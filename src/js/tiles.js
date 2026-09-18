/* tiles — moved verbatim off the PaintEngine class body.
 *
 * Assigned onto the prototype, so `this` is the same PaintEngine instance
 * these methods have always run against. Loads after paint-engine.js and
 * before boot.js, which is where the instance is finally created.
 */
(function () {
    Object.assign(PaintEngine.prototype, {
            initTileMode() {
                const savedSize = parseInt(this.lsGet('paint.tile.size') || '16', 10);
                const savedGrid = parseInt(this.lsGet('paint.tile.grid') || '3', 10);
                const savedEnabled = this.lsGet('paint.tile.enabled') === 'true';
                const savedDarken = this.lsGet('paint.tile.darken') === 'true';
                if (Number.isFinite(savedSize) && savedSize >= 1) this.tileSize = savedSize;
                if (Number.isFinite(savedGrid) && savedGrid >= 3) {
                    this.tileGrid = savedGrid % 2 === 0 ? savedGrid + 1 : savedGrid;
                }
                this.tileModeEnabled = savedEnabled;
                this.tileDarkenEnabled = savedDarken;

                const toggle = document.getElementById('tile-mode-toggle');
                const sizeInput = document.getElementById('tile-size');
                const gridInput = document.getElementById('tile-grid');
                const darkenToggle = document.getElementById('tile-darken-toggle');

                if (toggle) {
                    toggle.checked = this.tileModeEnabled;
                    toggle.addEventListener('change', () => this.setTileModeEnabled(toggle.checked));
                }
                if (sizeInput) {
                    sizeInput.value = this.tileSize;
                    sizeInput.addEventListener('change', () => this.setTileSize(sizeInput.value));
                }
                if (gridInput) {
                    gridInput.value = this.tileGrid;
                    gridInput.addEventListener('change', () => this.setTileGrid(gridInput.value));
                }
                if (darkenToggle) {
                    darkenToggle.checked = this.tileDarkenEnabled;
                    darkenToggle.addEventListener('change', () => this.setTileDarkenEnabled(darkenToggle.checked));
                }

                this.updateTileOffsets();
                if (this.tileModeEnabled) {
                    // Boot-time restore of a persisted setting, not a user edit.
                    // applyTileMode() resizes and repaints the canvas and records an
                    // undo step for it, which would leave a freshly-opened app with
                    // one phantom action to undo.
                    this.applyTileMode();
                    this.resetHistoryBaseline();
                }
                this.updateTileOverlay();
            },
            setTileModeEnabled(enabled) {
                this.tileModeEnabled = !!enabled;
                this.lsSet('paint.tile.enabled', this.tileModeEnabled ? 'true' : 'false');
                const toggle = document.getElementById('tile-mode-toggle');
                if (toggle) toggle.checked = this.tileModeEnabled;
                this.updateTileOffsets();
                if (this.tileModeEnabled) this.applyTileMode();
                this.updateTileOverlay();
            },
            setTileSize(value) {
                let size = parseInt(value, 10);
                if (!Number.isFinite(size) || size < 1) size = this.tileSize;
                this.tileSize = size;
                this.lsSet('paint.tile.size', String(size));
                const input = document.getElementById('tile-size');
                if (input) input.value = size;
                this.updateTileOffsets();
                if (this.tileModeEnabled) this.applyTileMode();
                this.updateTileOverlay();
            },
            setTileGrid(value) {
                let grid = parseInt(value, 10);
                if (!Number.isFinite(grid)) grid = this.tileGrid;
                if (grid < 3) grid = 3;
                if (grid % 2 === 0) grid += 1;
                this.tileGrid = grid;
                this.lsSet('paint.tile.grid', String(grid));
                const input = document.getElementById('tile-grid');
                if (input) input.value = grid;
                this.updateTileOffsets();
                if (this.tileModeEnabled) this.applyTileMode();
                this.updateTileOverlay();
            },
            setTileDarkenEnabled(enabled) {
                this.tileDarkenEnabled = !!enabled;
                this.lsSet('paint.tile.darken', this.tileDarkenEnabled ? 'true' : 'false');
                const toggle = document.getElementById('tile-darken-toggle');
                if (toggle) toggle.checked = this.tileDarkenEnabled;
                this.updateTileOverlay();
            },
            applyTileMode() {
                if (!this.tileModeEnabled) return;
                const tileSize = Math.max(1, this.tileSize);
                const grid = Math.max(3, this.tileGrid);
                const w = tileSize * grid;
                const h = tileSize * grid;
                if (this.state.selection) this.commitSelection();
                if (w === this.config.width && h === this.config.height) {
                    this.updateTileOverlay();
                    return;
                }
                this.setSize(w, h);
                this.ctx.fillStyle = 'white';
                this.ctx.fillRect(0, 0, w, h);
                this.saveState();
                this.updateTileOverlay();
            },
            updateTileOverlay() {
                if (!this.ui.tileOverlay) return;
                if (!this.tileModeEnabled || !this.tileDarkenEnabled) {
                    this.ui.tileOverlay.style.display = 'none';
                    this._tileOverlayCacheKey = '';
                    return;
                }
                this.ui.tileOverlay.style.display = 'block';
                this.ui.tileOverlay.style.width = window.innerWidth + 'px';
                this.ui.tileOverlay.style.height = window.innerHeight + 'px';
                const stageRect = this.ui.stage ? this.ui.stage.getBoundingClientRect() : null;
                if (!stageRect) return;
                const viewW = Math.max(1, Math.round(window.innerWidth));
                const viewH = Math.max(1, Math.round(window.innerHeight));
                this.ui.tileOverlay.setAttribute('width', String(viewW));
                this.ui.tileOverlay.setAttribute('height', String(viewH));
                this.ui.tileOverlay.setAttribute('viewBox', `0 0 ${viewW} ${viewH}`);
                const wrap = this.ui.tileShadeWrap;
                const clipRect = this.ui.tileClipRect;
                const left = Math.round(stageRect.left);
                const top = Math.round(stageRect.top);
                const right = Math.round(stageRect.right);
                const bottom = Math.round(stageRect.bottom);
                const clipLeft = Math.max(0, left);
                const clipTop = Math.max(0, top);
                const clipRight = Math.min(viewW, right);
                const clipBottom = Math.min(viewH, bottom);
                const clipWidth = Math.max(0, clipRight - clipLeft);
                const clipHeight = Math.max(0, clipBottom - clipTop);
                if (clipRect) {
                    clipRect.setAttribute('x', String(clipLeft));
                    clipRect.setAttribute('y', String(clipTop));
                    clipRect.setAttribute('width', String(clipWidth));
                    clipRect.setAttribute('height', String(clipHeight));
                }
                if (!wrap || clipWidth === 0 || clipHeight === 0) {
                    this.ui.tileOverlay.style.display = 'none';
                    this._tileOverlayCacheKey = '';
                    return;
                }
                const tilePx = Math.max(1, Math.round(this.tileSize * (this.config.zoom || 1)));
                const tiles = Math.max(3, this.tileGrid);
                const overlayKey = `${viewW}|${viewH}|${left}|${top}|${tilePx}|${tiles}|${this.tileDarkenOpacity}`;
                if (overlayKey === this._tileOverlayCacheKey) return;
                this._tileOverlayCacheKey = overlayKey;
                wrap.innerHTML = '';
                const center = Math.floor(tiles / 2);
                const fillOpacity = String(this.tileDarkenOpacity);
                for (let row = 0; row < tiles; row++) {
                    for (let col = 0; col < tiles; col++) {
                        if (row === center && col === center) continue;
                        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                        rect.setAttribute('x', String(left + col * tilePx));
                        rect.setAttribute('y', String(top + row * tilePx));
                        rect.setAttribute('width', String(tilePx));
                        rect.setAttribute('height', String(tilePx));
                        rect.setAttribute('fill', '#000000');
                        rect.setAttribute('fill-opacity', fillOpacity);
                        wrap.appendChild(rect);
                    }
                }
            },
            updateTileOffsets() {
                if (!this.tileModeEnabled) {
                    this.tileOffsets = null;
                    return;
                }
                const size = Math.max(1, this.tileSize);
                const tiles = Math.max(3, this.tileGrid);
                const offsets = [];
                for (let row = 0; row < tiles; row++) {
                    for (let col = 0; col < tiles; col++) {
                        offsets.push({ x: col * size, y: row * size });
                    }
                }
                this.tileOffsets = offsets;
            },
            getCenterTileBounds() {
                if (!this.tileModeEnabled) return null;
                const size = Math.max(1, this.tileSize);
                const tiles = Math.max(3, this.tileGrid);
                const center = Math.floor(tiles / 2);
                return { x: center * size, y: center * size, w: size, h: size };
            },
            isPointInCenterTile(x, y) {
                const b = this.getCenterTileBounds();
                if (!b) return true;
                return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
            },
            getTileLocalCoord(value, size) {
                const mod = value % size;
                return mod < 0 ? mod + size : mod;
            },
            fillRectTiled(ctx, x, y, w, h) {
                if (!this.tileModeEnabled || !this.tileOffsets) {
                    ctx.fillRect(x, y, w, h);
                    return;
                }
                if (!this.isPointInCenterTile(x, y)) return;
                const size = Math.max(1, this.tileSize);
                const localX = this.getTileLocalCoord(x, size);
                const localY = this.getTileLocalCoord(y, size);
                for (const off of this.tileOffsets) {
                    ctx.fillRect(off.x + localX, off.y + localY, w, h);
                }
            },
            replicateCenterTile() {
                if (!this.tileModeEnabled) return;
                const size = Math.max(1, this.tileSize);
                const tiles = Math.max(3, this.tileGrid);
                const center = Math.floor(tiles / 2);
                const srcX = center * size;
                const srcY = center * size;
                const tileData = this.ctx.getImageData(srcX, srcY, size, size);
                for (let row = 0; row < tiles; row++) {
                    for (let col = 0; col < tiles; col++) {
                        if (row === center && col === center) continue;
                        this.ctx.putImageData(tileData, col * size, row * size);
                    }
                }
            },
            shouldUseTiledHistory(w, h) {
                return (w * h) >= this.tileHistory.thresholdPixels;
            },
            // The tile is the smallest thing history can store or share, so tile
            // size IS undo granularity. This used to grow with the canvas — 1024 px
            // above 16 MP — which meant touching one pixel on a big document
            // recorded a megapixel of tile, exactly where fine granularity matters
            // most. A fixed small tile costs a longer tile list and buys a ~64x
            // cheaper brush dab; Krita runs 64 px tiles on far larger images.
            _chooseTileSize(w, h) {
                return 128;
            },
            // History depth used to be guessed from canvas size on the assumption
            // that a step cost a whole canvas. It does not: historyByteBudget()
            // measures what history is really holding and trimming works from that.
            // All this does now is keep the readout honest after a resize.
            getSolidTileColor(data) {
                if (data.length < 4) return null;
                const r = data[0];
                const g = data[1];
                const b = data[2];
                const a = data[3];
                for (let i = 4; i < data.length; i += 4) {
                    if (data[i] !== r || data[i + 1] !== g || data[i + 2] !== b || data[i + 3] !== a) {
                        return null;
                    }
                }
                return [r, g, b, a];
            },
            captureTiledSnapshot(canvas, prevMap, anchor, dirty) {
                const tileSize = this.tileHistory.tileSize;
                const width = canvas.width;
                const height = canvas.height;
                const ctx = canvas.getContext('2d');
                const tiles = [];
                let ownedBytes = 0;
                const maxTileBytes = tileSize * tileSize * 4;
                if (!this._tileCopyBuf || this._tileCopyBuf.length < maxTileBytes) {
                    this._tileCopyBuf = new Uint8ClampedArray(maxTileBytes);
                }
                for (let y = 0; y < height; y += tileSize) {
                    const stripH = Math.min(tileSize, height - y);
                    // Rows nothing touched are not read at all — this is where the
                    // saving is. An anchor has to hold everything, so it ignores it.
                    if (dirty && !anchor && (y + stripH - 1 < dirty.y0 || y > dirty.y1)) continue;
                    // Read only the columns in play, not the full width of the
                    // document. A tall narrow edit on a 13000px canvas was pulling
                    // back the entire row band — three times the pixels needed.
                    let stripX = 0, stripW = width;
                    if (dirty && !anchor) {
                        stripX = Math.max(0, Math.floor(dirty.x0 / tileSize) * tileSize);
                        const endX = Math.min(width, Math.ceil((dirty.x1 + 1) / tileSize) * tileSize);
                        stripW = Math.max(tileSize, endX - stripX);
                    }
                    const strip = ctx.getImageData(stripX, y, stripW, stripH);
                    const stripData = strip.data;
                    for (let x = 0; x < width; x += tileSize) {
                        const w = Math.min(tileSize, width - x);
                        const h = Math.min(tileSize, height - y);
                        if (dirty && !anchor && (x + w - 1 < dirty.x0 || x > dirty.x1)) continue;
                        const tileData = this._tileCopyBuf.subarray(0, w * h * 4);
                        for (let row = 0; row < h; row++) {
                            // Offsets are relative to the strip, which may start
                            // part-way across the document.
                            const srcOffset = (row * stripW + (x - stripX)) * 4;
                            tileData.set(stripData.subarray(srcOffset, srcOffset + w * 4), row * w * 4);
                        }
                        const solid = this.getSolidTileColor(tileData);
                        if (solid) {
                            // Flat tiles were the one case that never shared, so a
                            // dab on a mostly-empty canvas still minted a descriptor
                            // for every other tile in the document.
                            const prevSolid = prevMap && prevMap.get(x + ',' + y);
                            if (prevSolid && prevSolid.solid &&
                                prevSolid.solid[0] === solid[0] && prevSolid.solid[1] === solid[1] &&
                                prevSolid.solid[2] === solid[2] && prevSolid.solid[3] === solid[3]) {
                                // Unchanged: an anchor still has to carry it, a
                                // delta leaves it to the step it came from.
                                if (anchor) tiles.push(prevSolid);
                            } else {
                                tiles.push({ x, y, w, h, solid });
                                ownedBytes += 48;            // a fresh descriptor object
                            }
                        } else {
                            const rle = this._rleEncode(tileData);
                            if (prevMap) {
                                const prev = prevMap.get(x + ',' + y);
                                if (prev && prev.rle && this._rleEqual(prev.rle, rle)) {
                                    // Unchanged. Tiles are never mutated after
                                    // capture, so an anchor can reuse the whole
                                    // descriptor; a delta omits it entirely.
                                    if (anchor) tiles.push(prev);
                                } else {
                                    tiles.push({ x, y, w, h, rle });
                                    ownedBytes += 48 + rle.length;
                                }
                            } else {
                                tiles.push({ x, y, w, h, rle });
                                ownedBytes += 48 + rle.length;
                            }
                        }
                    }
                }
                // One array slot per tile the entry actually holds. A delta holds
                // only what changed, which is the whole point.
                ownedBytes += tiles.length * 8 + 64;
                return { width, height, tileSize, tiles, ownedBytes };
            },
            /* ── Dirty-region tracking ────────────────────────────────────────
             * Capturing a history step used to read and re-encode the whole canvas
             * however little had changed: 618 ms on a 13000px document for a
             * six-pixel dab. Knowing which part was touched turns that into a few
             * milliseconds.
             *
             * Trusting each tool to declare what it touched would be a quiet
             * disaster — a tool that understates its area produces an undo that
             * restores the wrong pixels, and you would not find out for a long
             * time. So nothing is trusted. Drawing contexts are wrapped, the
             * wrapper works out the affected rectangle itself, and ANY operation it
             * does not fully understand falls back to "assume everything changed".
             * The failure mode is a slow capture, never a wrong one.
             */
            /* Recording an undo step has to read the canvas back, and that read
             * waits for whatever was just painted to finish on the GPU. After a
             * fat brush stroke that wait is most of half a second, during which
             * nothing else can happen — the tail of the stroke cannot appear and a
             * second stroke cannot start.
             *
             * Letting the browser get on with it first and recording a moment later
             * costs the same total work but takes it off the path between one
             * stroke and the next. Anything that would touch the canvas flushes the
             * pending record first, so history can never merge two edits into one
             * step or record them out of order. */
            _resolveTiles(entry) {
                const chain = [];
                let e = entry, guard = 0;
                while (e) {
                    chain.push(e);
                    if (!e.base) break;
                    e = e.base;
                    // The anchor interval bounds this; the guard is for a chain
                    // that somehow lost its anchor, so restore degrades rather
                    // than hanging.
                    if (++guard > 100000) { console.warn('[History] runaway tile chain'); break; }
                }
                const map = new Map();
                for (let i = chain.length - 1; i >= 0; i--) {
                    for (const t of chain[i].tiles) map.set(t.x + ',' + t.y, t);
                }
                return map;
            },

            /* Flatten an entry so it no longer depends on anything earlier. Needed
             * before the entry it links through is dropped — by eviction from the
             * front, or by removing one from the middle. */
            applyTiledSnapshot(snapshot) {
                const ctx = this.ctx;
                const { width, height } = snapshot;
                const tiles = snapshot.base
                    ? Array.from(this._resolveTiles(snapshot).values())
                    : snapshot.tiles;
                for (const tile of tiles) {
                    if (tile.solid) continue;
                    const data = tile.rle ? this._rleDecode(tile.rle, tile.w, tile.h) : tile.data;
                    ctx.putImageData(new ImageData(data, tile.w, tile.h), tile.x, tile.y);
                }
                for (const tile of tiles) {
                    if (!tile.solid) continue;
                    const r = tile.solid[0];
                    const g = tile.solid[1];
                    const b = tile.solid[2];
                    const a = tile.solid[3];
                    if (a === 0) {
                        ctx.clearRect(tile.x, tile.y, tile.w, tile.h);
                    } else if (a === 255) {
                        ctx.fillStyle = `rgb(${r},${g},${b})`;
                        ctx.fillRect(tile.x, tile.y, tile.w, tile.h);
                    } else {
                        const alpha = Math.round((a / 255) * 1000) / 1000;
                        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
                        ctx.fillRect(tile.x, tile.y, tile.w, tile.h);
                    }
                }
            },
            initGapStitcherUI() {
                // Link every number input to its readout label
                const linkNumVal = (inputId, valId) => {
                    const inp = document.getElementById(inputId);
                    const val = document.getElementById(valId);
                    if (!inp || !val) return;
                    inp.addEventListener('input', () => { val.textContent = inp.value; });
                };
                linkNumVal('stitch-radius',     'stitch-radius-val');
                linkNumVal('stitch-min-mass',   'stitch-min-mass-val');
                linkNumVal('stitch-tolerance',  'stitch-tolerance-val');
                linkNumVal('stitch-iterations', 'stitch-iterations-val');

                const applyBtn = document.getElementById('stitch-apply-btn');
                if (applyBtn) applyBtn.addEventListener('click', () => this.applyGapStitcher(false));

                const applyCloseBtn = document.getElementById('stitch-apply-close-btn');
                if (applyCloseBtn) applyCloseBtn.addEventListener('click', () => this.applyGapStitcher(true));
            },


            // ── Colour helpers ────────────────────────────────────────────────────
            applyGapStitcher(closeAfter = false) {
                const p = this._gsReadParams();
                const result = this._gsCompute(p);
                if (!result) return;
                if (this.state.selection) this.commitSelection();
                this.disableSmoothing(this.ctx);
                this.ctx.putImageData(result, 0, 0);
                this.saveState();
                if (closeAfter) this.closeGapStitchModal();
            }

            // ── Core computation — returns final ImageData or null ─────────────────
    });
})();
