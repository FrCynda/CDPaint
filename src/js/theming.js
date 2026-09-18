/* theming — moved verbatim off the PaintEngine class body.
 *
 * Assigned onto the prototype, so `this` is the same PaintEngine instance
 * these methods have always run against. Loads after paint-engine.js and
 * before boot.js, which is where the instance is finally created.
 */
(function () {
    Object.assign(PaintEngine.prototype, {
            isThemeColorElementExcluded(el) {
                if (!el) return false;
                if (this.isPaletteMiniSwatchElement(el)) return true;
                return false;
            },
            normalizeSelectIconThemeBindings() {
                const normalizeBase = (value) => String(value || '').replace(/\s+/g, '').toLowerCase();
                const bindFillVar = (rect, varName, defaultBase = '') => {
                    if (!rect || !rect.dataset) return;
                    if (!rect.dataset.themeFillBase) {
                        const initial = rect.style ? rect.style.fill : '';
                        const fallback = rect.getAttribute ? (rect.getAttribute('fill') || '') : '';
                        rect.dataset.themeFillBase = initial || fallback || defaultBase;
                    }
                    if (rect.style) rect.style.setProperty('fill', `var(${varName})`);
                    if (rect.hasAttribute && rect.hasAttribute('fill')) rect.removeAttribute('fill');
                };
                const freeIcon = document.getElementById('select-icon-free');
                if (freeIcon) {
                    freeIcon.querySelectorAll('rect').forEach(rect => {
                        bindFillVar(rect, '--select-icon-free-color', '#1a6aab');
                    });
                }
                const polyIcon = document.getElementById('select-icon-poly');
                if (polyIcon) {
                    polyIcon.querySelectorAll('rect').forEach(rect => {
                        const base = normalizeBase(rect.dataset.themeFillBase || rect.style.fill || rect.getAttribute('fill') || '');
                        const isAccent = base === '#4e8aba' || base === 'rgb(78,138,186)';
                        bindFillVar(rect, isAccent ? '--select-icon-poly-accent-color' : '--select-icon-poly-main-color', isAccent ? '#4e8aba' : '#1a6aab');
                    });
                }
            },
            normalizeSaveIconThemeBindings() {
                const colorMap = {
                    '#9c75ca': '--titlebar-save-pixel-primary',
                    '#81679b': '--titlebar-save-pixel-shadow',
                    '#e6eaec': '--titlebar-save-pixel-sheet',
                    '#cccad5': '--titlebar-save-pixel-sheet-shadow',
                    '#ffffff': '--titlebar-save-pixel-white',
                    '#835ac7': '--titlebar-save-pixel-accent',
                    '#a191b3': '--titlebar-save-pixel-accent-soft',
                    '#98999c': '--titlebar-save-pixel-mid'
                };
                const normalizeBase = (value) => String(value || '').replace(/\s+/g, '').toLowerCase();
                const saveIcon = document.getElementById('selectall---copy');
                if (!saveIcon) return;
                saveIcon.querySelectorAll('rect').forEach(rect => {
                    if (!rect || !rect.dataset || !rect.style) return;
                    if (!rect.dataset.themeFillBase) {
                        rect.dataset.themeFillBase = rect.style.fill || rect.getAttribute('fill') || '';
                    }
                    const base = normalizeBase(rect.dataset.themeFillBase);
                    const varName = colorMap[base];
                    if (!varName) return;
                    rect.style.setProperty('fill', `var(${varName})`);
                    if (rect.hasAttribute('fill')) rect.removeAttribute('fill');
                });
            },
            getThemeColorElementRef(el) {
                if (!el) return 'node';
                const svgRoot = el.closest ? el.closest('svg') : null;
                const scopeRoot = svgRoot || document.body;
                const tag = (el.tagName || 'node').toLowerCase();
                if (el.id) {
                    if (svgRoot && svgRoot.id) return `svg#${svgRoot.id}>${tag}#${el.id}`;
                    return `${tag}#${el.id}`;
                }
                const path = [];
                let current = el;
                while (current && current !== scopeRoot) {
                    const parent = current.parentElement;
                    if (!parent) break;
                    const siblings = Array.from(parent.children).filter(child => child.tagName === current.tagName);
                    const idx = Math.max(0, siblings.indexOf(current));
                    path.unshift(`${(current.tagName || 'node').toLowerCase()}[${idx}]`);
                    current = parent;
                }
                const scoped = path.length ? path.join('/') : `${tag}[0]`;
                if (svgRoot && svgRoot.id) return `svg#${svgRoot.id}>${scoped}`;
                return scoped;
            },
            initThemeMode() {
                const CUSTOM_THEMES_INIT = [
                    'primeval-forest-mode',
                    'abyssal-ocean-mode',
                    'crimson-dusk-mode',
                    'gilded-obsidian-mode',
                    'violet-haze-mode',
                ];
                const stored = this.lsGet('paint.themeMode') || 'light';
                this.themeChrome = {
                    titleBar: document.getElementById('title-bar'),
                    tabRow: document.querySelector('.tab-row'),
                    tabs: Array.from(document.querySelectorAll('.tab-row .tab')),
                    tabArrows: Array.from(document.querySelectorAll('.dd-arrow'))
                };
                // Restore theme on load; default dark is no longer available — fall back to light
                if (stored === 'dark') {
                    this.themeMode = 'light';
                    this.setThemeMode('light', { save: true });
                } else if (CUSTOM_THEMES_INIT.includes(stored)) {
                    this.setThemeMode(stored, { save: false });
                } else {
                    this.themeMode = 'light';
                    this.setThemeMode('light', { save: false });
                }

                // Test mode — only restore if dark-refined is not also on (mutual exclusivity)
                const storedTest = this.lsGet('paint.testMode') === 'true';
                const storedDR   = this.lsGet('paint.darkRefinedMode') === 'true';
                this.testMode = storedTest && !storedDR;
                const testBtn = document.getElementById('test-mode-btn');
                if (testBtn) {
                    testBtn.addEventListener('click', () => this.setTestMode(!this.testMode));
                }
                this.applyTestMode(this.testMode);

                // Dark Refined mode
                this.darkRefinedMode = storedDR && !storedTest;
                const darkRefinedBtn = document.getElementById('dark-refined-btn');
                if (darkRefinedBtn) {
                    darkRefinedBtn.addEventListener('click', () => this.setDarkRefinedMode(!this.darkRefinedMode));
                }
                this.applyDarkRefinedMode(this.darkRefinedMode);
            },
            toggleThemeMode(mode) {
                const CUSTOM_THEMES = [
                    'primeval-forest-mode',
                    'abyssal-ocean-mode',
                    'crimson-dusk-mode',
                    'gilded-obsidian-mode',
                    'violet-haze-mode',
                ];
                const isCustom = CUSTOM_THEMES.includes(mode);
                // Check if already active
                const alreadyActive = isCustom
                    ? document.body.classList.contains(mode)
                    : (mode === 'light' && this.themeMode === 'light' && !CUSTOM_THEMES.some(c => document.body.classList.contains(c)));
                if (alreadyActive) {
                    // Untoggle: for custom themes fall back to last base; for light do nothing (already light)
                    if (isCustom) {
                        const fallback = this._lastBaseTheme || 'light';
                        this.setThemeMode(fallback, { save: true });
                    }
                    // For 'light' clicking again: no-op (already light)
                } else {
                    // Remember the last base (light/dark) before switching to a custom theme
                    if (isCustom && !CUSTOM_THEMES.some(c => document.body.classList.contains(c))) {
                        this._lastBaseTheme = this.themeMode === 'dark' ? 'dark' : 'light';
                    }
                    this.setThemeMode(mode, { save: true });
                }
            },
            setThemeMode(mode, opts = {}) {
                const CUSTOM_THEMES = [
                    'primeval-forest-mode',
                    'abyssal-ocean-mode',
                    'crimson-dusk-mode',
                    'gilded-obsidian-mode',
                    'violet-haze-mode',
                ];
                // Remove any previously applied custom theme classes
                CUSTOM_THEMES.forEach(cls => document.body.classList.remove(cls));

                // Mutual exclusivity: turn off overlay themes when a base theme is chosen
                if (this.testMode) { this.testMode = false; this.lsSet('paint.testMode', 'false'); this.applyTestMode(false); }
                if (this.darkRefinedMode) { this.darkRefinedMode = false; this.lsSet('paint.darkRefinedMode', 'false'); this.applyDarkRefinedMode(false); }

                const isCustom = CUSTOM_THEMES.includes(mode);
                const next = isCustom ? 'dark' : (mode === 'dark' ? 'dark' : 'light');
                this.themeMode = next;
                document.body.classList.toggle('dark-mode', next === 'dark');
                if (isCustom) document.body.classList.add(mode);
                const ribbon = document.getElementById('ribbon');
                const tabRow = document.querySelector('.tab-row');
                const titleBar = document.getElementById('title-bar');
                const ribbonView = document.getElementById('ribbon-view');
                const ribbonThemes = document.getElementById('ribbon-themes');
                const ribbonDebug = document.getElementById('ribbon-debug');
                const vis = {
                    ribbon: ribbon ? ribbon.style.display : null,
                    tabRow: tabRow ? tabRow.style.display : null,
                    titleBar: titleBar ? titleBar.style.display : null,
                    ribbonView: ribbonView ? ribbonView.style.display : null,
                    ribbonThemes: ribbonThemes ? ribbonThemes.style.display : null,
                    ribbonDebug: ribbonDebug ? ribbonDebug.style.display : null
                };
                if (!isCustom) {
                    if (next === 'dark') {
                        this.applyColorPreset('dark-ui');
                    } else {
                        this.resetColorOverrides({ recordHistory: false });
                    }
                }
                this.applyThemeChromeStyles(next);
                this.updateThemeModeStatus();
                if (ribbon) ribbon.style.display = vis.ribbon || '';
                if (tabRow) tabRow.style.display = vis.tabRow || '';
                if (titleBar) titleBar.style.display = vis.titleBar || '';
                if (ribbonView && vis.ribbonView !== null) ribbonView.style.display = vis.ribbonView;
                if (ribbonThemes && vis.ribbonThemes !== null) ribbonThemes.style.display = vis.ribbonThemes;
                if (ribbonDebug && vis.ribbonDebug !== null) ribbonDebug.style.display = vis.ribbonDebug;
                if (opts.save !== false) {
                    // Save the actual mode name so custom themes persist across reloads
                    this.lsSet('paint.themeMode', isCustom ? mode : next);
                }
            },
            updateThemeModeStatus() {
                const btn = document.getElementById('theme-mode-btn');
                const label = document.getElementById('theme-mode-status');
                if (btn) btn.classList.toggle('is-on', this.themeMode === 'dark');
                if (label) label.textContent = this.themeMode === 'dark' ? 'Dark' : 'Light';
                // Sync theme button active states
                const CUSTOM_THEMES = [
                    'primeval-forest-mode',
                    'abyssal-ocean-mode',
                    'crimson-dusk-mode',
                    'gilded-obsidian-mode',
                    'violet-haze-mode',
                ];
                const activeCustom = CUSTOM_THEMES.find(c => document.body.classList.contains(c)) || null;
                const lightBtn = document.getElementById('theme-btn-light');
                if (lightBtn) lightBtn.classList.toggle('is-on', !activeCustom && this.themeMode === 'light');
                CUSTOM_THEMES.forEach(c => {
                    const b = document.getElementById('theme-btn-' + c);
                    if (b) b.classList.toggle('is-on', c === activeCustom);
                });
            },
            applyThemeChromeStyles(mode) {
                const isDark = mode === 'dark';
                const chrome = this.themeChrome;
                if (!chrome) return;
                const CUSTOM_THEMES = [
                    'primeval-forest-mode',
                    'abyssal-ocean-mode',
                    'crimson-dusk-mode',
                    'gilded-obsidian-mode',
                    'violet-haze-mode',
                ];
                const isCustom = CUSTOM_THEMES.some(c => document.body.classList.contains(c));
                // Custom themes define their own titlebar/tab-row colors via CSS variables.
                // Clear any inline overrides so those CSS rules are respected.
                if (isCustom) {
                    if (chrome.titleBar) {
                        chrome.titleBar.style.backgroundColor = '';
                        chrome.titleBar.style.color = '';
                    }
                    if (chrome.tabRow) {
                        chrome.tabRow.style.backgroundColor = '';
                        chrome.tabRow.style.borderBottomColor = '';
                        chrome.tabRow.style.color = '';
                    }
                    if (chrome.tabArrows && chrome.tabArrows.length) {
                        chrome.tabArrows.forEach(arrow => { arrow.style.color = ''; });
                    }
                    return;
                }
                if (chrome.titleBar) {
                    chrome.titleBar.style.backgroundColor = isDark ? '#1b1b1d' : '';
                    chrome.titleBar.style.color = isDark ? '#f2f2f2' : '';
                }
                if (chrome.tabRow) {
                    chrome.tabRow.style.backgroundColor = isDark ? '#1f1f22' : '';
                    chrome.tabRow.style.borderBottomColor = isDark ? '#2a2a2d' : '';
                    chrome.tabRow.style.color = isDark ? '#f2f2f2' : '';
                }
                if (chrome.tabArrows && chrome.tabArrows.length) {
                    chrome.tabArrows.forEach(arrow => {
                        arrow.style.color = isDark ? '#f2f2f2' : '';
                    });
                }
            },
            initThemeSelectMode() {
                if (this.themeSelectBound) return;
                this.themeSelectBound = true;
                const btn = document.getElementById('theme-select-toggle-btn');
                if (btn && !btn.dataset.themeSelectBound) {
                    btn.dataset.themeSelectBound = '1';
                    btn.addEventListener('click', () => this.toggleThemeSelectMode());
                }
                document.addEventListener('mousemove', (e) => this.handleThemeSelectMouseMove(e), true);
                document.addEventListener('mousedown', (e) => this.handleThemeSelectMouseDown(e), true);
                document.addEventListener('click', (e) => this.handleThemeSelectClick(e), true);
                window.addEventListener('keydown', (e) => this.handleThemeSelectKeydown(e), true);
                this.updateThemeSelectUi();
            },
            syncThemeColorsModelessMode() {
                document.body.classList.toggle('theme-colors-open', this.isColorModalOpen());
            },
            updateThemeSelectUi(hintOverride = '') {
                const btn = document.getElementById('theme-select-toggle-btn');
                const hint = document.getElementById('theme-select-hint');
                if (btn) {
                    btn.classList.toggle('is-on', this.themeSelectActive);
                    btn.textContent = this.themeSelectActive ? 'Select to Edit: On' : 'Select to Edit: Off';
                }
                if (hint) {
                    if (hintOverride) {
                        hint.textContent = hintOverride;
                    } else if (this.themeSelectActive) {
                        hint.textContent = 'Click any UI element to edit it. Click near edges for border/outline colors. Esc exits.';
                    } else {
                        hint.textContent = 'Turn this on, then click a UI element to edit its color token.';
                    }
                }
            },
            toggleThemeSelectMode(force = null) {
                const next = force === null ? !this.themeSelectActive : !!force;
                if (next && !this.isColorModalOpen()) return;
                if (next === this.themeSelectActive) {
                    this.updateThemeSelectUi();
                    return;
                }
                this.themeSelectActive = next;
                document.body.classList.toggle('theme-select-mode', this.themeSelectActive);
                if (!this.themeSelectActive) {
                    this.clearThemeSelectHover();
                    if (this.themeSelectPickedRowTimer) {
                        clearTimeout(this.themeSelectPickedRowTimer);
                        this.themeSelectPickedRowTimer = null;
                    }
                }
                this.updateThemeSelectUi();
            },
            clearThemeSelectHover() {
                if (this.themeSelectHoverEl && this.themeSelectHoverEl.classList) {
                    this.themeSelectHoverEl.classList.remove('theme-select-candidate');
                }
                this.themeSelectHoverEl = null;
            },
            setThemeSelectHoverElement(el) {
                if (this.themeSelectHoverEl === el) return;
                if (this.themeSelectHoverEl && this.themeSelectHoverEl.classList) {
                    this.themeSelectHoverEl.classList.remove('theme-select-candidate');
                }
                this.themeSelectHoverEl = null;
                if (el && el.classList) {
                    el.classList.add('theme-select-candidate');
                    this.themeSelectHoverEl = el;
                }
            },
            getThemeSelectEventElement(event) {
                const target = event && event.target && event.target.nodeType === 1 ? event.target : null;
                if (!target) return null;
                if (target.closest('#palette-std, #palette-recent, #palette-custom, #palette, #cq-palette')) return null;
                if (target.closest('#modal-colors .window')) return null;
                if (target.closest('#modal-wincolor .window')) return null;
                if (target.closest('.modal-mask .window')) return null;
                return target;
            },
            findThemeColorKeyByColor(normalizedColor) {
                if (!normalizedColor || !this.colorCustomizerRows) return null;
                for (const key of this.colorCustomizerRows.keys()) {
                    if (key.startsWith('var(')) continue;
                    if (key === normalizedColor) return key;
                }
                for (const [key, row] of this.colorCustomizerRows.entries()) {
                    if (key.startsWith('var(')) continue;
                    if (row.currentNormalized === normalizedColor) return key;
                }
                return null;
            },
            findNearestThemeColorKey(normalizedColor, maxDistance = 44) {
                if (!normalizedColor || !this.colorCustomizerRows || !this.colorCustomizerRows.size) return null;
                const src = this.colorStringToRgba(normalizedColor);
                if (!src || src.a <= 0) return null;
                let bestKey = null;
                let bestDist = Infinity;
                for (const [key, row] of this.colorCustomizerRows.entries()) {
                    const to = this.colorStringToRgba(row.currentNormalized || key);
                    if (!to || to.a <= 0) continue;
                    const dr = src.r - to.r;
                    const dg = src.g - to.g;
                    const db = src.b - to.b;
                    const dist = Math.sqrt((dr * dr) + (dg * dg) + (db * db));
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestKey = key;
                    }
                }
                return bestDist <= maxDistance ? bestKey : null;
            },
            getThemeSelectPropOrderForElement(el, cs, point = null) {
                const base = [
                    'backgroundColor',
                    'color',
                    'borderTopColor',
                    'borderRightColor',
                    'borderBottomColor',
                    'borderLeftColor',
                    'outlineColor'
                ];
                if (!el || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return base;
                let rect = null;
                try { rect = el.getBoundingClientRect(); } catch (e) { rect = null; }
                if (!rect) return base;
                const dTop = Math.abs(point.y - rect.top);
                const dRight = Math.abs(rect.right - point.x);
                const dBottom = Math.abs(rect.bottom - point.y);
                const dLeft = Math.abs(point.x - rect.left);
                const minEdgeDist = Math.min(dTop, dRight, dBottom, dLeft);
                if (!Number.isFinite(minEdgeDist) || minEdgeDist > 8) return base;
                const borderRows = [
                    { prop: 'borderTopColor', dist: dTop, width: parseFloat(cs.borderTopWidth) || 0 },
                    { prop: 'borderRightColor', dist: dRight, width: parseFloat(cs.borderRightWidth) || 0 },
                    { prop: 'borderBottomColor', dist: dBottom, width: parseFloat(cs.borderBottomWidth) || 0 },
                    { prop: 'borderLeftColor', dist: dLeft, width: parseFloat(cs.borderLeftWidth) || 0 }
                ];
                const activeBorders = borderRows.filter(row => row.width > 0.5);
                const orderedBorders = (activeBorders.length ? activeBorders : borderRows)
                    .slice()
                    .sort((a, b) => a.dist - b.dist)
                    .map(row => row.prop);
                return [
                    ...orderedBorders,
                    'outlineColor',
                    'backgroundColor',
                    'color'
                ];
            },
            resolveThemeSelectMatchFromElement(startEl, point = null) {
                if (!startEl) return null;
                const attrs = ['fill', 'stroke', 'stop-color'];
                const seen = new Set();
                const tryColor = (raw, element, source) => {
                    const normalized = this.normalizeColor(raw);
                    if (!normalized || seen.has(normalized)) return null;
                    seen.add(normalized);
                    if (normalized === 'rgba(0, 0, 0, 0)') return null;
                    if (this.getAlphaFromNormalized(normalized) === 0) return null;
                    const key = this.findThemeColorKeyByColor(normalized);
                    if (key) return { key, element, inferred: false, source };
                    const nearest = this.findNearestThemeColorKey(normalized);
                    return nearest ? { key: nearest, element, inferred: true, source } : null;
                };
                let el = startEl;
                let depth = 0;
                while (el && depth < 8) {
                    if (el.nodeType !== 1) break;
                    let cs = null;
                    try { cs = getComputedStyle(el); } catch (e) {}
                    if (cs) {
                        const props = this.getThemeSelectPropOrderForElement(el, cs, point);
                        for (const prop of props) {
                            const match = tryColor(cs[prop], el, prop);
                            if (match) return match;
                        }
                    }
                    if (el.getAttribute) {
                        for (const attr of attrs) {
                            const raw = el.getAttribute(attr);
                            if (!raw) continue;
                            const match = tryColor(raw, el, attr);
                            if (match) return match;
                        }
                    }
                    el = el.parentElement;
                    depth += 1;
                }
                return null;
            },
            resolveThemeSelectMatchFromPoint(x, y, fallbackEl = null) {
                if (typeof document.elementsFromPoint === 'function') {
                    const stack = document.elementsFromPoint(x, y);
                    for (const el of stack) {
                        if (!el || el.nodeType !== 1) continue;
                        if (el.closest('#modal-colors .window')) continue;
                        if (el.closest('#modal-wincolor .window')) continue;
                        if (el.closest('.modal-mask .window')) continue;
                        const match = this.resolveThemeSelectMatchFromElement(el, { x, y });
                        if (match) return match;
                    }
                }
                return this.resolveThemeSelectMatchFromElement(fallbackEl, { x, y });
            },
            handleThemeSelectMouseMove(e) {
                if (!this.themeSelectActive) return;
                if (!this.isColorModalOpen()) {
                    this.toggleThemeSelectMode(false);
                    return;
                }
                if (this.isWinColorOpen()) {
                    this.clearThemeSelectHover();
                    return;
                }
                const target = this.getThemeSelectEventElement(e);
                if (!target) {
                    this.clearThemeSelectHover();
                    return;
                }
                this.setThemeSelectHoverElement(target);
            },
            handleThemeSelectMouseDown(e) {
                if (!this.themeSelectActive || e.button !== 0) return;
                if (!this.isColorModalOpen()) {
                    this.toggleThemeSelectMode(false);
                    return;
                }
                if (this.isWinColorOpen()) return;
                const target = this.getThemeSelectEventElement(e);
                if (!target) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                const match = this.resolveThemeSelectMatchFromPoint(e.clientX, e.clientY, target);
                if (!match) this.updateThemeSelectUi('No editable color token found here. Try another element.');
            },
            handleThemeSelectClick(e) {
                if (!this.themeSelectActive || e.button !== 0) return;
                if (!this.isColorModalOpen()) {
                    this.toggleThemeSelectMode(false);
                    return;
                }
                if (this.isWinColorOpen()) return;
                const target = this.getThemeSelectEventElement(e);
                if (!target) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                if (!this.colorCustomizerRows || !this.colorCustomizerRows.size) {
                    this.initColorCustomizer();
                    this.buildColorCustomizer();
                }
                const match = this.resolveThemeSelectMatchFromPoint(e.clientX, e.clientY, target);
                if (!match) {
                    this.updateThemeSelectUi('No editable color token found here. Try another element.');
                    this.clearThemeSelectHover();
                    return;
                }
                this.focusColorCustomizerRow(match.key);
                this.openColorPickerForKey(match.key);
                if (match.source && (match.source.indexOf('border') === 0 || match.source === 'outlineColor')) {
                    this.updateThemeSelectUi('Border/outline token selected.');
                } else if (match.inferred) {
                    this.updateThemeSelectUi('Selected nearest token match for this element color.');
                } else {
                    this.updateThemeSelectUi();
                }
            },
            handleThemeSelectKeydown(e) {
                if (!this.themeSelectActive) return;
                if (e.key !== 'Escape') return;
                if (this.isWinColorOpen()) return;
                this.toggleThemeSelectMode(false);
                e.preventDefault();
                e.stopImmediatePropagation();
            },
            initRibbonCustomization() {
                this.setupRibbonDrag('ribbon', 'ribbon-order-home');
                this.setupRibbonDrag('ribbon-view', 'ribbon-order-view');
                this.setupRibbonDrag('ribbon-themes', 'ribbon-order-themes');
                this.setupRibbonDrag('ribbon-debug', 'ribbon-order-debug');
                this.applyRibbonLayout();
                this.initRibbonContextMenu();
                this.initToolGrid();
            },
            setupRibbonDrag(ribbonId, storageKey) {
                const ribbon = document.getElementById(ribbonId);
                if (!ribbon) return;
                const sections = Array.from(ribbon.querySelectorAll(':scope > .section'));
                sections.forEach((sec, idx) => {
                    if (!sec.dataset.ribbonId) sec.dataset.ribbonId = `${ribbonId}-${idx}`;
                    if (!sec.dataset.ribbonDefault) sec.dataset.ribbonDefault = ribbonId;
                    sec.classList.add('ribbon-draggable');
                    const title = sec.querySelector(':scope > .section-title');
                    if (title) {
                        title.classList.add('ribbon-drag-handle');
                        title.setAttribute('draggable', 'true');
                    }
                    sec.setAttribute('draggable', 'true');
                });
                this.applyRibbonOrder(ribbon, storageKey);
                ribbon.addEventListener('dragstart', (e) => {
                    if (this.state.ribbonDrag && this.state.ribbonDrag.pointer) {
                        e.preventDefault();
                        return;
                    }
                    if (!e.target.closest('.section-title')) {
                        e.preventDefault();
                        return;
                    }
                    const sec = e.target.closest('.section');
                    if (!sec || !ribbon.contains(sec)) return;
                    sec.setAttribute('draggable', 'true');
                    this.state.ribbonDrag = { ribbon, storageKey, dragEl: sec };
                    sec.classList.add('ribbon-dragging');
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', sec.dataset.ribbonId || '');
                });
                ribbon.addEventListener('dragover', (e) => {
                    if (this.state.ribbonDrag && this.state.ribbonDrag.pointer) return;
                    if (!this.state.ribbonDrag || this.state.ribbonDrag.ribbon !== ribbon) return;
                    e.preventDefault();
                    const dragEl = this.state.ribbonDrag.dragEl;
                    const beforeRects = this.captureRibbonRects(ribbon);
                    const insertBefore = this.getRibbonInsertTarget(ribbon, e.clientX);
                    if (!insertBefore) {
                        ribbon.appendChild(dragEl);
                    } else if (insertBefore !== dragEl) {
                        ribbon.insertBefore(dragEl, insertBefore);
                    }
                    this.animateRibbonReorder(ribbon, beforeRects);
                });
                ribbon.addEventListener('dragend', () => {
                    if (this.state.ribbonDrag && this.state.ribbonDrag.pointer) return;
                    if (!this.state.ribbonDrag || this.state.ribbonDrag.ribbon !== ribbon) return;
                    this.state.ribbonDrag.dragEl.classList.remove('ribbon-dragging');
                    this.saveRibbonOrder(ribbon, storageKey);
                    this.state.ribbonDrag = null;
                });
                const isTauri = !!(window.__TAURI__ && window.__TAURI__.window);
                if (isTauri) {
                    let pointerId = null;
                    let startX = 0;
                    let moved = false;
                    ribbon.addEventListener('pointerdown', (e) => {
                        if (e.button !== 0) return;
                        if (!e.target.closest('.section-title')) return;
                        const sec = e.target.closest('.section');
                        if (!sec || !ribbon.contains(sec)) return;
                        pointerId = e.pointerId;
                        startX = e.clientX;
                        moved = false;
                        this.state.ribbonDrag = { ribbon, storageKey, dragEl: sec, pointer: true };
                        if (ribbon.setPointerCapture) ribbon.setPointerCapture(pointerId);
                        e.preventDefault();
                    });
                    ribbon.addEventListener('pointermove', (e) => {
                        if (!this.state.ribbonDrag || !this.state.ribbonDrag.pointer) return;
                        if (pointerId !== null && e.pointerId !== pointerId) return;
                        if (!moved) {
                            if (Math.abs(e.clientX - startX) < 4) return;
                            moved = true;
                            this.state.ribbonDrag.dragEl.classList.add('ribbon-dragging');
                        }
                        const dragEl = this.state.ribbonDrag.dragEl;
                        const beforeRects = this.captureRibbonRects(ribbon);
                        const insertBefore = this.getRibbonInsertTarget(ribbon, e.clientX);
                        if (!insertBefore) {
                            ribbon.appendChild(dragEl);
                        } else if (insertBefore !== dragEl) {
                            ribbon.insertBefore(dragEl, insertBefore);
                        }
                        this.animateRibbonReorder(ribbon, beforeRects);
                        e.preventDefault();
                    });
                    const finishPointerDrag = (e) => {
                        if (!this.state.ribbonDrag || !this.state.ribbonDrag.pointer) return;
                        if (pointerId !== null && e.pointerId !== undefined && e.pointerId !== pointerId) return;
                        this.state.ribbonDrag.dragEl.classList.remove('ribbon-dragging');
                        this.saveRibbonOrder(ribbon, storageKey);
                        this.state.ribbonDrag = null;
                        pointerId = null;
                        moved = false;
                    };
                    ribbon.addEventListener('pointerup', finishPointerDrag);
                    ribbon.addEventListener('pointercancel', finishPointerDrag);
                }
            },
            applyRibbonOrder(ribbon, storageKey) {
                const raw = this.lsGet(storageKey);
                if (!raw) return;
                let order = [];
                try { order = JSON.parse(raw); } catch (e) { order = []; }
                if (!Array.isArray(order) || !order.length) return;
                const map = new Map();
                Array.from(ribbon.querySelectorAll(':scope > .section')).forEach(sec => {
                    if (sec.dataset.ribbonId) map.set(sec.dataset.ribbonId, sec);
                });
                order.forEach(id => {
                    const sec = map.get(id);
                    if (sec) ribbon.appendChild(sec);
                });
            },
            saveRibbonOrder(ribbon, storageKey) {
                const ids = Array.from(ribbon.querySelectorAll(':scope > .section'))
                    .map(sec => sec.dataset.ribbonId)
                    .filter(Boolean);
                this.lsSet(storageKey, JSON.stringify(ids));
            },
            getRibbonContainers() {
                return {
                    home: document.getElementById('ribbon'),
                    view: document.getElementById('ribbon-view'),
                    themes: document.getElementById('ribbon-themes')
                };
            },
            getRibbonSections() {
                const containers = this.getRibbonContainers();
                const sections = [];
                const collect = (ribbonKey, ribbonEl) => {
                    if (!ribbonEl) return;
                    const list = Array.from(ribbonEl.querySelectorAll(':scope > .section'));
                    list.forEach((sec, idx) => {
                        if (!sec.dataset.ribbonId) sec.dataset.ribbonId = `${ribbonEl.id}-${idx}`;
                        if (!sec.dataset.ribbonLabel) {
                            const title = sec.querySelector(':scope > .section-title');
                            const label = title ? title.textContent.trim() : `Section ${sections.length + 1}`;
                            sec.dataset.ribbonLabel = label;
                        }
                        sections.push({
                            id: sec.dataset.ribbonId,
                            label: sec.dataset.ribbonLabel,
                            ribbonKey,
                            el: sec
                        });
                    });
                };
                collect('home', containers.home);
                collect('view', containers.view);
                collect('themes', containers.themes);
                return sections;
            },
            loadRibbonLayout() {
                const raw = this.lsGet('paint.ribbonLayout');
                if (!raw) return {};
                try {
                    const parsed = JSON.parse(raw);
                    return parsed && typeof parsed === 'object' ? parsed : {};
                } catch (e) {
                    return {};
                }
            },
            saveRibbonLayout(layout) {
                this.lsSet('paint.ribbonLayout', JSON.stringify(layout));
            },
            applyRibbonLayout() {
                const layout = this.loadRibbonLayout();
                const containers = this.getRibbonContainers();
                const sections = this.getRibbonSections();
                sections.forEach((item) => {
                    const entry = layout[item.id] || {};
                    const targetKey = entry.ribbon || item.ribbonKey;
                    const target = targetKey === 'view' ? containers.view : targetKey === 'themes' ? containers.themes : containers.home;
                    if (target && item.el.parentElement !== target) target.appendChild(item.el);
                    const hidden = !!entry.hidden;
                    item.el.style.display = hidden ? 'none' : '';
                });
                if (containers.home) this.applyRibbonOrder(containers.home, 'ribbon-order-home');
                if (containers.view) this.applyRibbonOrder(containers.view, 'ribbon-order-view');
                if (containers.themes) this.applyRibbonOrder(containers.themes, 'ribbon-order-themes');
            },
            setRibbonSectionLayout(sectionId, updates) {
                const layout = this.loadRibbonLayout();
                const entry = layout[sectionId] || {};
                if (updates.ribbon) entry.ribbon = updates.ribbon;
                if (updates.hidden !== undefined) entry.hidden = !!updates.hidden;
                layout[sectionId] = entry;
                this.saveRibbonLayout(layout);
                this.applyRibbonLayout();
                const containers = this.getRibbonContainers();
                if (containers.home) this.saveRibbonOrder(containers.home, 'ribbon-order-home');
                if (containers.view) this.saveRibbonOrder(containers.view, 'ribbon-order-view');
                if (containers.themes) this.saveRibbonOrder(containers.themes, 'ribbon-order-themes');
                this.updateBounds();
                this.requestGlobalOverlayUpdate();
                this.updateViewportScrollability();
            },
            resetToolbarLayout() {
                this.lsRemove('paint.ribbonLayout');
                const containers = this.getRibbonContainers();
                const sections = this.getRibbonSections();
                sections.forEach((item) => {
                    const def = item.el.dataset.ribbonDefault || item.el.dataset.ribbonDefault === ''
                        ? item.el.dataset.ribbonDefault
                        : null;
                    const target = def === 'ribbon-themes' ? containers.themes : def === 'ribbon-view' ? containers.view : containers.home;
                    if (target && item.el.parentElement !== target) target.appendChild(item.el);
                    item.el.style.display = '';
                });
                this.updateBounds();
                this.requestGlobalOverlayUpdate();
                this.updateViewportScrollability();
                this.buildToolbarCustomizer();
            },
            hideContextRibbonSection() {
                const section = this.state.ribbonContextSection;
                if (!section) return;
                const id = section.dataset.ribbonId;
                if (!id) return;
                this.setRibbonSectionLayout(id, { hidden: true });
                this.state.ribbonContextSection = null;
            },
            buildToolbarCustomizer() {
                const list = document.getElementById('toolbar-customizer-list');
                if (!list) return;
                list.innerHTML = '';
                const sections = this.getRibbonSections();
                if (!sections.length) {
                    const empty = document.createElement('div');
                    empty.className = 'toolbar-empty';
                    empty.textContent = 'No toolbar sections found.';
                    list.appendChild(empty);
                    return;
                }
                const header = document.createElement('div');
                header.className = 'toolbar-row toolbar-header';
                header.innerHTML = '<div>Section</div><div>Toolbar</div><div>Visible</div>';
                list.appendChild(header);
                const layout = this.loadRibbonLayout();
                sections.forEach((item) => {
                    const entry = layout[item.id] || {};
                    const row = document.createElement('div');
                    row.className = 'toolbar-row';
                    const label = document.createElement('div');
                    label.textContent = item.label || item.id;
                    const select = document.createElement('select');
                    const optHome = document.createElement('option');
                    optHome.value = 'home';
                    optHome.textContent = 'Home';
                    const optView = document.createElement('option');
                    optView.value = 'view';
                    optView.textContent = 'Misc';
                    select.appendChild(optHome);
                    select.appendChild(optView);
                    const target = entry.ribbon || item.ribbonKey;
                    select.value = target === 'view' ? 'view' : 'home';
                    select.addEventListener('change', () => {
                        this.setRibbonSectionLayout(item.id, { ribbon: select.value });
                    });
                    const visibleWrap = document.createElement('label');
                    visibleWrap.style.display = 'inline-flex';
                    visibleWrap.style.alignItems = 'center';
                    visibleWrap.style.gap = '6px';
                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.checked = !entry.hidden;
                    checkbox.addEventListener('change', () => {
                        this.setRibbonSectionLayout(item.id, { hidden: !checkbox.checked });
                    });
                    const visText = document.createElement('span');
                    visText.textContent = 'Show';
                    visibleWrap.appendChild(checkbox);
                    visibleWrap.appendChild(visText);
                    row.appendChild(label);
                    row.appendChild(select);
                    row.appendChild(visibleWrap);
                    list.appendChild(row);
                });
            },
            // ─── Tool Grid System (column-major, max 3 rows, unlimited cols) ─────────
            captureRibbonRects(ribbon) {
                const map = new Map();
                Array.from(ribbon.querySelectorAll(':scope > .section')).forEach(sec => {
                    map.set(sec, sec.getBoundingClientRect());
                });
                return map;
            },
            animateRibbonReorder(ribbon, beforeRects) {
                Array.from(ribbon.querySelectorAll(':scope > .section')).forEach(sec => {
                    const before = beforeRects.get(sec);
                    if (!before) return;
                    const after = sec.getBoundingClientRect();
                    const dx = before.left - after.left;
                    const dy = before.top - after.top;
                    if (dx || dy) {
                        sec.style.transition = 'none';
                        sec.style.transform = `translate(${dx}px, ${dy}px)`;
                        requestAnimationFrame(() => {
                            sec.style.transition = 'transform 160ms ease';
                            sec.style.transform = '';
                        });
                    }
                });
            },
            getRibbonInsertTarget(ribbon, x) {
                const sections = Array.from(ribbon.querySelectorAll(':scope > .section:not(.ribbon-dragging)'));
                let closest = null;
                let closestOffset = -Infinity;
                sections.forEach(sec => {
                    const rect = sec.getBoundingClientRect();
                    const offset = x - rect.left - rect.width / 2;
                    if (offset < 0 && offset > closestOffset) {
                        closestOffset = offset;
                        closest = sec;
                    }
                });
                return closest;
            },
            toggleToolbar() {
                const ribbon = document.getElementById('ribbon');
                if (!ribbon) return;
                const isHidden = ribbon.style.display === 'none';
                ribbon.style.display = isHidden ? '' : 'none';
                this.updateBounds();
                this.requestGlobalOverlayUpdate();
            },

            getToolbarHeight() {
                const title = document.getElementById('title-bar');
                const tabs = document.querySelector('.tab-row');
                const ribbon = document.getElementById('ribbon');
                const ribbonView = document.getElementById('ribbon-view');
                const ribbonThemes = document.getElementById('ribbon-themes');
                const ribbonDebug = document.getElementById('ribbon-debug');
                let h = 0;
                if (title && title.offsetParent) h += title.offsetHeight;
                if (tabs && tabs.offsetParent) h += tabs.offsetHeight;
                if (ribbon && ribbon.offsetParent) h += ribbon.offsetHeight;
                if (ribbonView && ribbonView.offsetParent) h += ribbonView.offsetHeight;
                if (ribbonThemes && ribbonThemes.offsetParent) h += ribbonThemes.offsetHeight;
                if (ribbonDebug && ribbonDebug.offsetParent) h += ribbonDebug.offsetHeight;
                return h;
            }
    });
})();
