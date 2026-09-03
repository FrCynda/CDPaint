/* Proves that folders survive a .ora round trip.
 *
 * The bug: the writer filtered groups out and emitted one flat <stack>, and the
 * reader only looked at ':scope > layer'. Every group you made was silently
 * gone the next time you opened the file — with the layers still there, so it
 * looked like a cosmetic glitch rather than lost structure.
 *
 * Both halves are the REAL functions, lifted out of the source: the save path
 * produces stack.xml, and the load path's _walkStack parses it back.
 */
import { readFileSync } from 'fs';
import vm from 'vm';

const SRC = process.argv[2] || 'src/js/paint-engine.js';
const lines = readFileSync(SRC, 'utf8').split(/\r?\n/);

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

function extractAssign(pattern) {
    const start = lines.findIndex(l => l.includes(pattern));
    if (start < 0) throw new Error(`not found: ${pattern}`);
    let depth = 0, started = false, out = [];
    for (let i = start; i < lines.length; i++) {
        out.push(lines[i]);
        for (const ch of lines[i]) {
            if (ch === '{') { depth++; started = true; }
            else if (ch === '}') depth--;
        }
        if (started && depth === 0) return out.join('\n');
    }
    throw new Error('unbalanced braces for ' + pattern);
}

let uid = 0;
function fakeCanvas(tag, w = 8, h = 8) {
    const c = { __tag: tag || ('c' + (++uid)), width: w, height: h };
    c.getContext = () => ({
        drawImage() {}, clearRect() {}, save() {}, restore() {}, setTransform() {},
        globalAlpha: 1, globalCompositeOperation: 'source-over'
    });
    return c;
}

/* ── the document under test ────────────────────────────────────────────────
 *   BG                     (base)
 *   Folder A               (pass-through)
 *     Inner                (multiply, masked)
 *     Folder B             (isolated, 50%)
 *       Deep               (clipped)
 *   Top                    (hidden)
 */
const L = {};
let nextId = 1;
function layer(name, extra) {
    const l = Object.assign({
        id: nextId++, name, canvas: fakeCanvas(name), visible: true, opacity: 1,
        blendMode: 'source-over', locked: false, alphaLock: false, isBase: false,
        clipped: false, mask: null, parentId: null, alpha: true
    }, extra || {});
    L[name] = l;
    return l;
}

const bg      = layer('BG', { isBase: true, alpha: false });
const folderA = layer('Folder A', { isGroup: true, canvas: fakeCanvas('A'), ctx: null,
                                    blendMode: 'pass-through' });
const inner   = layer('Inner', { parentId: folderA.id, blendMode: 'multiply',
                                 mask: { canvas: fakeCanvas('MASK'), enabled: true } });
const folderB = layer('Folder B', { isGroup: true, canvas: fakeCanvas('B'), ctx: null,
                                    parentId: folderA.id, opacity: 0.5 });
const deep    = layer('Deep', { parentId: folderB.id, clipped: true });
const top     = layer('Top', { visible: false });

// mgr.layers is bottom-first, each folder followed by its contents.
const stackOrder = [bg, folderA, inner, folderB, deep, top];
const mgr = { active: true, activeIdx: stackOrder.indexOf(deep), layers: stackOrder };

/* ── run the real writer ───────────────────────────────────────────────── */
let capturedXml = null;
const sandbox = {
    console, mgr, TextEncoder,
    Blob: class { constructor(p, o) { this.parts = p; this.type = o && o.type; }
                  async arrayBuffer() { return new ArrayBuffer(8); } },
    document: { createElement: () => fakeCanvas() },
    window: {}, setTimeout, showToast() {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    _blendToOra: { 'source-over': 'svg:src-over', 'multiply': 'svg:multiply' },
    _composite: () => fakeCanvas('COMPOSITE'),
    async _canvasToPngBytes(canvas) {
        if (!canvas) throw new Error('_canvasToPngBytes: canvas is ' + canvas);
        return new Uint8Array(4);
    },
    async _saveBlobAs(blob, name) { return name; },
    app: {
        config: { width: 8, height: 8 },
        ui: { cMain: fakeCanvas('cMain') },
        state: { fileName: 'art.ora' },
        markSaved() {}, resetSaveReminderTimer() {}, disableSmoothing() {}
    }
};
// Capture stack.xml on its way into the archive.
sandbox.TextEncoder = class {
    encode(s) { if (typeof s === 'string' && s.includes('<image')) capturedXml = s;
                return new Uint8Array(s ? s.length : 0); }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(extractAssign('const _oraZip = (() => {'), sandbox);
vm.runInContext(extractAssign('async function _saveAsORAInner()'), sandbox);
await sandbox._saveAsORAInner.call(sandbox.app);

console.log('== 1. the writer emits real nesting ==');
check('stack.xml was produced', !!capturedXml);
{
    const stacks = (capturedXml.match(/<stack[ >]/g) || []).length;
    // root + Folder A + Folder B
    check('folders are written as nested <stack> elements, not flattened away',
        stacks === 3, `found ${stacks}`);
    check('every raster layer is present',
        (capturedXml.match(/<layer /g) || []).length === 4,
        capturedXml);
    check('a pass-through folder is marked isolation="auto"',
        /isolation="auto"/.test(capturedXml));
    check('an isolated folder is marked isolation="isolate"',
        /isolation="isolate"/.test(capturedXml));
    check('the folder opacity is written on the folder',
        /<stack[^>]*opacity="0\.5000"/.test(capturedXml));
    check('a mask on a layer inside a folder is still written',
        /paint:mask="data\/mask_0\.png"/.test(capturedXml));
    check('clipping survives on a layer nested two folders deep',
        /<layer[^>]*name="Deep"[^>]*paint:clipped="true"/.test(capturedXml));
    check('the active layer is an index into the rebuild order',
        /paint:activeLayer="4"/.test(capturedXml), capturedXml.split('\n')[1]);
}

/* ── parse it back with the real reader ────────────────────────────────── */
/* Minimal stand-in for what DOMParser hands the loader: elements with
 * tagName / children / getAttribute. The source strips the "paint:" prefix
 * before parsing, so do the same here. */
function parseXml(xml) {
    const src = xml.replace(/paint:/g, '');
    const root = { tagName: '#root', children: [], getAttribute: () => null };
    const stack = [root];
    const tagRe = /<(\/?)([A-Za-z#?][\w-]*)([^>]*?)(\/?)>/g;
    let m;
    while ((m = tagRe.exec(src))) {
        const [, closing, tag, attrText, selfClose] = m;
        if (tag === '?xml' || tag.startsWith('?')) continue;
        if (closing) { stack.pop(); continue; }
        const attrs = {};
        const aRe = /([\w-]+)="([^"]*)"/g;
        let a;
        while ((a = aRe.exec(attrText))) attrs[a[1]] = a[2];
        const el = { tagName: tag, children: [], getAttribute: (n) => (n in attrs ? attrs[n] : null) };
        stack[stack.length - 1].children.push(el);
        if (!selfClose) stack.push(el);
    }
    return root;
}

const doc = parseXml(capturedXml);
const imageEl = doc.children.find(c => c.tagName === 'image');
const rootStack = imageEl.children.find(c => c.tagName === 'stack');

const loadBox = {
    console,
    layerDefs: [],
    _oraToBlend: { 'svg:src-over': 'source-over', 'svg:multiply': 'multiply' },
    // Pixels are irrelevant here; only structure is under test.
    _decodeEntry: async (src) => (src ? { __png: src } : null)
};
loadBox.globalThis = loadBox;
vm.createContext(loadBox);
// `const` does not land on the sandbox global, so hand it out explicitly.
vm.runInContext(extractAssign('const _walkStack = async (stackEl, parentIdx)') +
                '\nglobalThis.__walk = _walkStack;', loadBox);
await loadBox.__walk(rootStack, -1);
const defs = loadBox.layerDefs;

console.log('\n== 2. the reader rebuilds the same tree ==');
check('every node comes back (4 layers + 2 folders)', defs.length === 6, String(defs.length));
check('order matches the layer array: bottom-first, folder before its contents',
    defs.map(d => d.name).join(',') === 'BG,Folder A,Inner,Folder B,Deep,Top',
    defs.map(d => d.name).join(','));
{
    const byName = Object.fromEntries(defs.map((d, i) => [d.name, { d, i }]));
    check('Inner is inside Folder A',
        byName['Inner'].d.parentIdx === byName['Folder A'].i);
    check('Folder B is inside Folder A',
        byName['Folder B'].d.parentIdx === byName['Folder A'].i);
    check('Deep is inside Folder B, not re-parented to the top level',
        byName['Deep'].d.parentIdx === byName['Folder B'].i,
        String(byName['Deep'].d.parentIdx));
    check('top-level layers have no parent',
        byName['BG'].d.parentIdx === -1 && byName['Top'].d.parentIdx === -1);
    check('folders are marked as folders',
        byName['Folder A'].d.isGroup === true && byName['Inner'].d.isGroup === false);
    check('pass-through comes back as pass-through',
        byName['Folder A'].d.blendMode === 'pass-through',
        byName['Folder A'].d.blendMode);
    check('an isolated folder does NOT come back as pass-through',
        byName['Folder B'].d.blendMode === 'source-over',
        byName['Folder B'].d.blendMode);
    check('folder opacity round-trips', byName['Folder B'].d.opacity === 0.5);
    check('blend mode round-trips', byName['Inner'].d.blendMode === 'multiply');
    check('clipping round-trips', byName['Deep'].d.clipped === true);
    check('hidden stays hidden', byName['Top'].d.visible === false);
    check('the mask file is carried on the right layer',
        !!byName['Inner'].d.maskCanvas && !byName['Top'].d.maskCanvas);
    check('the base layer flag round-trips',
        byName['BG'].d.isBase === true && byName['Inner'].d.isBase === false);
    check('a folder carries no pixels', byName['Folder A'].d.canvas === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
