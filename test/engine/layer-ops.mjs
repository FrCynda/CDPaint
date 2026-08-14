/* Layer operations that used to lose things.
 *
 *  - Duplicate copied opacity and blend but dropped the mask and the clipping,
 *    and duplicating a folder produced an empty folder.
 *  - Deleting a folder left its contents behind, scattered to the top level.
 *  - "New group" made an empty folder you then had to drag into.
 *  - Clipping was blocked at the bottom of the DOCUMENT but not at the bottom
 *    of a FOLDER, where it made the layer silently disappear.
 *
 * The functions are lifted verbatim out of the source and run against stubs.
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
function fakeCanvas(tag, w = 8, h = 8) {
    const c = { __tag: tag || ('c' + (++uid)), width: w, height: h };
    c.getContext = () => ({
        drawImage(src) { c.__drewFrom = src && src.__tag; },
        clearRect() {}, save() {}, restore() {}, setTransform() {}, fillRect() {},
        globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000'
    });
    return c;
}

const mgr = { active: true, activeIdx: 0, layers: [], nextId: 100 };
let saveStateCalls = 0;

const sandbox = {
    console, mgr,
    document: { createElement: () => fakeCanvas('placeholder') },
    requestAnimationFrame: () => 0,
    app: {
        config: { width: 8, height: 8 },
        disableSmoothing() {},
        saveState() { saveStateCalls++; }
    },
    _newCanvas: (w, h) => fakeCanvas('new', w, h),
    _applyLayerStyle() {}, _refreshList() {}, _invalidate() {},
    _syncBtns() {}, _schedThumb() {}, _syncOpacity() {},
    _makeMask: (w, h) => ({ canvas: fakeCanvas('mask', w, h),
                            ctx: fakeCanvas('mask').getContext(), enabled: true }),
    _setActive(i) { mgr.activeIdx = Math.max(0, Math.min(i, mgr.layers.length - 1)); }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const fn of ['_subtreeIds', '_canClip', '_cloneLayer', '_dupLayer', '_delLayer', '_makeGroup']) {
    vm.runInContext(extractFn(fn) + `\nglobalThis.${fn} = ${fn};`, sandbox);
}
console.log(`extracted layer ops from ${SRC}\n`);

let nid = 1;
function layer(name, extra) {
    return Object.assign({
        id: nid++, name, canvas: fakeCanvas(name), ctx: fakeCanvas(name).getContext(),
        visible: true, opacity: 1, blendMode: 'source-over', locked: false,
        alphaLock: false, isBase: false, clipped: false, mask: null,
        parentId: null, alpha: true, isGroup: false
    }, extra || {});
}
const byName = (n) => mgr.layers.find(l => l.name === n);

console.log('== 1. duplicate carries everything the original had ==');
{
    const src = layer('Art', {
        clipped: true, opacity: 0.4, blendMode: 'multiply', alphaLock: true,
        mask: { canvas: fakeCanvas('MASK'), enabled: false }
    });
    mgr.layers = [layer('BG', { isBase: true }), src];
    mgr.activeIdx = 1;
    sandbox._dupLayer();

    const copy = mgr.layers[2];
    check('the copy was inserted directly above the original', !!copy && copy.name === 'Art copy');
    check('the mask comes with it', !!(copy && copy.mask && copy.mask.canvas));
    check('a disabled mask stays disabled', copy.mask.enabled === false);
    check('the mask is a separate canvas, not the same one',
        copy.mask.canvas !== src.mask.canvas);
    check('the clipping comes with it', copy.clipped === true);
    check('opacity and blend still come with it',
        copy.opacity === 0.4 && copy.blendMode === 'multiply');
    check('alpha lock comes with it', copy.alphaLock === true);
    check('the copy is not the base layer', copy.isBase === false);
    check('the copy gets a fresh id', copy.id !== src.id);
    check('the copy is selected', mgr.activeIdx === 2);
}

console.log('\n== 2. duplicating a folder duplicates its contents ==');
{
    const g     = layer('G',     { isGroup: true, ctx: null });
    const kid1  = layer('Kid1',  { parentId: g.id });
    const sub   = layer('Sub',   { isGroup: true, ctx: null, parentId: g.id });
    const kid2  = layer('Kid2',  { parentId: sub.id });
    mgr.layers = [layer('BG', { isBase: true }), g, kid1, sub, kid2, layer('Top')];
    mgr.activeIdx = 1;                       // the folder
    const before = mgr.layers.length;
    sandbox._dupLayer();

    check('four new entries appeared, not one empty folder',
        mgr.layers.length === before + 4, `${before} -> ${mgr.layers.length}`);
    const gCopy = mgr.layers.find(l => l.name === 'G copy');
    check('the folder copy exists', !!gCopy);
    const copies = mgr.layers.filter(l => l !== g && l !== kid1 && l !== sub && l !== kid2 &&
                                          (l.name === 'G copy' || l.name === 'Kid1' ||
                                           l.name === 'Sub' || l.name === 'Kid2'));
    check('the contents were copied too', copies.length === 4, String(copies.length));
    const kid1Copy = copies.find(l => l.name === 'Kid1');
    const subCopy  = copies.find(l => l.name === 'Sub');
    const kid2Copy = copies.find(l => l.name === 'Kid2');
    check('the copied child points at the COPIED folder, not the original',
        kid1Copy.parentId === gCopy.id, `${kid1Copy.parentId} vs ${gCopy.id}`);
    check('nesting is preserved two deep', kid2Copy.parentId === subCopy.id);
    check('the original folder still holds its own children',
        kid1.parentId === g.id && sub.parentId === g.id && kid2.parentId === sub.id);
    check('the copies sit above the original block, below what was on top',
        mgr.layers[mgr.layers.length - 1].name === 'Top');
    check('the new folder is selected', mgr.layers[mgr.activeIdx] === gCopy);
    check('copied ids are all distinct',
        new Set(mgr.layers.map(l => l.id)).size === mgr.layers.length);
}

console.log('\n== 3. deleting a folder takes its contents with it ==');
{
    const g    = layer('G',    { isGroup: true, ctx: null });
    const kid  = layer('Kid',  { parentId: g.id });
    const sub  = layer('Sub',  { isGroup: true, ctx: null, parentId: g.id });
    const deep = layer('Deep', { parentId: sub.id });
    mgr.layers = [layer('BG', { isBase: true }), g, kid, sub, deep, layer('Other')];
    mgr.activeIdx = 1;
    sandbox._delLayer();

    check('the folder and everything in it are gone',
        mgr.layers.length === 2, mgr.layers.map(l => l.name).join(','));
    check('nothing was orphaned to the top level',
        !mgr.layers.some(l => ['Kid', 'Sub', 'Deep'].includes(l.name)));
    check('unrelated layers are untouched', !!byName('BG') && !!byName('Other'));
}
{
    // Deleting a folder that holds the entire document must not empty it.
    const g   = layer('G',  { isGroup: true, ctx: null });
    const kid = layer('K',  { parentId: g.id });
    mgr.layers = [g, kid];
    mgr.activeIdx = 0;
    sandbox._delLayer();
    check('a folder holding the whole document is not deleted', mgr.layers.length === 2);
}
{
    // A plain layer still deletes normally.
    mgr.layers = [layer('BG', { isBase: true }), layer('A'), layer('B')];
    mgr.activeIdx = 1;
    sandbox._delLayer();
    check('deleting a plain layer removes exactly one',
        mgr.layers.length === 2 && !byName('A'));
}

console.log('\n== 4. "New group" puts the selected layer inside ==');
{
    mgr.layers = [layer('BG', { isBase: true }), layer('Art')];
    mgr.activeIdx = 1;
    mgr.nextId = 500;
    sandbox._makeGroup();

    const g = mgr.layers.find(l => l.isGroup);
    check('a folder was created', !!g);
    check('the selected layer went into it', byName('Art').parentId === g.id);
    check('the folder defaults to pass-through, like Photoshop',
        g.blendMode === 'pass-through', g.blendMode);
    check('the layer inside stays selected', mgr.layers[mgr.activeIdx].name === 'Art');
    check('the background was not swept into the folder', byName('BG').parentId == null);
}
{
    // Grouping while the base layer is selected leaves the base alone.
    mgr.layers = [layer('BG', { isBase: true })];
    mgr.activeIdx = 0;
    sandbox._makeGroup();
    check('the base layer is never absorbed', byName('BG').parentId == null);
}

console.log('\n== 5. clipping is only offered where it can work ==');
{
    const g = layer('G', { isGroup: true, ctx: null });
    const first = layer('First', { parentId: g.id });
    const second = layer('Second', { parentId: g.id });
    mgr.layers = [layer('BG', { isBase: true }), g, first, second, layer('Top')];

    check('the bottom of the document cannot clip', sandbox._canClip(0) === false);
    check('a folder itself cannot clip', sandbox._canClip(1) === false);
    check('THE BUG: the first layer inside a folder cannot clip either',
        sandbox._canClip(2) === false,
        'it has no sibling underneath, so it used to vanish silently');
    check('a second layer inside the folder CAN clip', sandbox._canClip(3) === true);
    check('a top-level layer above the background can clip', sandbox._canClip(4) === true);
}

console.log('\n== 6. subtree collection is not fooled by array order ==');
{
    const g   = layer('G',   { isGroup: true, ctx: null });
    const sub = layer('Sub', { isGroup: true, ctx: null, parentId: g.id });
    const kid = layer('Kid', { parentId: sub.id });
    // Deliberately out of order: the grandchild sits before its grandparent.
    mgr.layers = [kid, sub, g];
    const ids = sandbox._subtreeIds(g.id);
    check('a descendant listed before its parent is still found',
        ids.has(kid.id) && ids.has(sub.id) && ids.size === 3, String(ids.size));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
