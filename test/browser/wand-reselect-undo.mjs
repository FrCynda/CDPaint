/* Two wand selections in a row, then undo twice.
 *
 * Repro: on a transparent layer, fill white, draw a black circle, wand-select
 * the circle, then wand-select the white area instead. Each wand click is a
 * distinct, visible action the user chose to make, so each one must be its
 * own undo step: ONE undo should bring back the circle selection (not jump
 * straight past it to the pre-selection document), and a SECOND undo should
 * then restore the document to before any selection was made.
 *
 * (An earlier version of this test asserted the opposite — that one undo
 * should collapse both selections into a single step. That was itself a fix
 * for a different complaint, but it meant re-selecting repeatedly made undo
 * skip over every earlier selection at once instead of stepping back through
 * them one click at a time, which is the bug this version guards against.)
 *
 * A wand selection lifts the matched pixels off the canvas, leaving a hole,
 * and records that as a history entry (state.selectionCutStep). Only when a
 * selection is actually FINALIZED unchanged (e.g. commitSelection() with no
 * edits) should its scaffolding cut-step collapse into one net undo step —
 * replacing it with a brand new selection must not.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

const BLACK = '0,0,0,255';
const WHITE = '255,255,255,255';

await withPage(async (page) => {
    await page.run(`
        window.__q = {
            setup: () => {
                PaintApp.layerMgr.collapseToBase({ fresh: true });
                PaintApp.setSize(200, 200);
                PaintApp.ctx.fillStyle = '#ffffff';
                PaintApp.ctx.fillRect(0, 0, 200, 200);
                PaintApp.state.history = []; PaintApp.state.step = -1;
                PaintApp.saveState();
                // A transparent layer above it, per the report.
                document.getElementById('lsys-add').click();
                const L = PaintApp.layerMgr.layers[PaintApp.layerMgr.activeIdx];
                // Fill it white, then a black circle in the middle.
                PaintApp.ctx.fillStyle = '#ffffff';
                PaintApp.ctx.fillRect(0, 0, 200, 200);
                PaintApp.saveState();
                PaintApp.ctx.fillStyle = '#000000';
                PaintApp.ctx.beginPath();
                PaintApp.ctx.arc(100, 100, 40, 0, Math.PI * 2);
                PaintApp.ctx.fill();
                PaintApp.saveState();
                return L;
            },
            px: (x, y) => {
                const d = PaintApp.ctx.getImageData(x, y, 1, 1).data;
                return [d[0], d[1], d[2], d[3]].join(',');
            },
            hash: () => {
                const d = PaintApp.ctx.getImageData(0, 0, 200, 200).data;
                let a = 0x811c9dc5;
                for (let i = 0; i < d.length; i++) a = ((a ^ d[i]) * 16777619) >>> 0;
                return a.toString(16);
            },
            wand: (x, y) => {
                PaintApp.config.tool = 'wand';
                PaintApp.magicWandSelect(x, y, 0, 'replace', null, true);
            }
        };
        return true;
    `);

    console.log('== wand, re-wand, undo x2 ==');
    const r = await page.eval(`(() => {
        __q.setup();
        const out = {};
        out.circleBefore = __q.px(100, 100);
        out.fillBefore   = __q.px(20, 20);
        const clean = __q.hash();

        __q.wand(100, 100);                 // select the black circle
        out.stepAfterFirst = PaintApp.state.step;
        const afterFirstSelect = __q.hash();

        __q.wand(20, 20);                   // now select the white area instead
        out.stepAfterSecond = PaintApp.state.step;

        // First undo: should land back on "circle selected", not skip past it.
        PaintApp.undo();
        out.stepAfter1Undo = PaintApp.state.step;
        out.restoredFirstSelectIn1Undo = __q.hash() === afterFirstSelect;

        // Second undo: NOW it should restore the pre-selection document.
        PaintApp.undo();
        PaintApp.commitSelection && PaintApp.commitSelection();
        out.circleAfter2Undo = __q.px(100, 100);
        out.restoredIn2      = __q.hash() === clean;
        return JSON.stringify(out);
    })()`);

    const o = JSON.parse(r);
    console.log('  ' + JSON.stringify(o, null, 1).replace(/\n/g, '\n  '));

    check('starts with a black circle', o.circleBefore === BLACK, o.circleBefore);
    check('starts with a white fill', o.fillBefore === WHITE, o.fillBefore);
    check('each wand click is its own history step',
        o.stepAfterSecond === o.stepAfterFirst + 1, `first ${o.stepAfterFirst}, second ${o.stepAfterSecond}`);
    check('ONE undo restores the first (circle) selection, not the pre-selection document',
        o.stepAfter1Undo === o.stepAfterFirst && o.restoredFirstSelectIn1Undo,
        `step ${o.stepAfter1Undo} (expected ${o.stepAfterFirst}), matched=${o.restoredFirstSelectIn1Undo}`);
    check('a SECOND undo restores the pre-selection document', o.restoredIn2,
        'document was not fully restored after the second undo');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
