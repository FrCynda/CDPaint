/* quantize — moved verbatim off the PaintEngine class body.
 *
 * Assigned onto the prototype, so `this` is the same PaintEngine instance
 * these methods have always run against. Loads after paint-engine.js and
 * before boot.js, which is where the instance is finally created.
 */
(function () {
    Object.assign(PaintEngine.prototype, {
            initQuantizeWorker() {
                const code = `
                    self.onmessage = (e) => {
                        const msg = e.data;
                        const width = msg.width, height = msg.height;
                        const data = new Uint8ClampedArray(msg.data);
                        const K = msg.K;
                        const sampleMax = msg.sampleMax || 20000;
                        const seed = msg.seed || 1337;
                        const paletteIn = msg.palette || null;

                        const srgbToLinear = (c) => { const v=c/255; return v<=0.04045? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
                        const linearToSrgb = (v) => { const c=v<=0.0031308? 12.92*v : 1.055*Math.pow(v, 1/2.4)-0.055; return Math.max(0,Math.min(255,Math.round(c*255))); };
                        const rgbToOklab = (r,g,b) => {
                            let lr=srgbToLinear(r), lg=srgbToLinear(g), lb=srgbToLinear(b);
                            let l=0.4122214708*lr+0.5363325363*lg+0.0514459929*lb;
                            let m=0.2119034982*lr+0.6806995451*lg+0.1073969566*lb;
                            let s=0.0883024619*lr+0.2817188376*lg+0.6299787005*lb;
                            l=Math.cbrt(l); m=Math.cbrt(m); s=Math.cbrt(s);
                            return { L:0.2104542553*l+0.7936177850*m-0.0040720468*s, a:1.9779984951*l-2.4285922050*m+0.4505937099*s, b:0.0259040371*l+0.7827717662*m-0.8086757660*s };
                        };
                        const oklabToRgb = (L,a,b) => {
                            let l=L+0.3963377774*a+0.2158037573*b;
                            let m=L-0.1055613458*a-0.0638541728*b;
                            let s=L-0.0894841775*a-1.2914855480*b;
                            l=l*l*l; m=m*m*m; s=s*s*s;
                            return [
                                linearToSrgb(4.0767416621*l-3.3077115913*m+0.2309699292*s),
                                linearToSrgb(-1.2684380046*l+2.6097574011*m-0.3413193965*s),
                                linearToSrgb(-0.0041960863*l-0.7034186147*m+1.7076147010*s)
                            ];
                        };
                        const distOklab = (c1,c2) => (c1.L-c2.L)**2 + (c1.a-c2.a)**2 + (c1.b-c2.b)**2;

                        let palette = [];
                        let paletteLab = [];
                        if (paletteIn && paletteIn.length) {
                            palette = paletteIn;
                            paletteLab = palette.map(c => rgbToOklab(c.r, c.g, c.b));
                        } else {
                            const total = width * height;
                            const step = Math.max(1, Math.floor(total / sampleMax));
                            const samples = [];
                            for (let i = 0; i < total; i += step) {
                                const idx = i * 4;
                                samples.push(rgbToOklab(data[idx], data[idx+1], data[idx+2]));
                            }
                            let rng = seed;
                            const rand = () => {
                                rng = (rng * 1664525 + 1013904223) >>> 0;
                                return rng / 4294967296;
                            };
                            // k-means++ initialisation: seed the first centroid uniformly at random,
                            // then choose each subsequent centroid with probability proportional to its
                            // squared distance from the nearest existing centroid. This spreads the
                            // initial centroids and consistently outperforms random seeding.
                            const centroids = [];
                            centroids.push({ ...samples[Math.floor(rand() * samples.length)] });
                            for (let k = 1; k < K; k++) {
                                const dists = new Float64Array(samples.length);
                                let totalDist = 0;
                                for (let i = 0; i < samples.length; i++) {
                                    const p = samples[i];
                                    let minD = Infinity;
                                    for (let c = 0; c < centroids.length; c++) {
                                        const d = distOklab(p, centroids[c]);
                                        if (d < minD) minD = d;
                                    }
                                    dists[i] = minD;
                                    totalDist += minD;
                                }
                                let threshold = rand() * totalDist;
                                let chosen = samples.length - 1;
                                for (let i = 0; i < samples.length; i++) {
                                    threshold -= dists[i];
                                    if (threshold <= 0) { chosen = i; break; }
                                }
                                centroids.push({ ...samples[chosen] });
                            }
                            const iterations = 8;
                            for (let iter = 0; iter < iterations; iter++) {
                                const sums = centroids.map(() => ({ L:0, a:0, b:0, w:0 }));
                                let worstErr = -1, worstIdx = 0;
                                for (let i = 0; i < samples.length; i++) {
                                    const p = samples[i];
                                    let bestD = Infinity, idx = 0;
                                    for (let c = 0; c < K; c++) {
                                        const dist = distOklab(p, centroids[c]);
                                        if (dist < bestD) { bestD = dist; idx = c; }
                                    }
                                    sums[idx].L += p.L; sums[idx].a += p.a; sums[idx].b += p.b; sums[idx].w += 1;
                                    if (bestD > worstErr) { worstErr = bestD; worstIdx = i; }
                                }
                                for (let c = 0; c < K; c++) {
                                    if (sums[c].w > 0) {
                                        centroids[c].L = sums[c].L / sums[c].w;
                                        centroids[c].a = sums[c].a / sums[c].w;
                                        centroids[c].b = sums[c].b / sums[c].w;
                                    } else {
                                        centroids[c] = { ...samples[worstIdx] };
                                    }
                                }
                            }
                            const rgbCentroids = centroids.map(c => oklabToRgb(c.L, c.a, c.b));
                            palette = rgbCentroids.map(c => ({ r: c[0], g: c[1], b: c[2], a: 255 }));
                            paletteLab = centroids;
                        }

                        const total = width * height;
                        for (let i = 0; i < total; i++) {
                            const idx = i * 4;
                            const r = data[idx], g = data[idx+1], b = data[idx+2];
                            const p = rgbToOklab(r, g, b);
                            let bestD = Infinity, bestIdx = 0;
                            for (let c = 0; c < paletteLab.length; c++) {
                                const dist = distOklab(p, paletteLab[c]);
                                if (dist < bestD) { bestD = dist; bestIdx = c; }
                            }
                            const col = palette[bestIdx];
                            data[idx] = col.r; data[idx+1] = col.g; data[idx+2] = col.b;
                        }
                        self.postMessage({ data: data.buffer, palette }, [data.buffer]);
                    };
                `;
                const blob = new Blob([code], { type: 'application/javascript' });
                const url = URL.createObjectURL(blob);
                const worker = new Worker(url);
                this.quantizeWorker = worker;
                const revokeUrl = () => {
                    URL.revokeObjectURL(url);
                    worker.removeEventListener('message', revokeUrl);
                    worker.removeEventListener('error', revokeUrl);
                };
                worker.addEventListener('error', revokeUrl);
                worker.addEventListener('message', revokeUrl);
            },

            /**
             * Compute the SVG clip-rect that culls ants to the visible viewport area.
             * Returns { x, y, w, h, visible } in SVG-local (canvas-pixel) coordinates.
             * Used by both updateGlobalOverlays (committed selections) and
             * _applyWandSvgPreview (live wand drag preview).
             */
            quantizeChannel(v, bits) {
                const levels = (1 << bits) - 1;
                return Math.round((v / 255) * levels) * (255 / levels);
            },
            quantizeRgb555(r, g, b) {
                return {
                    r: Math.round(this.quantizeChannel(r, 5)),
                    g: Math.round(this.quantizeChannel(g, 5)),
                    b: Math.round(this.quantizeChannel(b, 5))
                };
            },
            quantizeRgb565(r, g, b) {
                return {
                    r: Math.round(this.quantizeChannel(r, 5)),
                    g: Math.round(this.quantizeChannel(g, 6)),
                    b: Math.round(this.quantizeChannel(b, 5))
                };
            },
            wuIndex(r, g, b) {
                return (r * 33 + g) * 33 + b;
            },
            wuVolume(cube, moment) {
                return moment[this.wuIndex(cube.r1, cube.g1, cube.b1)]
                    - moment[this.wuIndex(cube.r1, cube.g1, cube.b0)]
                    - moment[this.wuIndex(cube.r1, cube.g0, cube.b1)]
                    + moment[this.wuIndex(cube.r1, cube.g0, cube.b0)]
                    - moment[this.wuIndex(cube.r0, cube.g1, cube.b1)]
                    + moment[this.wuIndex(cube.r0, cube.g1, cube.b0)]
                    + moment[this.wuIndex(cube.r0, cube.g0, cube.b1)]
                    - moment[this.wuIndex(cube.r0, cube.g0, cube.b0)];
            },
            wuBottom(cube, dir, moment) {
                if (dir === 0) {
                    return -moment[this.wuIndex(cube.r0, cube.g1, cube.b1)]
                        + moment[this.wuIndex(cube.r0, cube.g1, cube.b0)]
                        + moment[this.wuIndex(cube.r0, cube.g0, cube.b1)]
                        - moment[this.wuIndex(cube.r0, cube.g0, cube.b0)];
                }
                if (dir === 1) {
                    return -moment[this.wuIndex(cube.r1, cube.g0, cube.b1)]
                        + moment[this.wuIndex(cube.r1, cube.g0, cube.b0)]
                        + moment[this.wuIndex(cube.r0, cube.g0, cube.b1)]
                        - moment[this.wuIndex(cube.r0, cube.g0, cube.b0)];
                }
                return -moment[this.wuIndex(cube.r1, cube.g1, cube.b0)]
                    + moment[this.wuIndex(cube.r1, cube.g0, cube.b0)]
                    + moment[this.wuIndex(cube.r0, cube.g1, cube.b0)]
                    - moment[this.wuIndex(cube.r0, cube.g0, cube.b0)];
            },
            wuTop(cube, dir, pos, moment) {
                if (dir === 0) {
                    return moment[this.wuIndex(pos, cube.g1, cube.b1)]
                        - moment[this.wuIndex(pos, cube.g1, cube.b0)]
                        - moment[this.wuIndex(pos, cube.g0, cube.b1)]
                        + moment[this.wuIndex(pos, cube.g0, cube.b0)];
                }
                if (dir === 1) {
                    return moment[this.wuIndex(cube.r1, pos, cube.b1)]
                        - moment[this.wuIndex(cube.r1, pos, cube.b0)]
                        - moment[this.wuIndex(cube.r0, pos, cube.b1)]
                        + moment[this.wuIndex(cube.r0, pos, cube.b0)];
                }
                return moment[this.wuIndex(cube.r1, cube.g1, pos)]
                    - moment[this.wuIndex(cube.r1, cube.g0, pos)]
                    - moment[this.wuIndex(cube.r0, cube.g1, pos)]
                    + moment[this.wuIndex(cube.r0, cube.g0, pos)];
            },
            wuVariance(cube, moments) {
                const weight = this.wuVolume(cube, moments.wt);
                if (weight <= 0) return 0;
                const r = this.wuVolume(cube, moments.r);
                const g = this.wuVolume(cube, moments.g);
                const b = this.wuVolume(cube, moments.b);
                const xx = this.wuVolume(cube, moments.m2);
                return xx - (r * r + g * g + b * b) / weight;
            },
            wuMaximize(cube, dir, first, last, whole, moments) {
                const baseR = this.wuBottom(cube, dir, moments.r);
                const baseG = this.wuBottom(cube, dir, moments.g);
                const baseB = this.wuBottom(cube, dir, moments.b);
                const baseW = this.wuBottom(cube, dir, moments.wt);
                let cut = -1;
                let max = 0;
                for (let i = first; i < last; i++) {
                    const halfR = baseR + this.wuTop(cube, dir, i, moments.r);
                    const halfG = baseG + this.wuTop(cube, dir, i, moments.g);
                    const halfB = baseB + this.wuTop(cube, dir, i, moments.b);
                    const halfW = baseW + this.wuTop(cube, dir, i, moments.wt);
                    if (halfW <= 0) continue;
                    const restW = whole.w - halfW;
                    if (restW <= 0) continue;
                    const temp = (halfR * halfR + halfG * halfG + halfB * halfB) / halfW
                        + ((whole.r - halfR) ** 2 + (whole.g - halfG) ** 2 + (whole.b - halfB) ** 2) / restW;
                    if (temp > max) {
                        max = temp;
                        cut = i;
                    }
                }
                return { cut, score: max };
            },
            wuCut(first, second, moments) {
                const whole = {
                    r: this.wuVolume(first, moments.r),
                    g: this.wuVolume(first, moments.g),
                    b: this.wuVolume(first, moments.b),
                    w: this.wuVolume(first, moments.wt)
                };
                const r = this.wuMaximize(first, 0, first.r0 + 1, first.r1, whole, moments);
                const g = this.wuMaximize(first, 1, first.g0 + 1, first.g1, whole, moments);
                const b = this.wuMaximize(first, 2, first.b0 + 1, first.b1, whole, moments);
                let dir = 0;
                let best = r;
                if (g.score > best.score) { dir = 1; best = g; }
                if (b.score > best.score) { dir = 2; best = b; }
                if (best.cut < 0) return false;

                Object.assign(second, first);
                if (dir === 0) {
                    first.r1 = best.cut;
                    second.r0 = best.cut;
                } else if (dir === 1) {
                    first.g1 = best.cut;
                    second.g0 = best.cut;
                } else {
                    first.b1 = best.cut;
                    second.b0 = best.cut;
                }
                return true;
            },
            quantizeRgbToPalette(r, g, b, palette) {
                let best = 0, minD = Infinity;
                for (let i = 0; i < palette.length; i++) {
                    const p = palette[i];
                    const dr = r - p.r, dg = g - p.g, db = b - p.b;
                    const d = dr*dr + dg*dg + db*db;
                    if (d < minD) { minD = d; best = i; }
                }
                return palette[best] || { r, g, b };
            },
            quantizeRgbWithLookup(r, g, b, lookup) {
                const ri = (r >> 3) & 31, gi = (g >> 3) & 31, bi = (b >> 3) & 31;
                const idx = ((ri << 10) | (gi << 5) | bi) * 3;
                return { r: lookup[idx], g: lookup[idx + 1], b: lookup[idx + 2] };
            },
            initQuantizeGL() {
                if (this.quantizeGL) return this.quantizeGL;
                const canvas = document.createElement('canvas');
                const gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
                if (!gl) return null;

                const vs = `
                    attribute vec2 a_pos;
                    attribute vec2 a_uv;
                    varying vec2 v_uv;
                    void main() {
                        v_uv = a_uv;
                        gl_Position = vec4(a_pos, 0.0, 1.0);
                    }
                `;
                const fs = `
                    precision mediump float;
                    uniform sampler2D u_img;
                    uniform int u_mode;
                    uniform int u_gray;
                    varying vec2 v_uv;
                    float q(float v, float levels) {
                        return floor(v * levels + 0.5) / levels;
                    }
                    void main() {
                        vec4 c = texture2D(u_img, v_uv);
                        if (u_gray == 1) {
                            float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
                            c.rgb = vec3(lum);
                        }
                        if (u_mode == 565) {
                            c.r = q(c.r, 31.0);
                            c.g = q(c.g, 63.0);
                            c.b = q(c.b, 31.0);
                        } else {
                            c.r = q(c.r, 31.0);
                            c.g = q(c.g, 31.0);
                            c.b = q(c.b, 31.0);
                        }
                        gl_FragColor = c;
                    }
                `;
                const compile = (type, src) => {
                    const sh = gl.createShader(type);
                    gl.shaderSource(sh, src);
                    gl.compileShader(sh);
                    return sh;
                };
                const prog = gl.createProgram();
                gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
                gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
                gl.linkProgram(prog);
                gl.useProgram(prog);

                const quad = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, quad);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                    -1, -1, 0, 0,
                    1, -1, 1, 0,
                    -1,  1, 0, 1,
                    -1,  1, 0, 1,
                    1, -1, 1, 0,
                    1,  1, 1, 1
                ]), gl.STATIC_DRAW);
                const aPos = gl.getAttribLocation(prog, 'a_pos');
                const aUv = gl.getAttribLocation(prog, 'a_uv');
                gl.enableVertexAttribArray(aPos);
                gl.enableVertexAttribArray(aUv);
                gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
                gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);

                const tex = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

                this.quantizeGL = { canvas, gl, prog, tex, uMode: gl.getUniformLocation(prog, 'u_mode'), uGray: gl.getUniformLocation(prog, 'u_gray') };
                canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.quantizeGL = null; }, { once: true });
                return this.quantizeGL;
            },
            applyWebGLQuantize(mode, srcCanvas, dstCanvas, grayscale = false) {
                const q = this.initQuantizeGL();
                if (!q) return false;
                const { canvas, gl, tex, uMode, uGray } = q;
                canvas.width = srcCanvas.width;
                canvas.height = srcCanvas.height;
                gl.viewport(0, 0, canvas.width, canvas.height);
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);
                gl.uniform1i(uMode, mode === 'rgb565' ? 565 : 555);
                gl.uniform1i(uGray, grayscale ? 1 : 0);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
                const ctx = dstCanvas.getContext('2d');
                ctx.clearRect(0, 0, dstCanvas.width, dstCanvas.height);
                ctx.drawImage(canvas, 0, 0);
                return true;
            },
            quantizeWinColorRgb(r, g, b) {
                if (this.winColorQuantMode === 'rgb565') return this.quantizeRgb565(r, g, b);
                if (this.winColorQuantMode === 'rgb555') return this.quantizeRgb555(r, g, b);
                return { r, g, b };
            },
            quantizeToIndices(d, w, h, palette) {
                const n = palette ? palette.length : 0;
                const idx = new Uint8Array(w * h);
                if (n === 0) return idx;
                let q = 0;
                for (let p = 0; p < d.length; p += 4, q++) {
                    const r = d[p], g = d[p + 1], b = d[p + 2];
                    let best = 0, bestDist = Infinity;
                    for (let i = 0; i < n; i++) {
                        const c = palette[i];
                        const dr = r - c.r, dg = g - c.g, db = b - c.b;
                        const dist = dr * dr + dg * dg + db * db;
                        if (dist < bestDist) { bestDist = dist; best = i; }
                    }
                    idx[q] = best;
                }
                return idx;
            },
            _quantizeToColor(ctx, x, y, w, h, hexColor) {
                const rgb = this.hexToRgb(hexColor);
                const imageData = ctx.getImageData(x, y, w, h);
                const d = imageData.data;
                for (let i = 0; i < d.length; i += 4) {
                    if (d[i + 3] > 127) {
                        d[i] = rgb.r;
                        d[i + 1] = rgb.g;
                        d[i + 2] = rgb.b;
                        d[i + 3] = 255;
                    } else {
                        d[i + 3] = 0;
                    }
                }
                ctx.putImageData(imageData, x, y);
            }

    });
})();
