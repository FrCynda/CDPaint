/* Headless verification of the tab-system document round-trip.
 *
 * Loads src/js/tab-system.js against a mock PaintApp so the real capture /
 * restore code runs, then asserts:
 *   1. document-scoped state survives a tab switch
 *   2. in-progress gesture state does NOT leak between tabs
 *   3. undo() after a switch steps the *incoming* tab's history
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const root = join(dirname(fileURLToPath(import.meta.url)));
const SRC = process.argv[2];

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

/* ── Minimal canvas / DOM stubs ─────────────────────────────────────── */
function makeCanvas(w = 0, h = 0) {
    const c = {
        width: w, height: h, style: {}, dataset: {}, classList: { add(){}, remove(){}, toggle(){} },
        getContext: () => ({
            drawImage(){}, clearRect(){}, fillRect(){}, putImageData(){},
            getImageData: () => ({ data: new Uint8ClampedArray(4) }),
            save(){}, restore(){}, createImageData: (w,h) => ({ data: new Uint8ClampedArray(w*h*4) })
        }),
        appendChild(){}, insertBefore(){}, removeChild(){}, remove(){},
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener(){}, setAttribute(){}, replaceChildren(){}
    };
    return c;
}
/* Minimal DOM good enough for the tab strip: class + [data-attr] selectors,
 * child insertion/removal, classList and dataset. Without a real strip element
 * refreshStrip() returns immediately and the interesting logic never runs. */
function makeEl(tag) {
    const classes = new Set();
    const node = {
        tagName: (tag || 'div').toUpperCase(),
        children: [], parentNode: null,
        style: {}, dataset: {}, _attrs: {},
        textContent: '', title: '',
        get className() { return [...classes].join(' '); },
        set className(v) {
            classes.clear();
            String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
        },
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            contains: (c) => classes.has(c),
            toggle: (c, on) => {
                const want = on === undefined ? !classes.has(c) : !!on;
                want ? classes.add(c) : classes.delete(c);
                return want;
            }
        },
        setAttribute(k, v) {
            node._attrs[k] = String(v);
            const m = /^data-(.+)$/.exec(k);
            if (m) node.dataset[m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
        },
        getAttribute: (k) => (k in node._attrs ? node._attrs[k] : null),
        addEventListener() {}, removeEventListener() {},
        setPointerCapture() {}, releasePointerCapture() {},
        appendChild(c) {
            if (c.parentNode) c.parentNode.removeChild(c);
            c.parentNode = node; node.children.push(c); return c;
        },
        insertBefore(c, ref) {
            if (c.parentNode) c.parentNode.removeChild(c);
            c.parentNode = node;
            const i = ref ? node.children.indexOf(ref) : -1;
            if (i < 0) node.children.push(c); else node.children.splice(i, 0, c);
            return c;
        },
        removeChild(c) {
            const i = node.children.indexOf(c);
            if (i >= 0) { node.children.splice(i, 1); c.parentNode = null; }
            return c;
        },
        remove() { if (node.parentNode) node.parentNode.removeChild(node); },
        _matches(sel) {
            const attr = /\[([^\]=]+)="([^"]*)"\]/.exec(sel);
            const cls = sel.replace(/\[[^\]]*\]/g, '').split('.').filter(Boolean);
            if (cls.some(c => !classes.has(c))) return false;
            if (attr && node._attrs[attr[1]] !== attr[2]) return false;
            return true;
        },
        _all(sel, out) {
            for (const c of node.children) {
                if (c._matches && c._matches(sel)) out.push(c);
                if (c._all) c._all(sel, out);
            }
            return out;
        },
        querySelector(sel) { return node._all(sel, [])[0] || null; },
        querySelectorAll(sel) { return node._all(sel, []); },
        closest() { return null; },
        getBoundingClientRect: () => ({ left: 0, width: 10, top: 0, height: 10 })
    };
    return node;
}

const titleBar = makeEl('div');
const titleLeft = makeEl('div');
titleLeft.className = 'title-left';
const titleSep = makeEl('span');
titleSep.className = 'title-sep';
const filenameEl = makeEl('span');
filenameEl.className = 'title-filename';
titleLeft.appendChild(titleSep);
titleLeft.appendChild(filenameEl);
titleBar.appendChild(titleLeft);

const byId = { 'title-bar': titleBar, 'title-filename': filenameEl };
const document = {
    createElement: (tag) => (tag === 'canvas' ? makeCanvas() : makeEl(tag)),
    getElementById: (id) => byId[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    documentElement: { style: { setProperty() {} } }
};

/* ── Mock engine ────────────────────────────────────────────────────── */
const DOCUMENT_STATE_KEYS = Object.freeze([
    'history', 'step',
    'fileName', 'filePath', 'fileHandle',
    'projectFile', 'projectHandle', 'projectImage', 'projectBitDepth',
    'palettes', 'activePaletteId', 'previewPaletteId', 'previewSnapshot',
    'isDirty', 'canvasOffset'
]);

function freshState() {
    return {
        history: [], step: -1,
        fileName: 'untitled.png', filePath: null, fileHandle: null,
        projectFile: null, projectHandle: null, projectImage: false, projectBitDepth: 4,
        palettes: [], activePaletteId: null, previewPaletteId: null, previewSnapshot: null,
        isDirty: false, hasDocument: true, canvasOffset: { x: 0, y: 0 },
        // transient gesture state
        isDrawing: false, activeShape: null, shapeEditMode: false,
        curvePhase: 0, curvePts: [], curveUndo: null,
        selection: null, selectionCutStep: null, selectionJustCreated: false,
        isMovingSel: false, isRotatingSel: false, isRotatingShape: false,
        polyActive: false, polyPoints: [], lassoActive: false, lassoPoints: [],
        freehandPathActive: false, freehandActive: false, paintbrushActive: false,
        isPanning: false, isCanvasDragging: false, wandBase: null, wandDiff: null,
        selStart: {x:0,y:0}, dragHandle: null, startPos: {x:0,y:0},
        selectionOriginalPos: null, selectionRotateSession: null,
        selectionIgnoreClickUntil: 0, selectionIgnoreNextClick: false,
        tempSelectionDrawRect: null, activeShapePathHandle: null,
        shapeDragStart: null, shapeDragBase: null, shapeRotateSession: null,
        shapeResizeAnchor: null, shapeResizeBase: null,
        freehandPathPoints: [], freehandPoints: [], smartPencilActive: false,
        pencilCtrlAxis: null, lassoMode: null, lassoIsDown: false, lassoStart: null,
        wandActive: false, wandStart: null, wandStartScreen: null, wandVisited: null,
        wandMaskCanvas: null, wandMaskImageData: null, isCanvasResizing: false, rDir: '',
        canvasOriginalSize: null, resizeAnchor: null, resizePreviewActive: false,
        resizePreviewRect: null, resizePreviewGhost: null,
        hueSatActive: false, hueSatApplied: false, hueSatDragging: false
    };
}

const app = {
    DOCUMENT_STATE_KEYS,
    state: freshState(),
    config: { width: 64, height: 64, zoom: 1, gradient: { active: false } },
    ui: { cMain: makeCanvas(64, 64), cTemp: makeCanvas(64, 64), selControls: { style: {} }, statusZoom: null },
    bitDepth: 24, palette: null, paletteLab: null, paletteLocked: false,
    layerMgr: null, zoomLevels: [100],

    /* --- the two engine methods under test are re-implemented faithfully
       below; the real ones live in paint-engine.js and are DOM-bound. --- */
    endInteractiveEditCalls: 0,
    saveCount: 0,
    /* Faithful to the real saveState: pushing DROPS the redo stack. */
    saveState() {
        if (this.state.step < this.state.history.length - 1) {
            this.state.history.splice(this.state.step + 1);
        }
        this.state.history.push({ id: 'save-' + (++this.saveCount) });
        this.state.step++;
    },
    endInteractiveEdit(opts) {
        this.endInteractiveEditCalls++;
        // mirrors the real one: always pokes the brush engine to guarantee no
        // stroke is in flight
        if (this.brush && this.brush.endStroke) this.brush.endStroke();
        this.resetTransientEditState();
    },
    resetTransientEditState() {
        const s = this.state, f = freshState();
        for (const k of Object.keys(f)) {
            if (DOCUMENT_STATE_KEYS.includes(k) || k === 'hasDocument') continue;
            s[k] = f[k];
        }
    },
    restoreHistoryEntry(entry) { this.lastRestored = entry; },
    // The real restoreTab() ends by calling this, and the tab system hooks it
    // to refreshStrip() — that re-entrancy is what renamed the outgoing tab.
    _titleBarHook: null,
    baselineCalls: 0,
    resetHistoryBaseline() {
        this.baselineCalls++;
        this.state.history = [{ id: 'baseline-' + this.baselineCalls }];
        this.state.step = 0;
    },
    _closeBitmapEntry() {},
    disableSmoothing() {},
    getCurrentFilename() { return this.state.fileName; },
    updateTitleBarActions() {}, updateTitleFilename() {},
    applyStageTransform() {}, updateBounds() {},
    initializeBlankDocument() { this.state = freshState(); },
    markSaved() {}, markClean() {}, closeModals() {}, centerModal() {},
    saveFile: async () => {}, newFile() {},
    openFileFromPath: async () => true,
    // Faithful to a real load: takes on a new document AND refreshes the strip
    // mid-flight (via saveState -> updateTitleBarActions), which is exactly when
    // the outgoing tab used to get renamed.
    async handleLoadedImage(img, isPaste) {
        this.state.history = [];
        this.state.step = -1;
        this.saveState();
        this.updateTitleBarActions();
    },
    // Faithful to the real handleFile: it stamps the incoming file's identity
    // onto app.state BEFORE the image is decoded and handed to
    // handleLoadedImage. That ordering is the whole bug.
    handleFile(f, isPaste) {
        if (!isPaste) {
            this.state.fileHandle = null;
            this.state.filePath = null;
            this.state.fileName = f.name;
        }
        return this.handleLoadedImage({ width: 8, height: 8 }, isPaste);
    },
    // Mirrors the fixed createNewCanvas: a new document installs a FRESH
    // history array (this is the bug that made new tabs inherit 6 undos).
    aliasHistoryOnNew: false,
    async createNewCanvas() {
        this.state.fileName = 'untitled.png';
        if (!this.aliasHistoryOnNew) {
            // DETACH only — never release. A tab record may already own this
            // exact array; closing its pixels strands that tab. (Releasing here
            // is what caused "restoreHistoryEntry failed / drawImage: value is
            // not of type ImageBitmap" when switching back to the old tab.)
            this.state.history = [];
            this.state.step = -1;
        }
        this.state.history.push({ id: 'new-doc' });
        this.state.step = this.state.history.length - 1;
    },
    loadORAFile: async () => {},

    /* real undo(), reduced to the branches that matter here */
    undo() {
        if (this.state.activeShape) { this.state.activeShape = null; return 'shape-branch'; }
        if (this.state.curvePhase > 0) { this.state.curvePhase = 0; return 'curve-branch'; }
        if (this.state.step > 0) { this.state.step--; return 'history-branch'; }
        return 'noop';
    }
};

/* Brush engine stub with the FIXED endStroke semantics: it only records an
 * undo step when a stroke was genuinely in progress. With the old unguarded
 * version every tab switch appended an entry and wiped the redo stack. */
app.brush = {
    drawing: false,
    endStroke() {
        const was = this.drawing;
        this.drawing = false;
        if (was) app.saveState();
    }
};

/* ── Load the real tab-system.js ────────────────────────────────────── */
const code = readFileSync(SRC, 'utf8');
const sandbox = {
    window: { PaintApp: app, addEventListener(){}, showToast(){} },
    document,
    requestAnimationFrame(){},
    performance: { now: () => 0 },
    console
};
sandbox.window.document = document;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const TS = app.tabSystem;
console.log('\n== tab-system loaded ==');
check('tabSystem installed', !!TS);

/* Seed tab 1 with a distinctive document state. */
app.state.fileName = 'alpha.png';
app.state.filePath = '/tmp/alpha.png';
app.state.history = [{ id: 'a0' }, { id: 'a1' }, { id: 'a2' }];
app.state.step = 2;
app.state.isDirty = true;
app.state.canvasOffset = { x: 11, y: 22 };
app.state.palettes = [{ id: 'pal-a' }];

// force the internal ensureInitialTab path by driving the public API
const seed = TS;
// tabs[] is empty; use the reroute-free path: adopt via activate on a new tab
// (ensureInitialTab is rAF-driven, so drive it through createNewCanvas instead)
await app.createNewCanvas();

console.log('\n== 1. document state survives a switch ==');
const tabsArr = TS.tabs;
// createNewCanvas captures the outgoing document as a tab and adopts the new
// one, so a first "New" on an existing doc yields two tabs.
check('two tabs after first New', tabsArr.length === 2, `got ${tabsArr.length}`);
const tab1 = tabsArr[0].id;
check('tab1 captured filename', tabsArr[0].doc.fileName === 'alpha.png', tabsArr[0].doc.fileName);
check('tab1 captured step', tabsArr[0].doc.step === 2, String(tabsArr[0].doc.step));
check('tab1 captured canvasOffset copy',
    tabsArr[0].doc.canvasOffset.x === 11 && tabsArr[0].doc.canvasOffset !== app.state.canvasOffset,
    'offset must be a copy, not the live object');

check('new tab did NOT inherit alpha history',
    app.state.history.length === 1, `new doc has ${app.state.history.length} entries (should be 1)`);
check('new tab has nothing to undo', app.state.step === 0, `step ${app.state.step}`);
check('alpha tab kept its own 3 entries', tabsArr[0].doc.history.length === 3,
    `${tabsArr[0].doc.history.length}`);

/* The adopted tab becomes "beta" once the user edits it. */
const tab2 = TS.tabs[TS.tabs.length - 1].id;
check('tab1 and tab2 are distinct records', tab1 !== tab2, `${tab1} vs ${tab2}`);
app.state.fileName = 'beta.png';
app.state.filePath = '/tmp/beta.png';
app.state.history = [{ id: 'b0' }, { id: 'b1' }];
app.state.step = 1;
app.state.canvasOffset = { x: 99, y: 99 };

console.log('\n== 2. gesture state does not leak across tabs ==');
// leave an uncommitted shape + curve draft + stale cut index on tab 2
app.state.activeShape = { kind: 'rect' };
app.state.curvePhase = 2;
app.state.curveUndo = { curvePhase: 2 };
app.state.selectionCutStep = 7;

TS.activate(tab1);
check('activeShape cleared on switch', app.state.activeShape === null, JSON.stringify(app.state.activeShape));
check('curvePhase cleared on switch', app.state.curvePhase === 0, String(app.state.curvePhase));
check('curveUndo cleared on switch', app.state.curveUndo === null, JSON.stringify(app.state.curveUndo));
check('selectionCutStep cleared on switch', app.state.selectionCutStep === null, String(app.state.selectionCutStep));
check('endInteractiveEdit ran', app.endInteractiveEditCalls > 0);

console.log('\n== 3. incoming tab gets its own history ==');
check('tab1 filename restored', app.state.fileName === 'alpha.png', app.state.fileName);
check('tab1 history restored', app.state.history.length === 3 && app.state.history[0].id === 'a0',
    JSON.stringify(app.state.history));
check('tab1 step restored', app.state.step === 2, String(app.state.step));
check('tab1 canvasOffset restored', app.state.canvasOffset.x === 11, JSON.stringify(app.state.canvasOffset));

const branch = app.undo();
check('undo takes the history branch (not shape/curve)', branch === 'history-branch', branch);
check('undo stepped tab1 history', app.state.step === 1, String(app.state.step));

console.log('\n== 4. switching back keeps tab2 intact ==');
TS.activate(tab2);
check('tab2 filename', app.state.fileName === 'beta.png', app.state.fileName);
check('tab2 history', app.state.history.length === 2 && app.state.history[0].id === 'b0',
    JSON.stringify(app.state.history));
check('tab2 offset', app.state.canvasOffset.x === 99, JSON.stringify(app.state.canvasOffset));
check('tab2 undo uses its own history', app.undo() === 'history-branch');

console.log('\n== 5. tab1 retained the undo it performed ==');
TS.activate(tab1);
check('tab1 step still 1 (undo persisted)', app.state.step === 1, String(app.state.step));

console.log('\n== 6. no two tabs share one history array ==');
const arrays = TS.tabs.map(t => t.doc.history);
let shared = null;
for (let i = 0; i < arrays.length && !shared; i++)
    for (let j = i + 1; j < arrays.length; j++)
        if (arrays[i] === arrays[j]) { shared = `${i} and ${j}`; break; }
check('every tab owns a distinct history array', shared === null, shared && `tabs ${shared} share one`);
check('safety net did NOT need to fire (createNewCanvas resets properly)',
    app.baselineCalls === 0, `fired ${app.baselineCalls}x`);

// Appending to one tab's history must not lengthen another's.
const before = TS.tabs.map(t => t.doc.history.length);
app.state.history.push({ id: 'new-edit' });
app.state.step = app.state.history.length - 1;
const liveId = TS.activeTabId;
const after = TS.tabs.map((t, i) => t.id === liveId ? before[i] : t.doc.history.length);
check('an edit in the live tab does not grow other tabs',
    before.every((n, i) => n === after[i]), `${before} -> ${after}`);

console.log('\n== 7. safety net catches a path that forgets to reset history ==');
app.aliasHistoryOnNew = true;   // simulate a doc-replacing path with the old bug
const beforeCount = TS.tabs.length;
await app.createNewCanvas();
check('safety net fired', app.baselineCalls > 0, 'adoptLiveAsTab must re-baseline');
check('new tab still ends up with its own array',
    TS.tabs[TS.tabs.length - 1].doc.history !== TS.tabs[beforeCount - 1].doc.history);
check('re-baselined tab has nothing to undo', app.state.step === 0, `step ${app.state.step}`);

console.log('\n== 8. switching tabs must not touch history or redos ==');
app.aliasHistoryOnNew = false;
TS.activate(tab1);
// Put tab1 mid-history: 3 entries, cursor at 0 => two redos available.
app.state.history = [{ id: 'h0' }, { id: 'h1' }, { id: 'h2' }];
app.state.step = 0;
const savesBefore = app.saveCount;
TS.activate(tab2);
TS.activate(tab1);
check('history length unchanged by switching',
    app.state.history.length === 3, `${app.state.history.length} entries`);
check('cursor unchanged by switching', app.state.step === 0, `step ${app.state.step}`);
check('redo stack survived the switch',
    app.state.step < app.state.history.length - 1, 'no redos left');
check('no phantom saveState during switch',
    app.saveCount === savesBefore, `${app.saveCount - savesBefore} phantom entries`);

console.log('\n== 9. a real stroke still records undo ==');
// State here: history [h0,h1,h2], cursor at 0. A new edit truncates the two
// redos and appends one entry -> [h0, <new>], cursor at 1.
app.brush.drawing = true;          // simulate a paintbrush stroke in flight
app.brush.endStroke();
check('finished stroke appended an entry and dropped the redos',
    app.state.history.length === 2, `${app.state.history.length} entries`);
check('stroke advanced the cursor', app.state.step === 1, `step ${app.state.step}`);

console.log('\n== 10. no redundant per-tab canvas copy ==');
const withHistory = TS.tabs.filter(t => {
    const d = t.doc;
    return Array.isArray(d.history) && d.step >= 0 && d.history[d.step];
});
check('tabs with a usable history entry store no extra copy',
    withHistory.length > 0 && withHistory.every(t => t.entry === null),
    withHistory.map(t => t.entry === null ? 'null' : 'COPY').join(','));

console.log('\n== 11. restore reads the tab\'s own history cursor ==');
TS.activate(tab2);
TS.activate(tab1);
const rec1 = TS.tabs.find(t => t.id === tab1);
check('restored the entry at history[step], not a side copy',
    app.lastRestored === rec1.doc.history[rec1.doc.step],
    `restored ${JSON.stringify(app.lastRestored)}`);

console.log('\n== 12. background tabs get their history trimmed ==');
app.historyLimitEnabled = true;
app.historyLimit = 3;
app.trimBackgroundHistory = function (docState, w, h) {
    const max = Math.max(1, this.historyLimit || 1);
    const overflow = docState.history.length - max;
    if (overflow <= 0) return 0;
    docState.history.splice(0, overflow);
    docState.step = Math.max(-1, docState.step - overflow);
    return overflow;
};
// give the *background* tab a long history, then switch away from it
TS.activate(tab2);
const bgRec = TS.tabs.find(t => t.id === tab1);
bgRec.doc.history = Array.from({ length: 10 }, (_, i) => ({ id: 'g' + i }));
bgRec.doc.step = 9;
TS.activate(tab1);   // tab2 becomes background and gets swept
TS.activate(tab2);   // tab1 becomes background and gets swept
check('background history trimmed to the limit',
    bgRec.doc.history.length === 3, `${bgRec.doc.history.length} entries`);
check('background cursor stayed in range',
    bgRec.doc.step >= 0 && bgRec.doc.step < bgRec.doc.history.length, `step ${bgRec.doc.step}`);
check('live tab was not trimmed', app.state.history.length > 0);

console.log('\n== 13. switching tabs must not rename the tab being left ==');
{
    app.historyLimitEnabled = false;   // stop the budget sweep interfering
    TS.activate(tab1);
    app.state.fileName = 'aaa.png';
    TS.refresh();
    TS.activate(tab2);
    app.state.fileName = '000.png';
    TS.refresh();

    const t1 = TS.tabs.find(t => t.id === tab1);
    const t2 = TS.tabs.find(t => t.id === tab2);
    check('the tab we left kept its own name', t1.title === 'aaa.png', `got "${t1.title}"`);
    check('the active tab has the current name', t2.title === '000.png', `got "${t2.title}"`);

    // Now switch back and forth: names must stay put.
    TS.activate(tab1);
    TS.activate(tab2);
    TS.activate(tab1);
    check('names survive repeated switching',
        TS.tabs.find(t => t.id === tab1).title === 'aaa.png' &&
        TS.tabs.find(t => t.id === tab2).title === '000.png',
        `${TS.tabs.map(t => t.title).join(', ')}`);
    check('no two tabs share a name',
        new Set(TS.tabs.map(t => t.title)).size === TS.tabs.length,
        TS.tabs.map(t => t.title).join(', '));
}

console.log('\n== 14. opening a document does not rename the outgoing tab ==');
{
    TS.activate(tab1);
    app.state.fileName = 'keepme.png';
    TS.refresh();
    const before = TS.tabs.find(t => t.id === tab1).title;

    // Mimic a load: the engine takes on the new document mid-flight, and the
    // strip is refreshed while it does (saveState -> updateTitleBarActions).
    await app.handleLoadedImage({ width: 8, height: 8 }, false);

    const after = TS.tabs.find(t => t.id === tab1).title;
    check('outgoing tab kept its filename through a load',
        after === before, `"${before}" became "${after}"`);
}

console.log('\n== 15. fresh start, open a file (the reported sequence) ==');
{
    // Put the ACTIVE tab into the state a fresh start leaves it in. (Closing
    // tabs to rebuild the world doesn't work here: close() on a dirty tab opens
    // a confirm dialog instead of closing.)
    app.state.fileName = 'untitled.png';
    app.state.filePath = null;
    app.state.fileHandle = null;
    app.state.history = [{ id: 'blank' }];
    app.state.step = 0;
    app.state.isDirty = false;
    TS.refresh();

    const firstId = TS.activeTabId;
    const firstTab = TS.tabs.find(t => t.id === firstId);
    check('starting from an untitled active tab',
        !!firstTab && firstTab.title === 'untitled.png',
        firstTab ? firstTab.title : 'no tab');
    const tabsBefore = TS.tabs.length;
    // Earlier steps left their own tabs behind, so count the delta.
    const named000Before = TS.tabs.filter(t => t.title === '000.png').length;

    // Open 000.png through the real handleFile path.
    await app.handleFile({ name: '000.png' }, false);

    const after = TS.tabs.map(t => t.title);
    check('the original tab is still untitled.png',
        TS.tabs.find(t => t.id === firstId).title === 'untitled.png',
        `titles: ${after.join(', ')}`);
    check('a new tab was created for the opened file',
        TS.tabs.length === tabsBefore + 1, `${tabsBefore} -> ${TS.tabs.length}`);
    check('the open added exactly ONE tab named 000.png (not two)',
        after.filter(n => n === '000.png').length === named000Before + 1,
        `${named000Before} -> ${after.filter(n => n === '000.png').length}; titles: ${after.join(', ')}`);

    const orig = TS.tabs.find(t => t.id === firstId);
    check('original tab did NOT inherit the opened file path',
        !orig.doc.filePath, `filePath ${orig.doc.filePath}`);
    check('original tab kept its own fileName',
        orig.doc.fileName === 'untitled.png', `fileName ${orig.doc.fileName}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
