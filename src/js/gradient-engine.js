// ─── Gradient Tool Engine (Optimised) ────────────────────────────────────────
    //
    //  Tier 1 — allocation kills removed
    //    • _BAYER8      : Uint8Array at module scope (was: new Array(8) × W×H)
    //    • LUT          : flat Uint8Array (was: Array of [r,g,b,a] Objects)
    //    • _hexRgbaCache: Map cache for hex parsing (was: parseInt × LUT × renders)
    //    • running idx  : idx+=4 (was: (y*W+x)*4 multiply per pixel)
    //
    //  Tier 2 — loop restructuring
    //    • switch(type) dispatched once → per-type fill fn owns its tight loop
    //    • Math.atan2 / Math.hypot only called for types that need them
    //    • _isTile hoisted; _cpuOff OffscreenCanvas reused across renders
    //
    //  Tier 3 — render cache
    //    • _renderCache: param-hash → Uint8ClampedArray (≤ 8 entries)
    //    • GL path:  _glLastKey tracks last rendered state; re-blits on match
    //
    //  Tier 4 — WebGL fragment-shader path
    //    • One compiled program per gradient type, cached in _glPrograms
    //    • LUT uploaded as 512×1 RGBA8 texture; Bayer uploaded as 8×8 R8 texture
    //    • Staggered stays CPU-only (per-channel quantisation, not LUT-based)
    // ─────────────────────────────────────────────────────────────────────────────

    const GRAD_HANDLE_RADIUS = 8;
    function _gradientDrawVector(ctx, g, zoom) { /* superseded by SVG overlay */ }

    // ─── Module-scope constants ───────────────────────────────────────────────────

    // 8×8 Bayer ordered-dither matrix, flattened — allocated ONCE at module load
    const _BAYER8 = new Uint8Array([
         0,32, 8,40, 2,34,10,42,
        48,16,56,24,50,18,58,26,
        12,44, 4,36,14,46, 6,38,
        60,28,52,20,62,30,54,22,
         3,35,11,43, 1,33, 9,41,
        51,19,59,27,49,17,57,25,
        15,47, 7,39,13,45, 5,37,
        63,31,55,23,61,29,53,21
    ]);

    // Same matrix scaled to [0,254] for upload as WebGL R8 texture
    // (63/64 × 255 ≈ 250.9 → 251, matches JS threshold 63/64 = 0.984)
    const _BAYER8_GL = new Uint8Array(_BAYER8.map(v => Math.round(v * 255 / 64)));

    // Pre-scaled float version: avoids dividing by 64 on every pixel in CPU fill fns
    const _BAYER8F = new Float32Array(_BAYER8.map(v => v / 64));

    const LUT_SIZE  = 512;
    const LUT1      = LUT_SIZE - 1;       // 511 — used in every fill fn
    const TWO_PI    = Math.PI * 2;

    // Hex→rgba result cache — avoids repeated parseInt / string ops
    const _hexRgbaCache = new Map();

    // Tile types that use binary t (0 or 1) — no repeat/clamp needed, no dither
    const _TILE_TYPES = new Set([
        'star','pattern','dots_lg','diamond','cross','checkerboard','stripes'
    ]);

    // ─── Hex parsing (cached) ─────────────────────────────────────────────────────

    function _gradientHexToRgba(hex) {
        if (_hexRgbaCache.has(hex)) return _hexRgbaCache.get(hex);
        let h = hex.replace('#', '');
        if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
        const v = [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16),
                   parseInt(h.slice(4,6),16), 255];
        _hexRgbaCache.set(hex, v);
        return v;
    }

    // ─── LUT builder — writes into a flat Uint8Array (LUT_SIZE×4) ────────────────
    // Avoids all per-entry allocations; hex cache means no repeated string parsing.

    function _gradientBuildLUT(lut, stops, midpoint) {
        const mp      = (midpoint == null) ? 0.5 : Math.max(0.01, Math.min(0.99, midpoint));
        const logHalf = Math.log(0.5);
        const mpLog   = (mp !== 0.5) ? (logHalf / Math.log(mp)) : 0;

        for (let i = 0; i < LUT_SIZE; i++) {
            const t = i / LUT1;
            let o = i * 4;

            if (t <= 0) {
                const c = _gradientHexToRgba(stops[0].color);
                lut[o]=c[0]; lut[o+1]=c[1]; lut[o+2]=c[2]; lut[o+3]=255;
                continue;
            }
            if (t >= 1) {
                const c = _gradientHexToRgba(stops[stops.length-1].color);
                lut[o]=c[0]; lut[o+1]=c[1]; lut[o+2]=c[2]; lut[o+3]=255;
                continue;
            }

            let si = 0;
            while (si < stops.length - 1 && t > stops[si+1].offset) si++;
            const s1 = stops[si], s2 = stops[si+1];
            let lt = (t - s1.offset) / ((s2.offset - s1.offset) || 1);
            if (mp !== 0.5) lt = Math.pow(lt, mpLog);

            const c1 = _gradientHexToRgba(s1.color);
            const c2 = _gradientHexToRgba(s2.color);
            lut[o]   = (c1[0] + (c2[0]-c1[0])*lt + 0.5) | 0;
            lut[o+1] = (c1[1] + (c2[1]-c1[1])*lt + 0.5) | 0;
            lut[o+2] = (c1[2] + (c2[2]-c1[2])*lt + 0.5) | 0;
            lut[o+3] = 255;
        }
    }

    // ─── Repeat modes ─────────────────────────────────────────────────────────────

    function _gradientRepeat(t, mode) {
        if (mode === 'repeat') return ((t%1)+1)%1;
        if (mode === 'mirror') { const f=Math.floor(t), fr=t-f; return (Math.abs(f)%2===1)?1-fr:fr; }
        return t < 0 ? 0 : t > 1 ? 1 : t;
    }

    // ─── Render-cache key ─────────────────────────────────────────────────────────

    function _gradCacheKey(g, W, H, c1hex, c2hex) {
        return `${W}x${H}|${g.type}|${g.startX},${g.startY},${g.endX},${g.endY}`
             + `|${g.midpoint ?? 0.5}|${g.repeat ?? 'clamp'}|${g.reverse ? 1:0}`
             + `|${g.staggerLevels ?? 256}|${c1hex}|${c2hex}`;
    }

    // ─── Shared CPU offscreen canvas ──────────────────────────────────────────────

    let _cpuOff = null, _cpuOffW = 0, _cpuOffH = 0, _cpuOffCtx = null;

    function _getCPUOff(W, H) {
        if (!_cpuOff || _cpuOffW !== W || _cpuOffH !== H) {
            _cpuOff = (typeof OffscreenCanvas !== 'undefined')
                ? new OffscreenCanvas(W, H)
                : Object.assign(document.createElement('canvas'), { width: W, height: H });
            _cpuOffCtx = _cpuOff.getContext('2d');
            _cpuOffW = W; _cpuOffH = H;
        }
        return { off: _cpuOff, ctx: _cpuOffCtx };
    }

    // ─── CPU render cache (param-hash → Uint8ClampedArray) ───────────────────────

    const _renderCache   = new Map();
    const _RENDER_CACHE_MAX = 8;

    function _cacheGet(key) { return _renderCache.get(key) || null; }

    function _cacheSet(key, buf, imageData) {
        if (_renderCache.size >= _RENDER_CACHE_MAX) {
            _renderCache.delete(_renderCache.keys().next().value);
        }
        _renderCache.set(key, { buf, imageData });
    }

    // ─── WebGL state ──────────────────────────────────────────────────────────────

    let _glCanvas   = null;
    let _glCtx      = null;                    // WebGL2RenderingContext | null
    let _glFailed   = false;                   // set on init failure — disables GL path
    let _glVbo      = null;                    // fullscreen quad VBO
    let _glLutTex   = null;                    // 512×1 RGBA8 LUT texture
    let _glBayerTex = null;                    // 8×8 R8 Bayer texture
    let _glLastKey  = null;                    // key of last successful GL render
    let _glLastW    = 0, _glLastH = 0;

    const _glPrograms = new Map();             // type → WebGLProgram | null

    // ─── WebGL initialiser ────────────────────────────────────────────────────────

    function _glSetup() {
        if (_glCtx)    return true;
        if (_glFailed) return false;
        try {
            _glCanvas = (typeof OffscreenCanvas !== 'undefined')
                ? new OffscreenCanvas(1, 1)
                : document.createElement('canvas');
            const gl = _glCanvas.getContext('webgl2', {
                alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true,
                antialias: false, depth: false, stencil: false
            });
            if (!gl) { _glFailed = true; return false; }
            _glCtx = gl;

            // Fullscreen quad (triangle-strip)
            _glVbo = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, _glVbo);
            gl.bufferData(gl.ARRAY_BUFFER,
                new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

            // Bayer 8×8 texture (R8, REPEAT so fract-UV wraps cleanly)
            _glBayerTex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, _glBayerTex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 8, 8, 0,
                          gl.RED, gl.UNSIGNED_BYTE, _BAYER8_GL);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

            // LUT 512×1 texture (placeholder, updated each render)
            _glLutTex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, _glLutTex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, LUT_SIZE, 1, 0,
                          gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

            return true;
        } catch (e) {
            console.warn('[GradGL] init failed:', e);
            _glFailed = true;
            return false;
        }
    }

    // ─── GLSL programs ────────────────────────────────────────────────────────────

    const _GL_VS = /* glsl */`#version 300 es
        in  vec2 a_pos;
        out vec2 v_px;
        uniform vec2 u_res;
        void main() {
            gl_Position = vec4(a_pos, 0.0, 1.0);
            // Map NDC → canvas pixel coords (Y-flipped to match canvas 2D)
            v_px = (a_pos * 0.5 + 0.5) * u_res;
            v_px.y = u_res.y - v_px.y;
        }`;

    // Shared header included in every fragment shader
    const _GL_FS_HEAD = /* glsl */`#version 300 es
        precision mediump float;
        in  vec2 v_px;
        out vec4 fragColor;
        uniform sampler2D u_lut;
        uniform sampler2D u_bayer;
        uniform vec2  u_start;
        uniform vec2  u_end;
        uniform float u_dist;
        uniform float u_cosA;
        uniform float u_sinA;
        uniform float u_midpoint;
        uniform int   u_repeat;   // 0=clamp  1=repeat  2=mirror

        float applyRepeat(float t) {
            if (u_repeat == 1) {
                t = mod(t, 1.0);
                return t < 0.0 ? t + 1.0 : t;
            }
            if (u_repeat == 2) {
                float a  = abs(t);
                float fr = a - floor(a);
                return (mod(floor(a), 2.0) >= 1.0) ? 1.0 - fr : fr;
            }
            return clamp(t, 0.0, 1.0);
        }

        // Bayer-ordered dither between two neighbouring LUT entries
        vec4 sampleLUT(float t) {
            float lutF = clamp(t, 0.0, 1.0) * float(${LUT_SIZE - 1});
            float lo   = floor(lutF);
            float frac = lutF - lo;
            // Bayer UV: fract maps pixel coords into [0,1)² repeating over 8px tiles
            float thr = texture(u_bayer, fract(gl_FragCoord.xy / 8.0)).r;
            float idx = lo + (frac > thr ? 1.0 : 0.0);
            return texture(u_lut, vec2((idx + 0.5) / float(${LUT_SIZE}), 0.5));
        }`;

    // Per-type fragment shader bodies (appended after _GL_FS_HEAD)
    const _GL_FS_BODIES = {
        linear: /* glsl */`
            void main() {
                vec2 p = v_px - u_start;
                float t = (p.x * u_cosA - p.y * u_sinA) / u_dist;
                fragColor = sampleLUT(applyRepeat(t));
            }`,

        bilinear: /* glsl */`
            void main() {
                vec2 p = v_px - u_start;
                float rx = (p.x * u_cosA - p.y * u_sinA) / u_dist;
                float t  = abs(mod(rx * 2.0 + 1.0, 2.0) - 1.0);
                fragColor = sampleLUT(t);
            }`,

        radial: /* glsl */`
            void main() {
                float t = length(v_px - u_start) / u_dist;
                fragColor = sampleLUT(applyRepeat(t));
            }`,

        conic: /* glsl */`
            void main() {
                vec2 p = v_px - u_start;
                float baseA = atan(u_end.y - u_start.y, u_end.x - u_start.x);
                float a = atan(p.y, p.x) - baseA;
                float t = fract(a / (2.0 * 3.14159265358979));
                if (t < 0.0) t += 1.0;
                fragColor = sampleLUT(t);
            }`,

        square: /* glsl */`
            void main() {
                vec2 p = v_px - u_start;
                float rx = p.x * u_cosA - p.y * u_sinA;
                float ry = p.x * u_sinA + p.y * u_cosA;
                float t  = max(abs(rx), abs(ry)) / u_dist;
                fragColor = sampleLUT(applyRepeat(t));
            }`,

        spiral: /* glsl */`
            void main() {
                vec2 p = v_px - u_start;
                float baseA   = atan(u_end.y - u_start.y, u_end.x - u_start.x);
                float pixDist = length(p);
                float angle   = atan(p.y, p.x) - baseA;
                if (angle < 0.0) angle += 6.28318530717959;
                float phi = pixDist / u_dist - angle / 6.28318530717959;
                float t   = 0.5 - 0.5 * cos(phi * 6.28318530717959);
                fragColor = sampleLUT(t);
            }`,

        pattern: /* glsl */`
            void main() {
                vec2  p   = v_px - u_start;
                float sz  = max(4.0, u_dist);
                float cel = sz * (1.0 + u_midpoint * 3.0);
                float gx  = p.x * u_cosA - p.y * u_sinA;
                float gy  = p.x * u_sinA + p.y * u_cosA;
                vec2  c   = mod(vec2(gx, gy) + cel * 1000.0, cel) / cel - 0.5;
                float t   = length(c) <= (sz / cel) * 0.5 ? 1.0 : 0.0;
                fragColor = sampleLUT(t);
            }`,

        dots_lg: /* glsl */`
            void main() {
                vec2  p   = v_px - u_start;
                float sz  = max(4.0, u_dist);
                float cel = sz * (1.0 + u_midpoint * 3.0);
                float gx  = p.x * u_cosA - p.y * u_sinA;
                float gy  = p.x * u_sinA + p.y * u_cosA;
                float row = floor(gy / cel + 1000.0);
                float ox  = mod(row, 2.0) * 0.5;
                float cx  = mod(gx / cel + ox + 1000.0, 1.0) - 0.5;
                float cy  = mod(gy / cel       + 1000.0, 1.0) - 0.5;
                float t   = length(vec2(cx, cy)) <= (sz / cel) * 0.5 ? 1.0 : 0.0;
                fragColor = sampleLUT(t);
            }`,

        diamond: /* glsl */`
            void main() {
                vec2  p   = v_px - u_start;
                float sz  = max(4.0, u_dist);
                float cel = sz * (1.0 + u_midpoint * 3.0);
                float gx  = p.x * u_cosA - p.y * u_sinA;
                float gy  = p.x * u_sinA + p.y * u_cosA;
                vec2  c   = mod(vec2(gx, gy) + cel * 1000.0, cel) / cel - 0.5;
                float t   = (abs(c.x) + abs(c.y)) <= (sz / cel) * 0.5 ? 1.0 : 0.0;
                fragColor = sampleLUT(t);
            }`,

        cross: /* glsl */`
            void main() {
                vec2  p   = v_px - u_start;
                float sz  = max(4.0, u_dist);
                float cel = sz * (1.0 + u_midpoint * 3.0);
                float gx  = p.x * u_cosA - p.y * u_sinA;
                float gy  = p.x * u_sinA + p.y * u_cosA;
                vec2  c   = mod(vec2(gx, gy) + cel * 1000.0, cel) / cel - 0.5;
                float sf  = sz / cel;
                float arm = sf * 0.15;
                float half = sf * 0.5;
                float t = ((abs(c.x) <= arm || abs(c.y) <= arm)
                         && abs(c.x) <= half && abs(c.y) <= half) ? 1.0 : 0.0;
                fragColor = sampleLUT(t);
            }`,

        checkerboard: /* glsl */`
            void main() {
                vec2  p   = v_px - u_start;
                float cel = max(4.0, u_dist);
                float gx  = p.x * u_cosA - p.y * u_sinA;
                float gy  = p.x * u_sinA + p.y * u_cosA;
                float t   = mod(floor(gx / cel) + floor(gy / cel), 2.0) == 0.0 ? 0.0 : 1.0;
                fragColor = sampleLUT(t);
            }`,

        stripes: /* glsl */`
            void main() {
                vec2  p   = v_px - u_start;
                float sw  = max(2.0, u_dist * 0.25);
                float gap = sw * (u_midpoint * 4.0);
                float per = sw + gap;
                float rx  = mod(p.x * u_cosA - p.y * u_sinA + per * 1000.0, per);
                float t   = rx <= sw ? 1.0 : 0.0;
                fragColor = sampleLUT(t);
            }`,

        star: /* glsl */`
            void main() {
                vec2  p    = v_px - u_start;
                float sz   = max(4.0, u_dist);
                float cel  = sz * (1.0 + u_midpoint * 3.0);
                float gx   = p.x * u_cosA - p.y * u_sinA;
                float gy   = p.x * u_sinA + p.y * u_cosA;
                vec2  c    = mod(vec2(gx, gy) + cel * 1000.0, cel) / cel - 0.5;
                float sf   = sz / cel;
                vec2  sc   = c / sf;
                float sR   = length(sc);
                float sA   = atan(sc.y, sc.x);
                float s5   = 6.28318530717959 / 5.0;
                float sect = floor(sA / s5 + 0.5);
                float a1   = sA - sect * s5;
                float rR   = 1.0 / (cos(a1) / 0.38 + abs(sin(a1)) / 0.16);
                float t    = sR <= rR * 0.95 ? 1.0 : 0.0;
                fragColor  = sampleLUT(t);
            }`,
    };

    function _glCompileShader(gl, src, type) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.warn('[GradGL] shader:', gl.getShaderInfoLog(s));
            gl.deleteShader(s); return null;
        }
        return s;
    }

    function _glBuildProgram(type) {
        const gl   = _glCtx;
        const body = _GL_FS_BODIES[type];
        if (!body) return null;

        const vs = _glCompileShader(gl, _GL_VS, gl.VERTEX_SHADER);
        const fs = _glCompileShader(gl, _GL_FS_HEAD + body, gl.FRAGMENT_SHADER);
        if (!vs || !fs) return null;

        const prog = gl.createProgram();
        gl.attachShader(prog, vs); gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        gl.deleteShader(vs); gl.deleteShader(fs);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.warn('[GradGL] link:', gl.getProgramInfoLog(prog));
            gl.deleteProgram(prog); return null;
        }

        // Cache uniform locations alongside the program
        gl.useProgram(prog);
        prog._u = {};
        for (const n of ['u_res','u_start','u_end','u_dist','u_cosA','u_sinA',
                          'u_midpoint','u_repeat','u_lut','u_bayer']) {
            prog._u[n] = gl.getUniformLocation(prog, n);
        }
        // Cache attribute location — avoids a driver round-trip on every draw call
        prog._aPos = gl.getAttribLocation(prog, 'a_pos');
        return prog;
    }

    function _glGetProgram(type) {
        if (_glPrograms.has(type)) return _glPrograms.get(type);
        const prog = _glBuildProgram(type);
        _glPrograms.set(type, prog);
        return prog;
    }

    // ─── WebGL render ─────────────────────────────────────────────────────────────

    function _gradientRenderGL(ctx, g, W, H, lut, key) {
        if (!_glSetup()) return false;
        const gl = _glCtx;

        const prog = _glGetProgram(g.type);
        if (!prog) return false;   // unknown type → fall through to CPU

        // Resize canvas only when dimensions change
        if (_glCanvas.width !== W || _glCanvas.height !== H) {
            _glCanvas.width = W; _glCanvas.height = H;
        }

        // If params haven't changed, just re-blit the existing GL canvas
        if (key === _glLastKey && _glLastW === W && _glLastH === H) {
            ctx.drawImage(_glCanvas, 0, 0);
            return true;
        }

        // Upload LUT texture — texSubImage2D reuses existing GPU allocation (no realloc)
        gl.bindTexture(gl.TEXTURE_2D, _glLutTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LUT_SIZE, 1,
                         gl.RGBA, gl.UNSIGNED_BYTE, lut);

        // Use program and set uniforms
        gl.useProgram(prog);
        gl.viewport(0, 0, W, H);

        const u  = prog._u;
        const dx = g.endX - g.startX, dy = g.endY - g.startY;
        const dist      = Math.hypot(dx, dy);
        const baseAngle = Math.atan2(dy, dx);
        const repeatMode = g.repeat === 'repeat' ? 1 : g.repeat === 'mirror' ? 2 : 0;

        gl.uniform2f(u.u_res,      W, H);
        gl.uniform2f(u.u_start,    g.startX, g.startY);
        gl.uniform2f(u.u_end,      g.endX,   g.endY);
        gl.uniform1f(u.u_dist,     dist);
        gl.uniform1f(u.u_cosA,     Math.cos(-baseAngle));
        gl.uniform1f(u.u_sinA,     Math.sin(-baseAngle));
        gl.uniform1f(u.u_midpoint, g.midpoint ?? 0.5);
        gl.uniform1i(u.u_repeat,   repeatMode);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, _glLutTex);
        gl.uniform1i(u.u_lut, 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, _glBayerTex);
        gl.uniform1i(u.u_bayer, 1);

        // Bind VBO and draw fullscreen quad
        gl.bindBuffer(gl.ARRAY_BUFFER, _glVbo);
        gl.enableVertexAttribArray(prog._aPos);
        gl.vertexAttribPointer(prog._aPos, 2, gl.FLOAT, false, 0, 0);

        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // Blit to destination; drawImage respects any active ctx.clip()
        ctx.drawImage(_glCanvas, 0, 0);

        _glLastKey = key;
        _glLastW   = W;
        _glLastH   = H;
        return true;
    }

    // ─── Staggered / phase-shifted quantised gradient (CPU-only) ─────────────────
    // Per-channel independent quantisation — not LUT-based, so GL path doesn't apply.
    // Improvements vs original: running index (no rowOff+x*4 multiply), bitwise round.

    function _gradientStaggeredRender(ctx, g, W, H, stops) {
        const { startX: sx, startY: sy, endX: ex, endY: ey, staggerLevels } = g;
        const c1 = _gradientHexToRgba(stops[0].color);
        const c2 = _gradientHexToRgba(stops[1].color);
        if (!c1 || !c2) return;

        const baseLevels = Math.max(2, staggerLevels || 256);
        const maxR = baseLevels - 1, maxG = baseLevels, maxB = baseLevels - 2;
        // Precompute reciprocals to replace all per-pixel divisions
        const invMaxR = 255 / maxR, invMaxG = 255 / maxG, invMaxB = 255 / maxB;
        const normR   = maxR / 255,  normG   = maxG / 255,  normB   = maxB / 255;

        const sr = c1[0], sg = c1[1], sb = c1[2], sa = c1[3];
        const dR = c2[0]-sr, dG = c2[1]-sg, dB = c2[2]-sb, dA = c2[3]-sa;

        const dx = ex-sx, dy = ey-sy;
        const invLenSq = 1 / (dx*dx + dy*dy);
        if (!isFinite(invLenSq)) return;

        const imageData = ctx.createImageData(W, H);
        const data      = imageData.data;
        let   idx       = 0;                   // running pixel index — no multiply

        for (let y = 0; y < H; y++) {
            const py = y - sy;
            for (let x = 0; x < W; x++, idx += 4) {
                let t = ((x-sx)*dx + py*dy) * invLenSq;
                if (t < 0) t = 0; else if (t > 1) t = 1;

                // Bitwise round via +0.5|0  (safe for non-negative values)
                data[idx]   = (Math.round(sr + dR*t) * normR + 0.5 | 0) * invMaxR + 0.5 | 0;
                data[idx+1] = (Math.round(sg + dG*t) * normG + 0.5 | 0) * invMaxG + 0.5 | 0;
                data[idx+2] = (Math.round(sb + dB*t) * normB + 0.5 | 0) * invMaxB + 0.5 | 0;
                data[idx+3] = sa + dA*t + 0.5 | 0;
            }
        }
        ctx.putImageData(imageData, 0, 0);
    }

    // ─── CPU per-type fill functions ──────────────────────────────────────────────
    // Each fn owns its entire loop — no switch/branch inside, no unused trig.
    // All use the module-scope _BAYER8 and a flat Uint8Array lut.
    //
    // Shared dither+LUT sample pattern (inlined for speed):
    //   const bayerRow = (y & 7) * 8;
    //   const lutPos   = t * LUT1;                  // t already clamped to [0,1]
    //   const li       = lutPos < LUT1 ? lutPos|0 : LUT1-1;
    //   const o        = (_BAYER8[bayerRow+(x&7)]/64 < lutPos-li ? li+1 : li) * 4;
    //   data[idx]=lut[o]; data[idx+1]=lut[o+1]; ...

    function _cpuFillLinear(data, W, H, sx, sy, dist, cosA, sinA, lut, repeat) {
        const invDist  = 1 / dist;
        const isRepeat = repeat === 'repeat';
        const isMirror = repeat === 'mirror';
        let   idx = 0;
        for (let y = 0; y < H; y++) {
            const py       = y - sy;
            const bayerRow = (y & 7) * 8;
            for (let x = 0; x < W; x++, idx += 4) {
                let t = ((x-sx)*cosA - py*sinA) * invDist;
                if      (isRepeat) { t = ((t % 1) + 1) % 1; }
                else if (isMirror) { const f = Math.floor(t), fr = t-f; t = (Math.abs(f)%2===1) ? 1-fr : fr; }
                else               { t = t < 0 ? 0 : t > 1 ? 1 : t; }
                const lutPos = t * LUT1;
                const li = lutPos < LUT1 ? lutPos|0 : LUT1-1;
                const o  = (_BAYER8F[bayerRow+(x&7)] < lutPos-li ? li+1 : li) * 4;
                data[idx]=lut[o]; data[idx+1]=lut[o+1]; data[idx+2]=lut[o+2]; data[idx+3]=lut[o+3];
            }
        }
    }

    function _cpuFillBilinear(data, W, H, sx, sy, dist, cosA, sinA, lut) {
        const invDist = 1 / dist;
        let   idx = 0;
        for (let y = 0; y < H; y++) {
            const py       = y - sy;
            const bayerRow = (y & 7) * 8;
            for (let x = 0; x < W; x++, idx += 4) {
                const rx   = ((x-sx)*cosA - py*sinA) * invDist * 2 + 1;
                const t    = Math.abs(rx % 2 - 1);
                const lutPos = t * LUT1;
                const li = lutPos < LUT1 ? lutPos|0 : LUT1-1;
                const o  = (_BAYER8F[bayerRow+(x&7)] < lutPos-li ? li+1 : li) * 4;
                data[idx]=lut[o]; data[idx+1]=lut[o+1]; data[idx+2]=lut[o+2]; data[idx+3]=lut[o+3];
            }
        }
    }

    function _cpuFillRadial(data, W, H, sx, sy, dist, lut, repeat) {
        const invDist  = 1 / dist;
        const isRepeat = repeat === 'repeat';
        const isMirror = repeat === 'mirror';
        let   idx = 0;
        for (let y = 0; y < H; y++) {
            const py       = y - sy;
            const py2      = py * py;
            const bayerRow = (y & 7) * 8;
            for (let x = 0; x < W; x++, idx += 4) {
                const px = x - sx;
                let t    = Math.sqrt(px*px + py2) * invDist;
                if      (isRepeat) { t = ((t % 1) + 1) % 1; }
                else if (isMirror) { const f = Math.floor(t), fr = t-f; t = (Math.abs(f)%2===1) ? 1-fr : fr; }
                else               { t = t < 0 ? 0 : t > 1 ? 1 : t; }
                const lutPos = t * LUT1;
                const li = lutPos < LUT1 ? lutPos|0 : LUT1-1;
                const o  = (_BAYER8F[bayerRow+(x&7)] < lutPos-li ? li+1 : li) * 4;
                data[idx]=lut[o]; data[idx+1]=lut[o+1]; data[idx+2]=lut[o+2]; data[idx+3]=lut[o+3];
            }
        }
    }

    function _cpuFillConic(data, W, H, sx, sy, baseAngle, lut) {
        let idx = 0;
        for (let y = 0; y < H; y++) {
            const py       = y - sy;
            const bayerRow = (y & 7) * 8;
            for (let x = 0; x < W; x++, idx += 4) {
                let a = Math.atan2(py, x-sx) - baseAngle;
                if (a < 0) a += TWO_PI;
                const t      = ((a / TWO_PI) % 1 + 1) % 1;
                const lutPos = t * LUT1;
                const li = lutPos < LUT1 ? lutPos|0 : LUT1-1;
                const o  = (_BAYER8F[bayerRow+(x&7)] < lutPos-li ? li+1 : li) * 4;
                data[idx]=lut[o]; data[idx+1]=lut[o+1]; data[idx+2]=lut[o+2]; data[idx+3]=lut[o+3];
            }
        }
    }

    function _cpuFillSquare(data, W, H, sx, sy, dist, cosA, sinA, lut, repeat) {
        const invDist  = 1 / dist;
        const isRepeat = repeat === 'repeat';
        const isMirror = repeat === 'mirror';
        let   idx = 0;
        for (let y = 0; y < H; y++) {
            const py       = y - sy;
            const bayerRow = (y & 7) * 8;
            for (let x = 0; x < W; x++, idx += 4) {
                const px  = x - sx;
                const rx  = px*cosA - py*sinA;
                const ry  = px*sinA + py*cosA;
                let t = (Math.abs(rx) > Math.abs(ry) ? Math.abs(rx) : Math.abs(ry)) * invDist;
                if      (isRepeat) { t = ((t % 1) + 1) % 1; }
                else if (isMirror) { const f = Math.floor(t), fr = t-f; t = (Math.abs(f)%2===1) ? 1-fr : fr; }
                else               { t = t < 0 ? 0 : t > 1 ? 1 : t; }
                const lutPos = t * LUT1;
                const li = lutPos < LUT1 ? lutPos|0 : LUT1-1;
                const o  = (_BAYER8F[bayerRow+(x&7)] < lutPos-li ? li+1 : li) * 4;
                data[idx]=lut[o]; data[idx+1]=lut[o+1]; data[idx+2]=lut[o+2]; data[idx+3]=lut[o+3];
            }
        }
    }

    function _cpuFillSpiral(data, W, H, sx, sy, dist, baseAngle, lut) {
        const invDist = 1 / dist;
        let   idx = 0;
        for (let y = 0; y < H; y++) {
            const py       = y - sy;
            const py2      = py * py;
            const bayerRow = (y & 7) * 8;
            for (let x = 0; x < W; x++, idx += 4) {
                const px      = x - sx;
                let   angle   = Math.atan2(py, px) - baseAngle;
                if (angle < 0) angle += TWO_PI;
                const pixDist = Math.sqrt(px*px + py2);
                const phi     = pixDist * invDist - angle / TWO_PI;
                const t       = 0.5 - 0.5 * Math.cos(phi * TWO_PI);
                const lutPos  = t * LUT1;
                const li = lutPos < LUT1 ? lutPos|0 : LUT1-1;
                const o  = (_BAYER8F[bayerRow+(x&7)] < lutPos-li ? li+1 : li) * 4;
                data[idx]=lut[o]; data[idx+1]=lut[o+1]; data[idx+2]=lut[o+2]; data[idx+3]=lut[o+3];
            }
        }
    }

    // ── Tile types — binary t (0|1), no dither needed, no atan2/hypot ────────────

    function _cpuFillStar(data, W, H, sx, sy, dist, midpoint, cosA, sinA, lut) {
        const sz   = Math.max(4, dist);
        const cel  = sz * (1 + midpoint * 3);
        const sf   = sz / cel;
        const s5   = TWO_PI / 5;
        const o0   = 0,  o1 = LUT1 * 4;   // LUT offset for t=0 and t=1
        let   idx  = 0;
        for (let y = 0; y < H; y++) {
            const py = y - sy;
            for (let x = 0; x < W; x++, idx += 4) {
                const px  = x - sx;
                const gx  = px*cosA - py*sinA;
                const gy  = px*sinA + py*cosA;
                const cx  = ((gx%cel+cel)%cel)/cel - 0.5;
                const cy  = ((gy%cel+cel)%cel)/cel - 0.5;
                const scx = cx/sf, scy = cy/sf;
                const sR  = Math.sqrt(scx*scx + scy*scy);
                const sA  = Math.atan2(scy, scx);
                const sec = Math.round(sA / s5);
                const a1  = sA - sec*s5;
                const rR  = 1 / (Math.cos(a1)/0.38 + Math.abs(Math.sin(a1))/0.16);
                const o   = sR <= rR*0.95 ? o1 : o0;
                data[idx]=lut[o]; data[idx+1]=lut[o+1]; data[idx+2]=lut[o+2]; data[idx+3]=lut[o+3];
            }
        }
    }

    function _cpuFillPattern(data, W, H, sx, sy, dist, midpoint, cosA, sinA, lut) {
        const sz  = Math.max(4, dist);
        const cel = sz * (1 + midpoint * 3);
        const r   = (sz / cel) * 0.5;
        const o0  = 0, o1 = LUT1 * 4;
        let   idx = 0;
        for (let y = 0; y < H; y++) {
            const py = y - sy;
            for (let x = 0; x < W; x++, idx += 4) {
                const px = x - sx;
                const gx = px*cosA - py*sinA;
                const gy = px*sinA + py*cosA;
                const cx = ((gx%cel+cel)%cel)/cel - 0.5;
                const cy = ((gy%cel+cel)%cel)/cel - 0.5;
                const o  = Math.sqrt(cx*cx+cy*cy) <= r ? o1 : o0;
                data[idx]=lut[o]; data[idx+1]=lut[o+1]; data[idx+2]=lut[o+2]; data[idx+3]=lut[o+3];
            }
        }
    }

    function _cpuFillDotsLg(data, W, H, sx, sy, dist, midpoint, cosA, sinA, lut) {
        const sz     = Math.max(4, dist);
        const cel    = sz * (1 + midpoint * 3);
        const invCel = 1 / cel;
        const r      = (sz / cel) * 0.5;
        const o0     = 0, o1 = LUT1 * 4;
        let   idx    = 0;
        for (let y = 0; y < H; y++) {
            const py = y - sy;
            for (let x = 0; x < W; x++, idx += 4) {
                const px  = x - sx;
                const gx  = px*cosA - py*sinA;
                const gy  = px*sinA + py*cosA;
                const row = Math.floor(gy*invCel + 1000);
                const ox  = (row & 1) * 0.5;
                const cx  = ((gx*invCel + ox + 1000) % 1) - 0.5;
                const cy  = ((gy*invCel      + 1000) % 1) - 0.5;
                const o   = Math.sqrt(cx*cx+cy*cy) <= r ? o1 : o0;
                data[idx]=lut[o]; data[idx+1]=lut[o+1]; data[idx+2]=lut[o+2]; data[idx+3]=lut[o+3];
            }
        }
    }

    function _cpuFillDiamond(data, W, H, sx, sy, dist, midpoint, cosA, sinA, lut) {
        const sz  = Math.max(4, dist);
        const cel = sz * (1 + midpoint * 3);
        const r   = (sz / cel) * 0.5;
        const o0  = 0, o1 = LUT1 * 4;
        let   idx = 0;
        for (let y = 0; y < H; y++) {
            const py = y - sy;
            for (let x = 0; x < W; x++, idx += 4) {
                const px = x - sx;
                const gx = px*cosA - py*sinA;
                const gy = px*sinA + py*cosA;
                const cx = ((gx%cel+cel)%cel)/cel - 0.5;
                const cy = ((gy%cel+cel)%cel)/cel - 0.5;
                const o  = (Math.abs(cx)+Math.abs(cy)) <= r ? o1 : o0;
                data[idx]=lut[o]; data[idx+1]=lut[o+1]; data[idx+2]=lut[o+2]; data[idx+3]=lut[o+3];
            }
        }
    }

    function _cpuFillCross(data, W, H, sx, sy, dist, midpoint, cosA, sinA, lut) {
        const sz   = Math.max(4, dist);
        const cel  = sz * (1 + midpoint * 3);
        const sf   = sz / cel;
        const arm  = sf * 0.15;
        const half = sf * 0.5;
        const o0   = 0, o1 = LUT1 * 4;
        let   idx  = 0;
        for (let y = 0; y < H; y++) {
            const py = y - sy;
            for (let x = 0; x < W; x++, idx += 4) {
                const px  = x - sx;
                const gx  = px*cosA - py*sinA;
                const gy  = px*sinA + py*cosA;
                const cx  = ((gx%cel+cel)%cel)/cel - 0.5;
                const cy  = ((gy%cel+cel)%cel)/cel - 0.5;
                const acx = Math.abs(cx), acy = Math.abs(cy);
                const o   = ((acx<=arm||acy<=arm) && acx<=half && acy<=half) ? o1 : o0;
                data[idx]=lut[o]; data[idx+1]=lut[o+1]; data[idx+2]=lut[o+2]; data[idx+3]=lut[o+3];
            }
        }
    }

    function _cpuFillCheckerboard(data, W, H, sx, sy, dist, cosA, sinA, lut) {
        const invCel = 1 / Math.max(4, dist);
        const o0     = 0, o1 = LUT1 * 4;
        let   idx    = 0;
        for (let y = 0; y < H; y++) {
            const py = y - sy;
            for (let x = 0; x < W; x++, idx += 4) {
                const px = x - sx;
                const gx = px*cosA - py*sinA;
                const gy = px*sinA + py*cosA;
                const o  = ((Math.floor(gx*invCel) + Math.floor(gy*invCel)) & 1) ? o1 : o0;
                data[idx]=lut[o]; data[idx+1]=lut[o+1]; data[idx+2]=lut[o+2]; data[idx+3]=lut[o+3];
            }
        }
    }

    function _cpuFillStripes(data, W, H, sx, sy, dist, midpoint, cosA, sinA, lut) {
        const sw  = Math.max(2, dist * 0.25);
        const gap = sw * (midpoint * 4);
        const per = sw + gap;
        const o0  = 0, o1 = LUT1 * 4;
        let   idx = 0;
        for (let y = 0; y < H; y++) {
            const py = y - sy;
            for (let x = 0; x < W; x++, idx += 4) {
                const rx = ((((x-sx)*cosA - py*sinA) % per) + per) % per;
                const o  = rx <= sw ? o1 : o0;
                data[idx]=lut[o]; data[idx+1]=lut[o+1]; data[idx+2]=lut[o+2]; data[idx+3]=lut[o+3];
            }
        }
    }

    // ─── CPU dispatch table ───────────────────────────────────────────────────────

    function _cpuDispatch(type, data, W, H, sx, sy, dist, cosA, sinA, baseAngle, midpoint, lut, repeat) {
        switch (type) {
            case 'linear':       _cpuFillLinear(data,W,H,sx,sy,dist,cosA,sinA,lut,repeat); break;
            case 'bilinear':     _cpuFillBilinear(data,W,H,sx,sy,dist,cosA,sinA,lut); break;
            case 'radial':       _cpuFillRadial(data,W,H,sx,sy,dist,lut,repeat); break;
            case 'conic':        _cpuFillConic(data,W,H,sx,sy,baseAngle,lut); break;
            case 'square':       _cpuFillSquare(data,W,H,sx,sy,dist,cosA,sinA,lut,repeat); break;
            case 'spiral':       _cpuFillSpiral(data,W,H,sx,sy,dist,baseAngle,lut); break;
            case 'star':         _cpuFillStar(data,W,H,sx,sy,dist,midpoint,cosA,sinA,lut); break;
            case 'pattern':      _cpuFillPattern(data,W,H,sx,sy,dist,midpoint,cosA,sinA,lut); break;
            case 'dots_lg':      _cpuFillDotsLg(data,W,H,sx,sy,dist,midpoint,cosA,sinA,lut); break;
            case 'diamond':      _cpuFillDiamond(data,W,H,sx,sy,dist,midpoint,cosA,sinA,lut); break;
            case 'cross':        _cpuFillCross(data,W,H,sx,sy,dist,midpoint,cosA,sinA,lut); break;
            case 'checkerboard': _cpuFillCheckerboard(data,W,H,sx,sy,dist,cosA,sinA,lut); break;
            case 'stripes':      _cpuFillStripes(data,W,H,sx,sy,dist,midpoint,cosA,sinA,lut); break;
            default: break;
        }
    }

    // ─── Main entry point ─────────────────────────────────────────────────────────

    function _gradientRender(ctx, g, W, H, c1hex, c2hex) {
        const { type, repeat, reverse, startX: sx, startY: sy, endX: ex, endY: ey } = g;
        const midpoint = g.midpoint ?? 0.5;

        // Build stop list (respects reverse flag)
        const stops = reverse
            ? [{ offset: 0, color: c2hex }, { offset: 1, color: c1hex }]
            : [{ offset: 0, color: c1hex }, { offset: 1, color: c2hex }];

        const dx   = ex - sx, dy = ey - sy;
        const dist = Math.hypot(dx, dy);
        if (dist < 1) {
            ctx.fillStyle = stops[0].color;
            ctx.fillRect(0, 0, W, H);
            return;
        }

        // ── Staggered — dedicated CPU path, no LUT ─────────────────────────────
        if (type === 'staggered') {
            _gradientStaggeredRender(ctx, g, W, H, stops);
            return;
        }

        // ── Render cache lookup ────────────────────────────────────────────────
        const key     = _gradCacheKey(g, W, H, c1hex, c2hex);
        const cached  = _cacheGet(key);
        if (cached) {
            // Fast path: re-blit from cached ImageData (no re-wrap allocation)
            const { off, ctx: oCtx } = _getCPUOff(W, H);
            oCtx.putImageData(cached.imageData, 0, 0);
            ctx.drawImage(off, 0, 0);
            return;
        }

        // ── Build LUT (flat Uint8Array — zero object allocs) ──────────────────
        const lut = new Uint8Array(LUT_SIZE * 4);
        _gradientBuildLUT(lut, stops, midpoint);

        const baseAngle = Math.atan2(dy, dx);
        const cosA      = Math.cos(-baseAngle);
        const sinA      = Math.sin(-baseAngle);

        // ── WebGL path (preferred) ────────────────────────────────────────────
        if (_gradientRenderGL(ctx, g, W, H, lut, key)) return;

        // ── CPU fallback ──────────────────────────────────────────────────────
        const imageData = ctx.createImageData(W, H);
        const data      = imageData.data;

        _cpuDispatch(type, data, W, H, sx, sy, dist, cosA, sinA, baseAngle, midpoint, lut, repeat);

        // Store in render cache — keep both raw buf and the ImageData to avoid re-wrapping
        _cacheSet(key, data, imageData);

        // Blit via shared offscreen canvas so drawImage respects ctx.clip()
        const { off, ctx: oCtx } = _getCPUOff(W, H);
        oCtx.putImageData(imageData, 0, 0);
        ctx.drawImage(off, 0, 0);
    }

    // ─── End Gradient Tool Engine ─────────────────────────────────────────────────