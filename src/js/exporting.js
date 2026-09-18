/* exporting — moved verbatim off the PaintEngine class body.
 *
 * Assigned onto the prototype, so `this` is the same PaintEngine instance
 * these methods have always run against. Loads after paint-engine.js and
 * before boot.js, which is where the instance is finally created.
 */
(function () {
    Object.assign(PaintEngine.prototype, {
            exportThemeColors() {
                const now = new Date();
                const pad = (n) => String(n).padStart(2, '0');
                const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
                const payload = {
                    app: 'CDPaint',
                    type: 'theme-colors',
                    version: 1,
                    exportedAt: now.toISOString(),
                    overrides: Object.assign({}, this.colorOverrides || {}),
                    fileTabPresetColor: this.fileTabPresetColor || null
                };
                const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `cdpaint-theme-colors-${stamp}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 100);
            },
            sizeExportModalToContent(recenter = false) {
                const modal = document.getElementById('modal-export');
                const win = modal ? modal.querySelector('.window') : null;
                if (!modal || !win) return;
                win.style.height = 'auto';
                const desiredHeight = Math.max(420, Math.ceil(win.scrollHeight));
                win.style.height = desiredHeight + 'px';
                if (recenter) this.centerModal('modal-export');
            },
            getExportPresetConfig(preset) {
                if (preset === 'gba-sprite' || preset === 'gba-ui') {
                    return { paletteSize: 16, bitDepth: 4, force15: true, genPal: true, indexed: true };
                }
                if (preset === 'generic-8bpp') {
                    return { paletteSize: 256, bitDepth: 8, force15: false, genPal: true, indexed: true };
                }
                return { paletteSize: 0, bitDepth: 24, force15: false, genPal: false, indexed: false };
            },
            applyExportPreset() {
                const presetSel = document.getElementById('export-preset');
                const preset = presetSel ? presetSel.value : (this.state.exportPreset || 'gba-sprite');
                this.state.exportPreset = preset;
                const cfg = this.getExportPresetConfig(preset);

                const force15 = document.getElementById('export-15bit');
                const split = document.getElementById('export-split');
                const genPal = document.getElementById('export-gen-pal');
                const paletteGrid = document.getElementById('export-palette-grid');

                if (force15) {
                    force15.checked = cfg.force15;
                    force15.disabled = !cfg.indexed;
                }
                if (split) split.checked = preset !== 'standard';
                if (genPal) {
                    genPal.checked = cfg.genPal;
                    genPal.disabled = !cfg.indexed;
                }

                if (cfg.indexed && cfg.paletteSize) {
                    this.rebuildExportPalette(cfg.paletteSize);
                    this.renderExportPaletteUI();
                }
                if (paletteGrid) {
                    paletteGrid.style.opacity = cfg.indexed ? '1' : '0.5';
                    paletteGrid.style.pointerEvents = cfg.indexed ? 'auto' : 'none';
                }
                if (!cfg.indexed) {
                    const countLabel = document.getElementById('export-palette-count');
                    if (countLabel) countLabel.textContent = '--';
                }

                this.updateExportPreview();
                this.updateExportOutputInfo();
            },
            openExportModal() {
                const modal = document.getElementById('modal-export');
                if (!modal) return;

                const nameInput = document.getElementById('export-pkmn-name');
                // Try to guess pokemon name from current filename (e.g. "bulbasaur_front.png" -> "bulbasaur")
                const baseName = this.state.fileName.replace(/\.[^/.]+$/, "").split('_')[0] || '';
                if (nameInput && !nameInput.value) nameInput.value = baseName;

                // Auto-detect asset type based on canvas size
                const typeSelect = document.getElementById('export-asset-type');
                if (typeSelect) {
                    typeSelect.innerHTML = '';
                    const types = this.detectAssetTypes(this.config.width, this.config.height);
                    types.forEach(t => {
                        const opt = document.createElement('option');
                        opt.value = t.val;
                        opt.textContent = t.label;
                        typeSelect.appendChild(opt);
                    });
                }

                // Call applyExportPreset if it exists in the codebase to reset states
                if (typeof this.applyExportPreset === 'function') {
                    this.applyExportPreset();
                }

                // Auto-destination: derive sensible export defaults from the open project path
                const projPath = this.state.projectFile || this.state.filePath || '';
                if (projPath) {
                    const projFolder = this.getParentDirectory(projPath);
                    if (projFolder) this.state.exportDir = projFolder;
                    const segs = projPath.split(/[\\/]/).filter(Boolean);
                    const fileNameRaw = segs[segs.length - 1] || '';
                    const baseRaw = fileNameRaw.replace(/\.[^./]+$/, '');
                    const lc = baseRaw.toLowerCase();
                    let species = baseRaw.split('_')[0] || '';
                    const pkIdx = segs.findIndex(function (s) { return /pokemon/i.test(s); });
                    if (pkIdx >= 0 && pkIdx + 1 < segs.length) species = segs[pkIdx + 1].split('_')[0] || species;
                    if (species && nameInput && !nameInput.value) nameInput.value = species;
                    const typeSelect = document.getElementById('export-asset-type');
                    let at = null;
                    if (/back/.test(lc)) at = 'back';
                    else if (/icon/.test(lc)) at = 'icon';
                    else if (/footprint/.test(lc)) at = 'footprint';
                    else if (/anim/.test(lc)) at = 'anim_front';
                    else if (/front/.test(lc)) at = 'front';
                    if (at && typeSelect && typeSelect.querySelector('option[value="' + at + '"]')) typeSelect.value = at;
                    const shinyChk = document.getElementById('export-is-shiny');
                    if (shinyChk) shinyChk.checked = /shiny/.test(lc);
                    const prefixChk = document.getElementById('export-use-prefix');
                    if (prefixChk) prefixChk.checked = true;
                    const genChk = document.getElementById('export-gen-pal');
                    if (genChk) genChk.checked = true;
                }

                this.updateExportOutputInfo();
                modal.style.display = 'flex';
                this.sizeExportModalToContent(true);
            },
            onExportDragStart(e, index) {
                this.state.exportDraggingIndex = index;
                e.target.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
            },
            onExportDragOver(e, index) {
                e.preventDefault();
                if (this.state.exportDraggingIndex === index) return;
                e.currentTarget.classList.add('drag-over');
            },
            onExportDragEnd(e) {
                e.target.classList.remove('dragging');
                document.querySelectorAll('.export-swatch').forEach(el => el.classList.remove('drag-over'));
            },
            onExportDrop(e, targetIndex) {
                e.preventDefault();
                const sourceIndex = this.state.exportDraggingIndex;
                if (sourceIndex === targetIndex || sourceIndex < 0) return;

                const pal = this.state.exportPalette;
                const temp = pal[sourceIndex];
                pal[sourceIndex] = pal[targetIndex];
                pal[targetIndex] = temp;

                this.state.exportDraggingIndex = -1;
                this.renderExportPaletteUI();
                this.updateExportPreview();
            },
            updateExportOutputInfo() {
                const output = document.getElementById('export-output-info');
                if (!output) return;

                const pkmnName = document.getElementById('export-pkmn-name').value.trim() || 'pokemon';
                const usePrefix = document.getElementById('export-use-prefix').checked;
                const isShiny = document.getElementById('export-is-shiny') && document.getElementById('export-is-shiny').checked;
                const assetType = document.getElementById('export-asset-type').value;
                const genPal = document.getElementById('export-gen-pal') && document.getElementById('export-gen-pal').checked;

                const prefix = usePrefix ? `${pkmnName}_` : ``;
                const shinySuffix = isShiny ? '_shiny' : '';
                const filesToGenerate = [];

                if (assetType === 'front-back') {
                    filesToGenerate.push({ key: 'front', name: `${prefix}front${shinySuffix}.png` });
                    filesToGenerate.push({ key: 'back', name: `${prefix}back${shinySuffix}.png` });
                } else if (assetType === 'custom') {
                    filesToGenerate.push({ key: 'main', name: `${pkmnName}${shinySuffix}.png` });
                } else {
                    filesToGenerate.push({ key: 'main', name: `${prefix}${assetType}${shinySuffix}.png` });
                }

                if (genPal) {
                    filesToGenerate.push({ key: 'pal', name: `${prefix}${isShiny ? 'shiny' : 'normal'}.pal` });
                }

                const prevSelection = this.state.exportFileSelection || {};
                this.state.exportFileSelection = {};
                output.innerHTML = '';
                for (const file of filesToGenerate) {
                    const row = document.createElement('label');
                    row.className = 'checkbox-row';
                    row.style.cursor = 'pointer';
                    row.style.display = 'flex';
                    row.style.alignItems = 'center';
                    row.style.gap = '6px';
                    row.style.margin = '2px 0';

                    const input = document.createElement('input');
                    input.type = 'checkbox';
                    input.id = `export-file-${file.key}`;
                    input.checked = prevSelection[file.key] !== false;
                    input.onchange = () => {
                        this.state.exportFileSelection[file.key] = input.checked;
                    };
                    this.state.exportFileSelection[file.key] = input.checked;

                    const text = document.createElement('span');
                    text.textContent = file.name;

                    row.appendChild(input);
                    row.appendChild(text);
                    output.appendChild(row);
                }
                const modal = document.getElementById('modal-export');
                if (modal && modal.style.display === 'flex') {
                    this.sizeExportModalToContent(false);
                }
            },
            updateExportPreview() {
                const canvas = document.getElementById('export-preview-canvas');
                if (!canvas) return;

                const presetSel = document.getElementById('export-preset');
                const preset = presetSel ? presetSel.value : 'gba-sprite';
                const cfg = this.getExportPresetConfig(preset);

                const srcCtx = this.ui.cMain.getContext('2d');
                const w = this.config.width;
                const h = this.config.height;
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');

                if (!cfg.indexed) {
                    ctx.clearRect(0, 0, w, h);
                    ctx.drawImage(this.ui.cMain, 0, 0);
                    this.updateExportOutputInfo();
                    return;
                }

                const srcData = srcCtx.getImageData(0, 0, w, h);
                const destData = ctx.createImageData(w, h);

                const pal = this.state.exportPalette;
                if (!pal || !pal.length) return;

                const force15 = document.getElementById('export-15bit').checked;
                const to15 = (c) => Math.round(Math.round((c / 255) * 31) * (255 / 31));

                const previewPal = pal.map(c => {
                    if (!force15) return c;
                    return { r: to15(c.r), g: to15(c.g), b: to15(c.b), a: c.a };
                });

                for (let i = 0; i < srcData.data.length; i += 4) {
                    const r = srcData.data[i];
                    const g = srcData.data[i + 1];
                    const b = srcData.data[i + 2];
                    const a = srcData.data[i + 3];

                    let bestIdx = 0;
                    let minDist = Infinity;
                    for (let p = 0; p < previewPal.length; p++) {
                        const pc = previewPal[p];
                        const dist = (r - pc.r) ** 2 + (g - pc.g) ** 2 + (b - pc.b) ** 2 + (a - pc.a) ** 2;
                        if (dist < minDist) {
                            minDist = dist;
                            bestIdx = p;
                        }
                    }

                    const matchedColor = previewPal[bestIdx];
                    if (bestIdx === 0) {
                        destData.data[i] = 0;
                        destData.data[i + 1] = 0;
                        destData.data[i + 2] = 0;
                        destData.data[i + 3] = 0;
                    } else {
                        destData.data[i] = matchedColor.r;
                        destData.data[i + 1] = matchedColor.g;
                        destData.data[i + 2] = matchedColor.b;
                        destData.data[i + 3] = 255;
                    }
                }

                ctx.putImageData(destData, 0, 0);
                this.updateExportOutputInfo();
            },
            /* A PNG of this canvas, palette-encoded when the picture uses 256
               colours or fewer -- which is most sprite and tile work. The
               browser's own encoder always writes 32-bit RGBA no matter how few
               colours are actually on screen, so indexing is the single biggest
               lossless saving available to us: four times fewer bytes before
               compression gets a look in, and more again at 4, 2 or 1 bits per
               pixel. Anything with too many colours to index (a soft-brushed
               painting) falls back to toBlob, so the caller always gets a PNG.

               This is a repack, not a requantise -- if the colours do not fit in
               a palette we do not force them into one, and the alpha channel is
               left exactly as painted. */
            async pngBlobFromCanvas(canvas) {
                let indexed = null;
                try {
                    indexed = await this.indexedPngFromCanvas(canvas);
                } catch (e) {
                    console.warn('Indexed PNG encode failed, falling back to toBlob', e);
                }
                if (indexed) return new Blob([indexed], { type: 'image/png' });
                return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            },
            async indexedPngFromCanvas(canvas) {
                const w = canvas.width, h = canvas.height;
                if (!w || !h) return null;
                const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
                const seen = new Map();
                const indices = new Uint8Array(w * h);
                for (let i = 0, p = 0; p < d.length; p += 4, i++) {
                    // Packed by hand rather than read through a Uint32Array view so
                    // the key does not depend on the machine's byte order.
                    const key = (d[p] | d[p + 1] << 8 | d[p + 2] << 16 | d[p + 3] << 24) >>> 0;
                    let idx = seen.get(key);
                    if (idx === undefined) {
                        if (seen.size === 256) return null;
                        idx = seen.size;
                        seen.set(key, idx);
                    }
                    indices[i] = idx;
                }
                const palette = [...seen.keys()].map(k => ({
                    r: k & 255, g: (k >>> 8) & 255, b: (k >>> 16) & 255, a: (k >>> 24) & 255
                }));
                const bitDepth = seen.size <= 2 ? 1 : seen.size <= 4 ? 2 : seen.size <= 16 ? 4 : 8;
                return this.generateIndexedPNG(w, h, indices, palette, bitDepth);
            },
            /* Choose a row filter per row, the way every other PNG writer does.
               Deflate only sees repetition, so subtracting each byte from its
               left or upper neighbour first is usually what makes a picture
               compress at all -- writing filter 0 everywhere, as this did, cost
               enough that an indexed PNG could come out bigger than the 32-bit
               one the browser writes. Picks by the standard minimum-sum-of-
               absolute-differences heuristic, which is a guess at which filter
               deflates smallest, not a measurement.

               ponytail: five passes over the pixels, so it scales with canvas
               area. Only palette pictures come through here and they are small;
               if that stops being true, try filters on a sample of rows. */
            filterPngRows(packed, h, rowBytes) {
                const out = new Uint8Array(h * (rowBytes + 1));
                const cand = new Uint8Array(rowBytes);
                for (let y = 0; y < h; y++) {
                    const cur = y * rowBytes, prev = cur - rowBytes;
                    const dest = y * (rowBytes + 1);
                    let bestType = 0, bestScore = Infinity, bestRow = null;
                    for (let type = 0; type < 5; type++) {
                        if (type > 1 && y === 0 && type !== 4) {
                            /* Up and Average against a non-existent row above are
                               legal but pointless on row 0; Paeth degenerates to
                               Sub there, which is worth keeping in the running. */
                            if (type === 2) continue;
                        }
                        let score = 0;
                        for (let x = 0; x < rowBytes; x++) {
                            const raw = packed[cur + x];
                            const a = x >= 1 ? packed[cur + x - 1] : 0;
                            const b = y > 0 ? packed[prev + x] : 0;
                            const c = (x >= 1 && y > 0) ? packed[prev + x - 1] : 0;
                            let v;
                            if (type === 0) v = raw;
                            else if (type === 1) v = raw - a;
                            else if (type === 2) v = raw - b;
                            else if (type === 3) v = raw - ((a + b) >> 1);
                            else {
                                const p = a + b - c;
                                const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                                v = raw - ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c));
                            }
                            v &= 0xff;
                            cand[x] = v;
                            score += v < 128 ? v : 256 - v;
                        }
                        if (score < bestScore) {
                            bestScore = score;
                            bestType = type;
                            bestRow = cand.slice();
                        }
                    }
                    out[dest] = bestType;
                    out.set(bestRow, dest + 1);
                }
                return out;
            },
            async generateIndexedPNG(w, h, indices, palette, bitDepth, trns) {
                const ihdr = new Uint8Array(13);
                const ihdrView = new DataView(ihdr.buffer);
                ihdrView.setUint32(0, w, false);
                ihdrView.setUint32(4, h, false);
                ihdr[8] = bitDepth;
                ihdr[9] = 3;
                ihdr[10] = 0;
                ihdr[11] = 0;
                ihdr[12] = 0;

                const plte = new Uint8Array(palette.length * 3);
                for (let i = 0; i < palette.length; i++) {
                    plte[i * 3] = palette[i].r;
                    plte[i * 3 + 1] = palette[i].g;
                    plte[i * 3 + 2] = palette[i].b;
                }

                if (trns === undefined || trns === null) {
                    let lastTransparent = -1;
                    for (let i = 0; i < palette.length; i++) {
                        const a = palette[i].a === undefined ? 255 : palette[i].a;
                        if (a < 255) lastTransparent = i;
                    }
                    if (lastTransparent >= 0) {
                        trns = new Uint8Array(lastTransparent + 1);
                        for (let i = 0; i <= lastTransparent; i++) {
                            trns[i] = palette[i].a === undefined ? 255 : palette[i].a;
                        }
                    } else {
                        trns = null;
                    }
                }

                const rowBytes = Math.ceil((w * bitDepth) / 8);
                const packed = new Uint8Array(h * rowBytes);
                for (let y = 0; y < h; y++) {
                    let bitBuffer = 0;
                    let bitsFilled = 0;
                    let byteIndex = y * rowBytes;
                    for (let x = 0; x < w; x++) {
                        const idx = indices[y * w + x] & ((1 << bitDepth) - 1);
                        bitBuffer = (bitBuffer << bitDepth) | idx;
                        bitsFilled += bitDepth;
                        while (bitsFilled >= 8) {
                            bitsFilled -= 8;
                            packed[byteIndex++] = (bitBuffer >> bitsFilled) & 0xff;
                        }
                    }
                    if (bitsFilled > 0) {
                        packed[byteIndex] = (bitBuffer << (8 - bitsFilled)) & 0xff;
                    }
                }

                const rawData = this.filterPngRows(packed, h, rowBytes);
                const idatData = await CompressionCompat.deflate(rawData);

                const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
                const chunks = [
                    sig,
                    PngMetadata.createChunk('IHDR', ihdr),
                    PngMetadata.createChunk('PLTE', plte)
                ];
                if (trns && trns.length) chunks.push(PngMetadata.createChunk('tRNS', trns));
                chunks.push(PngMetadata.createChunk('IDAT', idatData));
                chunks.push(PngMetadata.createChunk('IEND', new Uint8Array(0)));

                let totalLen = 0;
                for (let c of chunks) totalLen += c.length;
                const out = new Uint8Array(totalLen);
                let offset = 0;
                for (let c of chunks) {
                    out.set(c, offset);
                    offset += c.length;
                }
                return out;
            },
            async decodePngIndices(meta) {
                if (!meta || meta.colorType !== 3 || meta.interlace !== 0) return null;
                if (!meta.idat || !meta.idat.length) return null;
                const { width: w, height: h, bitDepth: depth } = meta;
                if (![1, 2, 4, 8].includes(depth) || w <= 0 || h <= 0) return null;

                let joined;
                if (meta.idat.length === 1) {
                    joined = meta.idat[0];
                } else {
                    let total = 0;
                    for (const c of meta.idat) total += c.length;
                    joined = new Uint8Array(total);
                    let at = 0;
                    for (const c of meta.idat) { joined.set(c, at); at += c.length; }
                }

                let raw;
                try {
                    raw = CompressionCompat.toBytes(await CompressionCompat.inflate(joined));
                } catch (err) {
                    console.warn('Could not inflate PNG image data', err);
                    return null;
                }

                const rowBytes = Math.ceil((w * depth) / 8);
                if (raw.length < h * (rowBytes + 1)) return null;

                // Undo PNG row filters. Sub-byte depths filter on whole bytes, so the
                // "previous pixel" distance is 1 for every indexed image.
                const flat = new Uint8Array(h * rowBytes);
                for (let y = 0; y < h; y++) {
                    const filter = raw[y * (rowBytes + 1)];
                    const src = y * (rowBytes + 1) + 1;
                    const cur = y * rowBytes;
                    const prev = cur - rowBytes;
                    for (let x = 0; x < rowBytes; x++) {
                        const a = x >= 1 ? flat[cur + x - 1] : 0;
                        const b = y > 0 ? flat[prev + x] : 0;
                        const c = (x >= 1 && y > 0) ? flat[prev + x - 1] : 0;
                        let v = raw[src + x];
                        if (filter === 1) v += a;
                        else if (filter === 2) v += b;
                        else if (filter === 3) v += (a + b) >> 1;
                        else if (filter === 4) {
                            const p = a + b - c;
                            const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                            v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
                        } else if (filter !== 0) {
                            return null; // unknown filter: better no answer than a wrong one
                        }
                        flat[cur + x] = v & 0xff;
                    }
                }

                const indices = new Uint8Array(w * h);
                if (depth === 8) {
                    for (let y = 0; y < h; y++) indices.set(flat.subarray(y * rowBytes, y * rowBytes + w), y * w);
                } else {
                    const perByte = 8 / depth;
                    const mask = (1 << depth) - 1;
                    for (let y = 0; y < h; y++) {
                        const row = y * rowBytes, out = y * w;
                        for (let x = 0; x < w; x++) {
                            const shift = 8 - depth - (x % perByte) * depth;
                            indices[out + x] = (flat[row + ((x / perByte) | 0)] >> shift) & mask;
                        }
                    }
                }
                return indices;
            },
            /* Which palette slot means "not drawn". Taken from the file's own tRNS
               chunk rather than from palette alpha, because a loaded .pal marks its
               first entry transparent whether or not that is true for this asset. */
            async pickExportDirectoryForDesktop() {
                const defaultPath = this.normalizeExportDirectoryPath(this.state.exportDir || '');
                const selected = await this.tauriOpenDirectoryDialog({
                    title: 'Choose Export Folder',
                    directory: true,
                    multiple: false,
                    defaultPath: defaultPath || undefined
                });
                if (selected !== undefined) {
                    if (!selected) return null;
                    const dir = this.normalizeDialogPathSelection(selected);
                    return dir || null;
                }
                const nativeDir = await this.tauriPickExportFolderNative();
                if (nativeDir === null) return null;
                if (typeof nativeDir === 'string' && nativeDir) return nativeDir;
                return undefined;
            },
            normalizeExportDirectoryPath(input) {
                if (input === null || input === undefined) return '';
                return String(input).trim();
            },
            async saveExportFiles(files, preselectedDir = null, options = {}) {
                if (!Array.isArray(files) || files.length === 0) return true;
                const hasTauriWrite = !!this.getTauriInvokeFn();
                const opts = options && typeof options === 'object' ? options : {};
                const skipDirectoryPrompt = !!opts.skipDirectoryPrompt;
                const tauriFailures = [];
                const rememberTauriFailure = (step, err) => {
                    const msg = this.getErrorText(err);
                    tauriFailures.push(`${step}: ${msg}`);
                };
                if (hasTauriWrite) {
                    let chosenDir = '';
                    if (skipDirectoryPrompt && typeof preselectedDir === 'string' && preselectedDir) {
                        chosenDir = this.normalizeExportDirectoryPath(preselectedDir);
                    } else {
                        try {
                            const pickedDir = await this.pickExportDirectoryForDesktop();
                            if (pickedDir === null) return null;
                            if (typeof pickedDir === 'string' && pickedDir) {
                                chosenDir = this.normalizeExportDirectoryPath(pickedDir);
                                this.state.exportDir = chosenDir;
                            }
                        } catch (e) {
                            rememberTauriFailure('desktop folder picker', e);
                        }
                        // If directory picker is unavailable in this runtime, reuse last known export dir.
                        if (!chosenDir && typeof preselectedDir === 'string' && preselectedDir) {
                            chosenDir = this.normalizeExportDirectoryPath(preselectedDir);
                        }
                    }
                    if (chosenDir) {
                        try {
                            await this.tauriWriteExportFiles(chosenDir, files);
                            return true;
                        } catch (e) {
                            rememberTauriFailure('native batch write', e);
                            try {
                                await this.tauriWriteExportFilesPerFile(chosenDir, files);
                                return true;
                            } catch (perFileError) {
                                rememberTauriFailure('native per-file write', perFileError);
                            }
                        }
                    }
                    try {
                        const wroteViaSaveDialog = await this.tauriWriteExportFilesWithSaveDialog(files);
                        if (wroteViaSaveDialog === true) return true;
                        if (wroteViaSaveDialog === null) return null;
                    } catch (e) {
                        rememberTauriFailure('save dialog write', e);
                    }
                    try {
                        const wroteViaDialog = await this.tauriWriteExportFilesWithDialog(files);
                        if (wroteViaDialog === true) return true;
                        if (wroteViaDialog === null) return null;
                    } catch (e) {
                        rememberTauriFailure('folder dialog write', e);
                    }
                    try {
                        const nativeDir = await this.tauriPickExportFolderNative();
                        if (nativeDir === null) return null;
                        if (typeof nativeDir === 'string' && nativeDir) {
                            try {
                                await this.tauriWriteExportFiles(nativeDir, files);
                                return true;
                            } catch (batchError) {
                                rememberTauriFailure('native picker batch write', batchError);
                                await this.tauriWriteExportFilesPerFile(nativeDir, files);
                                return true;
                            }
                        }
                    } catch (e) {
                        rememberTauriFailure('native picker write', e);
                    }
                    try {
                        const selected = await this.tauriOpenDirectoryDialog({
                            title: 'Choose Export Folder',
                            directory: true,
                            multiple: false
                        });
                        if (selected !== undefined) {
                            if (!selected) return null;
                            const dir = this.normalizeDialogPathSelection(selected);
                            if (!dir) return null;
                            try {
                                await this.tauriWriteExportFiles(dir, files);
                            } catch (batchError) {
                                rememberTauriFailure('dialog picker batch write', batchError);
                                await this.tauriWriteExportFilesPerFile(dir, files);
                            }
                            return true;
                        }
                    } catch (e) {
                        rememberTauriFailure('dialog picker write', e);
                    }
                }
                if (window.showDirectoryPicker) {
                    try {
                        const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
                        for (const file of files) {
                            const handle = await dir.getFileHandle(file.name, { create: true });
                            const writable = await handle.createWritable();
                            await writable.write(this.toUint8Array(file.bytes));
                            await writable.close();
                        }
                        return true;
                    } catch (e) {
                        if (e && e.name === 'AbortError') return null;
                        if (hasTauriWrite) {
                            rememberTauriFailure('browser directory picker write', e);
                        } else {
                            throw e;
                        }
                    }
                }
                if (files.length === 1 && window.showSaveFilePicker) {
                    try {
                        const only = files[0];
                        const isPal = /\.pal$/i.test(only.name);
                        const types = isPal
                            ? [{ description: 'Palette', accept: { 'text/plain': ['.pal'] } }]
                            : [{ description: 'PNG Image', accept: { 'image/png': ['.png'] } }];
                        const handle = await window.showSaveFilePicker({ suggestedName: only.name, types });
                        const writable = await handle.createWritable();
                        await writable.write(this.toUint8Array(only.bytes));
                        await writable.close();
                        return true;
                    } catch (e) {
                        if (e && e.name === 'AbortError') return null;
                        if (hasTauriWrite) {
                            rememberTauriFailure('browser save picker write', e);
                        } else {
                            throw e;
                        }
                    }
                }
                if (hasTauriWrite) {
                    if (!tauriFailures.length) {
                        throw new Error('Desktop export failed: no writable save path was available.');
                    }
                    throw new Error(`Desktop export failed:\n${tauriFailures.join('\n')}`);
                }
                return false;
            },
            async doAdvancedExport() {
                const pkmnName = document.getElementById('export-pkmn-name').value.trim() || 'pokemon';
                const usePrefix = document.getElementById('export-use-prefix').checked;
                const isShiny = document.getElementById('export-is-shiny') && document.getElementById('export-is-shiny').checked;
                const assetType = document.getElementById('export-asset-type').value;
                const genPal = document.getElementById('export-gen-pal').checked;
                const force15 = document.getElementById('export-15bit').checked;
                const prefix = usePrefix ? `${pkmnName}_` : ``;
                const shinySuffix = isShiny ? '_shiny' : '';
                let selectedExportDir = this.normalizeExportDirectoryPath(this.state.exportDir || '');
                const hasTauriWrite = !!this.getTauriInvokeFn();
                let skipDesktopPrompt = false;

                if (hasTauriWrite) {
                    try {
                        const pickedDir = await this.pickExportDirectoryForDesktop();
                        if (pickedDir === null) return;
                        if (typeof pickedDir === 'string' && pickedDir) {
                            selectedExportDir = this.normalizeExportDirectoryPath(pickedDir);
                            this.state.exportDir = selectedExportDir;
                            skipDesktopPrompt = true;
                        }
                    } catch (e) {
                        // Keep export flow alive: saveExportFiles will try additional picker/write fallbacks.
                        console.warn('Desktop export folder picker failed before generation', e);
                    }
                }

                const finalPalette = this.state.exportPalette.map(c => {
                    if (!force15) return c;
                    const q = (v) => Math.round(Math.round((v / 255) * 31) * (255 / 31));
                    return { r: q(c.r), g: q(c.g), b: q(c.b), a: c.a };
                });

                const w = this.config.width;
                const h = this.config.height;
                const srcCtx = this.ui.cMain.getContext('2d');
                const srcData = srcCtx.getImageData(0, 0, w, h).data;
                const indices = new Uint8Array(w * h);

                for (let i = 0; i < w * h; i++) {
                    const off = i * 4;
                    const r = srcData[off], g = srcData[off + 1], b = srcData[off + 2], a = srcData[off + 3];

                    if (a === 0) {
                        indices[i] = 0;
                        continue;
                    }

                    let bestIdx = 0, minDist = Infinity;
                    for (let p = 0; p < finalPalette.length; p++) {
                        const pc = finalPalette[p];
                        const dist = (r - pc.r) ** 2 + (g - pc.g) ** 2 + (b - pc.b) ** 2;
                        if (dist < minDist) { minDist = dist; bestIdx = p; }
                    }
                    indices[i] = bestIdx;
                }

                const queuedFiles = [];
                const queueFile = (data, filename, isText = false) => {
                    const bytes = isText ? new TextEncoder().encode(String(data)) : this.toUint8Array(data);
                    queuedFiles.push({ name: filename, bytes });
                };
                const flushDownloads = () => {
                    queuedFiles.forEach((file) => {
                        const isPal = /\.pal$/i.test(file.name);
                        const blob = new Blob([file.bytes], { type: isPal ? 'text/plain' : 'image/png' });
                        const link = document.createElement('a');
                        link.download = file.name;
                        link.href = URL.createObjectURL(blob);
                        link.click();
                        setTimeout(() => URL.revokeObjectURL(link.href), 100);
                    });
                };

                const savePng = async (x, y, subW, subH, filename) => {
                    const subIndices = new Uint8Array(subW * subH);
                    for (let row = 0; row < subH; row++) {
                        for (let col = 0; col < subW; col++) {
                            subIndices[row * subW + col] = indices[(y + row) * w + (x + col)];
                        }
                    }
                    const pngBytes = await this.generateIndexedPNG(subW, subH, subIndices, finalPalette, 4, new Uint8Array([0])); // index 0 = transparent (GBA contract); 4bpp for decomps
                    queueFile(pngBytes, filename);
                };

                const shouldExport = (key) => {
                    const checkbox = document.getElementById(`export-file-${key}`);
                    return checkbox ? checkbox.checked : true;
                };

                try {
                    // Execute the saves based on asset type
                    if (assetType === 'front-back' && w === 128 && h === 64) {
                        if (shouldExport('front')) await savePng(0, 0, 64, 64, `${prefix}front${shinySuffix}.png`);
                        if (shouldExport('back')) await savePng(64, 0, 64, 64, `${prefix}back${shinySuffix}.png`);
                    } else if (assetType === 'custom') {
                        if (shouldExport('main')) await savePng(0, 0, w, h, `${pkmnName}${shinySuffix}.png`);
                    } else {
                        // front, back, anim_front, footprint, icon
                        if (shouldExport('main')) await savePng(0, 0, w, h, `${prefix}${assetType}${shinySuffix}.png`);
                    }

                    if (genPal && shouldExport('pal')) {
                        let palStr = "JASC-PAL\r\n0100\r\n16\r\n";
                        for (let i = 0; i < 16; i++) {
                            const c = finalPalette[i] || { r: 0, g: 0, b: 0 };
                            palStr += `${c.r} ${c.g} ${c.b}\r\n`;
                        }
                        queueFile(palStr, `${prefix}${isShiny ? 'shiny' : 'normal'}.pal`, true);
                    }
                    if (!queuedFiles.length) {
                        showToast('No export files are selected.', 'warning');
                        return;
                    }

                    const saveResult = await this.saveExportFiles(queuedFiles, selectedExportDir, {
                        skipDirectoryPrompt: skipDesktopPrompt
                    });
                    if (saveResult === null) return;
                    if (saveResult === false) flushDownloads();
                    if (saveResult && this.getTauriInvokeFn()) this.revealInExplorer(this.state.exportDir);

                    this.closeModals();
                } catch (e) {
                    console.error("Export Error:", e);
                    showToast("Export Failed: " + e, 'error');
                }
            },
            doExport() {
                const name = document.getElementById('export-name').value || 'untitled';
                const format = document.getElementById('export-format').value;
                const space = document.getElementById('export-space').value;
                let mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
                if(space !== 'srgb' && space !== 'p3') {
                    this.applyColorSpace(space);
                }
                const finish = () => {
                    const opts = {};
                    if(space === 'p3') opts.colorSpace = 'display-p3';
                    // Display-P3 stays on the browser encoder: reading the pixels back
                    // through getImageData would convert them to sRGB and the export
                    // would quietly come out in the wrong colours.
                    const encode = (format !== 'jpeg' && space !== 'p3')
                        ? this.pngBlobFromCanvas(this.ui.cMain)
                        : new Promise(resolve => this.ui.cMain.toBlob(resolve, mime, 1.0, opts));
                    encode.then(blob => {
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = name + '.' + (format==='jpeg'?'jpg':'png');
                        a.click();
                        setTimeout(() => URL.revokeObjectURL(url), 100);
                        this.closeModals();
                    });
                };
                finish();
            },

            validateForExport(profile) {
                const errors = [];
                const w = this.config.width, h = this.config.height;
                if (profile.allowedResolutions && profile.allowedResolutions.length) {
                    const okRes = profile.allowedResolutions.some(r => r[0] === w && r[1] === h);
                    if (!okRes) {
                        const hint = 'Allowed resolutions: ' + profile.allowedResolutions.map(r => r.join('x')).join(', ');
                        if (profile.strictResolution) {
                            errors.push({ field: 'resolution', message: `Resolution ${w}x${h} is not allowed for ${profile.label}.`, hint, warn: false });
                        } else {
                            errors.push({ field: 'resolution', message: `Resolution ${w}x${h} is unusual for ${profile.label}.`, hint, warn: true });
                        }
                    }
                }
                if (profile.requiredWidth && w !== profile.requiredWidth) {
                    errors.push({ field: 'resolution', message: `${profile.label} must be ${profile.requiredWidth}px wide; this is ${w}px.`, hint: `Tile sheets are laid out ${profile.requiredWidth}px across.`, warn: false });
                }
                if (profile.tileAligned && (w % 8 !== 0 || h % 8 !== 0)) {
                    errors.push({ field: 'resolution', message: `${w}x${h} is not a whole number of 8x8 tiles.`, hint: 'Both dimensions need to be multiples of 8.', warn: false });
                }
                const imgData = this.ctx.getImageData(0, 0, w, h);
                const d = imgData.data;
                const distinct = new Map();
                for (let p = 0; p < d.length; p += 4) {
                    if (d[p + 3] < 128) continue;
                    distinct.set((d[p] << 16) | (d[p + 1] << 8) | d[p + 2], true);
                }
                const distinctCount = distinct.size;
                const maxColors = this.maxColorsForProfile(profile);
                if (distinctCount > maxColors) {
                    errors.push({ field: 'colors', message: `Artwork uses ${distinctCount} distinct colors; this asset holds ${maxColors}.`, hint: `Reduce to ${maxColors} or fewer colors before exporting.`, warn: false });
                }
                const tol = 24;
                const palEntries = (this.state.palettes || []).filter(pe => pe.source === 'pal');
                for (const pe of palEntries) {
                    const offending = this.findOffendingColors(pe.colors, d, tol);
                    if (offending.length) {
                        const sw = offending.slice(0, 5).map(c => this.rgbToHex(c.r, c.g, c.b)).join(', ');
                        errors.push({ field: 'palette:' + pe.name, message: `${offending.length}+ pixel color(s) fall outside the ${pe.name} palette.`, hint: `Mismatched colors: ${sw}`, warn: true });
                    }
                }
                const blocking = errors.filter(e => !e.warn);
                return { ok: blocking.length === 0, errors };
            },
            /* Decomp .pal files are JASC-PAL with 0-255 channels — the 8-bit spelling of
               the GBA's 15-bit colour. Writing the raw 0-31 values instead makes gbagfx
               compile a near-black palette into the ROM.
               The conversion mirrors gbagfx exactly: 8-bit down to 5-bit by >> 3, and
               back up by (v * 255) / 31 truncated. Bulbasaur's 205 205 172 survives that
               round trip unchanged, which is the point — reading and re-writing a
               palette you didn't edit must not move a single channel. */
            async doExportProjectFile() {
                this.state.isSaving = true;
                this.updateBusyIndicator();
                try {
                    await this.saveProjectFile(this.state.projectFile);
                    await this.writeProjectPalFiles();
                } finally {
                    this.state.isSaving = false;
                    this.updateBusyIndicator();
                }
            },
            showExportValidationModal(errors, onSaveAnyway) {
                const existing = document.getElementById('export-validation-modal');
                if (existing) existing.remove();
                const overlay = document.createElement('div');
                overlay.id = 'export-validation-modal';
                overlay.className = 'modal-overlay';
                overlay.style.position = 'fixed';
                overlay.style.inset = '0';
                overlay.style.background = 'rgba(0,0,0,0.5)';
                overlay.style.display = 'flex';
                overlay.style.alignItems = 'center';
                overlay.style.justifyContent = 'center';
                overlay.style.zIndex = '9999';
                const box = document.createElement('div');
                box.className = 'modal-box';
                box.style.background = 'var(--bg, #fff)';
                box.style.color = 'var(--fg, #000)';
                box.style.padding = '20px';
                box.style.borderRadius = '8px';
                box.style.maxWidth = '480px';
                box.style.width = '90%';
                const title = document.createElement('h3');
                title.textContent = 'Export validation failed';
                box.appendChild(title);
                const list = document.createElement('ul');
                errors.forEach(err => {
                    const li = document.createElement('li');
                    const strong = document.createElement('strong');
                    strong.textContent = (err.warn ? 'Warning' : 'Error') + ': ';
                    li.appendChild(strong);
                    li.appendChild(document.createTextNode(err.message));
                    if (err.hint) {
                        const hint = document.createElement('div');
                        hint.style.fontSize = '0.85em';
                        hint.style.opacity = '0.8';
                        hint.textContent = err.hint;
                        li.appendChild(hint);
                    }
                    list.appendChild(li);
                });
                box.appendChild(list);
                const btnRow = document.createElement('div');
                btnRow.style.marginTop = '16px';
                btnRow.style.display = 'flex';
                btnRow.style.gap = '8px';
                btnRow.style.justifyContent = 'flex-end';
                const cancel = document.createElement('button');
                cancel.type = 'button';
                cancel.textContent = 'Cancel';
                cancel.onclick = () => overlay.remove();
                const saveAnyway = document.createElement('button');
                saveAnyway.type = 'button';
                saveAnyway.textContent = 'Export anyway';
                saveAnyway.onclick = () => { overlay.remove(); onSaveAnyway(); };
                btnRow.appendChild(cancel);
                btnRow.appendChild(saveAnyway);
                box.appendChild(btnRow);
                overlay.appendChild(box);
                document.body.appendChild(overlay);
            }
    });
})();
