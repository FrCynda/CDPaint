/* The paint brush engine (krita-brush-engine.js) had no tests at all.
 *
 * It is the largest untested surface in the app and it reaches the canvas by a
 * different route from every other tool: dabs accumulate on an offscreen flow
 * buffer and get composited onto the layer in one drawImage per frame. That
 * route walks straight past the guards the pixel tools go through, which is how
 * it ended up ignoring both alpha lock and the active selection.
 *
 * These tests drive the engine through its real API — beginStroke / moveStroke
 * / endStroke — and assert on layer pixels.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

const CLEAR = '0,0,0,0';

await withPage(async (page) => {
    await page.run(`
        window.__B = {
            /* One transparent layer over an opaque white Background. */
            doc: (w, h) => {
                const app = PaintApp;
                app.layerMgr.collapseToBase({ fresh: true });
                app.setSize(w || 200, h || 200);
                app.config.zoom = 1; app.updateBounds();
                app.ctx.fillStyle = '#ffffff';
                app.ctx.fillRect(0, 0, w || 200, h || 200);
                document.getElementById('lsys-add').click();
                app.state.selection = null;
                app.state.history = []; app.state.step = -1;
                app.brush.loadPreset('Round');
                // Undo any per-preset overrides a previous run may have saved.
                ['colorRate','bristleCount','scatter','texture','opacity','flow']
                    .forEach(k => app.brush.setParam(k, app.brush.DEFAULTS[k]));
                app.brush.setParam('size', 14);
                app.saveState();
                return app.layerMgr.layers[app.layerMgr.activeIdx];
            },
            layer: () => PaintApp.layerMgr.layers[PaintApp.layerMgr.activeIdx],
            hash: (L) => {
                const d = L.ctx.getImageData(0, 0, 200, 200).data;
                let a = 0x811c9dc5;
                for (let i = 0; i < d.length; i++) a = ((a ^ d[i]) * 16777619) >>> 0;
                return a.toString(16);
            },
            /* Bristle strokes must be deterministic to compare: dynamics off
             * and scatter zero means _dabRand never moves anything. */
            bristles: (n) => {
                const b = PaintApp.brush;
                b.setParam('dynamicsMode', 'off');
                b.setParam('scatter', 0);
                b.setParam('bristleCount', n);
                b.setParam('bristleLength', 20);
                b.setParam('bristleWidth', 3);
                b.setParam('bristleSpread', 60);
                b.setParam('size', 24);
            },
            px: (L, x, y) => {
                const d = L.ctx.getImageData(x, y, 1, 1).data;
                return [d[0], d[1], d[2], d[3]].join(',');
            },
            stroke: async (x0, y0, x1, y1, color) => {
                const app = PaintApp;
                const c = color || '#ff0000';
                app.brush.beginStroke(x0, y0, 0.9, c);
                for (let i = 1; i <= 24; i++) {
                    app.brush.moveStroke(x0 + (x1 - x0) * i / 24,
                                         y0 + (y1 - y0) * i / 24, 0.9, c);
                }
                app.brush.endStroke();
                await new Promise(r => setTimeout(r, 180));
            }
        };
        return true;
    `);

    /* ── it works at all ──────────────────────────────────────────────── */
    console.log('== a stroke reaches the active layer ==');
    const r1 = await page.eval(`(async () => {
        const L = __B.doc();
        const before = __B.px(L, 100, 100);
        await __B.stroke(20, 100, 180, 100);
        return JSON.stringify({ before, after: __B.px(L, 100, 100),
            steps: PaintApp.state.history.length });
    })()`, { awaitPromise: true });
    const o1 = JSON.parse(r1);
    check('the layer starts empty', o1.before === CLEAR, o1.before);
    check('the stroke paints on it', o1.after !== CLEAR, o1.after);
    check('a stroke is exactly one undo step', o1.steps === 2, `${o1.steps} history entries`);

    /* ── undo ─────────────────────────────────────────────────────────── */
    console.log('\n== one undo removes a whole stroke ==');
    const r2 = await page.eval(`(async () => {
        const L = __B.doc();
        await __B.stroke(20, 100, 180, 100);
        const painted = __B.px(L, 100, 100);
        PaintApp.undo();
        await new Promise(r => setTimeout(r, 80));
        return JSON.stringify({ painted, undone: __B.px(__B.layer(), 100, 100) });
    })()`, { awaitPromise: true });
    const o2 = JSON.parse(r2);
    check('the stroke was there', o2.painted !== CLEAR, o2.painted);
    check('one undo clears it completely', o2.undone === CLEAR,
        `got ${o2.undone} — undo left part of the stroke behind`);

    /* ── locked layers ────────────────────────────────────────────────── */
    console.log('\n== a locked layer refuses the brush ==');
    const r3 = await page.eval(`(async () => {
        const L = __B.doc();
        L.locked = true;
        await __B.stroke(20, 100, 180, 100);
        L.locked = false;
        return JSON.stringify({ painted: __B.px(L, 100, 100) });
    })()`, { awaitPromise: true });
    const o3 = JSON.parse(r3);
    check('nothing is painted on a locked layer', o3.painted === CLEAR, o3.painted);

    /* ── alpha lock ───────────────────────────────────────────────────── */
    console.log('\n== alpha lock constrains the brush to existing pixels ==');
    const r4 = await page.eval(`(async () => {
        const L = __B.doc();
        PaintApp.ctx.fillStyle = '#00ff00';
        PaintApp.ctx.fillRect(20, 20, 40, 40);      // the only opaque pixels
        PaintApp.saveState();
        L.alphaLock = true;
        await __B.stroke(10, 40, 190, 40);          // crosses the block and continues
        L.alphaLock = false;
        return JSON.stringify({ onBlock: __B.px(L, 40, 40), offBlock: __B.px(L, 150, 40) });
    })()`, { awaitPromise: true });
    const o4 = JSON.parse(r4);
    check('it still paints inside the opaque area', o4.onBlock !== CLEAR, o4.onBlock);
    check('it paints nothing on the transparent area', o4.offBlock === CLEAR,
        `got ${o4.offBlock} — alpha lock was ignored`);

    /* ── selection as a stencil ───────────────────────────────────────── */
    console.log('\n== the active selection clips the brush ==');
    const r5 = await page.eval(`(async () => {
        const L = __B.doc();
        PaintApp.state.selection = { x: 20, y: 20, w: 60, h: 60, rotation: 0,
            canvas: null, originalX: 20, originalY: 20 };
        PaintApp.state.selectionOriginalPos = { x: 20, y: 20, w: 60, h: 60, rotation: 0 };
        await __B.stroke(10, 50, 190, 50);         // starts inside, runs far outside
        PaintApp.state.selection = null;
        return JSON.stringify({ inside: __B.px(L, 50, 50), outside: __B.px(L, 150, 50) });
    })()`, { awaitPromise: true });
    const o5 = JSON.parse(r5);
    check('it paints inside the selection', o5.inside !== CLEAR, o5.inside);
    check('it paints nothing outside the selection', o5.outside === CLEAR,
        `got ${o5.outside} — the selection was ignored`);

    /* ── an empty rectangular selection is still a stencil ────────────── */
    console.log('\n== an empty selection is a shape, not a set of pixels ==');
    const r6 = await page.eval(`(async () => {
        const L = __B.doc();
        // A marquee dragged over blank space: the region holds no pixels at all.
        PaintApp.state.selection = { x: 20, y: 20, w: 60, h: 60, rotation: 0,
            canvas: null, originalX: 20, originalY: 20 };
        PaintApp.state.selectionOriginalPos = { x: 20, y: 20, w: 60, h: 60, rotation: 0 };
        await __B.stroke(30, 50, 70, 50);
        PaintApp.state.selection = null;
        return JSON.stringify({ inside: __B.px(L, 50, 50) });
    })()`, { awaitPromise: true });
    const o6 = JSON.parse(r6);
    check('the brush still paints inside an empty selection', o6.inside !== CLEAR,
        `got ${o6.inside} — the stencil came from lifted pixels, not the shape`);

    /* ── bristle mode honours the tip settings ────────────────────────── */
    console.log('\n== bristle mode is a real tip, not a bare line ==');
    const r8 = await page.eval(`(async () => {
        const b = PaintApp.brush;
        const out = {};
        const strokeWith = async (mutate) => {
            const L = __B.doc();
            __B.bristles(12);
            if (mutate) mutate();
            await __B.stroke(40, 100, 160, 100);
            return __B.hash(L);
        };
        out.painted   = await strokeWith(() => {});
        const L0 = __B.layer();
        out.blank     = (() => { __B.doc(); return __B.hash(__B.layer()); })();

        out.hard      = await strokeWith(() => b.setParam('hardness', 100));
        out.soft      = await strokeWith(() => b.setParam('hardness', 5));
        out.circle    = await strokeWith(() => { b.setParam('hardness', 80); b.setParam('shape', 'circle'); });
        out.square    = await strokeWith(() => { b.setParam('hardness', 80); b.setParam('shape', 'square'); });
        out.noTexture = await strokeWith(() => { b.setParam('shape', 'circle'); b.setParam('texture', 0); });
        out.texture   = await strokeWith(() => { b.setParam('shape', 'circle'); b.setParam('texture', 80); });
        out.repeat    = await strokeWith(() => { b.setParam('texture', 0); b.setParam('shape', 'circle'); b.setParam('hardness', 80); });
        out.repeat2   = await strokeWith(() => { b.setParam('texture', 0); b.setParam('shape', 'circle'); b.setParam('hardness', 80); });
        ['hardness','shape','texture','bristleCount','bristleLength','bristleWidth',
         'bristleSpread','dynamicsMode','scatter','size']
            .forEach(k => b.setParam(k, b.DEFAULTS[k]));
        return JSON.stringify(out);
    })()`, { awaitPromise: true });
    const o8 = JSON.parse(r8);
    check('a bristle stroke paints something', o8.painted !== o8.blank);
    check('the same bristle stroke twice is identical (no hidden randomness)',
        o8.repeat === o8.repeat2, `${o8.repeat} vs ${o8.repeat2}`);
    check('hardness changes a bristle stroke', o8.hard !== o8.soft,
        'soft and hard bristles produced identical pixels');
    check('shape changes a bristle stroke', o8.circle !== o8.square,
        'circle and square bristles produced identical pixels');
    check('texture changes a bristle stroke', o8.noTexture !== o8.texture,
        'texture had no effect on bristles');

    /* ── performance guards ───────────────────────────────────────────── */
    /* -- the rope overlay is positioned in SCREEN space ---------------- */
    console.log('');
    console.log('== the rope overlay follows the cursor on a layered document ==');
    const rr = await page.eval(`(() => {
        const app = PaintApp;
        // The rope is an SVG in viewport coordinates. It used to measure
        // app.ctx.canvas, which in layer mode is the active layer's OFF-SCREEN
        // canvas -- rect all zeros, rope pinned to the viewport corner.
        const read = () => {
            const svg = document.querySelector('svg[style*="99999"]');
            if (!svg || svg.style.display === 'none') return null;
            const d = svg.querySelector('path').getAttribute('d');
            const m = /^M ([-0-9.]+),([-0-9.]+)/.exec(d);
            return m ? { x: +m[1], y: +m[2] } : null;
        };
        const drag = () => {
            const b = app.brush;
            b.setParam('smoothingMode', 'rope');
            b.setParam('smoothingRope', 100);
            b.beginStroke(40, 40, 0.9, '#ff0000');
            for (let i = 1; i <= 10; i++) b.moveStroke(40 + i * 12, 40, 0.9, '#ff0000');
            const at = read();
            b.endStroke();
            return at;
        };
        // A document where no extra layer was ever created.
        app.layerMgr.collapseToBase({ fresh: true });
        app.setSize(200, 200);
        app.config.zoom = 1; app.updateBounds();
        app.state.selection = null;
        app.brush.loadPreset('Round');
        const flat = drag();
        // The same drag once a second layer exists.
        __B.doc();
        const layered = drag();
        const r = app.ui.cMain.getBoundingClientRect();
        return JSON.stringify({ flat, layered, left: r.left, top: r.top });
    })()`);
    const ro = JSON.parse(rr);
    console.log('  ' + rr);
    check('the rope is drawn at all', !!(ro.flat && ro.layered), rr);
    check('a layered document puts the rope where a flat one does',
        !!(ro.flat && ro.layered
            && Math.abs(ro.flat.x - ro.layered.x) < 1
            && Math.abs(ro.flat.y - ro.layered.y) < 1),
        `flat ${JSON.stringify(ro.flat)} vs layered ${JSON.stringify(ro.layered)}`);

    console.log('\n== hot-path guards ==');
    const r7 = await page.eval(`(async () => {
        const app = PaintApp;
        let reads = 0, masks = 0;
        // Count BOTH context types: the smudge cache reads off an
        // OffscreenCanvas, and a guard that cannot see it proves nothing.
        const P = CanvasRenderingContext2D.prototype, oG = P.getImageData;
        P.getImageData = function (...a) { reads++; return oG.apply(this, a); };
        const OP = OffscreenCanvasRenderingContext2D.prototype, oOG = OP.getImageData;
        OP.getImageData = function (...a) { reads++; return oOG.apply(this, a); };
        const oOC = window.OffscreenCanvas;
        window.OffscreenCanvas = function (w, h) { masks++; return new oOC(w, h); };
        const run = async () => {
            app.brush.beginStroke(20, 100, 0.4, '#ff0000');
            for (let i = 1; i <= 200; i++) {
                app.brush.moveStroke(20 + i * 0.8, 100 + Math.sin(i / 5) * 30,
                    0.3 + 0.6 * Math.abs(Math.sin(i / 9)), '#ff0000');
            }
            app.brush.endStroke();
            await new Promise(r => setTimeout(r, 250));
        };
        __B.doc();
        reads = 0; masks = 0;
        await run();
        const plain = { reads, masks };

        __B.doc();
        app.brush.setParam('colorRate', 50);
        reads = 0;
        await run();
        const smudgeReads = reads;
        app.brush.setParam('colorRate', app.brush.DEFAULTS.colorRate);

        // Bristles: one dab per bristle per position, and the tip cache must
        // absorb them — a mask per bristle per position would be ruinous.
        __B.doc();
        __B.bristles(12);
        reads = 0; masks = 0;
        await run();
        const bristle = { reads, masks };
        ['bristleCount','bristleLength','bristleWidth','bristleSpread','dynamicsMode','scatter','size']
            .forEach(k => app.brush.setParam(k, app.brush.DEFAULTS[k]));

        P.getImageData = oG; OP.getImageData = oOG; window.OffscreenCanvas = oOC;
        return JSON.stringify({ plain, smudgeReads, bristle });
    })()`, { awaitPromise: true });
    const o7 = JSON.parse(r7);
    console.log('  ' + JSON.stringify(o7));
    check('the dab cache absorbs varying pressure (few mask builds)',
        o7.plain.masks <= 40, `${o7.plain.masks} offscreen canvases for a 200-point stroke`);
    check('a plain stroke does no per-dab canvas readback',
        o7.plain.reads <= 20, `${o7.plain.reads} getImageData calls`);
    check('smudge does not read back once per dab',
        o7.smudgeReads <= 4,
        `${o7.smudgeReads} getImageData calls in one stroke — it should be one`);
    check('a 12-bristle stroke does not thrash the tip cache',
        o7.bristle.masks <= 80,
        `${o7.bristle.masks} tip masks built for one bristle stroke`);
    check('bristles do no per-dab readback either',
        o7.bristle.reads <= 4, `${o7.bristle.reads} getImageData calls`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
