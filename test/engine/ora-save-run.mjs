/* Runs the real saveAsORA() against stubs to find where it fails. */
import { readFileSync } from 'fs';
import vm from 'vm';

const SRC = process.argv[2] || 'src/js/paint-engine.js';
const lines = readFileSync(SRC, 'utf8').split(/\r?\n/);

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
    throw new Error('unbalanced');
}

let uid = 0;
function fakeCanvas(tag, w = 8, h = 8) {
    const c = { __tag: tag || ('c' + (++uid)), width: w, height: h };
    c.getContext = () => ({
        drawImage() {}, clearRect() {}, save() {}, restore() {}, setTransform() {},
        globalAlpha: 1, globalCompositeOperation: 'source-over'
    });
    c.toBlob = (cb) => cb({ arrayBuffer: async () => new ArrayBuffer(8) });
    return c;
}

const mgr = { active: true, activeIdx: 0, layers: [] };
const sandbox = {
    console,
    mgr,
    TextEncoder,
    Blob: class { constructor(p, o) { this.parts = p; this.type = o && o.type; }
                  async arrayBuffer() { return new ArrayBuffer(8); } },
    document: { createElement: () => fakeCanvas() },
    window: {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    setTimeout,
    showToast() {},
    _blendToOra: { 'source-over': 'svg:src-over', 'multiply': 'svg:multiply' },
    async _canvasToPngBytes(canvas) {
        if (!canvas) throw new Error('_canvasToPngBytes: canvas is ' + canvas);
        return new Uint8Array(4);
    },
    // mergedimage.png now goes through the real compositor
    _composite: () => fakeCanvas('COMPOSITE'),
    // real ZIP builder is injected below
    async _saveBlobAs(blob, name) { sandbox.__saved = name; return name; },
    app: {
        config: { width: 8, height: 8 },
        ui: { cMain: fakeCanvas('cMain') },
        state: { fileName: 'art.ora' },
        escapeHtml: (s) => s,
        markSaved() {}, resetSaveReminderTimer() {},
        getTauriInvokeFn: () => undefined,
        disableSmoothing() {}
    }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
// inject the REAL zip builder and the real inner save function
vm.runInContext(extractAssign('const _oraZip = (() => {'), sandbox);
vm.runInContext(extractAssign('app.saveAsORA = async function'), sandbox);
vm.runInContext(extractAssign('async function _saveAsORAInner()'), sandbox);

function layer(tag, extra) {
    return Object.assign({
        id: ++uid, name: tag, canvas: fakeCanvas(tag), visible: true, opacity: 1,
        blendMode: 'source-over', locked: false, alphaLock: false, isBase: false,
        clipped: false, mask: null, parentId: null
    }, extra || {});
}

async function attempt(label, layers) {
    mgr.layers = layers;
    sandbox.__saved = null;
    try {
        await sandbox.app.saveAsORA.call(sandbox.app);
        console.log(`  ok   ${label} -> wrote ${sandbox.__saved}`);
        return true;
    } catch (e) {
        console.log(`  FAIL ${label} -> ${e && e.message}`);
        if (e && e.stack) console.log('        ' + e.stack.split('\n').slice(0, 3).join('\n        '));
        return false;
    }
}

console.log('== running the real saveAsORA against stub layers ==');
await attempt('two plain layers', [layer('BG', { isBase: true }), layer('L2')]);
await attempt('layer with a mask', [
    layer('BG', { isBase: true }),
    layer('L2', { mask: { canvas: fakeCanvas('MASK'), enabled: true } })
]);
await attempt('clipped layer', [layer('BG', { isBase: true }), layer('L2', { clipped: true })]);
await attempt('with a GROUP layer', [
    layer('BG', { isBase: true }),
    layer('G', { isGroup: true, canvas: fakeCanvas('GROUP'), ctx: null }),
    layer('CHILD', { parentId: 999 })
]);
await attempt('group whose canvas is null', [
    layer('BG', { isBase: true }),
    layer('G', { isGroup: true, canvas: null, ctx: null })
]);
await attempt('hidden layer', [layer('BG', { isBase: true }), layer('L2', { visible: false })]);
