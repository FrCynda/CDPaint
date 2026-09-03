/* Does undo put back EXACTLY the right pixels?
 *
 * A history step no longer stores the whole picture — it stores only the tiles
 * it changed plus a link to the step before, with a full snapshot every 20th
 * step to bound how far a restore walks back. That is a large saving and a
 * genuinely dangerous change: if a chain is broken, undo silently restores the
 * wrong image. Nothing else in the suite would notice.
 *
 * So these tests fingerprint the canvas after every step, then undo back
 * through the whole history and require each fingerprint to match exactly.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

await withPage(async (page) => {
    await page.run(`
        window.__f = {
            doc: (w, h) => {
                PaintApp.layerMgr.collapseToBase({ fresh: true });
                PaintApp.setSize(w, h);
                PaintApp.state.history = []; PaintApp.state.step = -1;
                const c = PaintApp.ui.cMain.getContext('2d');
                c.clearRect(0, 0, w, h);
                c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h);
                PaintApp.saveState();
            },
            /* Cheap order-sensitive fingerprint of the whole canvas. */
            hash: () => {
                const w = PaintApp.config.width, h = PaintApp.config.height;
                const d = PaintApp.ui.cMain.getContext('2d').getImageData(0, 0, w, h).data;
                let a = 0x811c9dc5, b = 0;
                for (let i = 0; i < d.length; i += 4) {
                    const v = (d[i] << 24) ^ (d[i + 1] << 16) ^ (d[i + 2] << 8) ^ d[i + 3];
                    a = ((a ^ v) * 16777619) >>> 0;
                    b = (b + a) >>> 0;
                }
                return a.toString(16) + ':' + b.toString(16);
            },
            /* A mark whose colour and position are unique to the step index. */
            mark: (i) => {
                const c = PaintApp.ctx;
                c.fillStyle = 'rgb(' + (i * 7 % 256) + ',' + (i * 13 % 256) + ',' + (i * 29 % 256) + ')';
                c.fillRect((i * 11) % 300, (i * 17) % 200, 9, 9);
                PaintApp.saveState();
            },
            chains: () => PaintApp.state.history.map(e => e.base ? (e._chain || 0) : 0),
            anchors: () => PaintApp.state.history.filter(e => e.tiles && !e.base).length,
            tilesHeld: () => PaintApp.state.history.map(e => e.tiles ? e.tiles.length : -1)
        };
        return true;
    `);

    console.log('== 1. deltas and anchors are actually being produced ==');
    {
        const r = await page.eval(`(() => {
            __f.doc(1000, 1000);
            for (let i = 1; i <= 50; i++) __f.mark(i);
            return { anchors: __f.anchors(), steps: PaintApp.state.history.length,
                     held: __f.tilesHeld(), maxChain: Math.max(...__f.chains()) };
        })()`);
        check('most steps are deltas, not full snapshots',
            r.anchors < r.steps / 4, `${r.anchors} anchors in ${r.steps} steps`);
        check('anchors still appear, bounding the walk back',
            r.anchors >= 2, String(r.anchors));
        check('no chain is longer than the anchor interval',
            r.maxChain < 20, String(r.maxChain));
        // 1000x1000 at 128px tiles is 64 tiles; a delta should hold a handful.
        const deltas = r.held.filter(n => n > 0 && n < 64);
        check('a delta holds only the tiles it touched',
            deltas.length > 30, `${deltas.length} small entries of ${r.steps}`);
    }

    console.log('\n== 2. undoing all the way back reproduces every step exactly ==');
    {
        const r = await page.eval(`(() => {
            __f.doc(1000, 1000);
            const seen = [__f.hash()];
            for (let i = 1; i <= 60; i++) { __f.mark(i); seen.push(__f.hash()); }
            // Walk back to the very beginning, comparing at each step.
            const bad = [];
            for (let i = seen.length - 2; i >= 0; i--) {
                PaintApp.undo();
                const got = __f.hash();
                if (got !== seen[i]) bad.push({ step: i, want: seen[i], got });
            }
            return { total: seen.length, bad: bad.slice(0, 5), badCount: bad.length };
        })()`);
        check('every one of 60 undos restores the exact picture',
            r.badCount === 0, `${r.badCount} of ${r.total} wrong: ${JSON.stringify(r.bad)}`);
    }

    console.log('\n== 3. redo forward is exact too ==');
    {
        const r = await page.eval(`(() => {
            __f.doc(1000, 1000);
            const seen = [__f.hash()];
            for (let i = 1; i <= 45; i++) { __f.mark(i); seen.push(__f.hash()); }
            for (let i = 0; i < 45; i++) PaintApp.undo();
            const bad = [];
            for (let i = 1; i < seen.length; i++) {
                PaintApp.redo();
                const got = __f.hash();
                if (got !== seen[i]) bad.push(i);
            }
            return { badCount: bad.length, first: bad.slice(0, 5) };
        })()`);
        check('every redo restores the exact picture',
            r.badCount === 0, `${r.badCount} wrong at ${JSON.stringify(r.first)}`);
    }

    console.log('\n== 4. THE DANGEROUS ONE: undo still works after old steps are dropped ==');
    {
        const r = await page.eval(`(() => {
            __f.doc(1000, 1000);
            // A small ceiling forces eviction from the front while chains are live.
            PaintApp.historyLimitEnabled = true;
            PaintApp.historyLimit = 12;
            const seen = [];
            for (let i = 1; i <= 60; i++) { __f.mark(i); seen.push(__f.hash()); }
            const kept = PaintApp.state.history.length;
            const live = new Set(PaintApp.state.history);
            // A dropped step stays alive as long as a survivor links to it, so
            // failing to flatten here does not corrupt the picture — it quietly
            // keeps the entire history in memory while reporting it as freed.
            // That is why this is checked structurally and not only by pixels.
            const oldestIsAnchor = !PaintApp.state.history[0].base;
            let reachesDropped = false;
            for (const e of PaintApp.state.history) {
                for (let b = e.base; b; b = b.base) {
                    if (!live.has(b)) { reachesDropped = true; break; }
                }
            }
            const bad = [];
            for (let k = 1; k < kept; k++) {
                PaintApp.undo();
                const want = seen[seen.length - 1 - k];
                if (__f.hash() !== want) bad.push(k);
            }
            return { kept, oldestIsAnchor, reachesDropped,
                     badCount: bad.length, first: bad.slice(0, 5) };
        })()`);
        check('the oldest surviving step was flattened when its base was dropped',
            r.oldestIsAnchor === true);
        check('no surviving step still points at a dropped one',
            r.reachesDropped === false,
            'a lingering link keeps the whole evicted chain in memory');
        check('undoing back to the oldest kept step is still exact',
            r.badCount === 0, `${r.badCount} wrong at ${JSON.stringify(r.first)}`);
    }

    console.log('\n== 5. removing a step from the middle keeps the rest intact ==');
    {
        const r = await page.eval(`(() => {
            __f.doc(800, 800);
            const seen = [__f.hash()];
            for (let i = 1; i <= 12; i++) { __f.mark(i); seen.push(__f.hash()); }
            const finalHash = __f.hash();
            // This is what a selection cut does: drop one entry from the middle.
            PaintApp.state.selectionCutStep = 5;
            PaintApp.collapseSelectionCutStep();
            const afterRemoval = __f.hash();
            // The steps after the removed one must still restore correctly.
            PaintApp.undo();
            const oneBack = __f.hash();
            PaintApp.redo();
            return {
                canvasUntouched: afterRemoval === finalHash,
                undoWorks: oneBack === seen[seen.length - 2],
                backToEnd: __f.hash() === finalHash,
                steps: PaintApp.state.history.length
            };
        })()`);
        check('removing a middle step does not disturb the canvas', r.canvasUntouched);
        check('undo past the removal is still exact', r.undoWorks);
        check('and redo returns to where it was', r.backToEnd);
    }

    console.log('\n== 6. what it saved ==');
    {
        const r = await page.eval(`(() => {
            __f.doc(13000, 13000);
            const before = PaintApp.historyBytes();
            for (let i = 1; i <= 10; i++) __f.mark(i);
            return { bytes: PaintApp.historyBytes(), steps: PaintApp.state.history.length,
                     perStep: (PaintApp.historyBytes() - before) / 10,
                     tiles: PaintApp.state.history[PaintApp.state.history.length - 1].tiles.length };
        })()`);
        console.log(`     13000x13000: ${(r.perStep / 1024).toFixed(1)} KB per step, last step held ${r.tiles} tiles`);
        check('a step on a 13000px canvas now costs well under the old 81 KB floor',
            r.perStep < 20 * 1024, (r.perStep / 1024).toFixed(1) + ' KB');
    }

    const errs = page.errors();
    console.log(`\npage errors: ${errs.length}`);
    for (const e of errs.slice(0, 6)) console.log('  ! ' + e.text.split('\n')[0]);
    console.log(`\n${pass} passed, ${fail} failed`);
});

process.exit(fail ? 1 : 0);
