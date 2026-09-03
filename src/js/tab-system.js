/* ──────────────────────────────────────────────────────────────────────────
 * Tab System — browser-style document tabs in the title bar.
 * Installs onto window.PaintApp (loaded after paint-engine.js).
 * Docs are captured as canvas snapshots + state, so each tab is isolated
 * (own history, undo/redo, zoom, pan, file identity, project fields).
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
    'use strict';
    if (typeof window === 'undefined' || !window.PaintApp) return;
    const app = window.PaintApp;

    /* ── Internal state ─────────────────────────────────────────────────── */
    const tabs = [];                 // tab records, in strip order
    let activeTabId = null;
    let nextTabId = 1;
    let pendingCapture = null;       // snapshot taken before an open/load
    let pendingCloseId = null;       // tab awaiting the dirty-close confirm
    let dragId = null, dragEl = null, dragPointer = null;
    let dragStartX = 0, dragging = false;
    const DRAG_THRESHOLD_PX = 4;   // movement before a click becomes a drag
    /* >0 while a doc-replacing operation is mid-flight. Guards refreshStrip()
     * from attributing the incoming document to the outgoing tab. */
    let docSwapDepth = 0;
    let addPointerId = null, addSuppressClickAt = 0;
    let strip = null, addBtn = null;

    /* ── Snapshot / restore ─────────────────────────────────────────────── */

    /* Document-scoped fields of app.state, owned by the engine so that adding a
     * field to state forces a decision about whether tabs carry it. */
    const DOC_KEYS = app.DOCUMENT_STATE_KEYS || [];

    /* The history entry a document is currently sitting on, or null. Accepts
     * either app.state or a record's stored doc — both carry history/step. */
    function historyEntryFor(docLike) {
        if (!docLike || !Array.isArray(docLike.history)) return null;
        const step = docLike.step;
        if (typeof step !== 'number' || step < 0 || step >= docLike.history.length) return null;
        return docLike.history[step] || null;
    }

    /* Copy the document-scoped slice of app.state out of the live engine. */
    function captureDocState() {
        const doc = {};
        for (const k of DOC_KEYS) doc[k] = app.state[k];
        // canvasOffset is a live object the engine mutates in place — the record
        // needs its own copy or panning tab A would move tab B's viewport too.
        const off = app.state.canvasOffset;
        doc.canvasOffset = off ? { x: off.x, y: off.y } : { x: 0, y: 0 };
        return doc;
    }

    /* Clone the live document into a fresh record (no tab created yet). */
    function snapshotLive() {
        // Land every in-progress gesture first. Without this the outgoing tab's
        // shape/curve/selection drafts stay on app.state and the *next* tab's
        // undo() takes the shape-cancel or curve-cancel branch instead of
        // stepping its own history.
        try {
            app.endInteractiveEdit({ commit: true });
        } catch (e) {
            console.warn('[Tabs] endInteractiveEdit failed', e);
        }
        const mgr = app.layerMgr;
        // The tab's pixels are already described by history[step] — endInteractiveEdit()
        // above guarantees the canvas matches it. Keeping a second full-canvas (or
        // full layer-stack) copy per tab doubled what a background tab costs, and
        // gave tab-restore a slightly different code path from undo. Only capture
        // a standalone entry when there is no usable history entry to restore from.
        let entry = null;
        if (!historyEntryFor(app.state)) {
            if (mgr && mgr.active && mgr.layers && mgr.layers.length > 1) {
                const snaps = mgr.layers.map(function (l) {
                    const snap = document.createElement('canvas');
                    snap.width = l.canvas.width;
                    snap.height = l.canvas.height;
                    app.disableSmoothing(snap.getContext('2d'));
                    snap.getContext('2d').drawImage(l.canvas, 0, 0);
                    return { id: l.id, name: l.name, visible: l.visible, opacity: l.opacity,
                             blendMode: l.blendMode, alpha: l.alpha, alphaLock: l.alphaLock,
                             locked: l.locked, parentId: l.parentId, isBase: l.isBase,
                             snap: snap, bitmap: null, ref: null };
                });
                entry = { _lsys: true, snaps: snaps, width: app.config.width, height: app.config.height };
            } else {
                const c = document.createElement('canvas');
                c.width = app.ui.cMain.width;
                c.height = app.ui.cMain.height;
                app.disableSmoothing(c.getContext('2d'));
                c.getContext('2d').drawImage(app.ui.cMain, 0, 0);
                entry = { canvas: c, width: c.width, height: c.height };
            }
        }
        return {
            id: nextTabId++,
            title: app.getCurrentFilename(),
            dirty: !!app.state.isDirty,
            entry: entry,
            /* Document-scoped slice of app.state (history, step, file identity,
             * palettes, canvasOffset, isDirty). */
            doc: captureDocState(),
            /* Document fields the engine keeps outside app.state. */
            zoom: app.config.zoom,
            bitDepth: app.bitDepth,
            palette: app.palette,
            paletteLab: app.paletteLab,
            paletteLocked: app.paletteLocked,
            layerActive: !!(mgr && mgr.active),
            layerActiveIdx: (mgr && mgr.activeIdx) || 0,
            width: app.config.width,
            height: app.config.height
        };
    }

    /* Move a snapshot's payload onto an existing record, preserving its id
     * (and therefore its position in the strip and its DOM element). */
    function assignRecord(dst, src) {
        for (const k of ['title', 'dirty', 'entry', 'doc', 'zoom', 'bitDepth',
                         'palette', 'paletteLab', 'paletteLocked',
                         'layerActive', 'layerActiveIdx', 'width', 'height']) {
            dst[k] = src[k];
        }
    }

    function isPristineUntitled(rec) {
        const d = rec.doc;
        return d.fileName === 'untitled.png' && !rec.dirty &&
            !d.filePath && !d.fileHandle && (d.history || []).length <= 1;
    }

    /* Rebuild the live document from a tab record. */
    function restoreTab(rec) {
        const mgr = app.layerMgr;
        // Clear any gesture state before the incoming document's pixels land.
        // snapshotLive() already does this on the way out, but restoreTab is
        // also reached from failure paths where nothing was snapshotted.
        try { app.resetTransientEditState(); } catch (e) { /* ignore */ }
        if (mgr && rec.layerActiveIdx != null) mgr.activeIdx = rec.layerActiveIdx;
        // Restore from the tab's own history cursor so that showing a tab and
        // undoing within it go through identical code. rec.entry is only
        // populated for documents that had no usable history entry.
        const src = historyEntryFor(rec.doc) || rec.entry;
        if (src) {
            try {
                app.restoreHistoryEntry(src, -1);
            } catch (e) {
                console.warn('[Tabs] restoreHistoryEntry failed', e);
            }
        }
        if (mgr) {
            // A flat entry collapses the stack to a single layer; honouring a
            // stale layerActive would leave the panel claiming a multi-layer
            // document that no longer exists.
            mgr.active = !!rec.layerActive && mgr.layers.length > 1;
            if (mgr.activeIdx > mgr.layers.length - 1) mgr.activeIdx = Math.max(0, mgr.layers.length - 1);
        }
        const d = rec.doc || {};
        for (const k of DOC_KEYS) app.state[k] = d[k];
        // Normalize the fields that must never be undefined.
        if (!Array.isArray(app.state.history)) app.state.history = [];
        if (app.state.step == null) app.state.step = -1;
        if (!app.state.fileName) app.state.fileName = 'untitled.png';
        if (!Array.isArray(app.state.palettes)) app.state.palettes = [];
        if (app.state.projectBitDepth == null) app.state.projectBitDepth = 4;
        app.state.canvasOffset = d.canvasOffset
            ? { x: d.canvasOffset.x, y: d.canvasOffset.y }
            : { x: 0, y: 0 };
        app.state.isDirty = !!rec.dirty;
        app.state.hasDocument = true;
        app.bitDepth = rec.bitDepth != null ? rec.bitDepth : 24;
        app.palette = rec.palette;
        app.paletteLab = rec.paletteLab;
        app.paletteLocked = rec.paletteLocked;
        try {
            // Must stay wrapped: history captures only the region the wrapper
            // says changed, so handing back a bare context here would silently
            // switch that off for the rest of the session.
            const fresh = app.trackCtx
                ? app.trackCtx(app.ui.cMain.getContext('2d', { willReadFrequently: true }))
                : app.ui.cMain.getContext('2d', { willReadFrequently: true });
            app.ctx = fresh;
            app.disableSmoothing(fresh);
            // A different document is on the canvas now.
            if (app.markAllDirty) app.markAllDirty();
        } catch (e) { /* ignore */ }
        app.config.zoom = rec.zoom != null ? rec.zoom : 1;
        applyZoomState();
        if (app.onPalettesChanged) { try { app.onPalettesChanged(); } catch (e) { /* ignore */ } }
        app.updateTitleBarActions();
        app.updateTitleFilename();
        if (app.requestGlobalOverlayUpdate) app.requestGlobalOverlayUpdate();
    }

    /* Apply the stored zoom/pan exactly (setZoom is delta-based). */
    function applyZoomState() {
        let z = app.config.zoom || 1;
        if (app.zoomLevels && app.zoomLevels.length) {
            let best = z, bestDiff = Infinity;
            for (let i = 0; i < app.zoomLevels.length; i++) {
                const diff = Math.abs(app.zoomLevels[i] / 100 - z);
                if (diff < bestDiff) { bestDiff = diff; best = app.zoomLevels[i] / 100; }
            }
            z = best;
        }
        app.config.zoom = z;
        if (app.ui.statusZoom) app.ui.statusZoom.textContent = Math.round(z * 100) + '%';
        document.documentElement.style.setProperty('--zoom', z);
        document.documentElement.style.setProperty('--zoom-inv', String(1 / z));
        app.applyStageTransform();
        if (app.updateViewportScrollability) app.updateViewportScrollability();
        if (app.clampViewportScroll) app.clampViewportScroll();
        if (app.updateBounds) app.updateBounds();
        if (app.updateGridOverlay) app.updateGridOverlay();
        if (app.requestGlobalOverlayUpdate) app.requestGlobalOverlayUpdate();
    }

    function freeRec(rec) {
        if (!rec) return;
        if (rec.entry) { try { app._closeBitmapEntry(rec.entry); } catch (e) { /* ignore */ } }
        const hist = rec.doc && rec.doc.history;
        // snapshotLive() copies the history *reference*, so a record can share
        // its array with the live document. Releasing those bitmaps would
        // detach entries the engine is still going to restore from.
        if (Array.isArray(hist) && hist !== app.state.history) {
            for (const en of hist) {
                try { app._closeBitmapEntry(en); } catch (e) { /* ignore */ }
            }
        }
    }

    /* ── Tab lifecycle ──────────────────────────────────────────────────── */

    function liveRec() {
        return tabs.find(t => t.id === activeTabId) || null;
    }

    /* The engine only ever trims the document it is currently showing, so
     * without this a background tab's undo stack grows to whatever it was when
     * you left it and is never reclaimed — five open tabs meant five full
     * histories resident at once. Apply the same ceiling to every tab that is
     * not on screen, sized to that tab's own canvas. */
    function enforceTabMemoryBudget() {
        if (typeof app.trimBackgroundHistory !== 'function') return;
        let trimmed = 0;
        for (const t of tabs) {
            if (t.id === activeTabId || !t.doc) continue;
            // Never trim through the live array — that is the on-screen document.
            if (t.doc.history === app.state.history) continue;
            try {
                trimmed += app.trimBackgroundHistory(t.doc, t.width, t.height) || 0;
            } catch (e) {
                console.warn('[Tabs] background history trim failed', e);
            }
        }
        if (trimmed) {
            console.info('[Tabs] released ' + trimmed + ' background history entries');
        }
    }

    function activateTab(id) {
        if (id === activeTabId) return;
        const rec = tabs.find(t => t.id === id);
        if (!rec) return;
        const from = liveRec();
        if (from) {
            const snap = snapshotLive();
            assignRecord(from, snap);
        }
        // Claim the incoming tab BEFORE restoring it. restoreTab() calls
        // updateTitleBarActions(), which is hooked to refreshStrip(), which
        // copies the live document's filename onto whichever record activeTabId
        // names. Leaving it stale renames the tab we are leaving.
        activeTabId = id;
        restoreTab(rec);
        enforceTabMemoryBudget();
        refreshStrip();
    }

    function closeTab(id) {
        if (pendingCloseId != null) return;
        const idx = tabs.findIndex(t => t.id === id);
        if (idx < 0) return;
        const rec = tabs[idx];
        if (rec.dirty) {
            if (id !== activeTabId) { activateTab(id); return; }
            showTabCloseConfirm();
            return;
        }
        doCloseTab(id);
    }

    function doCloseTab(id) {
        const idx = tabs.findIndex(t => t.id === id);
        if (idx < 0) return;
        const rec = tabs[idx];
        tabs.splice(idx, 1);
        freeRec(rec);
        if (tabs.length === 0) {
            // No record to sync to while the blank document is being built.
            activeTabId = null;
            app.state.hasDocument = false;
            app.state.isDirty = false;
            app.initializeBlankDocument();
            const blank = snapshotLive();
            tabs.push(blank);
            activeTabId = blank.id;
        } else if (id === activeTabId) {
            const next = tabs[Math.min(idx, tabs.length - 1)];
            // Claim before restoring — see activateTab().
            activeTabId = next.id;
            restoreTab(next);
        }
        refreshStrip();
    }

    /* Install the live doc as a tab (after open/new produced a fresh doc). */
    function adoptLiveAsTab() {
        // A document-replacing operation is expected to install a *fresh*
        // history array. If it reused the live one, this new tab and the tab we
        // just captured would share a single undo stack: undoing in one would
        // walk the other's steps, and closing one would release the other's
        // bitmaps. Re-baseline instead of adopting a shared stack.
        const shared = tabs.some(t => t.doc && t.doc.history === app.state.history);
        if (shared) {
            console.warn('[Tabs] document reused the previous history array — re-baselining');
            try { app.resetHistoryBaseline(); } catch (e) { console.warn('[Tabs] re-baseline failed', e); }
        }
        const rec = snapshotLive();
        tabs.push(rec);
        activeTabId = rec.id;
        enforceTabMemoryBudget();
        refreshStrip();
    }

    /* Wrap a doc-replacing operation (open/load) with capture + new tab. */
    async function tabbedLoadOpen(afterCapture, bodyFn) {
        let capture = pendingCapture || null;
        pendingCapture = null;
        // A capture taken here rather than at the start of the operation may
        // already reflect the incoming document (see the handleFile wrapper).
        // Its pixels and history are still the outgoing document's, but its
        // file identity cannot be trusted.
        const lateCapture = !capture;
        if (!capture) {
            const snap = snapshotLive();
            if (!(isPristineUntitled(snap) && tabs.length === 0)) capture = snap;
            else freeRec(snap);
        }
        if (capture && isPristineUntitled(capture) && tabs.length === 0) {
            freeRec(capture);
            capture = null;
        }
        if (capture) {
            const live = liveRec();
            if (live) {
                // Keep the outgoing tab's own identity when the capture was
                // taken too late to be trusted for it.
                const prior = lateCapture && live.doc ? {
                    title: live.title,
                    fileName: live.doc.fileName,
                    filePath: live.doc.filePath,
                    fileHandle: live.doc.fileHandle
                } : null;
                assignRecord(live, capture);
                if (prior) {
                    live.title = prior.title;
                    live.doc.fileName = prior.fileName;
                    live.doc.filePath = prior.filePath;
                    live.doc.fileHandle = prior.fileHandle;
                }
            } else { tabs.push(capture); activeTabId = capture.id; }
        } else if (afterCapture) {
            afterCapture();
        }
        app.state.isDirty = false;
        // From here until the loaded document is adopted as its own tab, the
        // engine holds a document the active record does not describe.
        docSwapDepth++;
        try {
            await bodyFn();
        } catch (e) {
            docSwapDepth--;
            const live = liveRec();
            if (live) { restoreTab(live); refreshStrip(); }
            throw e;
        }
        docSwapDepth--;
        adoptLiveAsTab();
    }

    /* ── Strip rendering ────────────────────────────────────────────────── */

    function createTabEl(t) {
        const el = document.createElement('div');
        el.className = 'doc-tab';
        el.setAttribute('data-tab-id', String(t.id));
        el.setAttribute('data-tauri-drag-region', 'false');
        el.title = t.title || '';
        // Label only \u2014 no close button, no dirty badge. Closing is middle-click
        // or Ctrl+W; a dirty tab still prompts before it closes.
        const title = document.createElement('span');
        title.className = 'doc-tab-title';
        el.appendChild(title);
        el.addEventListener('pointerdown', onTabPointerDown);
        el.addEventListener('click', onTabClick);
        el.addEventListener('auxclick', onTabAuxClick);
        return el;
    }

    function refreshStrip() {
        if (!strip) return;
        // While a document swap is in flight the engine holds a document that no
        // record describes yet, so there is nothing to sync to — copying the
        // live filename here would stamp the incoming document's name onto the
        // outgoing tab (two tabs called 000.png).
        if (!docSwapDepth) {
            const live = liveRec();
            if (live) {
                live.title = app.getCurrentFilename();
                live.dirty = !!(app.state && app.state.isDirty);
            }
        }
        for (const el of Array.from(strip.querySelectorAll('.doc-tab'))) {
            if (!tabs.some(t => t.id === parseInt(el.dataset.tabId, 10))) el.remove();
        }
        for (const t of tabs) {
            let el = strip.querySelector('.doc-tab[data-tab-id="' + t.id + '"]');
            if (!el) el = createTabEl(t);
            strip.insertBefore(el, addBtn);
            el.classList.toggle('active', t.id === activeTabId);
            // Kept as a styling hook even though nothing renders it now — the
            // unsaved state is deliberately not shown on the tab.
            el.classList.toggle('doc-tab-dirty', !!t.dirty);
            el.querySelector('.doc-tab-title').textContent = t.title || 'untitled.png';
            el.title = (t.title || 'untitled.png') + '  ·  middle-click to close';
        }
        const titleEl = document.getElementById('title-filename');
        if (titleEl) {
            // The live document is always represented as a tab now, so the
            // standalone filename label is only needed before any doc exists.
            titleEl.classList.toggle('hidden', tabs.length > 0);
            if (addBtn.parentNode !== strip) strip.appendChild(addBtn);
        }
    }

    /* ── Drag reorder ───────────────────────────────────────────────────── */

    function onTabPointerDown(e) {
        if (e.button !== 0) return;
        const el = e.currentTarget;
        dragId = parseInt(el.dataset.tabId, 10);
        dragEl = el;
        dragPointer = e.pointerId;
        dragStartX = e.clientX;
        dragging = false;
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }

    function onTabPointerMove(e) {
        if (!dragEl || e.pointerId !== dragPointer) return;
        // Don't treat a plain click as a drag: nothing dims and nothing
        // reorders until the pointer has actually travelled a few pixels.
        if (!dragging) {
            if (Math.abs(e.clientX - dragStartX) < DRAG_THRESHOLD_PX) return;
            dragging = true;
            dragEl.classList.add('dragging');
        }
        const x = e.clientX;
        const els = Array.from(strip.querySelectorAll('.doc-tab'));
        const cur = els.indexOf(dragEl);
        let ins = cur;
        for (let i = 0; i < els.length; i++) {
            if (els[i] === dragEl) continue;
            const r = els[i].getBoundingClientRect();
            if (x < r.left + r.width / 2) { ins = i; break; }
            ins = i + 1;
        }
        if (ins === cur) return;
        const srcIdx = tabs.findIndex(t => t.id === dragId);
        if (srcIdx < 0) return;
        const rec = tabs.splice(srcIdx, 1)[0];
        const destIdx = ins > srcIdx ? ins - 1 : ins;
        tabs.splice(destIdx, 0, rec);
        const anchor = addBtn.parentNode === strip ? addBtn : null;
        if (ins >= els.length) strip.insertBefore(dragEl, anchor);
        else strip.insertBefore(dragEl, els[ins]);
    }

    function onTabPointerUp(e) {
        if (!dragEl || e.pointerId !== dragPointer) return;
        try { dragEl.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        dragEl.classList.remove('dragging');
        dragId = null;
        dragEl = null;
        dragPointer = null;
        dragging = false;
    }

    function onTabClick(e) {
        activateTab(parseInt(e.currentTarget.dataset.tabId, 10));
    }

    function onTabAuxClick(e) {
        if (e.button !== 1) return;
        e.preventDefault();
        closeTab(parseInt(e.currentTarget.dataset.tabId, 10));
    }

    /* ── Dirty-close confirm modal ──────────────────────────────────────── */

    function showTabCloseConfirm() {
        const modal = document.getElementById('tab-close-confirm-modal');
        if (!modal) return;
        const rec = tabs.find(t => t.id === activeTabId);
        const label = document.getElementById('tab-close-filename');
        if (label) label.textContent = rec ? rec.title : 'your file';
        modal.style.display = 'flex';
        if (app.centerModal) app.centerModal('tab-close-confirm-modal');
        const saveBtn = document.getElementById('tab-close-save');
        if (saveBtn) requestAnimationFrame(() => saveBtn.focus());
    }

    function hideTabCloseConfirm() {
        const modal = document.getElementById('tab-close-confirm-modal');
        if (modal) modal.style.display = 'none';
        pendingCloseId = null;
    }

    async function confirmTabCloseSave() {
        pendingCloseId = null;
        hideTabCloseConfirm();
        await app.saveFile();
        const rec = liveRec();
        if (rec && rec.dirty) {
            if (window.showToast) showToast('Save cancelled — tab kept open.', 'warning');
            return;
        }
        doCloseTab(activeTabId);
    }

    function confirmTabCloseDiscard() {
        const id = activeTabId;
        pendingCloseId = null;
        hideTabCloseConfirm();
        doCloseTab(id);
    }

    function dismissTabCloseConfirm() {
        pendingCloseId = null;
        hideTabCloseConfirm();
    }

    /* ── "+" (new tab) button ───────────────────────────────────────────── */

    function addTabClick() {
        try {
            app.newFile();
        } catch (e) {
            console.error('[Tabs] newFile failed', e);
            if (window.showToast) showToast('Could not open the New dialog.', 'error');
        }
    }

    function onAddPointerDown(e) {
        if (e.button === 0) addPointerId = e.pointerId;
    }

    function onAddPointerUp(e) {
        if (addPointerId === null || e.pointerId !== addPointerId) return;
        addPointerId = null;
        if (e.button !== 0) return;
        if (!e.target.closest('#doc-tab-add')) return;
        e.preventDefault();
        e.stopPropagation();
        addSuppressClickAt = performance.now();
        addTabClick();
    }

    function onAddPointerCancel(e) {
        if (e.pointerId === addPointerId) addPointerId = null;
    }

    /* Capture-phase fallback so element moves / refreshStrip can never orphan the button. */
    function onTitleBarClick(e) {
        if (e.button !== 0) return;
        if (performance.now() < addSuppressClickAt + 500) return;
        if (!e.target.closest('#doc-tab-add')) return;
        e.preventDefault();
        e.stopPropagation();
        addTabClick();
    }

    /* ── Wiring ─────────────────────────────────────────────────────────── */

    function installStrip() {
        const titleBar = document.getElementById('title-bar');
        const titleLeft = titleBar && titleBar.querySelector('.title-left');
        const sep = titleLeft && titleLeft.querySelector('.title-sep');
        if (!titleBar || !titleLeft) return;
        strip = document.createElement('div');
        strip.id = 'tab-strip';
        strip.className = 'tab-strip';
        strip.setAttribute('data-tauri-drag-region', 'false');
        // Place the strip right where the filename label used to be (after the
        // title separator) so the first tab lines up with the old title position.
        titleLeft.insertBefore(strip, sep ? sep.nextSibling : null);
        addBtn = document.createElement('div');
        addBtn.id = 'doc-tab-add';
        addBtn.className = 'doc-tab-add';
        addBtn.textContent = '+';
        addBtn.title = 'New tab (Ctrl+T)';
        addBtn.setAttribute('aria-label', 'New tab');
        addBtn.setAttribute('data-tauri-drag-region', 'false');
        addBtn.addEventListener('pointerdown', onAddPointerDown);
        addBtn.addEventListener('pointerup', onAddPointerUp);
        addBtn.addEventListener('pointercancel', onAddPointerCancel);
        titleBar.addEventListener('click', onTitleBarClick, true);
        const filenameEl = document.getElementById('title-filename');
        if (filenameEl && filenameEl.parentNode) {
            filenameEl.parentNode.insertBefore(addBtn, filenameEl.nextSibling);
        }
        strip.addEventListener('pointermove', onTabPointerMove);
        strip.addEventListener('pointerup', onTabPointerUp);
        strip.addEventListener('pointercancel', onTabPointerUp);
    }

    function cycleTab(dir) {
        if (!tabs.length) return;
        const cur = tabs.findIndex(t => t.id === activeTabId);
        const next = tabs[(cur + dir + tabs.length) % tabs.length];
        activateTab(next.id);
    }

    function onWindowKeyDown(e) {
        if (e.defaultPrevented) return;
        const key = (e.key || '').toLowerCase();
        const tag = (e.target && e.target.tagName) || '';
        const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
            (e.target && e.target.isContentEditable);
        if (app.isHotkeysOpen && app.isHotkeysOpen()) return;
        if (key === 'escape' && document.getElementById('tab-close-confirm-modal') &&
            document.getElementById('tab-close-confirm-modal').style.display === 'flex') {
            e.preventDefault();
            e.stopImmediatePropagation();
            dismissTabCloseConfirm();
            return;
        }
        if (pendingCloseId != null) return;
        const mod = e.ctrlKey || e.metaKey;
        if (!mod || typing) return;
        if (key === 'w') {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (activeTabId != null) closeTab(activeTabId);
        } else if (key === 't') {
            e.preventDefault();
            e.stopImmediatePropagation();
            addTabClick();
        } else if (key === 'tab') {
            e.preventDefault();
            e.stopImmediatePropagation();
            cycleTab(e.shiftKey ? -1 : 1);
        }
    }

    function wireModal() {
        const save = document.getElementById('tab-close-save');
        const discard = document.getElementById('tab-close-discard');
        const cancel = document.getElementById('tab-close-cancel');
        const dismiss = document.getElementById('tab-close-dismiss');
        if (save) save.addEventListener('click', confirmTabCloseSave);
        if (discard) discard.addEventListener('click', confirmTabCloseDiscard);
        if (cancel) cancel.addEventListener('click', dismissTabCloseConfirm);
        if (dismiss) dismiss.addEventListener('click', dismissTabCloseConfirm);
    }

    function hookSync(name) {
        const orig = app[name].bind(app);
        app[name] = function () {
            const r = orig.apply(this, arguments);
            refreshStrip();
            return r;
        };
    }

    /* ── Reroutes: open / new create tabs ──────────────────────────────── */

    const _origOpenFileFromPath = app.openFileFromPath.bind(app);
    app.openFileFromPath = async function (path, _skipUnsavedCheck) {
        pendingCapture = snapshotLive();
        let r;
        try {
            r = await _origOpenFileFromPath(path, true);
        } finally {
            pendingCapture = null;
        }
        if (!r) {
            const live = liveRec();
            if (live) restoreTab(live);
            refreshStrip();
        }
        return r;
    };

    /* handleFile() stamps the incoming file's name onto app.state *before* the
     * image is decoded and handed to handleLoadedImage. By the time
     * tabbedLoadOpen() takes its own snapshot, the "outgoing document" already
     * carries the new file's identity — so the tab being left is relabelled
     * 000.png and, worse, inherits its filePath/fileHandle. Capture first. */
    const _origHandleFile = app.handleFile.bind(app);
    app.handleFile = function (f, isPaste) {
        // Paste keeps the current document, so there is nothing to hand off.
        if (!isPaste) pendingCapture = snapshotLive();
        return _origHandleFile(f, isPaste);
    };

    const _origHandleLoadedImage = app.handleLoadedImage.bind(app);
    app.handleLoadedImage = async function (img, isPaste) {
        if (isPaste) return _origHandleLoadedImage(img, isPaste);
        return tabbedLoadOpen(null, () => _origHandleLoadedImage(img, false));
    };

    const _origCreateNewCanvas = app.createNewCanvas.bind(app);
    app.createNewCanvas = async function () {
        try {
            const capture = pendingCapture || snapshotLive();
            pendingCapture = null;
            const live = liveRec();
            if (capture && (live || !isPristineUntitled(capture))) {
                if (live) assignRecord(live, capture);
                else { tabs.push(capture); activeTabId = capture.id; }
            }
            // The new document has no record until adoptLiveAsTab() below.
            docSwapDepth++;
            try {
                await _origCreateNewCanvas();
            } catch (e) {
                docSwapDepth--;
                const l = liveRec();
                if (l) restoreTab(l);
                refreshStrip();
                throw e;
            }
            docSwapDepth--;
            adoptLiveAsTab();
        } catch (e) {
            console.error('[Tabs] createNewCanvas failed', e);
            if (window.showToast) showToast('Could not create the new tab.', 'error');
            throw e;
        } finally {
            // Never leave the New dialog stuck open if the create path threw
            // before reaching the original closeModals().
            try { app.closeModals(); } catch (e) { /* ignore */ }
        }
    };

    const _origLoadORAFile = app.loadORAFile.bind(app);
    app.loadORAFile = async function (file) {
        return tabbedLoadOpen(null, () => _origLoadORAFile(file));
    };

    /* ── Stroke safety net ────────────────────────────────────────────────
     * If a tab/doc operation interrupts an in-progress stroke (or the New
     * dialog is dismissed mid-draw), the live document can be left with a
     * stuck drawing flag so the stroke never ends on pointer-up. Force-reset
     * every stroke-related flag whenever any modal is dismissed. */
    function resetStrokeState() {
        try {
            const s = app.state;
            if (!s) return;
            s.isDrawing = false;
            s.freehandActive = false;
            s.paintbrushActive = false;
            s.isPanning = false;
            s.isCanvasDragging = false;
            s.isMovingSel = false;
            s.isRotatingSel = false;
            s.isRotatingShape = false;
            if (app.brush && typeof app.brush.endStroke === 'function') app.brush.endStroke();
            if (typeof FreehandPathEngine !== 'undefined' &&
                FreehandPathEngine.isActive && FreehandPathEngine.isActive() &&
                FreehandPathEngine.onPointerUp) {
                FreehandPathEngine.onPointerUp();
            }
        } catch (e) { /* ignore */ }
    }

    const _origCloseModals = app.closeModals.bind(app);
    app.closeModals = function (opts) {
        resetStrokeState();
        return _origCloseModals(opts);
    };

    /* Seed a tab for the initial document so the strip is never empty and the
     * first tab appears aligned where the filename label used to be. */
    function ensureInitialTab() {
        if (tabs.length > 0) return;
        if (!app.state || !app.state.hasDocument) { requestAnimationFrame(ensureInitialTab); return; }
        if (app.state.isFileLoading) { requestAnimationFrame(ensureInitialTab); return; }
        try {
            const rec = snapshotLive();
            tabs.push(rec);
            activeTabId = rec.id;
        } catch (e) {
            console.warn('[Tabs] initial tab seed failed', e);
        }
        refreshStrip();
    }

    /* ── Install ────────────────────────────────────────────────────────── */

    app.tabSystem = {
        get tabs() { return tabs; },
        get activeTabId() { return activeTabId; },
        activate: activateTab,
        close: closeTab,
        refresh: refreshStrip
    };

    hookSync('updateTitleBarActions');
    hookSync('markSaved');
    hookSync('markClean');

    installStrip();
    wireModal();
    window.addEventListener('keydown', onWindowKeyDown, true);
    refreshStrip();
    requestAnimationFrame(ensureInitialTab);
})();