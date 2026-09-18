/* file-io — moved verbatim off the PaintEngine class body.
 *
 * Assigned onto the prototype, so `this` is the same PaintEngine instance
 * these methods have always run against. Loads after paint-engine.js and
 * before boot.js, which is where the instance is finally created.
 */
(function () {
    Object.assign(PaintEngine.prototype, {
            loadImageFromBlob(blob) {
                return new Promise((resolve, reject) => {
                    const img = new Image();
                    const url = URL.createObjectURL(blob);
                    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
                    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
                    img.src = url;
                });
            },

            loadImageFromDataUrl(blob) {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const img = new Image();
                        img.onload = () => resolve(img);
                        img.onerror = (e) => reject(e);
                        img.src = reader.result;
                    };
                    reader.onerror = (e) => reject(e);
                    reader.readAsDataURL(blob);
                });
            },

            loadImageFromSrc(src) {
                return new Promise((resolve, reject) => {
                    const img = new Image();
                    img.onload = () => resolve(img);
                    img.onerror = (e) => reject(e);
                    img.src = src;
                });
            },

            async evaluateDecodedImageVariants(blob, evaluate) {
                let reusableCanvas = null;
                let reusableCtx = null;

                const evaluateSource = async (source, label) => {
                    if (!source || !source.width || !source.height) return false;
                    if (!reusableCanvas) {
                        reusableCanvas = document.createElement('canvas');
                    }
                    if (reusableCanvas.width !== source.width) reusableCanvas.width = source.width;
                    if (reusableCanvas.height !== source.height) reusableCanvas.height = source.height;
                    reusableCtx = this.get2dContext(reusableCanvas);
                    this.disableSmoothing(reusableCtx);
                    reusableCtx.clearRect(0, 0, reusableCanvas.width, reusableCanvas.height);
                    reusableCtx.drawImage(source, 0, 0);
                    await evaluate(reusableCanvas, reusableCtx, label);
                    return true;
                };

                if (window.createImageBitmap) {
                    try {
                        const bmp = await createImageBitmap(blob);
                        try { await evaluateSource(bmp, 'bitmap-default'); }
                        finally { if (bmp.close) bmp.close(); }
                    } catch (e) {}

                    try {
                        const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
                        try { await evaluateSource(bmp, 'bitmap-no-color-conv'); }
                        finally { if (bmp.close) bmp.close(); }
                    } catch (e) {}

                    try {
                        const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none' });
                        try { await evaluateSource(bmp, 'bitmap-unpremul'); }
                        finally { if (bmp.close) bmp.close(); }
                    } catch (e) {}

                    try {
                        const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
                        try { await evaluateSource(bmp, 'bitmap-no-color-conv-unpremul'); }
                        finally { if (bmp.close) bmp.close(); }
                    } catch (e) {}
                }

                try {
                    await evaluateSource(await this.loadImageFromBlob(blob), 'img-object-url');
                } catch (e) {}

                try {
                    await evaluateSource(await this.loadImageFromDataUrl(blob), 'img-data-url');
                } catch (e) {}
            },

            async openFileFromPath(path, _skipUnsavedCheck = false) {
                this.clearProjectAssetState();
                if (!_skipUnsavedCheck && this.hasUnsavedChanges()) {
                    return new Promise((resolve) => {
                        this.showOpenConfirm(async () => {
                            const result = await this.openFileFromPath(path, true);
                            resolve(result);
                        }, 'Opening a new file');
                    });
                }
                const tauri = window.__TAURI__;
                if (!tauri || !this.getTauriInvokeFn() || !path) {
                    if (!this.state.hasDocument) this.initializeBlankDocument();
                    return false;
                }
                const normalizedPath = this.normalizeIncomingPath(path);
                if (!this.isSupportedImagePath(normalizedPath)) {
                    console.warn('Rejected non-image path', normalizedPath);
                    if (!this.state.hasDocument) this.initializeBlankDocument();
                    this.state.isFileLoading = false;
                    this.updateBusyIndicator();
                    return false;
                }
                /* Route .ora files through the layer loader */
                if (/\.ora$/i.test(normalizedPath)) {
                    try {
                        const bytes = await this.getTauriInvokeFn()('read_image_file', { path: normalizedPath });
                        const file = new File([new Uint8Array(bytes)], this.getFilenameFromPath(normalizedPath), { type: 'image/openraster' });
                        await this.loadORAFile(file);
                        this.addRecentFile({ name: this.state.fileName, path: normalizedPath });
                        return true;
                    } catch (err) {
                        console.log('Failed to load ORA file', { path: normalizedPath, err });
                        if (!this.state.hasDocument) this.initializeBlankDocument();
                        return false;
                    }
                }
                this.state.isFileLoading = true;
                this.updateBusyIndicator();
                this.state.fileHandle = null;
                this.state.filePath = null;
                try {
                    const img = await this.loadTauriImageFromPath(normalizedPath);
                    this.state.fileHandle = null;
                    this.state.filePath = normalizedPath;
                    this.state.fileName = this.getFilenameFromPath(normalizedPath);
                    await this.handleLoadedImage(img, false);
                    this.addRecentFile({ name: this.state.fileName, path: normalizedPath });
                    return true;
                } catch (err) {
                    console.log('Failed to load file', { path: normalizedPath, err });
                    if (!this.state.hasDocument) this.initializeBlankDocument();
                    return false;
                } finally {
                    this.state.isFileLoading = false;
                    this.updateBusyIndicator();
                }
            },
            saveFromReminder() {
                this.dismissSaveReminder();
                this.saveFile();
            },
            loadRecentFiles() {
                const raw = this.lsGet(this.recentFilesStorageKey);
                let list = [];
                try {
                    const parsed = raw ? JSON.parse(raw) : [];
                    if (Array.isArray(parsed)) list = parsed;
                } catch (e) {
                    list = [];
                }
                this.state.recentFiles = list
                    .filter((item) => item && typeof item.name === 'string' && item.name.trim())
                    .map((item) => ({
                        name: String(item.name).trim(),
                        path: item.path ? String(item.path) : '',
                        ts: Number(item.ts) || 0
                    }))
                    .slice(0, this.maxRecentFiles);
            },
            saveRecentFiles() {
                this.lsSet(this.recentFilesStorageKey, JSON.stringify(this.state.recentFiles || []));
            },
            async openRecentFile(index) {
                const item = (this.state.recentFiles || [])[index];
                if (!item || !item.path) return;
                this.setFileMenuRecentCollapsed(true);
                const ok = await this.openFileFromPath(item.path);
                if (ok) return;
                this.state.recentFiles = (this.state.recentFiles || []).filter((_, i) => i !== index);
                this.saveRecentFiles();
                this.renderFileMenuRecentFiles();
                showToast('Could not open this recent file. It may have been moved or removed.', 'error');
            },
            openFitToTarget(docIn, title) {
                const plan = this.planFitToTarget(undefined, docIn);
                if (!plan) { showToast('No project asset open', 'warning'); return; }
                if (!plan.steps.length) {
                    // Incoming art that needs no fixing still has to be installed;
                    // there is just nothing to show the artist a choice about.
                    if (docIn) { this.applyFitToTarget([], undefined, docIn); return; }
                    showToast('Already insertable — nothing to fit', 'info');
                    return;
                }

                const chosen = new Set(plan.steps.map(s => s.id));
                const overlay = document.createElement('div');
                overlay.id = 'fit-overlay';
                const box = document.createElement('div');
                box.id = 'fit-box';
                overlay.appendChild(box);

                const h3 = document.createElement('h3');
                h3.textContent = title || ('Fit to ' + plan.profile.label.toLowerCase());
                box.appendChild(h3);
                const sub = document.createElement('div');
                sub.className = 'fit-sub';
                sub.textContent = this.getFilenameFromPath(this.state.projectFile || '') || 'this asset';
                box.appendChild(sub);

                const diff = document.createElement('div');
                diff.className = 'fit-diff';
                const beforeC = document.createElement('canvas');
                const afterC = document.createElement('canvas');
                [['Now', beforeC], ['After', afterC]].forEach(([caption, canvas]) => {
                    const fig = document.createElement('figure');
                    fig.appendChild(canvas);
                    const cap = document.createElement('figcaption');
                    cap.textContent = caption;
                    fig.appendChild(cap);
                    diff.appendChild(fig);
                });
                box.appendChild(diff);

                const list = document.createElement('ul');
                list.className = 'fit-steps';
                box.appendChild(list);

                const scale = Math.max(1, Math.min(3, Math.floor(220 / Math.max(plan.doc.w, plan.doc.h)) || 1));
                const redraw = () => {
                    this.renderProjectDocInto(beforeC, plan.doc, scale);
                    let doc = plan.doc;
                    const order = { slot0: 0, colors: 1, size: 2 };
                    plan.steps.slice()
                        .filter(s => chosen.has(s.id))
                        .sort((a, b) => order[a.id] - order[b.id])
                        .forEach(s => { doc = this.fitStepApply(doc, s); });
                    this.renderProjectDocInto(afterC, doc, scale);
                };

                plan.steps.forEach((step) => {
                    const li = document.createElement('li');
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.checked = true;
                    cb.onchange = () => {
                        if (cb.checked) chosen.add(step.id); else chosen.delete(step.id);
                        redraw();
                    };
                    li.appendChild(cb);
                    const label = document.createElement('label');
                    label.className = 'fit-label';
                    label.textContent = step.label;
                    const detail = document.createElement('span');
                    detail.className = 'fit-detail' + (step.destructive ? ' fit-warn' : '');
                    detail.textContent = step.detail;
                    label.appendChild(detail);
                    label.onclick = () => { cb.checked = !cb.checked; cb.onchange(); };
                    li.appendChild(label);
                    list.appendChild(li);
                });

                const actions = document.createElement('div');
                actions.className = 'fit-actions';
                const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
                const onKey = (e) => { if (e.key === 'Escape') close(); };
                const cancel = document.createElement('button');
                cancel.type = 'button';
                cancel.textContent = 'Cancel';
                cancel.onclick = close;
                const apply = document.createElement('button');
                apply.type = 'button';
                apply.className = 'fit-primary';
                apply.textContent = 'Apply';
                apply.onclick = () => {
                    close();
                    this.applyFitToTarget(Array.from(chosen), undefined, docIn);
                };
                actions.appendChild(cancel);
                actions.appendChild(apply);
                box.appendChild(actions);

                document.addEventListener('keydown', onKey);
                document.body.appendChild(overlay);
                redraw();
            },

            /* Run the chosen fixes and install the result. One step, so one undo. */
            handleFile(f, isPaste = false) {
                if (!isPaste && this.hasUnsavedChanges()) {
                    const file = f;
                    this.showOpenConfirm(() => this.handleFile(file, false), 'Opening a new file');
                    return;
                }
                if (isPaste && this.config.transparentSelection && this.config.transAutoPaste) {
                    this.handlePastedFileWithConversions(f);
                    return;
                }
                if (!isPaste && f && f.name) {
                    this.state.fileHandle = null;
                    this.state.filePath = null;
                    this.state.fileName = f.name;
                    this.updateTitleFilename();
                    this.addRecentFile({ name: f.name, path: '' });
                }
                const loadImage = (img) => { this.handleLoadedImage(img, isPaste); };
                if (window.createImageBitmap) {
                    createImageBitmap(f).then(loadImage).catch(() => {
                        const i = new Image();
                        const _u = URL.createObjectURL(f);
                        i.onload = () => { URL.revokeObjectURL(_u); loadImage(i); };
                        i.onerror = () => URL.revokeObjectURL(_u);
                        i.src = _u;
                    });
                } else {
                    const i = new Image();
                    const _u = URL.createObjectURL(f);
                    i.onload = () => { URL.revokeObjectURL(_u); loadImage(i); };
                    i.onerror = () => URL.revokeObjectURL(_u);
                    i.src = _u;
                }
            },

            async handleLoadedImage(img, isPaste) {
                if (isPaste) {
                    if (this.state.selection) this.commitSelection();
                    this.ensurePasteCanvasFits(img.width, img.height);
                    const c = document.createElement('canvas');
                    c.width = img.width;
                    c.height = img.height;
                    const cCtx = this.get2dContext(c);
                    this.disableSmoothing(cCtx);
                    cCtx.drawImage(img, 0, 0);
                    this.normalizeCanvasColors(cCtx, img.width, img.height);
                    let keyMask = null;
                    if (this.config.transparentSelection && this.config.transAutoPaste) {
                        const imgData = cCtx.getImageData(0, 0, img.width, img.height);
                        let bg = null;
                        if (this.config.transColor) bg = this.config.transColor;
                        else if (this.config.transMode === 'c2') bg = this.hexToRgb(this.config.c2);
                        else bg = this.sampleBorderColorFromImageData(imgData, img.width, img.height) || this.hexToRgb(this.config.c2);
                        const mode = this.config.transMode === 'edge' ? 'edge' : 'all';
                        keyMask = this.buildTransparencyKeyMask(imgData, img.width, img.height, bg, this.config.transTol ?? 12, mode);
                    }
                    await this.applyCurrentModeToCanvasAsync(cCtx, img.width, img.height, true);
                    if (keyMask) this.applyTransparencyMaskToCanvas(cCtx, img.width, img.height, keyMask);
                    this.finalizePastedSelection(c);
                } else {
                    // Replace current document: clear history so undo doesn't revert to previous canvas.
                    this.clearProjectAssetState();
                    this.state.history = [];
                    this.state.step = -1;
                    if (this.state.selection) {
                        this.cancelSelection();
                    }
                    this.setSize(img.width, img.height);
                    this.ctx.drawImage(img, 0, 0);
                    await this.applyCurrentModeToCanvasAsync(this.ctx, img.width, img.height, true);
                    this.state.hasDocument = true;
                    this.saveState();
                    this.markSaved(this.state.fileName);
                }
            },
            newFile() {
                this.openModal('new');
            },
            async saveAsFile() {
                /* If layers are active, always save as ORA */
                if (this.layerMgr && this.layerMgr.active && this.layerMgr.layers.length > 1) {
                    return this.saveAsORA();
                }
                const prevHandle = this.state.fileHandle;
                const prevPath = this.state.filePath;
                this.state.fileHandle = null;
                this.state.filePath = null;
                try {
                    await this.saveFile();
                } catch (e) {
                    this.state.fileHandle = prevHandle;
                    this.state.filePath = prevPath;
                    throw e;
                }
            },

            async saveFile(options = {}) {
                /* If layers are active, always save as ORA */
                if (this.layerMgr && this.layerMgr.active && this.layerMgr.layers.length > 1) {
                    return this.saveAsORA();
                }
                /* A tiled screen was assembled out of three files and has to go back
                   into three files. Writing the canvas as one PNG would replace a
                   tile sheet with a picture and leave the tilemap pointing at
                   nothing, so this comes before the ordinary project save. */
                if (window.TiledScreen && window.TiledScreen.isOpen()) {
                    try {
                        return await window.TiledScreen.save();
                    } catch (e) {
                        console.error('Screen save failed', e);
                        showToast('Screen save failed: ' + this.getErrorText(e), 'error');
                        return;
                    }
                }
                /* Project (pokeemerald) images are written back as indexed PNG with the
                   exact original palette/indices and no injected CDPaint metadata. */
                if (this.state.projectFile && this.state.projectImage && this.palette && this.palette.length) {
                    try {
                        if (this.state.previewPaletteId) this.exitPreview();
                        const profile = this.inferProfile(this.state.projectFile);
                        const validation = this.validateForExport(profile);
                        if (!validation.ok) {
                            this.showExportValidationModal(validation.errors, () => this.doExportProjectFile());
                            return;
                        }
                        await this.doExportProjectFile();
                    } catch (e) {
                        console.error('Project save failed', e);
                        showToast('Project save failed: ' + this.getErrorText(e), 'error');
                    }
                    return;
                }
                const opts = options && typeof options === 'object' ? options : {};
                const wantCursorFeedback = !!opts.cursorFeedback;
                let savedSuccessfully = false;
                this.state.isSaving = true;
                this.updateBusyIndicator();
                try {
                    const supportsFs = window.showSaveFilePicker && window.showOpenFilePicker;
                    let blob = await this.pngBlobFromCanvas(this.ui.cMain);
                    blob = await PngMetadata.inject(blob);
                    if (this.getTauriInvokeFn() && this.state.filePath) {
                        const normalizedPath = this.normalizeIncomingPath(this.state.filePath);
                        if (!this.isSupportedImagePath(normalizedPath)) {
                            throw new Error(`Refusing to write non-image path: ${normalizedPath}`);
                        }
                        const bytes = new Uint8Array(await blob.arrayBuffer());
                        await this.tauriWriteAllowedFile(normalizedPath, bytes);
                        this.state.filePath = normalizedPath;
                        this.markSaved(this.getFilenameFromPath(normalizedPath));
                        this.resetSaveReminderTimer();
                        savedSuccessfully = true;
                        return;
                    }
                    if (supportsFs) {
                        if (!this.state.fileHandle) {
                            this.state.fileHandle = await window.showSaveFilePicker({
                                suggestedName: 'untitled.png',
                                types: [{ description: 'PNG Image', accept: { 'image/png': ['.png'] } }]
                            });
                        }
                        const writable = await this.state.fileHandle.createWritable();
                        await writable.write(blob);
                        await writable.close();
                        this.markSaved(this.state.fileHandle.name);
                        this.resetSaveReminderTimer();
                        savedSuccessfully = true;
                        return;
                    }
                    const link = document.createElement('a');
                    link.download = this.getCurrentFilename();
                    const objectUrl = URL.createObjectURL(blob);
                    link.href = objectUrl;
                    link.click();
                    URL.revokeObjectURL(objectUrl);
                    this.markSaved(this.getCurrentFilename());
                    this.resetSaveReminderTimer();
                    savedSuccessfully = true;
                } finally {
                    this.state.isSaving = false;
                    if (savedSuccessfully && wantCursorFeedback) {
                        this.queueSaveCursorFeedback();
                    } else {
                        setTimeout(() => this.updateBusyIndicator(), 13);
                    }
                }
            }

            // ── Freehand Brush Engine ──────────────────────────────────────────────────

    });
})();
