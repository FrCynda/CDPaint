/* What a stroke costs, and where the grain sits.
 *
 * Both halves guard fixes that are invisible to a pixel test. The engine
 * used to repaint every dab of a stroke a second time when the pen lifted,
 * purely so a taper it usually does not have could be applied retroactively
 * -- 131ms of dead work on mouse-up for Impasto at 3000x2000. And the
 * texture grain was tiled onto the dab's own canvas, so it slid along under
 * the brush instead of belonging to the paper.
 *
 * Counting dabs rather than timing them: a clock on a CI box measures the
 * box, a dab count measures the engine.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

await withPage(async (page) => {
    await page.run(`
        window.__P = {
            doc: () => {
                const app = PaintApp;
                app.layerMgr.collapseToBase({ fresh: true });
                app.setSize(900, 400);
                app.config.zoom = 1; app.updateBounds();
                document.getElementById('lsys-add').click();
                app.state.selection = null;
                app.state.history = []; app.state.step = -1;
                return app.layerMgr.layers[app.layerMgr.activeIdx];
            },

            /* Count dabs on both context types. The engine's buffers are
             * OffscreenCanvas, so a counter that only wraps the on-screen
             * prototype proves nothing. */
            counted: null,
            countOn() {
                const self = this;
                self.counted = 0;
                self._undo = [];
                for (const C of [CanvasRenderingContext2D, OffscreenCanvasRenderingContext2D]) {
                    const orig = C.prototype.drawImage;
                    C.prototype.drawImage = function (...a) { self.counted++; return orig.apply(this, a); };
                    self._undo.push(() => { C.prototype.drawImage = orig; });
                }
            },
            countOff() { (this._undo || []).forEach(f => f()); this._undo = []; },

            /* A stroke that yields frames, so the live passes actually run.
             * Without the rAF the engine paints nothing until endStroke and
             * the mouse-up pass is indistinguishable from the whole stroke. */
            async split(preset) {
                const app = PaintApp, frame = () => new Promise(r => requestAnimationFrame(r));
                app.brush.loadPreset(preset);
                this.countOn();
                app.brush.beginStroke(60, 200, 0.9, '#c03030');
                for (let i = 1; i <= 120; i++) {
                    app.brush.moveStroke(60 + i * 6, 200 + Math.sin(i / 14) * 60, 0.8, '#c03030');
                    if (i % 6 === 0) await frame();
                }
                await frame();
                const live = this.counted;
                this.counted = 0;
                app.brush.endStroke();
                const end = this.counted;
                this.countOff();
                await new Promise(r => setTimeout(r, 60));
                return { live, end };
            }
        };
        return true;
    `);

    /* ── the mouse-up pass ─────────────────────────────────────────────── */
    console.log('== what lifting the pen costs ==');
    const r = JSON.parse(await page.eval(`(async () => {
        __P.doc();
        const out = {};
        out.round   = await __P.split('Round');
        out.impasto = await __P.split('Impasto');
        out.fan     = await __P.split('Fan Brush');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify(r));

    check('a plain brush paints the stroke while it is drawn',
        r.round.live > 50, `only ${r.round.live} dabs went down live`);
    check('...and lifting the pen does not paint it again',
        r.round.end < r.round.live / 4,
        `mouse-up cost ${r.round.end} dabs against ${r.round.live} live`);
    check('a start-only taper does not need the stroke repainted either',
        r.impasto.end < r.impasto.live / 4,
        `Impasto mouse-up ${r.impasto.end} against ${r.impasto.live} live`);
    /* Documents the known ceiling rather than pretending it is fixed: an END
     * taper genuinely cannot be drawn until the stroke has an end. */
    check('an end taper still redraws the stroke, as it must',
        r.fan.end > r.fan.live / 4,
        `Fan Brush mouse-up ${r.fan.end} against ${r.fan.live} live`);

    /* ── grain belongs to the paper ────────────────────────────────────── */
    /* The grain is a tile laid on the canvas, so the same dab drawn one tile
     * further along must come out (nearly) the same, and a dab half a tile
     * along must not. The period is not 64px: the engine scales the tile by
     * _TEX_GRAIN_SCALE (1.83, a deliberate look calibration), so the period
     * is about 117px. The constant is private, so rather than hardcode it
     * this measures the period: it scans shifts and asks that the best match
     * lands where a tile would, and that the half-period is clearly worse
     * than the period. Edge pixels resample slightly differently between
     * renderers, so "identical" is a similarity threshold rather than a hash. */
    console.log('== the texture grain stays with the canvas ==');
    const g = JSON.parse(await page.eval(`(async () => {
        const app = PaintApp, b = app.brush;
        const L = __P.doc();
        b.loadPreset('Round');
        b.setParam('dynamicsMode', 'off'); b.setParam('scatter', 0);
        b.setParam('size', 40); b.setParam('hardness', 100);
        b.setParam('texture', 90); b.setParam('textureScale', 1);
        b.setParam('textureType', 'grain');

        const grab = async (x) => {
            b.beginStroke(x, 200, 0.9, '#000000');
            b.endStroke();
            await new Promise(r => setTimeout(r, 40));
            /* Colour, not alpha: texture composites source-atop, which leaves
             * destination alpha alone, so alpha cannot see the grain at all. */
            const d = Array.from(L.ctx.getImageData(x - 20, 180, 40, 40).data);
            L.ctx.clearRect(0, 0, 900, 400);
            return d;
        };
        const base = await grab(100);
        const differing = (v) => { let n = 0; for (let i = 0; i < base.length; i++) if (base[i] !== v[i]) n++; return n; };

        const scan = [];
        for (let dx = 20; dx <= 200; dx++) scan.push([dx, differing(await grab(100 + dx))]);
        const best = scan.slice().sort((p, q) => p[1] - q[1])[0];
        /* Half a period along, for the "grain is not just uniform" check. The
         * scan starts at 20px, so a degenerate result (every shift identical,
         * which puts the "best" at 20 and its half outside the scan) must not
         * crash the page: report it and let the checks below fail with it. */
        const worst = Math.max(...scan.map(p => p[1]));
        const halfEntry = scan.find(p => p[0] === Math.round(best[0] / 2));
        const half = halfEntry ? halfEntry[1] : null;
        b.loadPreset('Round');
        return JSON.stringify({ total: base.length, best, half, worst, period: best[0] });
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify({ period: g.period, differing: g.best[1], of: g.total, worst: g.worst }));

    /* If no shift differs from any other, the grain is not varying with
     * position at all, which is the very thing this suite exists to catch. */
    check('the grain varies with position at all',
        g.worst > 0, `every shift gave the same ${g.worst} differing bytes`);

    check('the grain repeats at a period inside the tile-sized range (100-135px)',
        g.period >= 100 && g.period <= 135, `best match was ${g.period}px`);
    check('...and at that period the dab is clearly more alike than at half of it',
        g.half !== null && g.best[1] < g.half * 0.85,
        `${g.best[1]} differ at ${g.period}px against ${g.half} at half`);

    /* ── live flushes hint a bounded rect, not the whole stroke ──────────── */
    /* _clearBounds tracks the WHOLE stroke's bounds and is never narrowed
     * mid-stroke, so a live flush that widened to it (as it once did) would
     * recomposite an ever-growing region onto the layer compositor -- fine
     * on a small canvas, unbearable on a large one where every live frame of
     * a long stroke pays for the whole span drawn so far instead of just its
     * own new ink. A big brush moving in a straight line keeps each frame's
     * hinted rect close to one dab's footprint; only the FINAL/replay pass
     * (a taper) is allowed to widen. */
    console.log('== a live flush hints a bounded rect, not the growing stroke bounds ==');
    const d = JSON.parse(await page.eval(`(async () => {
        const app = PaintApp, b = app.brush, frame = () => new Promise(r => requestAnimationFrame(r));
        __P.doc();
        b.loadPreset('Round');
        b.setParam('dynamicsMode', 'off'); b.setParam('taperStart', 0); b.setParam('taperEnd', 0);
        b.setParam('size', 60); b.setParam('spacing', 5);
        const rects = [];
        const orig = app.layerMgr.markDirty;
        app.layerMgr.markDirty = function (x, y, w, h) { rects.push(w * h); return orig.apply(this, arguments); };
        b.beginStroke(60, 200, 0.9, '#c03030');
        for (let i = 1; i <= 40; i++) {
            b.moveStroke(60 + i * 15, 200, 0.9, '#c03030');
            await frame();
        }
        b.endStroke();
        await new Promise(r => setTimeout(r, 60));
        app.layerMgr.markDirty = orig;
        return JSON.stringify({ first: rects[0] || 0, last: rects[rects.length - 1] || 0, n: rects.length });
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify(d));
    check('a live flush late in a long straight stroke costs about what an early one did',
        d.n > 5 && d.last < d.first * 3,
        `first hinted area ${d.first}px², last ${d.last}px² over ${d.n} flushes`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
