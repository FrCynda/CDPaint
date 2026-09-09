/* project-assets — moved verbatim off the PaintEngine class body.
 *
 * Assigned onto the prototype, so `this` is the same PaintEngine instance
 * these methods have always run against. Loads after paint-engine.js and
 * before boot.js, which is where the instance is finally created.
 */
(function () {
    Object.assign(PaintEngine.prototype, {
            projectConformance(colorCount) {
                if (!this.state.projectImage || !this.state.projectFile) return null;
                const profile = this.inferProfile(this.state.projectFile);
                const w = this.config.width, h = this.config.height;
                const parts = [];
                let ok = true;

                const sizes = profile.allowedResolutions;
                const sizeOk = !sizes || sizes.some(r => r[0] === w && r[1] === h);
                if (!sizeOk) ok = false;
                parts.push({ text: `${w}×${h}`, ok: sizeOk });

                const max = this.maxColorsForProfile(profile);
                const used = Number.isFinite(colorCount) ? colorCount : this._lastKnownColorCount;
                if (Number.isFinite(used)) {
                    const colorsOk = used <= max;
                    if (!colorsOk) ok = false;
                    parts.push({ text: `${used}/${max} colours`, ok: colorsOk });
                }

                if (profile.tileAligned || w % 8 === 0) {
                    const tileOk = w % 8 === 0 && h % 8 === 0;
                    if (profile.tileAligned && !tileOk) ok = false;
                    parts.push({ text: tileOk ? 'tiles ✓' : 'not 8×8', ok: tileOk });
                }

                /* Nothing standing on the transparent slot means the background is
                   opaque — the "why has my sprite got a black box round it" bug (F1),
                   invisible in the editor because the editor has no battle scene behind
                   the canvas. Worth a red light of its own.

                   The slot is 0, not whatever the PNG's tRNS names. Transparency here
                   is a hardware rule — the GBA draws palette entry 0 of a sprite as
                   see-through — and tRNS is only how a PNG viewer is told about it. The
                   two disagree in the wild: togedemaru's front sprite carries a tRNS
                   naming slot 15, which nothing stands on, while slot 0 holds the
                   background exactly as it should. Reading tRNS called that broken.
                   `projectTransparentIndex` still drives *saving*, where matching the
                   file's own chunk is the right thing to do. */
                if (profile.wantsTransparency) {
                    const map = this.state.projectIndices;
                    let clear = 0;
                    if (map) for (let q = 0; q < map.length; q++) if (map[q] === 0) clear++;
                    const clearOk = clear > 0;
                    if (!clearOk) ok = false;
                    parts.push({
                        text: clearOk ? 'slot 0 clear' : 'slot 0 unused — opaque background',
                        ok: clearOk
                    });
                }

                const slot = this.paletteSlotFor(this.config.activeSlot);
                if (slot >= 0) parts.push({ text: `slot ${slot}`, ok: true });

                return { label: profile.label, parts, ok };
            },
            updateProjectConformance(colorCount) {
                const el = this.ui.statusConformance || document.getElementById('status-conformance');
                if (!el) return;
                this.ui.statusConformance = el;
                const info = this.projectConformance(colorCount);
                if (!info) { el.style.display = 'none'; el.textContent = ''; return; }
                el.style.display = 'block';
                el.textContent = '';
                el.title = info.label;
                info.parts.forEach((p, i) => {
                    if (i) el.appendChild(document.createTextNode(' · '));
                    const span = document.createElement('span');
                    span.textContent = p.text;
                    if (!p.ok) span.className = 'conformance-bad';
                    el.appendChild(span);
                });
                el.classList.toggle('conformance-ok', info.ok);
                this.updateConformanceBanner(info);
            },

            /* The status line is a glance; when the asset would not build, that is not
               enough. Raise a bar that cannot be missed and put the fix on it.
               Dismissing is remembered against the exact set of problems, so hiding it
               does not also hide the next, different one. */
            clearProjectAssetState() {
                this.state.projectFile = null;
                this.state.projectHandle = null;
                this.state.palettes = [];
                this.state.activePaletteId = null;
                this.state.previewPaletteId = null;
                this.state.previewSnapshot = null;
                this.state.projectImage = false;
                this.state.projectBitDepth = 4;
                this.state.projectIndices = null;
                this.state.projectTrns = null;
                this.state.projectTransparentIndex = -1;
                this.stopFramePlayback();
                this.state.activeFrame = 0;
                this.state.frameCountOverride = null;
                this.state.frameHold = 0;
                this.state.onionSkin = false;
                this.updateFrameOverlays();
                if (this.onPalettesChanged) this.onPalettesChanged();
                if (this.onFramesChanged) this.onFramesChanged();
            },
            toggleProjectPanel() {
                if (window.PokeProject && typeof window.PokeProject.toggle === 'function') window.PokeProject.toggle();
                this.syncToolGridActive();
            },
            _buildBrushSprite(color, isSquare, width) {
                const s = Math.ceil(width);
                const r = width / 2;
                const c = document.createElement('canvas');
                c.width = s; c.height = s;
                const ctx = c.getContext('2d');
                this.disableSmoothing(ctx);
                ctx.fillStyle = color;
                const center = s / 2;
                if (isSquare) {
                    ctx.fillRect(0, 0, s, s);
                } else {
                    // Rasterise the circle manually pixel-by-pixel to keep it hard-edged.
            // ctx.arc() + fill() applies sub-pixel antialiasing which blurs thin strokes
            // and makes pencil/pixel tools feel mushy.
                    for (let i = 0; i < s; i++) {
                        for (let j = 0; j < s; j++) {
                            const dx = (i + 0.5) - center;
                            const dy = (j + 0.5) - center;
                            if (dx*dx + dy*dy <= r*r) ctx.fillRect(i, j, 1, 1);
                        }
                    }
                }
                return { canvas: c, color, size: width, isSquare, offset: Math.floor(s / 2) };
            },

            // 4-slot LRU cache for brush sprite canvases.
            // Cache key format: "<hex-color>|<size>|<0-or-1-for-isSquare>".
            // Sprites for the same colour+size+shape are reused across dabs to avoid
            // rebuilding them on every mouse move.
            drawSpriteTiled(ctx, sprite, pixelX, pixelY, offset) {
                if (!this.tileModeEnabled || !this.tileOffsets) {
                    ctx.drawImage(sprite, pixelX - offset, pixelY - offset);
                    return;
                }
                if (!this.isPointInCenterTile(pixelX, pixelY)) return;
                const size = Math.max(1, this.tileSize);
                const localX = this.getTileLocalCoord(pixelX, size);
                const localY = this.getTileLocalCoord(pixelY, size);
                for (const off of this.tileOffsets) {
                    ctx.drawImage(sprite, off.x + localX - offset, off.y + localY - offset);
                }
            },
            async openProjectImage(path, palNodes) {
                if (!this.getTauriInvokeFn() || !path) {
                    if (!this.state.hasDocument) this.initializeBlankDocument();
                    return false;
                }
                const normalizedPath = this.normalizeIncomingPath(path);
                if (!this.isSupportedImagePath(normalizedPath)) {
                    showToast('Unsupported project image: ' + normalizedPath, 'warning');
                    return false;
                }
                if (this.hasUnsavedChanges()) {
                    return new Promise((resolve) => {
                        this.showOpenConfirm(async () => {
                            const r = await this.openProjectImage(path, palNodes);
                            resolve(r);
                        }, 'Opening a new file');
                    });
                }
                try {
                    const bytes = await this.tauriReadImageBytes(normalizedPath);
                    return await this.applyProjectImageBytes(bytes, this.getFilenameFromPath(normalizedPath), normalizedPath, palNodes);
                } catch (err) {
                    console.error('Failed to open project image', err);
                    showToast('Failed to open project image: ' + this.getErrorText(err), 'error');
                    if (!this.state.hasDocument) this.initializeBlankDocument();
                    return false;
                }
            },
            /* `sourcePath` is where the bytes came from on disk; `identity` is what the
               asset *is* within the project. They are the same thing when a real path
               was opened, but a directory handle has no path — only a project-relative
               one — and that relative path is what every decomp rule keys on. Which
               frames the sheet holds, what size it should be, which species declares
               its coordinates: all of it is `inferProfile(state.projectFile)`, and all
               of it silently degrades to the `default` profile when that is a bare
               filename. Hence two arguments rather than one. */
            async applyProjectImageBytes(bytes, fallbackName, sourcePath, palNodes, identity) {
                const meta = this.parsePngPalette(bytes);
                if (meta.colorType !== 3 || !meta.palette || !meta.palette.length) {
                    if (sourcePath) {
                        showToast('Project image is not an indexed PNG; opening normally', 'warning');
                        return this.openFileFromPath(sourcePath, true);
                    }
                    showToast('Project image is not an indexed PNG', 'warning');
                    return false;
                }
                const blob = new Blob([bytes], { type: 'image/png' });
                const bmp = await createImageBitmap(blob);
                const w = meta.width, h = meta.height;
                this.state.projectFile = identity || sourcePath || fallbackName;
                this.state.history = [];
                this.state.step = -1;
                if (this.state.selection) this.cancelSelection();
                const embeddedColors = meta.palette.map(c => ({ r: c.r, g: c.g, b: c.b, a: c.a === undefined ? 255 : c.a }));
                const palettes = await this.buildProjectPalettes(embeddedColors, palNodes);
                const active = palettes[0];
                this.palette = active ? active.colors : embeddedColors;
                this.basePalette = this.palette;
                this.paletteLab = null;
                this.bitDepth = 24;
                this.state.projectBitDepth = meta.bitDepth || 4;
                this.paletteLocked = false;
                this.state.palettes = palettes;
                this.state.activePaletteId = active ? active.id : null;
                this.state.projectImage = true;
                // Drop the outgoing document's map before a pixel of this one lands:
                // anything that commits in between must resolve from scratch rather
                // than snap this artwork onto the last asset's slots.
                this.state.projectIndices = null;
                // Likewise its frame reading — a count the artist fixed by hand for one
                // sheet says nothing about the next.
                this.stopFramePlayback();
                this.state.activeFrame = 0;
                this.state.frameCountOverride = null;
                this.state.frameHold = 0;
                this.state.projectTrns = meta.trns ? new Uint8Array(meta.trns) : null;
                this.state.projectTransparentIndex = this.transparentIndexFromTrns(meta.trns);
                this.setSize(w, h);
                this.ctx.drawImage(bmp, 0, 0);
                await this.applyCurrentModeToCanvasAsync(this.ctx, w, h, false);
                // The file's own indices seed the live map. From here the map is the
                // document: every committed edit folds the canvas back into it, so
                // nothing has to remember what the file looked like on disk.
                const trueIndices = await this.decodePngIndices(meta);
                try {
                    this.state.projectIndices = (trueIndices && trueIndices.length === w * h)
                        ? trueIndices
                        : this.quantizeToIndices(this.ctx.getImageData(0, 0, w, h).data, w, h,
                            this.basePalette || this.palette);
                } catch (e) {
                    this.state.projectIndices = null;
                }
                if (!trueIndices) {
                    console.warn('Could not decode PNG indices; falling back to nearest-colour reconstruction');
                }
                this.state.hasDocument = true;
                this.state.filePath = sourcePath || '';
                this.state.fileName = fallbackName || this.getFilenameFromPath(sourcePath || '');
                this.config.paletteSlot = { 1: -1, 2: -1 };
                this.renderQuantPalette();
                this.updateProjectConformance();
                this.updateFrameOverlays();
                if (this.onPalettesChanged) this.onPalettesChanged();
                if (this.onFramesChanged) this.onFramesChanged();
                this.saveState();
                this.markSaved(this.state.fileName);
                this.addRecentFile({ name: this.state.fileName, path: sourcePath || '' });
                if (bmp.close) bmp.close();
                return true;
            },
            async openProjectImageFromHandle(node, palNodes) {
                if (!node || !node.handle) {
                    showToast('No file handle for this asset', 'warning');
                    return false;
                }
                if (this.hasUnsavedChanges()) {
                    return new Promise((resolve) => {
                        this.showOpenConfirm(async () => {
                            const r = await this.openProjectImageFromHandle(node, palNodes);
                            resolve(r);
                        }, 'Opening a new file');
                    });
                }
                try {
                    let file;
                    if (node.handle instanceof File) file = node.handle;
                    else if (typeof node.handle.getFile === 'function') file = await node.handle.getFile();
                    else { showToast('Unsupported file handle', 'warning'); return false; }
                    const bytes = new Uint8Array(await file.arrayBuffer());
                    // No disk path to record, but `node.path` is the project-relative
                    // one the tree walked to get here — that is the asset's identity.
                    const ok = await this.applyProjectImageBytes(bytes, node.name, '', palNodes, node.path || '');
                    if (ok) {
                        this.state.projectHandle = node.handle || null;
                    }
                    return ok;
                } catch (err) {
                    console.error('Failed to open project image', err);
                    showToast('Failed to open project image: ' + this.getErrorText(err), 'error');
                    if (!this.state.hasDocument) this.initializeBlankDocument();
                    return false;
                }
            },
            /* The live index map. It lives on `state` so a tab switch carries it with
               the rest of the document; `spriteIndices` is the name the drawing code
               has always used for it. */
            projectIndexSurface() {
                const mgr = this.layerMgr;
                if (!mgr || !mgr.active || mgr.layers.length <= 1) return { ctx: this.ctx, canSnap: true };
                let ctx = null;
                try { ctx = this.ui.cMain.getContext('2d', { willReadFrequently: true }); } catch (e) {}
                return { ctx, canSnap: false };
            },

            /* Indices for the pixels in `d`.
               The index map is the document, so it is also the baseline: a pixel still
               showing the colour of the slot it holds was not painted and keeps that
               slot — which is how two slots sharing an RGB both survive a round trip.
               Anything else was just painted, and resolves to the slot in hand, then to
               a slot holding exactly that colour, then to the nearest one. A transparent
               pixel means the transparency slot, never "whatever is nearest to black".

               Pure: it reads the map and returns a new one. commitProjectIndices() is
               what installs the result.

               Known limit: painting slot 14 over a pixel that already holds slot 11 of
               the *same* colour is indistinguishable from not painting at all, and the
               conservative reading wins — renumbering on a guess is how the shiny
               palette gets silently rewritten (finding F3). Telling the two apart needs
               per-pixel stroke coverage, not a colour comparison. */
            buildProjectIndices(d, w, h) {
                const palette = this.palette || [];
                const n = w * h;
                const map = this.state.projectIndices;
                const known = (map && map.length === n) ? map : null;
                const transparentIdx = this.state.projectTransparentIndex;

                const exact = new Map();
                for (let i = 0; i < palette.length; i++) {
                    const key = (palette[i].r << 16) | (palette[i].g << 8) | palette[i].b;
                    if (!exact.has(key)) exact.set(key, i); // first slot wins unless a picked slot says otherwise
                }
                /* Where the artist picked a slot off the palette strip, painted pixels
                   resolve to that slot rather than to the first one sharing its colour.
                   Without this, painting with Magikarp's slot 14 would land on slot 11
                   and only show up as wrong in the shiny palette. */
                for (const colorSlot of [1, 2]) {
                    const picked = this.paletteSlotFor(colorSlot);
                    const c = picked >= 0 ? palette[picked] : null;
                    if (c) exact.set((c.r << 16) | (c.g << 8) | c.b, picked);
                }

                const indices = new Uint8Array(n);
                for (let p = 0, q = 0; q < n; p += 4, q++) {
                    const a = d[p + 3];
                    if (known) {
                        const slot = known[q];
                        if (slot === transparentIdx) {
                            if (a < 128) { indices[q] = slot; continue; }
                        } else {
                            const c = palette[slot];
                            if (c && a >= 128 && d[p] === c.r && d[p + 1] === c.g && d[p + 2] === c.b) {
                                indices[q] = slot;
                                continue;
                            }
                        }
                    }
                    if (a < 128 && transparentIdx >= 0) {
                        indices[q] = transparentIdx;
                        continue;
                    }
                    const idx = exact.get((d[p] << 16) | (d[p + 1] << 8) | d[p + 2]);
                    indices[q] = idx === undefined
                        ? this._nearestPaletteIndex(d[p], d[p + 1], d[p + 2])
                        : idx;
                }
                return indices;
            },

            /* Repaint the surface from the map, so what is on screen is exactly what
               the file will contain. This is what makes the colour ceiling structural:
               a blended or antialiased pixel does not survive the step it was made in,
               it lands on the slot it resolved to. */
            paintProjectIndicesOnto(img, indices, ctx, w) {
                const d = img.data;
                const palette = this.palette || [];
                const transparentIdx = this.state.projectTransparentIndex;
                let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                const touch = (q) => {
                    const x = q % w, y = (q / w) | 0;
                    if (x < x0) x0 = x; if (x > x1) x1 = x;
                    if (y < y0) y0 = y; if (y > y1) y1 = y;
                };
                for (let p = 0, q = 0; q < indices.length; p += 4, q++) {
                    const slot = indices[q];
                    if (slot === transparentIdx) {
                        if (d[p + 3] === 0) continue;
                        d[p] = 0; d[p + 1] = 0; d[p + 2] = 0; d[p + 3] = 0;
                        touch(q);
                        continue;
                    }
                    // Erased, on an asset with no transparency slot to erase to. There
                    // is nothing honest to draw, so leave the pixel alone rather than
                    // inventing an opaque colour underneath the artist's eraser.
                    if (d[p + 3] < 128) continue;
                    const c = palette[slot];
                    if (!c) continue;
                    if (d[p] === c.r && d[p + 1] === c.g && d[p + 2] === c.b && d[p + 3] === 255) continue;
                    d[p] = c.r; d[p + 1] = c.g; d[p + 2] = c.b; d[p + 3] = 255;
                    touch(q);
                }
                if (x1 < x0) return false;
                // Write back only the box that moved. A full-canvas putImageData would
                // report the whole surface as dirty and cost tiled history its deltas
                // on every step, on exactly the assets big enough to use them.
                const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
                const sub = ctx.createImageData(bw, bh);
                for (let y = 0; y < bh; y++) {
                    const from = ((y0 + y) * w + x0) * 4;
                    sub.data.set(d.subarray(from, from + bw * 4), y * bw * 4);
                }
                ctx.putImageData(sub, x0, y0);
                return true;
            },

            /* Fold the canvas back into the index map and pull the canvas onto the
               palette. Runs at the top of every committed step, which is what keeps
               the map live while painting — the save then writes the map rather than
               reconstructing one from RGB. */
            commitProjectIndices() {
                if (!this.state.projectImage) return null;
                if (this.state.previewPaletteId) return this.state.projectIndices; // showing someone else's colours
                const palette = this.palette;
                if (!palette || !palette.length) return null;
                const w = this.config.width, h = this.config.height;
                if (!w || !h) return null;
                const { ctx, canSnap } = this.projectIndexSurface();
                if (!ctx) return null;
                let img;
                try { img = ctx.getImageData(0, 0, w, h); }
                catch (e) { return this.state.projectIndices; }
                const indices = this.buildProjectIndices(img.data, w, h);
                if (canSnap) this.paintProjectIndicesOnto(img, indices, ctx, w);
                // Steps that left every slot alone keep the array they had, so history
                // shares one copy instead of one per step.
                const cur = this.state.projectIndices;
                if (cur && cur.length === indices.length) {
                    let same = true;
                    for (let q = 0; q < indices.length; q++) {
                        if (cur[q] !== indices[q]) { same = false; break; }
                    }
                    if (same) return cur;
                }
                this.state.projectIndices = indices;
                return indices;
            },

            /* Repaint a project asset from its index map under whatever the palette
               says now. Change slot 9 and every pixel holding slot 9 follows — nothing
               re-quantises, no index moves, and the pixels that were already right are
               left alone (paintProjectIndicesOnto only writes the box that moved).
               Records a step, so the edit is undoable along with the palette itself. */
            renumberProjectIndices(table) {
                if (!this.state.projectImage) return false;
                const map = this.state.projectIndices;
                if (!map || !table) return false;
                const next = new Uint8Array(map.length);
                let moved = false;
                for (let q = 0; q < map.length; q++) {
                    const to = table[map[q]];
                    next[q] = to === undefined ? map[q] : to;
                    if (next[q] !== map[q]) moved = true;
                }
                if (!moved) return false;
                this.state.projectIndices = next;
                return true;
            },

            /* The colours the map is being read through, flattened. A project asset's
               document is the pair — indices alone mean nothing without them, which is
               why both have to travel with history. */
            attachProjectStep(entry) {
                if (!entry || !this.state.projectImage) return;
                const prev = this.state.history[this.state.step - 1];
                const idx = this.state.projectIndices;
                if (idx) {
                    entry.projectIndices = idx;
                    entry._sharesIndices = !!(prev && prev.projectIndices === idx);
                    if (!entry._sharesIndices && typeof entry._bytes === 'number') entry._bytes += idx.length;
                }
                const pal = this.projectPaletteSnapshot();
                if (!pal) return;
                // Most steps do not touch the palette; those share the previous one.
                const before = prev && prev.projectPalette;
                const same = !!(before && before.length === pal.length
                    && before.every((v, i) => v === pal[i]));
                entry.projectPalette = same ? before : pal;
                entry.projectPaletteId = this.state.activePaletteId;
                // Both saveState paths converge here for a project asset, which makes
                // it the one place the frame views can be sure the pixels have settled.
                this.refreshFrameViews();
            },

            restoreProjectStep(entry) {
                if (!this.state.projectImage || !entry) return;
                if (entry.projectIndices) this.state.projectIndices = entry.projectIndices;
                this.refreshFrameViews();
                const pal = entry.projectPalette;
                const target = pal ? this.getPaletteById(entry.projectPaletteId) : null;
                if (!target) return;
                // Write the values back into the live array rather than replacing it:
                // palette, basePalette and the palette record all point at that one
                // array, and swapping it would leave two of the three stale.
                const colors = target.colors;
                colors.length = pal.length / 4;
                for (let i = 0; i < colors.length; i++) {
                    colors[i] = { r: pal[i * 4], g: pal[i * 4 + 1], b: pal[i * 4 + 2], a: pal[i * 4 + 3] };
                }
                this.palette = colors;
                this.basePalette = colors;
                this.state.activePaletteId = entry.projectPaletteId;
                this.paletteLab = null;
                this.renderQuantPalette();
                if (this.onPalettesChanged) this.onPalettesChanged();
            },

            /* ── Validation without a build ─────────────────────────────────────
               Two different questions get asked about a Gen 3 asset and they are
               routinely confused, so this keeps them apart:

                 build — gbagfx would refuse it, and `make` stops.
                 game  — it builds perfectly and then looks wrong. Nothing in the
                         toolchain will ever say a word about these.

               Both matter; only one of them stops the build, and an artist deserves to
               know which they are looking at. Runs off the file's bytes, so it needs
               neither the document nor a compiler.

               Every build rule below was read out of gbagfx's own source, not
               remembered, because the folklore is wrong in both directions:

                 convert_png.c:90   colour type must be GRAY or PALETTE. A greyscale
                                    PNG is perfectly acceptable — 64 stock expansion
                                    assets are greyscale and build fine.
                 convert_png.c:129  bit depth must be 1, 2, 4 or 8.
                 gfx.c:416,419      width and height must each be a multiple of 8.

               And nothing anywhere compares the PLTE length to the target depth. A
               4bpp asset whose PNG carries 256 palette entries builds without
               complaint (gfx.c:371 handles that case explicitly), which is how 196
               stock expansion assets were being called broken.

               The reverse error matters more. ConvertBitDepth (convert_png.c) reduces
               an over-deep index with

                   pixel = value % (1 << destBitDepth)

               so an 8bpp PNG using index 20 does *not* fail a 4bpp build — it becomes
               index 4 and the sprite renders in the wrong colours. That is the worst
               shape a problem can have: clean build, wrong picture, no diagnostic. It
               belongs in `game`, and it has to be checked always rather than only when
               some other check happened to pass. */
            async validateProjectAsset(bytes, path) {
                const profile = this.inferProfile(path);
                const out = { path, label: profile.label, problems: [], info: null };
                const fail = (kind, id, text) => out.problems.push({ kind, id, text });

                let meta = null;
                try { meta = this.parsePngPalette(bytes); } catch (e) { /* not a PNG */ }
                if (!meta || !meta.width || !meta.height) {
                    fail('build', 'unreadable', 'not a readable PNG');
                    out.ok = false; out.buildOk = false;
                    return out;
                }
                const w = meta.width, h = meta.height, depth = meta.bitDepth || 8;
                const colors = (meta.palette && meta.palette.length) || 0;
                out.info = { w, h, depth, colors, indexed: meta.colorType === 3, trns: !!meta.trns };

                // Greyscale (0) and palette (3) are what gbagfx accepts; anything with
                // real colour channels it refuses outright.
                if (meta.colorType !== 3 && meta.colorType !== 0) {
                    fail('build', 'notIndexed',
                        `colour type ${meta.colorType} — gbagfx takes indexed or greyscale only`);
                }
                if (![1, 2, 4, 8].includes(depth)) {
                    fail('build', 'depth', `${depth}-bit; gbagfx takes 1, 2, 4 or 8`);
                }
                /* Everything the GBA *draws* is built out of 8×8 tiles; a partial tile
                   has nowhere to go. A palette stored as a picture is never drawn, so
                   the rule does not apply to it — 16×1 is exactly right for one. */
                if (!profile.notArtwork && (w % 8 || h % 8)) {
                    fail('build', 'tiles', `${w}×${h} is not a whole number of 8×8 tiles`);
                }
                if (profile.requiredWidth && w !== profile.requiredWidth) {
                    fail('build', 'width', `tilesets must be ${profile.requiredWidth}px wide, not ${w}`);
                }

                /* The target depth is the slot's, not the file's. A PLTE longer than
                   the target holds is not a problem by itself — only an *index* the
                   target cannot express, and that one is silent.

                   Where the path does not say what the slot is (`depthGuessed`), the
                   file's own depth is the only evidence there is, and asserting 4bpp
                   anyway accused 100 stock 8bpp assets of drawing the wrong colours.
                   Silence beats a confident wrong answer; the project's own INCBIN line
                   is the real authority and reading it is 3.1's job. */
                const target = (!profile.depthGuessed && profile.bitDepth) || depth || 4;
                const budget = Number.isFinite(profile.maxColors) ? profile.maxColors : (1 << target);
                let idx = null;
                const indices = async () => (idx !== null ? idx : (idx = await this.decodePngIndices(meta)));

                if (meta.colorType === 3 && (depth > target || colors > budget)) {
                    const px = await indices();
                    if (px) {
                        let worst = -1;
                        for (let q = 0; q < px.length; q++) if (px[q] > worst) worst = px[q];
                        if (worst >= budget) {
                            fail('game', 'index',
                                `uses index ${worst}, which a ${target}bpp slot cannot hold — ` +
                                `it builds, then draws it as index ${worst % budget}`);
                        }
                    }
                }

                const sizes = profile.allowedResolutions;
                if (sizes && !sizes.some(r => r[0] === w && r[1] === h)) {
                    fail('game', 'size',
                        `${w}×${h}; this slot expects ${sizes.map(r => r[0] + '×' + r[1]).join(' or ')}`);
                }

                /* Transparency is a hardware rule, not a file one: the GBA draws
                   palette entry 0 of a sprite as see-through, whatever the PNG's tRNS
                   happens to say. Trusting tRNS instead flagged togedemaru's front
                   sprite — its tRNS names slot 15, which nothing stands on, while slot
                   0 holds the background exactly as it should. Ask the question the
                   hardware asks. */
                if (profile.wantsTransparency) {
                    const px = await indices();
                    if (px) {
                        let clear = 0;
                        for (let q = 0; q < px.length; q++) if (px[q] === 0) clear++;
                        if (!clear) {
                            fail('game', 'slot0',
                                'nothing on slot 0; the background will be solid in game');
                        }
                    }
                }

                out.buildOk = !out.problems.some(p => p.kind === 'build');
                out.ok = out.problems.length === 0;
                return out;
            },

            /* Every asset that would fail, listed. `read` turns an entry into bytes;
               the caller owns that because desktop and browser mode get at files in
               completely different ways. Reads are sequential on purpose — a decomp has
               thousands of PNGs and firing them all at once buries the main thread. */
            async auditProjectAssets(entries, read, onProgress) {
                const results = [];
                let done = 0;
                for (const entry of (entries || [])) {
                    let result;
                    try {
                        result = await this.validateProjectAsset(await read(entry), entry.path || entry.name);
                    } catch (e) {
                        result = {
                            path: entry.path || entry.name, label: 'Project asset', info: null,
                            ok: false, buildOk: false,
                            problems: [{ kind: 'build', id: 'unreadable', text: this.getErrorText(e) }]
                        };
                    }
                    result.name = entry.name;
                    results.push(result);
                    done++;
                    if (onProgress && (done % 25 === 0 || done === entries.length)) {
                        onProgress(done, entries.length);
                        // Let the panel paint; a scan of a whole decomp is not instant.
                        await new Promise(r => setTimeout(r, 0));
                    }
                }
                return {
                    total: results.length,
                    clean: results.filter(r => r.ok).length,
                    wontBuild: results.filter(r => !r.buildOk),
                    wrongInGame: results.filter(r => r.buildOk && !r.ok),
                    results
                };
            },

            /* ── Fit to target ──────────────────────────────────────────────────
               Everything here works on a plain value — size, index map, palette,
               transparency slot — rather than on the live canvas. That is what lets
               the dialog show a real "after" instead of a description of one: the
               fixes are run on a copy, drawn, and only installed if the artist says
               yes. It also means each fix is a small pure function that can be tested
               on its own, which matters, because these are the operations that can
               destroy someone's work. */
            projectDocValue() {
                if (!this.state.projectImage) return null;
                const map = this.state.projectIndices;
                const w = this.config.width, h = this.config.height;
                if (!map || map.length !== w * h) return null;
                return {
                    w, h,
                    map: new Uint8Array(map),
                    colors: (this.palette || []).map(c => ({ r: c.r, g: c.g, b: c.b, a: c.a === undefined ? 255 : c.a })),
                    transparentIdx: this.state.projectTransparentIndex
                };
            },

            /* Everything the asset would have to change to be insertable, as a list of
               named fixes. Nothing here touches the document.

               `docIn` is for art that is not the open document yet — an imported PNG
               being measured against the slot it is going into. The profile still
               comes from `state.projectFile`, because the destination is what decides
               what "insertable" means; the pixels are the only thing that differs. */
            async importIntoProjectSlot(file) {
                if (!this.state.projectImage || !this.state.projectFile) return false;
                let bmp;
                try {
                    bmp = await createImageBitmap(file);
                } catch (e) {
                    showToast('Could not read that image', 'warning');
                    return false;
                }
                const surface = document.createElement('canvas');
                surface.width = bmp.width;
                surface.height = bmp.height;
                const sctx = surface.getContext('2d', { willReadFrequently: true });
                sctx.drawImage(bmp, 0, 0);
                const data = sctx.getImageData(0, 0, bmp.width, bmp.height).data;
                const doc = this.docFromImageData(data, bmp.width, bmp.height);
                if (bmp.close) bmp.close();
                this.openFitToTarget(doc, 'Import ' + (file.name || 'image'));
                return true;
            },

            /* Draw a document value. Used for both halves of the before/after, so the
               two are guaranteed to be rendered the same way. */
            renderProjectDocInto(canvas, doc, scale) {
                if (!canvas || !doc) return false;
                const z = Math.max(1, Math.round(scale || 1));
                canvas.width = doc.w * z;
                canvas.height = doc.h * z;
                canvas.style.width = canvas.width + 'px';
                canvas.style.height = canvas.height + 'px';
                const native = document.createElement('canvas');
                native.width = doc.w; native.height = doc.h;
                const nctx = native.getContext('2d');
                const img = nctx.createImageData(doc.w, doc.h);
                for (let q = 0; q < doc.map.length; q++) {
                    const slot = doc.map[q];
                    const b4 = q * 4;
                    if (slot === doc.transparentIdx) { img.data[b4 + 3] = 0; continue; }
                    const c = doc.colors[slot] || doc.colors[0] || { r: 0, g: 0, b: 0 };
                    img.data[b4] = c.r; img.data[b4 + 1] = c.g; img.data[b4 + 2] = c.b; img.data[b4 + 3] = 255;
                }
                nctx.putImageData(img, 0, 0);
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingEnabled = false;
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(native, 0, 0, canvas.width, canvas.height);
                return true;
            },

            /* Install a document value as the live document, in one history step. */
            applyProjectDoc(doc) {
                if (!doc) return false;
                const entry = this.getPaletteById(this.state.activePaletteId);
                if (entry) {
                    // In place: palette, basePalette and the record share this array.
                    entry.colors.length = doc.colors.length;
                    for (let i = 0; i < doc.colors.length; i++) entry.colors[i] = { ...doc.colors[i] };
                    this.palette = entry.colors;
                    this.basePalette = entry.colors;
                } else {
                    // No palette record to write through — an import brings its own
                    // colours, and leaving the old ones would draw the new indices
                    // through the previous asset's table.
                    this.palette = doc.colors.map(c => ({ ...c }));
                    this.basePalette = this.palette;
                }
                this.paletteLab = null;
                this.state.projectTransparentIndex = doc.transparentIdx;
                if (doc.transparentIdx >= 0) {
                    const trns = new Uint8Array(doc.transparentIdx + 1).fill(255);
                    trns[doc.transparentIdx] = 0;
                    this.state.projectTrns = trns;
                }
                if (doc.w !== this.config.width || doc.h !== this.config.height) {
                    if (this.layerMgr && typeof this.layerMgr.collapseToBase === 'function'
                        && this.layerMgr.active && this.layerMgr.layers.length > 1) {
                        this.layerMgr.collapseToBase();
                    }
                    this.setSize(doc.w, doc.h);
                }
                this.state.projectIndices = new Uint8Array(doc.map);
                /* Drawn by the same function the dialog's "After" pane uses, so what
                   was agreed to is by construction what lands.

                   Not `paintProjectIndicesOnto`: that one is the live-editing painter
                   and skips any pixel whose canvas alpha is already 0, because while
                   painting a clear pixel means the artist erased it and there is
                   nothing honest to draw underneath. Handed a blank surface — which is
                   what installing a whole document is — that guard skips every opaque
                   pixel, leaving the canvas empty for the next commit to fold back
                   into the map as a blank asset. */
                const surface = document.createElement('canvas');
                this.renderProjectDocInto(surface, doc, 1);
                const ctx = this.ctx;
                ctx.clearRect(0, 0, doc.w, doc.h);
                ctx.drawImage(surface, 0, 0);
                this.renderQuantPalette();
                this.saveState();
                this.deferColorCounts();
                if (this.onPalettesChanged) this.onPalettesChanged();
                this.refreshFrameViews();
                return true;
            },

            /* The dialog. Shows what the asset is now beside what it would become,
               both drawn by the same function from the same kind of value, with each
               fix listed and switchable — because "one action closes the gap" is only
               safe if you can see the gap being closed before you agree to it. */
            refreshFrameViews() {
                this.updateFrameOverlays();
                if (this.onFramesChanged) this.onFramesChanged();
            },

            async saveProjectFile(path) {
                const w = this.config.width, h = this.config.height;
                const { ctx } = this.projectIndexSurface();
                const imgData = (ctx || this.ctx).getImageData(0, 0, w, h);
                // The map is live, so this only has to catch a canvas that moved since
                // the last committed step; it never reconciles against a stored bitmap.
                const indices = this.buildProjectIndices(imgData.data, w, h);
                const palette = this.palette;
                // Reproduce the file's own transparency chunk — including its absence.
                // An empty array means "write none", where null would mean "derive one
                // from palette alpha" and would add a tRNS that tilesets never had.
                const bytes = await this.generateIndexedPNG(
                    w, h, indices, palette,
                    this.state.projectBitDepth || this.bitDepth,
                    this.state.projectTrns || new Uint8Array(0)
                );
                if (this.getTauriInvokeFn()) {
                    const normalizedPath = this.normalizeIncomingPath(path);
                    await this.tauriWriteAllowedFile(normalizedPath, bytes);
                    this.state.filePath = normalizedPath;
                    this.markSaved(this.getFilenameFromPath(normalizedPath));
                    this.resetSaveReminderTimer();
                    this.revealInExplorer(this.getParentDirectory(normalizedPath));
                    return;
                }
                await this.saveProjectFileBrowser(bytes);
            },
            async saveProjectFileBrowser(bytes) {
                const name = this.getFilenameFromPath(this.state.projectFile) || 'sprite.png';
                const blob = new Blob([bytes], { type: 'image/png' });
                const handle = this.state.projectHandle;
                if (handle && typeof handle.createWritable === 'function') {
                    try {
                        const writable = await handle.createWritable();
                        await writable.write(blob);
                        await writable.close();
                        this.state.fileHandle = handle;
                        this.state.filePath = handle.name;
                        this.markSaved(name);
                        this.resetSaveReminderTimer();
                        return;
                    } catch (e) { /* read-only handle or denied -> fall through */ }
                }
                if (typeof window.showSaveFilePicker === 'function') {
                    let picked;
                    try {
                        picked = await window.showSaveFilePicker({
                            suggestedName: name,
                            types: [{ description: 'PNG', accept: { 'image/png': ['.png'] } }]
                        });
                    } catch (e) {
                        if (e && e.name === 'AbortError') return;
                        throw e;
                    }
                    const writable = await picked.createWritable();
                    await writable.write(blob);
                    await writable.close();
                    this.state.fileHandle = picked;
                    this.state.filePath = picked.name;
                    this.markSaved(name);
                    this.resetSaveReminderTimer();
                    return;
                }
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = name;
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                this.markSaved(name);
                this.resetSaveReminderTimer();
            },
            labelForProjectPal(name) {
                const n = (name || '').toLowerCase();
                if (n === 'normal.pal') return 'Normal';
                if (n === 'shiny.pal') return 'Shiny';
                return (name || 'palette').replace(/\.pal$/i, '');
            },
            projectFrameLayout() {
                if (!this.state.projectImage || !this.state.projectFile) return null;
                const spec = this.inferProfile(this.state.projectFile).frames;
                if (!spec) return null;
                const w = this.config.width, h = this.config.height;
                if (!w || !h) return null;
                const axis = spec.axis === 'x' ? 'x' : 'y';
                const along = axis === 'x' ? w : h;

                let count = null;
                const forced = this.state.frameCountOverride;
                if (Number.isInteger(forced) && forced > 1) {
                    // The artist said so. Only refuse when the sheet cannot be cut that way.
                    if (along % forced) return null;
                    count = forced;
                } else if (spec.size) {
                    const fw = spec.size[0], fh = spec.size[1];
                    if (w % fw || h % fh) return null;
                    count = (w / fw) * (h / fh);
                } else {
                    /* Frame width for an overworld sheet really comes from
                       ObjectEventGraphicsInfo in the C, which nothing here reads yet.
                       Until it does: take the first division that lands on a whole 8×8
                       tile boundary, largest count first, since that is what a walking
                       sheet looks like. Wrong guesses are why the count is adjustable. */
                    for (const c of (spec.counts || [])) {
                        if (along % c) continue;
                        if ((along / c) % 8) continue;
                        count = c;
                        break;
                    }
                }
                if (!count || count < 2) return null;

                const fw = axis === 'x' ? w / count : w;
                const fh = axis === 'x' ? h : h / count;
                if (!Number.isInteger(fw) || !Number.isInteger(fh)) return null;
                const cols = w / fw, rows = h / fh;
                const hold = this.state.frameHold > 0
                    ? this.state.frameHold
                    : (spec.hold || this.constructor.DEFAULT_FRAME_HOLD);
                return {
                    count: cols * rows, cols, rows, w: fw, h: fh, axis, hold,
                    ms: hold * 1000 / this.constructor.GBA_HZ
                };
            },

            projectFrameRect(index) {
                const layout = this.projectFrameLayout();
                if (!layout || index < 0 || index >= layout.count) return null;
                const col = index % layout.cols, row = (index / layout.cols) | 0;
                return { x: col * layout.w, y: row * layout.h, w: layout.w, h: layout.h };
            },

            activeFrameIndex() {
                const layout = this.projectFrameLayout();
                if (!layout) return 0;
                const i = this.state.activeFrame | 0;
                return i >= 0 && i < layout.count ? i : 0;
            },

            setFrameCountOverride(count) {
                this.state.frameCountOverride = (Number.isInteger(count) && count > 1) ? count : null;
                this.state.activeFrame = 0;
                this.updateFrameOverlays();
                if (this.onFramesChanged) this.onFramesChanged();
            },
            setFrameHold(gameFrames) {
                const v = Math.max(1, Math.min(120, Math.round(gameFrames) || 0));
                this.state.frameHold = v;
                if (this.onFramesChanged) this.onFramesChanged();
            },
            renderProjectFrameInto(canvas, index, scale) {
                const rect = this.projectFrameRect(index);
                if (!canvas || !rect) return false;
                const z = Math.max(1, Math.round(scale || 1));
                canvas.width = rect.w * z;
                canvas.height = rect.h * z;
                const ctx = canvas.getContext('2d');
                this.disableSmoothing(ctx);
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                try {
                    ctx.drawImage(this.ui.cMain, rect.x, rect.y, rect.w, rect.h,
                        0, 0, canvas.width, canvas.height);
                } catch (e) { return false; }
                return true;
            },

            /* Ghost the neighbouring frames over the one being worked on, so a walk
               cycle can be lined up without flipping back and forth. The ghost lands on
               its own canvas above the artwork and below the tool preview: it is
               something to look through, never something that can be painted or saved. */
            updateFrameOverlays() {
                const c = this.ui.frameOnion;
                if (!c) return;
                const layout = this.projectFrameLayout();
                const w = this.config.width, h = this.config.height;
                if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
                const ctx = c.getContext('2d');
                this.disableSmoothing(ctx);
                ctx.clearRect(0, 0, w, h);
                if (!layout || !this.state.onionSkin || layout.count < 2) {
                    c.style.display = 'none';
                    return;
                }
                c.style.display = 'block';
                const at = this.activeFrameIndex();
                const here = this.projectFrameRect(at);
                const seen = new Set([at]);
                // Previous reads stronger than next: it is the frame you just drew.
                for (const [delta, alpha] of [[-1, 0.4], [1, 0.22]]) {
                    const i = ((at + delta) % layout.count + layout.count) % layout.count;
                    if (seen.has(i)) continue;
                    seen.add(i);
                    const from = this.projectFrameRect(i);
                    ctx.globalAlpha = alpha;
                    try {
                        ctx.drawImage(this.ui.cMain, from.x, from.y, from.w, from.h,
                            here.x, here.y, here.w, here.h);
                    } catch (e) { /* canvas not readable yet */ }
                }
                ctx.globalAlpha = 1;
            },

            isFramePlaying() { return !!this._framePlayTimer; },
            startFramePlayback() {
                const layout = this.projectFrameLayout();
                if (!layout || this._framePlayTimer) return false;
                // Playback walks the preview, not the canvas: the artist keeps the frame
                // they were editing, and nothing they do is interrupted by the animation.
                this._framePlayFrame = this.activeFrameIndex();
                const tick = () => {
                    const l = this.projectFrameLayout();
                    if (!l) { this.stopFramePlayback(); return; }
                    this._framePlayFrame = (this._framePlayFrame + 1) % l.count;
                    if (this.onFramePlayback) this.onFramePlayback(this._framePlayFrame);
                    this._framePlayTimer = setTimeout(tick, l.ms);
                };
                this._framePlayTimer = setTimeout(tick, layout.ms);
                if (this.onFramesChanged) this.onFramesChanged();
                return true;
            },
            stopFramePlayback() {
                if (this._framePlayTimer) clearTimeout(this._framePlayTimer);
                this._framePlayTimer = null;
                this._framePlayFrame = null;
                if (this.onFramePlayback) this.onFramePlayback(null);
                if (this.onFramesChanged) this.onFramesChanged();
            },
            toggleFramePlayback() {
                if (this._framePlayTimer) this.stopFramePlayback();
                else this.startFramePlayback();
            },

            /* How many colours this asset can actually hold: the bit depth the file was
               opened at decides it, not an assumption that everything is 4bpp. */
            /* The colour budget belongs to the *slot*, not to the file sitting in it.
               An expansion icon.png is an 8bpp PNG that becomes a 4bpp asset, so taking
               the budget from the file hands the artist 256 colours for a slot that
               holds 16 — it builds, and the icon comes out wrong.

               Where the slot's depth is genuinely unknown (a loose interface graphic
               that could be either), the file's own depth is the better guess of the
               two. Neither is authority: the project declares the real answer, in the
               `.4bpp` / `.8bpp` extension on the INCBIN/INCGFX line that names the
               file. Reading that is the asset model's job (3.1); until it exists this
               prefers the slot wherever the slot is actually known. */
            drivesProjectCanvas(paletteId) {
                return !!(this.state.projectImage && paletteId
                    && paletteId === this.state.activePaletteId
                    && !this.state.previewPaletteId);
            }
    });
})();
