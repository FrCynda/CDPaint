/* hotkeys — moved verbatim off the PaintEngine class body.
 *
 * Assigned onto the prototype, so `this` is the same PaintEngine instance
 * these methods have always run against. Loads after paint-engine.js and
 * before boot.js, which is where the instance is finally created.
 */
(function () {
    Object.assign(PaintEngine.prototype, {
            isHotkeysOpen() {
                const modal = document.getElementById('modal-hotkeys');
                return modal && modal.style.display === 'flex';
            },

            openHotkeys() {
                const modal = document.getElementById('modal-hotkeys');
                if (!modal) return;
                modal.style.display = 'flex';
                this.centerHotkeys();
                this.buildHotkeyUI();
                this.renderHotkeyUI();
            },

            closeHotkeys(skipActivateRibbon = false) {
                const modal = document.getElementById('modal-hotkeys');
                if (!modal) return;
                modal.style.display = 'none';
                this.clearHotkeyCapture();
                const hot = document.getElementById('tab-hotkeys');
                if (hot) hot.classList.remove('active');
                if (!skipActivateRibbon) this.setActiveTab('home');
            },

            centerHotkeys() {
                const modal = document.getElementById('modal-hotkeys');
                const win = modal ? modal.querySelector('.window') : null;
                if (!modal || !win) return;
                const rect = win.getBoundingClientRect();
                const w = rect.width || win.offsetWidth;
                const h = rect.height || win.offsetHeight;
                win.style.left = ((window.innerWidth - w) / 2) + 'px';
                win.style.top = '10px';
            },

            startHotkeysDrag(e) {
                if (e.button !== 0) return;
                const modal = document.getElementById('modal-hotkeys');
                const win = modal ? modal.querySelector('.window') : null;
                if (!win) return;
                const rect = win.getBoundingClientRect();
                this.hotkeysDrag = {
                    offsetX: e.clientX - rect.left,
                    offsetY: e.clientY - rect.top
                };
                e.preventDefault();
            },

            moveHotkeysDrag(e) {
                if (!this.hotkeysDrag) return;
                const modal = document.getElementById('modal-hotkeys');
                const win = modal ? modal.querySelector('.window') : null;
                if (!win) return;
                const x = e.clientX - this.hotkeysDrag.offsetX;
                const y = e.clientY - this.hotkeysDrag.offsetY;
                this.setClampedWindowPosition(win, x, y);
            },

            endHotkeysDrag() {
                this.hotkeysDrag = null;
            },

            initHotkeys() {
                if (this._hotkeysInit) return;
                this._hotkeysInit = true;
                this.buildHotkeyActions();
                this.loadHotkeys();
                this.buildHotkeyUI();
                this.updateHotkeyIndex();
                this.updateToolHoverTitles();
                const modal = document.getElementById('modal-hotkeys');
                if (modal) {
                    modal.addEventListener('click', (e) => {
                        if (e.target === modal) this.closeHotkeys();
                    });
                }
                const title = document.querySelector('#modal-hotkeys .title-bar');
                if (title) {
                    title.addEventListener('mousedown', (e) => this.startHotkeysDrag(e));
                }
                window.addEventListener('mousemove', (e) => this.moveHotkeysDrag(e));
                window.addEventListener('mouseup', () => this.endHotkeysDrag());
                window.addEventListener('mousedown', (e) => this.captureHotkeyMouse(e));
            },

            buildHotkeyActions() {
                const add = (id, label, handler) => {
                    this.hotkeyActions.push({ id, label, handler });
                    this.hotkeyActionMap[id] = { label, handler };
                };
                this.hotkeyActions = [];
                this.hotkeyActionMap = {};

                add('tool.pencil', 'Tool: Pencil', () => this.setTool('pencil'));
                add('tool.eraser', 'Tool: Eraser', () => this.setTool('eraser'));
                add('tool.fill', 'Tool: Fill', () => this.setTool('fill'));
                add('tool.gradient', 'Tool: Gradient', () => this.setTool('gradient'));
                add('tool.select', 'Tool: Select', () => this.setSelectTool());
                add('tool.wand', 'Tool: Magic Wand', () => this.setTool('wand'));
                add('tool.lasso', 'Tool: Lasso Select', () => this.setTool('lasso'));
                add('tool.picker', 'Tool: Color Picker', () => this.setTool('picker'));
                add('tool.zoom', 'Tool: Zoom', () => this.setTool('zoom'));
                add('tool.line', 'Tool: Line', () => this.setTool('line'));
                add('tool.curve', 'Tool: Curve', () => this.setTool('curve'));
                add('tool.poly', 'Tool: Polyline', () => this.setTool('poly'));
                add('tool.path', 'Tool: Freehand Path (WIP)', () => this.setTool('path'));
                add('tool.rect', 'Tool: Rectangle', () => this.setTool('rect'));
                add('tool.circle', 'Tool: Circle', () => this.setTool('circle'));
                add('tool.tri', 'Tool: Triangle', () => this.setTool('tri'));
                add('tool.freehand', 'Tool: Freehand Brush', () => this.setTool('freehand'));
                add('tool.paintbrush', 'Tool: Paint Brush', () => this.setTool('paintbrush'));

                add('edit.undo', 'Edit: Undo', () => this.undo());
                add('edit.redo', 'Edit: Redo', () => this.redo());
                add('edit.copy', 'Edit: Copy', () => this.execCopy());
                add('edit.cut', 'Edit: Cut', () => this.execCut());
                add('edit.paste', 'Edit: Paste', () => this.execPaste());
                add('edit.deleteSelection', 'Edit: Delete Selection', () => this.deleteSelection());
                add('edit.selectAll', 'Edit: Select All', () => this.selectAll());
                add('edit.invertSelection', 'Edit: Invert Selection', () => this.invertSelection());
                add('edit.cancel', 'Edit: Cancel/Unselect', () => {
                    if (this.config.tool === 'gradient' && this.config.gradient.active) { this.gradientDiscard(); return; }
                    if (this.state.polyActive) this.cancelPolyline();
                    if (this.state.lassoActive) {
                        this.state.lassoActive = false;
                        this.state.lassoPoints = [];
                        this.state.lassoIsDown = false;
                        this.state.lassoMode = null;
                        this.ctxTemp.clearRect(0,0,this.config.width, this.config.height);
                        if (this.ui && this.ui.cTemp) this.ui.cTemp.style.mixBlendMode = 'normal';
                    }
                    this.cancelSelection();
                });

                add('image.new', 'File: New', () => this.newFile());
                add('image.open', 'File: Open', () => this.openFileDialog());
                add('image.save', 'File: Save', () => this.saveFile({ cursorFeedback: true }));
                add('image.export', 'File: Export', () => this.openExportModal());
                add('image.props', 'Image: Properties', () => this.openModal('props'));
                add('image.resize', 'Image: Resize', () => this.initResize());
                add('image.crop', 'Image: Crop Selection', () => this.cropSelection());
                add('image.rotateRight', 'Image: Rotate Right 90', () => this.transform('rotate', 90));
                add('image.rotateLeft', 'Image: Rotate Left 90', () => this.transform('rotate', -90));
                add('image.rotate180', 'Image: Rotate 180', () => this.transform('rotate', 180));
                add('image.flipH', 'Image: Flip Horizontal', () => this.transform('flip', 'h'));
                add('image.flipV', 'Image: Flip Vertical', () => this.transform('flip', 'v'));

                add('color.swap', 'Colors: Swap', () => this.swapColors());
                add('color.toggleTransparent', 'Selection: Toggle Transparency', () => this.toggleTransparentSelection());
                add('color.edit', 'Colors: Edit', () => this.triggerColorPicker());

                add('brush.sizeUp', 'Brush: Size Up', () => this.changeSize(1));
                add('brush.sizeDown', 'Brush: Size Down', () => this.changeSize(-1));
                add('zoom.in', 'Zoom: In', () => this.setZoom(0.1));
                add('zoom.out', 'Zoom: Out', () => this.setZoom(-0.1));
                add('view.toggleAnchor', 'View: Toggle Anchor', () => this.toggleAnchorCanvas());
                add('view.centerCanvas', 'View: Center Canvas', () => this.centerCanvas());
                add('view.toggleGrid', 'View: Toggle Gridlines', () => this.setGridlinesEnabled(!this.gridlinesEnabled));
                add('view.toggleToolbar', 'View: Toggle Toolbar', () => this.toggleToolbar());
                add('help.info', 'Help: Info', () => this.openInfoModal());
                add('help.hotkeys', 'Help: Hotkeys', () => this.openHotkeys());
                add('adjust.huesat', 'Adjust: Hue/Sat', () => this.openModal('huesat'));
                add('image.depth', 'Image: Decrease Color Depth', () => this.openModal('depth'));

                this.hotkeyDefaults = {
                    'tool.pencil': { simple: 'P', complex: '' },
                    'tool.eraser': { simple: 'E', complex: '' },
                    'tool.fill': { simple: 'G', complex: '' },
                    'tool.gradient': { simple: 'R', complex: '' },
                    'tool.select': { simple: 'S', complex: '' },
                    'tool.wand': { simple: 'W', complex: '' },
                    'tool.lasso': { simple: 'A', complex: '' },
                    'tool.picker': { simple: 'I', complex: '' },
                    'tool.zoom': { simple: 'Z', complex: '' },
                    'tool.line': { simple: 'L', complex: '' },
                    'tool.curve': { simple: 'U', complex: '' },
                    'tool.poly': { simple: 'Y', complex: '' },
                    'tool.path': { simple: 'H', complex: '' },
                    'tool.rect': { simple: 'F', complex: '' },
                    'tool.circle': { simple: 'C', complex: '' },
                    'tool.tri': { simple: 'V', complex: '' },
                    'tool.freehand': { simple: '', complex: '' },
                    'tool.paintbrush': { simple: 'B', complex: '' },
                    'color.toggleTransparent': { simple: 'T', complex: '' },
                    'color.swap': { simple: 'X', complex: '' },
                    'edit.undo': { simple: '', complex: 'Ctrl+Z' },
                    'edit.redo': { simple: '', complex: 'Ctrl+Y' },
                    'image.save': { simple: '', complex: 'Ctrl+S' },
                    'image.open': { simple: '', complex: 'Ctrl+O' },
                    'image.new': { simple: '', complex: 'Ctrl+N' },
                    'edit.selectAll': { simple: '', complex: 'Ctrl+A' },
                    'edit.copy': { simple: '', complex: 'Ctrl+C' },
                    'edit.cut': { simple: '', complex: 'Ctrl+X' },
                    'edit.paste': { simple: '', complex: 'Ctrl+V' },
                    'image.props': { simple: '', complex: 'Ctrl+E' },
                    'image.resize': { simple: '', complex: 'Ctrl+R' },
                    'brush.sizeUp': { simple: '', complex: 'Ctrl+Plus' },
                    'brush.sizeDown': { simple: '', complex: 'Ctrl+Minus' },
                    'view.toggleToolbar': { simple: 'Tab', complex: '' },
                    'help.hotkeys': { simple: 'F1', complex: '' },
                    'edit.cancel': { simple: 'Escape', complex: '' },
                    'edit.deleteSelection': { simple: 'Delete', complex: '' }
                };
            },

            buildHotkeyUI() {
                const list = document.getElementById('hotkey-list');
                if (!list) return;
                if (list.dataset.built === 'true') return;
                list.dataset.built = 'true';
                list.innerHTML = '';
                this.hotkeyActions.forEach(action => {
                    const row = document.createElement('div');
                    row.className = 'hotkey-row';
                    const label = document.createElement('div');
                    label.className = 'hotkey-label';
                    label.textContent = action.label;

                    const simpleField = this.createHotkeyField(action.id, 'simple');
                    const complexField = this.createHotkeyField(action.id, 'complex');

                    row.appendChild(label);
                    row.appendChild(simpleField);
                    row.appendChild(complexField);
                    list.appendChild(row);
                });
            },

            createHotkeyField(actionId, type) {
                const field = document.createElement('div');
                field.className = 'hotkey-field';
                const input = document.createElement('input');
                input.className = 'hotkey-input';
                input.readOnly = true;
                input.dataset.action = actionId;
                input.dataset.type = type;
                input.value = '';
                const wrap = document.createElement('div');
                wrap.className = 'hotkey-input-wrap';
                wrap.appendChild(input);
                input.onclick = () => {
                    if (this.hotkeyCapture && this.hotkeyCapture.inputEl === input) {
                        if (this.hotkeyCapture.pendingCombo) {
                            this.setHotkey(this.hotkeyCapture.actionId, this.hotkeyCapture.type, this.hotkeyCapture.pendingCombo);
                        }
                        this.clearHotkeyCapture();
                    }
                };
                const setBtn = document.createElement('button');
                setBtn.className = 'hotkey-btn set';
                setBtn.textContent = 'Set';
                setBtn.onclick = () => {
                    if (this.hotkeyCapture && this.hotkeyCapture.actionId === actionId && this.hotkeyCapture.type === type) {
                        this.clearHotkeyCapture();
                    } else {
                        this.startHotkeyCapture(actionId, type, input, setBtn);
                    }
                };
                const clearBtn = document.createElement('button');
                clearBtn.className = 'hotkey-btn clear';
                clearBtn.textContent = 'Clear';
                clearBtn.onclick = () => this.setHotkey(actionId, type, '');
                field.appendChild(wrap);
                field.appendChild(setBtn);
                field.appendChild(clearBtn);
                return field;
            },

            renderHotkeyUI() {
                const list = document.getElementById('hotkey-list');
                if (!list) return;
                list.querySelectorAll('.hotkey-input').forEach(input => {
                    const actionId = input.dataset.action;
                    const type = input.dataset.type;
                    const entry = this.hotkeys[actionId] || { simple: '', complex: '' };
                    input.value = entry[type] || '';
                });
            },

            startHotkeyCapture(actionId, type, inputEl, buttonEl) {
                this.clearHotkeyCapture();
                this.hotkeyCapture = {
                    actionId,
                    type,
                    inputEl,
                    buttonEl,
                    wrapEl: inputEl ? inputEl.parentElement : null,
                    modifiers: null,
                    pendingCombo: null,
                    seq: [],
                    mods: new Set(),
                    timer: null,
                    deadline: null,
                    rafId: null
                };
                this.keyState.clear();
                this.keyOrder = [];
                this.pendingSimple = null;
                inputEl.classList.add('capture');
                if (this.hotkeyCapture.wrapEl) {
                    this.hotkeyCapture.wrapEl.classList.add('capture');
                    this.hotkeyCapture.wrapEl.style.setProperty('--capture-progress', 1);
                }
                inputEl.value = 'Listening...';
                if (buttonEl) buttonEl.textContent = 'Listening';
            },

            clearHotkeyCapture() {
                if (!this.hotkeyCapture) return;
                if (this.hotkeyCapture.timer) {
                    clearTimeout(this.hotkeyCapture.timer);
                }
                if (this.hotkeyCapture.rafId) {
                    cancelAnimationFrame(this.hotkeyCapture.rafId);
                }
                if (this.hotkeyCapture.inputEl) {
                    this.hotkeyCapture.inputEl.classList.remove('capture');
                }
                if (this.hotkeyCapture.wrapEl) {
                    this.hotkeyCapture.wrapEl.classList.remove('capture');
                    this.hotkeyCapture.wrapEl.style.removeProperty('--capture-progress');
                }
                if (this.hotkeyCapture.buttonEl) {
                    this.hotkeyCapture.buttonEl.textContent = 'Set';
                }
                this.hotkeyCapture = null;
                this.renderHotkeyUI();
            },

            captureHotkeyEvent(e) {
                if (!this.hotkeyCapture) return false;
                e.preventDefault();
                if (e.key === 'Escape') {
                    this.clearHotkeyCapture();
                    return true;
                }
                return this.handleCaptureKey(this.normalizeKey(e), e);
            },

            captureHotkeyMouse(e) {
                if (!this.hotkeyCapture) return false;
                const key = this.normalizeMouseButton(e);
                if (!key) return false;
                e.preventDefault();
                e.stopPropagation();
                return this.handleCaptureKey(key, e);
            },

            handleCaptureKey(key, e) {
                if (!this.hotkeyCapture) return false;
                const combo = this.updateHotkeyCaptureFromInput(key, e);
                if (!this.hotkeyCapture) return true;
                if (!combo) return true;
                if (this.hotkeyCapture.inputEl) {
                    this.hotkeyCapture.inputEl.value = combo;
                }
                const parts = combo.split('+');
                const hasMod = parts.some(p => ['Ctrl','Alt','Shift','Meta'].includes(p));
                const nonMods = parts.filter(p => !['Ctrl','Alt','Shift','Meta'].includes(p));
                if (this.hotkeyCapture.type === 'simple') {
                    if (hasMod || nonMods.length !== 1) return true;
                    this.setHotkey(this.hotkeyCapture.actionId, this.hotkeyCapture.type, combo);
                    this.clearHotkeyCapture();
                    return true;
                } else {
                    if (nonMods.length < 1 || (nonMods.length + (hasMod ? 1 : 0)) < 2) return true;
                    this.hotkeyCapture.pendingCombo = combo;
                }
                return true;
            },

            updateHotkeyCaptureFromInput(key, e) {
                const mods = ['Ctrl', 'Alt', 'Shift', 'Meta'];
                if (key && mods.includes(key)) {
                    this.hotkeyCapture.mods.add(key);
                }
                if (e) {
                    if (e.ctrlKey) this.hotkeyCapture.mods.add('Ctrl');
                    if (e.altKey) this.hotkeyCapture.mods.add('Alt');
                    if (e.shiftKey) this.hotkeyCapture.mods.add('Shift');
                    if (e.metaKey) this.hotkeyCapture.mods.add('Meta');
                }
                if (key && !mods.includes(key)) {
                    if (!this.hotkeyCapture.seq.includes(key) && this.hotkeyCapture.seq.length < 3) {
                        this.hotkeyCapture.seq.push(key);
                    }
                }
                const combo = this.buildChordFromSequence(this.hotkeyCapture.mods, this.hotkeyCapture.seq);
                if (!combo) return null;
                if (this.hotkeyCapture.type === 'complex') {
                    const maxed = combo.split('+').length >= 3;
                    if (maxed) {
                        this.setHotkey(this.hotkeyCapture.actionId, this.hotkeyCapture.type, combo);
                        this.clearHotkeyCapture();
                        return combo;
                    }
                    this.startHotkeyCountdown(1500);
                }
                return combo;
            },

            startHotkeyCountdown(ms) {
                if (!this.hotkeyCapture) return;
                if (this.hotkeyCapture.timer) clearTimeout(this.hotkeyCapture.timer);
                if (this.hotkeyCapture.rafId) cancelAnimationFrame(this.hotkeyCapture.rafId);
                const start = performance.now();
                const deadline = start + ms;
                this.hotkeyCapture.deadline = deadline;
                const tick = () => {
                    if (!this.hotkeyCapture || !this.hotkeyCapture.wrapEl) return;
                    const now = performance.now();
                    const remaining = Math.max(0, deadline - now);
                    const progress = remaining / ms;
                    this.hotkeyCapture.wrapEl.style.setProperty('--capture-progress', progress.toFixed(3));
                    if (remaining > 0) {
                        this.hotkeyCapture.rafId = requestAnimationFrame(tick);
                    }
                };
                this.hotkeyCapture.rafId = requestAnimationFrame(tick);
                this.hotkeyCapture.timer = setTimeout(() => {
                    if (this.hotkeyCapture && this.hotkeyCapture.pendingCombo) {
                        this.setHotkey(this.hotkeyCapture.actionId, this.hotkeyCapture.type, this.hotkeyCapture.pendingCombo);
                        this.clearHotkeyCapture();
                    }
                }, ms);
            },

            normalizeMouseButton(e) {
                if (!e) return null;
                if (e.button === 3) return 'Mouse4';
                if (e.button === 4) return 'Mouse5';
                return null;
            },

            buildChordFromSequence(modsSet, seq) {
                if (!seq || seq.length === 0) return '';
                const mods = ['Ctrl', 'Alt', 'Shift', 'Meta'];
                const parts = [];
                mods.forEach(m => { if (modsSet.has(m)) parts.push(m); });
                parts.push(...seq);
                if (parts.length > 3) return '';
                return parts.join('+');
            },

            normalizeKey(e) {
                let k = e.key;
                if (k === ' ') return 'Space';
                if (k === 'Esc') return 'Escape';
                if (k === 'Control') return 'Ctrl';
                if (k === 'Alt') return 'Alt';
                if (k === 'Shift') return 'Shift';
                if (k === 'Meta') return 'Meta';
                if (k === '+' || k === '=') return 'Plus';
                if (k === '-' || k === '_') return 'Minus';
                if (k.length === 1) return k.toUpperCase();
                return k;
            },

            updateKeyState(e, isDown) {
                const key = this.normalizeKey(e);
                if (!key) return;
                if (isDown) {
                    if (!this.keyState.has(key)) {
                        this.keyState.add(key);
                        this.keyOrder.push(key);
                    }
                } else {
                    this.keyState.delete(key);
                    this.keyOrder = this.keyOrder.filter(k => k !== key);
                }
            },

            checkSecretChord() {
                const needed = ['P','E','N','I','S'];
                for (const k of needed) {
                    if (!this.keyState.has(k)) return false;
                }
                if (this.secretArmed) return true;
                this.secretArmed = true;
                this.showSecretMessage();
                setTimeout(() => { this.secretArmed = false; }, 2200);
                return true;
            },

            showSecretMessage() {
                let el = document.getElementById('secret-splash');
                if (!el) {
                    el = document.createElement('div');
                    el.id = 'secret-splash';
                    el.style.position = 'fixed';
                    el.style.left = '50%';
                    el.style.top = '50%';
                    el.style.transform = 'translate(-50%, -50%)';
                    el.style.fontFamily = 'Segoe UI, sans-serif';
                    el.style.fontSize = '96px';
                    el.style.fontWeight = '800';
                    el.style.color = '#ff1e1e';
                    el.style.textShadow = '0 2px 6px rgba(0,0,0,0.4)';
                    el.style.zIndex = '25000';
                    el.style.pointerEvents = 'none';
                    el.style.display = 'none';
                    document.body.appendChild(el);
                }
                el.textContent = 'penis!!!';
                el.style.display = 'block';
                clearTimeout(this._secretTimer);
                this._secretTimer = setTimeout(() => { el.style.display = 'none'; }, 2000);
            },

            buildChordFromOrder(set, order) {
                if (!set || set.size === 0) return '';
                if (set.size > 3) return '';
                const mods = ['Ctrl', 'Alt', 'Shift', 'Meta'];
                const parts = [];
                mods.forEach(m => { if (set.has(m)) parts.push(m); });
                const others = (order || []).filter(k => set.has(k) && !mods.includes(k));
                if (others.length === 0) return '';
                parts.push(...others);
                return parts.join('+');
            },

            buildCombo(e) {
                const key = this.normalizeKey(e);
                if (['Shift', 'Control', 'Alt', 'Meta'].includes(key)) return null;
                const parts = [];
                if (e.ctrlKey) parts.push('Ctrl');
                if (e.altKey) parts.push('Alt');
                const shiftAllowed = !(key === 'Plus' && e.key === '+') && !(key === 'Minus' && e.key === '_');
                if (e.shiftKey && shiftAllowed) parts.push('Shift');
                if (e.metaKey) parts.push('Meta');
                parts.push(key);
                return parts.join('+');
            },

            handleHotkeyEvent(e) {
                const tag = e.target && e.target.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return false;
                const combo = this.buildChordFromOrder(this.keyState, this.keyOrder);
                if (!combo) return false;
                const parts = combo.split('+');
                const hasMod = parts.some(p => ['Ctrl','Alt','Shift','Meta'].includes(p));
                const nonMods = parts.filter(p => !['Ctrl','Alt','Shift','Meta'].includes(p));
                const isSimpleCombo = (!hasMod && nonMods.length === 1);
                if (isSimpleCombo) {
                    const hasComplexWithKey = this.keyInAnyComplex(nonMods[0]);
                    const list = this.getHotkeyActionList(combo, true);
                    if (list.length && hasComplexWithKey) {
                        this.pendingSimple = combo;
                        e.preventDefault();
                        return true;
                    }
                }
                const list = this.getHotkeyActionList(combo, isSimpleCombo);
                if (!list.length) return false;
                e.preventDefault();
                this.executeHotkeyList(combo, list);
                this.pendingSimple = null;
                return true;
            },

            handleHotkeyMouse(e) {
                if (this.hotkeyCapture) return false;
                const key = this.normalizeMouseButton(e);
                if (!key) return false;
                const mods = new Set();
                if (e.ctrlKey) mods.add('Ctrl');
                if (e.altKey) mods.add('Alt');
                if (e.shiftKey) mods.add('Shift');
                if (e.metaKey) mods.add('Meta');
                const combo = this.buildChordFromSequence(mods, [key]);
                if (!combo) return false;
                const parts = combo.split('+');
                const hasMod = parts.some(p => ['Ctrl','Alt','Shift','Meta'].includes(p));
                const nonMods = parts.filter(p => !['Ctrl','Alt','Shift','Meta'].includes(p));
                const isSimpleCombo = (!hasMod && nonMods.length === 1);
                const list = this.getHotkeyActionList(combo, isSimpleCombo);
                if (!list.length) return false;
                e.preventDefault();
                this.executeHotkeyList(combo, list);
                this.pendingSimple = null;
                return true;
            },

            handleHotkeyKeyup(e) {
                if (this.hotkeyCapture) return;
                if (!this.pendingSimple) return;
                const key = this.normalizeKey(e);
                if (key !== this.pendingSimple) return;
                if (this.keyState.size !== 0) return;
                const combo = key;
                const list = this.getHotkeyActionList(combo, true);
                if (list.length) this.executeHotkeyList(combo, list);
                this.pendingSimple = null;
            },

            getHotkeyActionList(combo, isSimple) {
                const idx = isSimple ? this.hotkeyIndexSimple : this.hotkeyIndexComplex;
                const list = idx[combo];
                if (!list) return [];
                return Array.isArray(list) ? list : [list];
            },

            executeHotkeyList(combo, list) {
                if (list.length === 1) {
                    const action = this.hotkeyActionMap[list[0]];
                    if (action && action.handler) action.handler();
                    return;
                }
                const allTools = list.every(id => id.startsWith('tool.'));
                if (!allTools) {
                    const action = this.hotkeyActionMap[list[0]];
                    if (action && action.handler) action.handler();
                    return;
                }
                const currentId = `tool.${this.config.tool}`;
                let nextIndex = 0;
                const currentIndex = list.indexOf(currentId);
                if (currentIndex !== -1) {
                    nextIndex = (currentIndex + 1) % list.length;
                } else if (typeof this.hotkeyToggleIndex[combo] === 'number') {
                    nextIndex = (this.hotkeyToggleIndex[combo] + 1) % list.length;
                }
                this.hotkeyToggleIndex[combo] = nextIndex;
                const action = this.hotkeyActionMap[list[nextIndex]];
                if (action && action.handler) action.handler();
            },

            keyInAnyComplex(key) {
                const entries = Object.values(this.hotkeys);
                for (const entry of entries) {
                    if (!entry.complex) continue;
                    const parts = entry.complex.split('+');
                    if (parts.includes(key)) return true;
                }
                return false;
            },

            updateHotkeyIndex() {
                this.hotkeyIndexSimple = {};
                this.hotkeyIndexComplex = {};
                Object.keys(this.hotkeys).forEach(actionId => {
                    const entry = this.hotkeys[actionId];
                    if (entry.simple) {
                        if (!this.hotkeyIndexSimple[entry.simple]) this.hotkeyIndexSimple[entry.simple] = [];
                        this.hotkeyIndexSimple[entry.simple].push(actionId);
                    }
                    if (entry.complex) {
                        if (!this.hotkeyIndexComplex[entry.complex]) this.hotkeyIndexComplex[entry.complex] = [];
                        this.hotkeyIndexComplex[entry.complex].push(actionId);
                    }
                });
            },

            loadHotkeys() {
                const raw = this.lsGet('paint-hotkeys-v1');
                let saved = {};
                try { if (raw) saved = JSON.parse(raw); } catch (e) { saved = {}; }
                this.hotkeys = {};
                this.hotkeyActions.forEach(action => {
                    const def = this.hotkeyDefaults[action.id] || { simple: '', complex: '' };
                    const s = saved[action.id] || {};
                    this.hotkeys[action.id] = {
                        simple: s.simple !== undefined ? s.simple : def.simple,
                        complex: s.complex !== undefined ? s.complex : def.complex
                    };
                });
                this.updateHotkeyIndex();
                this.updateToolHoverTitles();
            },

            saveHotkeys() {
                this.lsSet('paint-hotkeys-v1', JSON.stringify(this.hotkeys));
                this.updateHotkeyIndex();
                this.renderHotkeyUI();
                this.updateToolHoverTitles();
            },

            getHotkeyTooltip(actionId) {
                const entry = (this.hotkeys && this.hotkeys[actionId]) || (this.hotkeyDefaults && this.hotkeyDefaults[actionId]) || { simple: '', complex: '' };
                const parts = [];
                if (entry.simple) parts.push(entry.simple);
                if (entry.complex) parts.push(entry.complex);
                return parts.join(' / ');
            },

            setHotkey(actionId, type, combo) {
                if (!this.hotkeys[actionId]) this.hotkeys[actionId] = { simple: '', complex: '' };
                this.hotkeys[actionId][type] = combo;
                this.saveHotkeys();
            },

            resetHotkeys() {
                this.lsRemove('paint-hotkeys-v1');
                this.loadHotkeys();
                this.renderHotkeyUI();
            },

            clearHotkeys() {
                this.hotkeyActions.forEach(action => {
                    this.hotkeys[action.id] = { simple: '', complex: '' };
                });
                this.saveHotkeys();
            }
    });
})();
