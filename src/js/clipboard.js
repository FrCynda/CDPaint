/* clipboard — moved verbatim off the PaintEngine class body.
 *
 * Assigned onto the prototype, so `this` is the same PaintEngine instance
 * these methods have always run against. Loads after paint-engine.js and
 * before boot.js, which is where the instance is finally created.
 */
(function () {
    Object.assign(PaintEngine.prototype, {
            drainPendingPaste() {
                const file = window.__pendingPaste;
                if (!file) return;
                window.__pendingPaste = null;
                this.handleFile(file, true);
            },

            ensurePasteCanvasFits(w, h) {
                let currentW = this.config.width;
                let currentH = this.config.height;
                let needsResize = false;
                if (w > currentW) { currentW = w; needsResize = true; }
                if (h > currentH) { currentH = h; needsResize = true; }
                if (!needsResize) return;
                const temp = document.createElement('canvas');
                temp.width = this.config.width;
                temp.height = this.config.height;
                const tCtx = this.get2dContext(temp);
                this.disableSmoothing(tCtx);
                tCtx.drawImage(this.ui.cMain, 0, 0);
                this.setSize(currentW, currentH);
                this.ctx.fillStyle = 'white';
                this.ctx.fillRect(0, 0, currentW, currentH);
                this.ctx.drawImage(temp, 0, 0);
                this.saveState();
            },

            getPasteOrigin(w, h) {
                const stage = this.ui.stage ? this.ui.stage.getBoundingClientRect() : null;
                const ribbon = document.getElementById('ribbon');
                const zoom = this.config.zoom || 1;
                const vx = this.ui.viewport ? (this.ui.viewport.scrollLeft / zoom) : 0;
                const vy = this.ui.viewport ? (this.ui.viewport.scrollTop / zoom) : 0;
                if (stage && ribbon && ribbon.offsetParent) {
                    const rb = ribbon.getBoundingClientRect();
                    // Anchor paste position to the ribbon's bottom-left corner so the pasted content
                // appears immediately below the toolbar rather than at the scroll origin.
                    const x = Math.max(0, Math.floor((rb.left - stage.left) / zoom) + 1);
                    const y = Math.max(0, Math.floor((rb.bottom - stage.top) / zoom) + 1);
                    return { x, y };
                }
                return { x: Math.floor(vx), y: Math.floor(vy) };
            },

            async execCopy() {
                if(this.state.selection) {
                    const c=document.createElement('canvas');
                    c.width=this.state.selection.w;
                    c.height=this.state.selection.h;
                    const ctx = c.getContext('2d');
                    ctx.drawImage(this.state.selection.canvas,0,0);
                    c.toBlob(blob => navigator.clipboard.write([new ClipboardItem({'image/png': blob})]));
                }
            },
            async execCut() { await this.execCopy(); this.deleteSelection(); },
            async execPaste() {
                try {
                    const items = await navigator.clipboard.read();
                    for (const item of items) {
                        const type = item.types.find(t => t.startsWith('image/'));
                        if (type) {
                            const blob = await item.getType(type);
                            this.handleFile(blob, true);
                            return;
                        }
                    }
                    showToast("No image on clipboard", 'warning');
                } catch (e) { showToast("Paste failed or denied: " + e, 'error'); }
            },
            async handlePastedFileWithConversions(f) {
                let firstW = null, firstH = null;
                let best = null;
                const tol = this.config.transTol ?? 12;
                const mode = this.config.transMode === 'edge' ? 'edge' : 'all';
                let sawVariant = false;

                await this.evaluateDecodedImageVariants(f, async (c, cCtx, label) => {
                    sawVariant = true;
                    if (firstW === null) {
                        firstW = c.width;
                        firstH = c.height;
                        this.ensurePasteCanvasFits(c.width, c.height);
                    }
                    this.normalizeCanvasColors(cCtx, c.width, c.height);
                    const imgData = cCtx.getImageData(0, 0, c.width, c.height);
                    let bg = null;
                    if (this.config.transColor) bg = this.config.transColor;
                    else if (this.config.transMode === 'c2') bg = this.hexToRgb(this.config.c2);
                    else bg = this.sampleBorderColorFromImageData(imgData, c.width, c.height) || this.hexToRgb(this.config.c2);
                    const keyCount = this.countTransparencyKeyMatches(imgData, c.width, c.height, bg, tol, mode);

                    if (!best || keyCount > best.keyCount) {
                        const bestCanvas = document.createElement('canvas');
                        bestCanvas.width = c.width;
                        bestCanvas.height = c.height;
                        const bestCtx = this.get2dContext(bestCanvas);
                        this.disableSmoothing(bestCtx);
                        bestCtx.drawImage(c, 0, 0);
                        best = { canvas: bestCanvas, ctx: bestCtx, bg, keyCount, label };
                    }
                });

                if (!best) {
                    if (!sawVariant) {
                        const img = await this.loadImageFromBlob(f);
                        this.handleLoadedImage(img, true);
                    }
                    return;
                }

                let keyMask = null;
                if (best.bg) {
                    const imgData = best.ctx.getImageData(0, 0, best.canvas.width, best.canvas.height);
                    keyMask = this.buildTransparencyKeyMask(imgData, best.canvas.width, best.canvas.height, best.bg, tol, mode);
                }
                await this.applyCurrentModeToCanvasAsync(best.ctx, best.canvas.width, best.canvas.height, true);
                if (keyMask) this.applyTransparencyMaskToCanvas(best.ctx, best.canvas.width, best.canvas.height, keyMask);
                this.finalizePastedSelection(best.canvas);
            }
    });
})();
