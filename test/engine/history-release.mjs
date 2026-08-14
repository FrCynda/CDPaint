/* Verifies the history-eviction logic in paint-engine.js.
 *
 * The methods are extracted VERBATIM from the source and evaluated standalone,
 * so this tests the shipped code rather than a reimplementation of it. They are
 * self-contained (no DOM, no canvas), which is what makes that possible.
 *
 * The bug under test: layered history entries share unchanged layers with an
 * EARLIER entry by reference. Trimming the front of the history used to close
 * those shared ImageBitmaps, leaving later undo steps drawing from detached
 * bitmaps.
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

/* Pull a class method out of the source by brace matching. */
function extractMethod(name) {
    const start = lines.findIndex(l => new RegExp(`^        ${name}\\s*\\(`).test(l));
    if (start < 0) throw new Error(`method ${name} not found in ${SRC}`);
    let depth = 0, started = false, out = [];
    for (let i = start; i < lines.length; i++) {
        const line = lines[i];
        out.push(line);
        for (const ch of line) {
            if (ch === '{') { depth++; started = true; }
            else if (ch === '}') depth--;
        }
        if (started && depth === 0) return out.join('\n');
    }
    throw new Error(`unbalanced braces extracting ${name}`);
}

const NAMES = ['_collectOwnedSnapsInUse', '_releaseHistoryEntries', '_closeBitmapEntry',
               'historyHardCap', 'historyBudgetFor', '_trimHistoryTarget',
               '_entryBytes', 'historyBytes', 'historyByteBudget'];
const body = NAMES.map(extractMethod).join('\n');
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(`class H {\n${body}\n}\nglobalThis.H = H;`, sandbox);
const h = new sandbox.H();
h.HISTORY_MIN_STEPS = 8;
sandbox.navigator = { deviceMemory: 8 };
console.log(`extracted ${NAMES.length} methods from ${SRC}\n`);

/* Fake ImageBitmap that records whether it was closed. */
let nextBmp = 0;
const makeBmp = () => ({ id: ++nextBmp, closed: false, close() { this.closed = true; } });
const ownedSnap = (id) => ({ id, bitmap: makeBmp(), ref: null });
const refSnap = (id, target) => ({ id, bitmap: null, ref: target });

console.log('== 1. ref chains are followed to the owning snap ==');
{
    const owner = ownedSnap('L1');
    const mid = refSnap('L1', owner);
    const tail = refSnap('L1', mid);          // two-hop chain
    const inUse = h._collectOwnedSnapsInUse([{ snaps: [tail] }]);
    check('multi-hop chain resolves to the owner', inUse.has(owner));
    check('only the owner is marked in use', inUse.size === 1, `size ${inUse.size}`);

    const selfOnly = h._collectOwnedSnapsInUse([{ snaps: [ownedSnap('X')] }]);
    check('an entry owning its own snap pins nothing foreign', selfOnly.size === 0);
}

console.log('\n== 2. eviction does NOT close pixels a survivor still uses ==');
{
    // e0 owns the layer bitmap; e1 and e2 reference it (layer never changed).
    const owner = ownedSnap('base');
    const e0 = { _lsys: true, snaps: [owner] };
    const e1 = { _lsys: true, snaps: [refSnap('base', owner)] };
    const e2 = { _lsys: true, snaps: [refSnap('base', owner)] };
    const history = [e0, e1, e2];

    const evicted = history.splice(0, 1);      // drop e0 from the front
    h._releaseHistoryEntries(evicted, history);

    check('shared bitmap kept alive for surviving entries', owner.bitmap.closed === false,
        'this is the bug: closing it strands undo on a detached bitmap');
    check('survivors can still resolve to real pixels',
        history.every(e => {
            let s = e.snaps[0];
            while (s.ref) s = s.ref;
            return s.bitmap && !s.bitmap.closed;
        }));
}

console.log('\n== 3. eviction DOES close pixels nothing references ==');
{
    const orphan = ownedSnap('gone');
    const keeper = ownedSnap('kept');
    const orphanBmp = orphan.bitmap;   // the code nulls the field after closing
    const e0 = { _lsys: true, snaps: [orphan] };
    const e1 = { _lsys: true, snaps: [keeper] };
    const history = [e0, e1];

    const evicted = history.splice(0, 1);
    h._releaseHistoryEntries(evicted, history);

    check('unreferenced bitmap is released', orphanBmp.closed === true);
    check('reference to it is cleared', orphan.bitmap === null);
    check('surviving entry\'s own bitmap untouched', keeper.bitmap.closed === false);
}

console.log('\n== 4. flat (non-layered) entries still release ==');
{
    const flat = { bitmap: makeBmp(), width: 8, height: 8 };
    const survivor = { bitmap: makeBmp(), width: 8, height: 8 };
    const flatBmp = flat.bitmap;
    const history = [flat, survivor];
    const evicted = history.splice(0, 1);
    h._releaseHistoryEntries(evicted, history);
    check('evicted flat bitmap closed', flatBmp.closed === true);
    check('evicted flat reference cleared', flat.bitmap === null);
    check('surviving flat bitmap alive', survivor.bitmap.closed === false);
}

console.log('\n== 5. trimming keeps the cursor pointing at the same image ==');
{
    const target = {
        history: Array.from({ length: 10 }, (_, i) => ({ id: i, bitmap: makeBmp() })),
        step: 7
    };
    const atCursor = target.history[7];
    const n = h._trimHistoryTarget(target, 4);
    check('evicted the overflow', n === 6, `evicted ${n}`);
    check('kept exactly the budget', target.history.length === 4, `${target.history.length}`);
    check('cursor still points at the same entry', target.history[target.step] === atCursor,
        `step ${target.step}`);
    check('cursor stayed in range', target.step >= 0 && target.step < target.history.length);
}

console.log('\n== 6. trim is a no-op under budget ==');
{
    const target = { history: [{ id: 'a' }, { id: 'b' }], step: 1 };
    check('returns 0 when nothing to do', h._trimHistoryTarget(target, 10) === 0);
    check('history untouched', target.history.length === 2);
    check('cursor untouched', target.step === 1);
    check('handles a missing history array', h._trimHistoryTarget({}, 5) === 0);
    check('handles null target', h._trimHistoryTarget(null, 5) === 0);
}

console.log('\n== 7. the count ceiling no longer punishes large canvases ==');
{
    // This used to model every entry as a full-canvas snapshot and so allowed
    // 8 undo steps on an 8000² document. Memory is the byte budget's job now;
    // the count is only a ceiling.
    check('canvas size no longer decides the step count',
        h.historyHardCap(64, 64) === 500 && h.historyHardCap(8000, 8000) === 500,
        `${h.historyHardCap(64, 64)} vs ${h.historyHardCap(8000, 8000)}`);
    check('degenerate size falls back safely', h.historyHardCap(0, 0) === 500);

    h.historyLimitEnabled = true; h.historyLimit = 25;
    check('user limit wins when enabled', h.historyBudgetFor(64, 64) === 25);
    h.historyLimitEnabled = false;
    check('hard cap applies when limit disabled', h.historyBudgetFor(64, 64) === 500);
}

console.log('\n== 8. removing an entry from the MIDDLE (collapseSelectionCutStep) ==');
{
    // A selection commit collapses the intermediate "cut" entry out of the
    // middle of the history. Entries AFTER it survive and may reference it.
    const owner = ownedSnap('layer');
    const cut = { _lsys: true, snaps: [owner] };
    const later = { _lsys: true, snaps: [refSnap('layer', owner)] };
    const history = [{ _lsys: true, snaps: [ownedSnap('older')] }, cut, later];

    const [evicted] = history.splice(1, 1);          // remove the middle entry
    h._releaseHistoryEntries([evicted], history);

    check('pixels referenced by a LATER entry survive middle removal',
        owner.bitmap && owner.bitmap.closed === false);
    let s = later.snaps[0]; while (s.ref) s = s.ref;
    check('the later entry still resolves to live pixels', s.bitmap && !s.bitmap.closed);
}

console.log('\n== 9. the old unguarded release would have broken these ==');
{
    // Same fixture as test 2, run through _closeBitmapEntry (the pre-fix path)
    // to confirm these tests actually discriminate.
    const owner = ownedSnap('base');
    const ownerBmp = owner.bitmap;
    const e0 = { _lsys: true, snaps: [owner] };
    const e1 = { _lsys: true, snaps: [refSnap('base', owner)] };
    const history = [e0, e1];
    const evicted = history.splice(0, 1);
    for (const e of evicted) h._closeBitmapEntry(e);   // the old code path
    check('old path DOES detach the shared bitmap (test is not vacuous)',
        ownerBmp.closed === true,
        'if this fails the fixture no longer reproduces the original bug');
}

console.log('\n== 10. document-replacing paths must DETACH, not release ==');
{
    // Reproduces the crash: creating a new document released the history array
    // that the outgoing tab's record still owned, so switching back to that tab
    // hit "drawImage: value is not of type ImageBitmap".
    const src = readFileSync(SRC, 'utf8');
    const grab = (name) => extractMethod(name);

    for (const [name, label] of [['createNewCanvas', 'new document'],
                                 ['resetHistoryBaseline', 'history re-baseline']]) {
        const body = grab(name);
        const releases = /_closeBitmapEntry|_releaseHistoryEntries/.test(body);
        const detaches = /this\.state\.history\s*=\s*\[\]/.test(body);
        check(`${label} detaches the history array`, detaches, name);
        check(`${label} does NOT release entries it may not own`, !releases,
            `${name} calls a release helper on a possibly-shared array`);
    }
}

console.log('\n== 11. history is budgeted by real bytes, not a worst-case guess ==');
{
    const MB = 1024 * 1024;
    const canvas = (w, h2) => ({ width: w, height: h2 });

    // A tiled entry costs what its tiles actually weigh, not what the canvas
    // would weigh — the assumption that produced an 8-step ceiling.
    const tiled = (bytes) => ({ tiles: [{ rle: new Uint8Array(bytes) }], width: 8000, height: 8000 });
    check('a tiled step costs its compressed size, not the canvas size',
        h._entryBytes(tiled(4096)) === 4096, String(h._entryBytes(tiled(4096))));

    check('a flat snapshot really does cost the whole canvas',
        h._entryBytes({ width: 100, height: 100 }) === 100 * 100 * 4);

    // Layered: only what this entry OWNS. A ref points at someone else's pixels,
    // and counting those twice would evict far too eagerly.
    const owned = { snaps: [{ snap: canvas(100, 100) }, { ref: {}, snap: null }] };
    check('a layered step ignores layers it shares by reference',
        h._entryBytes(owned) === 100 * 100 * 4, String(h._entryBytes(owned)));

    const masked = { snaps: [{ snap: canvas(10, 10), mask: { canvas: canvas(10, 10) } }] };
    check('an owned mask is counted too', h._entryBytes(masked) === 10 * 10 * 4 * 2);

    check('the byte budget is a sane size',
        h.historyByteBudget() >= 256 * MB && h.historyByteBudget() <= 2048 * MB,
        (h.historyByteBudget() / MB) + 'MB');
}

console.log('\n== 12. trimming honours bytes AND a floor on steps ==');
{
    // 40 full-canvas steps at 64 MB each; a 640 MB budget leaves room for 10,
    // comfortably above the floor, so the budget is what decides.
    const target = { history: Array.from({ length: 40 }, () => ({ width: 4000, height: 4000 })), step: 39 };
    const evicted = h._trimHistoryTarget(target, 500, 640 * 1024 * 1024);
    check('an oversized history is trimmed even when under the count limit',
        evicted > 0, String(evicted));
    check('what remains fits the byte budget',
        h.historyBytes(target) <= 640 * 1024 * 1024,
        (h.historyBytes(target) / 1048576) + 'MB');
    check('it keeps as much as the budget allows, not the bare minimum',
        target.history.length === 10, String(target.history.length));
    check('the cursor moved with it', target.step === 39 - evicted);

    // The floor outranks the budget: steps this big cannot all fit, and an
    // undo system that leaves you one step is worse than one that overruns.
    const huge = { history: Array.from({ length: 10 }, () => ({ width: 9000, height: 9000 })), step: 9 };
    h._trimHistoryTarget(huge, 500, 1024);
    check('never trims below the minimum number of steps',
        huge.history.length === 8, String(huge.history.length));

    // The whole point: cheap tiled steps survive in the hundreds.
    const cheap = { history: Array.from({ length: 400 }, () => ({ tiles: [{ rle: new Uint8Array(2048) }] })), step: 399 };
    const cut = h._trimHistoryTarget(cheap, 500, 256 * 1024 * 1024);
    check('hundreds of small steps are kept', cut === 0 && cheap.history.length === 400,
        String(cheap.history.length));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
