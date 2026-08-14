/* What happens between letting go of the mouse and the app responding.
 *
 * Capturing the undo step is fast now. The cost that replaced it was the
 * colour counter: it reads the entire canvas back to work out how many colours
 * are in use — 676 MB and ~140 ms at 13000x13000 — and it ran after every
 * stroke. It is a status-bar number, so it does not need to keep up with the
 * brush.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

await withPage(async (page) => {
    await page.run(`
        window.__s = {
            doc: (w, h) => {
                PaintApp.layerMgr.collapseToBase({ fresh: true });
                PaintApp.setSize(w, h);
                const c = PaintApp.ctx;
                c.fillStyle = '#fff'; c.fillRect(0, 0, w, h);
                PaintApp.state.history = []; PaintApp.state.step = -1;
                PaintApp.state.isDrawing = false;
                PaintApp._colorCountTimer = null;
                PaintApp._colorCountPending = false;
                PaintApp._colorCountLastAt = performance.now();
                PaintApp.saveState();
            },
            stroke: () => {
                const t0 = performance.now();
                PaintApp.ctx.fillRect(60, 60, 8, 8);
                PaintApp.saveState();
                return performance.now() - t0;
            }
        };
        return true;
    `);

    console.log('== 1. the recount backs off as the canvas gets bigger ==');
    {
        const r = await page.eval(`(() => {
            const out = {};
            for (const [w, h] of [[500, 500], [2000, 2000], [8000, 8000], [13000, 13000]]) {
                PaintApp.config.width = w; PaintApp.config.height = h;
                out[w] = PaintApp.colorCountIntervalMs();
            }
            return out;
        })()`);
        console.log(`     500:${r[500]}ms  2000:${r[2000]}ms  8000:${r[8000]}ms  13000:${r[13000]}ms`);
        check('a small canvas keeps the responsive interval', r[500] <= 200, String(r[500]));
        check('the interval grows with canvas size',
            r[2000] > r[500] && r[8000] > r[2000] && r[13000] > r[8000],
            JSON.stringify(r));
        check('a huge canvas waits at least a second', r[13000] >= 1000, String(r[13000]));
    }

    console.log('\n== 2. it never runs while a stroke is in progress ==');
    {
        const r = await page.eval(`(() => {
            __s.doc(2000, 2000);
            let ran = 0;
            const real = PaintApp.updateColorCounts.bind(PaintApp);
            PaintApp.updateColorCounts = () => { ran++; };
            PaintApp.state.isDrawing = true;
            PaintApp._colorCountLastAt = 0;          // interval already elapsed
            for (let i = 0; i < 5; i++) PaintApp.deferColorCounts();
            const duringStroke = ran;
            PaintApp.state.isDrawing = false;
            PaintApp.updateColorCounts = real;
            return { duringStroke, pending: !!PaintApp._colorCountTimer };
        })()`);
        check('nothing is counted mid-stroke', r.duringStroke === 0, String(r.duringStroke));
        check('but it is queued to run once the stroke ends', r.pending === true);
    }

    console.log('\n== 3. finishing a stroke on a huge canvas returns control quickly ==');
    {
        const r = await page.eval(`(() => {
            __s.doc(13000, 13000);
            // Ten strokes back to back, as fast as a hand could manage.
            const times = [];
            for (let i = 0; i < 10; i++) times.push(__s.stroke());
            times.sort((a, b) => a - b);
            return { median: times[5], worst: times[9],
                     total: times.reduce((a, b) => a + b, 0) };
        })()`);
        console.log(`     median ${r.median.toFixed(1)} ms, worst ${r.worst.toFixed(1)} ms per stroke`);
        check('a stroke on a 13000px canvas finishes in a few milliseconds',
            r.median < 20, r.median.toFixed(1) + ' ms');
        check('no stroke stalls for anything like the old 140 ms recount',
            r.worst < 60, r.worst.toFixed(1) + ' ms');
    }

    console.log('\n== 4. it still counts, once things go quiet ==');
    {
        const r = await page.eval(`(async () => {
            __s.doc(500, 500);   // small, so the interval is short
            let ran = 0;
            const real = PaintApp.updateColorCounts.bind(PaintApp);
            PaintApp.updateColorCounts = () => { ran++; real(); };
            PaintApp._colorCountLastAt = 0;
            PaintApp.deferColorCounts();
            await new Promise(r => setTimeout(r, 600));
            PaintApp.updateColorCounts = real;
            return ran;
        })()`);
        check('the count still happens when the user stops drawing', r >= 1, String(r));
    }

    const errs = page.errors();
    console.log(`\npage errors: ${errs.length}`);
    for (const e of errs.slice(0, 5)) console.log('  ! ' + e.text.split('\n')[0]);
    console.log(`\n${pass} passed, ${fail} failed`);
});

process.exit(fail ? 1 : 0);
