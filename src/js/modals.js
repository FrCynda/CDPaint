/* modals — moved verbatim off the PaintEngine class body.
 *
 * Assigned onto the prototype, so `this` is the same PaintEngine instance
 * these methods have always run against. Loads after paint-engine.js and
 * before boot.js, which is where the instance is finally created.
 */
(function () {
    Object.assign(PaintEngine.prototype, {
            initModalInteractions() {
                const ids = ['modal-resize', 'modal-depth', 'modal-gapstitch', 'modal-export', 'modal-huesat', 'save-reminder-modal', 'close-confirm-modal', 'modal-info', 'modal-colors', 'modal-confirm-reset', 'modal-toolbar', 'modal-tool-customizer', 'modal-brush-pack'];
                ids.forEach(id => {
                    const modal = document.getElementById(id);
                    if (!modal) return;
                    modal.addEventListener('click', (e) => {
                        if (e.target === modal) {
                            if (this.isColorModalOpen() && id !== 'modal-colors') return;
                            if (id === 'modal-export') return;
                            if (id === 'modal-colors') return;
                            if (id === 'modal-huesat') this.cancelHueSat();
                            else if (id === 'modal-resize') this.cancelResize();
                            else if (id === 'modal-depth') this.cancelDepth();
                            else if (id === 'save-reminder-modal') this.dismissSaveReminder();
                            else if (id === 'close-confirm-modal') this.dismissCloseConfirm();
                            else if (id === 'modal-info') this.closeInfoModal();
                            else if (id === 'modal-gapstitch') this.closeGapStitchModal();
                            else this.closeModals();
                        }
                    });
                    const title = modal.querySelector('.title-bar');
                    if (title) {
                        title.addEventListener('mousedown', (e) => this.startModalDrag(id, e));
                    }
                });
                window.addEventListener('mousemove', (e) => this.moveModalDrag(e));
                window.addEventListener('mouseup', () => this.endModalDrag());
                window.addEventListener('focus', () => {
                    if (!this._inPopup) this.renderToolGrid();
                });
            },
            startModalDrag(modalId, e) {
                if (e.button !== 0) return;
                const modal = document.getElementById(modalId);
                if (modalId === 'modal-huesat' && this._activeSidebarModalId === 'huesat') return;
                const win = modal ? modal.querySelector('.window') : null;
                if (!win) return;
                const rect = win.getBoundingClientRect();
                this.modalDrag = {
                    modalId,
                    offsetX: e.clientX - rect.left,
                    offsetY: e.clientY - rect.top
                };
                e.preventDefault();
            },
            moveModalDrag(e) {
                if (!this.modalDrag) return;
                const modal = document.getElementById(this.modalDrag.modalId);
                const win = modal ? modal.querySelector('.window') : null;
                if (!win) return;
                const x = e.clientX - this.modalDrag.offsetX;
                const y = e.clientY - this.modalDrag.offsetY;
                this.setClampedWindowPosition(win, x, y);
            },
            endModalDrag() {
                this.modalDrag = null;
            },
            queueSaveReminderModal() {
                if (this._saveReminderActive) return;
                if (this._saveReminderCheck) clearInterval(this._saveReminderCheck);
                this._saveReminderCheck = setInterval(() => this.tryShowSaveReminderModal(), 200);
                this.tryShowSaveReminderModal();
            },
            tryShowSaveReminderModal() {
                const idleMs = performance.now() - this._lastMouseMoveAt;
                if (idleMs < 2000) return;
                this.showSaveReminderModal();
            },
            showSaveReminderModal() {
                if (!this.ui.saveReminderModal) return;
                if (this._saveReminderActive) return;
                this._saveReminderActive = true;
                if (this._saveReminderCheck) {
                    clearInterval(this._saveReminderCheck);
                    this._saveReminderCheck = null;
                }
                const filename = this.getSaveReminderFilename();
                const label = document.getElementById('save-reminder-filename');
                if (label) label.textContent = filename;
                this.ui.saveReminderModal.style.display = 'flex';
                this.centerModal('save-reminder-modal');
            },
            openInfoModal() {
                const modal = document.getElementById('modal-info');
                if (!modal) return;
                modal.style.display = 'flex';
                this.centerModal('modal-info');
            },
            closeInfoModal() {
                const modal = document.getElementById('modal-info');
                if (!modal) return;
                modal.style.display = 'none';
            },
            prepareUpdateModal() {
                const status = document.getElementById('update-status');
                const progress = document.getElementById('update-progress');
                const cur = document.getElementById('update-current-ver');
                const latest = document.getElementById('update-latest-ver');
                const notes = document.getElementById('update-notes');
                const btnInstall = document.getElementById('btn-update-install');
                const btnOpen = document.getElementById('btn-update-open-release');
                const btnCheck = document.getElementById('btn-update-check');

                if (status) {
                    status.classList.remove('is-checking', 'is-available', 'is-ok', 'is-warn', 'is-error');
                    status.textContent = 'Checking for updates will show what is new and enable one-click install (when supported).';
                }
                if (progress) progress.style.display = 'none';
                if (cur) cur.textContent = '-';
                if (latest) latest.textContent = '-';
                if (notes) notes.innerHTML = '<div class="empty">Release notes will appear here.</div>';
                if (btnInstall) {
                    btnInstall.disabled = true;
                    btnInstall.textContent = 'Update';
                }
                if (btnOpen) btnOpen.style.display = 'none';
                if (btnCheck) btnCheck.disabled = false;

                this._latestGithubRelease = null;
                this._latestUpdaterManifest = null;
            },
            refreshPropsModal(resetInputs = true) {
                const wInput = document.getElementById('pr-w');
                const hInput = document.getElementById('pr-h');
                const grid = document.getElementById('props-info-grid');
                if (!wInput || !hInput || !grid) return;
                if (resetInputs) {
                    wInput.value = this.config.width;
                    hInput.value = this.config.height;
                }
                const targetW = parseInt(wInput.value, 10);
                const targetH = parseInt(hInput.value, 10);
                const now = Date.now();
                const canvasW = this.config.width;
                const canvasH = this.config.height;
                const pixelCount = canvasW * canvasH;
                const rawRgbaBytes = pixelCount * 4;
                const filename = this.getCurrentFilename();
                const extension = filename.includes('.') ? `.${filename.split('.').pop()}` : '(none)';
                const historySize = this.state.history ? this.state.history.length : 0;
                const selection = this.state.selection;
                const selectionBounds = selection ? `${selection.w}x${selection.h} @ (${selection.x}, ${selection.y})` : 'none';
                const zoomPct = `${Math.round((this.config.zoom || 1) * 100)}%`;
                const bootMs = Math.max(0, now - this.appStartedAt);
                const tauriOn = this.getTauriInvokeFn() ? 'Yes' : 'No';
                const palSize = Array.isArray(this.palette) ? this.palette.length : 0;
                const sectionData = [
                    {
                        title: 'Document',
                        rows: [
                            ['File name', filename],
                            ['File path', this.state.filePath || '(none)'],
                            ['Extension', extension],
                            ['Current canvas', `${canvasW} x ${canvasH}`],
                            ['Target canvas', Number.isFinite(targetW) && Number.isFinite(targetH) ? `${targetW} x ${targetH}` : 'invalid input'],
                            ['Pixels', this.formatNumber(pixelCount)],
                            ['Aspect ratio', `${canvasW}:${canvasH}`],
                            ['Estimated RGBA size', this.formatBytes(rawRgbaBytes)]
                        ]
                    },
                    {
                        title: 'Color + State',
                        rows: [
                            ['Depth', this.getPropsDepthLabel()],
                            ['Palette size', this.formatNumber(palSize)],
                            ['Color 1', this.config.c1],
                            ['Color 2', this.config.c2],
                            ['Unsaved changes', this.state.isDirty ? 'Yes' : 'No'],
                            ['History entries', this.formatNumber(historySize)],
                            ['Selection', selection ? selectionBounds : 'none'],
                            ['Zoom', zoomPct]
                        ]
                    },
                    {
                        title: 'Runtime',
                        rows: [
                            ['Theme mode', this.themeMode || 'light'],
                            ['Tauri runtime', tauriOn],
                            ['Window size', `${window.innerWidth}x${window.innerHeight}`],
                            ['Device pixel ratio', window.devicePixelRatio || 1],
                            ['Session age', `${Math.round(bootMs / 1000)}s`]
                        ]
                    }
                ];
                grid.innerHTML = sectionData.map((section) => {
                    const rowsHtml = section.rows.map((row) => (
                        `<div class="props-k">${this.escapeHtml(row[0])}</div><div class="props-v">${this.escapeHtml(row[1])}</div>`
                    )).join('');
                    return `<section class="props-card"><h4>${this.escapeHtml(section.title)}</h4><div class="props-kv">${rowsHtml}</div></section>`;
                }).join('');
            },
            renderFileMenuRecentFiles() {
                const listEl = this.ui.fileMenuRecentList || document.getElementById('file-menu-recent-list');
                if (!listEl) return;
                listEl.innerHTML = '';
                const items = this.state.recentFiles || [];
                if (!items.length) {
                    const li = document.createElement('li');
                    li.className = 'file-menu-recent-item is-empty';
                    li.textContent = 'No recent files yet';
                    listEl.appendChild(li);
                    return;
                }
                items.forEach((item, index) => {
                    const li = document.createElement('li');
                    li.className = 'file-menu-recent-item';
                    const num = document.createElement('span');
                    num.className = 'file-menu-recent-number';
                    num.textContent = String(index + 1);
                    const label = document.createElement('span');
                    label.textContent = item.name;
                    li.appendChild(num);
                    li.appendChild(label);
                    const canOpen = !!item.path && this.isSupportedImagePath(item.path);
                    if (item.path) li.title = item.path;
                    if (canOpen) {
                        li.style.cursor = 'pointer';
                        li.addEventListener('click', () => this.openRecentFile(index));
                    } else {
                        li.style.cursor = 'default';
                    }
                    listEl.appendChild(li);
                });
            },
            setFileMenuRecentCollapsed(collapsed, persist = true) {
                this.fileMenuRecentCollapsed = !!collapsed;
                const menu = document.getElementById('file-menu');
                const toggle = this.ui.fileMenuRecentToggle || document.getElementById('file-menu-recent-toggle');
                if (menu) menu.classList.toggle('recent-collapsed', this.fileMenuRecentCollapsed);
                if (toggle) {
                    toggle.innerHTML = this.fileMenuRecentCollapsed ? '&#9654;' : '&#9664;';
                    toggle.title = this.fileMenuRecentCollapsed ? 'Show recent files' : 'Hide recent files';
                    toggle.setAttribute('aria-label', this.fileMenuRecentCollapsed ? 'Show recent files' : 'Hide recent files');
                }
                if (persist) {
                    this.lsSet(this.fileMenuRecentCollapsedStorageKey, this.fileMenuRecentCollapsed ? 'true' : 'false');
                }
            },
            toggleFileMenuRecentPanel(e) {
                if (e) {
                    e.preventDefault();
                    e.stopPropagation();
                }
                this.setFileMenuRecentCollapsed(!this.fileMenuRecentCollapsed);
            },
            isColorModalOpen() {
                const modal = document.getElementById('modal-colors');
                return !!(modal && modal.style.display === 'flex');
            },
            _floatCurrentModal() {
                const id = this._activeSidebarModalId;
                if (!id) return;
                const modal = document.getElementById('modal-' + id);
                const sidebar = document.getElementById('unified-sidebar');
                // Move modal to body and show as floating window
                if ((id === 'huesat' || id === 'resize' || id === 'depth') && sidebar) {
                    if (modal && modal.parentNode !== document.body) {
                        document.body.appendChild(modal);
                    }
                    modal.style.display = 'flex';
                    this.centerModal('modal-' + id);
                }
                // Mark floated and hide its tab button
                this._trackFloated();
                this._floatedModals[id] = true;
                this._saveSidebarUIMode(id, 'floating');
                // Update toggle button on the modal itself
                const btnId = id === 'huesat' ? 'hs-sidebar-toggle-btn' : id + '-sidebar-toggle-btn';
                const btn = document.getElementById(btnId);
                if (btn) { btn.title = 'Dock as sidebar'; btn.innerHTML = this.getSidebarDockIcon(); }
                this._updateSidebarTabVisibility();
                // Find next available tab
                const order = ['depth', 'huesat', 'resize'];
                let nextId = null;
                for (const c of order) {
                    if (this._loadSidebarUIMode(c) === 'sidebar') { nextId = c; break; }
                }
                if (nextId) {
                    if (nextId === 'huesat') this.openHueSat();
                    // Close current quietly (no DOM manipulation since modal already moved)
                    const oldId = this._activeSidebarModalId;
                    this._activeSidebarModalId = null;
                    this._openUnifiedSidebar(nextId);
                } else {
                    // All floated — close sidebar
                    sidebar.classList.add('hidden');
                    this._activeSidebarModalId = null;
                    this._updateSidebarModeButtons(null);
                }
            },
            initRibbonContextMenu() {
                if (this.ribbonContextBound) return;
                const menu = document.getElementById('ribbon-context-menu');
                if (!menu) return;
                const containers = this.getRibbonContainers();
                const handler = (e) => {
                    if (e.target && e.target.closest && (e.target.closest('#wand-tool-btn') || e.target.closest('#picker-tool-btn'))) {
                        return;
                    }
                    if (e.target && e.target.closest && e.target.closest('#palette-std')) {
                        return;
                    }
                    e.preventDefault();
                    this.closeMenus();
                    const section = e.target.closest('.section');
                    this.state.ribbonContextSection = section || null;
                    const hideItem = document.getElementById('ribbon-menu-hide-section');
                    if (hideItem) hideItem.style.display = section ? '' : 'none';
                    menu.style.left = `${e.clientX}px`;
                    menu.style.top = `${e.clientY}px`;
                    menu.style.display = 'flex';
                };
                if (containers.home) containers.home.addEventListener('contextmenu', handler);
                if (containers.view) containers.view.addEventListener('contextmenu', handler);
                this.ribbonContextBound = true;
            },
            openPickerMenu(e) {
                const menu = document.getElementById('picker-menu');
                if (!menu) return;
                menu.style.display = 'flex';
                menu.style.left = e.clientX + 'px';
                menu.style.top = e.clientY + 'px';
            },
            syncPickerMenu() {
                const item = document.getElementById('item-picker-preview');
                if (item) item.classList.toggle('checked', !!this.config.pickerHoverPreview);
            },
            openPaintbrushMenu(e) {
                const menu = document.getElementById('paintbrush-menu');
                if (!menu) return;
                menu.style.display = 'flex';
                menu.style.left = e.clientX + 'px';
                menu.style.top = e.clientY + 'px';
            },

            initWinColorDialog() {
                if (this._winColorDialogInit) return;
                this._winColorDialogInit = true;
                this.winColorCustom = Array(16).fill('#ffffff');
                this.winColorSelected = '#000000';
                this.winColorCustomIndex = 0;
                this.winColorCustomCursor = 0;
                this.renderWinColorGrids();
                const bindInput = (id, fn) => {
                    const el = document.getElementById(id);
                    el.addEventListener('input', fn);
                };
                bindInput('win-r', () => this.updateWinFromRgb());
                bindInput('win-g', () => this.updateWinFromRgb());
                bindInput('win-b', () => this.updateWinFromRgb());
                bindInput('win-h', () => this.updateWinFromHsl());
                bindInput('win-s', () => this.updateWinFromHsl());
                bindInput('win-l', () => this.updateWinFromHsl());

                const spec = this.ui.winSpectrum;
                const lum = this.ui.winLum;
                const onSpec = (e) => this.handleWinSpectrum(e);
                const onLum = (e) => this.handleWinLum(e);
                spec.addEventListener('mousedown', onSpec);
                lum.addEventListener('mousedown', onLum);
                window.addEventListener('mousemove', (e) => {
                    if (this.winColorDragging === 'spec') this.handleWinSpectrum(e);
                    if (this.winColorDragging === 'lum') this.handleWinLum(e);
                });
                window.addEventListener('mouseup', () => { this.winColorDragging = null; });

                if (this.ui.winTitleBar) {
                    this.ui.winTitleBar.addEventListener('mousedown', (e) => this.startWinColorDrag(e));
                }
                window.addEventListener('mousemove', (e) => this.moveWinColorDrag(e));
                window.addEventListener('mouseup', () => this.endWinColorDrag());
                const winModal = document.getElementById('modal-wincolor');
                if (winModal) {
                    winModal.addEventListener('dblclick', (e) => {
                        if (this.isColorModalOpen()) return;
                        if (e.target === winModal) this.closeWinColor();
                    });
                }
                window.addEventListener('keydown', (e) => {
                    if ((e.key === 'Enter' || e.code === 'NumpadEnter') && document.getElementById('modal-resize').style.display === 'flex') {
                        e.preventDefault();
                        this.applyResize();
                    }
                });
            },
            syncLineWidthMenu() {
                const menu = document.getElementById('line-width-menu');
                if (!menu) return;
                const current = Math.round(this.getToolWidth(this.config.tool));
                menu.querySelectorAll('.line-width-item').forEach((item) => {
                    const w = parseInt(item.dataset.width || '0', 10);
                    item.classList.toggle('selected', w === current);
                });
            },
            toggleLineWidthMenu(e) {
                if (e) {
                    e.preventDefault();
                    e.stopPropagation();
                }
                const menu = document.getElementById('line-width-menu');
                if (!menu) return;
                if (menu.style.display === 'flex') {
                    menu.style.display = 'none';
                    return;
                }
                this.closeMenus();
                this.syncLineWidthMenu();
                const anchor = document.getElementById('line-width-dropdown-btn') || (this.ui && this.ui.sizeInput ? this.ui.sizeInput : document.getElementById('pen-size-input'));
                if (!anchor) return;
                const rect = anchor.getBoundingClientRect();
                const menuW = 132;
                const menuH = 166;
                const margin = 6;
                let left = rect.left + (rect.width / 2) - (menuW / 2) + window.scrollX;
                let top = rect.bottom + margin + window.scrollY;
                const maxLeft = window.scrollX + window.innerWidth - menuW - margin;
                const minLeft = window.scrollX + margin;
                left = Math.max(minLeft, Math.min(left, maxLeft));
                const maxTop = window.scrollY + window.innerHeight - menuH - margin;
                if (top > maxTop) {
                    top = rect.top - menuH - margin + window.scrollY;
                }
                menu.style.left = `${Math.round(left)}px`;
                menu.style.top = `${Math.round(top)}px`;
                menu.style.display = 'flex';
            },
            toggleMenu(e, id) {
                e.stopPropagation();
                const m=document.getElementById(id);
                const v=m.style.display==='flex';
                document.querySelectorAll('.dropdown-menu').forEach(x=>x.style.display='none');
                if(!v) {
                    if (id === 'select-menu') {
                        const hasSel = !!this.state.selection;
                        const rectItem = document.getElementById('select-shape-rect');
                        const freeItem = document.getElementById('select-shape-free');
                        const polyItem = document.getElementById('select-shape-poly');
                        const invertItem = document.getElementById('select-invert');
                        const deleteItem = document.getElementById('select-delete');
                        const transItem = document.getElementById('item-trans-sel');
                        const lassoActive = this.config.tool === 'lasso';
                        if (rectItem) rectItem.classList.toggle('selection-highlight', this.config.tool === 'select');
                        if (freeItem) freeItem.classList.toggle('selection-highlight', lassoActive && this.config.lassoSelectMode === 'free');
                        if (polyItem) polyItem.classList.toggle('selection-highlight', lassoActive && this.config.lassoSelectMode === 'poly');
                        if (invertItem) invertItem.classList.toggle('disabled', !hasSel);
                        if (deleteItem) deleteItem.classList.toggle('disabled', !hasSel);
                        if (transItem) transItem.classList.toggle('checked', this.config.transparentSelection);
                    }
                    const rect = e.currentTarget.getBoundingClientRect();
                    m.style.left = (rect.left + window.scrollX) + 'px';
                    m.style.top = (rect.bottom + window.scrollY) + 'px';
                    m.style.display='flex';
                }
            },
            closeMenus() {
                document.querySelectorAll('.dropdown-menu').forEach(x=>x.style.display='none');
            },
            async openModal(id) {
                if (id === 'export') {
                    this.openExportModal();
                    return;
                }

                if (id === 'gapstitch') {
                    const m = document.getElementById('modal-gapstitch');
                    if (m && m.style.display === 'flex') { this.closeGapStitchModal(); return; }
                }

                if (id === 'props') {
                    this.refreshPropsModal(true);
                }
                if(id==='resize') {
                    let w, h;
                    if(this.state.selection) {
                        w = this.state.selection.w;
                        h = this.state.selection.h;
                    } else {
                        w = this.config.width;
                        h = this.config.height;
                    }
                    this.resizeState = { w: w, h: h, ratio: w/h };
                    this.resizeRatioState ??= true;
                    document.getElementById('rz-h-pct').value = 100;
                    document.getElementById('rz-h-px').value  = this.resizeState.w;
                    document.getElementById('rz-v-pct').value = 100;
                    document.getElementById('rz-v-px').value  = this.resizeState.h;
                    document.getElementById('rz-ratio').checked = this.resizeRatioState;
                    if (this._activeSidebarModalId === 'resize') return;
                    if (this._loadSidebarUIMode('resize') === 'sidebar') {
                        this._openUnifiedSidebar('resize');
                        return;
                    }
                }
                if(id==='depth') {
                    let depthVal = '256';
                    if (this.bitDepth === 16) depthVal = 'rgb565';
                    else if (this.bitDepth === 8) depthVal = '256';
                    else if (this.bitDepth === 4) depthVal = '16';
                    else if (this.bitDepth === 1) depthVal = '2';
                    const radio = document.querySelector(`input[name="depth"][value="${depthVal}"]`);
                    if (radio) radio.checked = true;
                    const savedCustomDepth = (() => { try { return this.lsGet('paint.depth.customVal'); } catch(e) { return null; } })();
                    if (savedCustomDepth !== null) { const el = document.getElementById('custom-depth-val'); if (el) el.value = savedCustomDepth; }
                    this.updateDepthUI();
                    const source = this.state.selection ? this.state.selection.canvas : this.ui.cMain;
                    const backup = document.createElement('canvas');
                    backup.width = source.width;
                    backup.height = source.height;
                    backup.getContext('2d').drawImage(source, 0, 0);
                    this.depthBackup = backup;
                    if (this._activeSidebarModalId === 'depth') return;
                    if (this._loadSidebarUIMode('depth') === 'sidebar') {
                        this._openUnifiedSidebar('depth');
                        return;
                    }
                }
                if(id==='huesat') {
                    this.openHueSat();
                    if (this._activeSidebarModalId === 'huesat') return;
                    if (this._loadSidebarUIMode('huesat') === 'sidebar') {
                        this._openUnifiedSidebar('huesat');
                        return;
                    }
                }
                if(id==='colors') {
                    if (!this.colorDefaults || !this.colorStyleEl) {
                        this.initColorCustomizer();
                    }
                    this.buildColorCustomizer();
                    this.toggleThemeSelectMode(false);
                    this.updateThemeSelectUi();
                    this.centerModal('modal-' + id);
                }
                if(id==='toolbar') {
                    this.applyRibbonLayout();
                    this.buildToolbarCustomizer();
                    this.centerModal('modal-' + id);
                }
                if(id==='tool-customizer') {
                    this.buildToolCustomizer();
                    this.centerModal('modal-tool-customizer');
                }
                if (id === 'update') {
                    this.prepareUpdateModal();
                    this.initUpdateModalWindowing();
                    if (!this.restoreModalPosition('modal-update', 'paint.modal.update.pos')) {
                        this.centerModal('modal-' + id);
                    }
                    // Kick the check after layout so the modal feels responsive.
                    setTimeout(() => this.checkForUpdates(), 0);
                }
                if (id === 'new') this.resetNewModal();
                document.getElementById('modal-'+id).style.display='flex';
                if (id === 'resize') { this.positionResizeModal(); this.updateResizePreview(); }
                if (id === 'depth') { this.centerModal('modal-'+id); setTimeout(()=>{const b=document.getElementById('depth-apply-btn');if(b)b.focus();},0); }
                if (id === 'huesat') this.centerModal('modal-'+id);
                this.syncThemeColorsModelessMode();
            },
            restoreModalPosition(modalId, storageKey) {
                const modal = document.getElementById(modalId);
                const win = modal ? modal.querySelector('.window') : null;
                if (!modal || !win) return false;
                let pos = null;
                try { pos = JSON.parse(this.lsGet(storageKey) || 'null'); } catch (e) { pos = null; }
                if (!pos || !Number.isFinite(pos.left) || !Number.isFinite(pos.top)) return false;
                const rect = win.getBoundingClientRect();
                const w = rect.width || win.offsetWidth || 200;
                const h = rect.height || win.offsetHeight || 120;
                const left = Math.max(10, Math.min(Math.round(pos.left), Math.round(window.innerWidth - w - 10)));
                const top = Math.max(10, Math.min(Math.round(pos.top), Math.round(window.innerHeight - h - 10)));
                win.style.position = 'absolute';
                win.style.left = left + 'px';
                win.style.top = top + 'px';
                return true;
            },
            persistModalPosition(modalId, storageKey) {
                const modal = document.getElementById(modalId);
                const win = modal ? modal.querySelector('.window') : null;
                if (!modal || !win) return;
                const rect = win.getBoundingClientRect();
                try {
                    this.lsSet(storageKey, JSON.stringify({ left: rect.left, top: rect.top }));
                } catch (e) {
                    // Ignore storage failures.
                }
            },
            initUpdateModalWindowing() {
                if (this._updateModalWindowingInit) return;
                const modal = document.getElementById('modal-update');
                const win = modal ? modal.querySelector('.window') : null;
                const handle = modal ? modal.querySelector('.title-bar') : null;
                if (!modal || !win || !handle) return;
                this._updateModalWindowingInit = true;

                let dragging = false;
                let startX = 0, startY = 0, startLeft = 0, startTop = 0, winW = 0, winH = 0;

                const onMove = (e) => {
                    if (!dragging) return;
                    const dx = e.clientX - startX;
                    const dy = e.clientY - startY;
                    const left = Math.max(10, Math.min(Math.round(startLeft + dx), Math.round(window.innerWidth - winW - 10)));
                    const top = Math.max(10, Math.min(Math.round(startTop + dy), Math.round(window.innerHeight - winH - 10)));
                    win.style.position = 'absolute';
                    win.style.left = left + 'px';
                    win.style.top = top + 'px';
                };
                const onUp = () => {
                    if (!dragging) return;
                    dragging = false;
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    this.persistModalPosition('modal-update', 'paint.modal.update.pos');
                };

                handle.addEventListener('mousedown', (e) => {
                    if (e.button !== 0) return;
                    if (e.target && e.target.closest && e.target.closest('.close-btn')) return;
                    const rect = win.getBoundingClientRect();
                    winW = rect.width || win.offsetWidth || 200;
                    winH = rect.height || win.offsetHeight || 120;
                    startX = e.clientX;
                    startY = e.clientY;
                    startLeft = rect.left;
                    startTop = rect.top;
                    dragging = true;
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                    e.preventDefault();
                });

                handle.addEventListener('dblclick', (e) => {
                    if (e.target && e.target.closest && e.target.closest('.close-btn')) return;
                    this.centerModal('modal-update');
                    this.persistModalPosition('modal-update', 'paint.modal.update.pos');
                });
            },
            closeColorModal() {
                const colors = document.getElementById('modal-colors');
                if (colors) colors.style.display = 'none';
                const reset = document.getElementById('modal-confirm-reset');
                if (reset) reset.style.display = 'none';
                this.toggleThemeSelectMode(false);
                if (this.colorPickTarget) this.closeWinColor();
                this.syncThemeColorsModelessMode();
            },
            closeModals(options = {}) {
                // If a panel is docked in the sidebar, move it to body and hide it,
                // but keep the sidebar open so the user can re-open via its tab
                if (this._activeSidebarModalId) {
                    const dockedId = this._activeSidebarModalId;
                    const modal = document.getElementById('modal-' + dockedId);
                    const sidebar = document.getElementById('unified-sidebar');
                    if (modal && sidebar && modal.parentNode !== document.body) {
                        document.body.appendChild(modal);
                    }
                    if (modal) modal.style.display = 'none';
                    const btnId = dockedId === 'huesat' ? 'hs-sidebar-toggle-btn' : dockedId + '-sidebar-toggle-btn';
                    const btn = document.getElementById(btnId);
                    if (btn) { btn.title = 'Dock as sidebar'; btn.innerHTML = this.getSidebarDockIcon(); }
                    this._activeSidebarModalId = null;
                    this._updateSidebarTabVisibility();
                }
                const keepColorsOpen = options.keepColorsOpen !== false;
                const colorsModal = document.getElementById('modal-colors');
                const shouldKeepColors = !!(keepColorsOpen && colorsModal && colorsModal.style.display === 'flex');
                document.querySelectorAll('.modal-mask').forEach(m => {
                    if (shouldKeepColors && m.id === 'modal-colors') return;
                    m.style.display = 'none';
                    // If this was a floated sidebar modal, un-float its tab
                    const mid = m.id.replace('modal-', '');
                    if (this._floatedModals && this._floatedModals[mid]) {
                        delete this._floatedModals[mid];
                    }
                });
                this._updateSidebarTabVisibility();
                if (!shouldKeepColors) {
                    this.toggleThemeSelectMode(false);
                }
                const info = document.getElementById('modal-info');
                if (info) info.style.display = 'none';
                this.depthBackup = null;
                this.state.resizePreviewActive = false;
                this.state.resizePreviewRect = null;
                this.state.resizePreviewGhost = null;
                this.resetUtilitySidebars();
                this.requestGlobalOverlayUpdate();
                if (this.state.hueSatActive && !this.state.hueSatApplied) {
                    this.cancelHueSat();
                }
                this.syncThemeColorsModelessMode();
                if (this._inPopup) {
                    const tauri = window.__TAURI__;
                    if (tauri && tauri.window && tauri.window.getCurrentWindow) {
                        tauri.window.getCurrentWindow().close();
                    }
                }
            },
            // ══════════════════════════════════════════════════════════════════════
            // STRAY PIXEL CLEANER
            // Removes trapped aliasing artifacts (background slivers, disconnected
            // pixel islands) that appear between two larger solid shapes, without
            // destroying intentional thin lines or sharp corners.
            // ══════════════════════════════════════════════════════════════════════

            openGapStitchModal() {
                this.closeModals();
                const modal = document.getElementById('modal-gapstitch');
                if (!modal) return;
                modal.style.display = 'flex';
                this.centerModal('modal-gapstitch');
            },

            closeGapStitchModal() {
                const modal = document.getElementById('modal-gapstitch');
                if (modal) modal.style.display = 'none';
            },

            centerModal(modalId) {
                const modal = document.getElementById(modalId);
                const win = modal ? modal.querySelector('.window') : null;
                if (!modal || !win) return;
                const rect = win.getBoundingClientRect();
                const w = rect.width || win.offsetWidth;
                const h = rect.height || win.offsetHeight;
                win.style.position = 'absolute';
                win.style.left = Math.max(10, Math.round((window.innerWidth - w) / 2)) + 'px';
                win.style.top = Math.max(10, Math.round((window.innerHeight - h) / 2)) + 'px';
            },
            normalizeDialogPathSelection(selected) {
                if (!selected) return '';
                const raw = Array.isArray(selected) ? selected[0] : selected;
                if (typeof raw === 'string') {
                    return this.normalizeExportDirectoryPath(raw);
                }
                if (!raw || typeof raw !== 'object') {
                    return '';
                }
                const direct = ['path', 'filePath', 'file', 'url', 'href'];
                for (const key of direct) {
                    if (typeof raw[key] === 'string') {
                        return this.normalizeExportDirectoryPath(raw[key]);
                    }
                }
                if (typeof raw.toString === 'function') {
                    const text = raw.toString();
                    if (text && text !== '[object Object]') {
                        return this.normalizeExportDirectoryPath(text);
                    }
                }
                return '';
            },
            async openFileDialog() {
                const fileInput = document.getElementById('file-upload');
                if (this.getTauriInvokeFn()) {
                    try {
                        const picked = await this.tauriOpenDirectoryDialog({
                            title: 'Open Image',
                            directory: false,
                            multiple: false,
                            filters: [{ name: 'Images & Layers', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'ora'] }]
                        });
                        if (typeof picked === 'string' && picked) {
                            await this.openFileFromPath(picked);
                            return;
                        }
                        if (Array.isArray(picked) && picked.length && typeof picked[0] === 'string' && picked[0]) {
                            await this.openFileFromPath(picked[0]);
                            return;
                        }
                        if (picked === null) return;
                    } catch (e) {
                        console.warn('Native open-file dialog failed, falling back to browser file input', e);
                    }
                }
                if (fileInput) fileInput.click();
            },

            openORADialog() {
                const input = document.getElementById('ora-upload');
                if (input) { input.value = ''; input.click(); }
            },

            resetNewModal() {
                document.getElementById('new-preset').value = 'custom';
                document.getElementById('new-w').value = this.config ? this.config.width : 800;
                document.getElementById('new-h').value = this.config ? this.config.height : 600;
                document.getElementById('new-depth').value = '24';
                document.getElementById('new-bg').value = 'white';
                document.getElementById('new-bg-custom-group').style.display = 'none';
            },

            async writePalViaSaveDialog(name, bytes) {
                if (typeof window.showSaveFilePicker !== 'function') {
                    const blob = new Blob([bytes], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = name || 'palette.pal';
                    document.body.appendChild(a); a.click(); a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                    return;
                }
                const picked = await window.showSaveFilePicker({
                    suggestedName: name || 'palette.pal',
                    types: [{ description: 'GBA Palette', accept: { 'application/octet-stream': ['.pal'] } }]
                });
                const writable = await picked.createWritable();
                await writable.write(new Blob([bytes]));
                await writable.close();
            }
    });
})();
