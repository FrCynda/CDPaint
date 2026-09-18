/* gradient-tool — moved verbatim off the PaintEngine class body.
 *
 * Assigned onto the prototype, so `this` is the same PaintEngine instance
 * these methods have always run against. Loads after paint-engine.js and
 * before boot.js, which is where the instance is finally created.
 */
(function () {
    Object.assign(PaintEngine.prototype, {
            gradientApply() {
                const _g = this.config.gradient;
                if (!_g.active) return;
                const _dist = Math.hypot(_g.endX - _g.startX, _g.endY - _g.startY);
                if (_dist > 2) {
                    if (this.state.selection) {
                        // The selection carries its own floating pixel copy (s.canvas)
                        // that travels when it's dragged and is what gets stamped back
                        // down on commit. Paint the gradient into that copy only — not
                        // into the base layer too, or the gradient ends up baked onto
                        // the canvas underneath as well as living in the selection.
                        const s = this.state.selection;
                        const selCtx = s.canvas.getContext('2d');
                        const rot = this.getSelectionRotationDegrees(s) * Math.PI / 180;
                        selCtx.save();
                        selCtx.translate(s.canvas.width / 2, s.canvas.height / 2);
                        selCtx.rotate(-rot);
                        selCtx.scale(s.canvas.width / (s.w || 1), s.canvas.height / (s.h || 1));
                        selCtx.translate(-(s.x + s.w / 2), -(s.y + s.h / 2));
                        _gradientRender(selCtx, _g, this.config.width, this.config.height, this.config.c1, this.config.c2);
                        selCtx.restore();
                        if (s.mask) {
                            selCtx.save();
                            selCtx.globalCompositeOperation = 'destination-in';
                            selCtx.drawImage(s.mask, 0, 0, s.canvas.width, s.canvas.height);
                            selCtx.restore();
                        }
                        s._cache = null;
                        s._glTexDirty = true;
                        s._contentDirty = true;
                    } else {
                        this.ctx.save();
                        _gradientRender(this.ctx, _g, this.config.width, this.config.height, this.config.c1, this.config.c2);
                        this.ctx.restore();
                    }

                    this.saveState();
                }
                _g.active = false;
                _g.isPlacing = false;
                _g.draggingHandle = null;
                this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                // The live preview lived on ctxTemp and just got wiped above — repaint
                // the selection (now holding the applied gradient in s.canvas) so it
                // doesn't visually vanish until something else happens to redraw it.
                if (this.state.selection) this.renderSelection();
                this._gradientClearVectorSVG();
                this._gradientUpdateApplyCard(false);
                this.ui.stage.style.cursor = '';
                this.updateCursorForTool(this.config.tool);
            },

            // Discard the live gradient without committing
            gradientDiscard() {
                const _g = this.config.gradient;
                _g.active = false;
                _g.isPlacing = false;
                _g.draggingHandle = null;
                this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                this._gradientClearVectorSVG();
                this._gradientUpdateApplyCard(false);
                this.ui.stage.style.cursor = '';
                this.updateCursorForTool(this.config.tool);
            },

            // Enable/disable the Apply / Discard button card based on whether a gradient is active
            _gradientUpdateApplyCard(active) {
                const card = document.getElementById('grad-apply-card');
                if (card) {
                    card.style.opacity = active ? '1' : '0.4';
                    card.style.pointerEvents = active ? 'auto' : 'none';
                }
            },

            // Draw gradient vector (ant-line + cross handles) into the screen-space SVG overlay.
            // Everything is in screen pixels so handles and line are always exactly 1 px thick
            // regardless of zoom level.
            _gradientDrawVectorSVG() {
                const g   = this.config.gradient;
                const grp = this.ui.gradVectorOverlay;
                if (!grp) return;
                const z   = this.config.zoom || 1;
                const NS  = 'http://www.w3.org/2000/svg';

                const sx = g.startX * z,  sy = g.startY * z;
                const ex = g.endX   * z,  ey = g.endY   * z;

                // Cache SVG elements on the group — create once, mutate thereafter
                if (!grp._cached) {
                    const H_SIZE = 19, H_HALF = (H_SIZE - 1) / 2;
                    const M_SIZE = 6, M_HALF = (M_SIZE - 1) / 2;

                    const mkEl = (tag, attrs) => {
                        const el = document.createElementNS(NS, tag);
                        for (const k in attrs) el.setAttribute(k, attrs[k]);
                        return el;
                    };

                    grp._cached = {
                        h1:  mkEl('image', { href:'assets/GradientHandle.png', width:H_SIZE, height:H_SIZE, 'image-rendering':'pixelated' }),
                        h2:  mkEl('image', { href:'assets/GradientHandle.png', width:H_SIZE, height:H_SIZE, 'image-rendering':'pixelated' }),
                        lineB: mkEl('line', { stroke:'#000', 'stroke-width':3, 'stroke-linecap':'round', 'stroke-opacity':'0.35' }),
                        lineW: mkEl('line', { stroke:'#fff', 'stroke-width':1, 'stroke-linecap':'round' }),
                        mp:   mkEl('image', { href:'assets/handle.png', width:M_SIZE, height:M_SIZE, 'image-rendering':'pixelated', style:'cursor:ew-resize;' })
                    };
                    const c = grp._cached;
                    grp.append(c.h1, c.h2, c.lineB, c.lineW, c.mp);
                }

                const c = grp._cached;
                const H_HALF = 9, M_HALF = 2.5;

                // Update handle positions
                c.h1.setAttribute('x', Math.round(sx - H_HALF));
                c.h1.setAttribute('y', Math.round(sy - H_HALF));
                c.h2.setAttribute('x', Math.round(ex - H_HALF));
                c.h2.setAttribute('y', Math.round(ey - H_HALF));

                // Update line endpoints
                c.lineB.setAttribute('x1', sx); c.lineB.setAttribute('y1', sy);
                c.lineB.setAttribute('x2', ex); c.lineB.setAttribute('y2', ey);
                c.lineW.setAttribute('x1', sx); c.lineW.setAttribute('y1', sy);
                c.lineW.setAttribute('x2', ex); c.lineW.setAttribute('y2', ey);

                // Update midpoint handle
                const mp  = (g.midpoint != null) ? g.midpoint : 0.5;
                const mpx = sx + (ex - sx) * mp;
                const mpy = sy + (ey - sy) * mp;
                c.mp.setAttribute('x', Math.round(mpx - M_HALF));
                c.mp.setAttribute('y', Math.round(mpy - M_HALF));

                grp.style.display = '';
            },

            // Hide the gradient vector SVG overlay. Keeps cached elements alive.
            _gradientClearVectorSVG() {
                const grp = this.ui.gradVectorOverlay;
                if (!grp) return;
                grp.style.display = 'none';
            },

            // Clip the temp canvas gradient preview to the selection bounds.
            _clipGradientToSelection() {
                if (!this.state.selection) return;
                const s = this.state.selection;
                const ctx = this.ctxTemp;
                ctx.save();
                ctx.globalCompositeOperation = 'destination-in';
                if (s.mask) {
                    ctx.drawImage(s.mask, s.x, s.y, s.w, s.h);
                } else {
                    ctx.fillStyle = '#000';
                    ctx.fillRect(Math.floor(s.x), Math.floor(s.y), Math.ceil(s.w), Math.ceil(s.h));
                }
                ctx.restore();
            },

            _gsHexToU32(hex) {
                const r = parseInt(hex.slice(1, 3), 16);
                const g = parseInt(hex.slice(3, 5), 16);
                const b = parseInt(hex.slice(5, 7), 16);
                // Canvas ImageData is RGBA; viewed as Uint32 LE it is 0xAABBGGRR
                return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
            },

            // FIX #5: Manhattan distance on RGB channels for tolerance comparisons.
            _gsColorDist(a32, b32) {
                return Math.abs( (a32        & 0xff) - (b32        & 0xff))   // R
                     + Math.abs(((a32 >>  8) & 0xff) - ((b32 >>  8) & 0xff))  // G
                     + Math.abs(((a32 >> 16) & 0xff) - ((b32 >> 16) & 0xff)); // B
            },

            _gsColorMatch(a32, b32, tol) {
                return tol === 0 ? (a32 === b32) : (this._gsColorDist(a32, b32) <= tol * 3);
            },

            // ── Read UI params into a plain object ────────────────────────────────
            _gsReadParams() {
                const iv = (id, def) => Math.max(1, parseInt((document.getElementById(id) || {}).value || def, 10));
                const radius     = iv('stitch-radius',     2);
                const minMass    = iv('stitch-min-mass',   60);
                const iterations = iv('stitch-iterations', 1);
                const tolerance  = Math.max(0, parseInt((document.getElementById('stitch-tolerance') || {}).value || '0', 10));
                return { radius, minMass, iterations, tolerance, protectedU32: [] };
            },


            // ── Apply (commit to canvas + save undo state) ────────────────────────
            _gsCompute(p) {
                const w = this.config.width;
                const h = this.config.height;
                const imgData = this.ctx.getImageData(0, 0, w, h);
                let buf = imgData.data.buffer.slice(0);
                for (let i = 0; i < p.iterations; i++) {
                    buf = this._gsRunPass(buf, w, h, p.radius, p.minMass, p.tolerance, p.protectedU32);
                }
                return new ImageData(new Uint8ClampedArray(buf), w, h);
            },

            // ── Single algorithmic pass ───────────────────────────────────────────
            _gsRunPass(srcBuffer, w, h, radius, minMass, tolerance, protectedU32) {
                const total  = w * h;
                const src32  = new Uint32Array(srcBuffer);

                // ── Stage 1: Breadcrumb Clustering (radius-jump BFS) ──────────────
                // Use a pre-allocated Int32Array as a circular queue to avoid the
                // memory overhead of growing a JS Array for each BFS tree.
                const visited      = new Uint8Array(total);
                const pixelCluster = new Int32Array(total).fill(-1);
                const clusters     = [];
                const bfsQueue     = new Int32Array(total); // worst-case: whole canvas

                for (let startPx = 0; startPx < total; startPx++) {
                    if (visited[startPx]) continue;
                    const color = src32[startPx];
                    visited[startPx] = 1;

                    let qHead = 0, qTail = 0;
                    bfsQueue[qTail++] = startPx;
                    const pixels = [startPx];

                    while (qHead < qTail) {
                        const cur = bfsQueue[qHead++];
                        const cx  = cur % w;
                        const cy  = (cur / w) | 0;

                        // FIX: radius-jump BFS — scan the full (2r+1)² bounding box so
                        // same-color crumbs separated by a gap still join one cluster.
                        const x0 = Math.max(0,     cx - radius);
                        const x1 = Math.min(w - 1, cx + radius);
                        const y0 = Math.max(0,     cy - radius);
                        const y1 = Math.min(h - 1, cy + radius);

                        for (let ny = y0; ny <= y1; ny++) {
                            const rowBase = ny * w;
                            for (let nx = x0; nx <= x1; nx++) {
                                const ni = rowBase + nx;
                                if (visited[ni]) continue;
                                // FIX #5: use colour-match with tolerance so near-identical
                                // hues (e.g. slightly different anti-aliasing variants of
                                // the same base colour) cluster together correctly.
                                if (!this._gsColorMatch(src32[ni], color, tolerance)) continue;
                                visited[ni] = 1;
                                pixels.push(ni);
                                bfsQueue[qTail++] = ni;
                            }
                        }
                    }

                    const cIdx = clusters.length;
                    // FIX #5: store the representative colour as-is; protected matching
                    // with tolerance happens at the mothership-test stage.
                    clusters.push({ color, pixels, mass: pixels.length });
                    for (let k = 0; k < pixels.length; k++) pixelCluster[pixels[k]] = cIdx;
                }

                // ── Stage 2: Mothership / Orphan split ────────────────────────────
                const mothSet = new Uint8Array(clusters.length); // 1 = mothership
                const orphans = [];

                for (let ci = 0; ci < clusters.length; ci++) {
                    const cl = clusters[ci];
                    // FIX #1 (exposed minMass): use the user-controlled threshold.
                    // FIX #5: protected-color check respects tolerance.
                    let isProtected = false;
                    for (let pi = 0; pi < protectedU32.length; pi++) {
                        if (this._gsColorMatch(cl.color, protectedU32[pi], tolerance)) { isProtected = true; break; }
                    }
                    if (cl.mass >= minMass || isProtected) {
                        mothSet[ci] = 1;
                    } else {
                        orphans.push(ci);
                    }
                }

                // ── Stage 3: Canyon test — 8-connected perimeter ─────────────────
                // FIX #3: previously only N4 (4-connected) was checked. Orphans that
                // touch a second mothership only diagonally were incorrectly spared.
                // Now we use full 8-connectivity for the perimeter scan.
                const N8 = [-1, 1, -w, w, -w - 1, -w + 1, w - 1, w + 1];

                const condemned = new Uint8Array(clusters.length); // 1 = to be removed

                for (let oi = 0; oi < orphans.length; oi++) {
                    const ci = orphans[oi];
                    const pixels = clusters[ci].pixels;
                    // Collect distinct mothership colours touching this orphan.
                    // Two mothership colours are "different" only when their distance
                    // exceeds the tolerance (FIX #5: prevents false positives when two
                    // very similar large shapes touch the orphan).
                    const touchedColors = [];

                    outer:
                    for (let k = 0; k < pixels.length; k++) {
                        const px = pixels[k];
                        const cx = px % w;
                        const cy = (px / w) | 0;
                        for (let d = 0; d < 8; d++) {
                            const delta = N8[d];
                            const ni = px + delta;
                            if (ni < 0 || ni >= total) continue;
                            // Edge-wrap guard for horizontal deltas
                            if ((delta === -1 || delta === -w - 1 || delta ===  w - 1) && cx === 0)     continue;
                            if ((delta ===  1 || delta === -w + 1 || delta ===  w + 1) && cx === w - 1) continue;
                            const nci = pixelCluster[ni];
                            if (nci < 0 || !mothSet[nci]) continue;
                            const nc = src32[ni];
                            // Only count as a distinct contact if it's perceptually
                            // different from every mothership colour already recorded.
                            let alreadySeen = false;
                            for (let t = 0; t < touchedColors.length; t++) {
                                if (this._gsColorMatch(touchedColors[t], nc, Math.max(tolerance, 4))) {
                                    alreadySeen = true; break;
                                }
                            }
                            if (!alreadySeen) touchedColors.push(nc);
                            if (touchedColors.length >= 2) { condemned[ci] = 1; break outer; }
                        }
                    }
                }

                // ── Stage 4: Sweep — replace condemned pixels ─────────────────────
                const out32 = src32.slice(); // copy, don't mutate the source

                for (let oi = 0; oi < orphans.length; oi++) {
                    const ci = orphans[oi];
                    if (!condemned[ci]) continue;
                    const pixels = clusters[ci].pixels;

                    for (let k = 0; k < pixels.length; k++) {
                        const px = pixels[k];
                        const cx = px % w;
                        const cy = (px / w) | 0;

                        // Frequency-count the 8 surrounding mothership colours.
                        // Reading from src32 (original) prevents pass-internal cascade.
                        let bestColor = 0, bestCount = -1;
                        const freq = new Map();

                        for (let d = 0; d < 8; d++) {
                            const delta = N8[d];
                            const ni = px + delta;
                            if (ni < 0 || ni >= total) continue;
                            if ((delta === -1 || delta === -w - 1 || delta ===  w - 1) && cx === 0)     continue;
                            if ((delta ===  1 || delta === -w + 1 || delta ===  w + 1) && cx === w - 1) continue;
                            if ((delta === -w || delta === -w - 1 || delta === -w + 1) && cy === 0)     continue;
                            if ((delta ===  w || delta ===  w - 1 || delta ===  w + 1) && cy === h - 1) continue;
                            const nci = pixelCluster[ni];
                            if (nci < 0 || !mothSet[nci]) continue;
                            const nc = src32[ni];
                            const prev = (freq.get(nc) || 0) + 1;
                            freq.set(nc, prev);
                            if (prev > bestCount) { bestCount = prev; bestColor = nc; }
                        }

                        if (freq.size > 0) {
                            // Common case: at least one mothership neighbour in 8-ring.
                            out32[px] = bestColor;
                            continue;
                        }

                        // FIX #4: freq.size === 0 means this pixel is completely
                        // surrounded by other orphan/condemned pixels (e.g. the centre
                        // of a wide gap ribbon). Expand the search to the full BFS
                        // radius to find the nearest mothership colour.
                        const x0 = Math.max(0,     cx - radius);
                        const x1 = Math.min(w - 1, cx + radius);
                        const y0 = Math.max(0,     cy - radius);
                        const y1 = Math.min(h - 1, cy + radius);

                        for (let ny = y0; ny <= y1; ny++) {
                            const rowBase = ny * w;
                            for (let nx = x0; nx <= x1; nx++) {
                                const ni = rowBase + nx;
                                const nci = pixelCluster[ni];
                                if (nci < 0 || !mothSet[nci]) continue;
                                const nc = src32[ni];
                                const prev = (freq.get(nc) || 0) + 1;
                                freq.set(nc, prev);
                                if (prev > bestCount) { bestCount = prev; bestColor = nc; }
                            }
                        }

                        if (bestCount > -1) out32[px] = bestColor;
                        // If still nothing found, leave the pixel as-is — it's too
                        // isolated for us to make a safe decision.
                    }
                }

                return out32.buffer;
            }

    });
})();
