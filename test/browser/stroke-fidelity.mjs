/* Real strokes, driven through the real pointer handlers.
 *
 * A stroke is drawn on a preview canvas and stamped onto the artwork when you
 * let go. That stamp used to copy the whole preview, which told history the
 * entire canvas had changed — 863 ms on a 13000x13000 document, and the reason
 * a second stroke started immediately after the first came out as a straight
 * line: the app was blocked, so the moves in between were never seen.
 *
 * Now only the touched part is stamped, and only that part is cleared. If that
 * region were ever too small, strokes would come out clipped — so these tests
 * compare against stamping everything, which is what it replaced.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

await withPage(async (page) => {
    await page.run(`
        window.__p = {
            doc: (w, h) => {
                PaintApp.layerMgr.collapseToBase({ fresh: true });
                PaintApp.setSize(w, h);
                const c = PaintApp.ctx;
                c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h);
                PaintApp.state.history = []; PaintApp.state.step = -1;
                PaintApp.config.zoom = 1;
                PaintApp.updateBounds();
                PaintApp.saveState();
            },
            /* Drive the app's own pointer handlers. */
            stroke: (pts) => {
                const stage = PaintApp.ui.stage, b = PaintApp.bounds;
                const fire = (type, p, buttons) => {
                    const e = new PointerEvent(type, {
                        bubbles: true, cancelable: true, pointerId: 1,
                        pointerType: 'mouse', isPrimary: true,
                        buttons: buttons, button: 0, pressure: 0.5,
                        clientX: b.left + p.x, clientY: b.top + p.y
                    });
                    (type === 'pointerdown' ? stage : window).dispatchEvent(e);
                };
                const t0 = performance.now();
                fire('pointerdown', pts[0], 1);
                for (let i = 1; i < pts.length; i++) fire('pointermove', pts[i], 1);
                fire('pointerup', pts[pts.length - 1], 0);
                return performance.now() - t0;
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
            /* Count pixels that are not the white background. */
            inked: () => {
                const w = PaintApp.config.width, h = PaintApp.config.height;
                const d = PaintApp.ui.cMain.getContext('2d').getImageData(0, 0, w, h).data;
                let n = 0;
                for (let i = 0; i < d.length; i += 4) {
                    if (d[i] !== 255 || d[i+1] !== 255 || d[i+2] !== 255) n++;
                }
                return n;
            },
            wiggle: (x, y, n) => {
                const pts = [];
                for (let i = 0; i < n; i++) {
                    pts.push({ x: x + i * 9, y: y + Math.round(Math.sin(i / 2) * 40) });
                }
                return pts;
            }
        };
        return true;
    `);

    console.log('== 1. a stamped stroke is identical to stamping everything ==');
    {
        // The old behaviour, reproduced exactly: force the preview region
        // unknown so the whole thing is copied, and compare the results.
        const r = await page.eval(`(() => {
            const pts = __p.wiggle(150, 300, 40);

            __p.doc(2000, 2000);
            __p.stroke(pts);
            const optimised = { hash: __p.hash(), inked: __p.inked() };

            __p.doc(2000, 2000);
            const realClear = PaintApp.clearTempCanvas.bind(PaintApp);
            const realCurrent = PaintApp.currentDirtyRect.bind(PaintApp);
            // Pretend nothing is known about the preview: full stamp, full clear.
            PaintApp.currentDirtyRect = (key) => key === 'temp' ? null : realCurrent(key);
            __p.stroke(pts);
            PaintApp.currentDirtyRect = realCurrent;
            const full = { hash: __p.hash(), inked: __p.inked() };

            return { optimised, full };
        })()`);
        check('the stroke actually drew something',
            r.optimised.inked > 200, String(r.optimised.inked));
        check('pixel-for-pixel identical to copying the whole preview',
            r.optimised.hash === r.full.hash,
            `${r.optimised.hash} vs ${r.full.hash}`);
        check('the same number of pixels were inked',
            r.optimised.inked === r.full.inked,
            `${r.optimised.inked} vs ${r.full.inked}`);
    }

    console.log('\n== 1b. the stamp itself never clips what is on the preview ==');
    {
        // Pencil and eraser leave the preview empty, so a stroke test alone
        // never exercises the copy. This drives it directly: put known shapes
        // on the preview, stamp, and compare against copying all of it.
        const r = await page.eval(`(() => {
            const paint = (t) => {
                t.fillStyle = '#c22'; t.fillRect(120, 140, 90, 60);
                t.fillStyle = '#2c2'; t.fillRect(400, 380, 40, 40);
                t.beginPath(); t.strokeStyle = '#22c'; t.lineWidth = 7;
                t.moveTo(600, 120); t.lineTo(760, 300); t.stroke();
            };

            __p.doc(1000, 1000);
            PaintApp.markCleanDirty('temp');
            paint(PaintApp.ctxTemp);
            PaintApp.stampTempCanvas();
            const optimised = { hash: __p.hash(), inked: __p.inked() };
            PaintApp.clearTempCanvas();

            __p.doc(1000, 1000);
            PaintApp.markCleanDirty('temp');
            paint(PaintApp.ctxTemp);
            PaintApp.ctx.drawImage(PaintApp.ui.cTemp, 0, 0);   // the old behaviour
            const full = { hash: __p.hash(), inked: __p.inked() };
            PaintApp.clearTempCanvas();

            return { optimised, full };
        })()`);
        check('the preview held real content', r.full.inked > 5000, String(r.full.inked));
        check('stamping the tracked region copies every pixel of it',
            r.optimised.inked === r.full.inked,
            `${r.optimised.inked} vs ${r.full.inked} — a short region clips artwork`);
        check('and the result is pixel-for-pixel identical',
            r.optimised.hash === r.full.hash);
    }

    console.log('\n== 2. nothing is left behind or clipped across many strokes ==');
    {
        const r = await page.eval(`(() => {
            __p.doc(1500, 1500);
            let inked = 0;
            // Strokes all over the canvas, including near the edges.
            const places = [[40, 40], [800, 200], [200, 900], [900, 900], [60, 1400], [1200, 60]];
            for (const [x, y] of places) __p.stroke(__p.wiggle(x, y, 25));
            inked = __p.inked();
            // Undo them all; the canvas must come back completely blank.
            for (let i = 0; i < places.length; i++) PaintApp.undo();
            const afterUndo = __p.inked();
            // Redo them all; the picture must return exactly.
            for (let i = 0; i < places.length; i++) PaintApp.redo();
            return { inked, afterUndo, afterRedo: __p.inked(), hash: __p.hash() };
        })()`);
        check('six strokes across the canvas all drew', r.inked > 1000, String(r.inked));
        check('undoing them leaves nothing behind',
            r.afterUndo === 0, r.afterUndo + ' pixels remained');
        check('redoing restores every pixel',
            r.afterRedo === r.inked, `${r.afterRedo} vs ${r.inked}`);
    }

    console.log('\n== 3. a stroke over an earlier one does not erase it ==');
    {
        const r = await page.eval(`(() => {
            __p.doc(1200, 1200);
            __p.stroke(__p.wiggle(100, 200, 30));
            const first = __p.inked();
            // A second stroke far away must not disturb the first.
            __p.stroke(__p.wiggle(700, 800, 30));
            const both = __p.inked();
            PaintApp.undo();
            const backToFirst = __p.inked();
            return { first, both, backToFirst };
        })()`);
        check('the second stroke added to the picture', r.both > r.first);
        check('undoing the second leaves the first untouched',
            r.backToFirst === r.first, `${r.backToFirst} vs ${r.first}`);
    }

    console.log('\n== 3b. a stroke follows its real path even when a frame is lost ==');
    {
        // When the app falls behind, the browser delivers ONE move holding the
        // latest position with the skipped ones folded inside it. Using only
        // the latest collapses the gap into a straight segment — the reported
        // bug. Real coalesced events cannot be synthesised, so they are
        // attached to the event directly.
        const r = await page.eval(`(() => {
            __p.doc(600, 600);
            PaintApp.config.tool = 'pencil';
            PaintApp.config.lineWidth = 3;

            const stage = PaintApp.ui.stage, b = PaintApp.bounds;
            const mk = (type, x, y, buttons) => new PointerEvent(type, {
                bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
                isPrimary: true, buttons, button: 0, pressure: 0.5,
                clientX: b.left + x, clientY: b.top + y
            });

            stage.dispatchEvent(mk('pointerdown', 100, 100, 1));

            // An L: right along the top, then down. A straight line from start
            // to finish would cut the corner diagonally instead.
            const path = [[200, 100], [300, 100], [400, 100], [400, 200], [400, 300]];
            const last = mk('pointermove', 400, 300, 1);
            Object.defineProperty(last, 'getCoalescedEvents', {
                value: () => path.map(([x, y]) => mk('pointermove', x, y, 1))
            });
            window.dispatchEvent(last);
            window.dispatchEvent(mk('pointerup', 400, 300, 0));

            const px = (x, y) => {
                const d = PaintApp.ui.cMain.getContext('2d').getImageData(x, y, 1, 1).data;
                return !(d[0] === 255 && d[1] === 255 && d[2] === 255);
            };
            return {
                alongTop:   px(250, 100) && px(350, 100),
                alongRight: px(400, 180) && px(400, 260),
                onDiagonal: px(250, 200) || px(300, 230)
            };
        })()`);
        check('the stroke ran along the top of the L', r.alongTop);
        check('and down the side of it', r.alongRight);
        check('it did NOT cut straight across the corner',
            r.onDiagonal === false,
            'the skipped positions were thrown away and the stroke went straight');
    }

    console.log('\n== 4. the pause is gone ==');
    {
        const r = await page.eval(`(() => {
            __p.doc(13000, 13000);
            const times = [];
            for (let i = 0; i < 6; i++) times.push(__p.stroke(__p.wiggle(200 + i * 400, 300, 20)));
            times.sort((a, b) => a - b);
            return { median: times[3], worst: times[5], inked: __p.inked() > 0 };
        })()`);
        console.log(`     13000x13000: median ${r.median.toFixed(1)} ms, worst ${r.worst.toFixed(1)} ms for a whole stroke`);
        check('strokes still draw on a 13000px canvas', r.inked);
        check('a complete stroke takes milliseconds, not most of a second',
            r.worst < 60, r.worst.toFixed(1) + ' ms');
    }

    const errs = page.errors();
    console.log(`\npage errors: ${errs.length}`);
    for (const e of errs.slice(0, 6)) console.log('  ! ' + e.text.split('\n')[0]);
    console.log(`\n${pass} passed, ${fail} failed`);
});

process.exit(fail ? 1 : 0);
