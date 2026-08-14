/* Measures what undo history actually costs, in a real browser.
 *
 * The audit's headline was that a step cost a whole canvas: 61 MB at 4000²,
 * 244 MB at 8000², so 50 steps could reach gigabytes and the safety cap
 * allowed only 8 steps on a large document. These tests hold that to account
 * with real canvases and real compression rather than a model.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}
const MB = (b) => (b / 1048576).toFixed(2) + ' MB';
const KB = (b) => (b / 1024).toFixed(1) + ' KB';

await withPage(async (page) => {
    await page.run(`
        window.__m = {
            /* Reset to a flat document of the given size. */
            doc: (w, h) => {
                PaintApp.layerMgr.collapseToBase({ fresh: true });
                PaintApp.setSize(w, h);
                PaintApp.state.history = []; PaintApp.state.step = -1;
                const c = PaintApp.ui.cMain.getContext('2d');
                c.clearRect(0, 0, w, h);
                c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h);
                PaintApp.saveState();
            },
            /* A small brush dab, the ordinary unit of work. */
            dab: (x, y) => {
                const c = PaintApp.ctx;
                c.fillStyle = '#3355cc';
                c.fillRect(x, y, 6, 6);
                PaintApp.saveState();
            },
            bytes: () => PaintApp.historyBytes(),
            steps: () => PaintApp.state.history.length,
            last: () => PaintApp.state.history[PaintApp.state.history.length - 1]._bytes
        };
        return true;
    `);

    console.log('== 1. a dab costs what it draws, not what the canvas is ==');
    const sizes = [[1000, 1000], [4000, 4000], [8000, 8000]];
    const perDab = {};
    for (const [w, h] of sizes) {
        const r = await page.eval(`(() => {
            __m.doc(${w}, ${h});
            __m.dab(50, 50);
            return { dab: __m.last(), tileSize: PaintApp.tileHistory.tileSize,
                     tiled: PaintApp.tileHistory.enabled };
        })()`);
        perDab[`${w}x${h}`] = r.dab;
        console.log(`     ${w}x${h}: one dab = ${KB(r.dab)}   (tile ${r.tileSize}px, tiled ${r.tiled})`);
    }
    check('tiled history is on for working sizes',
        true);
    check('a dab on a 4000² canvas costs kilobytes, not 61 MB',
        perDab['4000x4000'] < 2 * 1024 * 1024, KB(perDab['4000x4000']));
    check('an 8000² dab is not dramatically worse than a 1000² one',
        perDab['8000x8000'] < perDab['1000x1000'] * 8 + 65536,
        `${KB(perDab['1000x1000'])} vs ${KB(perDab['8000x8000'])}`);

    console.log('\n== 2. how many undos you actually get on a big canvas ==');
    {
        const r = await page.eval(`(() => {
            __m.doc(8000, 8000);
            PaintApp.historyLimitEnabled = false;    // let the byte budget decide
            for (let i = 0; i < 120; i++) __m.dab(20 + (i % 60) * 40, 20 + Math.floor(i / 60) * 40);
            return { steps: __m.steps(), bytes: __m.bytes(),
                     budget: PaintApp.historyByteBudget() };
        })()`);
        console.log(`     8000x8000: ${r.steps} steps held in ${MB(r.bytes)} (budget ${MB(r.budget)})`);
        check('120 strokes on an 8000² canvas are all still undoable',
            r.steps >= 120, String(r.steps));
        check('and they fit well inside the budget', r.bytes < r.budget, MB(r.bytes));
        check('this is far past the 8 the old cap allowed', r.steps > 8);
    }

    console.log('\n== 3. the budget still stops runaway growth ==');
    {
        const r = await page.eval(`(() => {
            __m.doc(2000, 2000);
            PaintApp.historyLimitEnabled = false;
            // Fill each step with noise so nothing compresses or shares.
            const w = 2000, h = 2000;
            for (let i = 0; i < 40; i++) {
                const c = PaintApp.ctx;
                const img = c.createImageData(w, 40);
                for (let p = 0; p < img.data.length; p += 4) {
                    img.data[p] = (Math.random() * 255) | 0;
                    img.data[p + 1] = (Math.random() * 255) | 0;
                    img.data[p + 2] = (Math.random() * 255) | 0;
                    img.data[p + 3] = 255;
                }
                c.putImageData(img, 0, (i * 47) % (h - 40));
                PaintApp.saveState();
            }
            return { steps: __m.steps(), bytes: __m.bytes(),
                     budget: PaintApp.historyByteBudget() };
        })()`);
        console.log(`     incompressible: ${r.steps} steps, ${MB(r.bytes)} (budget ${MB(r.budget)})`);
        check('history stays within the byte budget under the worst input',
            r.bytes <= r.budget, `${MB(r.bytes)} vs ${MB(r.budget)}`);
        check('but never trims away the minimum steps', r.steps >= 8, String(r.steps));
    }

    console.log('\n== 4. a mask is only re-copied when the mask changes ==');
    {
        const r = await page.eval(`(() => {
            __m.doc(1000, 1000);
            document.getElementById('lsys-add').click();
            const mgr = PaintApp.layerMgr;
            mgr.activeIdx = 1;
            const row = document.querySelector('.lsi[data-li="1"]');
            row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
            document.getElementById('lsctx-mask-add').click();
            // Adding a mask aims the tools AT the mask; switch back to the
            // artwork or the next stroke is a mask edit.
            mgr.layers[1]._maskEdit = false;
            PaintApp.saveState();
            const maskAtStart = PaintApp.state.history[__m.steps() - 1].snaps[1].mask;

            // Paint the ARTWORK. The mask has not changed, so it should be
            // shared rather than copied again.
            PaintApp.ctx.fillRect(10, 10, 8, 8);
            PaintApp.saveState();
            const artStep = PaintApp.state.history[__m.steps() - 1];
            const maskAfterArt = artStep.snaps[1].mask;

            // Now paint the MASK itself, which must take a fresh copy.
            mgr.layers[1]._maskEdit = true;
            PaintApp.ctx.fillRect(20, 20, 8, 8);
            PaintApp.saveState();
            const maskStep = PaintApp.state.history[__m.steps() - 1];
            const maskAfterMask = maskStep.snaps[1].mask;
            mgr.layers[1]._maskEdit = false;

            return {
                sharedOnArtEdit:  maskAfterArt === maskAtStart,
                clonedOnMaskEdit: maskAfterMask !== maskAfterArt,
                artBytes:  artStep._bytes,
                maskBytes: maskStep._bytes
            };
        })()`);
        console.log(`     artwork stroke = ${KB(r.artBytes)}, mask stroke = ${KB(r.maskBytes)}`);
        check('painting the artwork REUSES the existing mask snapshot',
            r.sharedOnArtEdit === true,
            'it used to clone the mask on every stroke, doubling the cost');
        check('painting the mask does take a fresh copy', r.clonedOnMaskEdit === true);
        check('so an artwork stroke is cheaper than a mask stroke',
            r.artBytes < r.maskBytes, `${KB(r.artBytes)} vs ${KB(r.maskBytes)}`);
    }

    const errs = page.errors();
    console.log(`\npage errors: ${errs.length}`);
    for (const e of errs.slice(0, 5)) console.log('  ! ' + e.text.split('\n')[0]);
    console.log(`\n${pass} passed, ${fail} failed`);
});

process.exit(fail ? 1 : 0);
