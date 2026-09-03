/* Verifies the new layer compositor in paint-engine.js.
 *
 * _buildTree / _renderList / _nodeContent are extracted verbatim and run
 * against a recording fake canvas, so we can assert the exact sequence of draw
 * operations: blend modes, group isolation, clipping runs and masks.
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

/* A canvas that records what was drawn onto it. */
let uid = 0;
function fakeCanvas(tag) {
    const c = { __tag: tag || ('scratch' + (++uid)), width: 4, height: 4, ops: [] };
    c.getContext = () => ({
        _c: c,
        globalAlpha: 1, globalCompositeOperation: 'source-over',
        setTransform() {}, save() { c.ops.push('save'); }, restore() { c.ops.push('restore'); },
        clearRect() { c.ops.push('clear'); },
        fillRect() {}, set fillStyle(v) {},
        drawImage(src) {
            c.ops.push(`${src.__tag}@${this.globalCompositeOperation}x${this.globalAlpha}`);
        }
    });
    return c;
}

const harness = `
${extractFn('_buildTree')}
${extractFn('_blendOf')}
${extractFn('_isPassThrough')}
${extractFn('_getScratch')}
${extractFn('_releaseScratch')}
${extractFn('_nodeContent')}
${extractFn('_renderList')}
globalThis.__api = { _buildTree, _renderList, _nodeContent };
`;

const mgr = { layers: [] };
const sandbox = {
    console, mgr,
    app: { disableSmoothing() {}, config: { width: 4, height: 4 } },
    document: { createElement: () => fakeCanvas() },
    _scratchPool: []
};
vm.createContext(sandbox);
vm.runInContext(harness, sandbox);
const { _buildTree, _renderList } = sandbox.__api;
console.log(`extracted compositor from ${SRC}\n`);

let nid = 0;
function layer(tag, extra) {
    return Object.assign({
        id: ++nid, name: tag, visible: true, opacity: 1,
        blendMode: 'source-over', canvas: fakeCanvas(tag),
        parentId: null, isGroup: false, clipped: false, mask: null
    }, extra || {});
}
function render() {
    const out = fakeCanvas('OUT');
    const { roots, kids } = _buildTree();
    _renderList(roots, kids, out.getContext(), 4, 4);
    return out.ops.filter(o => o !== 'save' && o !== 'restore' && o !== 'clear');
}

console.log('== 1. blend mode and opacity reach the draw call ==');
{
    const a = layer('A');
    const b = layer('B', { blendMode: 'multiply', opacity: 0.5 });
    mgr.layers = [a, b];
    const ops = render();
    check('bottom layer drawn normally', ops[0] === 'A@source-overx1', ops.join(' | '));
    check('multiply + opacity applied to the layer above',
        ops[1] === 'B@multiplyx0.5', ops.join(' | '));
}

console.log('\n== 2. hidden layers are skipped ==');
{
    mgr.layers = [layer('A'), layer('B', { visible: false }), layer('C')];
    const ops = render();
    check('only visible layers drawn', ops.length === 2 && !ops.some(o => o.startsWith('B')),
        ops.join(' | '));
}

console.log('\n== 3. a clipped layer is confined to the one below ==');
{
    const base = layer('BASE');
    const clip = layer('CLIP', { clipped: true, blendMode: 'multiply' });
    mgr.layers = [base, clip];
    const ops = render();
    // base+clip composite in a scratch, masked by base alpha, then drawn once
    check('clipped layer is NOT drawn straight to the output',
        !ops.some(o => o.startsWith('CLIP@')), ops.join(' | '));
    check('exactly one draw reaches the output', ops.length === 1, ops.join(' | '));
    check('the clipping group is drawn with the BASE layer settings',
        ops[0].endsWith('@source-overx1'), ops.join(' | '));
}

console.log('\n== 4. clipping uses destination-in against the base shape ==');
{
    const base = layer('BASE');
    const clip = layer('CLIP', { clipped: true });
    mgr.layers = [base, clip];
    const out = fakeCanvas('OUT');
    const { roots, kids } = _buildTree();
    _renderList(roots, kids, out.getContext(), 4, 4);
    // find the scratch that received the clipping work
    const scratch = sandbox._scratchPool.find(c => c.ops.some(o => o.includes('destination-in')));
    check('a destination-in pass confines the run to the base',
        !!scratch, 'no destination-in recorded');
    if (scratch) {
        const seq = scratch.ops.filter(o => o !== 'save' && o !== 'restore' && o !== 'clear');
        check('order is: base, clipped layer, then mask by base',
            seq[0].startsWith('BASE@') && seq[1].startsWith('CLIP@') &&
            seq[2] === 'BASE@destination-inx1', seq.join(' | '));
    }
}

console.log('\n== 5. a group isolates its children ==');
{
    const g = layer('G', { isGroup: true, opacity: 0.5, blendMode: 'screen', canvas: null });
    const c1 = layer('C1', { parentId: g.id });
    const c2 = layer('C2', { parentId: g.id, blendMode: 'multiply' });
    mgr.layers = [g, c1, c2];
    const ops = render();
    check('the folder reaches the output as ONE draw', ops.length === 1, ops.join(' | '));
    check('group opacity and blend apply to the folder as a whole',
        ops[0].endsWith('@screenx0.5'), ops.join(' | '));
    check('children are not drawn straight to the output',
        !ops.some(o => o.startsWith('C1@') || o.startsWith('C2@')), ops.join(' | '));
}

console.log('\n== 6. hiding a group hides it without touching the children ==');
{
    const g = layer('G', { isGroup: true, visible: false, canvas: null });
    const c1 = layer('C1', { parentId: g.id });
    mgr.layers = [g, c1];
    const ops = render();
    check('nothing from the hidden folder is drawn', ops.length === 0, ops.join(' | '));
    check('the child keeps its own visible flag', c1.visible === true);
}

console.log('\n== 7. an empty group draws nothing ==');
{
    const g = layer('G', { isGroup: true, canvas: null });
    mgr.layers = [g, layer('A')];
    const ops = render();
    check('empty folder contributes nothing', ops.length === 1 && ops[0].startsWith('A@'),
        ops.join(' | '));
}

console.log('\n== 8. a layer mask cuts the layer down ==');
{
    const m = fakeCanvas('MASK');
    mgr.layers = [layer('A', { mask: { canvas: m, enabled: true } })];
    const out = fakeCanvas('OUT');
    const { roots, kids } = _buildTree();
    _renderList(roots, kids, out.getContext(), 4, 4);
    const scratch = sandbox._scratchPool.find(c => c.ops.some(o => o.startsWith('MASK@')));
    check('mask applied in a scratch, not to the layer itself', !!scratch);
    if (scratch) {
        // Scratch canvases are pooled and reused, so their op log can carry
        // entries from earlier cases — assert on the tail.
        const seq = scratch.ops.filter(o => o !== 'save' && o !== 'restore' && o !== 'clear');
        const tail = seq.slice(-2);
        check('layer drawn, then masked with destination-in',
            tail[0].startsWith('A@') && tail[1] === 'MASK@destination-inx1', seq.join(' | '));
    }
    check('a disabled mask is ignored', (() => {
        sandbox._scratchPool.length = 0;
        mgr.layers = [layer('A', { mask: { canvas: fakeCanvas('MASK2'), enabled: false } })];
        return render()[0].startsWith('A@');
    })());
}

console.log('\n== 9. nesting: group inside a group ==');
{
    const outer = layer('OUTER', { isGroup: true, canvas: null });
    const inner = layer('INNER', { isGroup: true, parentId: outer.id, canvas: null, opacity: 0.25 });
    const leaf = layer('LEAF', { parentId: inner.id });
    mgr.layers = [outer, inner, leaf];
    const ops = render();
    check('nested folders collapse to a single output draw', ops.length === 1, ops.join(' | '));
}

console.log('\n== 10. a layer whose parent is missing still renders ==');
{
    mgr.layers = [layer('ORPHAN', { parentId: 9999 })];
    const ops = render();
    check('dangling parentId falls back to top level',
        ops.length === 1 && ops[0].startsWith('ORPHAN@'), ops.join(' | '));
}

console.log('\n== 11. pass-through folders do not isolate ==');
{
    // An isolated folder is flattened first, so the output sees ONE draw and
    // the child's own blend mode is spent inside the folder.
    const g = layer('G', { isGroup: true, blendMode: 'source-over' });
    mgr.layers = [layer('BASE'), g, layer('KID', { parentId: g.id, blendMode: 'multiply' })];
    const iso = render();
    check('an isolated folder reaches the canvas as a single object',
        iso.length === 2 && iso[1].startsWith('scratch'), iso.join(' | '));

    // Pass-through draws the children straight onto what is already there, so
    // the child's multiply blends against the layer below the folder.
    g.blendMode = 'pass-through';
    const pt = render();
    check('a pass-through folder draws its children directly',
        pt.length === 2 && pt[1] === 'KID@multiplyx1', pt.join(' | '));
}

console.log('\n== 12. pass-through gives way when the folder must act as one object ==');
{
    const g = layer('G', { isGroup: true, blendMode: 'pass-through', opacity: 0.5 });
    mgr.layers = [layer('BASE'), g, layer('KID', { parentId: g.id })];
    let ops = render();
    check('a partly transparent folder isolates, or the opacity could not apply',
        ops.length === 2 && ops[1].startsWith('scratch') && ops[1].endsWith('x0.5'),
        ops.join(' | '));

    g.opacity = 1;
    g.mask = { canvas: fakeCanvas('GMASK'), enabled: true };
    ops = render();
    check('a masked folder isolates too', ops.length === 2 && ops[1].startsWith('scratch'),
        ops.join(' | '));

    g.mask = null;
    mgr.layers.push(layer('CLIP', { clipped: true }));
    ops = render();
    // The clipping itself happens on a scratch canvas, so what is visible from
    // out here is that the folder went through a scratch instead of drawing its
    // children straight onto the output.
    check('a folder used as a clip base isolates, so the run has a shape to clip to',
        !ops.some(o => o.startsWith('KID@')) && ops.some(o => o.startsWith('scratch')),
        ops.join(' | '));
}

console.log('\n== 13. a clipped layer with nothing under it still draws ==');
{
    // Clipping the first layer INSIDE a folder used to drop it with no warning.
    const g = layer('G', { isGroup: true, blendMode: 'pass-through' });
    mgr.layers = [layer('BASE'), g, layer('FIRST', { parentId: g.id, clipped: true })];
    const ops = render();
    check('it is drawn as an ordinary layer rather than vanishing',
        ops.some(o => o.startsWith('FIRST@')), ops.join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
