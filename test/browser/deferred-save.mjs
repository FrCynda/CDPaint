/* Recording an undo step no longer happens between one stroke and the next.
 *
 * The read that records a step waits for whatever was just painted to finish
 * on the GPU. After a fat brush stroke that is most of half a second, and
 * nothing else can happen meanwhile — the end of the stroke cannot appear and
 * a second stroke cannot start drawing.
 *
 * It is now recorded a moment later instead. The danger is obvious: if
 * anything changes the canvas before the record is written, that step would
 * describe the wrong pixels, or two strokes would collapse into one undo. So
 * every path that touches pixels or history settles it first, and these tests
 * try hard to break that.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

await withPage(async (page) => {
    await page.run(`
        window.__q = {
            doc: (w, h, width) => {
                PaintApp.layerMgr.collapseToBase({ fresh: true });
                PaintApp.setSize(w, h);
                const c = PaintApp.ctx;
                c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h);
                PaintApp.state.history = []; PaintApp.state.step = -1;
                PaintApp.config.zoom = 1; PaintApp.updateBounds();
                PaintApp.config.tool = 'pencil';
                PaintApp.config.lineWidth = width || 3;
                PaintApp.flushDeferredSave();
                PaintApp.saveState();
            },
            fire: (type, x, y, buttons) => {
                const b = PaintApp.bounds;
                const e = new PointerEvent(type, {
                    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
                    isPrimary: true, buttons, button: 0, pressure: 0.5,
                    clientX: b.left + x, clientY: b.top + y
                });
                (type === 'pointerdown' ? PaintApp.ui.stage : window).dispatchEvent(e);
            },
            stroke: (x, y, n, step) => {
                __q.fire('pointerdown', x, y, 1);
                for (let i = 1; i <= (n || 8); i++) __q.fire('pointermove', x + i * (step || 20), y + i * 9, 1);
                __q.fire('pointerup', x + (n || 8) * (step || 20), y + (n || 8) * 9, 0);
            },
            hash: () => {
                const w = PaintApp.config.width, h = PaintApp.config.height;
                const d = PaintApp.ui.cMain.getContext('2d').getImageData(0, 0, w, h).data;
                let a = 0x811c9dc5, b = 0;
                for (let i = 0; i < d.length; i += 4) {
                    const v = (d[i] << 24) ^ (d[i+1] << 16) ^ (d[i+2] << 8) ^ d[i+3];
                    a = ((a ^ v) * 16777619) >>> 0; b = (b + a) >>> 0;
                }
                return a.toString(16) + ':' + b.toString(16);
            },
            inked: () => {
                const w = PaintApp.config.width, h = PaintApp.config.height;
                const d = PaintApp.ui.cMain.getContext('2d').getImageData(0, 0, w, h).data;
                let n = 0;
                for (let i = 0; i < d.length; i += 4) if (d[i] !== 255 || d[i+1] !== 255 || d[i+2] !== 255) n++;
                return n;
            },
            settle: () => new Promise(r => setTimeout(r, 250))
        };
        return true;
    `);

    console.log('== 1. mouse-up returns straight away, even with a fat brush ==');
    {
        const r = await page.eval(`(async () => {
            __q.doc(13000, 13000, 1000);
            const times = [];
            for (let i = 0; i < 5; i++) {
                __q.fire('pointerdown', 2000 + i * 900, 2000, 1);
                for (let k = 1; k <= 10; k++) __q.fire('pointermove', 2000 + i * 900 + k * 120, 2000 + k * 70, 1);
                const t0 = performance.now();
                __q.fire('pointerup', 2000 + i * 900 + 1200, 2700, 0);
                times.push(performance.now() - t0);
                await __q.settle();
            }
            times.sort((a, b) => a - b);
            return { median: times[2], worst: times[4] };
        })()`);
        console.log(`     1000px pencil on 13000x13000: mouse-up ${r.median.toFixed(1)} ms median, ${r.worst.toFixed(1)} ms worst`);
        check('mouse-up no longer blocks for hundreds of milliseconds',
            r.worst < 80, r.worst.toFixed(1) + ' ms');
    }

    console.log('\n== 2. one undo step per stroke, even started back to back ==');
    {
        const r = await page.eval(`(() => {
            __q.doc(2000, 2000, 5);
            const before = PaintApp.state.history.length;
            // No pause at all: the second begins while the first is unrecorded.
            __q.stroke(100, 100, 8);
            __q.stroke(600, 100, 8);
            __q.stroke(1100, 100, 8);
            PaintApp.flushDeferredSave();
            return { added: PaintApp.state.history.length - before };
        })()`);
        check('three strokes make exactly three undo steps',
            r.added === 3, String(r.added) + ' steps');
    }

    console.log('\n== 3. undoing back-to-back strokes removes them one at a time ==');
    {
        const r = await page.eval(`(() => {
            __q.doc(2000, 2000, 5);
            const blank = __q.hash();
            __q.stroke(100, 100, 8);
            const afterFirst = __q.hash();
            __q.stroke(900, 400, 8);          // starts before the first is recorded
            const afterSecond = __q.hash();
            PaintApp.undo();
            const undoneOnce = __q.hash();
            PaintApp.undo();
            const undoneTwice = __q.hash();
            return {
                distinct: afterFirst !== afterSecond && afterFirst !== blank,
                backToFirst: undoneOnce === afterFirst,
                backToBlank: undoneTwice === blank
            };
        })()`);
        check('the two strokes produced different pictures', r.distinct);
        check('one undo goes back to just after the first stroke',
            r.backToFirst, 'two strokes had been merged into one step');
        check('a second undo goes back to blank', r.backToBlank);
    }

    console.log('\n== 4. an unrecorded stroke is never lost ==');
    {
        const r = await page.eval(`(async () => {
            const out = {};
            // Undo immediately, before the record can have been written.
            __q.doc(1500, 1500, 5);
            const blank = __q.hash();
            __q.stroke(100, 100, 8);
            const drawn = __q.hash();
            PaintApp.undo();
            out.undoWorksImmediately = __q.hash() === blank;
            PaintApp.redo();
            out.redoRestores = __q.hash() === drawn;

            // A different kind of edit right after a stroke must not swallow it.
            __q.doc(1500, 1500, 5);
            const base = PaintApp.state.history.length;
            __q.stroke(200, 200, 6);
            const mid = __q.hash();
            PaintApp.ctx.fillStyle = '#0a0';
            PaintApp.ctx.fillRect(900, 900, 80, 80);
            PaintApp.saveState();
            out.bothRecorded = PaintApp.state.history.length - base === 2;
            PaintApp.undo();
            out.strokeSurvivesUndoOfNext = __q.hash() === mid;

            // A change that records WITHOUT drawing — a layer setting, say.
            // Nothing touches the canvas, so the drawing guard cannot help and
            // the record would otherwise be written after this one, putting
            // history out of order.
            __q.doc(1500, 1500, 5);
            const b3 = PaintApp.state.history.length;
            __q.stroke(400, 400, 6);
            const strokeHash = __q.hash();
            PaintApp.saveState();                 // no pixels changed
            out.metaKeptOrder = PaintApp.state.history.length - b3 === 2;
            PaintApp.undo();
            out.strokeSurvivesMetaUndo = __q.hash() === strokeHash;

            // And after everything settles on its own.
            __q.doc(1500, 1500, 5);
            const b2 = PaintApp.state.history.length;
            __q.stroke(300, 300, 6);
            await __q.settle();
            out.recordedOnItsOwn = PaintApp.state.history.length - b2 === 1;
            return out;
        })()`);
        check('undo works even if the record has not been written yet',
            r.undoWorksImmediately, 'the stroke was lost');
        check('and redo brings it back', r.redoRestores);
        check('a stroke and a later edit are two separate steps', r.bothRecorded);
        check('undoing the later edit leaves the stroke intact',
            r.strokeSurvivesUndoOfNext);
        check('a change that draws nothing still records in the right order',
            r.metaKeptOrder, 'the stroke was recorded after it');
        check('and undoing that change leaves the stroke intact',
            r.strokeSurvivesMetaUndo);
        check('a stroke gets recorded on its own if nothing else happens',
            r.recordedOnItsOwn);
    }

    console.log('\n== 5. the picture itself is unchanged by any of this ==');
    {
        const r = await page.eval(`(async () => {
            __q.doc(1200, 1200, 7);
            __q.stroke(100, 150, 10);
            __q.stroke(500, 150, 10);
            await __q.settle();
            const inked = __q.inked();
            const hash = __q.hash();
            for (let i = 0; i < 2; i++) PaintApp.undo();
            const blank = __q.inked();
            for (let i = 0; i < 2; i++) PaintApp.redo();
            return { inked, blank, same: __q.hash() === hash };
        })()`);
        check('both strokes drew', r.inked > 500, String(r.inked));
        check('undoing both leaves nothing', r.blank === 0, String(r.blank));
        check('redoing restores the exact picture', r.same);
    }

    const errs = page.errors();
    console.log(`\npage errors: ${errs.length}`);
    for (const e of errs.slice(0, 6)) console.log('  ! ' + e.text.split('\n')[0]);
    console.log(`\n${pass} passed, ${fail} failed`);
});

process.exit(fail ? 1 : 0);
