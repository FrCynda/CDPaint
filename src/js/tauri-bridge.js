/* tauri-bridge — moved verbatim off the PaintEngine class body.
 *
 * Assigned onto the prototype, so `this` is the same PaintEngine instance
 * these methods have always run against. Loads after paint-engine.js and
 * before boot.js, which is where the instance is finally created.
 */
(function () {
    Object.assign(PaintEngine.prototype, {
            loadTauriImageFromPath(path) {
                const tauri = window.__TAURI__;
                const convertFileSrc = tauri && tauri.core && typeof tauri.core.convertFileSrc === 'function'
                    ? tauri.core.convertFileSrc
                    : null;
                if (!convertFileSrc) {
                    return this.tauriReadImageBytes(path).then((data) => {
                        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
                        return this.loadImageFromBlob(new Blob([bytes]));
                    });
                }
                const fastSrc = convertFileSrc(path);
                return new Promise((resolve, reject) => {
                    let settled = false;
                    let fallbackStarted = false;
                    let fallbackTimer = null;
                    const finishResolve = (img) => {
                        if (settled) return;
                        settled = true;
                        if (fallbackTimer) clearTimeout(fallbackTimer);
                        resolve(img);
                    };
                    const finishReject = (err) => {
                        if (settled) return;
                        settled = true;
                        if (fallbackTimer) clearTimeout(fallbackTimer);
                        reject(err);
                    };
                    const tryBytesFallback = async () => {
                        if (settled || fallbackStarted) return;
                        fallbackStarted = true;
                        try {
                            const data = await this.tauriReadImageBytes(path);
                            if (settled) return;
                            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
                            const img = await this.loadImageFromBlob(new Blob([bytes]));
                            finishResolve(img);
                        } catch (err) {
                            finishReject(err);
                        }
                    };
                    const fastImg = new Image();
                    fastImg.onload = () => finishResolve(fastImg);
                    fastImg.onerror = () => { tryBytesFallback(); };
                    fallbackTimer = setTimeout(() => { tryBytesFallback(); }, 50);
                    fastImg.src = fastSrc;
                });
            },

            initTauriFileOpenListener() {
                const tauri = window.__TAURI__;
                if (!tauri || !tauri.event) {
                    this.initializeBlankDocument();
                    return Promise.resolve();
                }
                tauri.event.listen('open-file', (event) => {
                    const payload = event && event.payload;
                    if (!payload) return;
                    if (Array.isArray(payload)) {
                        payload.forEach(path => {
                            this.openFileFromPath(path).catch((err) => {
                                console.log('open-file event load failed', { path, err });
                            });
                        });
                    } else {
                        this.openFileFromPath(payload).catch((err) => {
                            console.log('open-file event load failed', { path: payload, err });
                        });
                    }
                });
                const invoke = this.getTauriInvokeFn();
                if (invoke) {
                    return invoke('get_pending_file').then((path) => {
                        if (path) {
                            return this.openFileFromPath(path);
                        } else {
                            this.initializeBlankDocument();
                            return null;
                        }
                    }).catch(() => {
                        this.initializeBlankDocument();
                        return null;
                    });
                }
                this.initializeBlankDocument();
                return Promise.resolve();
            },
            /* Forget that the document was a project asset. Every path that replaces
               the document has to call this: the index map and the palettes it names
               belong to one file, and a document that inherits them would be snapped
               onto the previous asset's slots on its first committed edit. */
            getTauriWindow() {
                if (this._tauriWindow) return this._tauriWindow;
                const api = window.__TAURI__ && window.__TAURI__.window;
                if (!api) return null;
                if (api.appWindow) {
                    this._tauriWindow = api.appWindow;
                    return this._tauriWindow;
                }
                if (api.getCurrentWindow) {
                    this._tauriWindow = api.getCurrentWindow();
                    return this._tauriWindow;
                }
                if (api.getCurrent) {
                    this._tauriWindow = api.getCurrent();
                    return this._tauriWindow;
                }
                return null;
            },
            getTauriInvokeFn() {
                const tauri = window.__TAURI__;
                if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
                    return tauri.core.invoke.bind(tauri.core);
                }
                if (tauri && typeof tauri.invoke === 'function') {
                    return tauri.invoke.bind(tauri);
                }
                const internals = window.__TAURI_INTERNALS__;
                if (internals && typeof internals.invoke === 'function') {
                    return internals.invoke.bind(internals);
                }
                return null;
            },
            async tauriInvoke(command, payload = {}) {
                const invoke = this.getTauriInvokeFn();
                if (!invoke) {
                    throw new Error('Tauri invoke API is unavailable');
                }
                return invoke(command, payload);
            },
            async tauriReadImageBytes(path) {
                const data = await this.tauriInvoke('read_image_file', { path });
                return data instanceof Uint8Array ? data : new Uint8Array(data);
            },
            async tauriWriteAllowedFile(path, data) {
                const bytes = this.toUint8Array(data);
                await this.tauriInvoke('write_allowed_file', { path, data: Array.from(bytes) });
            },
            async tauriWriteExportFiles(directory, files) {
                const dir = this.normalizeExportDirectoryPath(directory);
                const payloadFiles = (files || []).map((file) => ({
                    name: String(file.name || ''),
                    data: Array.from(this.toUint8Array(file.bytes))
                }));
                await this.tauriInvoke('write_export_files', { directory: dir, files: payloadFiles });
            },
            async tauriWriteExportFilesPerFile(directory, files) {
                const dir = this.normalizeExportDirectoryPath(directory);
                if (!dir) throw new Error('Export directory is empty');
                const list = Array.isArray(files) ? files : [];
                for (const file of list) {
                    const fileName = String((file && file.name) || '').trim();
                    if (!fileName) throw new Error('Export file name is empty');
                    const outputPath = this.joinPath(dir, fileName);
                    await this.tauriWriteAllowedFile(outputPath, file.bytes);
                }
            },
            async tauriWriteExportFilesWithDialog(files) {
                const payloadFiles = (files || []).map((file) => ({
                    name: String(file.name || ''),
                    data: Array.from(this.toUint8Array(file.bytes))
                }));
                try {
                    const result = await this.tauriInvoke('write_export_files_with_dialog', { files: payloadFiles });
                    if (!result) return null;
                    return true;
                } catch (e) {
                    const msg = String((e && e.message) || e || '');
                    if (/unknown command|not found|write_export_files_with_dialog/i.test(msg)) {
                        return undefined;
                    }
                    throw e;
                }
            },
            async tauriWriteExportFilesWithSaveDialog(files) {
                const payloadFiles = (files || []).map((file) => ({
                    name: String(file.name || ''),
                    data: Array.from(this.toUint8Array(file.bytes))
                }));
                const suggested = files && files.length ? String(files[0].name || '') : '';
                const attempts = [
                    { files: payloadFiles, suggestedName: suggested },
                    { files: payloadFiles, suggested_name: suggested }
                ];
                let lastArgError = null;
                for (const payload of attempts) {
                    try {
                        const result = await this.tauriInvoke('write_export_files_with_save_dialog', payload);
                        if (!result) return null;
                        return true;
                    } catch (e) {
                        const msg = String((e && e.message) || e || '');
                        if (/unknown command|not found|write_export_files_with_save_dialog/i.test(msg)) {
                            return undefined;
                        }
                        if (/invalid args|missing required key|unknown field|invalid type/i.test(msg)) {
                            lastArgError = e;
                            continue;
                        }
                        throw e;
                    }
                }
                if (lastArgError) throw lastArgError;
                return undefined;
            },
            async tauriWriteExportFileWithSaveDialog(file, defaultDirectory = '') {
                const payloadFile = {
                    name: String((file && file.name) || ''),
                    data: Array.from(this.toUint8Array(file && file.bytes))
                };
                const suggested = String(payloadFile.name || '');
                const defaultDir = this.normalizeExportDirectoryPath(defaultDirectory);
                const attempts = [
                    { file: payloadFile, suggestedName: suggested, defaultDirectory: defaultDir || null },
                    { file: payloadFile, suggested_name: suggested, default_directory: defaultDir || null }
                ];
                let lastArgError = null;
                for (const payload of attempts) {
                    try {
                        const result = await this.tauriInvoke('write_export_file_with_save_dialog', payload);
                        if (result === null) return null;
                        if (typeof result === 'string') {
                            return this.normalizeExportDirectoryPath(result);
                        }
                        return '';
                    } catch (e) {
                        const msg = String((e && e.message) || e || '');
                        if (/unknown command|not found|write_export_file_with_save_dialog/i.test(msg)) {
                            return undefined;
                        }
                        if (/invalid args|missing required key|unknown field|invalid type/i.test(msg)) {
                            lastArgError = e;
                            continue;
                        }
                        throw e;
                    }
                }
                if (lastArgError) throw lastArgError;
                return undefined;
            },
            async tauriPickExportFolderNative() {
                try {
                    const dir = await this.tauriInvoke('pick_export_folder');
                    if (!dir) return null;
                    const out = this.normalizeExportDirectoryPath(dir);
                    return out || null;
                } catch (e) {
                    return undefined;
                }
            },
            async tauriOpenDirectoryDialog(options = {}) {
                const tauri = window.__TAURI__;
                if (!tauri) return undefined;
                if (tauri.dialog && typeof tauri.dialog.open === 'function') {
                    return tauri.dialog.open(options);
                }
                const invoke = this.getTauriInvokeFn();
                if (invoke) {
                    try {
                        return await invoke('plugin:dialog|open', { options });
                    } catch (e) {
                        try {
                            // Some runtimes may expect options to be passed directly.
                            return await invoke('plugin:dialog|open', options);
                        } catch (_) {
                            throw e;
                        }
                    }
                }
                return undefined;
            },
            async tauriSaveFileDialog(options = {}) {
                const tauri = window.__TAURI__;
                if (!tauri) return undefined;
                if (tauri.dialog && typeof tauri.dialog.save === 'function') {
                    return tauri.dialog.save(options);
                }
                const invoke = this.getTauriInvokeFn();
                if (invoke) {
                    try {
                        return await invoke('plugin:dialog|save', { options });
                    } catch (e) {
                        try {
                            // Some runtimes may expect options to be passed directly.
                            return await invoke('plugin:dialog|save', options);
                        } catch (_) {
                            throw e;
                        }
                    }
                }
                return undefined;
            },
            async tauriWriteExportFilesOneByOneViaDialog(files, initialDirectory = '') {
                const list = Array.isArray(files) ? files : [];
                if (!list.length) return true;
                let dirHint = this.normalizeExportDirectoryPath(initialDirectory);
                for (const file of list) {
                    const fileName = String((file && file.name) || '').trim() || 'export.png';
                    const defaultPath = dirHint ? this.joinPath(dirHint, fileName) : fileName;
                    const selection = await this.tauriSaveFileDialog({
                        title: 'Save Export File',
                        defaultPath
                    });
                    if (selection === undefined) return undefined;
                    if (!selection) return null;
                    const outPath = this.normalizeDialogPathSelection(selection);
                    if (!outPath) return null;
                    await this.tauriWriteAllowedFile(outPath, file.bytes);
                    const parent = this.getParentDirectory(outPath);
                    if (parent) dirHint = parent;
                }
                if (dirHint) this.state.exportDir = dirHint;
                return true;
            }
    });
})();
