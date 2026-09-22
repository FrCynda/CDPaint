/* adjustments — moved verbatim off the PaintEngine class body.
 *
 * Assigned onto the prototype, so `this` is the same PaintEngine instance
 * these methods have always run against. Loads after paint-engine.js and
 * before boot.js, which is where the instance is finally created.
 */
(function () {
    Object.assign(PaintEngine.prototype, {
            initHueSat() {
                this.hueSatChannels = {
                    Master: { hue: 0, sat: 0, light: 0, chroma: 100, overlap: 0 },
                    R: { hue: 0, sat: 0, light: 0, chroma: 100, overlap: 0 },
                    Y: { hue: 0, sat: 0, light: 0, chroma: 100, overlap: 0 },
                    G: { hue: 0, sat: 0, light: 0, chroma: 100, overlap: 0 },
                    C: { hue: 0, sat: 0, light: 0, chroma: 100, overlap: 0 },
                    B: { hue: 0, sat: 0, light: 0, chroma: 100, overlap: 0 },
                    M: { hue: 0, sat: 0, light: 0, chroma: 100, overlap: 0 }
                };
                this.hueSatWorker = null;
                this.hueSatWorkerSeq = 0;
                this.hueSatWorkerCallbacks = new Map();
                this.hueSatWorkerFailed = false;
                this.hueSatWorkerBusy = false;
                this.hueSatWorkerPending = false;
                this.hueSatGlCanvas = null;
                this.hueSatGl = null;
                this.hueSatGlProgram = null;
                this.hueSatGlTex = null;
                this.hueSatGlPosBuf = null;
                this.hueSatGlTexBuf = null;
                this.hueSatGlFailed = false;
                this.hueSatGlMaxTex = 0;
                const handle = document.getElementById('huesat-split-handle');
                if (handle) {
                    handle.addEventListener('mousedown', (e) => {
                        if (!this.state.hueSatActive) return;
                        this.state.hueSatDragging = true;
                        e.preventDefault();
                    });
                }
                window.addEventListener('mouseup', () => { this.state.hueSatDragging = false; });
                window.addEventListener('mousemove', (e) => {
                    if (!this.state.hueSatDragging) return;
                    this.updateHueSatSplitFromEvent(e);
                });
            },
            openHueSat() {
                this.state.hueSatApplied = false;
                this.state.hueSatActive = true;
                this.state.hueSatSplit = false;
                this.state.hueSatSplitRatio = 0.5;
                this.hueSatWorkerBusy = false;
                this.hueSatWorkerPending = false;
                this.hueSatWorkerFailed = false;
                this.hueSatGlFailed = false;
                this.hueSatPreviewBusy = false;
                this.captureHueSatBackup();
                if (this.state.selection) {
                    this.state.selection._disablePalette = true;
                }
                this.setHueSatChannel(this.state.hueSatChannel || 'Master');
                const split = document.getElementById('hs-split');
                if (split) split.checked = false;
                this._hsUpdatePreviewColors();
                this.updateHueSatPreview();
                this.updateHueSatSplitHandle();
            },
            captureHueSatBackup() {
                const source = this.state.selection ? this.state.selection.canvas : this.ui.cMain;
                if (!source) return;
                const backup = document.createElement('canvas');
                backup.width = source.width;
                backup.height = source.height;
                backup.getContext('2d').drawImage(source, 0, 0);
                this.hueSatBackup = backup;
                const bctx = backup.getContext('2d');
                try {
                    this.hueSatBaseData = bctx.getImageData(0, 0, backup.width, backup.height);
                    this.hueSatWorkerBaseVersion = (this.hueSatWorkerBaseVersion || 0) + 1;
                    this.initHueSatWorkerBase();
                } catch (e) {
                    this.hueSatWorkerFailed = true;
                } finally {
                    this.hueSatBaseData = null;
                }
            },
            cancelHueSat() {
                if (!this.state.hueSatActive) { this.closeModals(); return; }
                if (this.hueSatBackup) {
                    if (this.state.selection) {
                        const ctx = this.state.selection.canvas.getContext('2d');
                        ctx.clearRect(0, 0, this.hueSatBackup.width, this.hueSatBackup.height);
                        ctx.drawImage(this.hueSatBackup, 0, 0);
                        this.state.selection._cache = null;
                        this.state.selection._glTexDirty = true;
                        this.state.selection._disablePalette = false;
                        this.renderSelection();
                    } else {
                        this.ctx.clearRect(0, 0, this.config.width, this.config.height);
                        this.ctx.drawImage(this.hueSatBackup, 0, 0);
                    }
                }
                const huesatDocked = this._activeSidebarModalId === 'huesat';
                if (huesatDocked) {
                    this._closeUnifiedSidebar(true);
                }
                this.state.hueSatActive = false;
                this.hideHueSatSplitHandle();
                clearTimeout(this.state.hueSatPreviewTimer);
                this.state.hueSatPreviewTimer = null;
                clearTimeout(this.state.hueSatWorkerTimeout);
                this.state.hueSatWorkerTimeout = null;
                this.resetHueSatUI();
                this.hueSatBackup = null;
                this.hueSatBaseData = null;
                this.hueSatWorkerBaseVersion = 0;
                if (this.hueSatWorker) {
                    this.hueSatWorker.terminate();
                    this.hueSatWorker = null;
                    this.hueSatWorkerCallbacks?.clear();
                }
                this.disposeHueSatGL();
                if (!huesatDocked) {
                    const m = document.getElementById('modal-huesat');
                    if (m) m.style.display = 'none';
                }
            },
            _closeHueSatSidebarIfActive() {
                if (this._activeSidebarModalId === 'huesat') {
                    this._closeUnifiedSidebar(true);
                }
            },
            toggleHueSatSidebar() {
                const sidebar = document.getElementById('unified-sidebar');
                if (!sidebar) return;
                if (this._activeSidebarModalId === 'huesat') {
                    this._closeUnifiedSidebar();
                } else {
                    if (this._activeSidebarModalId) this._closeUnifiedSidebar(true);
                    this._openUnifiedSidebar('huesat');
                }
            },
            setHueSatChannel(channel) {
                if (!this.hueSatChannels[channel]) return;
                this.saveHueSatState();
                this.state.hueSatChannel = channel;
                const label = document.getElementById('hs-channel-label');
                if (label) label.textContent = channel;
                document.querySelectorAll('#modal-huesat .channel-wrap').forEach(b => b.classList.remove('active'));
                const masterBtn = document.getElementById('hs-master-btn');
                if (masterBtn) masterBtn.classList.toggle('active', channel === 'Master');
                const map = { R: '.pos-r', Y: '.pos-y', G: '.pos-g', C: '.pos-c', B: '.pos-b', M: '.pos-m' };
                if (channel !== 'Master') {
                    const btn = document.querySelector(`#modal-huesat ${map[channel]}`);
                    if (btn) btn.classList.add('active');
                }
                // Update sat slider end-color to match the channel's true hue
                const channelHues = { Master: 0, R: 0, Y: 60, G: 120, C: 180, B: 240, M: 300 };
                const hue = channelHues[channel] !== undefined ? channelHues[channel] : 0;
                const satSlider = document.getElementById('hs-sat');
                if (satSlider) satSlider.style.background = `linear-gradient(to right, #808080 0%, hsl(${hue},100%,50%) 100%)`;
                this.loadHueSatState();
                this._hsUpdatePreviewColors();
            },
            saveHueSatState() {
                const c = this.hueSatChannels[this.state.hueSatChannel];
                if (!c) return;
                c.hue = parseFloat(document.getElementById('hs-hue')?.value) || 0;
                c.sat = parseFloat(document.getElementById('hs-sat')?.value) || 0;
                c.light = parseFloat(document.getElementById('hs-light')?.value) || 0;
                c.chroma = parseFloat(document.getElementById('hs-chroma')?.value);
                if (!Number.isFinite(c.chroma)) c.chroma = 100;
                c.overlap = parseFloat(document.getElementById('hs-overlap')?.value) || 0;
            },
            loadHueSatState() {
                const c = this.hueSatChannels[this.state.hueSatChannel];
                if (!c) return;
                this.setHueSatVal('hs-hue', 'hs-hue-num', c.hue);
                this.setHueSatVal('hs-sat', 'hs-sat-num', c.sat);
                this.setHueSatVal('hs-light', 'hs-light-num', c.light);
                this.setHueSatVal('hs-chroma', 'hs-chroma-num', c.chroma !== undefined ? c.chroma : 100);
                this.setHueSatVal('hs-overlap', 'hs-overlap-num', c.overlap);
            },
            setHueSatVal(rangeId, numId, val) {
                const r = document.getElementById(rangeId);
                const n = document.getElementById(numId);
                if (r) r.value = val;
                if (n) n.value = val;
            },
            resetHueSatChannel() {
                const c = this.hueSatChannels[this.state.hueSatChannel];
                if (!c) return;
                c.hue = 0; c.sat = 0; c.light = 0; c.chroma = 100; c.overlap = 0;
                this.loadHueSatState();
                this.updateHueSatPreview();
            },
            resetHueSatUI() {
                Object.keys(this.hueSatChannels).forEach(k => {
                    this.hueSatChannels[k].hue = 0;
                    this.hueSatChannels[k].sat = 0;
                    this.hueSatChannels[k].light = 0;
                    this.hueSatChannels[k].chroma = 100;
                    this.hueSatChannels[k].overlap = 0;
                });
                this.state.hueSatChannel = 'Master';
                this.state.hueSatSplit = false;
                const split = document.getElementById('hs-split');
                if (split) split.checked = false;
                const label = document.getElementById('hs-channel-label');
                if (label) label.textContent = 'Master';
                document.querySelectorAll('#modal-huesat .channel-wrap').forEach(b => b.classList.remove('active'));
                const masterBtn = document.getElementById('hs-master-btn');
                if (masterBtn) masterBtn.classList.add('active');
                this.setHueSatVal('hs-hue', 'hs-hue-num', 0);
                this.setHueSatVal('hs-sat', 'hs-sat-num', 0);
                this.setHueSatVal('hs-light', 'hs-light-num', 0);
                this.setHueSatVal('hs-overlap', 'hs-overlap-num', 0);
                this.hideHueSatSplitHandle();
            },
            toggleHueSatSplit() {
                const chk = document.getElementById('hs-split');
                this.state.hueSatSplit = chk ? chk.checked : false;
                if (!this.state.hueSatSplit) this.hideHueSatSplitHandle();
                this.updateHueSatPreview();
            },
            updateHueSatSplitFromEvent(e) {
                const rect = this.getHueSatTargetRect();
                if (!rect) return;
                const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
                this.state.hueSatSplitRatio = rect.width ? (x / rect.width) : 0.5;
                this.updateHueSatPreview();
            },
            getHueSatTargetRect() {
                this.updateBounds();
                const z = this.config.zoom || 1;
                if (this.state.selection) {
                    const n = this.getNormalizedRect(this.state.selection);
                    return {
                        left: this.bounds.left + n.x * z,
                        top: this.bounds.top + n.y * z,
                        width: n.w * z,
                        height: n.h * z
                    };
                }
                return { left: this.bounds.left, top: this.bounds.top, width: this.config.width * z, height: this.config.height * z };
            },
            updateHueSatSplitHandle() {
                const handle = document.getElementById('huesat-split-handle');
                if (!handle) return;
                if (!this.state.hueSatSplit) { handle.style.display = 'none'; return; }
                const rect = this.getHueSatTargetRect();
                if (!rect) return;
                const x = rect.left + rect.width * this.state.hueSatSplitRatio;
                handle.style.display = 'block';
                handle.style.left = `${Math.round(x)}px`;
                handle.style.top = `${Math.round(rect.top)}px`;
                handle.style.height = `${Math.round(rect.height)}px`;
            },
            hideHueSatSplitHandle() {
                const handle = document.getElementById('huesat-split-handle');
                if (handle) handle.style.display = 'none';
            },
            getHueSatGL() {
                if (this.hueSatGlFailed) return null;
                if (this.hueSatGl) return this.hueSatGl;
                const canvas = document.createElement('canvas');
                const gl = canvas.getContext('webgl', { premultipliedAlpha: false }) || canvas.getContext('experimental-webgl');
                if (!gl) {
                    this.hueSatGlFailed = true;
                    return null;
                }
                this.hueSatGlMaxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
                const vsSrc = `
    attribute vec2 aPos;
    attribute vec2 aTex;
    varying vec2 vTex;
    void main() {
        vTex = aTex;
        gl_Position = vec4(aPos, 0.0, 1.0);
    }
    `;
                const fsSrc = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    varying vec2 vTex;
    uniform sampler2D uImage;
    uniform float uHue[7];
    uniform float uSat[7];
    uniform float uLight[7];
    uniform float uOverlap[7];
    uniform float uCenter[7];
    uniform float uChroma[7];
    vec3 rgb2hsl(vec3 c) {
        float maxc = max(c.r, max(c.g, c.b));
        float minc = min(c.r, min(c.g, c.b));
        float h = 0.0;
        float s = 0.0;
        float l = (maxc + minc) * 0.5;
        if (maxc != minc) {
            float d = maxc - minc;
            s = l > 0.5 ? d / (2.0 - maxc - minc) : d / (maxc + minc);
            if (maxc == c.r) {
                h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
            } else if (maxc == c.g) {
                h = (c.b - c.r) / d + 2.0;
            } else {
                h = (c.r - c.g) / d + 4.0;
            }
            h /= 6.0;
        }
        return vec3(h, s, l);
    }
    float hue2rgb(float p, float q, float t) {
        if (t < 0.0) t += 1.0;
        if (t > 1.0) t -= 1.0;
        if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
        if (t < 1.0/2.0) return q;
        if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
        return p;
    }
    vec3 hsl2rgb(vec3 hsl) {
        float h = hsl.x;
        float s = hsl.y;
        float l = hsl.z;
        if (s == 0.0) return vec3(l, l, l);
        float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
        float p = 2.0 * l - q;
        return vec3(
            hue2rgb(p, q, h + 1.0/3.0),
            hue2rgb(p, q, h),
            hue2rgb(p, q, h - 1.0/3.0)
        );
    }
    // sRGB <-> linear
    float toLinear(float v) {
        return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4);
    }
    float toSrgb(float v) {
        return v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1.0/2.4) - 0.055;
    }
    // Lab helpers
    float labF(float t) {
        return t > 0.008856 ? pow(t, 1.0/3.0) : 7.787 * t + 16.0/116.0;
    }
    float labFInv(float t) {
        return t > 0.206897 ? t*t*t : (t - 16.0/116.0) / 7.787;
    }
    vec3 rgb2lab(vec3 c) {
        float rl = toLinear(c.r), gl = toLinear(c.g), bl = toLinear(c.b);
        float X = (rl*0.4124564 + gl*0.3575761 + bl*0.1804375) / 0.95047;
        float Y = (rl*0.2126729 + gl*0.7151522 + bl*0.0721750) / 1.00000;
        float Z = (rl*0.0193339 + gl*0.1191920 + bl*0.9503041) / 1.08883;
        float L = 116.0 * labF(Y) - 16.0;
        float A = 500.0 * (labF(X) - labF(Y));
        float B = 200.0 * (labF(Y) - labF(Z));
        return vec3(L, A, B);
    }
    vec3 lab2rgb(vec3 lab) {
        float fy = (lab.x + 16.0) / 116.0;
        float fx = lab.y / 500.0 + fy;
        float fz = fy - lab.z / 200.0;
        float X = labFInv(fx) * 0.95047;
        float Y = labFInv(fy) * 1.00000;
        float Z = labFInv(fz) * 1.08883;
        float rl =  3.2404542*X - 1.5371385*Y - 0.4985314*Z;
        float gl = -0.9692660*X + 1.8760108*Y + 0.0415560*Z;
        float bl =  0.0556434*X - 0.2040259*Y + 1.0572252*Z;
        return vec3(
            clamp(toSrgb(max(0.0, rl)), 0.0, 1.0),
            clamp(toSrgb(max(0.0, gl)), 0.0, 1.0),
            clamp(toSrgb(max(0.0, bl)), 0.0, 1.0)
        );
    }
    vec3 applyChannel(vec3 hsl, vec3 rgb, float hue, float sat, float light, float center, float overlap, float chroma, bool wasAchromatic) {
        if (hue == 0.0 && sat == 0.0 && light == 0.0 && overlap == 0.0 && chroma == 100.0) return rgb;
        bool useChannel = center >= 0.0;
        if (useChannel) {
            float dist = abs(hsl.x - (center / 360.0));
            dist = min(dist, 1.0 - dist);
            float deg = dist * 360.0;
            float range = min(180.0, 20.0 + overlap * 1.6);
            if (deg > range * 0.5) return rgb;
        }
        if (wasAchromatic && hue == 0.0) sat = 0.0;
        // Apply hue/sat/light in HSL space
        vec3 outRgb = rgb;
        if (hue != 0.0 || sat != 0.0 || light != 0.0) {
            float nh = hsl.x + (hue / 360.0);
            nh = nh - floor(nh);
            float ns = clamp(hsl.y + (sat / 100.0), 0.0, 1.0);
            float nl = clamp(hsl.z + (light / 100.0), 0.0, 1.0);
            outRgb = hsl2rgb(vec3(nh, ns, nl));
        }
        // Apply chroma in Lab space
        if (chroma != 100.0) {
            vec3 lab = rgb2lab(outRgb);
            float chromaScale = chroma / 100.0;
            lab.y *= chromaScale;
            lab.z *= chromaScale;
            outRgb = lab2rgb(lab);
        }
        return outRgb;
    }
    void main() {
        vec4 color = texture2D(uImage, vTex);
        vec3 hsl = rgb2hsl(color.rgb);
        vec3 rgb = color.rgb;
        bool wasAchromatic = (color.r == color.g && color.g == color.b);
        for (int i = 0; i < 7; i++) {
            rgb = applyChannel(hsl, rgb, uHue[i], uSat[i], uLight[i], uCenter[i], uOverlap[i], uChroma[i], wasAchromatic);
            hsl = rgb2hsl(rgb);
        }
        gl_FragColor = vec4(rgb, color.a);
    }
    `;
                const compile = (type, src) => {
                    const sh = gl.createShader(type);
                    gl.shaderSource(sh, src);
                    gl.compileShader(sh);
                    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return null;
                    return sh;
                };
                const vs = compile(gl.VERTEX_SHADER, vsSrc);
                const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
                if (!vs || !fs) {
                    if (vs) gl.deleteShader(vs);
                    if (fs) gl.deleteShader(fs);
                    this.hueSatGlFailed = true;
                    return null;
                }
                const prog = gl.createProgram();
                gl.attachShader(prog, vs);
                gl.attachShader(prog, fs);
                gl.linkProgram(prog);
                if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
                    this.hueSatGlFailed = true;
                    return null;
                }
                gl.useProgram(prog);
                const posBuf = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                    -1, -1, 1, -1, -1, 1, 1, 1
                ]), gl.STATIC_DRAW);
                const texBuf = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                    0, 0, 1, 0, 0, 1, 1, 1
                ]), gl.STATIC_DRAW);
                this.hueSatGlCanvas = canvas;
                this.hueSatGl = gl;
                this.hueSatGlProgram = prog;
                this.hueSatGlPosBuf = posBuf;
                this.hueSatGlTexBuf = texBuf;
                // Cache uniform and attribute locations once at program link time.
                this.hueSatGlUniforms = {
                    uHue:    gl.getUniformLocation(prog, 'uHue'),
                    uSat:    gl.getUniformLocation(prog, 'uSat'),
                    uLight:  gl.getUniformLocation(prog, 'uLight'),
                    uOverlap: gl.getUniformLocation(prog, 'uOverlap'),
                    uCenter: gl.getUniformLocation(prog, 'uCenter'),
                    uChroma: gl.getUniformLocation(prog, 'uChroma'),
                };
                this.hueSatGlAttribs = {
                    posLoc: gl.getAttribLocation(prog, 'aPos'),
                    texLoc: gl.getAttribLocation(prog, 'aTex'),
                };
                // Pre-allocated typed-array buffers for the 7 Hue/Sat channel uniforms.
                // Reusing the same Float32Array instances across renders avoids 6 heap
                // allocations (and corresponding GC pressure) per slider adjustment.
                this.hueSatGlBufs = {
                    hues:     new Float32Array(7),
                    sats:     new Float32Array(7),
                    lights:   new Float32Array(7),
                    overlaps: new Float32Array(7),
                    centers:  new Float32Array([-1, 0, 60, 120, 180, 240, 300]),
                    chromas:  new Float32Array(7),
                };
                canvas.addEventListener('webglcontextlost', (e) => {
                    e.preventDefault();
                    this.disposeHueSatGL();
                    this.hueSatGlFailed = false;
                }, { once: true });
                return gl;
            },
            disposeHueSatGL() {
                const gl = this.hueSatGl;
                if (!gl) return;
                if (this.hueSatGlTex) gl.deleteTexture(this.hueSatGlTex);
                if (this.hueSatGlProgram) gl.deleteProgram(this.hueSatGlProgram);
                if (this.hueSatGlPosBuf) gl.deleteBuffer(this.hueSatGlPosBuf);
                if (this.hueSatGlTexBuf) gl.deleteBuffer(this.hueSatGlTexBuf);
                this.hueSatGl = null;
                this.hueSatGlCanvas = null;
                this.hueSatGlProgram = null;
                this.hueSatGlPosBuf = null;
                this.hueSatGlTexBuf = null;
                this.hueSatGlTex = null;
                this.hueSatGlUniforms = null;
                this.hueSatGlAttribs = null;
                this.hueSatGlBufs = null;
                this.hueSatGlMaxTex = null;
            },
            shouldUseHueSatGL(w, h) {
                if (this.hueSatGlFailed || (w * h) < 200000) return false;
                const gl = this.getHueSatGL();
                if (!gl) return false;
                const maxTex = this.hueSatGlMaxTex || 0;
                if (maxTex && (w > maxTex || h > maxTex)) return false;
                return true;
            },
            applyHueSatGL(sourceCanvas) {
                const gl = this.getHueSatGL();
                if (!gl) return null;
                const bw = sourceCanvas.width;
                const bh = sourceCanvas.height;
                const maxTex = this.hueSatGlMaxTex || 0;
                if (maxTex && (bw > maxTex || bh > maxTex)) return null;
                this.hueSatGlCanvas.width = bw;
                this.hueSatGlCanvas.height = bh;
                gl.viewport(0, 0, bw, bh);
                gl.useProgram(this.hueSatGlProgram);
                if (!this.hueSatGlTex) {
                    this.hueSatGlTex = gl.createTexture();
                }
                gl.bindTexture(gl.TEXTURE_2D, this.hueSatGlTex);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
                if (gl.getError && gl.getError() !== gl.NO_ERROR) {
                    this.hueSatGlFailed = true;
                    return null;
                }
                const { posLoc, texLoc } = this.hueSatGlAttribs;
                gl.bindBuffer(gl.ARRAY_BUFFER, this.hueSatGlPosBuf);
                gl.enableVertexAttribArray(posLoc);
                gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
                gl.bindBuffer(gl.ARRAY_BUFFER, this.hueSatGlTexBuf);
                gl.enableVertexAttribArray(texLoc);
                gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);
                const order = ['Master', 'R', 'Y', 'G', 'C', 'B', 'M'];
                // Fill the pre-allocated typed-array scratch buffers in-place.
                // This avoids constructing temporary JS arrays or wrapping new Float32Arrays
                // on every render call — important since this runs on every slider drag.
                const _b = this.hueSatGlBufs;
                for (let i = 0; i < order.length; i++) {
                    const c = this.hueSatChannels[order[i]] || { hue: 0, sat: 0, light: 0, chroma: 100, overlap: 0 };
                    _b.hues[i]     = c.hue || 0;
                    _b.sats[i]     = c.sat || 0;
                    _b.lights[i]   = c.light || 0;
                    _b.overlaps[i] = c.overlap || 0;
                    _b.chromas[i]  = c.chroma !== undefined ? c.chroma : 100;
                }
                const _hu = this.hueSatGlUniforms;
                gl.uniform1fv(_hu.uHue,     _b.hues);
                gl.uniform1fv(_hu.uSat,     _b.sats);
                gl.uniform1fv(_hu.uLight,   _b.lights);
                gl.uniform1fv(_hu.uOverlap, _b.overlaps);
                gl.uniform1fv(_hu.uCenter,  _b.centers);
                gl.uniform1fv(_hu.uChroma,  _b.chromas);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                const work = document.createElement('canvas');
                work.width = bw;
                work.height = bh;
                const wctx = work.getContext('2d');
                wctx.drawImage(this.hueSatGlCanvas, 0, 0);
                return work;
            },
            getHueSatWorker() {
                if (this.hueSatWorkerFailed) return null;
                if (this.hueSatWorker) return this.hueSatWorker;
                const src = `
    let baseData = null;
    let baseW = 0;
    let baseH = 0;
    let baseVersion = 0;
    self.onmessage = (e) => {
        const { type } = e.data;
        if (type === 'init') {
            const { width, height, buffer, version } = e.data;
            baseData = new Uint8ClampedArray(buffer);
            baseW = width;
            baseH = height;
            baseVersion = version || 0;
            return;
        }
        const { id, width, height, channels, order, version } = e.data;
        if (!baseData || baseW !== width || baseH !== height || (version || 0) !== baseVersion) {
            const empty = new Uint8ClampedArray(width * height * 4);
            self.postMessage({ id, buffer: empty.buffer }, [empty.buffer]);
            return;
        }
        const data = baseData.slice();
        const hueCenters = { R: 0, Y: 60, G: 120, C: 180, B: 240, M: 300 };
        const rgbToHsl = (r, g, b) => {
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            let h = 0;
            let s = 0;
            const l = (max + min) / 2;
            if (max !== min) {
                const d = max - min;
                s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                switch (max) {
                    case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                    case g: h = (b - r) / d + 2; break;
                    case b: h = (r - g) / d + 4; break;
                }
                h /= 6;
            }
            return { h, s, l };
        };
        const hslToRgb = (h, s, l) => {
            if (s === 0) return { r: l, g: l, b: l };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            const hue2rgb = (t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1/6) return p + (q - p) * 6 * t;
                if (t < 1/2) return q;
                if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                return p;
            };
            return { r: hue2rgb(h + 1/3), g: hue2rgb(h), b: hue2rgb(h - 1/3) };
        };
        const applyHueSatToImageData = (hue, sat, light, channel, overlap, chroma) => {
            const hueShift = hue / 360;
            const satShift = sat / 100;
            const lightShift = light / 100;
            const chromaScale = (chroma !== undefined ? chroma : 100) / 100;
            const useChannel = channel && channel !== 'Master' && hueCenters[channel] !== undefined;
            const range = Math.min(180, 20 + (overlap || 0) * 1.6);
            const toLinear = v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
            const toSrgb   = v => v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1/2.4) - 0.055;
            const Xn = 0.95047, Yn = 1.00000, Zn = 1.08883;
            const labF = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16/116;
            const labFInv = t => t > 0.206897 ? t*t*t : (t - 16/116) / 7.787;
            const rgbToLab = (r, g, b) => {
                const rl = toLinear(r), gl = toLinear(g), bl = toLinear(b);
                const X = (rl*0.4124564 + gl*0.3575761 + bl*0.1804375) / Xn;
                const Y = (rl*0.2126729 + gl*0.7151522 + bl*0.0721750) / Yn;
                const Z = (rl*0.0193339 + gl*0.1191920 + bl*0.9503041) / Zn;
                return { L: 116*labF(Y)-16, A: 500*(labF(X)-labF(Y)), B: 200*(labF(Y)-labF(Z)) };
            };
            const labToRgb = (L, A, B) => {
                const fy = (L+16)/116, fx = A/500+fy, fz = fy-B/200;
                const X = labFInv(fx)*Xn, Y = labFInv(fy)*Yn, Z = labFInv(fz)*Zn;
                const rl =  3.2404542*X - 1.5371385*Y - 0.4985314*Z;
                const gl = -0.9692660*X + 1.8760108*Y + 0.0415560*Z;
                const bl =  0.0556434*X - 0.2040259*Y + 1.0572252*Z;
                return {
                    r: Math.max(0,Math.min(1,toSrgb(Math.max(0,rl)))),
                    g: Math.max(0,Math.min(1,toSrgb(Math.max(0,gl)))),
                    b: Math.max(0,Math.min(1,toSrgb(Math.max(0,bl))))
                };
            };
            for (let i = 0; i < data.length; i += 4) {
                const r = data[i] / 255;
                const g = data[i + 1] / 255;
                const b = data[i + 2] / 255;
                const wasAchromatic = (r === g && g === b);
                const hsl = rgbToHsl(r, g, b);
                if (useChannel) {
                    const center = hueCenters[channel] / 360;
                    let dist = Math.abs(hsl.h - center);
                    dist = Math.min(dist, 1 - dist);
                    const deg = dist * 360;
                    if (deg > range / 2) continue;
                }
                let nh = hsl.h + hueShift;
                nh = nh - Math.floor(nh);
                let ns = Math.max(0, Math.min(1, hsl.s + satShift));
                if (wasAchromatic && !hueShift) ns = 0;
                let nl = Math.max(0, Math.min(1, hsl.l + lightShift));
                let or = r, og = g, ob = b;
                if (hueShift || satShift || lightShift) {
                    const c = hslToRgb(nh, ns, nl);
                    or = c.r; og = c.g; ob = c.b;
                }
                if (chromaScale !== 1) {
                    const lab = rgbToLab(or, og, ob);
                    lab.A *= chromaScale;
                    lab.B *= chromaScale;
                    const c = labToRgb(lab.L, lab.A, lab.B);
                    or = c.r; og = c.g; ob = c.b;
                }
                data[i]     = Math.round(or * 255);
                data[i + 1] = Math.round(og * 255);
                data[i + 2] = Math.round(ob * 255);
            }
        };
        const applyHueSatAll = () => {
            const orderList = order && order.length ? order : ['Master', 'R', 'Y', 'G', 'C', 'B', 'M'];
            for (const channel of orderList) {
                const c = channels ? channels[channel] : null;
                if (!c) continue;
                const chroma = c.chroma !== undefined ? c.chroma : 100;
                if (!c.hue && !c.sat && !c.light && chroma === 100 && !c.overlap) continue;
                applyHueSatToImageData(c.hue || 0, c.sat || 0, c.light || 0, channel, c.overlap || 0, chroma);
            }
        };
        applyHueSatAll();
        self.postMessage({ id, buffer: data.buffer }, [data.buffer]);
    };
    `;
                const blob = new Blob([src], { type: 'application/javascript' });
                const url = URL.createObjectURL(blob);
                try {
                    this.hueSatWorker = new Worker(url);
                } catch (err) {
                    this.hueSatWorkerFailed = true;
                    URL.revokeObjectURL(url);
                    return null;
                }
                // Revoke the object URL after the Worker has actually loaded the
                // script (first message or error), not synchronously — some browsers
                // fetch the worker script lazily and revoking too early aborts it.
                const _hsWorker = this.hueSatWorker;
                const revokeUrl = () => {
                    URL.revokeObjectURL(url);
                    _hsWorker.removeEventListener('message', revokeUrl);
                    _hsWorker.removeEventListener('error', revokeUrl);
                };
                _hsWorker.addEventListener('error', revokeUrl);
                _hsWorker.addEventListener('message', revokeUrl);
                this.hueSatWorker.onmessage = (e) => {
                    const { id, buffer } = e.data || {};
                    const cb = this.hueSatWorkerCallbacks.get(id);
                    if (!cb) return;
                    this.hueSatWorkerCallbacks.delete(id);
                    cb(buffer);
                };
                this.hueSatWorker.onerror = () => {
                    this.hueSatWorkerFailed = true;
                    this.hueSatWorkerCallbacks.clear();
                    if (this.hueSatWorker) {
                        this.hueSatWorker.terminate();
                        this.hueSatWorker = null;
                    }
                };
                return this.hueSatWorker;
            },
            shouldUseHueSatWorker(w, h) {
                return !this.hueSatWorkerFailed && (w * h) >= 200000;
            },
            initHueSatWorkerBase() {
                if (!this.hueSatBackup) return;
                const worker = this.getHueSatWorker();
                if (!worker) return;
                const version = this.hueSatWorkerBaseVersion || 0;
                if (this._hueSatWorkerLastInitVersion === version) return;
                this._hueSatWorkerLastInitVersion = version;
                const bctx = this.hueSatBackup.getContext('2d');
                const baseData = bctx.getImageData(0, 0, this.hueSatBackup.width, this.hueSatBackup.height);
                const copy = baseData.data.slice();
                worker.postMessage({
                    type: 'init',
                    width: baseData.width,
                    height: baseData.height,
                    buffer: copy.buffer,
                    version: version
                }, [copy.buffer]);
            },
            runHueSatWorker(w, h, reqId) {
                const worker = this.getHueSatWorker();
                if (!worker) return Promise.resolve(null);
                const id = reqId || (++this.hueSatWorkerSeq);
                const payload = {
                    type: 'apply',
                    id,
                    width: w,
                    height: h,
                    channels: this.hueSatChannels,
                    order: ['Master', 'R', 'Y', 'G', 'C', 'B', 'M'],
                    version: this.hueSatWorkerBaseVersion || 0
                };
                return new Promise((resolve) => {
                    this.hueSatWorkerCallbacks.set(id, resolve);
                    worker.postMessage(payload);
                });
            },
            renderHueSatWork(work) {
                if (this.state.selection) {
                    if (this.state.selection.canvas && this.state.selection.canvas !== this.hueSatBackup) {
                        this.state.selection.canvas.width = 0;
                    }
                    this.state.selection.canvas = work;
                    this.state.selection._cache = null;
                    this.state.selection._glTexDirty = true;
                    this.renderSelection();
                    if (this.state.hueSatSplit) {
                        const s = this.state.selection;
                        const n = this.getNormalizedRect(s);
                        const destX = Math.floor(n.x);
                        const destY = Math.floor(n.y);
                        const destW = Math.floor(n.w);
                        const destH = Math.floor(n.h);
                        const splitX = Math.round(destW * this.state.hueSatSplitRatio);
                        const overlay = document.createElement('canvas');
                        overlay.width = work.width;
                        overlay.height = work.height;
                        const octx = overlay.getContext('2d');
                        octx.drawImage(this.hueSatBackup, 0, 0);
                        if (s.mask) {
                            octx.globalCompositeOperation = 'destination-in';
                            octx.drawImage(s.mask, 0, 0, overlay.width, overlay.height);
                            octx.globalCompositeOperation = 'source-over';
                        }
                        this.ctxTemp.save();
                        this.ctxTemp.beginPath();
                        this.ctxTemp.rect(destX + splitX, destY, destW - splitX, destH);
                        this.ctxTemp.clip();
                        this.ctxTemp.drawImage(overlay, destX, destY, destW, destH);
                        this.ctxTemp.restore();
                    }
                } else {
                    this.ctx.clearRect(0, 0, this.config.width, this.config.height);
                    this.ctx.drawImage(work, 0, 0);
                    if (this.state.hueSatSplit) {
                        const splitX = Math.round(work.width * this.state.hueSatSplitRatio);
                        this.ctx.save();
                        this.ctx.beginPath();
                        this.ctx.rect(splitX, 0, work.width - splitX, work.height);
                        this.ctx.clip();
                        this.ctx.drawImage(this.hueSatBackup, 0, 0);
                        this.ctx.restore();
                    }
                }
                this.updateHueSatSplitHandle();
            },
            updateHueSatPreview() {
                if (!this.state.hueSatActive || !this.hueSatBackup) return;
                if (this.hueSatPreviewBusy) {
                    clearTimeout(this.state.hueSatPreviewTimer);
                    this.state.hueSatPreviewTimer = setTimeout(() => this.updateHueSatPreview(), 40);
                    return;
                }
                // Live preview strip update
                this._hsUpdatePreviewColors();
                const now = performance.now();
                if (this.state.hueSatPreviewLast && now - this.state.hueSatPreviewLast < 40) {
                    clearTimeout(this.state.hueSatPreviewTimer);
                    this.state.hueSatPreviewTimer = setTimeout(() => this.updateHueSatPreview(), 40);
                    return;
                }
                this.state.hueSatPreviewLast = now;
                this.saveHueSatState();
                // Early exit if all channels are at default (no adjustment to apply)
                const allDefault = Object.values(this.hueSatChannels).every(c =>
                    !c || (!c.hue && !c.sat && !c.light && (c.chroma === undefined || c.chroma === 100) && !c.overlap)
                );
                if (allDefault) {
                    if (this.hueSatBackup) this.renderHueSatWork(this.hueSatBackup);
                    return;
                }
                this.hueSatPreviewBusy = true;
                const done = () => { this.hueSatPreviewBusy = false; };
                const fallback = () => {
                    done();
                    if (this.hueSatBackup) this.renderHueSatWork(this.hueSatBackup);
                };
                if (this.shouldUseHueSatGL(this.hueSatBackup.width, this.hueSatBackup.height)) {
                    const work = this.applyHueSatGL(this.hueSatBackup);
                    if (work) {
                        this.renderHueSatWork(work);
                        done();
                        return;
                    }
                }
                const work = document.createElement('canvas');
                const bw = this.hueSatBackup.width;
                const bh = this.hueSatBackup.height;
                work.width = bw;
                work.height = bh;
                const wctx = work.getContext('2d');
                if (this.shouldUseHueSatWorker(bw, bh)) {
                    this.initHueSatWorkerBase();
                    if (this.hueSatWorkerBusy) {
                        done();
                        this.hueSatWorkerPending = true;
                        return;
                    }
                    this.beginOperation();
                    this.hueSatWorkerBusy = true;
                    const reqId = ++this.hueSatWorkerSeq;
                    this.hueSatPreviewReq = reqId;
                    this.runHueSatWorker(bw, bh, reqId).then((buffer) => {
                        this.hueSatWorkerBusy = false;
                        this.endOperation();
                        done();
                        if (!this.state.hueSatActive) return;
                        if (reqId !== this.hueSatPreviewReq) return;
                        if (!buffer) { fallback(); return; }
                        if (buffer.byteLength !== bw * bh * 4) { fallback(); return; }
                        const out = new ImageData(new Uint8ClampedArray(buffer), bw, bh);
                        wctx.putImageData(out, 0, 0);
                        this.renderHueSatWork(work);
                        if (this.hueSatWorkerPending) {
                            this.hueSatWorkerPending = false;
                            this.updateHueSatPreview();
                        }
                    });
                    clearTimeout(this.state.hueSatWorkerTimeout);
                    this.state.hueSatWorkerTimeout = setTimeout(() => {
                        if (this.hueSatPreviewReq !== reqId) return;
                        this.hueSatWorkerFailed = true;
                        this.hueSatWorkerBusy = false;
                        this.hueSatWorkerPending = false;
                        this.endOperation();
                        done();
                        this.updateHueSatPreview();
                    }, 250);
                    return;
                }
                try {
                    wctx.drawImage(this.hueSatBackup, 0, 0);
                    const imgData = wctx.getImageData(0, 0, bw, bh);
                    this.applyHueSatAll(imgData);
                    wctx.putImageData(imgData, 0, 0);
                    this.renderHueSatWork(work);
                    done();
                } catch (e) {
                    fallback();
                }
            },
            applyHueSatAll(imgData) {
                const order = ['Master', 'R', 'Y', 'G', 'C', 'B', 'M'];
                for (const channel of order) {
                    const c = this.hueSatChannels[channel];
                    if (!c) continue;
                    const chroma = c.chroma !== undefined ? c.chroma : 100;
                    if (!c.hue && !c.sat && !c.light && chroma === 100 && !c.overlap) continue;
                    this.applyHueSatToImageData(imgData, c.hue || 0, c.sat || 0, c.light || 0, channel, c.overlap || 0, chroma);
                }
            },
            applyHueSatToImageData(imgData, hue, sat, light, channel, overlap, chroma) {
                const d = imgData.data;
                const hueShift = hue / 360;
                const satShift = sat / 100;
                const lightShift = light / 100;
                const chromaScale = (chroma !== undefined ? chroma : 100) / 100;
                const hueCenters = { R: 0, Y: 60, G: 120, C: 180, B: 240, M: 300 };
                const useChannel = channel && channel !== 'Master' && hueCenters[channel] !== undefined;
                const range = Math.min(180, 20 + (overlap || 0) * 1.6);
                for (let i = 0; i < d.length; i += 4) {
                    const r = d[i] / 255;
                    const g = d[i + 1] / 255;
                    const b = d[i + 2] / 255;
                    const wasAchromatic = (r === g && g === b);
                    const hsl = this.rgbToHsl(r, g, b);
                    if (useChannel) {
                        const center = hueCenters[channel] / 360;
                        let dist = Math.abs(hsl.h - center);
                        dist = Math.min(dist, 1 - dist);
                        const deg = dist * 360;
                        if (deg > range / 2) continue;
                    }
                    let nh = hsl.h + hueShift;
                    nh = nh - Math.floor(nh);
                    let ns = Math.max(0, Math.min(1, hsl.s + satShift));
                    if (wasAchromatic && !hueShift) ns = 0;
                    let nl = Math.max(0, Math.min(1, hsl.l + lightShift));
                    let or = r, og = g, ob = b;
                    if (hueShift || satShift || lightShift) {
                        const c = this.hslToRgb(nh, ns, nl);
                        or = c.r; og = c.g; ob = c.b;
                    }
                    if (chromaScale !== 1) {
                        const lab = this._rgbToLab(or, og, ob);
                        lab.A *= chromaScale;
                        lab.B *= chromaScale;
                        const c = this._labToRgb(lab.L, lab.A, lab.B);
                        or = c.r; og = c.g; ob = c.b;
                    }
                    d[i]     = Math.round(or * 255);
                    d[i + 1] = Math.round(og * 255);
                    d[i + 2] = Math.round(ob * 255);
                }
            },
            async applyDepth() {
                this.beginOperation();
                await new Promise((resolve) => setTimeout(resolve, 0));
                try {
                    const mode = document.querySelector('input[name="depth"]:checked').value;
                    const dither = document.getElementById('chk-dither').checked;
                    const grayscale = document.getElementById('chk-gray').checked;

                    const target = this.state.selection ? this.state.selection.canvas : this.ui.cMain;
                    if (!this.depthBackup) {
                        const backup = document.createElement('canvas');
                        backup.width = target.width;
                        backup.height = target.height;
                        backup.getContext('2d').drawImage(target, 0, 0);
                        this.depthBackup = backup;
                    }

                    // Always revert to the pre-apply backup before reprocessing.
                    const targetCtx2 = target.getContext('2d');
                    targetCtx2.clearRect(0, 0, target.width, target.height);
                    targetCtx2.drawImage(this.depthBackup, 0, 0);

                    const work = document.createElement('canvas');
                    work.width = this.depthBackup.width;
                    work.height = this.depthBackup.height;
                    const targetCtx = work.getContext('2d');
                    targetCtx.drawImage(this.depthBackup, 0, 0);
                    const w = work.width;
                    const h = work.height;
                    const imgData = targetCtx.getImageData(0, 0, w, h);
                    const d = imgData.data;

                    const applyDither = (quantizeFn) => {
                        const workPixels = new Float32Array(w * h * 3);
                        const clamp255 = (v) => Math.max(0, Math.min(255, v));
                        for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
                            let r = d[i], g = d[i + 1], b = d[i + 2];
                            if (grayscale) {
                                const lum = r * 0.299 + g * 0.587 + b * 0.114;
                                r = lum; g = lum; b = lum;
                            }
                            workPixels[j] = r;
                            workPixels[j + 1] = g;
                            workPixels[j + 2] = b;
                        }
                        const addError = (x, y, er, eg, eb, weight) => {
                            if (x < 0 || x >= w || y < 0 || y >= h) return;
                            const di = (y * w + x) * 4;
                            if (d[di + 3] === 0) return;
                            const pi = (y * w + x) * 3;
                            workPixels[pi] += er * weight;
                            workPixels[pi + 1] += eg * weight;
                            workPixels[pi + 2] += eb * weight;
                        };
                        for (let y = 0; y < h; y++) {
                            for (let x = 0; x < w; x++) {
                                const di = (y * w + x) * 4;
                                const a = d[di + 3];
                                if (a === 0) continue;
                                const pi = (y * w + x) * 3;
                                const r = clamp255(workPixels[pi]);
                                const g = clamp255(workPixels[pi + 1]);
                                const b = clamp255(workPixels[pi + 2]);
                                const q = quantizeFn(r, g, b);
                                d[di] = q.r; d[di + 1] = q.g; d[di + 2] = q.b; d[di + 3] = a;
                                const er = r - q.r;
                                const eg = g - q.g;
                                const eb = b - q.b;
                                addError(x + 1, y, er, eg, eb, 7 / 16);
                                addError(x - 1, y + 1, er, eg, eb, 3 / 16);
                                addError(x, y + 1, er, eg, eb, 5 / 16);
                                addError(x + 1, y + 1, er, eg, eb, 1 / 16);
                            }
                        }
                    };
                    const applyDirect = (quantizeFn) => {
                        for (let i = 0; i < d.length; i += 4) {
                            const a = d[i+3];
                            if (a === 0) continue;
                            let r = d[i], g = d[i+1], b = d[i+2];
                            if (grayscale) {
                                const lum = r * 0.299 + g * 0.587 + b * 0.114;
                                r = lum; g = lum; b = lum;
                            }
                            const q = quantizeFn(r, g, b);
                            d[i] = q.r; d[i+1] = q.g; d[i+2] = q.b;
                        }
                    };

                    if (mode === 'full') {
                        if (grayscale) {
                            for (let i = 0; i < d.length; i += 4) {
                                const lum = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
                                d[i] = lum; d[i+1] = lum; d[i+2] = lum;
                            }
                        }
                        targetCtx.putImageData(imgData, 0, 0);
                        target.getContext('2d').clearRect(0, 0, target.width, target.height);
                        target.getContext('2d').drawImage(work, 0, 0);
                        if(this.state.selection) { this.state.selection._baseRect = null; this.renderSelection(); } else this.saveState();
                        return;
                    }

                    if (mode === 'rgb565' || mode === 'rgb555') {
                        if (!dither && this.applyWebGLQuantize(mode, this.depthBackup, target, grayscale)) {
                            if(this.state.selection) this.renderSelection(); else this.saveState();
                            return;
                        }
                        const quantizeFn = (r, g, b) => mode === 'rgb565' ? this.quantizeRgb565(r, g, b) : this.quantizeRgb555(r, g, b);
                        if (dither) applyDither(quantizeFn);
                        else applyDirect(quantizeFn);
                        targetCtx.putImageData(imgData, 0, 0);
                        target.getContext('2d').clearRect(0, 0, target.width, target.height);
                        target.getContext('2d').drawImage(work, 0, 0);
                        if(this.state.selection) { this.state.selection._baseRect = null; this.renderSelection(); } else this.saveState();
                        return;
                    }

                    let K = 256;
                    if (mode === '16') K = 16;
                    if (mode === '4') K = 4;
                    if (mode === '2') K = 2;
                    if (mode === '2bw') K = 2;
                    if (mode === 'custom') K = parseInt(document.getElementById('custom-depth-val').value, 10);
                    if (!K || K < 2) K = 2;
                    if (K > 256) K = 256;

                    let palette = null;
                    if (mode === '2bw') {
                        palette = [
                            { r: 0, g: 0, b: 0, a: 255 },
                            { r: 255, g: 255, b: 255, a: 255 }
                        ];
                    } else if (document.getElementById('chk-progressive').checked) {
                        palette = this.buildProgressivePalette(imgData, w, h, K);
                    } else {
                        palette = this.buildWuPalette(imgData, w, h, K);
                    }
                    const paletteLookup = this.buildPaletteLookup(palette);
                    const quantizeFn = (r, g, b) => this.quantizeRgbWithLookup(r, g, b, paletteLookup);

                    if (dither) applyDither(quantizeFn);
                    else applyDirect(quantizeFn);

                    targetCtx.putImageData(imgData, 0, 0);
                    target.getContext('2d').clearRect(0, 0, target.width, target.height);
                    target.getContext('2d').drawImage(work, 0, 0);
                    this.palette = palette;
                    this.paletteLab = null;
                    if(this.state.selection) {
                        this.state.selection._baseRect = null;
                        this.state.selection.palette = palette;
                        this.state.selection._needsPaletteEnforce = false;
                        this.state.selection._glTexDirty = true;
                        this.state.selection._cache = null;
                        this.renderSelection();
                    } else {
                        this.saveState();
                    }
                } finally {
                    this._closeActiveSidebar(true);
                    this.endOperation();
                }
            },

            syncHueSatInput(kind) {
                const map = {
                    hue: { range: 'hs-hue', num: 'hs-hue-num' },
                    sat: { range: 'hs-sat', num: 'hs-sat-num' },
                    light: { range: 'hs-light', num: 'hs-light-num' },
                    chroma: { range: 'hs-chroma', num: 'hs-chroma-num' },
                    overlap: { range: 'hs-overlap', num: 'hs-overlap-num' }
                };
                const cfg = map[kind];
                if (!cfg) return;
                const range = document.getElementById(cfg.range);
                const num = document.getElementById(cfg.num);
                if (range && num) num.value = range.value;
            },
            syncHueSatNumber(kind) {
                const map = {
                    hue: { range: 'hs-hue', num: 'hs-hue-num' },
                    sat: { range: 'hs-sat', num: 'hs-sat-num' },
                    light: { range: 'hs-light', num: 'hs-light-num' },
                    chroma: { range: 'hs-chroma', num: 'hs-chroma-num' },
                    overlap: { range: 'hs-overlap', num: 'hs-overlap-num' }
                };
                const cfg = map[kind];
                if (!cfg) return;
                const range = document.getElementById(cfg.range);
                const num = document.getElementById(cfg.num);
                if (range && num) range.value = num.value;
            },
            async applyHueSat() {
                this.state.hueSatApplied = true;
                this.state.hueSatActive = false;
                this.hideHueSatSplitHandle();
                clearTimeout(this.state.hueSatPreviewTimer);
                this.state.hueSatPreviewTimer = null;
                clearTimeout(this.state.hueSatWorkerTimeout);
                this.state.hueSatWorkerTimeout = null;
                if (!this.state.selection) {
                    if (this.state.hueSatSplit && this.hueSatBackup) {
                        this.saveHueSatState();
                        if (this.shouldUseHueSatGL(this.hueSatBackup.width, this.hueSatBackup.height)) {
                            const work = this.applyHueSatGL(this.hueSatBackup);
                            if (work) {
                                this.ctx.clearRect(0, 0, this.config.width, this.config.height);
                                this.ctx.drawImage(work, 0, 0);
                                this.saveState();
                                if (this.bitDepth !== 24) {
                                    this.applyCurrentModeToCanvas(this.ctx, this.config.width, this.config.height, false);
                                }
                                this.resetHueSatUI();
                                this.hueSatBaseData = null;
                                this.hueSatWorkerBaseVersion = 0;
                                if (this.hueSatWorker) { this.hueSatWorker.terminate(); this.hueSatWorker = null; this.hueSatWorkerCallbacks?.clear(); }
                                this.disposeHueSatGL();
                                this.hueSatBackup = null;
                                this._closeHueSatSidebarIfActive();
                                return;
                            }
                        }
                        const work = document.createElement('canvas');
                        const bw = this.hueSatBackup.width;
                        const bh = this.hueSatBackup.height;
                        work.width = bw;
                        work.height = bh;
                        const wctx = work.getContext('2d');
                        if (this.shouldUseHueSatWorker(bw, bh)) {
                            this.initHueSatWorkerBase();
                            const reqId = ++this.hueSatWorkerSeq;
                            this.beginOperation();
                            try {
                                const buffer = await this.runHueSatWorker(bw, bh, reqId);
                                if (buffer) {
                                    const out = new ImageData(new Uint8ClampedArray(buffer), bw, bh);
                                    wctx.putImageData(out, 0, 0);
                                }
                            } finally {
                                this.endOperation();
                            }
                        } else {
                            wctx.drawImage(this.hueSatBackup, 0, 0);
                            const imgData = wctx.getImageData(0, 0, bw, bh);
                            this.applyHueSatAll(imgData);
                            wctx.putImageData(imgData, 0, 0);
                        }
                        this.ctx.clearRect(0, 0, this.config.width, this.config.height);
                        this.ctx.drawImage(work, 0, 0);
                    }
                    this.saveState();
                    if (this.bitDepth !== 24) {
                        this.applyCurrentModeToCanvas(this.ctx, this.config.width, this.config.height, false);
                    }
                    this.resetHueSatUI();
                    this.hueSatBaseData = null;
                    this.hueSatWorkerBaseVersion = 0;
                    if (this.hueSatWorker) { this.hueSatWorker.terminate(); this.hueSatWorker = null; this.hueSatWorkerCallbacks?.clear(); }
                    this.disposeHueSatGL();
                    this.hueSatBackup = null;
                    this._closeHueSatSidebarIfActive();
                    return;
                }
                this.state.selection._forceOpaque = false;
                this.state.selection.palette = null;
                this.state.selection._needsPaletteEnforce = false;
                this.state.selection._glTexDirty = true;
                this.state.selection._cache = null;
                this.state.selection._disablePalette = false;
                this.renderSelection();
                this.deferSelectionRenderFinalize(this.state.selection);
                this.resetHueSatUI();
                this.hueSatBaseData = null;
                this.hueSatWorkerBaseVersion = 0;
                if (this.hueSatWorker) { this.hueSatWorker.terminate(); this.hueSatWorker = null; this.hueSatWorkerCallbacks?.clear(); }
                this.disposeHueSatGL();
                this.hueSatBackup = null;
                this._closeHueSatSidebarIfActive();
            }
    });
})();
