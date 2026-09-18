/* selection — moved verbatim off the PaintEngine class body.
 *
 * Assigned onto the prototype, so `this` is the same PaintEngine instance
 * these methods have always run against. Loads after paint-engine.js and
 * before boot.js, which is where the instance is finally created.
 */
(function () {
    Object.assign(PaintEngine.prototype, {
            requestSelectionRenderFast() {
                if (this._selectionRenderRaf) return;
                this._selectionRenderRaf = requestAnimationFrame(() => {
                    this._selectionRenderRaf = null;
                    if (!this.state.selection) return;
                    this.renderSelectionFast();
                });
            },

            shouldUseCanvasMaskAnts() {
                // Canvas-based marching ants are disabled. The SVG overlay path (svgAntsPath)
                // is used instead because it preserves the original visual appearance exactly
                // and composes correctly with transparent selections.
                return false;
            },

            refreshSelectionUiFromState() {
                if (!this.ui || !this.ui.selControls) return;
                if (this.state.selection) {
                    this.updateSelectionUI(
                        this.state.selection.x,
                        this.state.selection.y,
                        this.state.selection.w,
                        this.state.selection.h,
                        this.getSelectionRotationDegrees(this.state.selection)
                    );
                    return;
                }
                if (this.state.shapeEditMode && this.state.activeShape) {
                    const b = this.getActiveShapeBounds(this.state.activeShape);
                    this.updateSelectionUI(b.x, b.y, b.w, b.h, 0);
                }
            },
            buildEdgeTransparencyMask(imgData, w, h, bg, tol) {
                const visited = new Uint8Array(w * h);
                const mask = new Uint8Array(w * h);
                const data = imgData.data;
                const match = (idx) =>
                    Math.abs(data[idx] - bg.r) <= tol &&
                    Math.abs(data[idx + 1] - bg.g) <= tol &&
                    Math.abs(data[idx + 2] - bg.b) <= tol;
                const stack = [];
                for (let x = 0; x < w; x++) {
                    stack.push({ x, y: 0 });
                    stack.push({ x, y: h - 1 });
                }
                for (let y = 1; y < h - 1; y++) {
                    stack.push({ x: 0, y });
                    stack.push({ x: w - 1, y });
                }
                while (stack.length) {
                    const { x, y } = stack.pop();
                    if (x < 0 || y < 0 || x >= w || y >= h) continue;
                    const i = y * w + x;
                    if (visited[i]) continue;
                    const idx = i * 4;
                    if (!match(idx)) continue;
                    visited[i] = 1;
                    mask[i] = 1;
                    stack.push({ x: x + 1, y });
                    stack.push({ x: x - 1, y });
                    stack.push({ x, y: y + 1 });
                    stack.push({ x, y: y - 1 });
                }
                return mask;
            },
            buildTransparencyKeyMask(imgData, w, h, bg, tol, mode) {
                if (!imgData || !bg) return null;
                if (mode === 'all') {
                    const d = imgData.data;
                    const mask = new Uint8Array(w * h);
                    let mi = 0;
                    for (let i = 0; i < d.length; i += 4) {
                        if (Math.abs(d[i] - bg.r) <= tol &&
                            Math.abs(d[i + 1] - bg.g) <= tol &&
                            Math.abs(d[i + 2] - bg.b) <= tol) {
                            mask[mi] = 1;
                        }
                        mi++;
                    }
                    return mask;
                }
                return this.buildEdgeTransparencyMask(imgData, w, h, bg, tol);
            },
            applyTransparencyMaskToCanvas(ctx, w, h, mask) {
                if (!ctx || !mask) return;
                const img = ctx.getImageData(0, 0, w, h);
                const d = img.data;
                for (let i = 0; i < mask.length; i++) {
                    if (mask[i]) d[i * 4 + 3] = 0;
                }
                ctx.putImageData(img, 0, 0);
            },
            finalizePastedSelection(canvas) {
                const cCtx = this.get2dContext(canvas);
                const pos = this.getPasteOrigin(canvas.width, canvas.height);
                this.state.selection = {
                    x: pos.x, y: pos.y, w: canvas.width, h: canvas.height, rotation: 0,
                    canvas: canvas,
                    originalX: pos.x, originalY: pos.y,
                    palette: null,
                    _glTex: null,
                    _glTexDirty: true
                };
                if (this.getDepthConfig().mode === 'indexed' && this.palette && this.palette.length) {
                    this.state.selection.palette = this.palette;
                }
                this.state.selectionOriginalPos = null;
                this.renderSelection();
                this.deferSelectionPalette(cCtx, canvas.width, canvas.height, this.state.selection);
            },
            getSelectionCenter(selection = this.state.selection) {
                if (!selection) return { x: 0, y: 0 };
                const nr = this.getNormalizedRect(selection);
                return {
                    x: nr.x + (nr.w / 2),
                    y: nr.y + (nr.h / 2)
                };
            },
            // Returns the axis-aligned bounding box (AABB) of the selection after rotation.
            // Use this for overlay positioning and hit-testing — s.x/s.y/s.w/s.h are the
            // un-rotated logical rect and will be wrong once the selection has been rotated.
            getSelectionAABB(selection = this.state.selection) {
                if (!selection) return { x: 0, y: 0, w: 0, h: 0 };
                const rot = this.getSelectionRotationDegrees(selection);
                const nr = this.getNormalizedRect(selection);
                if (Math.abs(rot) <= 0.01) return nr;
                const cx = nr.x + nr.w / 2;
                const cy = nr.y + nr.h / 2;
                const corners = [
                    { x: nr.x,        y: nr.y },
                    { x: nr.x + nr.w, y: nr.y },
                    { x: nr.x + nr.w, y: nr.y + nr.h },
                    { x: nr.x,        y: nr.y + nr.h }
                ].map(pt => this.rotatePoint(pt, { x: cx, y: cy }, rot));
                let minX = corners[0].x, maxX = corners[0].x, minY = corners[0].y, maxY = corners[0].y;
                for (let i = 1; i < corners.length; i++) {
                    minX = Math.min(minX, corners[i].x); maxX = Math.max(maxX, corners[i].x);
                    minY = Math.min(minY, corners[i].y); maxY = Math.max(maxY, corners[i].y);
                }
                return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
            },
            getSelectionRotationDegrees(selection = this.state.selection) {
                if (!selection) return 0;
                return this.normalizeAngleDegrees(selection.rotation || 0);
            },
            getSelectionDisplayRect(selection = this.state.selection) {
                if (!selection) return { x: 0, y: 0, w: 0, h: 0 };
                return this.getNormalizedRect(selection);
            },
            getSelectionDrawMetrics(selection = this.state.selection, renderCanvas = null, noSnap = false) {
                if (!selection) return null;
                const display = this.getSelectionDisplayRect(selection);
                const rotation = this.getSelectionRotationDegrees(selection);
                const renderC = renderCanvas || this.getRenderedSelectionCanvas();
                let destX = display.x;
                let destY = display.y;
                let drawW = display.w;
                let drawH = display.h;
                if (Math.abs(rotation) > 0.01 && renderC) {
                    const center = this.getSelectionCenter(selection);
                    drawW = renderC.width;
                    drawH = renderC.height;
                    destX = Math.round(center.x - (drawW / 2));
                    destY = Math.round(center.y - (drawH / 2));
                }
                const z = this.config.zoom || 1;
                if (z < 1 && Math.abs(rotation) <= 0.01 && !noSnap) {
                    const snapToScreen = (v) => Math.round(v * z) / z;
                    destX = snapToScreen(destX);
                    destY = snapToScreen(destY);
                    drawW = snapToScreen(drawW);
                    drawH = snapToScreen(drawH);
                }
                return { display, rotation, renderC, destX, destY, drawW, drawH };
            },
            getSelectionCutPreviewRect(selection = this.state.selection, pad = 3) {
                if (!selection || !selection._deferredCut || !selection._cutRect) return null;
                const r = selection._cutRect;
                return {
                    x: Math.floor(r.x - pad),
                    y: Math.floor(r.y - pad),
                    w: Math.ceil(r.w + (pad * 2)),
                    h: Math.ceil(r.h + (pad * 2))
                };
            },
            drawSelectionDeferredCutPreview(selection = this.state.selection) {
                if (!selection || !selection._deferredCut || !selection._cutRect) return;
                const r = selection._cutRect;
                const activeLayer = this.layerMgr && this.layerMgr.active && this.layerMgr.layers[this.layerMgr.activeIdx];
                const isTransparentLayer = activeLayer && activeLayer.alpha !== false;
                this.ctxTemp.save();
                if (isTransparentLayer) {
                    // On transparent layers ctxTemp is composited on top of the layer canvas,
                    // so clearing ctxTemp only punches a hole in the overlay — the underlying
                    // layer pixels are still visible, causing a "ghost" of the cut region
                    // to show while the selection is being dragged.
                    //
                    // Fix: erase the cut region directly from the layer canvas for the
                    // duration of the drag. The original pixels are saved in _cutSavedData
                    // so cancelSelection() can restore them exactly if the user cancels.
                    const ctx = activeLayer.ctx;
                    const rx = Math.floor(r.x), ry = Math.floor(r.y);
                    const rw = Math.floor(r.w), rh = Math.floor(r.h);
                    if (!selection._cutSavedData) {
                        selection._cutSavedData = ctx.getImageData(rx, ry, rw, rh);
                        selection._cutSavedRect = { x: rx, y: ry, w: rw, h: rh };
                        ctx.clearRect(rx, ry, rw, rh);
                    }
                    this.ctxTemp.clearRect(rx, ry, rw, rh);
                } else {
                    this.ctxTemp.fillStyle = this.config.c2;
                    this.ctxTemp.fillRect(Math.floor(r.x), Math.floor(r.y), Math.floor(r.w), Math.floor(r.h));
                }
                this.ctxTemp.restore();
            },
            selectionChangedFromBase(selection = this.state.selection) {
                if (!selection || !selection._baseRect) return true;
                const base = selection._baseRect;
                return (
                    Math.floor(selection.x) !== Math.floor(base.x) ||
                    Math.floor(selection.y) !== Math.floor(base.y) ||
                    Math.floor(selection.w) !== Math.floor(base.w) ||
                    Math.floor(selection.h) !== Math.floor(base.h) ||
                    Math.abs(this.getSelectionRotationDegrees(selection) - (base.rotation || 0)) > 0.01
                );
            },
            pointInSelection(x, y, selection = this.state.selection) {
                if (!selection) return false;
                const nr = this.getSelectionDisplayRect(selection);
                const rotation = this.getSelectionRotationDegrees(selection);
                if (Math.abs(rotation) <= 0.01) {
                    return x >= nr.x && x <= nr.x + nr.w && y >= nr.y && y <= nr.y + nr.h;
                }
                const center = this.getSelectionCenter(selection);
                const rad = -rotation * Math.PI / 180;
                const dx = x - center.x;
                const dy = y - center.y;
                const rx = (dx * Math.cos(rad)) - (dy * Math.sin(rad));
                const ry = (dx * Math.sin(rad)) + (dy * Math.cos(rad));
                return Math.abs(rx) <= (nr.w / 2) && Math.abs(ry) <= (nr.h / 2);
            },
            applySelectionRotation(angleDeg, options = {}) {
                const selection = this.state.selection;
                if (!selection) return;
                const session = options.session || null;
                selection.rotation = this.normalizeAngleDegrees(angleDeg);
                selection._cache = null;
                if (session) {
                    session.angle = selection.rotation;
                }
                this.requestSelectionRenderFast();
            },
            beginSelectionRotation(pointer, event) {
                if (!this.state.selection) return;
                const center = this.getSelectionCenter(this.state.selection);
                const baseRotation = this.getSelectionRotationDegrees(this.state.selection);
                const pointerAngle = this.getAngleDegrees(center, pointer);
                this.state.isDrawing = false;
                this.state.isMovingSel = false;
                this.state.dragHandle = null;
                this.state.isRotatingSel = true;
                this.state.selectionRotateSession = {
                    center,
                    lastPointerAngle: pointerAngle,
                    accumulatedDelta: 0,
                    baseRotation,
                    angle: 0,
                    baseSelection: {
                        x: this.state.selection.x,
                        y: this.state.selection.y,
                        w: this.state.selection.w,
                        h: this.state.selection.h
                    },
                    sourceCanvas: this.cloneCanvas(this.state.selection.canvas),
                    sourceMask: this.cloneCanvas(this.state.selection.mask)
                };
                if (event) {
                    event.preventDefault();
                    event.stopPropagation();
                }
                // Render immediately so the first mousemove frame isn't dropped by the rAF guard.
                this.renderSelectionFast();
            },
            updateSelectionRotation(pointer, event) {
                const session = this.state.selectionRotateSession;
                if (!this.state.selection || !session) return;
                const currentAngle = this.getAngleDegrees(session.center, pointer);
                const rawStep = this.getSignedAngleDelta(session.lastPointerAngle, currentAngle);
                session.lastPointerAngle = currentAngle;

                // 1:1 angular tracking — Alt key enables fine/slow mode.
                const step = rawStep * (event && event.altKey ? 0.2 : 1);

                session.accumulatedDelta += step;
                let delta = session.accumulatedDelta;

                let angle = (session.baseRotation || 0) + delta;
                // Ctrl snaps to the nearest 45° world-axis increment (0°, 45°, 90°, …).
                // Shift snaps to 15° increments. Neither is relative to the drag-start angle.
                if (event && event.ctrlKey) angle = Math.round(angle / 45) * 45;
                else if (event && event.shiftKey) angle = Math.round(angle / 15) * 15;
                this.applySelectionRotation(angle, { session });
                this.updateHoverPreview(Math.round(pointer.x), Math.round(pointer.y));
            },
            endSelectionRotation() {
                if (!this.state.isRotatingSel) return;
                this.state.isRotatingSel = false;
                this.state.selectionRotateSession = null;
                // Suppress the click event that fires immediately after the rotate drag mouseup.
                // Without this guard the selection would commit or deselect the moment the
                // user releases the mouse after finishing a rotation.
                this.state.selectionIgnoreNextClick = true;
                this.state.selectionIgnoreClickUntil = Date.now() + 1000;
                if (!this.state.selection) return;
                this.renderSelection();
                this.deferSelectionRenderFinalize(this.state.selection);
                this.deferColorCounts();
            },

            createSelection(x, y, w, h) {
                if(w < 0) { x += w; w = Math.abs(w); }
                if(h < 0) { y += h; h = Math.abs(h); }
                x = Math.floor(x); y = Math.floor(y); w = Math.floor(w); h = Math.floor(h);
                if(w === 0 || h === 0) return;

                const data = this.ctx.getImageData(x, y, w, h);
                const selC = document.createElement('canvas'); selC.width = w; selC.height = h;
                const selCtx = selC.getContext('2d', { willReadFrequently: true });
                this.disableSmoothing(selCtx);
                selCtx.putImageData(data, 0, 0);

                // Keep selection creation non-destructive to redo history; cut is deferred until commit/delete.
                this.state.selectionCutStep = null;
                this.state.selection = {
                    x, y, w, h, rotation: 0, canvas: selC, originalX: x, originalY: y, palette: null,
                    _deferredCut: true, _cutRect: { x, y, w, h }, _baseRect: { x, y, w, h, rotation: 0 },
                    _glTex: null, _glTexDirty: true
                };
                this.state.selectionOriginalPos = { x: x, y: y, w: w, h: h, rotation: 0 };
                // Defer palette extraction off the critical path to avoid blocking the main thread
                // on large canvases (extractPalette is O(pixels)).
                this.deferSelectionPalette(selCtx, w, h, this.state.selection);
                this.renderSelection();
            },

            getRenderedSelectionCanvas() {
                const s = this.state.selection;
                if (!s) return null;
                let dw = Math.floor(s.w);
                let dh = Math.floor(s.h);
                const rotation = this.getSelectionRotationDegrees(s);

                // Cache check to improve performance during moves
                const _cacheLayerKey = (this.layerMgr && this.layerMgr.active) ? this.layerMgr.activeIdx : -1;
                const cacheKey = `${dw},${dh},${rotation},${_cacheLayerKey},${this.config.transparentSelection},${this.config.c2},${this.config.transTol},${this.config.transMode},${this.config.transColor ? `${this.config.transColor.r},${this.config.transColor.g},${this.config.transColor.b}` : 'none'},${s._forceOpaque ? 1 : 0}`;
                if (s._cache && s._cache.key === cacheKey) {
                    return s._cache.canvas;
                }

                let renderC;
                if (Math.abs(rotation) > 0.01) {
                    // If the selection has been resized (s.w/s.h differ from s.canvas dimensions),
                    // scale the pixel canvas to the current display size first so the rotation
                    // renders the resized content rather than snapping back to the original size.
                    let sourceForRotation = s.canvas;
                    const targetW = Math.abs(dw);
                    const targetH = Math.abs(dh);
                    if (targetW > 0 && targetH > 0 &&
                        (s.canvas.width !== targetW || s.canvas.height !== targetH)) {
                        const scaled = document.createElement('canvas');
                        scaled.width  = targetW;
                        scaled.height = targetH;
                        const sctx = scaled.getContext('2d');
                        this.disableSmoothing(sctx);
                        sctx.save();
                        sctx.scale(dw < 0 ? -1 : 1, dh < 0 ? -1 : 1);
                        sctx.translate(dw < 0 ? -targetW : 0, dh < 0 ? -targetH : 0);
                        sctx.drawImage(s.canvas, 0, 0, targetW, targetH);
                        sctx.restore();
                        sourceForRotation = scaled;
                    }
                    renderC = this.renderCleanEdgeRotation(sourceForRotation, rotation, {
                        slope: true,
                        lineWidth: 1,
                        similarThreshold: 0,
                        highestColor: [1, 1, 1]
                    });
                } else {
                    const targetW = Math.abs(dw);
                    const targetH = Math.abs(dh);
                    const srcW = s.canvas.width;
                    const srcH = s.canvas.height;
                    renderC = document.createElement('canvas');
                    renderC.width = targetW;
                    renderC.height = targetH;
                    const renderCtx = renderC.getContext('2d');
                    this.disableSmoothing(renderCtx);
                    // Always use manual nearest-neighbor pixel copy via ImageData so the
                    // browser never gets a chance to interpolate, regardless of scale direction.
                    const srcCtx = s.canvas.getContext('2d');
                    const srcData = srcCtx.getImageData(0, 0, srcW, srcH).data;
                    const dstData = new Uint8ClampedArray(targetW * targetH * 4);
                    const flipX = dw < 0;
                    const flipY = dh < 0;
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
                    renderCtx.putImageData(new ImageData(dstData, targetW, targetH), 0, 0);
                }
                const renderCtx = renderC.getContext('2d');
                this.disableSmoothing(renderCtx);

                const depthMode = this.getDepthConfig().mode;
                const shouldEnforcePalette = depthMode === 'indexed' || s._needsPaletteEnforce;
                if (!s._disablePalette && shouldEnforcePalette && s.palette && s.palette.list && s.palette.list.length <= 256) {
                    this.enforcePalette(renderCtx, renderC.width, renderC.height, s.palette);
                }

                if(this.config.transparentSelection && !s._forceOpaque) {
                    const imgData = renderCtx.getImageData(0, 0, renderC.width, renderC.height);
                    const tol = this.config.transTol ?? 12;
                    let bg = null;
                    if (this.config.transColor) bg = this.config.transColor;
                    else if (this.config.transMode === 'c2') bg = this.hexToRgb(this.config.c2);
                    else bg = this.sampleBorderColorFromImageData(imgData, renderC.width, renderC.height) || this.hexToRgb(this.config.c2);
                    if (bg) {
                        const mode = this.config.transMode === 'edge' ? 'edge' : 'all';
                        if (mode === 'all') {
                            const d = imgData.data;
                            for (let i = 0; i < d.length; i += 4) {
                                if (Math.abs(d[i] - bg.r) <= tol &&
                                    Math.abs(d[i+1] - bg.g) <= tol &&
                                    Math.abs(d[i+2] - bg.b) <= tol) {
                                    d[i+3] = 0;
                                }
                            }
                        } else {
                            const mask = this.buildEdgeTransparencyMask(imgData, renderC.width, renderC.height, bg, tol);
                            const d = imgData.data;
                            for (let i = 0; i < mask.length; i++) {
                                if (mask[i]) d[i*4 + 3] = 0;
                            }
                        }
                        renderCtx.putImageData(imgData, 0, 0);
                    }
                }

                s._cache = { key: cacheKey, canvas: renderC };
                return renderC;
            },

            _freeSelectionGlTex(s) {
                if (s && s._glTex && this.gl) {
                    try { this.gl.deleteTexture(s._glTex); } catch (_) {}
                    s._glTex = null;
                }
            },

            renderSelection() {
                if(!this.state.selection) {
                    this.state.isRotatingSel = false;
                    this.state.selectionRotateSession = null;
                    this.resetSelectionTempDirty();
                    this.stopOutlineAnimation();
                    this.ui.selControls.style.display = 'none';
                    this.clearStatusSelectionSize();
                    this.requestGlobalOverlayUpdate();
                    return;
                }
                const s = this.state.selection;

                this.disableSmoothing(this.ctxTemp);
                const renderC = this.getRenderedSelectionCanvas();
                const metrics = this.getSelectionDrawMetrics(s, renderC);

                if (s.mask && this.shouldUseCanvasMaskAnts()) this.startOutlineAnimation();
                else this.stopOutlineAnimation();

                const clearRect = this.unionRects(
                    this.getSelectionTempDrawRect(metrics.destX, metrics.destY, metrics.drawW, metrics.drawH),
                    this.getSelectionCutPreviewRect(s)
                );
                this.clearSelectionTempDirty(clearRect);

                this.drawSelectionDeferredCutPreview(s);
                this.ctxTemp.drawImage(renderC, metrics.destX, metrics.destY);
                if (s.mask && Math.abs(metrics.rotation) <= 0.01) {
                    const dw = Math.floor(s.w);
                    const dh = Math.floor(s.h);
                    const destX = dw < 0 ? Math.floor(s.x) + dw : Math.floor(s.x);
                    const destY = dh < 0 ? Math.floor(s.y) + dh : Math.floor(s.y);
                    this.ctxTemp.save();
                    this.ctxTemp.globalCompositeOperation = 'destination-in';
                    this.ctxTemp.translate(destX, destY);
                    this.ctxTemp.scale(dw < 0 ? -1 : 1, dh < 0 ? -1 : 1);
                    this.ctxTemp.drawImage(s.mask, 0, 0, Math.abs(dw), Math.abs(dh));
                    this.ctxTemp.restore();
                    if (this.shouldUseCanvasMaskAnts()) {
                        this.drawSelectionOutline(s, destX, destY, dw, dh);
                    }
                }

                this.updateSelectionUI(s.x, s.y, s.w, s.h, metrics.rotation);
            },
            renderSelectionFast() {
                if(!this.state.selection) return;
                const s = this.state.selection;
                const needsTransparentPreview = this.config.transparentSelection && !s._forceOpaque;
                if (s.mask || needsTransparentPreview || Math.abs(this.getSelectionRotationDegrees(s)) > 0.01) {
                    this.renderSelectionFastCanvas();
                    return;
                }
                // During a resize drag, always use the canvas path. Drawing a WebGL canvas
                // into a 2D canvas via drawImage goes through the browser compositor and can
                // introduce antialiasing when downscaling, regardless of imageSmoothingEnabled.
                if (this.state.dragHandle) {
                    this.renderSelectionFastCanvas();
                    return;
                }
                if(!this.gl || !this.glCanvas) {
                    this.renderSelectionFastCanvas();
                    return;
                }
                this.disableSmoothing(this.ctxTemp);

                let dx = Math.floor(s.x);
                let dy = Math.floor(s.y);
                let dw = Math.floor(s.w);
                let dh = Math.floor(s.h);

                let destX = dw < 0 ? dx + dw : dx;
                let destY = dh < 0 ? dy + dh : dy;
                const clearRect = this.unionRects(
                    this.getSelectionTempDrawRect(destX, destY, dw, dh),
                    this.getSelectionCutPreviewRect(s)
                );
                this.clearSelectionTempDirty(clearRect);
                const aw = Math.max(1, Math.abs(dw));
                const ah = Math.max(1, Math.abs(dh));

                const gl = this.gl;
                gl.useProgram(this.glProgram);
                if (this.glCanvas.width !== aw || this.glCanvas.height !== ah) {
                    this.glCanvas.width = aw;
                    this.glCanvas.height = ah;
                    gl.viewport(0, 0, aw, ah);
                }

                if (!s._glTex) {
                    s._glTex = gl.createTexture();
                    s._glTexDirty = true;
                }
                gl.bindTexture(gl.TEXTURE_2D, s._glTex);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                if (s._glTexDirty) {
                    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, s.canvas);
                    s._glTexDirty = false;
                }

                const u0 = dw < 0 ? 1 : 0;
                const u1 = dw < 0 ? 0 : 1;
                const v0 = dh < 0 ? 1 : 0;
                const v1 = dh < 0 ? 0 : 1;
                // Reuse a pre-allocated 8-element buffer rather than allocating a new
                // Float32Array on every animation frame.
                if (!this._selTexCoordBuf) this._selTexCoordBuf = new Float32Array(8);
                const tc = this._selTexCoordBuf;
                tc[0] = u0; tc[1] = v0;
                tc[2] = u1; tc[3] = v0;
                tc[4] = u0; tc[5] = v1;
                tc[6] = u1; tc[7] = v1;
                gl.bindBuffer(gl.ARRAY_BUFFER, this.glBuffers.texBuf);
                gl.bufferData(gl.ARRAY_BUFFER, tc, gl.DYNAMIC_DRAW);
                gl.clearColor(0,0,0,0);
                gl.clear(gl.COLOR_BUFFER_BIT);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

                this.drawSelectionDeferredCutPreview(s);
                this.ctxTemp.drawImage(this.glCanvas, destX, destY);
                this.updateSelectionUI(s.x, s.y, s.w, s.h, this.getSelectionRotationDegrees(s));
            },
            renderSelectionFastCanvas() {
                const s = this.state.selection;
                this.disableSmoothing(this.ctxTemp);
                const renderC = this.getRenderedSelectionCanvas();
                const metrics = this.getSelectionDrawMetrics(s, renderC);

                if (s.mask && this.shouldUseCanvasMaskAnts()) this.startOutlineAnimation();
                else this.stopOutlineAnimation();

                const clearRect = this.unionRects(
                    this.getSelectionTempDrawRect(metrics.destX, metrics.destY, metrics.drawW, metrics.drawH),
                    this.getSelectionCutPreviewRect(s)
                );
                this.clearSelectionTempDirty(clearRect);
                this.drawSelectionDeferredCutPreview(s);
                // Disable smoothing immediately before the draw to guarantee nearest-neighbor
                // interpolation regardless of any prior save/restore that could have reset it.
                this.disableSmoothing(this.ctxTemp);
                this.ctxTemp.drawImage(renderC, metrics.destX, metrics.destY);
                if (s.mask && Math.abs(metrics.rotation) <= 0.01) {
                    const dw = Math.floor(s.w);
                    const dh = Math.floor(s.h);
                    const destX = dw < 0 ? Math.floor(s.x) + dw : Math.floor(s.x);
                    const destY = dh < 0 ? Math.floor(s.y) + dh : Math.floor(s.y);
                    this.ctxTemp.save();
                    this.ctxTemp.globalCompositeOperation = 'destination-in';
                    this.ctxTemp.translate(destX, destY);
                    this.ctxTemp.scale(dw < 0 ? -1 : 1, dh < 0 ? -1 : 1);
                    this.ctxTemp.drawImage(s.mask, 0, 0, Math.abs(dw), Math.abs(dh));
                    this.ctxTemp.restore();
                    if (this.shouldUseCanvasMaskAnts()) {
                        this.drawSelectionOutline(s, destX, destY, dw, dh);
                    }
                }
                this.updateSelectionUI(s.x, s.y, s.w, s.h, metrics.rotation);
            },
            getSelectionTempDrawRect(destX, destY, dw, dh, pad = 3) {
                const aw = Math.max(1, Math.abs(dw));
                const ah = Math.max(1, Math.abs(dh));
                return {
                    x: Math.floor(destX - pad),
                    y: Math.floor(destY - pad),
                    w: Math.ceil(aw + (pad * 2)),
                    h: Math.ceil(ah + (pad * 2))
                };
            },
            clearSelectionTempDirty(nextRect) {
                const toClear = this.unionRects(this.state.tempSelectionDrawRect, nextRect);
                this.state.tempSelectionDrawRect = nextRect ? { ...nextRect } : null;
                if (!toClear || toClear.w <= 0 || toClear.h <= 0) return;
                const x = Math.max(0, toClear.x);
                const y = Math.max(0, toClear.y);
                const x2 = Math.min(this.config.width, toClear.x + toClear.w);
                const y2 = Math.min(this.config.height, toClear.y + toClear.h);
                const w = x2 - x;
                const h = y2 - y;
                if (w <= 0 || h <= 0) return;
                this.ctxTemp.clearRect(x, y, w, h);
            },
            resetSelectionTempDirty() {
                this.state.tempSelectionDrawRect = null;
            },
            ensureSelectionOutline(s) {
                if (!s.mask || s._maskOutline) return;
                const mw = s.mask.width;
                const mh = s.mask.height;
                const outline = document.createElement('canvas');
                outline.width = mw;
                outline.height = mh;
                const octx = outline.getContext('2d');
                const mctx = s.mask.getContext('2d');
                const img = mctx.getImageData(0, 0, mw, mh).data;
                const out = octx.createImageData(mw, mh);
                const od = out.data;
                const idx = (x, y) => (y * mw + x) * 4;
                for (let y = 0; y < mh; y++) {
                    for (let x = 0; x < mw; x++) {
                        const i = idx(x, y);
                        if (img[i + 3] === 0) continue;
                        const left = x === 0 ? 0 : img[idx(x - 1, y) + 3];
                        const right = x === mw - 1 ? 0 : img[idx(x + 1, y) + 3];
                        const up = y === 0 ? 0 : img[idx(x, y - 1) + 3];
                        const down = y === mh - 1 ? 0 : img[idx(x, y + 1) + 3];
                        if (left === 0 || right === 0 || up === 0 || down === 0) {
                            od[i] = 255; od[i + 1] = 255; od[i + 2] = 255; od[i + 3] = 255;
                        }
                    }
                }
                octx.putImageData(out, 0, 0);
                s._maskOutline = outline;
                const outlineData = this.buildMaskOutlineData(s.mask);
                s._maskOutlinePath = outlineData.path;
                s._maskOutlineData = outlineData;
                s._maskVisiblePathCacheKey = '';
                s._maskVisiblePathCacheValue = '';
            },
            buildMaskOutlineData(mask) {
                if (!mask) {
                    return {
                        path: '',
                        width: 0,
                        height: 0,
                        tileSize: 32,
                        bins: new Map(),
                        segments: []
                    };
                }
                const mw = mask.width;
                const mh = mask.height;
                const mctx = mask.getContext('2d', { willReadFrequently: true });
                const img = mctx.getImageData(0, 0, mw, mh).data;
                const edges = [];
                const idx = (x, y) => (y * mw + x) * 4;
                const addEdge = (x1, y1, x2, y2) => {
                    edges.push({ a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, used: false });
                };
                for (let y = 0; y < mh; y++) {
                    for (let x = 0; x < mw; x++) {
                        if (img[idx(x, y) + 3] === 0) continue;
                        const top = y === 0 ? 0 : img[idx(x, y - 1) + 3];
                        const right = x === mw - 1 ? 0 : img[idx(x + 1, y) + 3];
                        const bottom = y === mh - 1 ? 0 : img[idx(x, y + 1) + 3];
                        const left = x === 0 ? 0 : img[idx(x - 1, y) + 3];
                        const x0 = x, x1 = x + 1, y0 = y, y1 = y + 1;
                        if (top === 0) addEdge(x0, y0, x1, y0);
                        if (right === 0) addEdge(x1, y0, x1, y1);
                        if (bottom === 0) addEdge(x1, y1, x0, y1);
                        if (left === 0) addEdge(x0, y1, x0, y0);
                    }
                }
                if (!edges.length) {
                    return {
                        path: '',
                        width: mw,
                        height: mh,
                        tileSize: 32,
                        bins: new Map(),
                        segments: []
                    };
                }
                const key = (p) => `${p.x},${p.y}`;
                const adj = new Map();
                for (let i = 0; i < edges.length; i++) {
                    const e = edges[i];
                    const ka = key(e.a);
                    const kb = key(e.b);
                    if (!adj.has(ka)) adj.set(ka, []);
                    if (!adj.has(kb)) adj.set(kb, []);
                    adj.get(ka).push(i);
                    adj.get(kb).push(i);
                }
                const paths = [];
                const segments = [];
                for (let i = 0; i < edges.length; i++) {
                    if (edges[i].used) continue;
                    const startEdge = edges[i];
                    startEdge.used = true;
                    const start = startEdge.a;
                    const startKey = key(start);
                    let prevKey = startKey;
                    let curr = startEdge.b;
                    let currKey = key(curr);
                    const points = [start, curr];
                    while (currKey !== startKey) {
                        const neighbors = adj.get(currKey) || [];
                        let nextEdgeIndex = -1;
                        let nextPoint = null;
                        for (const idxEdge of neighbors) {
                            const e = edges[idxEdge];
                            if (e.used) continue;
                            const other = key(e.a) === currKey ? e.b : e.a;
                            const otherKey = key(other);
                            if (otherKey === prevKey) continue;
                            nextEdgeIndex = idxEdge;
                            nextPoint = other;
                            break;
                        }
                        if (nextEdgeIndex === -1) {
                            for (const idxEdge of neighbors) {
                                const e = edges[idxEdge];
                                if (e.used) continue;
                                nextEdgeIndex = idxEdge;
                                nextPoint = key(e.a) === currKey ? e.b : e.a;
                                break;
                            }
                        }
                        if (nextEdgeIndex === -1) break;
                        edges[nextEdgeIndex].used = true;
                        prevKey = currKey;
                        curr = nextPoint;
                        currKey = key(curr);
                        points.push(curr);
                    }
                    const isClosed = points.length > 2 && currKey === startKey;
                    const simplified = this.simplifyAxisAlignedPath(points, isClosed);
                    if (!simplified.length) continue;
                    if (!isClosed && simplified.length < 2) continue;

                    const pushSegment = (a, b) => {
                        const x1 = a.x;
                        const y1 = a.y;
                        const x2 = b.x;
                        const y2 = b.y;
                        if (x1 === x2 && y1 === y2) return;
                        segments.push({
                            x1, y1, x2, y2,
                            minX: Math.min(x1, x2),
                            minY: Math.min(y1, y2),
                            maxX: Math.max(x1, x2),
                            maxY: Math.max(y1, y2)
                        });
                    };
                    for (let j = 1; j < simplified.length; j++) {
                        pushSegment(simplified[j - 1], simplified[j]);
                    }
                    if (isClosed) {
                        pushSegment(simplified[simplified.length - 1], simplified[0]);
                    }

                    let d = `M${simplified[0].x} ${simplified[0].y}`;
                    for (let j = 1; j < simplified.length; j++) {
                        d += `L${simplified[j].x} ${simplified[j].y}`;
                    }
                    if (isClosed) d += 'Z';
                    paths.push(d);
                }
                const tileSize = 32;
                const bins = new Map();
                for (let i = 0; i < segments.length; i++) {
                    const s = segments[i];
                    const tx0 = Math.floor(s.minX / tileSize);
                    const ty0 = Math.floor(s.minY / tileSize);
                    const tx1 = Math.floor(s.maxX / tileSize);
                    const ty1 = Math.floor(s.maxY / tileSize);
                    for (let ty = ty0; ty <= ty1; ty++) {
                        for (let tx = tx0; tx <= tx1; tx++) {
                            const k = `${tx},${ty}`;
                            let list = bins.get(k);
                            if (!list) {
                                list = [];
                                bins.set(k, list);
                            }
                            list.push(i);
                        }
                    }
                }
                return {
                    path: paths.join(''),
                    width: mw,
                    height: mh,
                    tileSize,
                    bins,
                    segments
                };
            },
            buildMaskOutlinePath(mask) {
                const data = this.buildMaskOutlineData(mask);
                return data.path || '';
            },
            getVisibleMaskOutlinePath(s, clipX, clipY, clipW, clipH) {
                if (!s || !s.mask) return '';
                const full = s._maskOutlinePath || '';
                const data = s._maskOutlineData;
                if (!full || !data || !Array.isArray(data.segments) || !data.segments.length) return full;
                if (!(clipW > 0 && clipH > 0)) return '';

                const cacheKey = `${clipX}|${clipY}|${clipW}|${clipH}`;
                if (s._maskVisiblePathCacheKey === cacheKey) {
                    return s._maskVisiblePathCacheValue || '';
                }

                const pad = 1;
                const qLeft = Math.max(0, clipX - pad);
                const qTop = Math.max(0, clipY - pad);
                const qRight = Math.min(data.width, clipX + clipW + pad);
                const qBottom = Math.min(data.height, clipY + clipH + pad);
                if (!(qRight > qLeft && qBottom > qTop)) {
                    s._maskVisiblePathCacheKey = cacheKey;
                    s._maskVisiblePathCacheValue = '';
                    return '';
                }

                const tileSize = data.tileSize || 32;
                const tx0 = Math.floor(qLeft / tileSize);
                const ty0 = Math.floor(qTop / tileSize);
                const tx1 = Math.floor(qRight / tileSize);
                const ty1 = Math.floor(qBottom / tileSize);
                const seen = new Set();
                const clippedSegments = [];
                for (let ty = ty0; ty <= ty1; ty++) {
                    for (let tx = tx0; tx <= tx1; tx++) {
                        const list = data.bins.get(`${tx},${ty}`);
                        if (!list) continue;
                        for (const idxSeg of list) {
                            if (seen.has(idxSeg)) continue;
                            seen.add(idxSeg);
                            const seg = data.segments[idxSeg];
                            if (seg.maxX < qLeft || seg.minX > qRight || seg.maxY < qTop || seg.minY > qBottom) continue;
                            if (seg.y1 === seg.y2) {
                                const y = seg.y1;
                                if (y < qTop || y > qBottom) continue;
                                const minX = Math.min(seg.x1, seg.x2);
                                const maxX = Math.max(seg.x1, seg.x2);
                                const x1 = Math.max(minX, qLeft);
                                const x2 = Math.min(maxX, qRight);
                                if (x2 <= x1) continue;
                                clippedSegments.push({ x1, y1: y, x2, y2: y });
                            } else if (seg.x1 === seg.x2) {
                                const x = seg.x1;
                                if (x < qLeft || x > qRight) continue;
                                const minY = Math.min(seg.y1, seg.y2);
                                const maxY = Math.max(seg.y1, seg.y2);
                                const y1 = Math.max(minY, qTop);
                                const y2 = Math.min(maxY, qBottom);
                                if (y2 <= y1) continue;
                                clippedSegments.push({ x1: x, y1, x2: x, y2 });
                            }
                        }
                    }
                }

                if (!clippedSegments.length) {
                    s._maskVisiblePathCacheKey = cacheKey;
                    s._maskVisiblePathCacheValue = '';
                    return '';
                }

                const keyPt = (x, y) => `${x},${y}`;
                const segAdj = new Map();
                for (let i = 0; i < clippedSegments.length; i++) {
                    const seg = clippedSegments[i];
                    const ka = keyPt(seg.x1, seg.y1);
                    const kb = keyPt(seg.x2, seg.y2);
                    if (!segAdj.has(ka)) segAdj.set(ka, []);
                    if (!segAdj.has(kb)) segAdj.set(kb, []);
                    segAdj.get(ka).push(i);
                    segAdj.get(kb).push(i);
                }
                const used = new Uint8Array(clippedSegments.length);
                const nextFrom = (pt) => {
                    const list = segAdj.get(keyPt(pt.x, pt.y)) || [];
                    for (const idxSeg of list) {
                        if (used[idxSeg]) continue;
                        const seg = clippedSegments[idxSeg];
                        if (seg.x1 === pt.x && seg.y1 === pt.y) return { idx: idxSeg, pt: { x: seg.x2, y: seg.y2 } };
                        if (seg.x2 === pt.x && seg.y2 === pt.y) return { idx: idxSeg, pt: { x: seg.x1, y: seg.y1 } };
                    }
                    return null;
                };

                let d = '';
                for (let i = 0; i < clippedSegments.length; i++) {
                    if (used[i]) continue;
                    used[i] = 1;
                    const seg = clippedSegments[i];
                    const pts = [{ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }];

                    let tail = pts[pts.length - 1];
                    while (true) {
                        const next = nextFrom(tail);
                        if (!next) break;
                        used[next.idx] = 1;
                        tail = next.pt;
                        pts.push(tail);
                    }

                    let head = pts[0];
                    while (true) {
                        const next = nextFrom(head);
                        if (!next) break;
                        used[next.idx] = 1;
                        head = next.pt;
                        pts.unshift(head);
                    }

                    const simplified = this.simplifyAxisAlignedPath(pts, false);
                    if (!simplified || simplified.length < 2) continue;
                    d += `M${simplified[0].x} ${simplified[0].y}`;
                    for (let j = 1; j < simplified.length; j++) {
                        d += `L${simplified[j].x} ${simplified[j].y}`;
                    }
                }

                s._maskVisiblePathCacheKey = cacheKey;
                s._maskVisiblePathCacheValue = d;
                return d;
            },
            drawSelectionCutout(ctx, s, pos) {
                const nr = this.getNormalizedRect(pos);
                const fill = this.config.c2;
                ctx.save();
                ctx.translate(nr.x, nr.y);
                ctx.fillStyle = fill;
                ctx.fillRect(0, 0, nr.w, nr.h);
                if (s.mask) {
                    ctx.globalCompositeOperation = 'destination-in';
                    ctx.drawImage(s.mask, 0, 0, nr.w, nr.h);
                    ctx.globalCompositeOperation = 'source-over';
                } else if (this.config.transparentSelection && !s._forceOpaque) {
                    const renderC = this.getRenderedSelectionCanvas();
                    ctx.globalCompositeOperation = 'destination-in';
                    ctx.drawImage(renderC, 0, 0, nr.w, nr.h);
                    ctx.globalCompositeOperation = 'source-over';
                }
                ctx.restore();
            },
            getSelectionOutlinePath2D(s) {
                if (!s || !s.mask) return null;
                this.ensureSelectionOutline(s);
                const d = s._maskOutlinePath || '';
                if (!d) return null;
                if (s._maskPath2D && s._maskPath2DSource === d) {
                    return s._maskPath2D;
                }
                try {
                    s._maskPath2D = new Path2D(d);
                    s._maskPath2DSource = d;
                    return s._maskPath2D;
                } catch (e) {
                    s._maskPath2D = null;
                    s._maskPath2DSource = null;
                    return null;
                }
            },
            drawSelectionOutline(s, destX, destY, dw, dh) {
                if (!s || !s.mask) return;
                if (!this.shouldUseCanvasMaskAnts()) return;
                const path = this.getSelectionOutlinePath2D(s);
                if (!path) return;
                const ctx = this.ctxTemp;
                const aw = Math.max(1, Math.abs(dw));
                const ah = Math.max(1, Math.abs(dh));
                ctx.save();
                const z = this.config.zoom || 1;
                const viewport = this.ui.viewport;
                if (viewport) {
                    const vx = viewport.scrollLeft / z;
                    const vy = viewport.scrollTop / z;
                    const vw = viewport.clientWidth / z;
                    const vh = viewport.clientHeight / z;
                    const pad = 2 / z;
                    ctx.beginPath();
                    ctx.rect(vx - pad, vy - pad, vw + (pad * 2), vh + (pad * 2));
                    ctx.clip();
                }

                const mw = Math.max(1, s.mask.width || aw);
                const mh = Math.max(1, s.mask.height || ah);
                const sx = aw / mw;
                const sy = ah / mh;
                const invScale = 1 / Math.max(sx, sy, 1e-6);
                const lineWidth = (1 / z) * invScale;
                const dash = (15 / z) * invScale;
                const phase = (this.state.outlinePhase || 0) * ((1 / z) * invScale);

                ctx.translate(destX, destY);
                ctx.scale(dw < 0 ? -1 : 1, dh < 0 ? -1 : 1);
                ctx.scale(sx, sy);

                ctx.lineCap = 'butt';
                ctx.lineJoin = 'miter';
                ctx.lineWidth = lineWidth;
                ctx.setLineDash([]);
                ctx.strokeStyle = '#000000';
                ctx.stroke(path);

                ctx.setLineDash([dash, dash]);
                ctx.lineDashOffset = -phase;
                ctx.strokeStyle = '#ffffff';
                ctx.stroke(path);
                ctx.globalCompositeOperation = 'source-over';
                ctx.restore();
            },
            deferSelectionRenderFinalize(selectionRef) {
                const finalize = () => {
                    if (!selectionRef || this.state.selection !== selectionRef) return;
                    const maxFinalPixels = 600000;
                    const area = Math.abs(selectionRef.w) * Math.abs(selectionRef.h);
                    if (area > maxFinalPixels) {
                        selectionRef._needsPaletteEnforce = false;
                        selectionRef._cache = null;
                        return;
                    }
                    if (selectionRef._needsPaletteEnforce) {
                        if (selectionRef.palette && selectionRef.palette.list && selectionRef.palette.list.length > 256) {
                            selectionRef._needsPaletteEnforce = false;
                            selectionRef._cache = null;
                            return;
                        }
                        const ctx = selectionRef.canvas.getContext('2d');
                        this.disableSmoothing(ctx);
                        this.enforcePalette(ctx, selectionRef.canvas.width, selectionRef.canvas.height, selectionRef.palette);
                        selectionRef._needsPaletteEnforce = false;
                        selectionRef._glTexDirty = true;
                    }
                    selectionRef._cache = null;
                    this.renderSelection();
                };
                if (window.requestIdleCallback) {
                    requestIdleCallback(finalize, { timeout: 200 });
                } else {
                    setTimeout(finalize, 0);
                }
            },

            setStatusSelectionSize(w, h) {
                if (!this.ui.statusSelectionSize) return;
                const sw = Math.max(0, Math.floor(Math.abs(w)));
                const sh = Math.max(0, Math.floor(Math.abs(h)));
                const next = `${sw} x ${sh}px`;
                if (next === this._lastSelectionSizeText) return;
                this._lastSelectionSizeText = next;
                this.ui.statusSelectionSize.textContent = next;
            },

            clearStatusSelectionSize() {
                if (!this.ui.statusSelectionSize) return;
                this.clearStatusRotation();
                if (this._lastSelectionSizeText === '-') return;
                this._lastSelectionSizeText = '-';
                this.ui.statusSelectionSize.textContent = '-';
            },
            updateSelectionUI(x, y, w, h, rotation = 0) {
                let lx = x, ly = y, lw = w, lh = h;
                if(lw < 0) { lx += lw; lw = Math.abs(lw); }
                if(lh < 0) { ly += lh; lh = Math.abs(lh); }
                const el = this.ui.selControls;
                const hideHandles = !!(this.state.selection && this.state.selection.noHandles);
                const isCreating = this.state.isDrawing && this.config.tool === 'select' && !this.state.selection;
                const isRotating = !!(this.state.isRotatingSel || this.state.isRotatingShape);
                const rot = this.normalizeAngleDegrees(rotation || 0);
                const hasMask = !!(this.state.selection && this.state.selection.mask);

                // While actively rotating: hide the entire overlay so the box and handles
                // disappear. They reappear as a straight axis-aligned box once the mouse is released.
                if (isRotating) {
                    el.style.display = 'none';
                    this._selectionUiCacheKey = null;
                    // Also hide the SVG marquee rect — it was last drawn at rotation=0 and
                    // would stay visible unless we explicitly suppress it here.
                    this.requestGlobalOverlayUpdate();
                    if (this.state.selection || this.state.activeShape) {
                        this.setStatusRotation(rot);
                    }
                    return;
                }

                // Compute the axis-aligned bounding box of the (possibly rotated) content so
                // the overlay is always drawn straight — no CSS transform rotation ever.
                if (Math.abs(rot) > 0.01) {
                    const cx = lx + lw / 2;
                    const cy = ly + lh / 2;
                    // Inline the 4-corner AABB calculation — avoids 4 object allocations + .map() per frame.
                    const rad = rot * Math.PI / 180;
                    const cos = Math.cos(rad);
                    const sin = Math.sin(rad);
                    const rotate = (px, py) => ({
                        x: cx + (px - cx) * cos - (py - cy) * sin,
                        y: cy + (px - cx) * sin + (py - cy) * cos,
                    });
                    const c0 = rotate(lx,      ly);
                    const c1 = rotate(lx + lw, ly);
                    const c2 = rotate(lx + lw, ly + lh);
                    const c3 = rotate(lx,      ly + lh);
                    const minX = Math.min(c0.x, c1.x, c2.x, c3.x);
                    const maxX = Math.max(c0.x, c1.x, c2.x, c3.x);
                    const minY = Math.min(c0.y, c1.y, c2.y, c3.y);
                    const maxY = Math.max(c0.y, c1.y, c2.y, c3.y);
                    lx = minX; ly = minY; lw = maxX - minX; lh = maxY - minY;
                }

                const zoom = this.config.zoom || 1;
                const viewport = this.ui.viewport;
                const vpRect = this.vpBounds || (viewport ? viewport.getBoundingClientRect() : null);
                const stageRect = this.bounds || (this.ui.stage ? this.ui.stage.getBoundingClientRect() : null);
                const baseX = (vpRect && stageRect && viewport) ? (stageRect.left - vpRect.left + viewport.scrollLeft) : 0;
                const baseY = (vpRect && stageRect && viewport) ? (stageRect.top - vpRect.top + viewport.scrollTop) : 0;
                const screenX = Math.round(baseX + (lx * zoom));
                const screenY = Math.round(baseY + (ly * zoom));
                const screenW = Math.max(0, Math.round(lw * zoom));
                const screenH = Math.max(0, Math.round(lh * zoom));
                const cacheKey = `${screenX}|${screenY}|${screenW}|${screenH}|${hideHandles ? 1 : 0}|${hasMask ? 1 : 0}|${isCreating ? 1 : 0}`;
                const needsDisplayRestore = el.style.display !== 'block';
                if (needsDisplayRestore || cacheKey !== this._selectionUiCacheKey) {
                    el.classList.toggle('no-handles', hideHandles);
                    el.classList.remove('selection-rotated');
                    el.classList.remove('selection-rotating');
                    el.style.display = 'block';
                    el.style.left = screenX + 'px';
                    el.style.top = screenY + 'px';
                    el.style.width = screenW + 'px';
                    el.style.height = screenH + 'px';
                    el.style.transformOrigin = '';
                    el.style.transform = '';
                    const handlePos = {
                        nw: { x: 0,            y: 0 },
                        n:  { x: screenW / 2,  y: 0 },
                        ne: { x: screenW,      y: 0 },
                        e:  { x: screenW,      y: screenH / 2 },
                        se: { x: screenW,      y: screenH },
                        s:  { x: screenW / 2,  y: screenH },
                        sw: { x: 0,            y: screenH },
                        w:  { x: 0,            y: screenH / 2 }
                    };
                    const handleHalf = 3;
                    el.querySelectorAll('.sel-handle').forEach((handle) => {
                        const pos = handlePos[handle.dataset.id];
                        if (!pos) return;
                        handle.style.width = '6px';
                        handle.style.height = '6px';
                        handle.style.left = `${Math.round(pos.x - handleHalf)}px`;
                        handle.style.top = `${Math.round(pos.y - handleHalf)}px`;
                    });
                    const rotateHandle = el.querySelector('.sel-rotate-handle');
                    if (rotateHandle) {
                        if (this.state.selRotateAnchorMode) {
                            rotateHandle.style.left = `${Math.round((screenW / 2) - 10)}px`;
                            rotateHandle.style.top = `${Math.round((screenH / 2) - 10)}px`;
                        } else {
                            rotateHandle.style.left = `${Math.round((screenW / 2) - 10)}px`;
                            rotateHandle.style.top = `${Math.round(-34)}px`;
                        }
                    }
                    const rotateCenter = el.querySelector('#sel-rot-center');
                    if (rotateCenter) {
                        rotateCenter.style.left = `${Math.round((screenW / 2) - 3)}px`;
                        rotateCenter.style.top = `${Math.round((screenH / 2) - 3)}px`;
                    }
                    this._selectionUiCacheKey = cacheKey;
                }

                this.updateSelectionRotateHandleColor();
                if (this.state.selection || (this.state.isDrawing && this.config.tool === 'select')) {
                    this.setStatusSelectionSize(lw, lh);
                    this.setStatusRotation(rot);
                } else {
                    this.clearStatusSelectionSize();
                    this.clearStatusRotation();
                }

                if (isCreating) {
                    this.requestGlobalOverlayUpdate({x:lx, y:ly, w:lw, h:lh});
                } else {
                    this.requestGlobalOverlayUpdate();
                }
                this.requestPathHandlesUpdate();
            },

            commitSelection() {
                if(!this.state.selection) return;
                this.state.wandBase = null;
                this.state.wandDiff = null;
                this._clearSelAnchorMode();
                const s = this.state.selection;
                s._forceOpaque = false;
                const isDeferred = !!(s._deferredCut && s._cutRect);
                const changed = this.selectionChangedFromBase(s);
                const isUnmovedMaskSel = (s.source === 'wand' || s.source === 'lasso') && !changed && !isDeferred;
                if (isUnmovedMaskSel) {
                    this._freeSelectionGlTex(this.state.selection); this.state.selection = null;
                    this.state.selectionOriginalPos = null;
                    this.state.isRotatingSel = false;
                    this.state.selectionRotateSession = null;
                    this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                    this.resetSelectionTempDirty();
                    this.ui.selControls.style.display = 'none';
                    this.clearStatusSelectionSize();
                    this.stopOutlineAnimation();
                    this.requestGlobalOverlayUpdate();
                    return;
                }
                const renderC = this.getRenderedSelectionCanvas();
                const metrics = this.getSelectionDrawMetrics(s, renderC, true);

                this.disableSmoothing(this.ctx);
                if (isDeferred && !changed && !s._contentDirty) {
                    // Pure selection lifecycle (no move/transform): keep history and redo chain intact.
                    // If we cleared the layer canvas as a cut preview, restore it since nothing moved.
                    if (s._cutSavedData && s._cutSavedRect) {
                        const activeLayer = this.layerMgr && this.layerMgr.active && this.layerMgr.layers[this.layerMgr.activeIdx];
                        if (activeLayer && activeLayer.alpha !== false) {
                            activeLayer.ctx.putImageData(s._cutSavedData, s._cutSavedRect.x, s._cutSavedRect.y);
                        }
                    }
                } else {
                    if (isDeferred) {
                        const cut = s._cutRect;
                        // On a transparent layer, cut pixels should become transparent (clearRect).
                        // On an opaque layer, fill with C2 (the background colour).
                        const activeLayer = this.layerMgr && this.layerMgr.active && this.layerMgr.layers[this.layerMgr.activeIdx];
                        const isTransparentLayer = activeLayer && activeLayer.alpha !== false;
                        if (isTransparentLayer) {
                            this.ctx.clearRect(Math.floor(cut.x), Math.floor(cut.y), Math.floor(cut.w), Math.floor(cut.h));
                        } else {
                            this.ctx.fillStyle = this.config.c2;
                            this.ctx.fillRect(Math.floor(cut.x), Math.floor(cut.y), Math.floor(cut.w), Math.floor(cut.h));
                        }
                    }
                    // On a transparent layer, strip C2 background colour before stamping
                    // so we don't paint solid background squares onto layers that support true alpha.
                    const _stampLayer = this.layerMgr && this.layerMgr.active && this.layerMgr.layers[this.layerMgr.activeIdx];
                    const _stampOnTrans = _stampLayer && _stampLayer.alpha !== false;
                    if (_stampOnTrans) {
                        const _c2 = this.config.c2;
                        const _sw = renderC.width, _sh = renderC.height;
                        const _stripped = document.createElement('canvas');
                        _stripped.width = _sw; _stripped.height = _sh;
                        const _sctx = _stripped.getContext('2d');
                        _sctx.drawImage(renderC, 0, 0);
                        const _img = _sctx.getImageData(0, 0, _sw, _sh);
                        const _d = _img.data;
                        const _r = parseInt(_c2.slice(1,3),16), _g = parseInt(_c2.slice(3,5),16), _b = parseInt(_c2.slice(5,7),16);
                        for (let _i = 0; _i < _d.length; _i += 4) {
                            if (_d[_i] === _r && _d[_i+1] === _g && _d[_i+2] === _b) _d[_i+3] = 0;
                        }
                        _sctx.putImageData(_img, 0, 0);
                        this.ctx.drawImage(_stripped, metrics.destX, metrics.destY);
                    } else {
                        this.ctx.drawImage(renderC, metrics.destX, metrics.destY);
                    }
                }

                this._freeSelectionGlTex(this.state.selection); this.state.selection = null;
                this.state.selectionOriginalPos = null;
                this.state.isRotatingSel = false;
                this.state.selectionRotateSession = null;
                this.ctxTemp.clearRect(0,0,this.config.width, this.config.height);
                this.resetSelectionTempDirty();
                this.ui.selControls.style.display = 'none';
                this.clearStatusSelectionSize();
                this.stopOutlineAnimation();
                this.requestGlobalOverlayUpdate();
                if (!isDeferred || changed) {
                    this.saveState();
                    this.collapseSelectionCutStep();
                } else {
                    this.state.selectionCutStep = null;
                }
            },

            // Discard the floating selection without stamping it onto the canvas.
            // The counterpart to commitSelection(): never touches history, because
            // selection creation is deliberately non-destructive (see createSelection).
            cancelSelection() {
                const s = this.state.selection;
                if (!s) return;
                this._clearSelAnchorMode();
                // A deferred cut may have erased the source pixels from the layer canvas
                // as a drag preview. Nothing is being committed, so put them back.
                if (s._cutSavedData && s._cutSavedRect) {
                    const activeLayer = this.layerMgr && this.layerMgr.active && this.layerMgr.layers[this.layerMgr.activeIdx];
                    if (activeLayer && activeLayer.alpha !== false) {
                        activeLayer.ctx.putImageData(s._cutSavedData, s._cutSavedRect.x, s._cutSavedRect.y);
                    }
                }
                this._freeSelectionGlTex(s);
                this.state.selection = null;
                this.state.selectionOriginalPos = null;
                this.state.selectionRotateSession = null;
                this.state.selectionJustCreated = false;
                this.state.selectionCutStep = null;
                this.state.isMovingSel = false;
                this.state.isRotatingSel = false;
                this.state.wandBase = null;
                this.state.wandDiff = null;
                this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                this.resetSelectionTempDirty();
                this.ui.selControls.style.display = 'none';
                this.clearStatusSelectionSize();
                this.stopOutlineAnimation();
                this.requestGlobalOverlayUpdate();
            },

            // Drop an uncommitted shape draft without rasterizing it. Mirrors the
            // shape branch of undo(); commitActiveShape() is the stamping variant.
            commitSelectionRotationInPlace() {
                const s = this.state.selection;
                if (!s) return;
                const rot = this.getSelectionRotationDegrees(s);
                if (Math.abs(rot) <= 0.01) return;

                // Apply the deferred cut (if any) so the canvas shows the correct background
                // under the selection. Do NOT stamp renderC onto the main canvas and do NOT
                // erase the full AABB — the AABB is larger than the original selection (it
                // fits the rotated diagonal), so either operation would destroy canvas pixels
                // in the corner areas that were never part of the selection.
                const renderC = this.getRenderedSelectionCanvas();
                const metrics = this.getSelectionDrawMetrics(s, renderC, true);
                this.disableSmoothing(this.ctx);
                if (s._deferredCut && s._cutRect) {
                    const cut = s._cutRect;
                    const activeLayer = this.layerMgr && this.layerMgr.active && this.layerMgr.layers[this.layerMgr.activeIdx];
                    const isTransparentLayer = activeLayer && activeLayer.alpha !== false;
                    if (isTransparentLayer) {
                        this.ctx.clearRect(Math.floor(cut.x), Math.floor(cut.y), Math.floor(cut.w), Math.floor(cut.h));
                    } else {
                        this.ctx.fillStyle = this.config.c2;
                        this.ctx.fillRect(Math.floor(cut.x), Math.floor(cut.y), Math.floor(cut.w), Math.floor(cut.h));
                    }
                }

                // Compute the AABB of the rotated selection in canvas coords.
                const nr = this.getNormalizedRect(s);
                const cx = nr.x + nr.w / 2, cy = nr.y + nr.h / 2;
                const corners = [
                    { x: nr.x,        y: nr.y },
                    { x: nr.x + nr.w, y: nr.y },
                    { x: nr.x + nr.w, y: nr.y + nr.h },
                    { x: nr.x,        y: nr.y + nr.h }
                ].map(pt => this.rotatePoint(pt, { x: cx, y: cy }, rot));
                let minX = corners[0].x, maxX = corners[0].x, minY = corners[0].y, maxY = corners[0].y;
                for (let i = 1; i < corners.length; i++) {
                    minX = Math.min(minX, corners[i].x); maxX = Math.max(maxX, corners[i].x);
                    minY = Math.min(minY, corners[i].y); maxY = Math.max(maxY, corners[i].y);
                }
                const aabbX = Math.max(0, Math.round(minX));
                const aabbY = Math.max(0, Math.round(minY));
                const aabbW = Math.min(this.config.width  - aabbX, Math.round(maxX - minX));
                const aabbH = Math.min(this.config.height - aabbY, Math.round(maxY - minY));

                if (aabbW <= 0 || aabbH <= 0) {
                    // Degenerate case — just fully commit with no new selection.
                    this._freeSelectionGlTex(this.state.selection); this.state.selection = null;
                    this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                    this.resetSelectionTempDirty();
                    this.ui.selControls.style.display = 'none';
                    this.stopOutlineAnimation();
                    this.requestGlobalOverlayUpdate();
                    this.saveState();
                    return;
                }

                // Lift the rotated selection pixels into a new selection canvas.
                // IMPORTANT: draw renderC directly rather than copying from the main canvas.
                // The AABB is larger than the original selection rect (it fits the rotated
                // diagonal), so copying from this.ctx.canvas would capture real canvas pixels
                // that happen to fall under the transparent corner areas of the rotated
                // selection — those pixels would then be accidentally resized with the selection.
                // renderC already has transparent corners, so drawing it directly avoids
                // pulling in any background content.
                const selCanvas = document.createElement('canvas');
                selCanvas.width  = aabbW;
                selCanvas.height = aabbH;
                const selCtx = selCanvas.getContext('2d');
                this.disableSmoothing(selCtx);
                selCtx.drawImage(renderC, metrics.destX - aabbX, metrics.destY - aabbY);

                // Replace the old (rotated) selection with the fresh unrotated one.
                this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                this.resetSelectionTempDirty();
                this.state.isRotatingSel      = false;
                this.state.selectionRotateSession = null;
                this.state.selection = {
                    x: aabbX, y: aabbY, w: aabbW, h: aabbH,
                    canvas: selCanvas,
                    rotation: 0,
                    _cache: null,
                    _glTexDirty: true
                };
                this.state.selectionOriginalPos = { x: aabbX, y: aabbY, w: aabbW, h: aabbH, rotation: 0 };
                this.saveState();
                this.collapseSelectionCutStep();
                this.renderSelection();
            },

            stampSelection() {
                if(!this.state.selection) return;
                const s = this.state.selection;
                const renderC = this.getRenderedSelectionCanvas();
                const metrics = this.getSelectionDrawMetrics(s, renderC, true);

                this.disableSmoothing(this.ctx);
                this.ctx.drawImage(renderC, metrics.destX, metrics.destY);
            },
            toggleTransparentSelection() {
                this.config.transparentSelection = !this.config.transparentSelection;
                document.getElementById('item-trans-sel').classList.toggle('checked', this.config.transparentSelection);
                if(this.state.selection) this.renderSelection();
            },
            removeSelection() {
                if(!this.state.selection) return;
                if(this.state.selectionOriginalPos) {
                    this.state.selection.x = this.state.selectionOriginalPos.x;
                    this.state.selection.y = this.state.selectionOriginalPos.y;
                    this.state.selection.w = this.state.selectionOriginalPos.w;
                    this.state.selection.h = this.state.selectionOriginalPos.h;
                    this.state.selection.rotation = this.state.selectionOriginalPos.rotation || 0;
                    this.state.selection._forceOpaque = false;
                    this.commitSelection();
                } else {
                    this._freeSelectionGlTex(this.state.selection); this.state.selection = null;
                    this.ctxTemp.clearRect(0,0,this.config.width, this.config.height);
                    this.resetSelectionTempDirty();
                    this.ui.selControls.style.display = 'none';
                    this.clearStatusSelectionSize();
                    this.stopOutlineAnimation();
                    this.requestGlobalOverlayUpdate();
                    this.state.isRotatingSel = false;
                    this.state.selectionRotateSession = null;
                    this.state.selectionCutStep = null;
                }
            },

            deleteSelection() {
                if(this.state.selection) {
                    this._clearSelAnchorMode();
                    const s = this.state.selection;
                    const isDeferred = !!(s._deferredCut && s._cutRect);
                    if (isDeferred) {
                        const cut = s._cutRect;
                        const activeLayer = this.layerMgr && this.layerMgr.active && this.layerMgr.layers[this.layerMgr.activeIdx];
                        const isTransparentLayer = activeLayer && activeLayer.alpha !== false;
                        if (isTransparentLayer) {
                            this.ctx.clearRect(Math.floor(cut.x), Math.floor(cut.y), Math.floor(cut.w), Math.floor(cut.h));
                        } else {
                            this.ctx.fillStyle = this.config.c2;
                            this.ctx.fillRect(Math.floor(cut.x), Math.floor(cut.y), Math.floor(cut.w), Math.floor(cut.h));
                        }
                    }
                    this._freeSelectionGlTex(this.state.selection); this.state.selection = null;
                    this.state.selectionOriginalPos = null;
                    this.state.isRotatingSel = false;
                    this.state.selectionRotateSession = null;
                    this.ctxTemp.clearRect(0,0,this.config.width, this.config.height);
                    this.resetSelectionTempDirty();
                    this.ui.selControls.style.display = 'none';
                    this.clearStatusSelectionSize();
                    this.stopOutlineAnimation();
                    this.requestGlobalOverlayUpdate();
                    this.saveState();
                    this.collapseSelectionCutStep();
                }
            },

            selectAll() {
                if (this.state.selection) {
                    this.commitSelection();
                }
                this.createSelection(0,0,this.config.width, this.config.height);
            },

            pointInSelectionRect(x, y, r) {
                return this.pointInSelection(x, y, r);
            },

            setLassoSelectMode(mode) {
                this.config.lassoSelectMode = mode === 'poly' ? 'poly' : 'free';
            },
            setSelectTool(mode) {
                if (mode) this.config.selectTool = mode === 'lasso' ? 'lasso' : 'select';
                const next = this.config.selectTool === 'lasso' ? 'lasso' : 'select';
                this.setTool(next);
            },
            debugLogSelection() {
                if (!this.state.selection) {
                    console.log('PaintApp selection', null);
                    return;
                }
                const s = this.state.selection;
                console.log('PaintApp selection', {
                    x: s.x, y: s.y, w: s.w, h: s.h,
                    hasMask: !!s.mask,
                    hasCache: !!s._cache,
                    forceOpaque: !!s._forceOpaque,
                    paletteSize: s.palette && s.palette.list ? s.palette.list.length : 0
                });
            },
            debugForceRenderSelection() {
                if (!this.state.selection) {
                    this.renderSelection();
                    return;
                }
                this.renderSelection();
                this.renderSelectionFast();
            },
            collapseSelectionCutStep() {
                const cutStep = this.state.selectionCutStep;
                if (cutStep === null) return;
                if (cutStep >= 0 && cutStep < this.state.history.length) {
                    // The step after this one may be a delta built on it. Flatten
                    // that one first, while this entry's tiles can still be reached.
                    const next = this.state.history[cutStep + 1];
                    if (next && next.base) this._anchorEntry(next);
                    const [evicted] = this.state.history.splice(cutStep, 1);
                    // This removes an entry from the MIDDLE of the history, so
                    // entries after it survive and may reference its layer pixels.
                    // Must not close anything they still resolve to.
                    this._releaseHistoryEntries([evicted], this.state.history);
                    if (this.state.step >= cutStep) this.state.step--;
                }
                this.state.selectionCutStep = null;
            },
            getSelectionOp(e) {
                if (e && e.ctrlKey) return 'subtract';
                if (e && e.shiftKey) return 'add';
                if (e && e.altKey) return 'intersect';
                return 'replace';
            },
            buildMaskFromPolygon(points, w, h) {
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                const ctx = c.getContext('2d', { willReadFrequently: true });
                ctx.clearRect(0,0,w,h);
                ctx.fillStyle = '#000';
                ctx.beginPath();
                ctx.moveTo(points[0].x, points[0].y);
                for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
                ctx.closePath();
                ctx.fill();
                return c;
            },
            buildMaskFromSelection() {
                if (!this.state.selection) return null;
                const nr = this.getNormalizedRect(this.state.selection);
                const rc = this.getRenderedSelectionCanvas();
                const mw = this.config.width, mh = this.config.height;
                const mask = document.createElement('canvas');
                mask.width = mw; mask.height = mh;
                const mctx = mask.getContext('2d', { willReadFrequently: true });
                mctx.clearRect(0,0,mw,mh);
                const tmp = document.createElement('canvas');
                tmp.width = rc.width; tmp.height = rc.height;
                const tctx = tmp.getContext('2d', { willReadFrequently: true });
                tctx.drawImage(rc, 0, 0);
                const img = tctx.getImageData(0, 0, tmp.width, tmp.height);
                const d = img.data;
                for (let i = 0; i < d.length; i += 4) {
                    d[i] = 0; d[i+1] = 0; d[i+2] = 0; d[i+3] = d[i+3] > 0 ? 255 : 0;
                }
                tctx.putImageData(img, 0, 0);
                mctx.drawImage(tmp, nr.x, nr.y);
                return mask;
            },
            applyMaskSelection(newMask, op = 'replace', baseImageData = null, commit = true, opts = {}) {
                const w = this.config.width;
                const h = this.config.height;
                // The pixels this selection lifts, and the pixels left behind,
                // always come from the layer being edited — never from the
                // caller's sample buffer. The wand may have built its mask from
                // the composited picture ("sample all layers"), and writing
                // that back here would stamp every upper layer into this one.
                const base = this.ctx.getImageData(0, 0, w, h);
                const baseData = base.data; // read-only reference — never mutated, no copy needed
                const canvasData = new Uint8ClampedArray(base.data);
                let selMask = this.buildMaskFromSelection();
                if (!selMask && op !== 'replace') op = 'replace';

                let selImg = null;
                let selMaskImg = null;
                if (selMask) {
                    const selFull = document.createElement('canvas');
                    selFull.width = w; selFull.height = h;
                    const sctx = selFull.getContext('2d', { willReadFrequently: true });
                    sctx.clearRect(0,0,w,h);
                    if (this.state.selection) {
                        const nr = this.getNormalizedRect(this.state.selection);
                        const rc = this.getRenderedSelectionCanvas();
                        sctx.drawImage(rc, nr.x, nr.y);
                    }
                    selImg = sctx.getImageData(0, 0, w, h).data;
                    selMaskImg = selMask.getContext('2d').getImageData(0, 0, w, h).data;
                }
                const newImg = newMask.getContext('2d').getImageData(0, 0, w, h).data;

                const combined = new Uint8ClampedArray(w * h);
                let minX = w, minY = h, maxX = -1, maxY = -1;
                for (let i = 0; i < w * h; i++) {
                    const s = selMaskImg ? (selMaskImg[i*4 + 3] > 0 ? 1 : 0) : 0;
                    const n = newImg[i*4 + 3] > 0 ? 1 : 0;
                    let c = n;
                    if (op === 'add') c = (s || n) ? 1 : 0;
                    else if (op === 'subtract') c = (s && !n) ? 1 : 0;
                    else if (op === 'intersect') c = (s && n) ? 1 : 0;
                    combined[i] = c;
                    if (c) {
                        const x = i % w;
                        const y = (i / w) | 0;
                        if (x < minX) minX = x;
                        if (y < minY) minY = y;
                        if (x > maxX) maxX = x;
                        if (y > maxY) maxY = y;
                    }
                }

                const bg = this.hexToRgb(this.config.c2);
                if (selMaskImg && selImg) {
                    for (let i = 0; i < w * h; i++) {
                        const s = selMaskImg[i*4 + 3] > 0;
                        const c = combined[i] > 0;
                        if (s && !c) {
                            const di = i * 4;
                            canvasData[di] = selImg[di];
                            canvasData[di+1] = selImg[di+1];
                            canvasData[di+2] = selImg[di+2];
                            canvasData[di+3] = selImg[di+3];
                        }
                    }
                }
                // Lifting the selected pixels leaves a hole. On an opaque layer that
                // hole is the background colour, as in MS Paint. A layer that carries
                // real alpha has to stay transparent instead — otherwise every lasso
                // or wand selection floods the empty parts of the layer with C2, and
                // it shows straight through the gaps in the floating selection.
                // Same rule the deferred rectangular cut already follows.
                const cutLayer = this.layerMgr && this.layerMgr.active && this.layerMgr.layers[this.layerMgr.activeIdx];
                const cutTransparent = !!(cutLayer && cutLayer.alpha !== false);
                if (cutTransparent) {
                    for (let i = 0; i < w * h; i++) {
                        if (combined[i]) {
                            const di = i * 4;
                            canvasData[di] = 0;
                            canvasData[di+1] = 0;
                            canvasData[di+2] = 0;
                            canvasData[di+3] = 0;
                        }
                    }
                } else {
                    for (let i = 0; i < w * h; i++) {
                        if (combined[i]) {
                            const di = i * 4;
                            canvasData[di] = bg.r;
                            canvasData[di+1] = bg.g;
                            canvasData[di+2] = bg.b;
                            canvasData[di+3] = 255;
                        }
                    }
                }
                const outImg = this.ctx.createImageData(w, h);
                outImg.data.set(canvasData);
                this.ctx.putImageData(outImg, 0, 0);
                if (commit) {
                    this.saveState();
                    // A previous mask selection may still have its own cut step pending.
                    // The entry we just saved already has those pixels put back (the
                    // s && !c restore loop above), so the old "pixels lifted, hole left
                    // behind" entry is dead scaffolding. Left in place it becomes the
                    // state the first undo lands on, which looks like the earlier
                    // selection vanishing. Collapse it before claiming the new one.
                    this.collapseSelectionCutStep();
                }

                if (maxX < minX || maxY < minY) {
                    this._freeSelectionGlTex(this.state.selection); this.state.selection = null;
                    this.state.selectionOriginalPos = null;
                    this.renderSelection();
                    return;
                }

                const selW = maxX - minX + 1;
                const selH = maxY - minY + 1;
                const selC = document.createElement('canvas');
                selC.width = selW; selC.height = selH;
                const selCtx = selC.getContext('2d', { willReadFrequently: true });
                this.disableSmoothing(selCtx);
                const selImgOut = selCtx.createImageData(selW, selH);
                const sd = selImgOut.data;
                const maskSel = document.createElement('canvas');
                maskSel.width = selW; maskSel.height = selH;
                const maskCtx = maskSel.getContext('2d', { willReadFrequently: true });
                const maskImg = maskCtx.createImageData(selW, selH);
                const md = maskImg.data;

                for (let y = minY; y <= maxY; y++) {
                    for (let x = minX; x <= maxX; x++) {
                        const ci = y * w + x;
                        const si = ((y - minY) * selW + (x - minX)) * 4;
                        if (combined[ci]) {
                            const useSel = selMaskImg && selMaskImg[ci*4 + 3] > 0;
                            const src = useSel ? selImg : baseData;
                            sd[si] = src[ci*4];
                            sd[si+1] = src[ci*4+1];
                            sd[si+2] = src[ci*4+2];
                            sd[si+3] = src[ci*4+3];
                            md[si] = 0; md[si+1] = 0; md[si+2] = 0; md[si+3] = 255;
                        } else {
                            sd[si] = 0;
                            sd[si+1] = 0;
                            sd[si+2] = 0;
                            sd[si+3] = 0;
                            md[si] = 0; md[si+1] = 0; md[si+2] = 0; md[si+3] = 0;
                        }
                    }
                }
                selCtx.putImageData(selImgOut, 0, 0);
                maskCtx.putImageData(maskImg, 0, 0);
                const source = opts && opts.source ? opts.source : null;
                this.state.selectionCutStep = this.state.step;
                this.state.selection = { x: minX, y: minY, w: selW, h: selH, rotation: 0, canvas: selC, originalX: minX, originalY: minY, palette: null, mask: maskSel, source: source, noHandles: source === 'wand', _maskOutline: null, _maskOutlinePath: null, _maskOutlineData: null, _maskVisiblePathCacheKey: '', _maskVisiblePathCacheValue: '', _maskAnts: null, _maskOutlineScreen: null, _maskAntsScreen: null, _glTex: null, _glTexDirty: true };
                this.state.selectionOriginalPos = { x: minX, y: minY, w: selW, h: selH, rotation: 0 };
                // Defer palette extraction to avoid blocking the main thread on large selections.
                this.deferSelectionPalette(selCtx, selW, selH, this.state.selection);
                if (source === 'wand' || source === 'lasso') {
                    this.state.selectionJustCreated = true;
                }
                this.renderSelection();
            },
            resetLassoState() {
                this.state.lassoActive = false;
                this.state.lassoPoints = [];
                this.state.lassoIsDown = false;
                this.state.lassoMode = null;
                this.state.lassoStart = null;
                this.ctxTemp.clearRect(0,0,this.config.width, this.config.height);
                if (this.ui && this.ui.cTemp) this.ui.cTemp.style.mixBlendMode = 'normal';
            },
            startLassoSelection(p) {
                this.resetLassoState();
                this.state.lassoActive = true;
                this.state.lassoMode = this.config.lassoSelectMode === 'poly' ? 'poly' : 'free';
                this.state.lassoIsDown = this.state.lassoMode === 'free';
                this.state.lassoStart = { x: p.x, y: p.y };
                this.state.lassoPoints = [{ x: p.x, y: p.y }];
            },
            appendLassoPoint(p) {
                const last = this.state.lassoPoints[this.state.lassoPoints.length - 1];
                if (!last || last.x !== p.x || last.y !== p.y) {
                    this.state.lassoPoints.push({ x: p.x, y: p.y });
                }
            },
            finalizeLassoSelection() {
                if (!this.state.lassoActive) return;
                if (this.state.lassoPoints.length < 3) {
                    this.resetLassoState();
                    return;
                }
                const pts = this.state.lassoPoints.slice();
                const w = this.config.width, h = this.config.height;
                const mask = this.buildMaskFromPolygon(pts, w, h);
                this.resetLassoState();
                this.applyMaskSelection(mask, this.getSelectionOp(this._lastPointerEvent));
            },
            renderLassoPreview(p) {
                this.ctxTemp.clearRect(0,0,this.config.width, this.config.height);
                if (!this.state.lassoPoints.length) return;
                if (this.ui && this.ui.cTemp) this.ui.cTemp.style.mixBlendMode = 'difference';
                for (let i = 1; i < this.state.lassoPoints.length; i++) {
                    const a = this.state.lassoPoints[i - 1];
                    const b = this.state.lassoPoints[i];
                    this.drawBinaryLine(a.x, a.y, b.x, b.y, '#ffffff', true, 1, false);
                }
                if (this.state.lassoMode === 'poly' && p) {
                    const last = this.state.lassoPoints[this.state.lassoPoints.length - 1];
                    this.drawBinaryLine(last.x, last.y, p.x, p.y, '#ffffff', true, 1, false);
                }
            },
            _maskToSvgPath(mask, w, h, clip) {
                if (!mask) return '';
                // Same viewport crop the worker applies — see maskToSvgPath in
                // ensureWandPreviewWorker(). Neighbour lookups still read the full
                // mask, so the edges that survive are exactly the ones the overlay
                // clip would have kept anyway.
                let cy0 = 0, cy1 = h, cx0 = 0, cx1 = w;
                if (clip) {
                    if (!clip.visible) return '';
                    cx0 = clip.x < 0 ? 0 : (clip.x > w ? w : clip.x | 0);
                    cy0 = clip.y < 0 ? 0 : (clip.y > h ? h : clip.y | 0);
                    const rx = clip.x + clip.w, ry = clip.y + clip.h;
                    cx1 = rx < 0 ? 0 : (rx > w ? w : Math.ceil(rx));
                    cy1 = ry < 0 ? 0 : (ry > h ? h : Math.ceil(ry));
                    if (cx1 <= cx0 || cy1 <= cy0) return '';
                }

                // ÔöÇÔöÇ 1. Collect directed boundary edges ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
                // Winding: CCW around each selected pixel, matching buildMaskOutlineData.
                // Stored as flat array [ax,ay,bx,by, ax,ay,bx,by, ...].
                const edges = [];
                for (let y = cy0; y < cy1; y++) {
                    const row  = y * w;
                    const rowP = (y - 1) * w;
                    const rowN = (y + 1) * w;
                    for (let x = cx0; x < cx1; x++) {
                        if (!mask[row + x]) continue;
                        const x1 = x + 1, y1 = y + 1;
                        if (y === 0   || !mask[rowP + x])   { edges.push(x,  y,  x1, y);  }
                        if (x === w-1 || !mask[row  + x+1]) { edges.push(x1, y,  x1, y1); }
                        if (y === h-1 || !mask[rowN + x])   { edges.push(x1, y1, x,  y1); }
                        if (x === 0   || !mask[row  + x-1]) { edges.push(x,  y1, x,  y);  }
                    }
                }
                const nEdges = edges.length >> 2;
                if (!nEdges) return '';

                // ÔöÇÔöÇ 2. Integer-keyed adjacency, as a reusable flat linked list ÔöÇÔöÇÔöÇÔöÇ
                // Point key = y*(w+1)+x — a unique integer for every grid corner.
                // Replaces the previous per-frame `Map` (+ per-vertex array) with a
                // preallocated head[]/next[]/edgeAt[] structure reused across frames:
                // head[key] -> index into entry arrays, entryNext[] chains further
                // entries at the same vertex, entryEdge[] holds the edge index.
                // This avoids Map hashing/boxing overhead and per-frame GC pressure
                // on the hottest path of the wand-drag preview.
                // NOTE: entries must be appended in FIFO (insertion) order, matching
                // the original `la.push(i)` / `lb.push(i)` array behaviour. At
                // non-manifold vertices (e.g. two selected pixels touching only
                // diagonally) more than 2 edges can meet at one point, and which
                // edge the tracer picks first is order-sensitive — LIFO/prepend
                // ordering silently produces a different (still valid-looking, but
                // NOT byte-identical) loop decomposition. A tail pointer per vertex
                // gives FIFO append while staying O(1) per insertion.
                const stride = this._ensureWandTraceBuffers(w, h);
                const vertexCount = stride * (h + 1);
                const head = this._wandTraceHead;
                const entryCap = nEdges * 2;
                const entryNext = this._growWandTraceI32('_wandTraceEntryNext', entryCap);
                const entryEdge = this._growWandTraceI32('_wandTraceEntryEdge', entryCap);
                const entryTail = this._growWandTraceI32('_wandTraceEntryTail', vertexCount);
                const touched = this._growWandTraceI32('_wandTraceTouched', entryCap);
                let touchedCount = 0;
                let entryCount = 0;
                for (let i = 0; i < nEdges; i++) {
                    const b = i * 4;
                    const ka = edges[b+1] * stride + edges[b];
                    const kb = edges[b+3] * stride + edges[b+2];

                    entryEdge[entryCount] = i; entryNext[entryCount] = -1;
                    if (head[ka] === -1) head[ka] = entryCount; else entryNext[entryTail[ka]] = entryCount;
                    entryTail[ka] = entryCount;
                    touched[touchedCount++] = ka; entryCount++;

                    entryEdge[entryCount] = i; entryNext[entryCount] = -1;
                    if (head[kb] === -1) head[kb] = entryCount; else entryNext[entryTail[kb]] = entryCount;
                    entryTail[kb] = entryCount;
                    touched[touchedCount++] = kb; entryCount++;
                }
                // Remember exactly which vertex slots we touched so the *next* call
                // can reset just those instead of the whole (w+1)*(h+1) buffer.
                this._wandTraceTouchedCount = touchedCount;

                // ÔöÇÔöÇ 3. Trace connected loops ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
                const used = this._growWandTraceI32('_wandTraceUsed', nEdges);
                used.fill(0, 0, nEdges);
                const parts = [];

                for (let si = 0; si < nEdges; si++) {
                    if (used[si]) continue;
                    used[si] = 1;
                    const b0   = si * 4;
                    const sx   = edges[b0],   sy   = edges[b0+1];
                    const startKey = sy * stride + sx;
                    let prevKey = startKey;
                    let cx = edges[b0+2], cy = edges[b0+3];
                    let currKey = cy * stride + cx;

                    // Collect polygon points as parallel flat arrays (faster than objects).
                    const ptx = [sx, cx];
                    const pty = [sy, cy];

                    while (currKey !== startKey) {
                        let entry = head[currKey];
                        if (entry === -1) break;
                        let nextIdx = -1, nxtX = 0, nxtY = 0;
                        let fbIdx   = -1, fbX  = 0, fbY  = 0;
                        while (entry !== -1) {
                            const ei = entryEdge[entry];
                            entry = entryNext[entry];
                            if (used[ei]) continue;
                            const nb   = ei * 4;
                            const naKey = edges[nb+1] * stride + edges[nb];
                            const isA  = (naKey === currKey);
                            const ox   = isA ? edges[nb+2] : edges[nb];
                            const oy   = isA ? edges[nb+3] : edges[nb+1];
                            const ok   = oy * stride + ox;
                            if (ok !== prevKey) { nextIdx = ei; nxtX = ox; nxtY = oy; break; }
                            if (fbIdx === -1)   { fbIdx   = ei; fbX  = ox; fbY  = oy; }
                        }
                        if (nextIdx === -1) {
                            if (fbIdx === -1) break;
                            nextIdx = fbIdx; nxtX = fbX; nxtY = fbY;
                        }
                        used[nextIdx] = 1;
                        prevKey = currKey;
                        cx = nxtX; cy = nxtY;
                        currKey = cy * stride + cx;
                        ptx.push(cx); pty.push(cy);
                    }

                    const n = ptx.length;
                    if (n < 2) continue;
                    const isClosed = n > 2 && currKey === startKey;

                    // ÔöÇÔöÇ 4. Inline O(n) collinear simplification ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
                    // Replaces simplifyAxisAlignedPath's O(n┬▓) splice loop.
                    // A point is collinear (kept=false) when both its neighbours share
                    // the same x OR the same y as it.
                    const keep = new Uint8Array(n);
                    if (!isClosed) {
                        keep[0] = 1; keep[n - 1] = 1;
                        for (let i = 1; i < n - 1; i++) {
                            const px = ptx[i-1], py = pty[i-1];
                            const qx = ptx[i],   qy = pty[i];
                            const rx = ptx[i+1], ry = pty[i+1];
                            if (!((px === qx && qx === rx) || (py === qy && qy === ry))) keep[i] = 1;
                        }
                    } else {
                        for (let i = 0; i < n; i++) {
                            const pi = (i - 1 + n) % n;
                            const ni = (i + 1) % n;
                            const px = ptx[pi], py = pty[pi];
                            const qx = ptx[i],  qy = pty[i];
                            const rx = ptx[ni], ry = pty[ni];
                            if (!((px === qx && qx === rx) || (py === qy && qy === ry))) keep[i] = 1;
                        }
                    }

                    // ÔöÇÔöÇ 5. Emit path string ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
                    let first = true;
                    for (let i = 0; i < n; i++) {
                        if (!keep[i]) continue;
                        parts.push(first ? ('M' + ptx[i] + ' ' + pty[i])
                                         : ('L' + ptx[i] + ' ' + pty[i]));
                        first = false;
                    }
                    if (isClosed && !first) parts.push('Z');
                }

                return parts.join('');
            }

            /**
             * Apply a pre-built SVG path string to the marching-ants overlay elements,
             * using the correct zoom transform and viewport clip rect. Hides elements
             * when pathStr is empty. Call clearRect on ctxTemp BEFORE calling this.
             */
    });
})();
