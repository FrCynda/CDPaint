/* transform — moved verbatim off the PaintEngine class body.
 *
 * Assigned onto the prototype, so `this` is the same PaintEngine instance
 * these methods have always run against. Loads after paint-engine.js and
 * before boot.js, which is where the instance is finally created.
 */
(function () {
    Object.assign(PaintEngine.prototype, {
            updateCanvasResizeHandles() {
                if (!this.bounds || !this.ui.viewport) return;
                const handles = this.ui.canvasResizeHandles;
                if (!handles) return;
                const vpRect = this.ui.viewport.getBoundingClientRect();
                const rect = this.bounds;
                // Before the first real measurement `bounds` is a stub with no size.
                // Writing NaN offsets from it leaves every handle at its static spot
                // — the top-left of the viewport — so bail and stay hidden instead.
                if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return;
                const size = 6;
                const half = size / 2;
                const baseX = rect.left - vpRect.left + this.ui.viewport.scrollLeft;
                const baseY = rect.top - vpRect.top + this.ui.viewport.scrollTop;
                const edgeX = Math.floor(baseX + rect.width);
                const edgeY = Math.floor(baseY + rect.height);
                const leftX = Math.floor(baseX - size);
                const topY = Math.floor(baseY - size);
                const midX = Math.floor(baseX + rect.width / 2 - half);
                const midY = Math.floor(baseY + rect.height / 2 - half);
                const set = (el, x, y) => {
                    if (!el) return;
                    el.style.left = `${x}px`;
                    el.style.top = `${y}px`;
                };
                set(this.ui.resizerRight, edgeX, midY);
                set(this.ui.resizerBottom, midX, edgeY);
                set(this.ui.resizerCorner, edgeX, edgeY);
                set(this.ui.resizerLeft, leftX, midY);
                set(this.ui.resizerTop, midX, topY);
                set(this.ui.resizerTL, leftX, topY);
                set(this.ui.resizerTR, edgeX, topY);
                set(this.ui.resizerBL, leftX, edgeY);
                handles.classList.add('positioned');
            },
            cancelResize() {
                const resizeDocked = this._activeSidebarModalId === 'resize';
                if (resizeDocked) {
                    this._closeUnifiedSidebar(true);
                }
                this.state.resizePreviewActive = false;
                this.state.resizePreviewRect = null;
                this.state.resizePreviewGhost = null;
                if (!resizeDocked) {
                    const m = document.getElementById('modal-resize');
                    if (m) m.style.display = 'none';
                }
            },
            rotateCanvasNearest(source, angleDeg, options = {}) {
                if (!source) return null;
                const srcW = Math.max(1, source.width | 0);
                const srcH = Math.max(1, source.height | 0);
                const snapAngle = Math.round(angleDeg / 90) * 90;
                const normalizedAngle = this.normalizeAngleDegrees(angleDeg);
                if (Math.abs(normalizedAngle - snapAngle) < 0.0001) {
                    const c = document.createElement('canvas');
                    const x = c.getContext('2d');
                    this.disableSmoothing(x);
                    if (Math.abs(snapAngle) % 180 === 90) {
                        c.width = srcH;
                        c.height = srcW;
                    } else {
                        c.width = srcW;
                        c.height = srcH;
                    }
                    x.translate(c.width / 2, c.height / 2);
                    x.rotate(snapAngle * Math.PI / 180);
                    x.drawImage(source, -srcW / 2, -srcH / 2);
                    return c;
                }

                const rad = angleDeg * Math.PI / 180;
                const cos = Math.cos(rad);
                const sin = Math.sin(rad);
                const halfW = srcW / 2;
                const halfH = srcH / 2;
                const corners = [
                    { x: -halfW, y: -halfH },
                    { x: halfW, y: -halfH },
                    { x: halfW, y: halfH },
                    { x: -halfW, y: halfH }
                ];
                let minX = Infinity;
                let minY = Infinity;
                let maxX = -Infinity;
                let maxY = -Infinity;
                for (const corner of corners) {
                    const rx = (corner.x * cos) - (corner.y * sin);
                    const ry = (corner.x * sin) + (corner.y * cos);
                    if (rx < minX) minX = rx;
                    if (ry < minY) minY = ry;
                    if (rx > maxX) maxX = rx;
                    if (ry > maxY) maxY = ry;
                }

                const outW = Math.max(1, Math.ceil(maxX - minX));
                const outH = Math.max(1, Math.ceil(maxY - minY));
                const srcCtx = source.getContext('2d', { willReadFrequently: true });
                const srcImage = srcCtx.getImageData(0, 0, srcW, srcH);
                const srcData = srcImage.data;
                const out = document.createElement('canvas');
                out.width = outW;
                out.height = outH;
                const outCtx = out.getContext('2d');
                this.disableSmoothing(outCtx);
                const outImage = outCtx.createImageData(outW, outH);
                const outData = outImage.data;
                // options.binary=true: single centre sample (fast, alias-free for 1-bit art).
                // Default: 5 sub-pixel offsets averaged via majority vote for smooth results.
                const sampleOffsets = options.binary ? [[0, 0]] : [[0, 0], [-0.25, 0], [0.25, 0], [0, -0.25], [0, 0.25]];
                const minAlpha = options.binary ? 1 : 96;

                const readSample = (dx, dy) => {
                    const sx = (dx * cos) + (dy * sin);
                    const sy = (-dx * sin) + (dy * cos);
                    const px = Math.round(sx + halfW - 0.5);
                    const py = Math.round(sy + halfH - 0.5);
                    if (px < 0 || py < 0 || px >= srcW || py >= srcH) return null;
                    const idx = ((py * srcW) + px) * 4;
                    const a = srcData[idx + 3];
                    if (a < minAlpha) return null;
                    return {
                        r: srcData[idx],
                        g: srcData[idx + 1],
                        b: srcData[idx + 2],
                        a,
                        key: `${srcData[idx]},${srcData[idx + 1]},${srcData[idx + 2]},${a}`
                    };
                };

                for (let y = 0; y < outH; y++) {
                    for (let x = 0; x < outW; x++) {
                        const centerX = minX + x + 0.5;
                        const centerY = minY + y + 0.5;
                        let best = null;
                        let bestScore = -1;
                        const counts = new Map();
                        for (const [offX, offY] of sampleOffsets) {
                            const sample = readSample(centerX + offX, centerY + offY);
                            if (!sample) continue;
                            const score = (counts.get(sample.key) || 0) + 1;
                            counts.set(sample.key, score);
                            if (score > bestScore) {
                                best = sample;
                                bestScore = score;
                            }
                        }
                        if (!best) continue;
                        const idx = ((y * outW) + x) * 4;
                        outData[idx] = best.r;
                        outData[idx + 1] = best.g;
                        outData[idx + 2] = best.b;
                        outData[idx + 3] = best.a;
                    }
                }

                outCtx.putImageData(outImage, 0, 0);
                return out;
            },
            initCleanEdgeRotateGL() {
                if (this.cleanEdgeRotateGL) return this.cleanEdgeRotateGL;
                const canvas = document.createElement('canvas');
                const gl = canvas.getContext('webgl2', {
                    antialias: false,
                    premultipliedAlpha: false,
                    preserveDrawingBuffer: true
                });
                if (!gl) return null;
                const vsSrc = `#version 300 es
    precision highp float;
    in vec2 a_position;
    in vec2 a_texcoord;
    uniform vec2 u_outputSize;
    uniform float u_angle;
    out vec2 v_texCoord;
    void main() {
        float c = cos(u_angle);
        float s = sin(u_angle);
        vec2 rotated = vec2(
            (a_position.x * c) - (a_position.y * s),
            (a_position.x * s) + (a_position.y * c)
        );
        vec2 clip = vec2(
            (rotated.x / (u_outputSize.x * 0.5)),
            (-rotated.y / (u_outputSize.y * 0.5))
        );
        v_texCoord = a_texcoord;
        gl_Position = vec4(clip, 0.0, 1.0);
    }`;
                // Fragment shader adapted from torcado's MIT-licensed "CleanEdge" pixel-art
                // rotation shader. Detects diagonal edges in the source image and blends
                // neighbouring pixels to produce smooth, aliasing-free rotated sprites.
                // Original: https://gist.github.com/torcado194/e2794f5a4b22049ac0a41f972d14c329
                const fsSrc = `#version 300 es
    precision highp float;
    uniform vec2 iResolution;
    uniform sampler2D iChannel0;
    uniform bool SLOPE;
    uniform vec3 highestColor;
    uniform float similarThreshold;
    uniform float lineWidth;
    in vec2 v_texCoord;
    out vec4 fragColor;

    bool similar(vec4 col1, vec4 col2){
        return (col1.a == 0.0 && col2.a == 0.0) || distance(col1, col2) <= similarThreshold;
    }
    bool similar3(vec4 col1, vec4 col2, vec4 col3){
        return similar(col1, col2) && similar(col2, col3);
    }
    bool similar4(vec4 col1, vec4 col2, vec4 col3, vec4 col4){
        return similar(col1, col2) && similar(col2, col3) && similar(col3, col4);
    }
    bool higher(vec4 thisCol, vec4 otherCol){
        if(similar(thisCol, otherCol)) return false;
        if(thisCol.a == otherCol.a){
            return distance(thisCol.rgb, highestColor) < distance(otherCol.rgb, highestColor);
        }
        return thisCol.a > otherCol.a;
    }
    float cd(vec4 col1, vec4 col2){
        return distance(col1.rgba, col2.rgba);
    }
    float distToLine(vec2 testPt, vec2 pt1, vec2 pt2, vec2 dir){
        vec2 lineDir = pt2 - pt1;
        vec2 perpDir = vec2(lineDir.y, -lineDir.x);
        vec2 dirToPt1 = pt1 - testPt;
        return (dot(perpDir, dir) > 0.0 ? 1.0 : -1.0) * dot(normalize(perpDir), dirToPt1);
    }
    vec4 sliceDist(vec2 point, vec2 mainDir, vec2 pointDir, vec4 ub, vec4 u, vec4 uf, vec4 uff, vec4 b, vec4 c, vec4 f, vec4 ff, vec4 db, vec4 d, vec4 df, vec4 dff, vec4 ddb, vec4 dd, vec4 ddf){
        float minWidth = 0.0;
        float maxWidth = 1.4;
        if(SLOPE){
            minWidth = 0.45;
            maxWidth = 1.142;
        }
        float _lineWidth = max(minWidth, min(maxWidth, lineWidth));
        point = mainDir * (point - 0.5) + 0.5;
        float distAgainst = 4.0*cd(f,d) + cd(uf,c) + cd(c,db) + cd(ff,df) + cd(df,dd);
        float distTowards = 4.0*cd(c,df) + cd(u,f) + cd(f,dff) + cd(b,d) + cd(d,ddf);
        bool shouldSlice = (distAgainst < distTowards) || ((distAgainst < distTowards + 0.001) && !higher(c, f));
        if(similar4(f, d, b, u) && similar4(uf, df, db, ub) && !similar(c, f)) shouldSlice = false;
        if(!shouldSlice) return vec4(-1.0);

        float dist = 1.0;
        bool flip = false;
        vec2 center = vec2(0.5, 0.5);

        if(SLOPE && similar3(f, d, db) && !similar3(f, d, b) && !similar(uf, db)){
            if(!(similar(c, df) && higher(c, f))){
                if(higher(c, f)) flip = true;
                if(similar(u, f) && !similar(c, df) && !higher(c, u)) flip = true;
            }
            if(flip){
                dist = _lineWidth - distToLine(point, center + vec2(1.5, -1.0) * pointDir, center + vec2(-0.5, 0.0) * pointDir, -pointDir);
            } else {
                dist = distToLine(point, center + vec2(1.5, 0.0) * pointDir, center + vec2(-0.5, 1.0) * pointDir, pointDir);
            }
            if(!flip && similar(c, uf) && !(similar3(c, uf, uff) && !similar3(c, uf, ff) && !similar(d, uff))){
                float dist2 = distToLine(point, center + vec2(2.0, -1.0) * pointDir, center + vec2(0.0, 1.0) * pointDir, pointDir);
                dist = min(dist, dist2);
            }
            dist -= (_lineWidth / 2.0);
            return dist <= 0.0 ? ((cd(c, f) <= cd(c, d)) ? f : d) : vec4(-1.0);
        } else if(SLOPE && similar3(uf, f, d) && !similar3(u, f, d) && !similar(uf, db)){
            if(!(similar(c, df) && higher(c, d))){
                if(higher(c, d)) flip = true;
                if(similar(b, d) && !similar(c, df) && !higher(c, d)) flip = true;
            }
            if(flip){
                dist = _lineWidth - distToLine(point, center + vec2(0.0, -0.5) * pointDir, center + vec2(-1.0, 1.5) * pointDir, -pointDir);
            } else {
                dist = distToLine(point, center + vec2(1.0, -0.5) * pointDir, center + vec2(0.0, 1.5) * pointDir, pointDir);
            }
            if(!flip && similar(c, db) && !(similar3(c, db, ddb) && !similar3(c, db, dd) && !similar(f, ddb))){
                float dist2 = distToLine(point, center + vec2(1.0, 0.0) * pointDir, center + vec2(-1.0, 2.0) * pointDir, pointDir);
                dist = min(dist, dist2);
            }
            dist -= (_lineWidth / 2.0);
            return dist <= 0.0 ? ((cd(c, f) <= cd(c, d)) ? f : d) : vec4(-1.0);
        } else if(similar(f, d)) {
            if(similar(c, df) && higher(c, f)){
                if(!similar(c, dd) && !similar(c, ff)) flip = true;
            } else {
                if(higher(c, f)) flip = true;
                if(!similar(c, b) && similar4(b, f, d, u)) flip = true;
            }
            if((((similar(f, db) && similar3(u, f, df)) || (similar(uf, d) && similar3(b, d, df))) && !similar(c, df))) flip = true;
            if(flip){
                dist = _lineWidth - distToLine(point, center + vec2(1.0, -1.0) * pointDir, center + vec2(-1.0, 1.0) * pointDir, -pointDir);
            } else {
                dist = distToLine(point, center + vec2(1.0, 0.0) * pointDir, center + vec2(0.0, 1.0) * pointDir, pointDir);
            }
            if(SLOPE){
                if(!flip && similar3(c, uf, uff) && !similar3(c, uf, ff) && !similar(d, uff)){
                    float dist2 = distToLine(point, center + vec2(1.5, 0.0) * pointDir, center + vec2(-0.5, 1.0) * pointDir, pointDir);
                    dist = max(dist, dist2);
                }
                if(!flip && similar3(ddb, db, c) && !similar3(dd, db, c) && !similar(ddb, f)){
                    float dist2 = distToLine(point, center + vec2(1.0, -0.5) * pointDir, center + vec2(0.0, 1.5) * pointDir, pointDir);
                    dist = max(dist, dist2);
                }
            }
            dist -= (_lineWidth / 2.0);
            return dist <= 0.0 ? ((cd(c, f) <= cd(c, d)) ? f : d) : vec4(-1.0);
        } else if(SLOPE && similar3(ff, df, d) && !similar3(ff, df, c) && !similar(uff, d)){
            if(!(similar(f, dff) && higher(f, ff))){
                if(higher(f, ff)) flip = true;
                if(similar(uf, ff) && !similar(f, dff) && !higher(f, uf)) flip = true;
            }
            if(flip){
                dist = _lineWidth - distToLine(point, center + vec2(2.5, -1.0) * pointDir, center + vec2(0.5, 0.0) * pointDir, -pointDir);
            } else {
                dist = distToLine(point, center + vec2(2.5, 0.0) * pointDir, center + vec2(0.5, 1.0) * pointDir, pointDir);
            }
            dist -= (_lineWidth / 2.0);
            return dist <= 0.0 ? ((cd(f, ff) <= cd(f, df)) ? ff : df) : vec4(-1.0);
        } else if(SLOPE && similar3(f, df, dd) && !similar3(c, df, dd) && !similar(f, ddb)){
            if(!(similar(d, ddf) && higher(d, dd))){
                if(higher(d, dd)) flip = true;
                if(similar(db, dd) && !similar(d, ddf) && !higher(d, dd)) flip = true;
            }
            if(flip){
                dist = _lineWidth - distToLine(point, center + vec2(0.0, 0.5) * pointDir, center + vec2(-1.0, 2.5) * pointDir, -pointDir);
            } else {
                dist = distToLine(point, center + vec2(1.0, 0.5) * pointDir, center + vec2(0.0, 2.5) * pointDir, pointDir);
            }
            dist -= (_lineWidth / 2.0);
            return dist <= 0.0 ? ((cd(d, df) <= cd(d, dd)) ? df : dd) : vec4(-1.0);
        }
        return vec4(-1.0);
    }
    void main() {
        vec2 fragCoord = v_texCoord * iResolution.xy;
        vec2 size = iResolution.xy + 0.5;
        vec2 px = fragCoord.xy;
        vec2 local = fract(px);
        px = ceil(px);
        vec2 pointDir = round(local) * 2.0 - 1.0;

        vec4 uub = texture(iChannel0, (px + vec2(-1.0, -2.0) * pointDir) / size);
        vec4 uu  = texture(iChannel0, (px + vec2( 0.0, -2.0) * pointDir) / size);
        vec4 uuf = texture(iChannel0, (px + vec2( 1.0, -2.0) * pointDir) / size);
        vec4 ubb = texture(iChannel0, (px + vec2(-2.0, -2.0) * pointDir) / size);
        vec4 ub  = texture(iChannel0, (px + vec2(-1.0, -1.0) * pointDir) / size);
        vec4 u   = texture(iChannel0, (px + vec2( 0.0, -1.0) * pointDir) / size);
        vec4 uf  = texture(iChannel0, (px + vec2( 1.0, -1.0) * pointDir) / size);
        vec4 uff = texture(iChannel0, (px + vec2( 2.0, -1.0) * pointDir) / size);
        vec4 bb  = texture(iChannel0, (px + vec2(-2.0,  0.0) * pointDir) / size);
        vec4 b   = texture(iChannel0, (px + vec2(-1.0,  0.0) * pointDir) / size);
        vec4 c   = texture(iChannel0, (px + vec2( 0.0,  0.0) * pointDir) / size);
        vec4 f   = texture(iChannel0, (px + vec2( 1.0,  0.0) * pointDir) / size);
        vec4 ff  = texture(iChannel0, (px + vec2( 2.0,  0.0) * pointDir) / size);
        vec4 dbb = texture(iChannel0, (px + vec2(-2.0,  1.0) * pointDir) / size);
        vec4 db  = texture(iChannel0, (px + vec2(-1.0,  1.0) * pointDir) / size);
        vec4 d   = texture(iChannel0, (px + vec2( 0.0,  1.0) * pointDir) / size);
        vec4 df  = texture(iChannel0, (px + vec2( 1.0,  1.0) * pointDir) / size);
        vec4 dff = texture(iChannel0, (px + vec2( 2.0,  1.0) * pointDir) / size);
        vec4 ddb = texture(iChannel0, (px + vec2(-1.0,  2.0) * pointDir) / size);
        vec4 dd  = texture(iChannel0, (px + vec2( 0.0,  2.0) * pointDir) / size);
        vec4 ddf = texture(iChannel0, (px + vec2( 1.0,  2.0) * pointDir) / size);

        vec4 col = c;
        vec4 c_col = sliceDist(local, vec2( 1.0, 1.0), pointDir, ub, u, uf, uff, b, c, f, ff, db, d, df, dff, ddb, dd, ddf);
        vec4 b_col = sliceDist(local, vec2(-1.0, 1.0), pointDir, uf, u, ub, ubb, f, c, b, bb, df, d, db, dbb, ddf, dd, ddb);
        vec4 u_col = sliceDist(local, vec2( 1.0,-1.0), pointDir, db, d, df, dff, b, c, f, ff, ub, u, uf, uff, uub, uu, uuf);
        if(c_col.r >= 0.0) col = c_col;
        if(b_col.r >= 0.0) col = b_col;
        if(u_col.r >= 0.0) col = u_col;
        fragColor = col;
    }`;
                const compile = (type, src) => {
                    const shader = gl.createShader(type);
                    gl.shaderSource(shader, src);
                    gl.compileShader(shader);
                    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                        console.warn('CleanEdge shader compile failed', gl.getShaderInfoLog(shader));
                        return null;
                    }
                    return shader;
                };
                const vs = compile(gl.VERTEX_SHADER, vsSrc);
                const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
                if (!vs || !fs) return null;
                const prog = gl.createProgram();
                gl.attachShader(prog, vs);
                gl.attachShader(prog, fs);
                gl.linkProgram(prog);
                if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
                    console.warn('CleanEdge program link failed', gl.getProgramInfoLog(prog));
                    return null;
                }
                const posBuf = gl.createBuffer();
                const texBuf = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                    0, 0,
                    1, 0,
                    0, 1,
                    1, 1
                ]), gl.STATIC_DRAW);
                const texture = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, texture);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                this.cleanEdgeRotateGL = {
                    canvas,
                    gl,
                    prog,
                    posBuf,
                    texBuf,
                    texture,
                    aPosition: gl.getAttribLocation(prog, 'a_position'),
                    aTexcoord: gl.getAttribLocation(prog, 'a_texcoord'),
                    uOutputSize: gl.getUniformLocation(prog, 'u_outputSize'),
                    uAngle: gl.getUniformLocation(prog, 'u_angle'),
                    uResolution: gl.getUniformLocation(prog, 'iResolution'),
                    uImage: gl.getUniformLocation(prog, 'iChannel0'),
                    uSlope: gl.getUniformLocation(prog, 'SLOPE'),
                    uHighestColor: gl.getUniformLocation(prog, 'highestColor'),
                    uSimilarThreshold: gl.getUniformLocation(prog, 'similarThreshold'),
                    uLineWidth: gl.getUniformLocation(prog, 'lineWidth')
                };
                canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.cleanEdgeRotateGL = null; }, { once: true });
                return this.cleanEdgeRotateGL;
            },
            toggleSelRotateAnchorMode() {
                this.state.selRotateAnchorMode = !this.state.selRotateAnchorMode;
                const el = this.ui.selControls;
                const rotateHandle = el ? el.querySelector('.sel-rotate-handle') : null;
                if (this.state.selRotateAnchorMode) {
                    el && el.classList.add('sel-anchor-mode');
                    rotateHandle && rotateHandle.classList.add('anchor-mode');
                    rotateHandle && (rotateHandle.title = 'Rotate (anchor mode) — right-click to exit');
                } else {
                    el && el.classList.remove('sel-anchor-mode');
                    rotateHandle && rotateHandle.classList.remove('anchor-mode');
                    rotateHandle && (rotateHandle.title = 'Rotate selection');
                }
                // Force UI cache to refresh so handle is repositioned immediately
                this._selectionUiCacheKey = null;
                if (this.state.selection) {
                    const s = this.state.selection;
                    const rot = this.getSelectionRotationDegrees(s);
                    this.updateSelectionUI(s.x, s.y, s.w, s.h, rot);
                }
            },

            updateSelectionRotateHandleColor() {
                const controls = this.ui.selControls;
                if (!controls || controls.style.display === 'none') return;
                // Canvas readback (`getImageData`) can stall badly and unpredictably during transforms.
                // While the user is actively dragging/transforming, skip the expensive pixel-sampled inversion.
                if (this.state && (this.state.isDrawing || this.state.isMovingSel || this.state.isRotatingSel || this.state.isRotatingShape || this.state.isCanvasResizing)) {
                    if (this._selRotateColorCache) {
                        this._selRotateColorCache.px = null;
                        this._selRotateColorCache.py = null;
                    }
                    return;
                }
                const handle = controls.querySelector('.sel-rotate-handle');
                if (!handle) return;
                const stage = this.ui.stage;
                if (!stage) return;
                const stageRect = stage.getBoundingClientRect();
                const handleRect = handle.getBoundingClientRect();
                if (stageRect.width <= 0 || stageRect.height <= 0 || handleRect.width <= 0 || handleRect.height <= 0) return;
                const zoom = this.config.zoom || 1;
                const screenX = handleRect.left + (handleRect.width / 2);
                const screenY = handleRect.top + (handleRect.height / 2);
                const canvasX = (screenX - stageRect.left) / zoom;
                const canvasY = (screenY - stageRect.top) / zoom;

                const w = Math.max(1, this.config.width | 0);
                const h = Math.max(1, this.config.height | 0);
                const px = Math.max(0, Math.min(w - 1, Math.floor(canvasX)));
                const py = Math.max(0, Math.min(h - 1, Math.floor(canvasY)));
                const now = performance.now();
                const cache = this._selRotateColorCache || (this._selRotateColorCache = { px: null, py: null, at: 0 });
                // Throttle repeated sampling (GPU readback) to avoid frame spikes.
                // We only really need to refresh when the handle crosses into a new canvas pixel.
                if (cache.px === px && cache.py === py) return;
                if ((now - (cache.at || 0)) < 80) return;
                cache.px = px;
                cache.py = py;
                cache.at = now;

                const col = this.sampleCompositedCanvasPixel(px, py);
                const inv = `rgb(${255 - col.r}, ${255 - col.g}, ${255 - col.b})`;
                handle.style.setProperty('--sel-rotate-icon-color', inv);
            },

            normalizeSelectionFlipInPlace() {
                const s = this.state.selection;
                if (!s) return;
                const flipX = s.w < 0;
                const flipY = s.h < 0;
                if (!flipX && !flipY) return;
                const nr = this.getNormalizedRect(s);
                // Re-render the flipped pixels into a fresh canvas at the normalised size
                // using a manual pixel copy so no browser interpolation can occur.
                const srcW = s.canvas.width;
                const srcH = s.canvas.height;
                const srcCtx = s.canvas.getContext('2d');
                const srcData = srcCtx.getImageData(0, 0, srcW, srcH).data;
                const targetW = nr.w;
                const targetH = nr.h;
                const dstData = new Uint8ClampedArray(targetW * targetH * 4);
                for (let dy2 = 0; dy2 < targetH; dy2++) {
                    const sy = Math.floor((flipY ? (targetH - 1 - dy2) : dy2) * srcH / targetH);
                    const srcRow = Math.min(sy, srcH - 1) * srcW;
                    const dstRow = dy2 * targetW;
                    for (let dx2 = 0; dx2 < targetW; dx2++) {
                        const sx = Math.floor((flipX ? (targetW - 1 - dx2) : dx2) * srcW / targetW);
                        const si = (srcRow + Math.min(sx, srcW - 1)) * 4;
                        const di = (dstRow + dx2) * 4;
                        dstData[di]     = srcData[si];
                        dstData[di + 1] = srcData[si + 1];
                        dstData[di + 2] = srcData[si + 2];
                        dstData[di + 3] = srcData[si + 3];
                    }
                }
                const baked = document.createElement('canvas');
                baked.width  = targetW;
                baked.height = targetH;
                const bctx = baked.getContext('2d');
                this.disableSmoothing(bctx);
                bctx.putImageData(new ImageData(dstData, targetW, targetH), 0, 0);
                s.canvas = baked;
                s.x = nr.x;
                s.y = nr.y;
                s.w = nr.w;
                s.h = nr.h;
                s._cache = null;
                s._glTexDirty = true;
            },

            // Stamps the rotated selection onto the main canvas and re-lifts it as a fresh
            // axis-aligned (unrotated) selection covering the AABB. Called before a resize
            // so that resize math always works in straight screen-space coords.
            cropSelection() {
                if(!this.state.selection) return;

                const s = this.state.selection;
                const prevForceOpaque = !!s._forceOpaque;
                let nw = s.w;
                let nh = s.h;
                if(nw < 0) nw = Math.abs(nw);
                if(nh < 0) nh = Math.abs(nh);

                s._forceOpaque = true;
                s._cache = null;
                const renderC = this.getRenderedSelectionCanvas();
                s._forceOpaque = prevForceOpaque;
                s._cache = null;
                const oldW = this.config.width;
                const oldH = this.config.height;
                this.setSize(Math.abs(nw), Math.abs(nh));
                this.ctx.clearRect(0, 0, this.config.width, this.config.height);
                this.disableSmoothing(this.ctx);
                this.ctx.drawImage(renderC, 0, 0);
                this.flattenCanvasAlpha(this.ctx, this.config.width, this.config.height);
                this._freeSelectionGlTex(this.state.selection); this.state.selection = null;
                this.state.selectionOriginalPos = null;
                this.ctxTemp.clearRect(0,0,this.config.width, this.config.height);
                this.resetSelectionTempDirty();
                this.renderSelection();
                this.saveState();
                if (nw < oldW || nh < oldH) {
                    this.centerCanvas();
                }
            },

            initResize() {
                if(this.state.selection) {
                    const w = this.state.selection.w;
                    const h = this.state.selection.h;
                    this.resizeState = { w: w, h: h, ratio: w/h };
                } else {
                    const w = this.config.width;
                    const h = this.config.height;
                    this.resizeState = { w: w, h: h, ratio: w/h };
                }
                this.resizeRatioState ??= true;
                document.getElementById('rz-h-pct').value = 100;
                document.getElementById('rz-h-px').value  = this.resizeState.w;
                document.getElementById('rz-v-pct').value = 100;
                document.getElementById('rz-v-px').value  = this.resizeState.h;
                document.getElementById('rz-ratio').checked = this.resizeRatioState;
                this.openModal('resize');
                this.updateResizePreview();
            },

            onResizeInput(axis, unit) {
                const hPct = document.getElementById('rz-h-pct');
                const hPx = document.getElementById('rz-h-px');
                const vPct = document.getElementById('rz-v-pct');
                const vPx = document.getElementById('rz-v-px');
                const maintain = document.getElementById('rz-ratio').checked;
                const fmt = (n) => {
                    const r = Math.round(n * 100) / 100;
                    return String(r);
                };
                const hBase = this.resizeState.w;
                const vBase = this.resizeState.h;
                let curPct, curPx;
                if (axis === 'h') {
                    if (unit === 'pct') {
                        curPct = parseFloat(hPct.value) || 0;
                        curPx = Math.max(1, Math.round(hBase * curPct / 100));
                        hPx.value = curPx;
                    } else {
                        curPx = parseFloat(hPx.value) || 0;
                        curPct = curPx / hBase * 100;
                        hPct.value = fmt(curPct);
                    }
                } else {
                    if (unit === 'pct') {
                        curPct = parseFloat(vPct.value) || 0;
                        curPx = Math.max(1, Math.round(vBase * curPct / 100));
                        vPx.value = curPx;
                    } else {
                        curPx = parseFloat(vPx.value) || 0;
                        curPct = curPx / vBase * 100;
                        vPct.value = fmt(curPct);
                    }
                }
                if (maintain) {
                    const factor = curPct / 100;
                    if (axis === 'h') {
                        vPct.value = fmt(curPct);
                        vPx.value = Math.max(1, Math.round(vBase * factor));
                    } else {
                        hPct.value = fmt(curPct);
                        hPx.value = Math.max(1, Math.round(hBase * factor));
                    }
                }
                this.updateResizePreview();
            },

            rotatePoint(p, center, deg) {
                if (!deg) return { x: p.x, y: p.y };
                const rad = deg * Math.PI / 180;
                const cos = Math.cos(rad);
                const sin = Math.sin(rad);
                const dx = p.x - center.x;
                const dy = p.y - center.y;
                return {
                    x: center.x + (dx * cos - dy * sin),
                    y: center.y + (dx * sin + dy * cos)
                };
            },

            toggleDragRotate() {
                this.config.dragRotate = !this.config.dragRotate;
                this.lsSet('paint.dragRotate', this.config.dragRotate ? 'true' : 'false');
                this.updateDragRotateStatus();
            },
            updateDragRotateStatus() {
                const item = document.getElementById('item-drag-rotate');
                if (item) item.classList.toggle('checked', this.config.dragRotate);
                // Sync the hit-area cursor so it reflects the current mode
                const hitArea = document.getElementById('sel-hit-area');
                if (hitArea) hitArea.style.cursor = this.config.dragRotate ? 'grab' : 'move';
            },
            startCanvasResize(e, d) {
                e.stopPropagation();
                if(this.state.selection) this.commitSelection();
                this.state.isCanvasResizing=true;
                this.state.rDir=d;
                this.state.canvasOriginalSize = { w: this.config.width, h: this.config.height };
                this.state.resizeStart = { x: e.clientX, y: e.clientY };
                this.state.resizeShift = { x: 0, y: 0 };
                this.state.canvasOffsetStart = { x: this.state.canvasOffset.x, y: this.state.canvasOffset.y };
                this.requestGlobalOverlayUpdate();
            },
            doCanvasResize(e) {
                const zoom = this.config.zoom || 1;
                const dx = (e.clientX - this.state.resizeStart.x) / zoom;
                const dy = (e.clientY - this.state.resizeStart.y) / zoom;
                const orig = this.state.canvasOriginalSize || { w: this.config.width, h: this.config.height };
                let nw = orig.w;
                let nh = orig.h;
                let shiftX = 0;
                let shiftY = 0;
                if (this.state.rDir.includes('r')) nw = orig.w + dx;
                if (this.state.rDir.includes('b')) nh = orig.h + dy;
                if (this.state.rDir.includes('l')) { nw = orig.w - dx; shiftX = -dx; }
                if (this.state.rDir.includes('t')) { nh = orig.h - dy; shiftY = -dy; }
                const previewW = Math.max(1, Math.round(nw));
                const previewH = Math.max(1, Math.round(nh));
                const previewShiftX = Math.round(shiftX);
                const previewShiftY = Math.round(shiftY);
                this.state.resizeShift = { x: previewShiftX, y: previewShiftY };
                this.ui.cMain.style.transform = `translate(${previewShiftX}px, ${previewShiftY}px)`;
                this.ui.cTemp.style.transform = `translate(${previewShiftX}px, ${previewShiftY}px)`;
                if (!this.config.anchorCanvas) {
                    const off = this.state.canvasOffsetStart;
                    const ox = this.state.rDir.includes('l') ? (dx * zoom) : 0;
                    const oy = this.state.rDir.includes('t') ? (dy * zoom) : 0;
                    this.state.canvasOffset = this.clampCanvasOffset({ x: off.x + ox, y: off.y + oy });
                    this.applyStageTransform();
                }

                this.ui.stage.style.width = previewW + 'px';
                this.ui.stage.style.height = previewH + 'px';
                this.requestGlobalOverlayUpdate();
                this.updateBounds();

                this.ui.statusDims.textContent = `${previewW} x ${previewH}px`;
            },
            async endCanvasResize() {
                this.state.isCanvasResizing=false;
                let nw = parseInt(this.ui.stage.style.width, 10);
                let nh = parseInt(this.ui.stage.style.height, 10);
                const shift = this.state.resizeShift || { x: 0, y: 0 };
                this.state.canvasOriginalSize = null;
                this.requestGlobalOverlayUpdate();
                this.ui.cMain.style.transform = '';
                this.ui.cTemp.style.transform = '';
                const bitmap = await this.getBitmap(this.ui.cMain);
                let t = null;
                if (!bitmap) {
                    t = document.createElement('canvas');
                    t.width=this.config.width;
                    t.height=this.config.height;
                    const tCtx = t.getContext('2d');
                    this.disableSmoothing(tCtx);
                    tCtx.drawImage(this.ui.cMain,0,0);
                }
                this.setSize(nw, nh);
                this.ctx.fillStyle='white';
                this.ctx.fillRect(0,0,nw,nh);
                this.disableSmoothing(this.ctx);
                if (bitmap) {
                    this.ctx.drawImage(bitmap, shift.x, shift.y);
                    if (bitmap.close) bitmap.close();
                } else {
                    this.ctx.drawImage(t, shift.x, shift.y);
                }
                this.saveState();
            },
            positionResizeModal() {
                const modalId = 'modal-resize';
                const modal = document.getElementById(modalId);
                const win = modal ? modal.querySelector('.window') : null;
                const btn = document.getElementById('resize-btn');
                if (!modal || !win || !btn) return;
                const rect = win.getBoundingClientRect();
                const w = rect.width || win.offsetWidth;
                const btnRect = btn.getBoundingClientRect();
                /* Place the window centered under the Resize button. */
                const targetLeft = Math.round(btnRect.left + (btnRect.width / 2) - (w / 2));
                const targetTop = Math.round(btnRect.bottom);
                win.style.position = 'absolute';
                win.style.left = Math.max(10, Math.min(targetLeft, window.innerWidth - w - 10)) + 'px';
                win.style.top = Math.max(10, Math.min(targetTop, window.innerHeight - 10)) + 'px';
            },
            updateResizePreview() {
                const modal = document.getElementById('modal-resize');
                if (!modal || modal.style.display !== 'flex') {
                    this.state.resizePreviewActive = false;
                    this.state.resizePreviewRect = null;
                    this.state.resizePreviewGhost = null;
                    this.requestGlobalOverlayUpdate();
                    return;
                }
                const hp = this.normalizeResizePercent(parseFloat(document.getElementById('rz-h-pct').value) || 0);
                const vp = this.normalizeResizePercent(parseFloat(document.getElementById('rz-v-pct').value) || 0);
                const base = this.state.selection ? {
                    x: this.state.selection.x,
                    y: this.state.selection.y,
                    w: this.state.selection.w,
                    h: this.state.selection.h
                } : { x: 0, y: 0, w: this.config.width, h: this.config.height };
                let newW = Math.max(1, Math.round(base.w * (hp / 100)));
                let newH = Math.max(1, Math.round(base.h * (vp / 100)));
                this.state.resizePreviewActive = true;
                this.state.resizePreviewRect = { x: base.x, y: base.y, w: newW, h: newH };
                this.state.resizePreviewGhost = { x: base.x, y: base.y, w: base.w, h: base.h };
                this.requestGlobalOverlayUpdate();
            },
            normalizeResizePercent(v) {
                if (v === 33) return 100 / 3;
                if (v === 66) return 200 / 3;
                return v;
            },
            async applyResize() {
                const mode = 'percent';
                const hIn = parseFloat(document.getElementById('rz-h-pct').value);
                const vIn = parseFloat(document.getElementById('rz-v-pct').value);
                const skH = parseFloat(document.getElementById('sk-h-val').value || '0');
                const skV = parseFloat(document.getElementById('sk-v-val').value || '0');
                const skewX = Math.tan((skH || 0) * Math.PI / 180);
                const skewY = Math.tan((skV || 0) * Math.PI / 180);
                let newW, newH;
                if(this.state.selection) {
                    const nr = this.getNormalizedRect(this.state.selection);
                    const currW = nr.w;
                    const currH = nr.h;
                    if(mode === 'percent') {
                        const hp = this.normalizeResizePercent(hIn);
                        const vp = this.normalizeResizePercent(vIn);
                        newW = Math.round(currW * (hp / 100));
                        newH = Math.round(currH * (vp / 100));
                    } else {
                        newW = Math.round(hIn);
                        newH = Math.round(vIn);
                    }
                    if (!Number.isFinite(newW) || !Number.isFinite(newH) || newW < 1 || newH < 1) {
                        showToast('Please enter valid resize dimensions.', 'warning');
                        return;
                    }
                    let tempC = document.createElement('canvas');
                    tempC.width = Math.abs(newW);
                    tempC.height = Math.abs(newH);
                    const tCtx = tempC.getContext('2d');
                    this.disableSmoothing(tCtx);
                    const bitmap = await this.getBitmap(this.state.selection.canvas);
                    if (bitmap) {
                        tCtx.drawImage(bitmap, 0, 0, tempC.width, tempC.height);
                        if (bitmap.close) bitmap.close();
                    } else {
                        tCtx.drawImage(this.state.selection.canvas, 0, 0, tempC.width, tempC.height);
                    }
                    if (skewX !== 0 || skewY !== 0) {
                        const sw = tempC.width;
                        const sh = tempC.height;
                        const outW = Math.ceil(sw + Math.abs(skewX) * sh);
                        const outH = Math.ceil(sh + Math.abs(skewY) * sw);
                        const skC = document.createElement('canvas');
                        skC.width = outW;
                        skC.height = outH;
                        const skCtx = skC.getContext('2d');
                        this.disableSmoothing(skCtx);
                        const offX = skewX < 0 ? Math.abs(skewX) * sh : 0;
                        const offY = skewY < 0 ? Math.abs(skewY) * sw : 0;
                        skCtx.setTransform(1, skewY, skewX, 1, offX, offY);
                        skCtx.drawImage(tempC, 0, 0);
                        tempC = skC;
                        newW = outW;
                        newH = outH;
                    }

                    this.state.selection.x = nr.x;
                    this.state.selection.y = nr.y;
                    this.state.selection.w = newW;
                    this.state.selection.h = newH;
                    this.state.selection.canvas = tempC;
                    this.state.selection._glTexDirty = true;
                    if (this.state.selection.palette) this.state.selection._needsPaletteEnforce = true;
                    this.state.selection._cache = null;
                    this.renderSelectionFast();
                    this.deferSelectionRenderFinalize(this.state.selection);
                } else {
                    if(mode === 'percent') {
                        const hp = this.normalizeResizePercent(hIn);
                        const vp = this.normalizeResizePercent(vIn);
                        newW = Math.round(this.config.width * (hp / 100));
                        newH = Math.round(this.config.height * (vp / 100));
                    } else {
                        newW = Math.round(hIn);
                        newH = Math.round(vIn);
                    }
                    if (!Number.isFinite(newW) || !Number.isFinite(newH) || newW < 1 || newH < 1) {
                        showToast('Please enter valid resize dimensions.', 'warning');
                        return;
                    }
                    const bitmap = await this.getBitmap(this.ui.cMain);
                    let t = null;
                    if (!bitmap) {
                        t = document.createElement('canvas');
                        t.width = this.config.width;
                        t.height = this.config.height;
                        const tCtx = t.getContext('2d');
                        this.disableSmoothing(tCtx);
                        tCtx.drawImage(this.ui.cMain, 0, 0);
                    }
                    let tempC = document.createElement('canvas');
                    tempC.width = Math.abs(newW);
                    tempC.height = Math.abs(newH);
                    const tCtx2 = tempC.getContext('2d');
                    this.disableSmoothing(tCtx2);
                    if (bitmap) {
                        tCtx2.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, newW, newH);
                        if (bitmap.close) bitmap.close();
                    } else {
                        tCtx2.drawImage(t, 0, 0, t.width, t.height, 0, 0, newW, newH);
                    }
                    if (skewX !== 0 || skewY !== 0) {
                        const sw = tempC.width;
                        const sh = tempC.height;
                        const outW = Math.ceil(sw + Math.abs(skewX) * sh);
                        const outH = Math.ceil(sh + Math.abs(skewY) * sw);
                        const skC = document.createElement('canvas');
                        skC.width = outW;
                        skC.height = outH;
                        const skCtx = skC.getContext('2d');
                        this.disableSmoothing(skCtx);
                        const offX = skewX < 0 ? Math.abs(skewX) * sh : 0;
                        const offY = skewY < 0 ? Math.abs(skewY) * sw : 0;
                        skCtx.setTransform(1, skewY, skewX, 1, offX, offY);
                        skCtx.drawImage(tempC, 0, 0);
                        tempC = skC;
                        newW = outW;
                        newH = outH;
                    }
                    this.setSize(newW, newH);
                    this.ctx.fillStyle='white';
                    this.ctx.fillRect(0,0,newW,newH);
                    this.disableSmoothing(this.ctx);
                    this.ctx.drawImage(tempC, 0, 0);
                    this.saveState();
                }
                this.resizeRatioState = document.getElementById('rz-ratio').checked;
                this._closeActiveSidebar(true);
                this.closeModals();
            },
            _fitResize(doc, tw, th) {
                const fill = doc.transparentIdx >= 0 ? doc.transparentIdx : 0;
                const out = new Uint8Array(tw * th).fill(fill);
                const dx = Math.round((tw - doc.w) / 2);
                const dy = th - doc.h;
                for (let y = 0; y < doc.h; y++) {
                    const ty = y + dy;
                    if (ty < 0 || ty >= th) continue;
                    for (let x = 0; x < doc.w; x++) {
                        const tx = x + dx;
                        if (tx < 0 || tx >= tw) continue;
                        out[ty * tw + tx] = doc.map[y * doc.w + x];
                    }
                }
                return { ...doc, w: tw, h: th, map: out };
            }

            /* ── Import ─────────────────────────────────────────────────────────
               Outside art as a document value: indexed, with slot 0 held for
               transparency because that is what the hardware reads it as.

               The palette is the picture's own colours, most-used first, not a
               generated approximation — art drawn for a 16-colour slot already has
               its palette and quantising it again would only lose fidelity. Only
               what does not fit gets merged, and that is `_fitReduceColors` doing
               it, the same reducer the Fit dialog runs on an open asset.

               255 rather than 256 because slot 0 is spoken for. A picture with more
               colours than that is not refused: the extras land on their nearest
               neighbour here, and the colour budget for the real slot — usually 16 —
               is applied afterwards as a fix the artist can see before agreeing to. */
    });
})();
