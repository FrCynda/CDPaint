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
    console.log('== the texture grain stays with the canvas ==');
    const g = JSON.parse(await page.eval(`(async () => {
        const app = PaintApp, b = app.brush;
        const L = __P.doc();
        b.loadPreset('Round');
        b.setParam('dynamicsMode', 'off'); b.setParam('scatter', 0);
        b.setParam('size', 40); b.setParam('hardness', 100);
        b.setParam('texture', 90); b.setParam('textureScale', 1);
        b.setParam('textureType', 'grain');

        // One tile is 64px across; at scale 1 the grain repeats every 64px.
        const dab = async (x) => {
            b.beginStroke(x, 200, 0.9, '#000000');
            b.endStroke();
            await new Promise(r => setTimeout(r, 60));
            /* Hash the colour, not the alpha. Texture composites
             * source-atop, which by definition leaves destination alpha
             * alone -- an alpha hash cannot see the grain at all. */
            const d = L.ctx.getImageData(x - 20, 180, 40, 40).data;
            let a = 0x811c9dc5;
            for (let i = 0; i < d.length; i++) a = ((a ^ d[i]) * 16777619) >>> 0;
            L.ctx.clearRect(0, 0, 900, 400);
            return a.toString(16);
        };

        const at100 = await dab(100);
        const period = await dab(100 + 64);   // one whole tile along
        const offset = await dab(100 + 32);   // half a tile along
        b.loadPreset('Round');
        return JSON.stringify({ at100, period, offset });
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify(g));

    check('the same dab one whole tile away grains identically',
        g.at100 === g.period, `${g.at100} vs ${g.period}`);
    check('...and half a tile away it does not',
        g.at100 !== g.offset, `both came out ${g.at100}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
