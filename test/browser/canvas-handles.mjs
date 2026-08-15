/* The canvas resize handles must sit on the canvas in every painted frame —
 * never trailing it, never parked somewhere else waiting to catch up.
 *
 * Two ways that used to go wrong:
 *
 *   Startup. The handles have no offsets of their own until JS measures the
 *   canvas, so they painted stacked in the viewport's top-left corner; and the
 *   easing armed by setTool() during init caught the initial centring, so the
 *   canvas snapped to the middle and the handles glided after it.
 *
 *   Panel slides. Opening a tool sidebar slides the canvas over a CSS
 *   transition. The handles used to jump to a PREDICTED end position and ease
 *   there on their own timer, which held up while a slide ran to completion and
 *   fell apart the moment a second toggle interrupted it — spamming a tool
 *   button left them a full 280px off the canvas.
 *
 * Both are first-few-frames problems, so both are measured frame by frame:
 * startup needs a recorder installed on a fresh document (hence reloadWith),
 * and the slide is sampled from a task queued off rAF, so the read lands after
 * every animation callback for the frame — what actually gets painted.
 * Sampling inside rAF instead races the app's own callback and reports a
 * one-frame lag that is not on screen.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

/* Runs before any app script. Free-canvas mode is the telling one for startup:
 * there the canvas is centred a couple of frames in, so the handles must move
 * with it. */
const RECORDER = `
(function () {
    try { localStorage.setItem('paint.anchorCanvas', 'false'); } catch (e) {}
    window.__hlog = [];
    const t0 = performance.now();
    function sample() {
        const stage = document.getElementById('canvas-stage');
        const hc = document.getElementById('canvas-resize-handles');
        const c = document.querySelector('.resizer.r-corner');
        if (stage && hc && c) {
            const s = stage.getBoundingClientRect();
            const cr = c.getBoundingClientRect();
            window.__hlog.push({
                t: Math.round(performance.now() - t0),
                visible: getComputedStyle(hc).visibility === 'visible',
                // The corner handle sits on the canvas's bottom-right corner.
                dx: Math.round(cr.left - s.right),
                dy: Math.round(cr.top - s.bottom)
            });
        }
        if (performance.now() - t0 < 2000) requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
})();
`;

const describe = (frames) => frames.length
    ? `${frames.length} frames, worst ${JSON.stringify(frames.reduce((a, b) =>
        Math.abs(b.dx) + Math.abs(b.dy || 0) > Math.abs(a.dx) + Math.abs(a.dy || 0) ? b : a))}`
    : '';

await withPage(async (page) => {
    console.log('\n== 1. startup ==');
    await page.reloadWith(RECORDER);
    await new Promise(r => setTimeout(r, 2200));

    const log = await page.eval('window.__hlog');
    check('the startup frames were recorded', log.length > 30, log.length + ' frames');

    const shown = log.filter(e => e.visible);
    check('the handles do become visible', shown.length > 0);
    check('and are never drawn away from the canvas',
        shown.every(e => Math.abs(e.dx) <= 1 && Math.abs(e.dy) <= 1),
        describe(shown.filter(e => Math.abs(e.dx) > 1 || Math.abs(e.dy) > 1)));
    check('startup is marked settled once it is over',
        (await page.eval('PaintApp._startupSettled')) === true);

    console.log('\n== 2. a sidebar sliding the canvas ==');
    // The shift only applies in anchored mode, which is also the default.
    await page.run(`PaintApp.toggleAnchorCanvas(true); return 1;`);
    await new Promise(r => setTimeout(r, 500));

    const startSampler = () => page.run(`
        window.__log = [];
        const t0 = performance.now();
        (function schedule() {
            requestAnimationFrame(() => setTimeout(() => {
                const s = document.getElementById('canvas-stage').getBoundingClientRect();
                const c = document.querySelector('.resizer.r-corner').getBoundingClientRect();
                window.__log.push({
                    stageR: Math.round(s.right),
                    dx: Math.round(c.left - s.right),
                    dy: Math.round(c.top - s.bottom)
                });
                if (performance.now() - t0 < 5000) schedule();
            }, 0));
        })();
        return 1;
    `);
    // Frames where the canvas actually moved are the ones that prove anything.
    const moved = (l) => l.filter((e, i) => i > 0 && l[i - 1].stageR !== e.stageR).length;

    await startSampler();
    await page.run(`PaintApp.setTool('freehand'); return 1;`);
    await new Promise(r => setTimeout(r, 700));
    await page.run(`PaintApp.setTool('pencil'); return 1;`);
    await new Promise(r => setTimeout(r, 700));
    let slide = await page.eval('window.__log');
    check('one open/close does slide the canvas', moved(slide) > 10, moved(slide) + ' moving frames');
    check('and the handles ride along with it',
        slide.every(e => Math.abs(e.dx) <= 1 && Math.abs(e.dy) <= 1),
        describe(slide.filter(e => Math.abs(e.dx) > 1 || Math.abs(e.dy) > 1)));

    // Spamming the tool button interrupts each slide partway through.
    await startSampler();
    for (let i = 0; i < 8; i++) {
        await page.run(`PaintApp.setTool('${i % 2 ? 'pencil' : 'freehand'}'); return 1;`);
        await new Promise(r => setTimeout(r, 90));
    }
    await new Promise(r => setTimeout(r, 1500));
    const burst = await page.eval('window.__log');
    check('spamming it keeps the canvas moving', moved(burst) > 30, moved(burst) + ' moving frames');
    check('and the handles stay on the canvas throughout',
        burst.every(e => Math.abs(e.dx) <= 1 && Math.abs(e.dy) <= 1),
        describe(burst.filter(e => Math.abs(e.dx) > 1 || Math.abs(e.dy) > 1)));
    check('with nothing left drifting once it stops',
        burst.slice(-10).every(e => e.dx === 0 && e.dy === 0),
        JSON.stringify(burst.slice(-3)));

    const errs = page.errors();
    console.log(`\npage errors: ${errs.length}`);
    for (const e of errs.slice(0, 5)) console.log('  ! ' + e.text.split('\n')[0]);
    console.log(`\n${pass} passed, ${fail} failed`);
});

process.exit(fail ? 1 : 0);
