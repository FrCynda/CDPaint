/* Does history still capture everything that changed?
 *
 * A step now reads only the region the context wrapper says was touched. If it
 * ever under-reports, history misses part of the picture and undo restores
 * something subtly wrong — the worst kind of bug, because it looks fine until
 * much later.
 *
 * So the rule is: the wrapper must never claim LESS than what changed. These
 * tests check the reported region against the drawing that produced it, and
 * check that anything the wrapper cannot model falls back to "all of it".
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

await withPage(async (page) => {
    await page.run(`
        window.__d = {
            doc: (w, h) => {
                PaintApp.layerMgr.collapseToBase({ fresh: true });
                PaintApp.setSize(w, h);
                PaintApp.state.history = []; PaintApp.state.step = -1;
                const c = PaintApp.ctx;
                c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h);
                PaintApp.saveState();
            },
            /* Run a drawing operation and report the region it claimed. */
            claim: (fn) => {
                PaintApp.markCleanDirty();
                fn(PaintApp.ctx);
                return PaintApp.currentDirtyRect();
            },
            covers: (r, x0, y0, x1, y1) =>
                !!r && r.x0 <= x0 && r.y0 <= y0 && r.x1 >= x1 && r.y1 >= y1,
            hash: () => {
                const w = PaintApp.config.width, h = PaintApp.config.height;
                const d = PaintApp.ui.cMain.getContext('2d').getImageData(0, 0, w, h).data;
                let a = 0x811c9dc5, b = 0;
                for (let i = 0; i < d.length; i += 4) {
                    const v = (d[i] << 24) ^ (d[i+1] << 16) ^ (d[i+2] << 8) ^ d[i+3];
                    a = ((a ^ v) * 16777619) >>> 0; b = (b + a) >>> 0;
                }
                return a.toString(16) + ':' + b.toString(16);
            }
        };
        return true;
    `);

    console.log('== 1. simple shapes report where they landed ==');
    {
        const r = await page.eval(`(() => {
            __d.doc(600, 600);
            return {
                fill:   __d.claim(c => { c.fillStyle = '#f00'; c.fillRect(100, 120, 40, 30); }),
                clear:  __d.claim(c => c.clearRect(200, 210, 25, 15)),
                stroke: __d.claim(c => { c.lineWidth = 8; c.strokeRect(300, 310, 20, 20); }),
                image:  __d.claim(c => c.putImageData(c.createImageData(30, 40), 400, 410)),
                none:   __d.claim(() => {})
            };
        })()`);
        check('fillRect covers what it filled', await page.eval(`__d.covers(${JSON.stringify(r.fill)}, 100, 120, 139, 149)`), JSON.stringify(r.fill));
        check('clearRect covers what it cleared', await page.eval(`__d.covers(${JSON.stringify(r.clear)}, 200, 210, 224, 224)`), JSON.stringify(r.clear));
        check('strokeRect allows for the line width',
            r.stroke.x0 <= 296 && r.stroke.x1 >= 324, JSON.stringify(r.stroke));
        check('putImageData covers the image', await page.eval(`__d.covers(${JSON.stringify(r.image)}, 400, 410, 429, 449)`), JSON.stringify(r.image));
        check('drawing nothing reports an empty region',
            r.none.x1 < r.none.x0, JSON.stringify(r.none));
    }

    console.log('\n== 2. transforms are followed, not ignored ==');
    {
        const r = await page.eval(`(() => {
            __d.doc(600, 600);
            return {
                moved:   __d.claim(c => { c.save(); c.translate(200, 150); c.fillRect(0, 0, 20, 20); c.restore(); }),
                scaled:  __d.claim(c => { c.save(); c.scale(3, 3); c.fillRect(50, 50, 10, 10); c.restore(); }),
                rotated: __d.claim(c => { c.save(); c.translate(300, 300); c.rotate(Math.PI / 4); c.fillRect(-30, -30, 60, 60); c.restore(); }),
                popped:  __d.claim(c => { c.save(); c.translate(400, 400); c.restore(); c.fillRect(10, 10, 5, 5); })
            };
        })()`);
        check('a translated fill is reported where it actually landed',
            await page.eval(`__d.covers(${JSON.stringify(r.moved)}, 200, 150, 219, 169)`), JSON.stringify(r.moved));
        check('a scaled fill reports the scaled area',
            await page.eval(`__d.covers(${JSON.stringify(r.scaled)}, 150, 150, 179, 179)`), JSON.stringify(r.scaled));
        check('a rotated square reports its full diagonal',
            r.rotated.x0 <= 258 && r.rotated.x1 >= 342, JSON.stringify(r.rotated));
        check('restore() puts the transform back',
            r.popped.x0 <= 10 && r.popped.x1 <= 40, JSON.stringify(r.popped));
    }

    console.log('\n== 3. anything it cannot model falls back to the whole canvas ==');
    {
        const r = await page.eval(`(() => {
            __d.doc(600, 600);
            // "Read everything" is represented by null, not by a rectangle
            // covering the canvas — there is nothing to intersect against.
            const all = (rect) => rect === null;
            return {
                shadow: all(__d.claim(c => { c.shadowBlur = 30; c.shadowColor = '#000';
                                             c.fillRect(10, 10, 5, 5); c.shadowBlur = 0; })),
                filter: all(__d.claim(c => { c.filter = 'blur(8px)';
                                             c.fillRect(10, 10, 5, 5); c.filter = 'none'; })),
                text:   all(__d.claim(c => { c.font = '20px sans-serif'; c.fillText('hi', 50, 50); })),
                nanRect: all(__d.claim(c => c.fillRect(NaN, 10, 5, 5))),
                pathNoPoints: all(__d.claim(c => { c.beginPath(); c.fill(); })),
                // The catch-all: a method the wrapper has no rule for at all.
                // Every other case here is caught by an explicit rule, so none
                // of them would notice if the fallback were deleted. Attaching
                // a method to the underlying context and calling it through the
                // wrapper exercises exactly that branch — which is what protects
                // against a future canvas API nobody has taught it about.
                unmodelled: all(__d.claim(c => {
                    c.__raw.__someFutureDrawCall = function () {};
                    c.__someFutureDrawCall();
                }))
            };
        })()`);
        check('a shadow forces a full capture', r.shadow, 'blur paints outside the shape');
        check('a filter forces a full capture', r.filter);
        check('text forces a full capture', r.text, 'glyph extents are not modelled');
        check('a nonsense rectangle forces a full capture', r.nanRect);
        check('filling an empty path forces a full capture', r.pathNoPoints);
        check('a drawing method with no rule at all forces a full capture',
            r.unmodelled,
            'this is the catch-all: without it, any unhandled method draws untracked');
    }

    console.log('\n== 4. paths report their own extent ==');
    {
        const r = await page.eval(`(() => {
            __d.doc(600, 600);
            return {
                line: __d.claim(c => { c.lineWidth = 4; c.beginPath();
                                       c.moveTo(100, 100); c.lineTo(200, 260); c.stroke(); }),
                circle: __d.claim(c => { c.beginPath(); c.arc(300, 300, 50, 0, 7); c.fill(); })
            };
        })()`);
        check('a stroked line covers both ends',
            await page.eval(`__d.covers(${JSON.stringify(r.line)}, 100, 100, 200, 260)`), JSON.stringify(r.line));
        check('a filled circle covers its radius',
            await page.eval(`__d.covers(${JSON.stringify(r.circle)}, 250, 250, 350, 350)`), JSON.stringify(r.circle));
    }

    console.log('\n== 5. end to end: the picture always comes back exactly ==');
    {
        // Mix every kind of operation, including ones that force a full read,
        // then undo the lot and demand an exact match at every step.
        const r = await page.eval(`(() => {
            __d.doc(900, 900);
            const ops = [
                c => { c.fillStyle = '#e33'; c.fillRect(20, 20, 60, 60); },
                c => { c.save(); c.translate(300, 100); c.rotate(0.5); c.fillStyle = '#3e3'; c.fillRect(0, 0, 80, 40); c.restore(); },
                c => { c.beginPath(); c.arc(500, 500, 70, 0, 7); c.fillStyle = '#33e'; c.fill(); },
                c => { c.clearRect(600, 100, 90, 90); },
                c => { c.save(); c.shadowBlur = 12; c.shadowColor = '#000'; c.fillStyle = '#ee3'; c.fillRect(120, 400, 50, 50); c.restore(); },
                c => { c.putImageData(c.createImageData(40, 40), 700, 700); },
                c => { c.save(); c.scale(2, 2); c.fillStyle = '#3ee'; c.fillRect(50, 300, 30, 30); c.restore(); },
                c => { c.font = '40px sans-serif'; c.fillStyle = '#000'; c.fillText('CD', 400, 800); },
                c => { c.lineWidth = 9; c.strokeStyle = '#909'; c.beginPath(); c.moveTo(50, 850); c.lineTo(850, 860); c.stroke(); }
            ];
            const seen = [__d.hash()];
            for (let pass = 0; pass < 3; pass++) {
                for (const op of ops) { op(PaintApp.ctx); PaintApp.saveState(); seen.push(__d.hash()); }
            }
            const bad = [];
            for (let i = seen.length - 2; i >= 0; i--) {
                PaintApp.undo();
                if (__d.hash() !== seen[i]) bad.push(i);
            }
            return { steps: seen.length, badCount: bad.length, first: bad.slice(0, 5) };
        })()`);
        check(`all ${r.steps - 1} mixed operations undo to the exact picture`,
            r.badCount === 0, `${r.badCount} wrong at ${JSON.stringify(r.first)}`);
    }

    console.log('\n== 6. it is actually saving the work, not just staying correct ==');
    {
        const r = await page.eval(`(() => {
            __d.doc(8000, 8000);
            let t = performance.now();
            for (let i = 0; i < 10; i++) { PaintApp.ctx.fillRect(40 + i * 30, 40, 8, 8); PaintApp.saveState(); }
            const smallMs = (performance.now() - t) / 10;
            // Something it cannot model has to fall back to reading everything.
            t = performance.now();
            PaintApp.ctx.font = '30px sans-serif'; PaintApp.ctx.fillText('x', 100, 100);
            PaintApp.saveState();
            const fullMs = performance.now() - t;
            return { smallMs, fullMs };
        })()`);
        console.log(`     small stroke ${r.smallMs.toFixed(1)} ms · forced full capture ${r.fullMs.toFixed(0)} ms`);
        check('a small stroke is far cheaper than a full capture',
            r.smallMs * 10 < r.fullMs, `${r.smallMs.toFixed(1)} vs ${r.fullMs.toFixed(0)}`);
        check('a small stroke is fast in absolute terms',
            r.smallMs < 25, r.smallMs.toFixed(1) + ' ms');
    }

    const errs = page.errors();
    console.log(`\npage errors: ${errs.length}`);
    for (const e of errs.slice(0, 6)) console.log('  ! ' + e.text.split('\n')[0]);
    console.log(`\n${pass} passed, ${fail} failed`);
});

process.exit(fail ? 1 : 0);
