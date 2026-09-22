/* palette — moved verbatim off the PaintEngine class body.
 *
 * Assigned onto the prototype, so `this` is the same PaintEngine instance
 * these methods have always run against. Loads after paint-engine.js and
 * before boot.js, which is where the instance is finally created.
 */
(function () {
    Object.assign(PaintEngine.prototype, {
            isPaletteMiniSwatchElement(el) {
                if (!el || !el.closest || !el.classList || !el.classList.contains('mini-swatch')) return false;
                return !!el.closest('#palette-std, #palette-recent, #palette-custom, #palette, #cq-palette');
            },
            enforceFixedPaletteSwatchStyles() {
                const swatches = document.querySelectorAll('#palette-std .mini-swatch, #palette-recent .mini-swatch, #palette-custom .mini-swatch, #palette .mini-swatch, #cq-palette .mini-swatch, #palette-panel .mini-swatch');
                swatches.forEach((swatch) => {
                    if (!swatch || !swatch.style) return;
                    swatch.style.border = '1px solid var(--palette-mini-swatch-border)';
                    if (swatch.classList.contains('empty')) {
                        swatch.style.backgroundColor = 'transparent';
                        swatch.style.boxShadow = '';
                        return;
                    }
                    swatch.style.boxShadow = 'inset 0 0 0 1px var(--palette-mini-swatch-inner)';
                    if (swatch.dataset && swatch.dataset.fixedPaletteColor) {
                        swatch.style.backgroundColor = swatch.dataset.fixedPaletteColor;
                    }
                });
            },
            addSwatch(parent, c) {
                let d = document.createElement('div');
                if (c) {
                    d.className = 'mini-swatch';
                    d.style.backgroundColor = c;
                    d.dataset.fixedPaletteColor = c;
                    d.dataset.defaultPaletteColor = c;
                    if (c === '#000000') d.dataset.fixedBlack = 'true';
                    d.onmousedown = (e) => {
                        if (e.button === 2) {
                            // Standard palette (#palette-std) has a custom context menu for edit/reset.
                            // All other palette containers (recent, custom) treat right-click as "set Color 2".
                            if (!d.closest('#palette-std')) {
                                this.setColor(d.dataset.fixedPaletteColor || c, 2);
                            }
                            return;
                        }
                        this.setColor(d.dataset.fixedPaletteColor || c, this.config.activeSlot);
                    };
                    d.oncontextmenu = (e) => {
                        e.preventDefault();
                        if (!d.closest('#palette-std')) return;
                        this._openSwatchContextMenu(e, d);
                    };
                } else {
                    d.className = 'mini-swatch empty';
                }
                parent.appendChild(d);
                this.enforceFixedPaletteSwatchStyles();
            },

            _openSwatchContextMenu(e, swatchEl) {
                // Tear down any previously open swatch context menu before building a new one.
                // Only one context menu should exist in the DOM at a time.
                const old = document.getElementById('swatch-ctx-menu');
                if (old) old.remove();

                const defaultColor = swatchEl.dataset.defaultPaletteColor;
                const currentColor = swatchEl.dataset.fixedPaletteColor;
                const isCustomized = currentColor && defaultColor && currentColor.toLowerCase() !== defaultColor.toLowerCase();

                const menu = document.createElement('div');
                menu.id = 'swatch-ctx-menu';
                Object.assign(menu.style, {
                    position: 'fixed', zIndex: '99999',
                    background: 'var(--dropdown-bg, #fff)',
                    border: '1px solid var(--dropdown-border, #a0a0a0)',
                    boxShadow: '2px 2px 6px var(--dropdown-shadow, rgba(0,0,0,0.2))',
                    borderRadius: '2px', padding: '2px 0',
                    fontFamily: "'Segoe UI', sans-serif", fontSize: '12px',
                    minWidth: '160px', userSelect: 'none',
                });

                const makeItem = (label, fn, disabled = false, swatchColor = null) => {
                    const item = document.createElement('div');
                    Object.assign(item.style, {
                        padding: '4px 14px', cursor: disabled ? 'default' : 'pointer',
                        color: disabled ? '#999' : 'inherit',
                        display: 'flex', alignItems: 'center', gap: '7px',
                    });
                    if (swatchColor) {
                        const sq = document.createElement('div');
                        Object.assign(sq.style, {
                            width: '14px', height: '14px', flexShrink: '0',
                            background: swatchColor,
                            border: '1px solid #000',
                            boxShadow: 'inset 0 0 0 1px #fff',
                            boxSizing: 'border-box',
                            marginLeft: 'auto',
                        });
                        const span = document.createElement('span');
                        span.textContent = label;
                        item.appendChild(span);
                        item.appendChild(sq);
                    } else {
                        item.textContent = label;
                    }
                    if (!disabled) {
                        item.addEventListener('mouseenter', () => item.style.background = 'var(--dropdown-item-hover-bg, #e8e8e8)');
                        item.addEventListener('mouseleave', () => item.style.background = '');
                        item.addEventListener('mousedown', (ev) => { ev.preventDefault(); menu.remove(); fn(); });
                    }
                    menu.appendChild(item);
                };

                makeItem('Edit color', () => {
                    this._paletteSwatchEditTarget = swatchEl;
                    const hex = swatchEl.dataset.fixedPaletteColor || defaultColor;
                    const rgb = this.hexToRgb(hex);
                    const q = this.quantizeWinColorRgb(rgb.r, rgb.g, rgb.b);
                    this.winColorSelected = this.rgbToHex(q.r, q.g, q.b);
                    this.openWinColor();
                    // Override: pre-select to swatch color rather than active slot color
                    setTimeout(() => {
                        const rgb2 = this.hexToRgb(hex);
                        const q2 = this.quantizeWinColorRgb(rgb2.r, rgb2.g, rgb2.b);
                        const hsl = this.rgbToWinHsl(q2.r, q2.g, q2.b);
                        this.winColorSelected = this.rgbToHex(q2.r, q2.g, q2.b);
                        this.setWinInputs(q2, hsl);
                        this.renderWinSpectrum(120);
                        this.renderWinLum(hsl.H, hsl.S);
                        this.positionWinMarkers(hsl.H, hsl.S, hsl.L);
                        if (this.ui.winSample) this.ui.winSample.style.backgroundColor = this.winColorSelected;
                    }, 0);
                });

                if (isCustomized) {
                    makeItem('Reset to default', () => {
                        swatchEl.dataset.fixedPaletteColor = defaultColor;
                        swatchEl.style.backgroundColor = defaultColor;
                        if (defaultColor.toLowerCase() === '#000000') swatchEl.dataset.fixedBlack = 'true';
                        else delete swatchEl.dataset.fixedBlack;
                        this.enforceFixedPaletteSwatchStyles();
                        this._savePaletteCustomizations();
                    }, false, defaultColor);
                } else {
                    makeItem('Reset to default', null, true, defaultColor);
                }

                // Clamp the menu so it never overflows the viewport edges.
                const x = Math.min(e.clientX, window.innerWidth - 170);
                const y = Math.min(e.clientY, window.innerHeight - 120);
                menu.style.left = x + 'px';
                menu.style.top = y + 'px';
                document.body.appendChild(menu);

                // Dismiss the context menu on any outside click or Escape keypress.
                // Listeners are added with a zero-delay setTimeout so the current mousedown
                // event that opened the menu does not immediately re-close it.
                const closeMenu = () => {
                    menu.remove();
                    document.removeEventListener('mousedown', onMouseDown, true);
                    document.removeEventListener('keydown', onKeyDown, true);
                };
                const onMouseDown = (ev) => { if (!menu.contains(ev.target)) closeMenu(); };
                const onKeyDown = (ev) => { if (ev.key === 'Escape') closeMenu(); };
                setTimeout(() => {
                    document.addEventListener('mousedown', onMouseDown, true);
                    document.addEventListener('keydown', onKeyDown, true);
                }, 0);
            },

            _savePaletteCustomizations() {
                const swatches = document.querySelectorAll('#palette-std .mini-swatch');
                const data = {};
                swatches.forEach((s, i) => {
                    const def = s.dataset.defaultPaletteColor;
                    const cur = s.dataset.fixedPaletteColor;
                    if (cur && def && cur.toLowerCase() !== def.toLowerCase()) {
                        data[i] = cur;
                    }
                });
                try { this.lsSet('paint_palette_custom', JSON.stringify(data)); } catch (_) {}
            },

            _loadPaletteCustomizations() {
                let data = {};
                try { data = JSON.parse(this.lsGet('paint_palette_custom') || '{}'); } catch (_) {}
                const swatches = document.querySelectorAll('#palette-std .mini-swatch');
                swatches.forEach((s, i) => {
                    if (data[i]) {
                        s.dataset.fixedPaletteColor = data[i];
                        s.style.backgroundColor = data[i];
                        if (data[i].toLowerCase() === '#000000') s.dataset.fixedBlack = 'true';
                        else delete s.dataset.fixedBlack;
                    }
                });
                this.enforceFixedPaletteSwatchStyles();
            },
            extractPalette(ctx, w, h) {
                if(w<=0 || h<=0) return { set: new Set(), list: [] };
                const data = ctx.getImageData(0,0,w,h).data;
                const set = new Set();
                const list = [];
                for(let i=0; i<data.length; i+=4) {
                    const r=data[i], g=data[i+1], b=data[i+2], a=data[i+3];
                    const key = r * 16777216 + g * 65536 + b * 256 + a;
                    if(!set.has(key)) {
                        set.add(key);
                        list.push({r, g, b, a});
                    }
                }
                return { set, list };
            },

            enforcePalette(ctx, w, h, palette) {
                if(!palette || palette.list.length === 0) return;
                if (this.shouldUsePaletteGL(w, h, palette) && this.applyWebGLEnforcePalette(ctx, w, h, palette)) {
                    return;
                }
                const imgData = ctx.getImageData(0,0,w,h);
                const data = imgData.data;
                const { list } = palette;
                // Pre-compute OKLab for every palette entry once, not per-pixel
                const listLab = list.map(c => c.a !== 0 ? this.rgbToOklab(c.r, c.g, c.b) : null);
                for(let i=0; i<data.length; i+=4) {
                    const r=data[i], g=data[i+1], b=data[i+2], a=data[i+3];
                    if (a < 128) {
                        if (list.length > 0 && list[0].a === 0) {
                            data[i]=list[0].r; data[i+1]=list[0].g; data[i+2]=list[0].b; data[i+3]=list[0].a;
                            continue;
                        }
                    }
                    let minDist = Infinity;
                    let best = list[0];
                    const pLab = this.rgbToOklab(r, g, b);
                    for(let ci = 0; ci < list.length; ci++) {
                        if (list[ci].a === 0) continue;
                        const d = this.distOklab(pLab, listLab[ci]);
                        if(d < minDist) { minDist = d; best = list[ci]; }
                    }
                    data[i] = best.r; data[i+1] = best.g; data[i+2] = best.b; data[i+3] = 255;
                }
                ctx.putImageData(imgData, 0, 0);
            },

            updatePickerCursorSwatch(hex) {
                if (!this.config.pickerHoverPreview) return;
                if (!this.pickerCursorBase) return;
                if (hex === this.pickerCursorHex) return;
                if (!this.ensurePickerCursorAssets()) {
                    if (this.pickerCursorImg) {
                        this.pickerCursorImg.onload = () => this.updatePickerCursorSwatch(hex);
                    }
                    return;
                }
                const baseW = this.pickerCursorImg.width;
                const baseH = this.pickerCursorImg.height;
                const baseHot = this.pickerCursorHotspot || { x: 2, y: 21 };
                const maxSw = Math.max(4, Math.min(9, baseW - 2, baseH - 2));
                const sw = maxSw * 4;
                const pad = 1;
                const offset = 40;
                const topPad = offset;
                const rightPad = offset + sw + pad + 1;
                const canvasW = baseW + rightPad;
                const canvasH = baseH + topPad;
                if (!this.pickerCursorCanvas || this.pickerCursorCanvas.width !== canvasW || this.pickerCursorCanvas.height !== canvasH) {
                    this.pickerCursorCanvas = document.createElement('canvas');
                    this.pickerCursorCanvas.width = canvasW;
                    this.pickerCursorCanvas.height = canvasH;
                    this.pickerCursorCtx = this.pickerCursorCanvas.getContext('2d');
                }
                const ctx = this.pickerCursorCtx;
                const c = this.pickerCursorCanvas;
                ctx.clearRect(0, 0, c.width, c.height);
                ctx.drawImage(this.pickerCursorImg, 0, topPad);
                let x = baseW - sw - pad + offset;
                let y = pad;
                if (x < pad) x = pad;
                ctx.fillStyle = '#000';
                ctx.fillRect(x - 1, y - 1, sw + 2, sw + 2);
                ctx.fillStyle = '#fff';
                ctx.fillRect(x, y, sw, sw);
                ctx.fillStyle = hex;
                ctx.fillRect(x + 1, y + 1, sw - 2, sw - 2);
                const url = c.toDataURL('image/png');
                const hx = baseHot.x;
                const hy = baseHot.y + topPad;
                this.ui.stage.style.cursor = `url("${url}") ${hx} ${hy}, crosshair`;
                this.pickerCursorHex = hex;
            },
            buildWuPalette(imgData, width, height, colorCount) {
                const size = 33 * 33 * 33;
                const moments = {
                    wt: new Float64Array(size),
                    r: new Float64Array(size),
                    g: new Float64Array(size),
                    b: new Float64Array(size),
                    m2: new Float64Array(size)
                };
                const data = imgData.data;
                let visible = 0;
                for (let i = 0; i < data.length; i += 4) {
                    if (data[i + 3] === 0) continue;
                    const r = data[i], g = data[i + 1], b = data[i + 2];
                    const ir = (r >> 3) + 1;
                    const ig = (g >> 3) + 1;
                    const ib = (b >> 3) + 1;
                    const idx = this.wuIndex(ir, ig, ib);
                    moments.wt[idx] += 1;
                    moments.r[idx] += r;
                    moments.g[idx] += g;
                    moments.b[idx] += b;
                    moments.m2[idx] += r * r + g * g + b * b;
                    visible++;
                }
                if (visible === 0) return [{ r: 0, g: 0, b: 0, a: 255 }];

                for (let r = 1; r <= 32; r++) {
                    const area = {
                        wt: new Float64Array(33),
                        r: new Float64Array(33),
                        g: new Float64Array(33),
                        b: new Float64Array(33),
                        m2: new Float64Array(33)
                    };
                    for (let g = 1; g <= 32; g++) {
                        let lineWt = 0, lineR = 0, lineG = 0, lineB = 0, lineM2 = 0;
                        for (let b = 1; b <= 32; b++) {
                            const idx = this.wuIndex(r, g, b);
                            lineWt += moments.wt[idx];
                            lineR += moments.r[idx];
                            lineG += moments.g[idx];
                            lineB += moments.b[idx];
                            lineM2 += moments.m2[idx];
                            area.wt[b] += lineWt;
                            area.r[b] += lineR;
                            area.g[b] += lineG;
                            area.b[b] += lineB;
                            area.m2[b] += lineM2;
                            const prev = this.wuIndex(r - 1, g, b);
                            moments.wt[idx] = moments.wt[prev] + area.wt[b];
                            moments.r[idx] = moments.r[prev] + area.r[b];
                            moments.g[idx] = moments.g[prev] + area.g[b];
                            moments.b[idx] = moments.b[prev] + area.b[b];
                            moments.m2[idx] = moments.m2[prev] + area.m2[b];
                        }
                    }
                }

                const target = Math.max(2, Math.min(256, colorCount | 0));
                const cubes = [{ r0: 0, r1: 32, g0: 0, g1: 32, b0: 0, b1: 32 }];
                const variances = [this.wuVariance(cubes[0], moments)];
                let cubeCount = 1;
                for (let i = 1; i < target; i++) {
                    let next = 0;
                    let bestVar = variances[0];
                    for (let j = 1; j < cubeCount; j++) {
                        if (variances[j] > bestVar) {
                            bestVar = variances[j];
                            next = j;
                        }
                    }
                    if (bestVar <= 0) break;
                    const newCube = {};
                    if (!this.wuCut(cubes[next], newCube, moments)) {
                        variances[next] = 0;
                        i--;
                        if (variances.every(v => v <= 0)) break;
                        continue;
                    }
                    cubes[cubeCount] = newCube;
                    variances[next] = this.wuVariance(cubes[next], moments);
                    variances[cubeCount] = this.wuVariance(newCube, moments);
                    cubeCount++;
                }

                const palette = [];
                for (let i = 0; i < cubeCount; i++) {
                    const wt = this.wuVolume(cubes[i], moments.wt);
                    if (wt <= 0) continue;
                    palette.push({
                        r: Math.max(0, Math.min(255, Math.round(this.wuVolume(cubes[i], moments.r) / wt))),
                        g: Math.max(0, Math.min(255, Math.round(this.wuVolume(cubes[i], moments.g) / wt))),
                        b: Math.max(0, Math.min(255, Math.round(this.wuVolume(cubes[i], moments.b) / wt))),
                        a: 255
                    });
                }
                return palette.length ? palette : [{ r: 0, g: 0, b: 0, a: 255 }];
            },
            buildPaletteLookup(palette) {
                // Flatten palette into a typed array so the inner loop is branch-free
                // and avoids object property lookups — ~5-10x faster on large palettes.
                const n = palette ? palette.length : 0;
                const lookup = new Uint8Array(32768 * 3);
                if (!n) return lookup;
                const pr = new Uint8Array(n), pg = new Uint8Array(n), pb = new Uint8Array(n);
                for (let i = 0; i < n; i++) { pr[i] = palette[i].r; pg[i] = palette[i].g; pb[i] = palette[i].b; }
                let idx = 0;
                for (let ri = 0; ri < 32; ri++) {
                    const r = (ri << 3) | (ri >> 2);
                    for (let gi = 0; gi < 32; gi++) {
                        const g = (gi << 3) | (gi >> 2);
                        for (let bi = 0; bi < 32; bi++) {
                            const b = (bi << 3) | (bi >> 2);
                            let best = 0, minD = Infinity;
                            for (let i = 0; i < n; i++) {
                                const dr = r - pr[i], dg = g - pg[i], db = b - pb[i];
                                const d = dr*dr + dg*dg + db*db;
                                if (d < minD) { minD = d; best = i; }
                            }
                            lookup[idx++] = pr[best];
                            lookup[idx++] = pg[best];
                            lookup[idx++] = pb[best];
                        }
                    }
                }
                return lookup;
            },
            ensurePaletteLab() {
                if (!this.palette || this.palette.length === 0) { this.paletteLab = []; return; }
                if (this.paletteLab && this.paletteLab.length === this.palette.length) return;
                this.paletteLab = this.palette.map(c => this.rgbToOklab(c.r, c.g, c.b));
            },
            paletteHasColor(r, g, b) {
                if (!this.palette) return false;
                for (const c of this.palette) {
                    if (c.r === r && c.g === g && c.b === b) return true;
                }
                return false;
            },
            addPaletteColor(r, g, b) {
                this.palette.push({ r, g, b, a: 255 });
                if (this.paletteLab) this.paletteLab.push(this.rgbToOklab(r, g, b));
                this._schedulePalettePanelRefresh();
            },
            _schedulePalettePanelRefresh() {
                if (this._paletteRefreshScheduled) return;
                this._paletteRefreshScheduled = true;
                const self = this;
                setTimeout(function () {
                    self._paletteRefreshScheduled = false;
                    if (self.onPalettesChanged) self.onPalettesChanged();
                }, 0);
            },
            buildKmeansPalette(imgData, w, h, K, opts = {}) {
                const d = imgData.data;
                const darkPower = Math.max(0, opts.darkPower || 0);
                const seed = typeof opts.seed === 'number' ? opts.seed : 1337;
                const maxSamples = opts.maxSamples || 0;
                const iterations = opts.iterations || 8;
                const pixels = [];
                const weights = [];
                const total = w * h;
                const rng = new SeededRNG(seed);
                const addPixel = (idx) => {
                    const base = idx * 4;
                    const a = d[base + 3];
                    if (a === 0) return false;
                    const r = d[base], g = d[base + 1], b = d[base + 2];
                    const p = this.rgbToOklab(r, g, b);
                    pixels.push(p);
                    if (darkPower > 0) {
                        const power = 1.0 + (darkPower * 6.0);
                        let wgt = Math.pow(Math.max(0.002, p.L), power);
                        const darkCut = 0.16 + (darkPower * 0.10);
                        if (p.L < darkCut) wgt *= 0.005;
                        weights.push(wgt);
                    } else {
                        weights.push(1.0);
                    }
                    return true;
                };
                if (maxSamples > 0 && maxSamples < total) {
                    const want = Math.min(maxSamples, total);
                    const picked = new Set();
                    let attempts = 0;
                    const maxAttempts = want * 10;
                    while (picked.size < want && attempts < maxAttempts) {
                        const idx = Math.floor(rng.next() * total);
                        attempts++;
                        if (picked.has(idx)) continue;
                        if (addPixel(idx)) picked.add(idx);
                    }
                    if (pixels.length === 0) {
                        for (let i = 0; i < total; i++) addPixel(i);
                    }
                } else {
                    for (let i = 0; i < total; i++) addPixel(i);
                }
                // k-means++ init: first centroid random, each subsequent one chosen with probability
                // proportional to squared OKLab distance from its nearest existing centroid.
                // This is the core seeding strategy behind libimagequant's palette quality.
                // Costs O(K^2 * samples), so a warm-started re-clustering pass (opts.fastInit,
                // used by buildProgressivePalette) skips it for an even-stride seed instead —
                // Lloyd iterations below correct it just as well when K is already close to
                // the previous pass's centroid count.
                const centroids = [];
                if (opts.fastInit) {
                    // Stride over the raw (spatially-ordered) sample list would
                    // repeatedly land inside the same large same-color region
                    // after a few reduction passes and seed duplicate/collapsed
                    // centroids — dedupe first so every seed starts distinct.
                    const uniqueMap = new Map();
                    for (const p of pixels) {
                        const key = p.L + '_' + p.a + '_' + p.b;
                        if (!uniqueMap.has(key)) uniqueMap.set(key, p);
                    }
                    const unique = [...uniqueMap.values()];
                    const stride = Math.max(1, Math.floor(unique.length / K));
                    for (let k = 0; k < K; k++) {
                        const src = unique[Math.min(unique.length - 1, k * stride)];
                        centroids.push({ ...(src || unique[k % unique.length]) });
                    }
                } else {
                    centroids.push({ ...pixels[Math.floor(rng.next() * pixels.length)] });
                    for (let k = 1; k < K; k++) {
                        const dists = new Float64Array(pixels.length);
                        let totalDist = 0;
                        for (let i = 0; i < pixels.length; i++) {
                            const p = pixels[i];
                            let minD = Infinity;
                            for (let c = 0; c < centroids.length; c++) {
                                const d = this.distOklab(p, centroids[c]);
                                if (d < minD) minD = d;
                            }
                            const wd = minD * weights[i];
                            dists[i] = wd;
                            totalDist += wd;
                        }
                        let threshold = rng.next() * totalDist;
                        let chosen = pixels.length - 1;
                        for (let i = 0; i < pixels.length; i++) {
                            threshold -= dists[i];
                            if (threshold <= 0) { chosen = i; break; }
                        }
                        centroids.push({ ...pixels[chosen] });
                    }
                }
                // k-means iteration with worst-error re-seeding for empty clusters:
                // instead of a random pixel, re-seed from the pixel furthest from any centroid.
                // This ensures every color slot covers a meaningful region of the color space.
                for (let iter = 0; iter < iterations; iter++) {
                    const sums = centroids.map(() => ({ L: 0, a: 0, b: 0, w: 0 }));
                    let worstErr = -1, worstIdx = 0;
                    for (let i = 0; i < pixels.length; i++) {
                        const p = pixels[i];
                        const wt = weights[i];
                        if (wt <= 0) continue;
                        let bestD = Infinity, idx = 0;
                        for (let c = 0; c < K; c++) {
                            const dist = this.distOklab(p, centroids[c]);
                            if (dist < bestD) { bestD = dist; idx = c; }
                        }
                        sums[idx].L += p.L * wt; sums[idx].a += p.a * wt; sums[idx].b += p.b * wt; sums[idx].w += wt;
                        const we = bestD * wt;
                        if (we > worstErr) { worstErr = we; worstIdx = i; }
                    }
                    for (let c = 0; c < K; c++) {
                        if (sums[c].w > 0) {
                            centroids[c].L = sums[c].L / sums[c].w;
                            centroids[c].a = sums[c].a / sums[c].w;
                            centroids[c].b = sums[c].b / sums[c].w;
                        } else {
                            centroids[c] = { ...pixels[worstIdx] };
                        }
                    }
                }
                const rgbCentroids = centroids.map(c => this.oklabToRgb(c.L, c.a, c.b));
                const palette = rgbCentroids.map(c => ({ r: c[0], g: c[1], b: c[2], a: 255 }));
                return palette;
            },

            // A single k-means (or Wu) pass straight from thousands of source
            // colors down to a small target has to choose every merge at
            // once, which can blur or misplace a boundary a human reads as
            // meaningful. Reducing in small geometric steps instead — each
            // pass re-clustering the PREVIOUS pass's already-reduced image
            // rather than the original — only ever merges nearby colors, so
            // real edges survive far more of the descent. Ratio is 10% per
            // step above 150 colors, 5% below it, matching how much finer
            // the low end needs to be to still land on the exact target.
            buildProgressiveDepthSteps(startK, targetK) {
                const steps = [];
                let k = Math.max(targetK, Math.round(startK));
                while (k > targetK) {
                    steps.push(k);
                    const ratio = k > 150 ? 0.9 : 0.95;
                    let next = Math.floor(k * ratio);
                    if (next >= k) next = k - 1;
                    if (next < targetK) next = targetK;
                    k = next;
                }
                steps.push(targetK);
                return steps;
            },
            buildProgressivePalette(imgData, w, h, targetK, opts = {}) {
                const total = w * h;
                const d = imgData.data;
                // ponytail: caps the descent's starting point at 200. The
                // k-means++ seeding buildKmeansPalette uses costs O(K^2 * N)
                // to place K centroids, so a much higher starting K would
                // make the very first step take seconds instead of a blink;
                // 200 already gives the low targets this tool is for (tens
                // to a couple hundred colors) several real steps to descend
                // through. Raise it (and buildKmeansPalette's own seeding)
                // together if a real need for a higher starting count shows up.
                const START_CAP = 200;
                const distinct = new Set();
                for (let i = 0; i < total && distinct.size < START_CAP; i++) {
                    const p = i * 4;
                    if (d[p + 3] === 0) continue;
                    distinct.add((d[p] << 16) | (d[p + 1] << 8) | d[p + 2]);
                }
                const startK = Math.max(targetK, Math.min(START_CAP, distinct.size));
                const steps = this.buildProgressiveDepthSteps(startK, targetK);

                // Each pass quantizes this working copy and writes the
                // result back into it, so the next pass clusters an
                // already-reduced image instead of the original.
                const work = new Uint8ClampedArray(d);
                const workImgData = { data: work };
                let palette = null;
                for (let i = 0; i < steps.length; i++) {
                    const K = steps[i];
                    // Every step but the last is a warm-started merge of an
                    // already-close previous step, so a fast even-stride seed
                    // is plenty — only the final palette pays for true
                    // k-means++ seeding.
                    const fastInit = i < steps.length - 1;
                    palette = this.buildKmeansPalette(workImgData, w, h, K, { seed: opts.seed || 1337, maxSamples: 20000, iterations: 5, fastInit });
                    const lookup = this.buildPaletteLookup(palette);
                    for (let i = 0; i < total; i++) {
                        const p = i * 4;
                        if (work[p + 3] === 0) continue;
                        const q = this.quantizeRgbWithLookup(work[p], work[p + 1], work[p + 2], lookup);
                        work[p] = q.r; work[p + 1] = q.g; work[p + 2] = q.b;
                    }
                }
                return palette;
            },

            initPaletteGL() {
                if (this.paletteGLFailed) return null;
                if (this.paletteGL) return this.paletteGL;
                const canvas = document.createElement('canvas');
                const gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
                if (!gl) {
                    this.paletteGLFailed = true;
                    return null;
                }
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
    precision mediump float;
    varying vec2 vTex;
    uniform sampler2D uImage;
    uniform sampler2D uPalette;
    uniform int uCount;
    uniform int uHasAlpha0;
    vec4 paletteAt(int idx) {
        float x = (float(idx) + 0.5) / 256.0;
        return texture2D(uPalette, vec2(x, 0.5));
    }
    void main() {
        vec4 color = texture2D(uImage, vTex);
        if (color.a < 0.5 && uHasAlpha0 == 1) {
            gl_FragColor = paletteAt(0);
            return;
        }
        vec4 best = paletteAt(0);
        float bestDist = 1e9;
        for (int i = 0; i < 256; i++) {
            if (i >= uCount) break;
            vec4 p = paletteAt(i);
            if (p.a < 0.5) continue;
            vec3 d = color.rgb - p.rgb;
            float dist = dot(d, d);
            if (dist < bestDist) {
                bestDist = dist;
                best = p;
            }
        }
        gl_FragColor = vec4(best.rgb, 1.0);
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
                    this.paletteGLFailed = true;
                    return null;
                }
                const prog = gl.createProgram();
                gl.attachShader(prog, vs);
                gl.attachShader(prog, fs);
                gl.linkProgram(prog);
                if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
                    this.paletteGLFailed = true;
                    return null;
                }
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
                const tex = gl.createTexture();
                const palTex = gl.createTexture();
                this.paletteGL = {
                    canvas,
                    gl,
                    prog,
                    tex,
                    palTex,
                    posBuf,
                    texBuf,
                    uCount: gl.getUniformLocation(prog, 'uCount'),
                    uHasAlpha0: gl.getUniformLocation(prog, 'uHasAlpha0'),
                    uImage: gl.getUniformLocation(prog, 'uImage'),
                    uPalette: gl.getUniformLocation(prog, 'uPalette'),
                    aPos: gl.getAttribLocation(prog, 'aPos'),
                    aTex: gl.getAttribLocation(prog, 'aTex'),
                };
                canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.paletteGL = null; this.paletteGLFailed = false; }, { once: true });
                return this.paletteGL;
            },
            shouldUsePaletteGL(w, h, palette) {
                if (this.paletteGLFailed) return false;
                if (!palette || !palette.list || palette.list.length === 0) return false;
                if (palette.list.length > 256) return false;
                return (w * h) >= 200000;
            },
            applyWebGLEnforcePalette(ctx, w, h, palette) {
                const p = this.initPaletteGL();
                if (!p) return false;
                const { canvas, gl, prog, tex, palTex, posBuf, texBuf, uCount, uHasAlpha0, uImage, uPalette } = p;
                canvas.width = w;
                canvas.height = h;
                gl.viewport(0, 0, w, h);
                gl.useProgram(prog);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ctx.canvas);
                const palData = new Uint8Array(256 * 4);
                const list = palette.list;
                for (let i = 0; i < list.length && i < 256; i++) {
                    const c = list[i];
                    const idx = i * 4;
                    palData[idx] = c.r;
                    palData[idx + 1] = c.g;
                    palData[idx + 2] = c.b;
                    palData[idx + 3] = c.a;
                }
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, palTex);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, palData);
                const posLoc = p.aPos;
                const texLoc = p.aTex;
                gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
                gl.enableVertexAttribArray(posLoc);
                gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
                gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
                gl.enableVertexAttribArray(texLoc);
                gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);
                gl.uniform1i(uImage, 0);
                gl.uniform1i(uPalette, 1);
                gl.uniform1i(uCount, Math.min(256, list.length));
                gl.uniform1i(uHasAlpha0, list.length > 0 && list[0].a === 0 ? 1 : 0);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                this.disableSmoothing(ctx);
                ctx.clearRect(0, 0, w, h);
                ctx.drawImage(canvas, 0, 0);
                return true;
            },
            _livePreviewPaletteSwatchEdit() {
                if (!this._paletteSwatchEditTarget) return;
                this._paletteSwatchEditTarget.style.backgroundColor = this.winColorSelected;
            },
            _livePreviewSwatch() {
                if (!this.winColorSelected) return;
                if (this._gradStopEditTarget != null) {
                    const idx = this._gradStopEditTarget;
                    if (this.config.gradient.stops && this.config.gradient.stops[idx]) {
                        this.config.gradient.stops[idx].color = this.winColorSelected;
                        if (this._renderGradBar) this._renderGradBar();
                        const _gs = this.config.gradient.stops;
                        if (_gs && _gs.length >= 2) {
                            if (idx === 0) {
                                this.config.c1 = _gs[0].color;
                                const el = document.getElementById('c1-disp');
                                if (el) el.style.backgroundColor = _gs[0].color;
                            }
                            if (idx === _gs.length - 1) {
                                this.config.c2 = _gs[idx].color;
                                const el = document.getElementById('c2-disp');
                                if (el) el.style.backgroundColor = _gs[idx].color;
                            }
                        }
                    }
                    return;
                }
                const slot = this.config.activeSlot;
                const el = document.getElementById('c' + slot + '-disp');
                if (el) el.style.backgroundColor = this.winColorSelected;
                const swatchId = slot === 1 ? 'fh-fill-swatch' : 'fh-stroke-swatch';
                const swatch = document.getElementById(swatchId);
                if (swatch) swatch.style.backgroundColor = this.winColorSelected;
            },
            renderQuantPalette() {
                if (!this.ui.cqPalette) return;
                this.ui.cqPalette.innerHTML = '';
                const pal = this.palette || [];
                pal.forEach((c, index) => {
                    const d = document.createElement('div');
                    d.className = 'mini-swatch';
                    const hex = this.rgbToHex(c.r, c.g, c.b);
                    d.style.backgroundColor = hex;
                    d.dataset.fixedPaletteColor = hex;
                    d.dataset.slot = String(index);
                    d.title = 'Slot ' + index + ' — ' + hex;
                    if (this.paletteSlotFor(this.config.activeSlot) === index) d.dataset.activeSlot = 'true';
                    d.onclick = () => {
                        // Remember which slot this was, not just what colour it is. Two
                        // slots can hold the same colour and mean different things —
                        // that is the whole reason a shiny palette works.
                        this.pickPaletteSlot(index, this.config.activeSlot);
                        this.closeModals();
                    };
                    this.ui.cqPalette.appendChild(d);
                });
                this.enforceFixedPaletteSwatchStyles();
            },
            paletteSlotFor(colorSlot) {
                const map = this.config.paletteSlot;
                if (!map) return -1;
                const idx = map[colorSlot === 2 ? 2 : 1];
                return Number.isInteger(idx) ? idx : -1;
            },
            /* Choose a palette slot as the drawing colour. The colour follows from the
               slot, never the other way around. */
            pickPaletteSlot(index, colorSlot) {
                const pal = this.palette || [];
                const c = pal[index];
                if (!c) return;
                this.setColor(this.rgbToHex(c.r, c.g, c.b), colorSlot);
                if (!this.config.paletteSlot) this.config.paletteSlot = { 1: -1, 2: -1 };
                this.config.paletteSlot[colorSlot === 2 ? 2 : 1] = index;
                this.renderQuantPalette();
                this.updateProjectConformance();
                if (window.PalettePanel && window.PalettePanel.render) window.PalettePanel.render();
            },
            debugDumpPalette() {
                if (!this.state.selection || !this.state.selection.palette) {
                    console.log('PaintApp palette', null);
                    return;
                }
                const list = this.state.selection.palette.list || [];
                console.log('PaintApp palette', {
                    size: list.length,
                    sample: list.slice(0, 10)
                });
            },
            rebuildExportPalette(targetSize) {
                const srcCtx = this.ui.cMain.getContext('2d');
                const paletteResult = this.extractPalette(srcCtx, this.config.width, this.config.height);
                const pal = paletteResult.list.slice(0, targetSize);
                while (pal.length < targetSize) {
                    pal.push({ r: 0, g: 0, b: 0, a: 0 });
                }
                this.state.exportPalette = pal;
            },
            renderExportPaletteUI() {
                const grid = document.getElementById('export-palette-grid');
                if (!grid) return;
                grid.innerHTML = '';

                this.state.exportPalette.forEach((color, index) => {
                    const div = document.createElement('div');
                    div.className = 'export-swatch';
                    div.setAttribute('data-index', index);
                    div.draggable = true;

                    const cssColor = `rgba(${color.r},${color.g},${color.b},${color.a / 255})`;
                    div.style.backgroundColor = cssColor;

                    if (color.a < 255) {
                        div.style.backgroundImage = 'linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%)';
                        div.style.backgroundSize = '10px 10px';
                    }

                    div.innerHTML = `<span class="swatch-idx">${index}</span>`;

                    div.addEventListener('dragstart', (e) => this.onExportDragStart(e, index));
                    div.addEventListener('dragover', (e) => this.onExportDragOver(e, index));
                    div.addEventListener('drop', (e) => this.onExportDrop(e, index));
                    div.addEventListener('dragend', (e) => this.onExportDragEnd(e));

                    grid.appendChild(div);
                });

                const countLabel = document.getElementById('export-palette-count');
                if (countLabel) {
                    const total = this.state.exportPalette.length;
                    const used = this.state.exportPalette.filter(c => c.a > 0).length;
                    countLabel.textContent = `${used}/${total}`;
                }
            },
            parsePngPalette(bytes) {
                const sig = [137, 80, 78, 71, 13, 10, 26, 10];
                if (!bytes || bytes.length < 8) throw new Error('File is not a PNG');
                for (let i = 0; i < 8; i++) {
                    if (bytes[i] !== sig[i]) throw new Error('File is not a PNG');
                }
                let pos = 8;
                let width = 0, height = 0, bitDepth = 8, colorType = 0, interlace = 0;
                let palette = null, trns = null;
                const idat = [];
                while (pos + 8 <= bytes.length) {
                    const len = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
                    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
                    const dataStart = pos + 8;
                    const dataEnd = dataStart + len;
                    if (type === 'IHDR' && len >= 13) {
                        width = (bytes[dataStart] << 24) | (bytes[dataStart + 1] << 16) | (bytes[dataStart + 2] << 8) | bytes[dataStart + 3];
                        height = (bytes[dataStart + 4] << 24) | (bytes[dataStart + 5] << 16) | (bytes[dataStart + 6] << 8) | bytes[dataStart + 7];
                        bitDepth = bytes[dataStart + 8];
                        colorType = bytes[dataStart + 9];
                        interlace = bytes[dataStart + 12];
                    } else if (type === 'IDAT') {
                        idat.push(bytes.subarray(dataStart, dataEnd));
                    } else if (type === 'PLTE') {
                        const count = Math.floor(len / 3);
                        palette = [];
                        for (let i = 0; i < count; i++) {
                            palette.push({ r: bytes[dataStart + i * 3], g: bytes[dataStart + i * 3 + 1], b: bytes[dataStart + i * 3 + 2], a: 255 });
                        }
                    } else if (type === 'tRNS') {
                        trns = bytes.slice(dataStart, dataEnd);
                    } else if (type === 'IEND') {
                        break;
                    }
                    if (dataEnd + 4 > bytes.length) break;
                    pos = dataEnd + 4;
                }
                if (palette && trns) {
                    for (let i = 0; i < trns.length && i < palette.length; i++) palette[i].a = trns[i];
                }
                return { width, height, bitDepth, colorType, palette, trns, idat, interlace };
            },
            /* The per-pixel palette indices, straight from the file.
               These are the real content of an indexed PNG: two palette slots can hold
               the same RGB (26% of pokeemerald species palettes do), and only the index
               says which one a pixel meant — which matters because the shiny palette
               may give those two slots different colours. Reconstructing indices from
               RGB cannot tell them apart, so we decode them instead of guessing.
               Returns null for anything we can't read exactly; callers fall back. */
            _nearestPaletteIndex(r, g, b) {
                this.ensurePaletteLab();
                const pLab = this.rgbToOklab(r, g, b);
                let best = 0, bestDist = Infinity;
                for (let i = 0; i < this.paletteLab.length; i++) {
                    const dist = this.distOklab(pLab, this.paletteLab[i]);
                    if (dist < bestDist) { bestDist = dist; best = i; }
                }
                return best;
            },
            repaintProjectFromPalette() {
                if (!this.state.projectImage) return false;
                if (this.state.previewPaletteId) return false; // a preview is not an edit
                const w = this.config.width, h = this.config.height;
                const map = this.state.projectIndices;
                if (!map || map.length !== w * h) return false;
                const { ctx, canSnap } = this.projectIndexSurface();
                // With layers active the artwork is spread across canvases the map does
                // not describe; repainting the composite would be undone by the next
                // render. The palette still changes — the canvas just will not follow.
                if (!ctx || !canSnap) return false;
                let img;
                try { img = ctx.getImageData(0, 0, w, h); }
                catch (e) { return false; }
                const changed = this.paintProjectIndicesOnto(img, map, ctx, w);
                this.saveState();
                return changed;
            },

            /* Renumber the map through `table`, which maps an old slot to a new one.
               Reordering a palette moves colours between slots; the artwork has to
               follow, or "move slot 3 to slot 7" silently recolours the sprite instead
               of renaming a slot. The pixels do not change, so there is nothing to
               repaint — only the numbers underneath them. */
            projectPaletteSnapshot() {
                const colors = this.palette;
                if (!colors || !colors.length) return null;
                const out = new Uint8Array(colors.length * 4);
                for (let i = 0; i < colors.length; i++) {
                    const c = colors[i];
                    out[i * 4] = c.r; out[i * 4 + 1] = c.g; out[i * 4 + 2] = c.b;
                    out[i * 4 + 3] = c.a === undefined ? 255 : c.a;
                }
                return out;
            },

            /* Pin the index map and the palette to the history entry just pushed, so
               undo restores what the pixels MEAN as well as the pixels. Neither is
               written in place, so the entry can hold them directly.

               Without the palette half, undoing a slot edit — or the normal/shiny swap,
               which has always been a history step — would leave the canvas showing one
               palette while the map was read through another, and the next committed
               edit would renumber the whole asset against colours it never used. */
            deferSelectionPalette(ctx, w, h, selectionRef) {
                const compute = () => {
                    if (!selectionRef || this.state.selection !== selectionRef) return;
                    selectionRef.palette = this.extractPalette(ctx, w, h);
                    this.renderSelection();
                };
                if (window.requestIdleCallback) {
                    requestIdleCallback(compute, { timeout: 200 });
                } else {
                    setTimeout(compute, 0);
                }
            },
            promptImportPalette() {
                const input = document.getElementById('pal-upload');
                if (!input) return;
                input.value = '';
                input.click();
            },

            exportPalette() {
                if (this.bitDepth === 24) {
                    const { list } = this.extractPalette(this.ctx, this.config.width, this.config.height);
                    this.palette = list;
                }
                let out = "JASC-PAL\r\n0100\r\n" + this.palette.length + "\r\n";
                for(let c of this.palette) {
                    let r = Math.floor(c.r / 8) * 8;
                    let g = Math.floor(c.g / 8) * 8;
                    let b = Math.floor(c.b / 8) * 8;
                    out += `${r} ${g} ${b}\r\n`;
                }
                const blob = new Blob([out], {type: 'text/plain'});
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'palette.pal';
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 100);
            },

            parseGbaPaletteText(text) {
                const lines = String(text).split(/\r?\n/);
                if (lines[0] !== 'JASC-PAL' || lines[1] !== '0100') {
                    throw new Error('Invalid JASC-PAL file');
                }
                const count = parseInt(lines[2], 10);
                if (!Number.isFinite(count) || count < 0) {
                    throw new Error('Invalid JASC-PAL file');
                }
                /* Decomp palettes are always 0-255. Guessing the scale from the largest
                   channel used to inflate any legitimately dark palette by 8x — a shadow
                   ramp of 0-31 values is a real palette, not a differently-scaled one. */
                const pal = [];
                for (let i = 3; i < 3 + count; i++) {
                    if (!lines[i]) continue;
                    const parts = lines[i].trim().split(/\s+/);
                    if (parts.length < 3) continue;
                    const r = Number(parts[0]), g = Number(parts[1]), b = Number(parts[2]);
                    if (![r, g, b].every(v => Number.isFinite(v) && v >= 0 && v <= 255)) continue;
                    pal.push({ r, g, b, a: i === 3 ? 0 : 255 });
                }
                if (!pal.length) throw new Error('Palette file had no valid colors');
                return { colors: pal, isGba: false };
            },
            applyGbaPaletteText(text) {
                let parsed;
                try {
                    parsed = this.parseGbaPaletteText(text);
                } catch (e) {
                    showToast(e.message, 'warning');
                    return;
                }
                const { colors, isGba } = parsed;
                this.palette = colors;
                this.paletteLab = null;
                this.paletteLocked = false;
                this.renderQuantPalette();
                this.saveState();
                showToast('Palette loaded' + (isGba ? ' (GBA 15-bit scaled)' : ''), 'info');
            },
            loadProjectPalette(name, text) {
                let parsed;
                try {
                    parsed = this.parseGbaPaletteText(text);
                } catch (e) {
                    showToast(e.message, 'warning');
                    return;
                }
                const label = this.labelForProjectPal(name);
                const id = 'pal-' + (name || label);
                const entry = {
                    id,
                    name: label,
                    colors: parsed.colors,
                    source: 'pal',
                    handle: null,
                    path: null
                };
                if (!Array.isArray(this.state.palettes)) this.state.palettes = [];
                const existingIdx = this.state.palettes.findIndex(p => p.id === id);
                if (existingIdx >= 0) this.state.palettes[existingIdx] = entry;
                else this.state.palettes.push(entry);
                this.palette = entry.colors;
                this.basePalette = entry.colors;
                this.paletteLab = null;
                this.paletteLocked = false;
                this.state.activePaletteId = id;
                if (!this.state.projectBitDepth) this.state.projectBitDepth = 4;
                this.renderQuantPalette();
                this.saveState();
                if (this.onPalettesChanged) this.onPalettesChanged();
                if (window.PalettePanel && window.PalettePanel.open) window.PalettePanel.open();
                if (window.SpritePreview && window.SpritePreview.open) window.SpritePreview.open();
                showToast('Palette loaded' + (parsed.isGba ? ' (GBA 15-bit scaled)' : ''), 'info');
            },
            async buildProjectPalettes(embeddedColors, palNodes) {
                const palettes = [];
                palettes.push({ id: 'embedded', name: 'Embedded', colors: embeddedColors, source: 'embedded', handle: null, path: null });
                if (Array.isArray(palNodes)) {
                    for (let i = 0; i < palNodes.length; i++) {
                        const node = palNodes[i];
                        try {
                            const text = await this.readPalNodeText(node);
                            const parsed = this.parseGbaPaletteText(text);
                            palettes.push({
                                id: 'pal-' + i + '-' + node.name,
                                name: this.labelForProjectPal(node.name),
                                colors: parsed.colors,
                                source: 'pal',
                                handle: node.handle || null,
                                path: node.path || null
                            });
                        } catch (e) {
                            console.warn('Failed to load palette', node && node.name, e);
                        }
                    }
                }
                return palettes;
            },
            /* Sizes and depths here were counted across a whole pokeemerald-expansion
               working copy, not remembered. A profile that rejects a stock asset is
               worse than no profile at all: it teaches people to click through the
               warning that was meant to save them.

               The counts behind each `allowedResolutions` (expansion 1.16.4, 11,234
               PNGs) are in the comments, because the temptation when something new
               trips a profile is to widen it, and the count says whether widening is
               honest or is just silencing the one asset in front of you.

               `strictResolution: false` is a real answer, not a cop-out. Object-event
               sheets came back in eleven different shapes; there is no box to hold
               them to, and pretending otherwise is how F5 happened. */
            async writeProjectPalFiles() {
                const entries = (this.state.palettes || []).filter(p => p.source === 'pal' && (p.handle || p.path));
                for (const e of entries) {
                    const text = this.serializeJascPal(e.colors);
                    const bytes = new TextEncoder().encode(text);
                    try {
                        if (e.path && this.getTauriInvokeFn()) {
                            await this.tauriWriteAllowedFile(this.normalizeIncomingPath(e.path), bytes);
                        } else if (e.handle && typeof e.handle.createWritable === 'function') {
                            try {
                                const writable = await e.handle.createWritable();
                                await writable.write(new Blob([bytes]));
                                await writable.close();
                            } catch (err) {
                                await this.writePalViaSaveDialog(e.name, bytes);
                            }
                        } else {
                            await this.writePalViaSaveDialog(e.name, bytes);
                        }
                    } catch (err) {
                        if (err && err.name === 'AbortError') continue;
                        console.error('Failed to write palette', e.name, err);
                        showToast('Palette write failed: ' + e.name, 'error');
                    }
                }
            },
            getPaletteById(id) {
                return (this.state.palettes || []).find(p => p.id === id) || null;
            },
            setActivePalette(id) {
                const e = this.getPaletteById(id);
                if (!e) return;
                /* For a project asset, which palette is active is not a view setting —
                   it is what the index map is read through. Switching has to repaint,
                   or the canvas would keep the old colours while every later edit was
                   resolved against the new ones. That is the normal/shiny toggle. */
                if (this.state.projectImage && id !== this.state.activePaletteId
                    && this.state.projectIndices
                    && this.state.projectIndices.length === this.config.width * this.config.height) {
                    this.remapCanvasToPalette(id);
                    return;
                }
                this.palette = e.colors;
                this.paletteLab = null;
                this.state.activePaletteId = id;
                this.renderQuantPalette();
                if (this.onPalettesChanged) this.onPalettesChanged();
            },
            /* Is this the palette the canvas is currently being read through? Only that
               one is part of the document; editing the shiny palette while painting the
               normal one changes a file on disk, not the artwork on screen. */
            reorderPaletteColor(paletteId, from, to) {
                const e = this.getPaletteById(paletteId);
                if (!e) return;
                const arr = e.colors;
                if (from < 0 || from >= arr.length || to < 0 || to >= arr.length || from === to) return;
                const moved = arr.splice(from, 1)[0];
                arr.splice(to, 0, moved);
                this.paletteLab = null;
                /* The indices point INTO this array, so a colour that moved takes every
                   pixel naming it along. Do it by table rather than by colour: two slots
                   can hold the same RGB, and matching on colour would merge them. */
                if (this.drivesProjectCanvas(paletteId)) {
                    const table = new Array(arr.length);
                    for (let i = 0; i < arr.length; i++) {
                        if (i === from) table[i] = to;
                        else if (from < to) table[i] = (i > from && i <= to) ? i - 1 : i;
                        else table[i] = (i >= to && i < from) ? i + 1 : i;
                    }
                    this.renumberProjectIndices(table);
                    this.renderQuantPalette();
                    this.repaintProjectFromPalette();
                    if (this.onPalettesChanged) this.onPalettesChanged();
                    return;
                }
                if (paletteId === this.state.activePaletteId) this.renderQuantPalette();
                if (this.state.previewPaletteId) this._recolorPreview();
                else if (this.onPalettesChanged) this.onPalettesChanged();
            },
            updatePaletteColor(paletteId, index, rgb) {
                const e = this.getPaletteById(paletteId);
                if (!e || index < 0 || index >= e.colors.length) return;
                const was = e.colors[index];
                if (was.r === rgb.r && was.g === rgb.g && was.b === rgb.b) return;
                e.colors[index] = { r: rgb.r, g: rgb.g, b: rgb.b, a: was.a };
                this.paletteLab = null;
                if (paletteId === this.state.activePaletteId) this.renderQuantPalette();
                // The canvas is this palette rendered through the index map, so a slot
                // edit repaints the pixels holding that slot and nothing else. No
                // re-quantise, no index moves — the artwork is not being reinterpreted.
                if (this.drivesProjectCanvas(paletteId)) this.repaintProjectFromPalette();
                if (this.state.previewPaletteId) this._recolorPreview();
                if (this.onPalettesChanged) this.onPalettesChanged();
            },
            addPaletteColorTo(paletteId, color) {
                const e = this.getPaletteById(paletteId);
                if (!e) return;
                e.colors.push({ r: color.r, g: color.g, b: color.b, a: 255 });
                this.paletteLab = null;
                if (paletteId === this.state.activePaletteId) this.renderQuantPalette();
                /* Appending moves no index and repaints nothing, but the palette is half
                   of a project asset's document — and a 17th colour on a 4bpp sprite is
                   exactly the kind of change conformance is watching for. Record it, or
                   undo would silently drop back to a palette the canvas no longer
                   matches. */
                if (this.drivesProjectCanvas(paletteId)) this.saveState();
                if (this.state.previewPaletteId) this._recolorPreview();
                if (this.onPalettesChanged) this.onPalettesChanged();
            },
            moveColorBetweenPalettes(srcId, srcIdx, dstId, dstIdx) {
                const src = this.getPaletteById(srcId);
                const dst = this.getPaletteById(dstId);
                if (!src || !dst || srcIdx < 0 || srcIdx >= src.colors.length) return;
                /* Taking a colour OUT of the palette driving the canvas deletes a slot
                   the artwork may be standing on, and there is no honest place to send
                   those pixels. Refuse while the slot is in use; an unused slot is just
                   housekeeping and goes through. */
                const leavingProject = this.drivesProjectCanvas(srcId) && srcId !== dstId;
                if (leavingProject) {
                    const map = this.state.projectIndices;
                    let used = 0;
                    if (map) for (let q = 0; q < map.length; q++) if (map[q] === srcIdx) used++;
                    if (used) {
                        showToast(`Slot ${srcIdx} is used by ${used} pixel(s) — recolour them first`, 'warning');
                        return;
                    }
                }
                const enteringProject = this.drivesProjectCanvas(dstId) && srcId !== dstId;
                const moved = src.colors.splice(srcIdx, 1)[0];
                if (dstIdx < 0 || dstIdx > dst.colors.length) dstIdx = dst.colors.length;
                dst.colors.splice(dstIdx, 0, moved);
                this.paletteLab = null;
                // A slot left or arrived, so the ones after it all shifted by one and
                // the artwork has to be renumbered to keep pointing at its own colours.
                if (leavingProject || enteringProject) {
                    const len = (leavingProject ? src.colors.length + 1 : dst.colors.length);
                    const at = leavingProject ? srcIdx : dstIdx;
                    const table = new Array(len);
                    for (let i = 0; i < len; i++) {
                        table[i] = leavingProject ? (i > at ? i - 1 : i) : (i >= at ? i + 1 : i);
                    }
                    this.renumberProjectIndices(table);
                    this.renderQuantPalette();
                    this.repaintProjectFromPalette();
                    if (this.onPalettesChanged) this.onPalettesChanged();
                    return;
                }
                if (srcId === this.state.activePaletteId || dstId === this.state.activePaletteId) this.renderQuantPalette();
                if (this.state.previewPaletteId) this._recolorPreview();
                if (this.onPalettesChanged) this.onPalettesChanged();
            },
            /* Show the artwork under a given palette at a true pixel scale.
               `opts.scale` is an integer multiplier of real pixels — 1 means 1:1, the
               size the thing will be in the game, which is the whole point of having
               this pane open while working at 800%. `opts.frame` picks one frame of a
               sheet; without it the whole file is shown.

               Deliberately NOT cropped to the artwork's bounding box. This refreshes on
               every edit now, and a crop would make the pane resize under the cursor
               every time a pixel near an edge changed. Showing the full frame also shows
               where the sprite sits inside it, which is what 3.4 is about. */
            renderPalettePreviewInto(canvas, paletteId, opts) {
                if (!canvas) return false;
                const target = this.getPaletteById(paletteId);
                if (!target) return false;
                const w = this.config.width, h = this.config.height;
                if (!w || !h) { canvas.width = 0; canvas.height = 0; return false; }
                const o = opts || {};
                const scale = Math.max(1, Math.round(o.scale || 1));
                const rect = (o.frame === undefined || o.frame === null)
                    ? { x: 0, y: 0, w, h }
                    : (this.projectFrameRect(o.frame) || { x: 0, y: 0, w, h });

                let srcData;
                try { srcData = this.ctx.getImageData(0, 0, w, h); }
                catch (e) { canvas.width = 0; canvas.height = 0; return false; }

                const native = document.createElement('canvas');
                native.width = w; native.height = h;
                const nctx = native.getContext('2d');
                if (this.palette && this.palette.length) {
                    // Repaint through the index map, so this shows what the file would
                    // contain under that palette rather than a nearest-colour guess.
                    const idx = (this.spriteIndices && this.spriteIndices.length === w * h)
                        ? this.spriteIndices
                        : this.quantizeToIndices(srcData.data, w, h, this.basePalette || this.palette);
                    const nd = nctx.createImageData(w, h);
                    const tcol = target.colors;
                    const alpha = srcData.data;
                    for (let q = 0; q < w * h; q++) {
                        const i = idx[q];
                        const c = tcol[i] || tcol[0] || { r: 0, g: 0, b: 0 };
                        const b4 = q * 4;
                        nd.data[b4] = c.r; nd.data[b4 + 1] = c.g; nd.data[b4 + 2] = c.b; nd.data[b4 + 3] = alpha[b4 + 3];
                    }
                    nctx.putImageData(nd, 0, 0);
                } else {
                    nctx.putImageData(srcData, 0, 0);
                }

                canvas.width = rect.w * scale;
                canvas.height = rect.h * scale;
                const cctx = canvas.getContext('2d');
                cctx.imageSmoothingEnabled = false;
                cctx.clearRect(0, 0, canvas.width, canvas.height);
                cctx.drawImage(native, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
                // CSS size tracks the backing store exactly: one artwork pixel is
                // `scale` screen pixels and no fraction of one, or this stops being a
                // preview of pixel art and starts being an impression of it.
                canvas.style.width = canvas.width + 'px';
                canvas.style.height = canvas.height + 'px';
                return true;
            },
            addPalette(name) {
                const src = this.palette || [];
                const colors = src.map(c => ({ r: c.r, g: c.g, b: c.b, a: c.a === undefined ? 255 : c.a }));
                const id = 'custom-' + Date.now();
                (this.state.palettes || (this.state.palettes = [])).push({
                    id, name: name || ('Custom ' + ((this.state.palettes || []).length + 1)),
                    colors, source: 'custom', handle: null, path: null
                });
                if (this.onPalettesChanged) this.onPalettesChanged();
            },
            removePalette(id) {
                const e = this.getPaletteById(id);
                if (!e || e.source === 'embedded') return;
                const wasDriving = this.drivesProjectCanvas(id);
                this.state.palettes = (this.state.palettes || []).filter(p => p.id !== id);
                if (this.state.activePaletteId === id) {
                    const a = this.state.palettes[0];
                    this.state.activePaletteId = a ? a.id : null;
                    this.palette = a ? a.colors : [];
                    this.basePalette = this.palette;
                    this.paletteLab = null;
                    // The canvas was showing the palette that just went away. Repaint it
                    // under whichever one took over, rather than leaving the pixels and
                    // the map disagreeing about what the artwork is made of.
                    if (wasDriving && a) { this.renderQuantPalette(); this.repaintProjectFromPalette(); }
                }
                if (this.state.previewPaletteId === id) this.exitPreview();
                if (this.onPalettesChanged) this.onPalettesChanged();
            },
            async exportSinglePalette(paletteId) {
                const e = this.getPaletteById(paletteId);
                if (!e || !e.colors || !e.colors.length) { showToast('No palette to export', 'warning'); return; }
                const text = this.serializeJascPal(e.colors);
                const bytes = new TextEncoder().encode(text);
                const suggested = (e.name && /\.pal$/i.test(e.name))
                    ? e.name
                    : ((e.name || 'palette').toLowerCase().replace(/[^a-z0-9_-]+/g, '_') + '.pal');
                try {
                    if (e.source === 'pal' && e.path && this.getTauriInvokeFn()) {
                        const normalized = this.normalizeIncomingPath(e.path);
                        await this.tauriWriteAllowedFile(normalized, bytes);
                        showToast('Palette saved: ' + e.name, 'info');
                        const dir = normalized.replace(/[\\/][^\\/]*$/, '');
                        this.revealInExplorer(dir);
                    } else if (e.source === 'pal' && e.handle && typeof e.handle.createWritable === 'function') {
                        const writable = await e.handle.createWritable();
                        await writable.write(new Blob([bytes]));
                        await writable.close();
                        showToast('Palette saved: ' + e.name, 'info');
                    } else {
                        await this.writePalViaSaveDialog(suggested, bytes);
                        showToast('Palette exported', 'info');
                    }
                } catch (err) {
                    if (err && err.name === 'AbortError') return;
                    console.error('Palette export failed', e.name, err);
                    showToast('Palette export failed: ' + e.name, 'error');
                }
            },
            generateShinyPalette(paletteId, hueShift) {
                const src = this.getPaletteById(paletteId);
                if (!src || !src.colors || !src.colors.length) { showToast('No palette to derive from', 'warning'); return; }
                const shift = Number.isFinite(hueShift) ? hueShift : 150;
                const rgbToHsl = (r, g, b) => {
                    r /= 255; g /= 255; b /= 255;
                    const max = Math.max(r, g, b), min = Math.min(r, g, b);
                    let h = 0, s = 0; const l = (max + min) / 2;
                    if (max !== min) {
                        const dd = max - min;
                        s = l > 0.5 ? dd / (2 - max - min) : dd / (max + min);
                        if (max === r) h = (g - b) / dd + (g < b ? 6 : 0);
                        else if (max === g) h = (b - r) / dd + 2;
                        else h = (r - g) / dd + 4;
                        h /= 6;
                    }
                    return [h, s, l];
                };
                const hslToRgb = (h, s, l) => {
                    let r, g, b;
                    if (s === 0) { r = g = b = l; }
                    else {
                        const hue2rgb = (p, q, t) => {
                            if (t < 0) t += 1;
                            if (t > 1) t -= 1;
                            if (t < 1 / 6) return p + (q - p) * 6 * t;
                            if (t < 1 / 2) return q;
                            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                            return p;
                        };
                        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
                        const p = 2 * l - q;
                        r = hue2rgb(p, q, h + 1 / 3);
                        g = hue2rgb(p, q, h);
                        b = hue2rgb(p, q, h - 1 / 3);
                    }
                    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
                };
                const colors = src.colors.map((c, i) => {
                    if (i === 0) return { r: c.r, g: c.g, b: c.b, a: c.a === undefined ? 255 : c.a };
                    const [h, s, l] = rgbToHsl(c.r, c.g, c.b);
                    const nh = (h + shift / 360) % 1;
                    const out = hslToRgb(nh < 0 ? nh + 1 : nh, s, l);
                    return { r: out.r, g: out.g, b: out.b, a: c.a === undefined ? 255 : c.a };
                });
                const baseName = src.name.replace(/\s*(normal|shiny)\s*$/i, '').trim() || src.name;
                const id = 'custom-' + Date.now();
                (this.state.palettes || (this.state.palettes = [])).push({
                    id, name: baseName + ' Shiny', colors, source: 'custom', handle: null, path: null
                });
                if (this.onPalettesChanged) this.onPalettesChanged();
                showToast('Shiny palette generated', 'info');
            },
            /* Repaint a project asset under a different palette, index by index.
               The index map is untouched — the pixels are new but they still mean the
               same slots, which is the whole point of swapping to shiny. */
            remapProjectCanvasToPalette(imgData, entry, paletteId, w, h) {
                const d = imgData.data;
                const colors = entry.colors;
                const transparentIdx = this.state.projectTransparentIndex;
                for (let p = 0, q = 0; p < d.length; p += 4, q++) {
                    const slot = this.spriteIndices[q];
                    if (slot === transparentIdx) {
                        d[p] = 0; d[p + 1] = 0; d[p + 2] = 0; d[p + 3] = 0;
                        continue;
                    }
                    const c = colors[slot] || colors[0];
                    d[p] = c.r; d[p + 1] = c.g; d[p + 2] = c.b; d[p + 3] = 255;
                }
                this.ctx.putImageData(imgData, 0, 0);
                this.basePalette = colors;
                this.palette = colors;
                this.paletteLab = null;
                this.state.activePaletteId = paletteId;
                this.renderQuantPalette();
                this.saveState();
                if (this.onPalettesChanged) this.onPalettesChanged();
            },
            remapCanvasToPalette(paletteId) {
                const e = this.getPaletteById(paletteId);
                if (!e || !e.colors || !e.colors.length) { showToast('No palette to remap to', 'warning'); return; }
                if (this.state.previewPaletteId) this.exitPreview();
                const w = this.config.width, h = this.config.height;
                let imgData;
                try { imgData = this.ctx.getImageData(0, 0, w, h); }
                catch (err) { showToast('Cannot read canvas', 'error'); return; }
                /* For a project asset the indices ARE the artwork — swapping to the shiny
                   palette recolours it without moving a pixel. Repaint straight from the
                   index map instead of re-deriving indices from RGB, which would collapse
                   slots that happen to share a colour in whichever palette we came from. */
                if (this.state.projectImage && this.spriteIndices && this.spriteIndices.length === w * h) {
                    this.remapProjectCanvasToPalette(imgData, e, paletteId, w, h);
                    return;
                }
                const d = imgData.data;
                const exact = new Set();
                for (let i = 0; i < e.colors.length; i++) {
                    const c = e.colors[i];
                    exact.add((c.r << 16) | (c.g << 8) | c.b);
                }
                const idx = this.quantizeToIndices(d, w, h, e.colors);
                let changed = 0;
                for (let p = 0, q = 0; p < d.length; p += 4, q++) {
                    if (d[p + 3] < 128) continue;
                    const r = d[p], g = d[p + 1], b = d[p + 2];
                    if (exact.has((r << 16) | (g << 8) | b)) continue;
                    const nc = e.colors[idx[q]] || e.colors[0];
                    d[p] = nc.r; d[p + 1] = nc.g; d[p + 2] = nc.b;
                    changed++;
                }
                this.ctx.putImageData(imgData, 0, 0);
                this.spriteIndices = idx;
                this.basePalette = e.colors;
                this.palette = e.colors;
                this.state.activePaletteId = paletteId;
                this.paletteLab = null;
                this.renderQuantPalette();
                this.saveState();
                if (this.onPalettesChanged) this.onPalettesChanged();
                showToast(changed ? ('Remapped ' + changed + ' pixel(s) to ' + e.name) : 'All pixels already in palette', 'info');
            },
            importPalette(file) {
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (e) => {
                    const text = e.target.result;
                    const lines = text.split(/\r?\n/);
                    if(lines[0] !== 'JASC-PAL' || lines[1] !== '0100') { showToast('Invalid JASC-PAL file', 'warning'); return; }
                    const count = parseInt(lines[2], 10);
                    if (!Number.isFinite(count) || count < 0) { showToast('Invalid JASC-PAL file', 'warning'); return; }
                    this.palette = [];
                    for(let i=3; i<3+count; i++) {
                        if(!lines[i]) continue;
                        const parts = lines[i].trim().split(/\s+/);
                        if(parts.length < 3) continue;
                        const r = Number(parts[0]);
                        const g = Number(parts[1]);
                        const b = Number(parts[2]);
                        if (![r, g, b].every(v => Number.isFinite(v) && v >= 0 && v <= 255)) continue;
                        let alpha = 255;
                        if (this.palette.length === 0) alpha = 0;
                        this.palette.push({r:Math.round(r), g:Math.round(g), b:Math.round(b), a:alpha});
                    }
                    if (!this.palette.length) { showToast('Palette file had no valid colors', 'warning'); return; }
                    this.paletteLab = null;
                    this.enforcePalette(this.ctx, this.config.width, this.config.height, {set: new Set(), list: this.palette});
                    this.saveState();
                };
                reader.readAsText(file);
            }

    });
})();
