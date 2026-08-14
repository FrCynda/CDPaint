/* Verifies the collapse/activate cycle under the NEW compositor model.
 *
 * Model: layer pixels are OFF-SCREEN canvases; cMain is the display surface
 * showing the composite. So:
 *   - collapsing flattens into cMain and empties the stack (pristine state)
 *   - activating builds a fresh Background by copying cMain off-screen
 * That symmetry is what makes a duplicate "Background" impossible.
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

function extractFn(name) {
    const start = lines.findIndex(l => new RegExp(`^        function ${name}\\s*\\(`).test(l));
    if (start < 0) throw new Error(`function ${name} not found`);
    let depth = 0, started = false, out = [];
    for (let i = start; i < lines.length; i++) {
        out.push(lines[i]);
        for (const ch of lines[i]) {
            if (ch === '{') { depth++; started = true; }
            else if (ch === '}') depth--;
        }
        if (started && depth === 0) return out.join('\n');
    }
    throw new Error(`unbalanced braces in ${name}`);
}

let uid = 0;
function fakeCanvas(tag) {
    const c = { __tag: tag || ('c' + (++uid)), width: 8, height: 8, style: {}, drew: [] };
    c.getContext = () => ({
        drawImage(src) { c.drew.push(src.__tag); },
        clearRect() {}, fillRect() {}, save() {}, restore() {},
        setTransform() {}, set fillStyle(v) {},
        globalAlpha: 1, globalCompositeOperation: 'source-over'
    });
    return c;
}

const cMain = fakeCanvas('cMain');
const mgr = { active: false, layers: [], activeIdx: 0, nextId: 2 };
let renders = 0;

const harness = `
${extractFn('_newCanvas')}
${extractFn('_collapseToBase')}
${extractFn('_activate')}
globalThis.__api = { _collapseToBase, _activate, _newCanvas };
`;

const sandbox = {
    console, mgr,
    app: {
        ui: { cMain, cTemp: { style: {} }, stage: { classList: { add() {}, remove() {} } } },
        config: { width: 8, height: 8 },
        disableSmoothing() {}
    },
    document: { createElement: () => fakeCanvas() },
    _holder: { ctx: cMain.getContext() },
    _refreshList() {}, _syncBtns() {}, _syncOpacity() {},
    _render() { renders++; },
    _invalidate() {}
};
vm.createContext(sandbox);
vm.runInContext(harness, sandbox);
const { _collapseToBase, _activate } = sandbox.__api;
console.log(`extracted _collapseToBase + _activate from ${SRC}\n`);

const newLayer = (id) => ({
    id, name: 'Layer ' + id, canvas: fakeCanvas('L' + id), ctx: {},
    visible: true, opacity: 1, isBase: false
});

console.log('== 1. activating moves the picture off-screen ==');
{
    mgr.active = false; mgr.layers = []; mgr.nextId = 2;
    _activate();
    check('a Background layer was created', mgr.layers.length === 1, `${mgr.layers.length}`);
    check('layer mode on', mgr.active === true);
    const base = mgr.layers[0];
    check('it is NOT the display canvas', base.canvas !== cMain,
        'layer pixels must live off-screen');
    check('it received a copy of what was on screen',
        base.canvas.drew.includes('cMain'), base.canvas.drew.join(','));
    check('named Background and marked as base',
        base.name === 'Background' && base.isBase === true);
}

console.log('\n== 2. collapsing flattens to the display and empties the stack ==');
{
    mgr.layers.push(newLayer(2), newLayer(3));
    mgr.activeIdx = 2; mgr.nextId = 4;
    const before = renders;
    _collapseToBase({ fresh: true });
    check('composited into the display canvas before dropping layers',
        renders === before + 1, `${renders - before} renders`);
    check('stack emptied', mgr.layers.length === 0, `${mgr.layers.length}`);
    check('layer mode off', mgr.active === false);
    check('active index reset', mgr.activeIdx === 0);
    check('numbering restarts for a fresh document', mgr.nextId === 2, `${mgr.nextId}`);
}

console.log('\n== 3. re-activating cannot produce a second Background ==');
{
    _activate();
    check('exactly one layer', mgr.layers.length === 1, `${mgr.layers.length}`);
    const fromMain = mgr.layers.filter(l => l.canvas === cMain);
    check('no layer aliases the display canvas', fromMain.length === 0,
        `${fromMain.length} layers point at cMain`);
    check('named Background', mgr.layers[0].name === 'Background');
}

console.log('\n== 4. undo-path collapse keeps layer numbering ==');
{
    mgr.layers.push(newLayer(7));
    mgr.nextId = 8;
    _collapseToBase();                 // no {fresh} — the undo path
    check('stack emptied', mgr.layers.length === 0);
    check('numbering NOT reset (would reuse ids held in history)', mgr.nextId === 8,
        `${mgr.nextId}`);
}

console.log('\n== 5. repeated cycles stay stable ==');
{
    mgr.active = false; mgr.layers = []; mgr.nextId = 2;
    for (let i = 0; i < 5; i++) {
        _activate();
        mgr.layers.push(newLayer(mgr.nextId++));
        _collapseToBase({ fresh: true });
    }
    _activate();
    check('one layer after 5 cycles', mgr.layers.length === 1, `${mgr.layers.length}`);
    check('still no alias of the display canvas',
        mgr.layers.every(l => l.canvas !== cMain));
    check('numbering did not run away', mgr.nextId === 2, `${mgr.nextId}`);
}

console.log('\n== 6. collapsing an already-collapsed stack is safe ==');
{
    mgr.active = false; mgr.layers = []; mgr.nextId = 2;
    const before = renders;
    _collapseToBase({ fresh: true });
    check('no render attempted with nothing to flatten', renders === before);
    check('still empty and inactive', mgr.layers.length === 0 && mgr.active === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
