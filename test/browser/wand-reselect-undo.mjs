/* Two wand selections in a row, then one undo.
 *
 * Repro: on a transparent layer, fill white, draw a black circle, wand-select
 * the circle, then wand-select the white area instead. One undo should put the
 * document back the way it was — instead the circle is gone, and it takes a
 * SECOND undo to bring it back.
 *
 * A wand selection lifts the matched pixels off the canvas, leaving a hole, and
 * records that as a history entry (state.selectionCutStep). Committing the
 * selection is supposed to collapse that entry away again, so the lift and the
 * put-back are one step rather than two. When a second wand selection replaces
 * the first, the first one's cut step has to be collapsed too — otherwise undo
 * lands on the intermediate "circle lifted, hole left behind" state.
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

    console.log('== wand, re-wand, undo ==');
    const r = await page.eval(`(() => {
        __q.setup();
        const out = {};
        out.circleBefore = __q.px(100, 100);
        out.fillBefore   = __q.px(20, 20);
        const clean = __q.hash();

        __q.wand(100, 100);                 // select the black circle
        out.cutStepAfterFirst = PaintApp.state.selectionCutStep;
        out.stepAfterFirst    = PaintApp.state.step;

        __q.wand(20, 20);                   // now select the white area instead
        out.cutStepAfterSecond = PaintApp.state.selectionCutStep;
        out.stepAfterSecond    = PaintApp.state.step;

        PaintApp.undo();
        PaintApp.commitSelection && PaintApp.commitSelection();
        out.circleAfter1Undo = __q.px(100, 100);
        out.fillAfter1Undo   = __q.px(20, 20);
        out.restoredIn1      = __q.hash() === clean;

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
    check('the first wand cut step is collapsed when the second selection replaces it',
        o.cutStepAfterSecond === null || o.cutStepAfterSecond === o.stepAfterSecond,
        `cutStep ${o.cutStepAfterSecond}, step ${o.stepAfterSecond}`);
    check('ONE undo brings the circle back', o.circleAfter1Undo === BLACK,
        `got ${o.circleAfter1Undo} — the circle was left lifted`);
    check('ONE undo restores the whole document', o.restoredIn1,
        'needed a second undo');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
