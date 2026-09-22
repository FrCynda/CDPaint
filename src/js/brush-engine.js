/* brush-engine — moved verbatim off the PaintEngine class body.
 *
 * Assigned onto the prototype, so `this` is the same PaintEngine instance
 * these methods have always run against. Loads after paint-engine.js and
 * before boot.js, which is where the instance is finally created.
 */
(function () {
    Object.assign(PaintEngine.prototype, {
            applyColorPresetFromUI() {
                const select = document.getElementById('color-customizer-preset');
                if (!select) return;
                const value = select.value;
                if (!value) return;
                this.applyColorPreset(value);
            },
            saveCustomColorPresetFromUI() {
                const input = document.getElementById('color-customizer-save-name');
                if (!input) return;
                const name = input.value.trim();
                if (!name) return;
                this.saveCustomColorPreset(name);
                input.value = '';
                this.refreshColorPresetOptions();
            },
            applyColorPreset(name) {
                if (!this.colorDefaults) return;
                const before = this.getColorCustomizerSnapshot();
                if (name.startsWith('custom:')) {
                    const preset = this.getCustomColorPreset(name);
                    if (!preset) return;
                    this.colorOverrides = Object.assign({}, preset.overrides || {});
                    this.fileTabPresetColor = preset.fileTabPresetColor || null;
                    this.saveColorOverrides();
                    this.applyColorOverrides();
                    this.pushColorCustomizerHistory({
                        type: 'snapshot',
                        prevSnapshot: before,
                        source: 'preset-custom',
                        at: Date.now()
                    });
                    return;
                }
                const palettes = {
                    'girly-pop': ['#ffe1f1', '#ffc7e6', '#ffb1da', '#ff8fc9', '#ff6eb6', '#ff4aa1', '#f7288f', '#d91d7a'],
                    'nature': ['#f1f8f2', '#ddefe1', '#c6e3cc', '#b0d7b5', '#96caa0', '#7bb889', '#5f9f73', '#3f7b56'],
                    'sunset': ['#fff0d5', '#ffd1a8', '#ffb07b', '#ff8a5b', '#ff6b6b', '#d84e5d', '#a13c5a', '#5f2b49'],
                    'ocean': ['#e2f6ff', '#c2e9ff', '#9bd8ff', '#6fc2f2', '#4aa6e6', '#2c8acb', '#1e6e99', '#184f6b'],
                    'mono-graphite': ['#f2f2f2', '#d9d9d9', '#bfbfbf', '#a5a5a5', '#8a8a8a', '#707070', '#555555', '#3b3b3b'],
                    'dark-ui': ['#0f0f10', '#141414', '#1a1b1d', '#202224', '#26282b', '#2e3236', '#3a3f45', '#4a5158'],
                    'dark-1': ['#0b0c0e', '#121317', '#191b20', '#21242b', '#2a2e36', '#343a45', '#3f4754', '#4b5563'],
                    'dark-2': ['#0d0f10', '#15171a', '#1d2024', '#262a30', '#30353d', '#3a414b', '#454f5b', '#516170'],
                    'dark-3': ['#0b0d10', '#12161a', '#1a1f25', '#232a33', '#2d3541', '#384253', '#445067', '#51607a'],
                    'dark-4': ['#0b0c0d', '#121416', '#191c1f', '#212428', '#2a2f34', '#353c44', '#414b56', '#4d5a68'],
                    'dark-5': ['#0c0d0f', '#131519', '#1b1e23', '#24282f', '#2e333c', '#39414d', '#465163', '#526173'],
                    'dark-6': ['#0a0c0f', '#11151a', '#191f26', '#222a34', '#2c3642', '#364252', '#424f63', '#4e5d70'],
                    'dark-7': ['#0c0c0c', '#141414', '#1b1c1c', '#232525', '#2c2f2f', '#373c3c', '#434a4a', '#505858'],
                    'dark-8': ['#0b0d0e', '#111619', '#181f23', '#21292f', '#2b353d', '#36424c', '#425061', '#4f6076'],
                    'dark-9': ['#0b0c0f', '#12141a', '#1a1d26', '#242934', '#2f3542', '#3a4152', '#464f63', '#535f76'],
                    'dark-10': ['#0a0b0d', '#111315', '#191c1f', '#22262a', '#2c3238', '#37414a', '#434f5b', '#515f6e']
                };
                const palette = palettes[name];
                if (!palette) return;
                const isDarkUi = name === 'dark-ui' || name.startsWith('dark-');
                this.colorOverrides = {};
                this.colorDefaults.forEach((item, idx) => {
                    if (this.colorSensitiveKeys && this.colorSensitiveKeys.has(item.key)) return;
                    if (this.colorIconBackgroundKeys && this.colorIconBackgroundKeys.has(item.key)) {
                        this.colorOverrides[item.key] = '#ffffff';
                        return;
                    }
                    const target = palette[idx % palette.length];
                    if (isDarkUi) {
                        const base = this.getHslFromColor(item.display);
                        if (base && base.l <= 0.45 && base.s <= 0.2) {
                            this.colorOverrides[item.key] = '#e6e6e6';
                            return;
                        }
                        const blendedDark = this.blendPresetColorDark(item.display, target);
                        this.colorOverrides[item.key] = blendedDark || target;
                        return;
                    }
                    const blended = this.blendPresetColor(item.display, target);
                    this.colorOverrides[item.key] = blended || target;
                });
                this.fileTabPresetColor = isDarkUi ? '#2d2f33' : this.buildFileTabPresetColor(palette);
                this.saveColorOverrides();
                this.applyColorOverrides();
                this.pushColorCustomizerHistory({
                    type: 'snapshot',
                    prevSnapshot: before,
                    source: 'preset',
                    at: Date.now()
                });
            },
            getCustomColorPreset(value) {
                const list = this.customColorPresets || [];
                const name = decodeURIComponent(value.replace(/^custom:/, ''));
                return list.find(p => p.name === name) || null;
            },
            saveCustomColorPreset(name) {
                const clean = name.slice(0, 40);
                const list = Array.isArray(this.customColorPresets) ? this.customColorPresets.slice() : [];
                const entry = {
                    name: clean,
                    overrides: Object.assign({}, this.colorOverrides || {}),
                    fileTabPresetColor: this.fileTabPresetColor || null
                };
                const idx = list.findIndex(p => p.name.toLowerCase() === clean.toLowerCase());
                if (idx >= 0) list[idx] = entry;
                else list.push(entry);
                this.customColorPresets = list;
                this.saveCustomColorPresets();
            },
            blendPresetColor(baseColor, targetColor) {
                const base = this.getHslFromColor(baseColor);
                const target = this.getHslFromColor(targetColor);
                if (!base || !target) return null;
                const maxLightDelta = 0.18;
                const desiredL = base.l + Math.max(-maxLightDelta, Math.min(maxLightDelta, target.l - base.l));
                let l = desiredL;
                if (base.l >= 0.72) l = Math.max(l, 0.65);
                if (base.l <= 0.28) l = Math.min(l, 0.35);
                const s = Math.max(0.15, Math.min(0.9, base.s * 0.4 + target.s * 0.6));
                const h = target.h;
                const rgb = this.hslToRgb(h, s, l);
                return this.rgbToHex(Math.round(rgb.r * 255), Math.round(rgb.g * 255), Math.round(rgb.b * 255));
            },
            blendPresetColorDark(baseColor, targetColor) {
                const base = this.getHslFromColor(baseColor);
                const target = this.getHslFromColor(targetColor);
                if (!base || !target) return null;
                const l = Math.max(0.08, Math.min(0.35, base.l * 0.25 + target.l * 0.6));
                const s = Math.max(0.05, Math.min(0.28, base.s * 0.1 + target.s * 0.2));
                const h = target.h;
                const rgb = this.hslToRgb(h, s, l);
                return this.rgbToHex(Math.round(rgb.r * 255), Math.round(rgb.g * 255), Math.round(rgb.b * 255));
            },
            buildFileTabPresetColor(palette) {
                if (!palette || !palette.length) return null;
                const target = this.getHslFromColor(palette[palette.length - 1]);
                if (!target) return null;
                const h = target.h;
                const s = Math.max(0.6, Math.min(0.9, target.s * 0.9 + 0.15));
                const l = Math.max(0.32, Math.min(0.45, target.l * 0.6 + 0.12));
                const rgb = this.hslToRgb(h, s, l);
                return this.rgbToHex(Math.round(rgb.r * 255), Math.round(rgb.g * 255), Math.round(rgb.b * 255));
            },
            loadCustomColorPresets() {
                try {
                    const raw = this.lsGet('paint.colorPresets');
                    if (!raw) return [];
                    const list = JSON.parse(raw);
                    if (!Array.isArray(list)) return [];
                    return list.filter(p => p && typeof p.name === 'string' && typeof p.overrides === 'object');
                } catch (e) {
                    return [];
                }
            },
            saveCustomColorPresets() {
                const list = Array.isArray(this.customColorPresets) ? this.customColorPresets : [];
                this.lsSet('paint.colorPresets', JSON.stringify(list));
            },
            refreshColorPresetOptions() {
                const select = document.getElementById('color-customizer-preset');
                if (!select) return;
                Array.from(select.querySelectorAll('option[data-custom="true"]')).forEach(opt => opt.remove());
                const list = Array.isArray(this.customColorPresets) ? this.customColorPresets : [];
                list.forEach(preset => {
                    const opt = document.createElement('option');
                    opt.value = `custom:${encodeURIComponent(preset.name)}`;
                    opt.textContent = `Custom: ${preset.name}`;
                    opt.dataset.custom = 'true';
                    select.appendChild(opt);
                });
            },
            initWebGLBrush() {
                const c = document.createElement('canvas');
                c.width = this.config.width;
                c.height = this.config.height;
                const gl = c.getContext('webgl', { preserveDrawingBuffer: true, antialias: false });
                if (!gl) return;
                const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
                const maxViewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) || [0, 0];
                const pointRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) || [1, 1];
                this.glBrushLimits = {
                    maxTex,
                    maxViewportW: maxViewport[0],
                    maxViewportH: maxViewport[1],
                    maxPointSize: pointRange[1]
                };
                if (!this.canUseWebGLBrushForSize(this.config.width, this.config.height)) {
                    return;
                }

                const vs = `
                    attribute vec2 a_pos;
                    uniform vec2 u_resolution;
                    uniform float u_pointSize;
                    void main() {
                        vec2 zeroToOne = a_pos / u_resolution;
                        vec2 zeroToTwo = zeroToOne * 2.0;
                        vec2 clip = zeroToTwo - 1.0;
                        gl_Position = vec4(clip * vec2(1.0, -1.0), 0.0, 1.0);
                        gl_PointSize = u_pointSize;
                    }
                `;
                const fs = `
                    precision mediump float;
                    uniform vec4 u_color;
                    uniform float u_isSquare;
                    void main() {
                        if (u_isSquare < 0.5) {
                            vec2 c = gl_PointCoord - vec2(0.5);
                            if (dot(c, c) > 0.25) discard;
                        }
                        gl_FragColor = u_color;
                    }
                `;
                const quadVs = `
                    attribute vec2 a_pos;
                    attribute vec2 a_tex;
                    uniform vec2 u_resolution;
                    varying vec2 v_tex;
                    void main() {
                        vec2 zeroToOne = a_pos / u_resolution;
                        vec2 zeroToTwo = zeroToOne * 2.0;
                        vec2 clip = zeroToTwo - 1.0;
                        gl_Position = vec4(clip * vec2(1.0, -1.0), 0.0, 1.0);
                        v_tex = a_tex;
                    }
                `;
                const quadFs = `
                    precision mediump float;
                    uniform vec4 u_color;
                    uniform float u_isSquare;
                    varying vec2 v_tex;
                    void main() {
                        if (u_isSquare < 0.5) {
                            vec2 c = v_tex - vec2(0.5);
                            if (dot(c, c) > 0.25) discard;
                        }
                        gl_FragColor = u_color;
                    }
                `;
                const compile = (type, src) => {
                    const s = gl.createShader(type);
                    gl.shaderSource(s, src);
                    gl.compileShader(s);
                    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null;
                    return s;
                };
                const vsh = compile(gl.VERTEX_SHADER, vs);
                const fsh = compile(gl.FRAGMENT_SHADER, fs);
                if (!vsh || !fsh) return;

                const prog = gl.createProgram();
                gl.attachShader(prog, vsh);
                gl.attachShader(prog, fsh);
                gl.linkProgram(prog);
                if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
                gl.useProgram(prog);

                const posBuf = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);

                const aPos = gl.getAttribLocation(prog, 'a_pos');
                gl.enableVertexAttribArray(aPos);
                gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

                gl.disable(gl.DITHER);
                gl.disable(gl.DEPTH_TEST);
                gl.disable(gl.CULL_FACE);
                gl.enable(gl.BLEND);
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

                this.glBrush = gl;
                this.glBrushCanvas = c;
                this.glBrushProgram = prog;
                // Cache uniform locations at link time.
                // getUniformLocation involves a driver round-trip; caching avoids that
                // cost on every stroke flush (which can happen hundreds of times per second).
                this.glBrushUniforms = {
                    uRes:      gl.getUniformLocation(prog, 'u_resolution'),
                    uSize:     gl.getUniformLocation(prog, 'u_pointSize'),
                    uColor:    gl.getUniformLocation(prog, 'u_color'),
                    uIsSquare: gl.getUniformLocation(prog, 'u_isSquare'),
                };
                this.glBrushBuffers = { posBuf, aPos };
                // Growable scratch buffers used by renderWebGLStrokes.
                // Reusing these avoids allocating a new Float32Array on every stroke batch.
                // Each buffer is doubled in capacity when the current batch outgrows it.
                this._strokePtsBuf  = new Float32Array(1024);
                this._strokeVertsBuf = new Float32Array(4096);
                this._strokeTexBuf   = new Float32Array(4096);

                const quadVsh = compile(gl.VERTEX_SHADER, quadVs);
                const quadFsh = compile(gl.FRAGMENT_SHADER, quadFs);
                if (quadVsh && quadFsh) {
                    const quadProg = gl.createProgram();
                    gl.attachShader(quadProg, quadVsh);
                    gl.attachShader(quadProg, quadFsh);
                    gl.linkProgram(quadProg);
                    if (gl.getProgramParameter(quadProg, gl.LINK_STATUS)) {
                        gl.useProgram(quadProg);
                        const quadPosBuf = gl.createBuffer();
                        const quadTexBuf = gl.createBuffer();

                        const quadPos = gl.getAttribLocation(quadProg, 'a_pos');
                        const quadTex = gl.getAttribLocation(quadProg, 'a_tex');
                        gl.bindBuffer(gl.ARRAY_BUFFER, quadPosBuf);
                        gl.enableVertexAttribArray(quadPos);
                        gl.vertexAttribPointer(quadPos, 2, gl.FLOAT, false, 0, 0);
                        gl.bindBuffer(gl.ARRAY_BUFFER, quadTexBuf);
                        gl.enableVertexAttribArray(quadTex);
                        gl.vertexAttribPointer(quadTex, 2, gl.FLOAT, false, 0, 0);

                        this.glBrushQuadProgram = quadProg;
                        this.glBrushQuadUniforms = {
                            uRes:      gl.getUniformLocation(quadProg, 'u_resolution'),
                            uColor:    gl.getUniformLocation(quadProg, 'u_color'),
                            uIsSquare: gl.getUniformLocation(quadProg, 'u_isSquare'),
                        };
                        this.glBrushQuadBuffers = { posBuf: quadPosBuf, texBuf: quadTexBuf, aPos: quadPos, aTex: quadTex };
                        gl.useProgram(prog);
                    }
                }
            },
            canUseWebGLBrushForSize(w, h) {
                if (!this.glBrushLimits) return true;
                const maxTex = this.glBrushLimits.maxTex || 0;
                const maxViewportW = this.glBrushLimits.maxViewportW || 0;
                const maxViewportH = this.glBrushLimits.maxViewportH || 0;
                if (!maxTex || !maxViewportW || !maxViewportH) return false;
                const texOk = !maxTex || (w <= maxTex && h <= maxTex);
                const viewportOk = (!maxViewportW || w <= maxViewportW) && (!maxViewportH || h <= maxViewportH);
                return texOk && viewportOk;
            },
            disableWebGLBrush() {
                // Explicitly lose the WebGL context via the WEBGL_lose_context extension
                // before nulling the reference. Setting glBrush = null alone does NOT release
                // the GPU context — browsers enforce a hard cap of ~8–16 WebGL contexts per tab,
                // and orphaned contexts accumulate until the GC runs. After ~10–16 canvas
                // resizes this causes the GPU pipeline to crash silently.
                if (this.glBrush) {
                    const ext = this.glBrush.getExtension('WEBGL_lose_context');
                    if (ext) ext.loseContext();
                }
                this.glBrush = null;
                this.glBrushCanvas = null;
                this.glBrushProgram = null;
                this.glBrushBuffers = null;
                this.glBrushUniforms = null;
                this.glBrushQuadProgram = null;
                this.glBrushQuadBuffers = null;
                this.glBrushQuadUniforms = null;
            },
            updateBrushCache(color = '#000000', isSquare = false, widthOverride = null) {
                const width = widthOverride !== null ? widthOverride : (isSquare ? this.config.eraserWidth : this.config.lineWidth);
                // Look up (or build) the brush sprite via the LRU cache.
                // The result is also stored in this.brushCache for backwards compatibility
                // with any code that reads it directly rather than calling _getBrushEntry.
                this.brushCache = this._getBrushEntry(color, isSquare, width);
            },

            // Builds a brush tip sprite canvas for the given colour/size/shape combination.
            // Called only on an LRU cache miss — the sprite is then stored and reused for
            // subsequent dabs that share the same parameters.
            _getBrushEntry(color, isSquare, width) {
                if (!this._brushLRU) this._brushLRU = [];
                const key = color + '|' + width + '|' + (isSquare ? '1' : '0');
                const lru = this._brushLRU;
                // Scan from the end of the array (most-recently-used) for the fastest hit.
                for (let i = lru.length - 1; i >= 0; i--) {
                    if (lru[i].key === key) {
                        // Promote to the most-recently-used position (end of array).
                        if (i !== lru.length - 1) lru.push(lru.splice(i, 1)[0]);
                        return lru[lru.length - 1].entry;
                    }
                }
                // Cache miss: build the sprite and insert it.
                // Evict the least-recently-used entry (front of array) if the cache is full.
                const entry = this._buildBrushSprite(color, isSquare, width);
                if (lru.length >= 4) lru.shift(); // evict least-recently-used
                lru.push({ key, entry });
                return entry;
            },

            setLineWidthPreset(width) {
                const w = Math.max(1, Math.min(4, parseInt(width, 10) || 1));
                this.setToolWidth(this.config.tool, w);
                this.ui.sizeInput.value = this.getToolWidth(this.config.tool);
                this.brushCache = null; this._brushLRU = [];
                this.refreshEraserGhost();
                this.closeMenus();
            },
            applyNewPreset() {
                const p = document.getElementById('new-preset').value;
                const set = (w, h, d) => {
                    document.getElementById('new-w').value = w;
                    document.getElementById('new-h').value = h;
                    document.getElementById('new-depth').value = d;
                };
                if (p === 'hd-1080p') set(1920, 1080, 24);
                else if (p === 'hd-720p') set(1280, 720, 24);
                else if (p === 'square') set(1080, 1080, 24);
                else if (p === 'portrait') set(1080, 1350, 24);
                else if (p === 'icon-512') set(512, 512, 24);
                else if (p === 'icon-256') set(256, 256, 24);
                else if (p === 'gba-sprite') set(64, 64, 4);
                else if (p === 'gba-tile') set(8, 8, 4);
                else if (p === 'gba-screen') set(240, 160, 4);
                else if (p === 'gb') set(160, 144, 2);
                else if (p === 'uhd-4k') set(3840, 2160, 24);
                else if (p === 'banner') set(1500, 500, 24);
                else if (p === 'a4-print') set(2480, 3508, 24);
            },

            getFreehandOptions(isComplete = false) {
                const fh = this.config.freehand || {};
                const sp = this._getSmoothParams();
                const easingFn = PaintEngine._freehandEasingMap[fh.easing] || PaintEngine._freehandEasingMap.linear;
                const easingStartFn = PaintEngine._freehandEasingMap[fh.easingStart] || easingFn;
                const easingEndFn = PaintEngine._freehandEasingMap[fh.easingEnd] || easingFn;
                const rawTaperStart = fh.taperStart;
                const rawTaperEnd = fh.taperEnd;
                const taperStartVal = rawTaperStart === true || rawTaperStart >= 100 ? true : (rawTaperStart > 0 ? rawTaperStart : 0);
                const taperEndVal = rawTaperEnd === true || rawTaperEnd >= 100 ? true : (rawTaperEnd > 0 ? rawTaperEnd : 0);
                return {
                    size: fh.size ?? 4,
                    smoothing: sp.smoothing,
                    thinning: fh.thinning ?? 0,
                    streamline: sp.streamline,
                    simulatePressure: fh.simulatePressure ?? true,
                    easing: easingFn,
                    last: isComplete,
                    start: {
                        cap: fh.capStart === true,
                        taper: taperStartVal,
                        easing: easingStartFn
                    },
                    end: {
                        cap: fh.capEnd === true,
                        taper: taperEndVal,
                        easing: easingEndFn
                    }
                };
            },

            scheduleFreehandPreview() {
                if (this._freehandPendingFrame) return;
                this._freehandPendingFrame = requestAnimationFrame(() => {
                    this._freehandPendingFrame = null;
                    this.renderFreehandPreview();
                });
            },

            renderFreehandPreview() {
                if (!this.state.freehandActive && this._fhPreviewing) {
                    this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                    if (this.ui.cTemp) this.ui.cTemp.style.opacity = '1';
                    this._fhPreviewing = false;
                    return;
                }
                const pts = this.state.freehandPoints;
                if (pts.length < 2) return;
                const opts = this.getFreehandOptions(true);
                const stroke = getStroke(pts, opts);
                this._freehandStrokePoints = stroke;
                if (!stroke || stroke.length < 2) return;
                this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                const fh = this.config.freehand || {};
                const _freehandIsRight = this.state.freehandSlot === 2;
                this.renderFreehandOutline(this.ctxTemp, stroke, {
                    alpha: 1,
                    isFilled: fh.fillEnabled !== false,
                    strokeWidth: (fh.strokeEnabled !== false) ? (fh.strokeWidth || 0) : 0,
                    fillColor: this.getActiveDrawColor(_freehandIsRight),
                    strokeColor: this.getActiveDrawColor(!_freehandIsRight)
                });
                if (this.ui.cTemp) this.ui.cTemp.style.opacity = '0.5';
                this._fhPreviewing = true;
            },

            commitFreehandStroke() {
                const pts = this.state.freehandPoints;
                if (pts.length < 2) return;
                const opts = this.getFreehandOptions(true);
                const stroke = getStroke(pts, opts);
                if (!stroke || stroke.length < 2) return;
                this._freehandStrokePoints = stroke;
                for (const p of stroke) {
                    p[0] = Math.round(p[0]);
                    p[1] = Math.round(p[1]);
                }
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const p of stroke) {
                    if (p[0] < minX) minX = p[0];
                    if (p[1] < minY) minY = p[1];
                    if (p[0] > maxX) maxX = p[0];
                    if (p[1] > maxY) maxY = p[1];
                }
                const fh = this.config.freehand || {};
                const effectiveStrokeWidth = (fh.strokeEnabled !== false) ? (fh.strokeWidth || 0) : 0;
                const pad = Math.ceil(effectiveStrokeWidth * 2) + 2;
                minX = Math.max(0, Math.floor(minX) - pad);
                minY = Math.max(0, Math.floor(minY) - pad);
                maxX = Math.min(this.config.width, Math.ceil(maxX) + pad);
                maxY = Math.min(this.config.height, Math.ceil(maxY) + pad);
                const bw = maxX - minX;
                const bh = maxY - minY;
                if (bw <= 0 || bh <= 0) return;
                const _commitIsRight = this.state.freehandSlot === 2;
                const strokeColor = this.getActiveDrawColor(!_commitIsRight);
                const fillColor = this.getActiveDrawColor(_commitIsRight);
                const strokeWidth = effectiveStrokeWidth;
                const isFilled = fh.fillEnabled !== false;
                const pixelMode = fh.pixelMode !== false;
                this.disableSmoothing(this.ctx);
                if (pixelMode) {
                    // Pass 1 — stroke
                    if (strokeWidth > 0) {
                        this.ctxTemp.clearRect(minX, minY, bw, bh);
                        this.renderFreehandOutline(this.ctxTemp, stroke, {
                            alpha: 1, isFilled: false,
                            strokeWidth: strokeWidth,
                            fillColor: fillColor,
                            strokeColor: strokeColor
                        });
                        this._quantizeToColor(this.ctxTemp, minX, minY, bw, bh, strokeColor);
                        this.ctx.drawImage(this.ctxTemp.canvas, minX, minY, bw, bh, minX, minY, bw, bh);
                    }
                    // Pass 2 — fill (drawn on top of stroke)
                    if (isFilled) {
                        this.ctxTemp.clearRect(minX, minY, bw, bh);
                        this.renderFreehandOutline(this.ctxTemp, stroke, {
                            alpha: 1, isFilled: true,
                            strokeWidth: 0,
                            fillColor: fillColor,
                            strokeColor: strokeColor
                        });
                        this._quantizeToColor(this.ctxTemp, minX, minY, bw, bh, fillColor);
                        this.ctx.drawImage(this.ctxTemp.canvas, minX, minY, bw, bh, minX, minY, bw, bh);
                    }
                } else {
                    this.renderFreehandOutline(this.ctx, stroke, {
                        alpha: 1,
                        isFilled: isFilled,
                        strokeWidth: strokeWidth,
                        fillColor: fillColor,
                        strokeColor: strokeColor
                    });
                }
                this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                if (this.ui.cTemp) this.ui.cTemp.style.opacity = '1';
                this._fhPreviewing = false;
                this.saveState();
            },

            renderFreehandOutline(ctx, outline, opts = {}) {
                if (!outline || outline.length < 3) return;
                const len = outline.length;
                const path = new Path2D();
                let p0 = outline[len - 1];
                let p1 = outline[0];
                path.moveTo((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2);
                for (let i = 0; i < len; i++) {
                    p0 = outline[i];
                    p1 = outline[(i + 1) % len];
                    path.quadraticCurveTo(p0[0], p0[1], (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2);
                }
                const isFilled = opts.isFilled !== false;
                const strokeWidth = opts.strokeWidth || 0;
                const fillColor = opts.fillColor || '#000000';
                const strokeColor = opts.strokeColor || '#000000';
                ctx.save();
                if (strokeWidth > 0) {
                    ctx.strokeStyle = strokeColor;
                    ctx.lineWidth = strokeWidth;
                    ctx.lineJoin = 'round';
                    ctx.lineCap = 'round';
                    ctx.stroke(path);
                }
                if (isFilled) {
                    ctx.fillStyle = fillColor;
                    ctx.fill(path);
                }
                ctx.restore();
            },

            bindFreehandSettings() {
                const sliderMap = [
                    ['fh-size', 'size'],
                    ['fh-thinning', 'thinning'],
                    ['fh-smoothing', 'smoothing'],
                    ['fh-streamline', 'streamline'],
                    ['fh-taperStart', 'taperStart'],
                    ['fh-taperEnd', 'taperEnd'],
                    ['fh-strokeWidth', 'strokeWidth']
                ];
                for (const [id, key] of sliderMap) {
                    const el = document.getElementById(id);
                    if (!el) continue;
                    el.addEventListener('input', () => {
                        var wrap2 = el.parentElement;
                        var val = (key === 'size' && wrap2 && wrap2.dataset.overflowVal !== undefined)
                            ? parseFloat(wrap2.dataset.overflowVal)
                            : parseFloat(el.value);
                        if (!isNaN(val)) this.config.freehand[key] = val;
                        var min = parseFloat(el.min) || 0;
                        var max = parseFloat(el.max) || 100;
                        var raw = (val - min) / (max - min) * 100;
                        var pct = Math.round(key === 'size' ? Math.min(raw, 100) : raw) + '%';
                        el.style.setProperty('--pct', pct);
                        var wrap = el.parentElement;
                        if (wrap && wrap.classList.contains('pb-slider-wrap')) {
                            wrap.style.setProperty('--pct', pct);
                        }
                        this.updateFreehandPanel();
                        this._saveFreehandConfig();
                    });
                }
                for (const [id] of sliderMap) {
                    const el = document.getElementById(id);
                    if (!el) continue;
                    const wrap = el.parentElement;
                    if (!wrap || !wrap.classList.contains('pb-slider-wrap')) continue;
                    wrap.addEventListener('mousedown', function (e) {
                        e.preventDefault();
                        var step = parseFloat(el.step) || 1;
                        var min = parseFloat(el.min) || 0;
                        var max = parseFloat(el.max) || 100;
                        var allowOverflow = (id === 'fh-size');
                        function updateFromClientX(cx) {
                            var rect = wrap.getBoundingClientRect();
                            var pct;
                            if (allowOverflow) {
                                pct = Math.max(0, (cx - rect.left) / rect.width);
                            } else {
                                pct = Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
                            }
                            var val = min + pct * (max - min);
                            val = Math.round(val / step) * step;
                            if (!allowOverflow) {
                                val = Math.max(min, Math.min(max, val));
                            }
                            if (allowOverflow) {
                                wrap.dataset.overflowVal = val;
                                el.value = Math.min(val, max);
                            } else {
                                el.value = val;
                            }
                            el.dispatchEvent(new Event('input'));
                        }
                        updateFromClientX(e.clientX);
                        function onMove(me) { updateFromClientX(me.clientX); }
                        function onUp() {
                            document.removeEventListener('mousemove', onMove);
                            document.removeEventListener('mouseup', onUp);
                        }
                        document.addEventListener('mousemove', onMove);
                        document.addEventListener('mouseup', onUp);
                    });
                }
                const selMap = [
                    ['fh-easing', 'easing'],
                    ['fh-easingStart', 'easingStart'],
                    ['fh-easingEnd', 'easingEnd']
                ];
                for (const [id, key] of selMap) {
                    const el = document.getElementById(id);
                    if (!el) continue;
                    el.addEventListener('change', () => {
                        this.config.freehand[key] = el.value;
                        this.updateFreehandPanel();
                        this._saveFreehandConfig();
                    });
                }
                const capStartEl = document.getElementById('fh-capStart');
                if (capStartEl) {
                    capStartEl.addEventListener('change', () => {
                        this.config.freehand.capStart = capStartEl.checked;
                        this._saveFreehandConfig();
                    });
                }
                const capEndEl = document.getElementById('fh-capEnd');
                if (capEndEl) {
                    capEndEl.addEventListener('change', () => {
                        this.config.freehand.capEnd = capEndEl.checked;
                        this._saveFreehandConfig();
                    });
                }
                const fillEl = document.getElementById('fh-fill');
                if (fillEl) {
                    fillEl.addEventListener('change', () => {
                        this.config.freehand.fillEnabled = fillEl.checked;
                        this.updateFreehandPanel();
                        this._saveFreehandConfig();
                    });
                }
                const fillSwatch = document.getElementById('fh-fill-swatch');
                if (fillSwatch) {
                    fillSwatch.addEventListener('click', () => {
                        this.selectSlot(1);
                        this.openWinColor();
                    });
                }
                const strokeSwatch = document.getElementById('fh-stroke-swatch');
                if (strokeSwatch) {
                    strokeSwatch.addEventListener('click', () => {
                        this.selectSlot(2);
                        this.openWinColor();
                    });
                }
                const strokeEnabledEl = document.getElementById('fh-strokeEnabled');
                if (strokeEnabledEl) {
                    strokeEnabledEl.addEventListener('change', () => {
                        this.config.freehand.strokeEnabled = strokeEnabledEl.checked;
                        this._saveFreehandConfig();
                    });
                }
                const pixelModeEl = document.getElementById('fh-pixelMode');
                if (pixelModeEl) {
                    pixelModeEl.addEventListener('change', () => {
                        this.config.freehand.pixelMode = pixelModeEl.checked;
                        this._saveFreehandConfig();
                    });
                }
                const simPresEl = document.getElementById('fh-simulatePressure');
                if (simPresEl) {
                    simPresEl.addEventListener('change', () => {
                        this.config.freehand.simulatePressure = simPresEl.checked;
                        this._saveFreehandConfig();
                    });
                }

                const resetBtn = document.getElementById('fh-reset-btn');
                if (resetBtn) {
                    resetBtn.addEventListener('click', () => this.resetFreehandSettings());
                }
                const collapseBtn = document.getElementById('freehand-collapse-btn');
                if (collapseBtn) {
                    collapseBtn.addEventListener('click', () => {
                        const sidebar = document.getElementById('freehand-sidebar');
                        if (sidebar) sidebar.classList.remove('open');
                        const reopen = document.getElementById('freehand-reopen-btn');
                        if (reopen) reopen.classList.add('show');
                        this._updateSidebarViewportShift(true);
                    });
                }
                const reopenBtn = document.getElementById('freehand-reopen-btn');
                if (reopenBtn) {
                    reopenBtn.addEventListener('click', () => {
                        const sidebar = document.getElementById('freehand-sidebar');
                        if (sidebar) sidebar.classList.add('open');
                        reopenBtn.classList.remove('show');
                        this._updateSidebarViewportShift(true);
                    });
                }
                const freehandCloseBtn = document.getElementById('freehand-close-btn');
                if (freehandCloseBtn) {
                    freehandCloseBtn.addEventListener('click', () => this.setTool('pencil'));
                }
                const gradCollapseBtn = document.getElementById('gradient-collapse-btn');
                if (gradCollapseBtn) {
                    gradCollapseBtn.addEventListener('click', () => {
                        const sidebar = document.getElementById('gradient-sidebar');
                        if (sidebar) sidebar.classList.remove('open');
                        const reopen = document.getElementById('gradient-reopen-btn');
                        if (reopen) reopen.classList.add('show');
                        this._updateSidebarViewportShift(true);
                    });
                }
                const gradReopenBtn = document.getElementById('gradient-reopen-btn');
                if (gradReopenBtn) {
                    gradReopenBtn.addEventListener('click', () => {
                        const sidebar = document.getElementById('gradient-sidebar');
                        if (sidebar) sidebar.classList.add('open');
                        gradReopenBtn.classList.remove('show');
                        this._updateSidebarViewportShift(true);
                    });
                }
                const gradientCloseBtn = document.getElementById('gradient-close-btn');
                if (gradientCloseBtn) {
                    gradientCloseBtn.addEventListener('click', () => this.setTool('pencil'));
                }
                this.updateFreehandPanel();
            },

            updateFreehandPanel() {
                const fh = this.config.freehand || {};
                const sliderMap = [
                    ['fh-size', 'size'],
                    ['fh-thinning', 'thinning'],
                    ['fh-smoothing', 'smoothing'],
                    ['fh-streamline', 'streamline'],
                    ['fh-taperStart', 'taperStart'],
                    ['fh-taperEnd', 'taperEnd'],
                    ['fh-strokeWidth', 'strokeWidth']
                ];
                for (const [id, key] of sliderMap) {
                    const el = document.getElementById(id);
                    if (!el) continue;
                    const raw = fh[key];
                    const numVal = raw === true ? 100 : (raw ?? 0);
                    if (key === 'size') {
                        var wrap = el.parentElement;
                        if (numVal > (parseFloat(el.max) || 100)) {
                            wrap.dataset.overflowVal = numVal;
                            el.value = parseFloat(el.max) || 100;
                        } else {
                            delete wrap.dataset.overflowVal;
                            el.value = numVal;
                        }
                    } else {
                        el.value = numVal;
                    }
                    var min = parseFloat(el.min) || 0;
                    var max = parseFloat(el.max) || 100;
                    var rawPct = (numVal - min) / (max - min) * 100;
                    var pct = Math.round(key === 'size' ? Math.min(rawPct, 100) : rawPct) + '%';
                    el.style.setProperty('--pct', pct);
                    var wrap = el.parentElement;
                    if (wrap && wrap.classList.contains('pb-slider-wrap')) {
                        wrap.style.setProperty('--pct', pct);
                        var pbVal = wrap.querySelector('.pb-val');
                        if (pbVal) pbVal.textContent = numVal;
                    }

                }
                const selMap = [
                    ['fh-easing', 'easing'],
                    ['fh-easingStart', 'easingStart'],
                    ['fh-easingEnd', 'easingEnd']
                ];
                for (const [id, key] of selMap) {
                    const el = document.getElementById(id);
                    if (el) el.value = fh[key] || 'linear';
                }
                const capStartEl = document.getElementById('fh-capStart');
                if (capStartEl) capStartEl.checked = fh.capStart !== false;
                const capEndEl = document.getElementById('fh-capEnd');
                if (capEndEl) capEndEl.checked = fh.capEnd !== false;
                const simPresEl = document.getElementById('fh-simulatePressure');
                if (simPresEl) simPresEl.checked = fh.simulatePressure !== false;

                const fillEl = document.getElementById('fh-fill');
                if (fillEl) fillEl.checked = fh.fillEnabled !== false;
                const pixelModeEl = document.getElementById('fh-pixelMode');
                if (pixelModeEl) pixelModeEl.checked = fh.pixelMode !== false;
                const fillSwatch = document.getElementById('fh-fill-swatch');
                if (fillSwatch) fillSwatch.style.backgroundColor = this.config.c1;
                const strokeSwatch = document.getElementById('fh-stroke-swatch');
                if (strokeSwatch) strokeSwatch.style.backgroundColor = this.config.c2;
                const strokeEnabledEl = document.getElementById('fh-strokeEnabled');
                if (strokeEnabledEl) strokeEnabledEl.checked = fh.strokeEnabled !== false;
                const capStartRow = document.getElementById('fh-capStart-row');
                if (capStartRow) {
                    capStartRow.classList.toggle('fh-hidden', fh.taperStart > 0);
                }
                const capEndRow = document.getElementById('fh-capEnd-row');
                if (capEndRow) {
                    capEndRow.classList.toggle('fh-hidden', fh.taperEnd > 0);
                }
                const easingStartRow = document.getElementById('fh-easingStart-row');
                if (easingStartRow) {
                    easingStartRow.classList.toggle('fh-hidden', !(fh.taperStart > 0));
                }
                const easingEndRow = document.getElementById('fh-easingEnd-row');
                if (easingEndRow) {
                    easingEndRow.classList.toggle('fh-hidden', !(fh.taperEnd > 0));
                }
            },

            _saveFreehandConfig() {
                try {
                    localStorage.setItem('cdpaint.freehandConfig', JSON.stringify(this.config.freehand || {}));
                } catch (e) {}
            },

            _loadFreehandConfig() {
                try {
                    const raw = localStorage.getItem('cdpaint.freehandConfig');
                    if (raw) {
                        const saved = JSON.parse(raw);
                        if (saved && typeof saved === 'object') {
                            if (saved.smoothMode != null) {
                                delete saved.smoothMode;
                                delete saved.smoothAmount;
                                delete saved.smoothDelay;
                                try { localStorage.setItem('cdpaint.freehandConfig', JSON.stringify(saved)); } catch (e) {}
                            }
                            this.config.freehand = { ...this.config.freehand, ...saved };
                        }
                    }
                } catch (e) {}
            },

            resetFreehandSettings() {
                this.config.freehand = {
                    size: 4, thinning: 0,
                    smoothing: 0.5, streamline: 0.5,
                    taperStart: 0, taperEnd: 0,
                    capStart: false, capEnd: false,
                    simulatePressure: true, easing: 'linear',
                    easingStart: 'linear', easingEnd: 'linear',
                    fillEnabled: true,
                    strokeWidth: 0,
                    strokeEnabled: true,
                    pixelMode: true
                };
                this.updateFreehandPanel();
                this._saveFreehandConfig();
            }
    });
})();
