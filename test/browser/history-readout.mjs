/* The undo-history readout, in a real browser.
 *
 * It replaces the old "Adaptive" checkbox, which set the step count from
 * canvas size on the assumption that a step cost a whole canvas. Once history
 * was budgeted by measured bytes that number stopped moving — it read 10,000
 * at 64x64 and at 13000x13000 alike — so it told you nothing. The readout
 * shows the quantity that actually governs.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

await withPage(async (page) => {
    await page.run(`
        window.__h = {
            text: () => (document.getElementById('history-usage') || {}).textContent || '',
            cls:  () => (document.getElementById('history-usage') || {}).className || '',
            doc: (w, h) => {
                PaintApp.layerMgr.collapseToBase({ fresh: true });
                PaintApp.setSize(w, h);
                PaintApp.state.history = []; PaintApp.state.step = -1;
                const c = PaintApp.ui.cMain.getContext('2d');
                c.clearRect(0, 0, w, h);
                c.fillStyle = '#fff'; c.fillRect(0, 0, w, h);
                PaintApp.saveState();
                PaintApp.updateHistoryUsage();
            },
            dab: (x, y) => {
                const c = PaintApp.ctx;
                c.fillStyle = '#3355cc'; c.fillRect(x, y, 6, 6);
                PaintApp.saveState();
            }
        };
        return true;
    `);

    console.log('== 1. the retired control is gone, the readout is present ==');
    {
        const r = await page.eval(`({
            adaptiveGone: !document.getElementById('history-limit-adaptive'),
            readout: !!document.getElementById('history-usage'),
            limitInput: !!document.getElementById('history-limit-input'),
            limitToggle: !!document.getElementById('history-limit-toggle')
        })`);
        check('the Adaptive checkbox is gone', r.adaptiveGone);
        check('the usage readout exists', r.readout);
        check('the step limit and its toggle are still there',
            r.limitInput && r.limitToggle);
    }

    console.log('\n== 2. it reports steps and memory, and tracks both ==');
    {
        const r = await page.eval(`(() => {
            __h.doc(1000, 1000);
            const start = __h.text();
            for (let i = 0; i < 25; i++) __h.dab(20 + (i % 10) * 40, 20 + Math.floor(i / 10) * 40);
            PaintApp.updateHistoryUsage();
            return { start, after: __h.text(),
                     steps: PaintApp.state.history.length,
                     bytes: PaintApp.historyBytes() };
        })()`);
        console.log(`     "${r.after}"`);
        check('it names a step count', /\d+ held/.test(r.after), r.after);
        check('it names a size against a budget', / of .*(KB|MB|GB)/.test(r.after), r.after);
        check('it reflects the real step count',
            r.after.startsWith(r.steps.toLocaleString()), `${r.steps} vs "${r.after}"`);
        check('it changed as history grew', r.after !== r.start);
    }

    console.log('\n== 3. it varies with canvas size, which is what the old one failed to do ==');
    {
        // Both of these are above the 200x200 threshold, so both use tiled
        // history. Comparing a tiled document against a flat one would only be
        // comparing two different storage strategies.
        const readings = {};
        for (const [w, h] of [[1000, 1000], [8000, 8000]]) {
            readings[`${w}x${h}`] = await page.eval(`(() => {
                __h.doc(${w}, ${h});
                for (let i = 0; i < 10; i++) __h.dab(10 + i * 3, 10);
                PaintApp.updateHistoryUsage();
                return { text: __h.text(), bytes: PaintApp.historyBytes(),
                         tiled: PaintApp.tileHistory.enabled,
                         limit: PaintApp.historyLimit };
            })()`);
        }
        const small = readings['1000x1000'], big = readings['8000x8000'];
        console.log(`     1000x1000  "${small.text}"`);
        console.log(`     8000x8000  "${big.text}"`);
        check('both documents are on the tiled path', small.tiled && big.tiled);
        check('the same work costs more on a bigger canvas, and it shows',
            big.bytes > small.bytes * 4, `${small.bytes} vs ${big.bytes}`);
        check('the step limit itself no longer varies by canvas size',
            small.limit === big.limit, `${small.limit} vs ${big.limit}`);
    }

    console.log('\n== 4. it warns as the budget fills ==');
    {
        const r = await page.eval(`(() => {
            __h.doc(500, 500);
            // Drive the ratio directly rather than allocating gigabytes.
            const realBudget = PaintApp.historyByteBudget.bind(PaintApp);
            const out = {};
            PaintApp.historyByteBudget = () => PaintApp.historyBytes() / 0.3;
            PaintApp.updateHistoryUsage(); out.low = __h.cls();
            PaintApp.historyByteBudget = () => PaintApp.historyBytes() / 0.7;
            PaintApp.updateHistoryUsage(); out.high = __h.cls();
            PaintApp.historyByteBudget = () => PaintApp.historyBytes() / 0.95;
            PaintApp.updateHistoryUsage(); out.full = __h.cls();
            PaintApp.historyByteBudget = realBudget;
            PaintApp.updateHistoryUsage();
            return out;
        })()`);
        check('quiet when there is plenty of room',
            !/is-high|is-full/.test(r.low), r.low);
        check('marked when it is getting full', /is-high/.test(r.high), r.high);
        check('marked differently when nearly full',
            /is-full/.test(r.full) && !/is-high/.test(r.full), r.full);
    }

    const errs = page.errors();
    console.log(`\npage errors: ${errs.length}`);
    for (const e of errs.slice(0, 5)) console.log('  ! ' + e.text.split('\n')[0]);
    console.log(`\n${pass} passed, ${fail} failed`);
});

process.exit(fail ? 1 : 0);
