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

    /* -- preset swatches are drawn by the real engine ------------------- */
    console.log('');
    console.log('== preset swatches are real strokes ==');
    const sw = await page.eval(`(() => {
        const app = PaintApp, b = app.brush;
        const L = __B.doc();
        const hash = (c) => {
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let a = 0x811c9dc5;
            for (let i = 0; i < d.length; i++) a = ((a ^ d[i]) * 16777619) >>> 0;
            return a.toString(16);
        };
        const ink = (c) => {
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let n = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
            return n;
        };
        const out = {};

        // Every stock preset must actually paint something.
        const names = Object.keys(b.PRESETS);
        out.empty = names.filter(n => {
            const c = b.generatePreview(n);
            return !c || ink(c) < 40;
        });

        // The old fake painter knew nothing of bristles or texture, so these
        // all came out as the same thin line.
        out.hRound     = hash(b.generatePreview('Round'));
        out.hFan       = hash(b.generatePreview('Fan Brush'));
        out.hAirbrush  = hash(b.generatePreview('Airbrush'));
        out.hPointy    = hash(b.generatePreview('Thin Pointy'));
        out.hSplatter  = hash(b.generatePreview('Splatter Large'));
        out.distinct   = new Set([out.hRound, out.hFan, out.hAirbrush,
                                  out.hPointy, out.hSplatter]).size;

        // Rendering a swatch must not touch the document at all.
        const before = __B.hash(L);
        const steps  = app.state.history.length;
        const wasPreset = b._currentPreset;
        const wasSize = b.getParams().size;
        names.forEach(n => b.generatePreview(n));
        out.docUntouched   = __B.hash(L) === before;
        out.noUndoSteps    = app.state.history.length === steps;
        out.presetKept     = b._currentPreset === wasPreset;
        out.paramsKept     = b.getParams().size === wasSize;

        // A swatch is not the document, so the document's selection and alpha
        // lock must not clip it.
        app.state.selection = { x: 0, y: 0, w: 1, h: 1 };
        const clipped = b.generatePreview('Round');
        app.state.selection = null;
        out.ignoresSelection = ink(clipped) > 40;

        // Cached until something changes it.
        /* The cache is about not re-rendering, not about node identity:
         * each caller needs its own canvas, because a favourite's brush has
         * a tile in two groups and appending one node twice moves it. */
        const oOC = window.OffscreenCanvas;
        let built = 0;
        window.OffscreenCanvas = function (w, h) { built++; return new oOC(w, h); };
        b.generatePreview('Round');
        built = 0;
        const c1 = b.generatePreview('Round');
        const c2 = b.generatePreview('Round');
        window.OffscreenCanvas = oOC;
        const px = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data.join();
        out.cached = built === 0;
        out.freshNodes = c1 !== c2;
        out.samePixels = px(c1) === px(c2);
        return JSON.stringify(out);
    })()`);
    const so = JSON.parse(sw);
    console.log('  ' + sw);

    check('every stock preset paints a visible swatch', so.empty.length === 0,
        `blank: ${so.empty.join(', ')}`);
    check('visibly different presets produce different swatches',
        so.distinct === 5, `only ${so.distinct}/5 unique`);
    check('rendering swatches leaves the document untouched', so.docUntouched);
    check('rendering swatches adds no undo steps', so.noUndoSteps);
    check('rendering swatches does not change the active preset', so.presetKept);
    check('rendering swatches does not disturb live brush settings', so.paramsKept);
    check('a document selection does not clip a swatch', so.ignoresSelection);
    check('a swatch is cached until something invalidates it', so.cached,
        're-rendered on a repeat call');
    check('each caller gets its own swatch node, with the same pixels',
        so.freshNodes && so.samePixels,
        `freshNodes=${so.freshNodes} samePixels=${so.samePixels}`);

    /* A swatch is a whole stroke drawn in one go, its samples a hair apart,
     * and the pen-rate memory kept those gaps: the next stroke read as a
     * blur, and a speed-thinned brush (Clip Studio's Milli pen) drew 6px
     * where 10 were due. A clock that stands still has no speed. */
    const spd = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = __B.layer(), clock = performance.now;
        b.forgetSaved('Round'); b.loadPreset('Round');
        b.setParam('size', 20); b.setParam('spacing', 10); b.setParam('smoothingMode', 'none');
        b.setParam('sizeSrc', 'speed'); b.setParam('sizeMin', 0); b.setParam('sizeCurve', [[0, 1], [1, 0]]);
        const line = () => {
            L.ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(20, 100, 1, '#000000');
            for (let i = 1; i <= 220; i++) b.moveStroke(20 + i * 0.7, 100, 1, '#000000');
            b.endStroke();
        };
        performance.now = () => 0; line();          // the rate memory: all standing still
        let t = 0; performance.now = () => (t += 0.05);
        b.generatePreview('Round');                  // a tile drawn in a few ms
        performance.now = () => 0; line();
        performance.now = clock;
        const d = L.ctx.getImageData(100, 0, 1, 200).data;
        let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 127) n++;
        return JSON.stringify({ tall: n });
    })()`));
    check('a swatch leaves no pen speed behind for the next stroke', spd.tall >= 18,
        `a stroke with no speed drew ${spd.tall}px of a 20px brush`);

    /* No anti-aliasing: a soft brush lands as ink or paper only, and a
     * faint one thins to scattered ink rather than vanishing. */
    const al = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = __B.layer();
        b.forgetSaved('Round'); b.loadPreset('Round');
        b.setParam('size', 30); b.setParam('hardness', 0); b.setParam('aliased', true);
        L.ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(40, 100, 1, '#000000');
        for (let i = 1; i <= 24; i++) b.moveStroke(40 + i * 5, 100, 1, '#000000');
        b.endStroke();
        b.setParam('aliased', false);
        const d = L.ctx.getImageData(0, 0, 200, 200).data;
        let mid = 0, ink = 0;
        for (let i = 3; i < d.length; i += 4) {
            if (d[i] > 0 && d[i] < 255) mid++;
            if (d[i] === 255) ink++;
        }
        b.setParam('hardness', 100); b.setParam('flow', 25); b.setParam('aliased', true);
        L.ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(40, 100, 1, '#000000'); b.endStroke();
        b.setParam('aliased', false); b.setParam('flow', 100);
        const f = L.ctx.getImageData(0, 0, 200, 200).data;
        let faint = 0, faintMid = 0;
        for (let i = 3; i < f.length; i += 4) { if (f[i] === 255) faint++; else if (f[i]) faintMid++; }
        return JSON.stringify({ mid, ink, faint, faintMid });
    })()`));
    check('a brush with no anti-aliasing leaves no half-inked pixel', al.mid === 0 && al.ink > 500,
        JSON.stringify(al));
    check('...and a faint dab is thinned, not cut away',
        al.faint > 50 && al.faintMid === 0, JSON.stringify(al));

    /* Clip Studio's round dab (edgeRamp): anti-aliasing fades the rim over
     * that many px; soft, it runs out to root 2 of its size at hardness 0,
     * 0.9 at its centre. Measured on single dabs in Clip Studio. */
    const cr = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = __B.layer(), row = (s, h) => {
            b.setParam('size', s); b.setParam('hardness', h);
            L.ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(100, 100, 1, '#000000'); b.endStroke();
            const d = L.ctx.getImageData(0, 99, 200, 1).data, a = [];
            for (let i = 3; i < d.length; i += 4) if (d[i]) a.push(d[i]);
            return a;
        };
        b.forgetSaved('Round'); b.loadPreset('Round'); b.setParam('edgeRamp', 2.5);
        const hard = row(20, 100), soft = row(40, 0);
        b.setParam('edgeRamp', 0);
        return JSON.stringify({ hard: [hard.length, hard[0]], soft: [soft.length, Math.max(...soft)] });
    })()`));
    check('Clip Studio anti-aliasing fades a round rim over its px',
        cr.hard[0] === 20 && cr.hard[1] > 40 && cr.hard[1] < 65, JSON.stringify(cr));
    check('...and a soft one runs past its size, root 2 at hardness 0',
        cr.soft[0] >= 54 && cr.soft[0] <= 58 && cr.soft[1] > 215 && cr.soft[1] < 240, JSON.stringify(cr));

    /* Clip Studio's density of paint: each dab lands at density plus the
     * rest times the alpha under it, replacing what is there -- so on an
     * empty layer the line settles short of solid (Round mixing brush, 236
     * there), and colour stretch makes it fade in. */
    const mx = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = __B.layer();
        b.forgetSaved('Round'); b.loadPreset('Round');
        b.setParam('size', 30); b.setParam('hardness', 100); b.setParam('spacing', 10);
        const line = (stretch) => {
            b.setParam('mixAlpha', 50); b.setParam('mixStretch', stretch);
            L.ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(20, 100, 1, '#000000');
            for (let i = 1; i <= 160; i++) b.moveStroke(20 + i, 100, 1, '#000000');
            b.endStroke();
            b.setParam('mixAlpha', null); b.setParam('mixStretch', 0);
            const d = L.ctx.getImageData(0, 100, 200, 1).data;
            return [d[25 * 4 + 3], d[150 * 4 + 3]];
        };
        return JSON.stringify({ flat: line(0), fade: line(100) });
    })()`));
    check('density of paint settles a line short of solid', mx.flat[1] > 190 && mx.flat[1] < 245,
        JSON.stringify(mx));
    check('...and colour stretch fades it in', mx.fade[0] < mx.fade[1] - 30 && mx.flat[0] > mx.fade[0] + 30,
        JSON.stringify(mx));
    /* ...and a spray's load fades as the pen moves, not as its particles
     * jump: Pointillism climbs to 229 at most along Clip Studio's stroke
     * (cdp-csp/qp qpc). A pen that barely moves keeps its first load, so
     * its particles stay near the density's half. */
    const msp = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = __B.layer();
        b.forgetSaved('Round'); b.loadPreset('Round');
        for (const [k, v] of Object.entries({ size: 30, hardness: 100, spacing: 10, flowSrc: 'none', sizeSrc: 'none', smoothingMode: 'none',
            sprayEach: true, scatter: 60, scatterAxis: 'disk', dabCount: 4, mixAlpha: 50, mixStretch: 15 })) b.setParam(k, v);
        b._setStrokeSeed(7);
        L.ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(100, 100, 1, '#000000');
        for (let i = 1; i <= 20; i++) b.moveStroke(100 + i * 0.5, 100, 1, '#000000');
        b.endStroke();
        b.setParam('mixAlpha', null); b.setParam('mixStretch', 0); b.setParam('sprayEach', false); b.setParam('dabCount', 1); b.setParam('scatter', 0);
        b._setStrokeSeed(null);
        const d = L.ctx.getImageData(0, 0, 200, 200).data;
        let max = 0, n = 0;
        for (let q = 3; q < d.length; q += 4) { if (d[q] > max) max = d[q]; if (d[q]) n++; }
        return JSON.stringify({ max, n });
    })()`));
    check("...and a spray's load fades as the pen moves, not as its particles jump", msp.n > 2000 && msp.max < 215, JSON.stringify(msp));   // 240 fading particle to particle
    /* A mixing brush lays its paint on the layer itself; its second brush,
     * laid at the end, wiped it out (Wet wash, cdp-csp/qv). Mixing kind 1
     * lays the density flat, nothing picked up (cdp-csp/qo qod: 127). */
    const mxs = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = __B.layer();
        b.forgetSaved('Round'); b.loadPreset('Round');
        const run = (flat, sec) => {
            for (const [k, v] of Object.entries({ size: 30, hardness: 100, spacing: 10, flowSrc: 'none', sizeSrc: 'none', smoothingMode: 'none',
                mixAlpha: 50, mixStretch: 0, mixFlat: flat })) b.setParam(k, v);
            b.PRESETS.Round.second = sec ? { op: 'contrast', p: { size: 10, flow: 30, spacing: 10, hardness: 100 } } : undefined;
            L.ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(40, 100, 1, '#000000');
            for (let i = 1; i <= 30; i++) b.moveStroke(40 + i * 4, 100, 1, '#000000');
            b.endStroke();
            const d = L.ctx.getImageData(0, 0, 200, 200).data;
            let n = 0, mid = d[(100 * 200 + 140) * 4 + 3];
            for (let q = 3; q < d.length; q += 4) if (d[q]) n++;
            return { n, mid };
        };
        const r = { sec: run(false, true), flat: run(true, false) };
        delete b.PRESETS.Round.second;
        b.setParam('mixAlpha', null); b.setParam('mixFlat', false);
        return JSON.stringify(r);
    })()`));
    check('a mixing brush keeps its paint under its second brush', mxs.sec.n > 3000, JSON.stringify(mxs.sec));
    check("...and Clip Studio's mixing kind 1 lays its density flat", Math.abs(mxs.flat.mid - 128) < 6, JSON.stringify(mxs.flat));
    /* Clip Studio's amount of paint is how much of a dab is the brush's colour, the rest the colour under
     * it as the stroke began: zb046 at 50 over a blue field keeps 0.37 of its ink (cdp-csp/stk sw-am046).
     * A fresh document's white base is Clip Studio's paper, which mixing cannot read: the ink stays. */
    const mpk = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, app = PaintApp;
        const run = (base) => {
            __B.doc();
            if (base) { app.layerMgr.collapseToBase({ fresh: true }); app.ctx.fillStyle = '#ffffff'; app.ctx.fillRect(0, 0, 200, 200); }
            for (const [k, v] of Object.entries({ size: 30, hardness: 100, spacing: 10, flowSrc: 'none', sizeSrc: 'none', smoothingMode: 'none',
                mixAlpha: 50, mixStretch: 0, mixColor: 50 })) b.setParam(k, v);
            const ctx = base ? app.ctx : __B.layer().ctx;
            if (!base) { ctx.fillStyle = '#2d6edc'; ctx.fillRect(0, 70, 200, 60); }
            b.beginStroke(40, 100, 1, '#5a40d7');
            for (let i = 1; i <= 30; i++) b.moveStroke(40 + i * 4, 100, 1, '#5a40d7');
            b.endStroke();
            return [...ctx.getImageData(120, 100, 1, 1).data];
        };
        const r = { field: run(false), base: run(true) };
        __B.doc(); b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify(r);
    })()`));
    check('a mixing brush takes up the colour under it by its amount of paint', mpk.field[0] > 55 && mpk.field[0] < 75 && mpk.field[1] > 82 && mpk.field[1] < 100, JSON.stringify(mpk));
    check("...but not a fresh document's white, Clip Studio's paper", mpk.base[0] < 100 && mpk.base[1] < 80, JSON.stringify(mpk));

    /* Clip Studio's paper on each dab blends with the dab's alpha, flow
     * and all: linear light (4) is solid at full flow and the bare paper
     * at half (single dabs there). With the flow put on after the paper,
     * half flow came out a flat half. On a mixing brush the paper is how
     * fast a dab covers, so a line fills in flat (Gouache). */
    const pp = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, L = __B.layer();
        const sc = new OffscreenCanvas(64, 64), sx = sc.getContext('2d');
        for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
            sx.fillStyle = (x + y) & 1 ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.8)'; sx.fillRect(x, y, 1, 1);
        }
        const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); sc.convertToBlob().then(bl => fr.readAsDataURL(bl)); });
        b.forgetSaved('Round'); b.loadPreset('Round');
        const set = () => {
            b.setParam('size', 40); b.setParam('hardness', 100); b.setParam('spacing', 10);
            b.setParam('texture', 100); b.setParam('textureScale', 1); b.setParam('textureBlend', 4);
        };
        set(); b.setParam('texturePattern', url);
        await new Promise(r => setTimeout(r, 700));
        b.loadPreset('Round'); set();
        await new Promise(r => setTimeout(r, 800));
        const levels = (y) => {
            const d = L.ctx.getImageData(90, y - 5, 20, 10).data, v = new Set();
            for (let i = 3; i < d.length; i += 4) v.add(d[i]);
            return [...v].sort((p, q) => p - q);
        };
        const dab = (flow) => {
            b.setParam('flow', flow); L.ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(100, 100, 1, '#000000'); b.endStroke();
            return levels(100);
        };
        const full = dab(100), half = dab(50);
        b.setParam('textureBlend', 0); b.setParam('texture', 50);
        const m0 = dab(50);
        b.setParam('textureBlend', 4); b.setParam('texture', 60);
        const m4 = dab(25);
        b.setParam('texture', 100); b.setParam('textureContrast', 0.7);
        const ct = dab(50);
        b.setParam('textureContrast', 1);
        b.setParam('textureBlend', 1); b.setParam('texture', 20); b.setParam('textureStress', true);
        const st = dab(100);
        b.setParam('textureStress', false);
        b.setParam('flow', 100); b.setParam('textureBlend', 1); b.setParam('mixAlpha', 100);
        L.ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(20, 100, 1, '#000000');
        for (let i = 1; i <= 160; i++) b.moveStroke(20 + i, 100, 1, '#000000');
        b.endStroke();
        const mixed = levels(100);
        b.setParam('mixAlpha', null); b.setParam('textureBlend', null); b.setParam('texture', 0);
        b.setParam('texturePattern', null); b.forgetSaved('Round');
        return JSON.stringify({ full, half, mixed, m0, m4, ct, st });
    })()`, { awaitPromise: true }));
    /* Clip Studio's paper on the whole stroke: a dense line takes the
     * paper's own levels once (multiply at full: a x s, 0.3 and 0.8 of
     * ink), where on each dab the next one fills it back in. */
    const ps = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, L = __B.layer();
        const sc = new OffscreenCanvas(64, 64), sx = sc.getContext('2d');
        for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
            sx.fillStyle = (x + y) & 1 ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.8)'; sx.fillRect(x, y, 1, 1);
        }
        const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); sc.convertToBlob().then(bl => fr.readAsDataURL(bl)); });
        const out = [];
        b.forgetSaved('Round'); b.loadPreset('Round'); b.setParam('texture', 100); b.setParam('texturePattern', url);
        await new Promise(r => setTimeout(r, 700));
        for (const [st, inv] of [[1, false], [null, false], [1, true]]) {
            b.loadPreset('Round');
            for (const [k, v] of Object.entries({ size: 40, hardness: 100, spacing: 5, flowSrc: 'none', sizeSrc: 'none', smoothingMode: 'none',
                    texture: 100, textureScale: 1, textureStroke: st, textureInvert: inv })) b.setParam(k, v);
            await new Promise(r => setTimeout(r, 800));
            L.ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(40, 100, 1, '#000000');
            for (let i = 1; i <= 120; i++) b.moveStroke(40 + i, 100, 1, '#000000');
            b.endStroke();
            const d = L.ctx.getImageData(90, 95, 20, 10).data, v = [];
            for (let i = 3; i < d.length; i += 4) v.push(d[i]);
            v.sort((p, q) => p - q);
            out.push([v[0], v[v.length >> 1], v[v.length - 1]]);
        }
        b.setParam('texture', 0); b.setParam('textureStroke', null); b.setParam('textureInvert', false); b.setParam('texturePattern', null); b.forgetSaved('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify(ps));
    check("Clip Studio's paper on the whole stroke lays its own levels once, not filled back in by the next dab",
        Math.abs(ps[0][0] - 77) <= 4 && Math.abs(ps[0][2] - 204) <= 4 && ps[1][1] > 230, JSON.stringify(ps));
    /* Reverse density reads 0.3 and 0.8 paper as 0.7 and 0.2. */
    check("Clip Studio's reversed paper lays the paper's levels inverted",
        Math.abs(ps[2][0] - 51) <= 4 && Math.abs(ps[2][2] - 179) <= 4, JSON.stringify(ps));
    /* Clip Studio's mode-12 second brush with its colour change off
     * ('contrast'): a + (1 - 2d) min(a, 1 - a), on the stroke WITH its
     * paper. Under a solid second brush the 0.3 and 0.8 paper go to 0 and
     * 0.6; read before the paper, the solid line moved nothing (Wet
     * blotting ink, cdp-csp/qw). Where the second brush is absent, faint
     * ink doubles: a lone faint dab's rim gains as much again. */
    const pc = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        const sc = new OffscreenCanvas(64, 64), sx = sc.getContext('2d');
        for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
            sx.fillStyle = (x + y) & 1 ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.8)'; sx.fillRect(x, y, 1, 1);
        }
        const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); sc.convertToBlob().then(bl => fr.readAsDataURL(bl)); });
        const out = {};
        b.forgetSaved('Round'); b.loadPreset('Round'); b.setParam('texture', 100); b.setParam('texturePattern', url);
        await new Promise(r => setTimeout(r, 700));
        for (const paper of [true, false, 'none']) { const P = paper === true;
            __B.doc(400, 200);
            if (paper !== 'none') b.PRESETS.Round.second = { op: 'contrast', p: { size: P ? 60 : 10, flow: 100, spacing: 10, hardness: 100 } };
            b.loadPreset('Round');
            b.setParam('dynamicsMode', 'off'); b.setParam('scatter', 0);
            b.setParam('size', 40); b.setParam('hardness', 100);
            if (P) {
                for (const [k, v] of Object.entries({ spacing: 5, texture: 100, texturePattern: url, textureScale: 1, textureStroke: 1 })) b.setParam(k, v);
                await new Promise(r => setTimeout(r, 800));
            } else { b.setParam('spacing', 400); b.setParam('flow', 20); }
            const L = __B.layer();
            await __B.stroke(20, 100, 380, 100, '#000000');
            if (P) {
                const d = L.ctx.getImageData(190, 95, 20, 10).data, v = [];
                for (let i = 3; i < d.length; i += 4) v.push(d[i]);
                v.sort((p, q) => p - q);
                out.paper = [v[0], v[v.length - 1]];
            } else out[paper ? 'bare' : 'lone'] = [__B.px(L, 20, 100), __B.px(L, 20, 115)].map(s => +s.split(',')[3]);
            delete b.PRESETS.Round.second;
        }
        b.setParam('texture', 0); b.setParam('textureStroke', null); b.setParam('texturePattern', null); b.setParam('flow', 100); b.forgetSaved('Round');
        b.loadPreset('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    check("Clip Studio's second brush with its colour change off pushes the papered stroke away from half",
        pc.paper[0] <= 4 && Math.abs(pc.paper[1] - 153) <= 5, JSON.stringify(pc));
    check("...and doubles faint ink where it is absent",
        pc.lone[0] <= 4 && Math.abs(pc.lone[1] - 2 * pc.bare[1]) <= 3, JSON.stringify(pc));

    /* Blend 0 at half density scales the paper in, a (1.5 - d (1 - s)):
     * 0.3 and 0.8 paper under a 0.5 dab give 0.58 and 0.70 (Soft bleed's
     * paper in Clip Studio); mixed with the bare dab it gave 0.45 and 0.58. */
    check('Clip Studio paper: blend 0 at half density is half again the dab, less the paper',
        pp.m0.length === 2 && Math.abs(pp.m0[0] - 147) <= 3 && Math.abs(pp.m0[1] - 179) <= 3, JSON.stringify(pp.m0));
    /* Linear light is mixed with the bare dab before it is clipped: a 0.25
     * dab at density 60 under 0.3 paper is gone (Pastel's paper in Clip
     * Studio), where clipped first it kept 26. Contrast 0.7 pulls 0.3 and
     * 0.8 to 0.36 and 0.71. */
    check('Clip Studio paper: linear light at density 60 takes a faint dab to nothing on light paper',
        pp.m4.length === 2 && pp.m4[0] === 0 && Math.abs(pp.m4[1] - 71) <= 3, JSON.stringify(pp.m4));
    check('...and contrast spreads the paper about its mid grey',
        pp.ct.length === 2 && Math.abs(pp.ct[0] - 92) <= 3 && Math.abs(pp.ct[1] - 181) <= 3, JSON.stringify(pp.ct));
    /* Emphasised density (Oil paint) lays the paper at full, stretched
     * density/10 times about its mean (cdp-csp/pst): at 20 the 0.3/0.8
     * paper (mean 0.55) goes to 0.05 and 1; plain multiply at 20 left
     * 0.86 and 0.96, and Oil paint lay 248 where Clip Studio lays 238. */
    check("Clip Studio's emphasised paper density stretches the paper about its mean",
        pp.st.length === 2 && Math.abs(pp.st[0] - 13) <= 3 && pp.st[1] >= 252, JSON.stringify(pp.st));
    check('Clip Studio paper: linear light is solid at full flow', pp.full.length === 1 && pp.full[0] === 255,
        JSON.stringify(pp));
    check('...and the bare paper at half flow', pp.half.length >= 2 && pp.half[0] < 100 && pp.half[pp.half.length - 1] > 180,
        JSON.stringify(pp));
    check('...and a mixing line fills its paper in flat', pp.mixed[0] > 240 && pp.mixed[pp.mixed.length - 1] - pp.mixed[0] <= 10,
        JSON.stringify(pp));

    console.log('');
    console.log('== editing a brush redraws its own swatch ==');
    const sw2 = await page.eval(`(async () => {
        const b = PaintApp.brush;
        __B.doc();
        const hash = (c) => {
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let a = 0x811c9dc5;
            for (let i = 0; i < d.length; i++) a = ((a ^ d[i]) * 16777619) >>> 0;
            return a.toString(16);
        };
        b.loadPreset('Round');
        const before = hash(b.generatePreview('Round'));
        b.setParam('size', b.getParams().size * 2.5);
        await new Promise(r => requestAnimationFrame(r));
        const after = hash(b.generatePreview('Round'));
        return JSON.stringify({ changed: before !== after });
    })()`, { awaitPromise: true });
    check('changing a setting changes the active preset swatch',
        JSON.parse(sw2).changed, 'the tile still shows the old brush');

    /* -- per-parameter dynamics ----------------------------------------- */
    console.log('');
    console.log('== every parameter has its own input ==');
    const dyn = await page.eval(`(() => {
        const app = PaintApp, b = app.brush;
        const L0 = __B.doc();
        const hash = () => __B.hash(__B.layer());
        const inkOf = () => {
            const d = __B.layer().ctx.getImageData(0, 0, 200, 200).data;
            let n = 0, sum = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 0) { n++; sum += d[i]; }
            return { px: n, meanAlpha: n ? Math.round(sum / n) : 0 };
        };
        // A stroke of CONSTANT pressure, so anything that varies must come
        // from the sensor under test rather than from the pressure ramp.
        const stroke = (pressure, pen) => {
            __B.layer().ctx.clearRect(0, 0, 200, 200);
            if (pen && b.setPenState) b.setPenState(pen);
            b.beginStroke(20, 100, pressure, '#000000');
            for (let i = 1; i <= 30; i++) {
                if (pen && b.setPenState) b.setPenState(pen);
                b.moveStroke(20 + i * 5, 100, pressure, '#000000');
            }
            b.endStroke();
        };
        const fresh = () => {
            PaintApp.brush.forgetSaved('Round');
            b.loadPreset('Round');
            b.setParam('size', 20); b.setParam('spacing', 12);
            b.setParam('scatter', 0); b.setParam('smoothingMode', 'none');
        };
        const out = {};

        // -- defaults reproduce the old hardcoded pressure behaviour --------
        fresh();
        out.defSizeSrc = b.getParams().sizeSrc;
        out.defSizeMin = b.getParams().sizeMin;
        out.defFlowSrc = b.getParams().flowSrc;
        out.defFlowMin = b.getParams().flowMin;

        // -- pressure still drives size by default --------------------------
        fresh(); stroke(0.2); const lightPx = inkOf().px;
        fresh(); stroke(1.0); const heavyPx = inkOf().px;
        out.pressureWidensStroke = heavyPx > lightPx * 1.4;

        // -- and can be switched OFF, which was impossible before ------------
        fresh();
        b.setParam('sizeSrc', 'none');
        stroke(0.2); const offLight = inkOf().px;
        stroke(1.0); const offHeavy = inkOf().px;
        out.sizeCanIgnorePressure = Math.abs(offHeavy - offLight) < offHeavy * 0.05;

        // -- the floor sets how far it collapses ----------------------------
        fresh(); b.setParam('sizeMin', 0);  stroke(0.1); const floor0 = inkOf().px;
        fresh(); b.setParam('sizeMin', 90); stroke(0.1); const floor90 = inkOf().px;
        out.floorRaisesMinimum = floor90 > floor0 * 1.3;

        // -- the curve reshapes the response --------------------------------
        fresh(); b.setParam('sizeCurve', 1); stroke(0.5); const g1 = inkOf().px;
        fresh(); b.setParam('sizeCurve', 3); stroke(0.5); const g3 = inkOf().px;
        out.curveChangesResponse = g1 !== g3;

        // -- TILT, which nothing read before --------------------------------
        fresh();
        b.setParam('sizeSrc', 'tilt'); b.setParam('sizeMin', 0);
        stroke(0.8, { tiltX: 0, tiltY: 0, twist: 0 });   const upright = inkOf().px;
        stroke(0.8, { tiltX: 85, tiltY: 0, twist: 0 });  const flat = inkOf().px;
        out.tiltDrivesSize = flat > upright * 1.4;
        // Krita's elevation reads the other way up: 1 upright (and for a
        // mouse), 0 at 60 degrees -- measured against Krita's Marker Chisel.
        fresh();
        b.setParam('sizeSrc', 'elevation'); b.setParam('sizeMin', 0);
        stroke(0.8, { tiltX: 0, tiltY: 0, twist: 0 });   const eUp = inkOf().px;
        stroke(0.8, { tiltX: 60, tiltY: 0, twist: 0 });  const eFlat = inkOf().px;
        out.elevationIsKritasWayUp = eUp > eFlat * 3;
        // Krita's per-dab opacity caps the stroke rather than adding ink:
        // tightly overlapping dabs at half pressure stop at half alpha.
        fresh();
        b.setParam('flowSrc', 'none'); b.setParam('hardness', 100);
        b.setParam('dabOpacitySrc', 'pressure');
        stroke(0.5);
        { const d = __B.layer().ctx.getImageData(0, 0, 200, 200).data; let m = 0;
          for (let i = 3; i < d.length; i += 4) if (d[i] > m) m = d[i];
          out.dabOpacityCapsAt = m; }

        // -- pen rotation ---------------------------------------------------
        fresh();
        b.setParam('aspectRatio', 5); b.setParam('angleSrc', 'twist');
        stroke(0.8, { tiltX: 0, tiltY: 0, twist: 0 });   const tw0 = hash();
        stroke(0.8, { tiltX: 0, tiltY: 0, twist: 90 });  const tw90 = hash();
        out.twistRotatesTip = tw0 !== tw90;

        // -- hardness and scatter, which had no dynamics at all -------------
        fresh();
        b.setParam('hardnessSrc', 'pressure'); b.setParam('hardnessMin', 0);
        b.setParam('sizeSrc', 'none');   // isolate hardness from size
        stroke(0.15); const softA = hash();
        stroke(1.0);  const hardA = hash();
        out.hardnessDrivable = softA !== hardA;

        fresh();
        b.setParam('scatter', 60);
        b.setParam('scatterSrc', 'pressure'); b.setParam('scatterMin', 0);
        b.setParam('sizeSrc', 'none');   // isolate scatter from size
        stroke(0.1); const tight = inkOf().px;
        stroke(1.0); const loose = inkOf().px;
        out.scatterDrivable = loose > tight * 1.2;

        // -- independence: two parameters on different inputs at once -------
        fresh();
        b.setParam('sizeSrc', 'pressure');
        b.setParam('hardnessSrc', 'tilt');
        out.independent = b.getParams().sizeSrc === 'pressure'
                       && b.getParams().hardnessSrc === 'tilt';

        // -- the old dropdown still works as a shortcut ---------------------
        fresh();
        b.setParam('dynamicsMode', 'size');
        out.shimSetsSizeSrc = b.getParams().sizeSrc === 'random';
        b.setParam('dynamicsMode', 'off');
        out.shimRestores = b.getParams().sizeSrc === 'pressure'
                        && b.getParams().sizeMin === 50;
        return JSON.stringify(out);
    })()`);
    const d = JSON.parse(dyn);
    console.log('  ' + JSON.stringify(d, null, 1).replace(/\n/g, '\n  '));

    check('size defaults to the pressure response it always had',
        d.defSizeSrc === 'pressure' && d.defSizeMin === 50,
        `${d.defSizeSrc}/${d.defSizeMin}`);
    check('flow defaults to the pressure response it always had',
        d.defFlowSrc === 'pressure' && d.defFlowMin === 0,
        `${d.defFlowSrc}/${d.defFlowMin}`);
    check('pressure still widens a stroke', d.pressureWidensStroke);
    check('pressure-to-size can now be turned off', d.sizeCanIgnorePressure);
    check('the floor sets how far a parameter collapses', d.floorRaisesMinimum);
    check('the curve reshapes the response', d.curveChangesResponse);
    check('tilt drives a parameter', d.tiltDrivesSize);
    check("Krita's elevation is full upright and nothing at 60 degrees", d.elevationIsKritasWayUp);
    check("Krita's dab opacity is a ceiling the stroke builds to, not past",
        Math.abs(d.dabOpacityCapsAt - 128) <= 8, 'max alpha ' + d.dabOpacityCapsAt);

    /* Clip Studio caps each dab at its own opacity, where Krita's running
     * average keeps a falling one high: a 0.6 dab over 0.5 of ink takes
     * half of the step to 0.6, not toward Krita's 0.96 average. */
    const avg = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = __B.layer(), out = [];
        for (const a of [true, false]) {
            b.forgetSaved('Round'); b.loadPreset('Round');
            for (const [k, v] of Object.entries({ size: 40, spacing: 25, hardness: 100, flow: 50, flowSrc: 'none', sizeSrc: 'none',
                    smoothingMode: 'none', dabOpacitySrc: 'pressure', dabOpacityMin: 0, dabOpacityCurve: 1, dabOpacityAvg: a })) b.setParam(k, v);
            L.ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(100, 100, 1, '#000000'); b.moveStroke(110, 100, 0.6, '#000000'); b.endStroke();
            out.push(L.ctx.getImageData(105, 100, 1, 1).data[3]);
        }
        b.setParam('dabOpacityAvg', true); b.setParam('dabOpacitySrc', 'none');
        return JSON.stringify(out);
    })()`));
    console.log('  ' + JSON.stringify(avg));
    check('a Clip Studio dab caps the stroke at its own opacity, not at a running average',
        avg[1] < avg[0] - 10 && Math.abs(avg[1] - 140) <= 8, JSON.stringify(avg));
    /* Krita's texture removes ink (subtract: a - (m + 1 - s)); our grey-tint
     * grain on an opaque pattern removed none, so Chalk Soft came out 1.6x
     * too dark against real Krita. A flat mid-grey pattern at strength 1
     * must take a solid dab to half. */
    const kt = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        const c = document.createElement('canvas'); c.width = c.height = 8;
        const x = c.getContext('2d'); x.fillStyle = '#808080'; x.fillRect(0, 0, 8, 8);
        const url = c.toDataURL();
        const run = (mode, more = {}) => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            b.setParam('size', 20); b.setParam('spacing', 12); b.setParam('hardness', 100);
            b.setParam('flowSrc', 'none'); b.setParam('sizeSrc', 'none'); b.setParam('smoothingMode', 'none');
            b.setParam('texture', 100); b.setParam('textureMode', mode);
            for (const k in more) b.setParam(k, more[k]);
            b.loadTexturePattern(url);
            __B.layer().ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(20, 100, 1, '#000000');
            b.endStroke();   // one dab: overlapping dabs stack back toward solid, in Krita too
            return __B.layer().ctx.getImageData(20, 100, 1, 1).data[3];
        };
        run('subtract');
        await new Promise(r => setTimeout(r, 300));   // the pattern decodes async
        const sub = run('subtract'), mul = run('multiply');
        // grey 128 sits below a cutoff range starting at 200: policy 2 fills
        // white AFTER Invert (Krita probe i0p2), so a multiply dab stays solid
        const cut = run('multiply', { textureInvert: true, textureCutoff: 2, textureCutoffLo: 200, textureCutoffHi: 255 });
        // ...and the range itself is tested after Invert (KisTextureMaskInfo): grey 128
        // inverted is 127, inside 0..130, so policy 1 keeps it. Tested on the raw grey,
        // Natural Media Pastel's inverted paper was cut away whole.
        const cutIn = run('multiply', { textureInvert: true, textureCutoff: 1, textureCutoffLo: 0, textureCutoffHi: 130 });
        // Height (probes/texmode): a/u - u - m*0.5/neutral with u = 1 - strength
        const h30 = run('height', { texture: 30 }), hNp = run('height', { texture: 30, textureNeutral: 0.25 });
        return JSON.stringify({ sub, mul, cut, cutIn, h30, hNp });
    })()`, { awaitPromise: true }));
    check("Krita's subtract texture takes ink away, not just tints it",
        Math.abs(kt.sub - 128) <= 6, 'alpha ' + kt.sub);
    check("...and multiply scales it by the pattern",
        Math.abs(kt.mul - 128) <= 6, 'alpha ' + kt.mul);
    check("a texture's cutoff fill lands after Invert, as Krita's does",
        kt.cut >= 250, 'alpha ' + kt.cut);
    check("...and its cutoff range reads the inverted grey",
        Math.abs(kt.cutIn - 127) <= 8, 'alpha ' + kt.cutIn);
    check("Krita's height texture rises with strength and the neutral point scales the grain",
        Math.abs(kt.h30 - 58) <= 4 && kt.hNp <= 2, 'alpha ' + kt.h30 + ', ' + kt.hNp);
    /* Enlarged, Krita's pattern is plain bilinear between pixel centres
     * (a lone texture_fabric dab over the bare one, to half a grey level):
     * black/white columns at scale 2 read 0, 64, 191, 191, repeating. */
    const kb = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        const c = document.createElement('canvas'); c.width = 4; c.height = 1;
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 4, 1);
        x.fillStyle = '#000'; x.fillRect(0, 0, 1, 1); x.fillRect(2, 0, 1, 1);
        const run = () => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            for (const [k, v] of Object.entries({ size: 20, hardness: 100, falloff: 'krita', flowSrc: 'none', sizeSrc: 'none',
                smoothingMode: 'none', texture: 100, textureMode: 'multiply', textureScale: 2 })) b.setParam(k, v);
            b.loadTexturePattern(c.toDataURL());
            __B.layer().ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(20, 100, 1, '#000000'); b.endStroke();
            const d = __B.layer().ctx.getImageData(16, 100, 4, 1).data;
            return [d[3], d[7], d[11], d[15]];
        };
        run(); await new Promise(r => setTimeout(r, 300));
        const r = run();
        b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify(r);
    })()`, { awaitPromise: true }));
    check("an enlarged Krita texture is bilinear between pixel centres",
        [0, 64, 191, 191].every((v, i) => Math.abs(kb[i] - v) <= 3), 'columns ' + kb);
    /* Krita's grain is fixed to canvas pixels (probes/gchar). Dabs drawn at
     * fractions slid it half a pixel from dab to dab, so a stroke refilled
     * the columns a 1px striped pattern cuts out. */
    const ks = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        const c = document.createElement('canvas'); c.width = c.height = 2;
        const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 2, 2); x.fillStyle = '#fff'; x.fillRect(1, 0, 1, 2);
        const url = c.toDataURL();
        const run = (off = 0) => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            b.setParam('size', 20); b.setParam('spacing', 7); b.setParam('hardness', 100); b.setParam('textureOffsetX', off);
            b.setParam('flowSrc', 'none'); b.setParam('sizeSrc', 'none'); b.setParam('smoothingMode', 'none');
            b.setParam('texture', 100); b.setParam('textureMode', 'subtract'); b.setParam('textureScale', 1);
            b.loadTexturePattern(url);
            __B.layer().ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(40.3, 100.4, 1, '#000000');
            for (let i = 1; i <= 30; i++) b.moveStroke(40.3 + i * 1.37, 100.4, 1, '#000000');
            b.endStroke();
            const d = __B.layer().ctx.getImageData(60, 100, 20, 1).data, a = [];
            for (let i = 3; i < d.length; i += 4) a.push(d[i]);
            return a;
        };
        run(); await new Promise(r => setTimeout(r, 300));   // the pattern decodes async
        const a = run(), o = run(1);
        return JSON.stringify({ black: Math.min(...a.filter((_, i) => i % 2 === 0)), white: Math.max(...a.filter((_, i) => i % 2 === 1)),
            offBlack: Math.min(...o.filter((_, i) => i % 2 === 1)), offWhite: Math.max(...o.filter((_, i) => i % 2 === 0)) });
    })()`, { awaitPromise: true }));
    check("Krita's grain stays on its canvas pixels down a stroke, not smeared from dab to dab",
        ks.black > 250 && ks.white < 5, JSON.stringify(ks));
    check("...and its offset moves the grain across the canvas (KisTextureOption: Bristle_frottis0797)",
        ks.offBlack > 250 && ks.offWhite < 5, JSON.stringify(ks));
    // Shrunk, Qt's smooth scale averages each pixel's footprint: 1 black + 2 white of 6 at a third is 170, alpha 85 left
    const kd = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        const c = document.createElement('canvas'); c.width = 6; c.height = 6;
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 6, 6); x.fillStyle = '#000'; x.fillRect(0, 0, 1, 6);
        const url = c.toDataURL();
        const run = () => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            for (const [k, v] of Object.entries({ size: 20, spacing: 400, hardness: 100, flowSrc: 'none', sizeSrc: 'none', smoothingMode: 'none',
                texture: 100, textureMode: 'subtract', textureScale: 1 / 3 })) b.setParam(k, v);
            b.loadTexturePattern(url);
            __B.layer().ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(100, 100, 1, '#000000'); b.endStroke();
            const d = __B.layer().ctx.getImageData(96, 100, 8, 1).data, a = [];
            for (let i = 3; i < d.length; i += 4) a.push(d[i]);
            return a;
        };
        run(); await new Promise(r => setTimeout(r, 300));
        const r = run();
        b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify(r);
    })()`, { awaitPromise: true }));
    check("a shrunk Krita texture averages each pixel's footprint, as Qt's smooth scale (Grease Pencil)",
        Math.min(...kd) <= 2 && Math.abs(Math.max(...kd) - 85) <= 3, 'columns ' + kd);
    /* A colour smudge writes the layer itself, so it has to grain its own
     * dabs: it skipped texture and pastel_014 laid 6x Krita's ink. */
    const st = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        const c = document.createElement('canvas'); c.width = c.height = 8;
        const x = c.getContext('2d'); x.fillStyle = '#808080'; x.fillRect(0, 0, 8, 8);
        const url = c.toDataURL();
        const run = (tex) => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            for (const [k, v] of Object.entries({ smudgeMode: 0, colorRate: 100, smudgeRate: 25, size: 30, hardness: 100,
                falloff: 'krita', autoSpacing: 0.3, flowSrc: 'none', sizeSrc: 'none', colorRateSrc: 'none', smoothingMode: 'none',
                texture: tex, textureMode: 'multiply' })) b.setParam(k, v);
            b.loadTexturePattern(url);
            __B.layer().ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(90, 100, 1, '#000000');
            for (let i = 91; i <= 100; i++) b.moveStroke(i, 100, 1, '#000000');
            b.endStroke();
            return __B.layer().ctx.getImageData(95, 100, 1, 1).data[3];
        };
        run(100); await new Promise(r => setTimeout(r, 300));   // the pattern decodes async
        return JSON.stringify({ plain: run(0), grained: run(100) });
    })()`, { awaitPromise: true }));
    check('a colour smudge dab is grained by its texture too',
        st.plain > 100 && st.grained < st.plain * 0.75, JSON.stringify(st));
    /* Krita's merged smudge (MergedPaint) picks up from the whole picture
     * and paints only its layer: over a white Background, black paint on an
     * empty layer comes out opaque grey. Off the layer alone it came out
     * see-through black, and EO Smudge Wet scored 0.72 against Krita. */
    const mg = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, out = [];
        for (const smudgeMerged of [false, true]) {
            __B.doc();
            for (const [k, v] of Object.entries({ smudgeMode: 1, colorRate: 10, smudgeRate: 100, size: 30, hardness: 100,
                falloff: 'krita', autoSpacing: 0.3, flowSrc: 'none', sizeSrc: 'none', colorRateSrc: 'none', smoothingMode: 'none',
                smudgeMerged })) b.setParam(k, v);
            b.beginStroke(60, 100, 1, '#000000');
            for (let i = 61; i <= 140; i++) b.moveStroke(i, 100, 1, '#000000');
            b.endStroke();
            out.push([...__B.layer().ctx.getImageData(120, 100, 1, 1).data]);
        }
        b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify(out);
    })()`));
    /* Krita's new smudge engine lays paint at colour rate SQUARED a dab and
     * copies the mix through the tip whole: at 12% the old engine's rule laid
     * half as much again, and EO Smudge Color scored 0.21 against Krita. */
    const nws = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, out = [];
        for (const smudgeNew of [false, true]) {
            __B.doc();
            for (const [k, v] of Object.entries({ smudgeMode: 0, colorRate: 12, smudgeRate: 50, size: 30, hardness: 100,
                falloff: 'krita', spacing: 3, flowSrc: 'none', sizeSrc: 'none', colorRateSrc: 'none', smudgeRateSrc: 'none',
                smoothingMode: 'none', smudgeNew })) b.setParam(k, v);
            b.beginStroke(40, 100, 1, '#000000');
            for (let i = 41; i <= 160; i++) b.moveStroke(i, 100, 1, '#000000');
            b.endStroke();
            out.push(__B.layer().ctx.getImageData(150, 100, 1, 1).data[3]);
        }
        b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify(out);
    })()`));
    check("Krita's new smudge engine lays colour rate squared, not the old engine's share",
        nws[0] > 180 && nws[1] > 100 && nws[1] < 170, JSON.stringify(nws));
    check('a merged smudge picks the Background up: opaque grey, not see-through black',
        mg[0][3] < 200 && mg[1][3] > 240 && mg[1][0] > 100 && mg[1][0] < 250, JSON.stringify(mg));
    /* Krita's hatching brush (test/krita/probes/hatch): lines fixed to the
     * canvas through the origin pixel, thickness/2 wide, drawn afresh in
     * every dab (HatchingBrush::hatch). It used to paint as a
     * plain round brush, 1.4-3.7x Krita's ink. */
    const ht = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        const run = (angle, thickness = 6, extra = {}) => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            for (const [k, v] of Object.entries({ size: 40, hardness: 100, spacing: 5, flowSrc: 'none', sizeSrc: 'none',
                smoothingMode: 'none', hatch: { angle, separation: 6, thickness, ox: 0, oy: 0, intervals: 2, aa: true,
                style: null, xs: null, whole: false, thick: { v: 0.5 }, sep: { v: 0.5 }, ...extra } })) b.setParam(k, v);
            __B.layer().ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(60, 100, 1, '#000000');
            for (let i = 61; i <= 140; i++) b.moveStroke(i, 100, 1, '#000000');
            b.endStroke();
            return Array.from(__B.layer().ctx.getImageData(100, 90, 1, 12).data.filter((_, i) => i % 4 === 3));
        };
        const flat = run(0), steep = [];
        const d = (run(-60), __B.layer().ctx.getImageData(90, 90, 20, 20).data);
        for (let i = 3; i < d.length; i += 4) steep.push(d[i]);
        // Krita rounds the width to whole pixels: 6.3 / 2 is 3 rows, not 4 (Hatching Lines: 1.31x the ink)
        const odd = run(0, 6.3).filter(a => a > 128).length;
        run(-60, 2);
        const row = Array.from(__B.layer().ctx.getImageData(90, 100, 21, 1).data.filter((_, i) => i % 4 === 3));
        // moire turns the lines by the crosshatching sensor x 360 and lays no base pass: 0.25 -> upright
        run(0, 6, { style: 'moirepattern', xs: { v: 0.25 } });
        const moire = Array.from(__B.layer().ctx.getImageData(90, 96, 12, 1).data.filter((_, i) => i % 4 === 3));   // row 96 lies on a level line
        return JSON.stringify({ flat, odd, solid: row.filter(a => a > 250).length, row, moire });
    })()`));
    check('hatch lines sit on the canvas: rows 5-7 of every 6 inked at 0 degrees',
        ht.flat.every((a, i) => ((90 + i) % 6 === 5 || (90 + i) % 6 === 0 || (90 + i) % 6 === 1) ? a > 250 : a < 5),
        JSON.stringify(ht.flat));
    check("...a fractional thickness rounds to whole pixels, as Krita's qRound does", ht.odd === 6, ht.odd + ' of 12 rows');
    check("...and a slanted 1px line's dabs build its soft edges up to about 2px solid, as Krita's alpha darken does",
        ht.solid >= 5, JSON.stringify(ht.row));
    check("...and Krita's moire style turns them by its crosshatching sensor, with no level pass under them",
        ht.moire.filter(a => a > 250).length === 6 && ht.moire.filter(a => a < 5).length === 6, JSON.stringify(ht.moire));
    /* Krita's grid brush (bank: Grid_square_25): every 25 px from the first
     * point, never at the last, the canvas cell under the pen fills with
     * 2x2 circles. It used to paint as a round brush (IoU 0.30). */
    const gr = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        b.forgetSaved('Round'); b.loadPreset('Round');
        for (const [k, v] of Object.entries({ size: 25, flowSrc: 'none', sizeSrc: 'none', smoothingMode: 'none',
            grid: { w: 25, h: 25, scale: 1, div: 2, shape: 0 } })) b.setParam(k, v);
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(40, 50, 1, '#000000');
        for (let i = 41; i <= 140; i++) b.moveStroke(i, 50, 1, '#000000');
        b.endStroke();
        const a = (x, y) => __B.layer().ctx.getImageData(x, y, 1, 1).data[3];
        // circle centres of cells 25..125 at x + 6.25; the cell of the end point (125) stays empty
        return JSON.stringify({ first: a(31, 56), last: a(106, 68), end: a(131, 56), gap: a(37, 62) });
    })()`));
    check('a grid brush fills the canvas cells it passes, not the cell it ends in',
        gr.first > 250 && gr.last > 250 && gr.end === 0 && gr.gap < 128, JSON.stringify(gr));
    /* kis_grid_paintop.cpp: a dab covers the diameter (size) in tiles of
     * cell/divisionLevel, a rectangle filled at its truncated corner and size.
     * A 3x2 cell in halves, size 3, fills "##." on three rows -- as Krita
     * paints HatiGamedev's pixel vertical-rect (IoU 0.25 -> 0.997). */
    const gtile = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        b.forgetSaved('Round'); b.loadPreset('Round');
        for (const [k, v] of Object.entries({ size: 3, flowSrc: 'none', sizeSrc: 'none', smoothingMode: 'none',
            grid: { w: 3, h: 2, scale: 1, div: 2, shape: 1 } })) b.setParam(k, v);
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(10, 50.5, 1, '#000000');
        for (let i = 11; i <= 40; i++) b.moveStroke(i, 50.5, 1, '#000000');
        b.endStroke();
        const a = (x, y) => __B.layer().ctx.getImageData(x, y, 1, 1).data[3];
        return JSON.stringify([49, 50, 51, 52, 53].map(y => [30, 31, 32].map(x => a(x, y) > 128 ? '#' : '.').join('')));
    })()`));
    check("a grid's half-pixel tiles fill whole pixels from their truncated corners, over the brush's size",
        gtile.join('|') === '...|##.|##.|##.|...', JSON.stringify(gtile));
    /* Krita's spray (spray_brush.cpp): dabs of particles thrown over a disc
     * of the diameter, not a round dab. Starfield, Hearts and the rest used
     * to paint as an ordinary brush (Starfield 98x Krita's ink). */
    const spr = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        b.forgetSaved('Round'); b.loadPreset('Round');
        for (const [k, v] of Object.entries({ size: 60, flowSrc: 'none', sizeSrc: 'none', smoothingMode: 'none',
            kspray: { tip: 0, aspect: 1, rot: 0, scale: 1, spacing: 0.5, jitter: 0, density: 0, count: 20, radial: 1, sd: 0.5,
                shape: 0, w: 3, h: 3, prop: false, randomSize: false, fixedRot: 0, randomRot: 0, followCursor: 0, followDrawing: 0,
                randomOpacity: false, perParticle: false } })) b.setParam(k, v);
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(40, 100, 1, '#000000');
        for (let i = 41; i <= 140; i++) b.moveStroke(i, 100, 1, '#000000');
        b.endStroke();
        const d = __B.layer().ctx.getImageData(0, 0, 200, 200).data;
        let band = 0, far = 0, out = 0;
        for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
            if (d[(y * 200 + x) * 4 + 3] < 128) continue;
            if (Math.hypot(Math.max(0, Math.max(40 - x, x - 140)), y - 100) > 32) out++;
            else if (Math.abs(y - 100) > 15) far++; else band++;
        }
        return JSON.stringify({ band, far, out });
    })()`));
    check('a Krita spray throws specks over its diameter instead of laying a round line',
        spr.band > 50 && spr.far > 50 && spr.band < 1500 && spr.out === 0, JSON.stringify(spr));
    /* A Krita generated tip's density keeps each pixel by chance, fresh
     * every dab (kis_brush_mask_scalar_applicator.h). Ignored, Chalk, Pencil
     * 4B and Dry Marker (density 0.5) laid twice Krita's ink. */
    const dens = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        b.forgetSaved('Round'); b.loadPreset('Round');
        for (const [k, v] of Object.entries({ size: 30, hardness: 100, opacity: 100, flow: 100, spacing: 1000,
            flowSrc: 'none', sizeSrc: 'none', smoothingMode: 'none', tipDensity: 0.5 })) b.setParam(k, v);
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(100, 100, 1, '#000000');
        b.endStroke();
        const d = __B.layer().ctx.getImageData(90, 90, 20, 20).data;
        let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++;
        return n;
    })()`));
    check("a Krita tip's density keeps about that share of its pixels", dens > 120 && dens < 280, dens + ' of 400');
    /* Clip Studio's continuous spray lays a dab at every pen report the
     * spacing did not reach (cdp-csp pcp: size 40 at 150%, 70 reports over
     * 800px, solid on and a dot every 60px off). Its sprays scatter each
     * particle over the brush's patch whatever the particle's own random
     * size (psz: 0-20px specks spread evenly over a 300 patch, where small
     * ones bunched on the line). A ribbon of pictures picked at random lays
     * each at its own length (Book's stood in clumps with gaps). */
    const csp = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, out = {};
        const base = { flowSrc: 'none', sizeSrc: 'none', smoothingMode: 'none', hardness: 100, opacity: 100, flow: 100 };
        const run = (params, dy) => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            for (const [k, v] of Object.entries(Object.assign({}, base, params))) b.setParam(k, v);
            __B.layer().ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(40, 100, 1, '#000000');
            for (let x = 40 + dy; x <= 160; x += dy) b.moveStroke(x, 100, 1, '#000000');
            b.endStroke();
            return __B.layer().ctx.getImageData(0, 0, 200, 200).data;
        };
        const runs = (d) => { let n = 0; for (let x = 1; x < 200; x++) if (d[(100 * 200 + x) * 4 + 3] > 128 && !(d[(100 * 200 + x - 1) * 4 + 3] > 128)) n++; return n; };
        out.each = runs(run({ size: 6, spacing: 1000, dabEachReport: true }, 10));
        out.plain = runs(run({ size: 6, spacing: 1000 }, 10));
        b._setStrokeSeed(7);
        const d = run({ size: 4, spacing: 5, sprayEach: true, scatter: 1000, scatterAxis: 'disk', dabCount: 4,
            sizeSrc: 'random', sizeMin: 0, sizeCurve: [[0, 0], [1, 1]] }, 1);
        let tiny = 0;
        for (let y = 0; y < 200; y++) for (let x = 2; x < 198; x++) {
            if (Math.abs(y - 100) < 25 || !(d[(y * 200 + x) * 4 + 3] > 10)) continue;
            let m = 0; for (let v = -2; v <= 2; v++) for (let u = -2; u <= 2; u++) if (y + v >= 0 && y + v < 200 && d[((y + v) * 200 + x + u) * 4 + 3] > 10) m++;
            if (m <= 3) tiny++;
        }
        out.tinyFar = tiny;
        const s = document.createElement('canvas'); s.width = 128; s.height = 64;
        const g = s.getContext('2d'); g.fillRect(0, 0, 64, 64); g.fillRect(80, 0, 32, 64);   // a whole slot, and a half one centred
        b.forgetSaved('Round'); b.loadPreset('Round');
        b.setParam('tipCells', 2);   // before the picture loads: it is cut into cells then
        b.loadCustomTip(s.toDataURL('image/png'), null);
        await new Promise(r => setTimeout(r, 400));
        /* ...and, as imported, half a picture on (offsetAlong): the first
         * starts on the pen whichever is picked (Book, cdp-csp: every Clip
         * Studio draw starts there; centred as the longest, a short first
         * began a quarter of the size late). */
        const gaps = { firsts: [] };
        for (const [lens, seed] of [[null, 3], [[1, 0.5], 3], [[1, 0.5], 8], [[1, 0.5], 11]]) {
            for (const [k, v] of Object.entries(Object.assign({}, base, { size: 10, tipPick: 'random', spacing: 100,
                spacingIsotropic: false, autoSpacing: 0, ribbonLens: lens, offsetAlong: 50 }))) b.setParam(k, v);
            b._setStrokeSeed(seed);
            __B.layer().ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(10, 100, 1, '#000000');
            for (let x = 12; x <= 190; x += 2) b.moveStroke(x, 100, 1, '#000000');
            b.endStroke();
            await new Promise(r => setTimeout(r, 200));
            const r = __B.layer().ctx.getImageData(0, 100, 200, 1).data;
            let first = -1, last = -1, n = 0;
            for (let x = 0; x < 200; x++) if (r[x * 4 + 3] > 128) { if (first < 0) first = x; last = x; }
            for (let x = first; x < last; x++) if (!(r[x * 4 + 3] > 128)) n++;
            if (seed === 3) gaps[lens ? 'own' : 'slot'] = n;
            if (lens) gaps.firsts.push(first);
        }
        b.setParam('offsetAlong', 0);
        /* Glitter's lightening second brush (mode 2) is laid over the
         * finished first, so its sparkles stay lit all along the stroke;
         * laid in turn, each next report's dabs covered the last ones'. */
        b.forgetSaved('Round'); b.loadPreset('Round');
        b.PRESETS[b._currentPreset].second = { op: 'destination-out', p: { size: 4, spacing: 300, hardness: 100, flowSrc: 'none', sizeSrc: 'none', cutByLight: true } };
        for (const [k, v] of Object.entries(Object.assign({}, base, { size: 30, spacing: 5 }))) b.setParam(k, v);
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(40, 100, 1, '#ffffff');
        for (let x = 50; x <= 160; x += 10) b.moveStroke(x, 100, 1, '#ffffff');
        b.endStroke();
        delete b.PRESETS[b._currentPreset].second;
        const lit = __B.layer().ctx.getImageData(50, 100, 90, 1).data;
        out.lit = 0; for (let x = 0; x < 90; x++) if (lit[x * 4 + 3] < 128) out.lit++;
        /* Mode 2's second brush adds its colour to the first's wherever the first has ink (Glitter's purple turns magenta). */
        b.forgetSaved('Round'); b.loadPreset('Round');
        b.PRESETS[b._currentPreset].second = { op: 'add', p: { size: 30, spacing: 5, hardness: 100, flowSrc: 'none', sizeSrc: 'none', cutByLight: true } };
        for (const [k, v] of Object.entries(Object.assign({}, base, { size: 30, spacing: 5 }))) b.setParam(k, v);
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(40, 100, 1, '#503070');
        for (let x = 50; x <= 160; x += 10) b.moveStroke(x, 100, 1, '#503070');
        b.endStroke();
        delete b.PRESETS[b._currentPreset].second;
        out.addPx = Array.from(__B.layer().ctx.getImageData(100, 100, 1, 1).data);
        /* Clip Studio's measured watercolour rim lifts the alpha of the faintest edge pixels; their own colour is 8-bit noise
         * ((127,0,255) for alpha 2), so the lift must not show it: Flat watercolor's rim had (255,0,255) specks. */
        b.PRESETS.__rimTest = { size: 120, hardness: 40, opacity: 100, flow: 100, spacing: 1, flowSrc: 'none', sizeSrc: 'none', smoothingMode: 'none', blendMode: 'multiply',
            edgeWidth: 2, edgeAdd: true, edgeDensity: 10, edgeValue: 0 };
        b.loadPreset('__rimTest');
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(30, 100, 1, '#912dcd');
        for (let x = 31; x <= 170; x += 3) b.moveStroke(x, 100, 1, '#912dcd');
        b.endStroke();
        delete b.PRESETS.__rimTest;
        const rim = __B.layer().ctx.getImageData(0, 0, 200, 200).data;
        out.rimBad = 0; for (let i = 0; i < rim.length; i += 4) if (rim[i + 3] && Math.abs(rim[i] - 145) + Math.abs(rim[i + 1] - 45) + Math.abs(rim[i + 2] - 205) > 150) out.rimBad++;
        /* A preset's sub colour mix may be random (Generic Flower BG), and
         * with a random opacity too each dab keeps its own colour: the
         * opacity's buffer used to paint the whole stroke the last dab's. */
        b.PRESETS.__mixTest = { size: 10, hardness: 100, opacity: 100, flow: 100, spacing: 400, flowSrc: 'none', sizeSrc: 'none', smoothingMode: 'none',
            dabOpacitySrc: 'random', dabOpacityMin: 100, subMix: 80, subMixSrc: 'random', subMixMin: 0, subMixCurve: [[0, 0], [1, 1]] };
        b.loadPreset('__mixTest');
        b._setStrokeSeed(5);
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(20, 100, 1, '#000000');
        for (let x = 30; x <= 180; x += 10) b.moveStroke(x, 100, 1, '#000000');
        b.endStroke();
        b._setStrokeSeed(null);
        delete b.PRESETS.__mixTest;
        const greys = new Set();
        for (let x = 20; x <= 180; x += 40) greys.add(__B.layer().ctx.getImageData(x, 100, 1, 1).data[0] >> 3);
        out.greys = greys.size;
        /* A thickness driven by two inputs at once (Oil paint: pressure and
         * speed) thins the tip like one input does; with two, the engine
         * skipped it, and Oil paint lay 72px wide where Clip Studio's is 68. */
        b.PRESETS.__aspTest = { size: 30, hardness: 100, opacity: 100, flow: 100, spacing: 5, flowSrc: 'none', sizeSrc: 'none', smoothingMode: 'none',
            aspectRatio: 1, aspectRatioSensors: [{ src: 'pressure', curve: [[0, 0.5], [1, 0.5]] }, { src: 'pressure', curve: [[0, 0.5], [1, 0.5]] }] };
        b.loadPreset('__aspTest');
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(40, 100, 1, '#000000');
        for (let x = 50; x <= 160; x += 10) b.moveStroke(x, 100, 1, '#000000');
        b.endStroke();
        delete b.PRESETS.__aspTest;
        const col = __B.layer().ctx.getImageData(100, 0, 1, 200).data;
        out.tall = 0; for (let y = 0; y < 200; y++) if (col[y * 4 + 3] > 128) out.tall++;
        out.gaps = gaps;
        b._setStrokeSeed(null);
        ['tipCells', 'tipPick', 'spacing', 'spacingIsotropic', 'autoSpacing', 'ribbonLens'].forEach(k => b.setParam(k, b.DEFAULTS[k]));
        b.forgetSaved(b._currentPreset || 'Round'); b.loadPreset('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    check("Clip Studio's continuous spray lays a dab at every pen report its spacing skips",
        csp.each >= 10 && csp.plain <= 3, JSON.stringify(csp));
    check("a Clip Studio spray throws its tiniest particles to the edge of the patch",
        csp.tinyFar > 12, JSON.stringify(csp));
    check("a Clip Studio ribbon of pictures at random lays each at its own length, end to end",
        csp.gaps.own <= 2 && csp.gaps.slot > 5 && csp.gaps.firsts.every(x => x === 10), JSON.stringify(csp.gaps));
    check("Clip Studio's lightening second brush lights the whole stroke, not just its last stretch",
        csp.lit > 10, 'lit ' + csp.lit);
    check("Clip Studio's mode 2 second brush adds its colour to the first's: 80,48,112 twice is 160,96,224",
        csp.addPx.join() === '160,96,224,255', JSON.stringify(csp.addPx));
    check("a watercolour rim's lifted faint pixels keep the paint's colour, not 8-bit noise",
        csp.rimBad === 0, 'bad ' + csp.rimBad);
    check("a Clip Studio sub colour mix at random gives each dab its own grey, random opacity or not",
        csp.greys >= 3, 'greys ' + csp.greys);
    check("a Clip Studio thickness driven by two inputs thins the tip",
        csp.tall > 0 && csp.tall < 15, 'tall ' + csp.tall);
    /* Dabs fainter than a few 8-bit levels still add up in Krita
     * (test/krita/probes/addop: X1BB at pressure 0.5, dabs 2.8 levels deep,
     * stacked to 17 in Krita and 9 here). The stroke buffer rounded every
     * dab to 8 bits; it is float16 now. 21 hard dabs of 1.1% (centres x = 80
     * to 120) cover the middle of this line: 1 - 0.989^21 = 0.207 of full
     * ink, about 53. The 8-bit buffer rounded each dab to a whole level and
     * gave 60 here -- too much on a hard tip, too little on X1BB's soft one. */
    const fz = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        b.forgetSaved('Round'); b.loadPreset('Round');
        for (const [k, v] of Object.entries({ size: 40, hardness: 100, opacity: 100, flow: 1.1, spacing: 5,
            flowSrc: 'none', sizeSrc: 'none', smoothingMode: 'none' })) b.setParam(k, v);
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(40, 100, 1, '#000000');
        for (let i = 41; i <= 160; i++) b.moveStroke(i, 100, 1, '#000000');
        b.endStroke();
        return JSON.stringify(__B.layer().ctx.getImageData(100, 100, 1, 1).data[3]);
    })()`));
    check('faint dabs add up as they would in exact arithmetic, not stalled by 8-bit rounding',
        Math.abs(fz / 255 / 0.207 - 1) < 0.05, String(fz));
    /* GIMP's generated round brush and its sub-pixel stepping, against
     * GIMP's own lone dabs and lines (test/gimp/probe.mjs, "circ" and
     * "tiny"). Circle (07) centred on a pixel is 0,128,191,255 out from its
     * middle row's end; a 1px one at a pixel corner is four quarters of
     * 64; a 1px line along a pixel boundary is 128 on both rows, one dab
     * per column. Ours were a smooth-edged disc, one pixel at 192, and
     * 183 from dabs stacked every 0.1px. */
    const gv = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = () => __B.layer().ctx;
        const vbr = (n, r) => 'GIMP-VBR\\n1.0\\n' + n + '\\n10.000000\\n' + r + '\\n1.000000\\n1.000000\\n0.000000\\n';
        const run = (n, r, pts) => {
            const got = b.importVbr(vbr(n, r), n + '.vbr'); b.loadPreset(got.added[0]);
            b.setParam('size', r * 2); L().clearRect(0, 0, 200, 200);
            b.beginStroke(pts[0], pts[1], 1, '#000000');
            for (let i = 2; i < pts.length; i += 2) b.moveStroke(pts[i], pts[i + 1], 1, '#000000');
            b.endStroke();
            b.deleteUserPreset(got.added[0]);
        };
        const px = (x, y) => L().getImageData(x, y, 1, 1).data[3];
        run('cdp-c7', 3.5, [100.5, 50.5]);
        const c7 = [97, 98, 99, 100].map(x => px(x, 47));
        run('cdp-c1', 0.5, [100, 50]);
        const c1 = [px(99, 49), px(100, 49), px(99, 50), px(100, 50), px(101, 50)];
        const pts = [40, 50]; for (let x = 41; x <= 160; x++) pts.push(x, 50);
        run('cdp-c1', 0.5, pts);
        const line = [px(100, 48), px(100, 49), px(100, 50), px(100, 51), px(130, 49)];
        return JSON.stringify({ c7, c1, line });
    })()`));
    check("a GIMP round brush is GIMP's pixel grid: Circle (07)'s top row, quarter levels",
        JSON.stringify(gv.c7) === '[0,128,191,255]', JSON.stringify(gv.c7));
    check('...and a 1px GIMP dab at a pixel corner is four quarters, not one pixel',
        JSON.stringify(gv.c1) === '[64,64,64,64,0]', JSON.stringify(gv.c1));
    check('...and a 1px GIMP line on a pixel boundary is 128 on both rows, one dab a column',
        JSON.stringify(gv.line) === '[0,128,128,0,128]', JSON.stringify(gv.line));
    /* A 1px sharp tip draws Krita's pixel line (test/krita/probes/pixel):
     * start snapped, a half rounding down, then one pixel per column with a
     * half across rounding up. Unsnapped, this diagonal sat a row off along
     * half its length (pixel1 IoU 0.76). */
    const px = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = () => __B.layer().ctx;
        const run = (shape) => {
        b.forgetSaved('Round'); b.loadPreset('Round');
        for (const [k, v] of Object.entries({ shape, size: 1, hardness: 100, falloff: 'krita-gauss', sharpness: 100, sharpSoftness: 0,
            spacing: 10, flowSrc: 'none', sizeSrc: 'none', smoothingMode: 'none' })) b.setParam(k, v);
        L().clearRect(0, 0, 200, 200);
        b.beginStroke(20.5, 80.5, 1, '#000000');
        for (let i = 1; i <= 45; i++) b.moveStroke(20.5 + 40 * i / 45, 80.5 - 20 * i / 45, 1, '#000000');
        b.endStroke();
        const d = L().getImageData(0, 0, 200, 200).data, on = [];
        for (let i = 3; i < d.length; i += 4) if (d[i] > 127) on.push([(i >> 2) % 200, (i >> 2) / 200 | 0]);
        const want = []; for (let k = 0; k <= 40; k++) want.push([20 + k, Math.floor(80 - k / 2 + 0.5)]);
        return { n: on.length, miss: want.filter(([x, y]) => !on.some(p => p[0] === x && p[1] === y)).length };
        };
        const r = run('circle'); r.square = run('square'); b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify(r);
    })()`));
    check('a 1px sharp tip draws a pixel line from its snapped start', px.n === 41 && px.miss === 0, JSON.stringify(px));
    check('...and so does a 1px sharp square, snapped the same (EO Pixel Perfect)', px.square.n === 41 && px.square.miss === 0, JSON.stringify(px.square));
    /* Krita's sketch engine (test/krita/probes/sketch): lines out to earlier
     * points within half the brush, trimmed by the offset. Its first cut
     * only repainted round the newest point, so a fast stroke kept its last
     * 17px of a 400px line. */
    const sk = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = () => __B.layer().ctx;
        const run = (pts) => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            for (const [k, v] of Object.entries({ engineKind: 'sketch', size: 30, flowSrc: 'none', sizeSrc: 'none',
                smoothingMode: 'none', sketchOffset: 0.2, sketchProb: 1, sketchWidth: 1 })) b.setParam(k, v);
            L().clearRect(0, 0, 200, 200);
            b.beginStroke(pts[0][0], pts[0][1], 1, '#000000');
            for (const [x, y] of pts.slice(1)) b.moveStroke(x, y, 1, '#000000');
            b.endStroke();
        };
        const uturn = (d) => { const o = []; for (let x = 20; x <= 120; x += 2) o.push([x, 50]); for (let x = 120; x >= 20; x -= 2) o.push([x, 50 + d]); return o; };
        run([[10, 20], [190, 20]]);
        const row = L().getImageData(0, 20, 200, 1).data; let n = 0; for (let x = 0; x < 200; x++) if (row[x * 4 + 3]) n++;
        run(uturn(8)); const near = L().getImageData(70, 54, 1, 1).data[3];
        run(uturn(20)); const far = L().getImageData(70, 60, 1, 1).data[3];
        b.setParam('sketchWidthSrc', 'pressure'); b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify({ n, near, far, leak: b.getParams().sketchWidthSrc });
    })()`));
    check('a sketch line drawn in one long move paints end to end', sk.n >= 180, sk.n + ' of 181 px');
    check('...joins across a gap inside half the brush', sk.near > 200, 'alpha ' + sk.near);
    check('...and not across one beyond it', sk.far === 0, 'alpha ' + sk.far);
    check("...and one preset's line-width sensor does not leak into the next", sk.leak === 'none', sk.leak);
    /* Krita's particle brush: particles pulled from the stroke's start
     * toward each new point, a pass per point. Painted as a round brush, a
     * 400px one-move line ran end to end where Krita's is a short streak
     * (X3CH Ribbon: IoU 0.015 -> 1). */
    const pt = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = __B.layer().ctx;
        b.forgetSaved('Round'); b.loadPreset('Round');
        for (const [k, v] of Object.entries({ engineKind: 'particle', smoothingMode: 'none',
            particle: { count: 10, iterations: 10, gravity: 0.985, weight: 1, scaleX: 1, scaleY: 0.6 } })) b.setParam(k, v);
        L.clearRect(0, 0, 480, 100);
        b.beginStroke(40, 50, 1, '#000000'); b.moveStroke(440, 50, 1, '#000000'); b.endStroke();
        const d = L.getImageData(0, 0, 480, 100).data; let n = 0, far = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i]) { n++; if ((i >> 2) % 480 > 60) far++; }
        b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify({ n, far });
    })()`));
    check('a particle stroke is a short streak from its start', pt.n > 5 && pt.far === 0, JSON.stringify(pt));
    /* Krita's hairy brush: the tip made into bristles, each drawn as a line
     * from where it sat to where it sits, spread by the bristle scale. It
     * was painted as a round brush -- one 18px band where Krita lays a comb
     * of hairlines 90px across (Oil Bristle Hairy: IoU 0.016 -> 1). The
     * opacity goes into the dab's bytes as Krita rounds it: a canvas
     * globalAlpha put 254 at half opacity to 128, not Krita's 127. */
    const hr = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = __B.layer().ctx;
        b.forgetSaved('Round'); b.loadPreset('Round');
        for (const [k, v] of Object.entries({ engineKind: 'hairy', smoothingMode: 'none', size: 18, sizeSrc: 'none',
            flowSrc: 'pressure', flowCurve: [[0, 0], [1, 1]], tipCurve: [[0, 1], [1, 0]], hardness: 0,
            hairy: { density: 1, random: 0, scale: 5, shear: 0, threshold: false, aa: true, comp: true, connected: false,
                inkOn: false, inkAmount: 2, inkCurve: [[0, 0], [1, 1]], useOpacity: true, useWeights: false, pw: 0.5, blw: 0.5, biw: 0.5, idw: 50 } }))
            b.setParam(k, v);
        L.clearRect(0, 0, 200, 200);
        b.beginStroke(20, 100, 0.5, '#000000'); b.moveStroke(180, 100, 0.5, '#000000'); b.endStroke();
        const col = L.getImageData(100, 0, 1, 200).data; let runs = 0, top = 200, bot = 0, max = 0;
        for (let y = 0; y < 200; y++) {
            const a = col[y * 4 + 3]; max = Math.max(max, a);
            if (a) { top = Math.min(top, y); bot = Math.max(bot, y); if (!col[(y - 1) * 4 + 3]) runs++; }
        }
        // one bristle at 254 (a 1px tip, its curve topping out there), on whole pixels
        b.setParam('size', 1); b.setParam('tipCurve', [[0, 254 / 255], [1, 0]]);
        L.clearRect(0, 0, 200, 200);
        b.beginStroke(20, 100, 0.5, '#000000'); b.moveStroke(180, 100, 0.5, '#000000'); b.endStroke();
        max = L.getImageData(100, 100, 1, 1).data[3];
        b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify({ runs, span: bot - top + 1, max });
    })()`));
    check('a hairy stroke is a comb of bristle lines spread by its scale', hr.runs >= 10 && hr.span > 70, JSON.stringify(hr));
    check("...and a 254 bristle at half opacity is Krita's 127, not 128", hr.max === 127, 'alpha ' + hr.max);
    /* The bristles come from the tip as Krita's mask makes it, holes and
     * all: Bristle Tapered's tip at density 0.3 laid 6x Krita's ink when
     * every pixel became a hair. Pressure from mouse is a speed reading
     * that scales the head, near nothing on a slow stroke (Bristle Details
     * 4.6x -> 0.97). */
    const hd = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = __B.layer().ctx;
        b.forgetSaved('Round'); b.loadPreset('Round');
        const hairy = { density: 1, random: 0, scale: 5, shear: 0, threshold: false, aa: true, comp: true, connected: false,
            inkOn: false, inkAmount: 2, inkCurve: [[0, 0], [1, 1]], useOpacity: true, useWeights: false, pw: 0.5, blw: 0.5, biw: 0.5, idw: 50 };
        for (const [k, v] of Object.entries({ engineKind: 'hairy', smoothingMode: 'none', size: 18, sizeSrc: 'none', flowSrc: 'none',
            tipCurve: [[0, 1], [1, 0]], hardness: 0, hairy })) b.setParam(k, v);
        const ink = (step, mouse, dn, end = 180) => {
            b.setParam('tipDensity', dn); b.setParam('hairy', Object.assign({}, hairy, { mouse }));
            L.clearRect(0, 0, 200, 200);
            b._setStrokeSeed(5); b.beginStroke(20, 100, 0.5, '#000000');
            for (let x = 20 + step; x <= end; x += step) b.moveStroke(x, 100, 0.5, '#000000');
            b.endStroke(); b._setStrokeSeed(null);
            const d = L.getImageData(0, 0, 200, 200).data; let sum = 0, top = 200, bot = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i]) { sum += d[i]; if (((i - 3) / 4) % 200 === 170) { const y = ((i - 3) / 4 - 170) / 200; top = Math.min(top, y); bot = Math.max(bot, y); } }
            return [sum, bot - top + 1];
        };
        const out = { full: ink(20, false, 1), thin: ink(20, false, 0.3), dot: ink(1, false, 1, 21), dotThin: ink(1, false, 0.3, 21), fast: ink(20, true, 1), slow: ink(2, true, 1) };
        b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify(out);
    })()`));
    check('a hairy brush makes bristles only where its tip density left pixels', hd.dotThin[0] / hd.dot[0] > 0.2 && hd.dotThin[0] / hd.dot[0] < 0.4, JSON.stringify(hd));
    check('...and pressure from mouse shrinks the head on a slow stroke', hd.fast[1] > 50 && hd.slow[1] < hd.fast[1] / 3, JSON.stringify(hd));
    /* A small Krita tip, read one bristle a pixel (scale 10, one 0.25px
     * step): Krita's own bytes (probes/hairtip). Its box is the size cut to
     * whole pixels, centred at W / 2 -- ours had a faint ring a row and a
     * column further out, and a 5px tip half a pixel off -- and its 3x3
     * samples add up whole bytes of transparency (245 where Krita has 246).
     * Half opacity is Krita's u8 multiply: 249 makes 125, not 124. */
    const hb = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = __B.layer().ctx;
        b.forgetSaved('Round'); b.loadPreset('Round');
        const hairy = { density: 1, random: 0, scale: 10, shear: 0, threshold: false, aa: true, comp: false, connected: true,
            inkOn: false, inkAmount: 2, inkCurve: [[0, 0], [1, 1]], useOpacity: true, useWeights: false, pw: 0.5, blw: 0.5, biw: 0.5, idw: 50 };
        for (const [k, v] of Object.entries({ engineKind: 'hairy', smoothingMode: 'none', sizeSrc: 'none', flowSrc: 'pressure',
            flowCurve: [[0, 0], [1, 1]], shape: 'circle', falloff: 'krita-aa', hardness: 50, hairy })) b.setParam(k, v);
        const grid = (sz, pr) => {
            b.setParam('size', sz); L.clearRect(0, 0, 200, 200);
            b.beginStroke(100, 100, pr, '#000000'); b.moveStroke(100.25, 100, pr, '#000000'); b.endStroke();
            const d = L.getImageData(0, 0, 200, 200).data, g = [];
            for (let oy = -3; oy <= 2; oy++) for (let ox = -3; ox <= 2; ox++) g.push(d[((100 + oy * 10) * 200 + 100 + ox * 10) * 4 + 3]);
            return g;
        };
        const out = { d4: grid(4, 1), d5: grid(5, 1) };
        b.setParam('tipCurve', [[0, 249 / 255], [1, 0]]); b.setParam('size', 1); L.clearRect(0, 0, 200, 200);
        b.beginStroke(20, 100, 0.5, '#000000'); b.moveStroke(180, 100, 0.5, '#000000'); b.endStroke();
        out.half = L.getImageData(100, 100, 1, 1).data[3];
        b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify(out);
    })()`));
    // rows -3..2, columns -3..2
    const kd4 = [0, 0, 0, 0, 0, 0, 0, 82, 167, 123, 12, 0, 0, 167, 246, 208, 51, 0, 0, 123, 208, 166, 26, 0, 0, 12, 51, 26, 0, 0, 0, 0, 0, 0, 0, 0];
    const kd5 = [0, 0, 0, 0, 0, 0, 0, 39, 129, 143, 73, 3, 0, 129, 223, 235, 171, 32, 0, 143, 235, 246, 185, 41, 0, 73, 171, 185, 114, 9, 0, 3, 32, 41, 9, 0];
    check("a small Krita tip's bristles are Krita's own bytes, box and middle", JSON.stringify(hb.d4) === JSON.stringify(kd4) && JSON.stringify(hb.d5) === JSON.stringify(kd5), JSON.stringify(hb));
    check("...and a 249 bristle at half opacity is Krita's 125", hb.half === 125, 'alpha ' + hb.half);
    /* An anti-aliased hard square is Krita's rectangle (KisRectangleMaskGenerator),
     * its last pixel fading: Grease Pencil Square's 6 x 2.9 dab is rows
     * 104, 254, 188 in Krita (probes/gpsq). Drawn as a plain box it was a
     * solid bar, and its subtract texture kept 1.8x Krita's ink. */
    const sq = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = __B.layer().ctx;
        b.forgetSaved('Round'); b.loadPreset('Round');
        for (const [k, v] of Object.entries({ smoothingMode: 'none', sizeSrc: 'none', flowSrc: 'none', shape: 'square',
            falloff: 'krita-aa', hardness: 100, aspectRatio: 1 / 0.47, size: 6.2, spacing: 1000 })) b.setParam(k, v);
        L.clearRect(0, 0, 200, 200);
        b.beginStroke(100, 100, 1, '#000000'); b.endStroke();
        const d = L.getImageData(100, 95, 1, 10).data, col = [];
        for (let i = 3; i < d.length; i += 4) if (d[i]) col.push(d[i]);
        b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify(col);
    })()`));
    check("an anti-aliased hard Krita square fades its edge pixels, as Krita's rectangle does",
        sq.filter(a => a >= 240).length === 1 && Math.abs(sq.reduce((a, b) => a + b, 0) - 546) < 30, JSON.stringify(sq));
    /* Krita's curve brush (KisCurvePaintOp): no dabs, a line per input
     * segment on Qt's anti-aliased pen, a curve through the history once it
     * is full. It was painted as a round brush: 10x Krita's ink on Ink Pen. */
    const cv = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = () => __B.layer().ctx;
        const run = (pts, more) => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            for (const [k, v] of Object.entries({ engineKind: 'curve', size: 30, flowSrc: 'none', sizeSrc: 'none',
                smoothingMode: 'none', sketchWidth: 0, curveHistory: 3, curvesOpacity: 1, ...more })) b.setParam(k, v);
            L().clearRect(0, 0, 200, 200);
            b.beginStroke(pts[0][0], pts[0][1], 1, '#000000');
            for (const [x, y] of pts.slice(1)) b.moveStroke(x, y, 1, '#000000');
            b.endStroke();
        };
        run([[20, 40], [180, 40]]);
        const a = L().getImageData(100, 38, 1, 4).data;
        const hair = [a[3], a[7], a[11], a[15]];
        // An 11px line whose width input reads 0 (a fade at its first step) is 1.1px, not a hairline.
        run([[20, 40], [180, 40]], { sketchWidth: 11,
            sketchWidthSensors: [{ src: 'fadein', curve: [[0, 0], [1, 1]], kind: 'scale', length: 20, periodic: false }] });
        const f = L().getImageData(100, 36, 1, 8).data; let floor = 0;
        for (let i = 3; i < f.length; i += 4) floor += f[i];
        b.setParam('sketchWidthSensors', null);
        // Draw Curve: 11px on a whole-pixel line leaves its edge rows half covered, which Qt makes 127.
        run([[20, 40], [180, 40]], { sketchWidth: 11 });
        const half = L().getImageData(100, 34, 1, 1).data[3];
        // ...but 1px is still Qt's thin line (fast_pen): one pixel of ink a column on a diagonal, not 1.12.
        run([[20, 150], [180, 70]], { sketchWidth: 1 });
        const g = L().getImageData(100, 100, 1, 20).data; let one = 0;
        for (let i = 3; i < g.length; i += 4) one += g[i];
        // a V: the curve from the first history point through the middle one to the last
        run([[20, 150], [60, 150], [100, 100], [140, 150]], { curveConnect: false });
        const mid = L().getImageData(90, 100, 20, 40).data; let curve = 0;
        for (let i = 3; i < mid.length; i += 4) if (mid[i]) curve++;
        b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify({ hair, floor, one, half, curve, kind: b.getParams().engineKind });
    })()`));
    check('a curve-brush hairline on a whole-pixel line lands half in each row, as Qt draws it',
        cv.hair[0] === 0 && cv.hair[1] > 100 && cv.hair[1] < 160 && cv.hair[2] > 100 && cv.hair[2] < 160 && cv.hair[3] === 0,
        JSON.stringify(cv.hair));
    check("...a width input reading 0 holds at a tenth of the width, as Krita's does",
        cv.floor >= 270 && cv.floor <= 292, 'column ink ' + cv.floor + ', 1.1px is 280');
    check("...a half-covered edge pixel truncates to 127, as Qt's does", cv.half === 127, 'alpha ' + cv.half);
    check('...and a 1px line keeps the thin line, one pixel of ink a column',
        cv.one >= 245 && cv.one <= 265, 'column ink ' + cv.one);
    check('...a full history draws its curve, with no connecting lines asked for', cv.curve > 20, cv.curve + ' px');
    check('...and the engine does not leak into the next preset', cv.kind === 'brush', cv.kind);
    /* Krita's colour smudge (test/krita/probes/smudge, smudge2). Ours mixed
     * one picked-up colour into an opaque dab, so on an empty layer it drew
     * solid black where Krita draws nothing or a diluted ramp, and a pure
     * smear never let go of what it carried. Numbers are Krita's. */
    const sm = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = () => __B.layer().ctx;
        const run = (set, x0, x1, prep, pr = 1, y = 100) => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            for (const [k, v] of Object.entries({ smudgeMode: 0, size: 30, hardness: 100, falloff: 'krita-gauss',
                autoSpacing: 0.3, flowSrc: 'none', sizeSrc: 'none', colorRateSrc: 'none', smoothingMode: 'none', ...set })) b.setParam(k, v);
            L().clearRect(0, 0, 200, 200);
            if (prep) prep(L());
            b.beginStroke(x0, y, pr, '#000000');
            for (let x = x0 + 1; x <= x1; x++) b.moveStroke(x, y, pr, '#000000');
            if ((x1 - x0) % 1) b.moveStroke(x1, y, pr, '#000000');
            b.endStroke();
        };
        const a = (x) => L().getImageData(x, 100, 1, 1).data[3];
        const blue = c => { c.fillStyle = '#0000ff'; c.fillRect(0, 0, 60, 200); };
        run({ colorRate: 0, smudgeRate: 25 }, 30, 190, blue); const flat = [a(70), a(80), a(90)];
        run({ colorRate: 0, smudgeRate: 50, dabOpacitySrc: 'pressure', dabOpacityCurve: 1 }, 30, 190, blue, 0.5);
        const byOp = [a(70), a(80), a(90)];
        run({ colorRate: 100, smudgeRate: 100, opacity: 50 }, 20, 180); const half = a(100);
        run({ colorRate: 100, smudgeRate: 25 }, 80, 80); const dot = a(80);
        run({ colorRate: 100, smudgeRate: 0 }, 20, 180); const off = a(100);
        // Node.paintLine's first dab lands half a pixel in (see probe-cdp.mjs): five dabs, not six
        run({ colorRate: 100, smudgeRate: 25 }, 90.5, 100); const short = a(95);
        run({ colorRate: 0, smudgeRate: 50 }, 30, 190, c => { c.fillStyle = '#0000ff'; c.fillRect(0, 0, 60, 200); });
        const drag = [a(80), a(100), a(120)];
        // blue on row 99 only: a dulling dab at y 100 reads it, as Krita's QRect::center() does
        run({ smudgeMode: 1, colorRate: 0, smudgeRate: 100 }, 30, 190, c => { c.fillStyle = '#0000ff'; c.fillRect(0, 99, 200, 1); });
        const dull = L().getImageData(120, 110, 1, 1).data[3];
        // a quarter of a level a dab: Krita's precise stroke copy adds it up, 8 bits rounded it away
        run({ smudgeMode: 1, colorRate: 0.4, smudgeRate: 50 }, 20, 180); const faint = a(100);
        // a smear at y 100.7 sits on whole pixels, centred on 100 as Krita's is
        run({ colorRate: 100, smudgeRate: 50 }, 20, 180, null, 1, 100.7);
        const col = y => L().getImageData(100, y, 1, 1).data[3], snap = [col(85), col(114)];
        // auto spacing 1.5 at 30: dabs every 8.2px to 119, not every 8.35 (the old extra pixel) to 112
        run({ colorRate: 100, smudgeRate: 25, autoSpacing: 1.5 }, 20.5, 120);
        let reach = 0; for (let x = 100; x < 160; x++) if (a(x) > 0) reach = x;
        // the old engine's dulling averages its radius (i) Wet Textured Soft): 1px stripes mix to half, not a stripe's 0 or 255
        run({ smudgeMode: 1, colorRate: 0, smudgeRate: 100, smudgeSample: 1 }, 30, 190, c => { c.fillStyle = '#0000ff'; for (let x = 0; x < 200; x += 2) c.fillRect(x, 0, 1, 200); });
        const avg = [a(100), a(101), a(102), a(103), a(140), a(141)];
        return JSON.stringify({ dot, off, short, drag, flat, byOp, half, dull, faint, snap, reach, avg });
    })()`));
    check('a colour smudge dab on its own only picks up, as in Krita', sm.dot === 0, 'alpha ' + sm.dot);
    check('...smudge rate 0 lays nothing down', sm.off === 0, 'alpha ' + sm.off);
    check("...a short stroke on an empty layer builds to Krita's 165, not solid", Math.abs(sm.short - 165) <= 12, 'alpha ' + sm.short);
    check('...and its auto gap is the dab size alone, no pixel wider (paint_dull_giant_blurry)', sm.reach >= 131, 'reach ' + sm.reach);
    check("...and dulling with a radius picks up the patch's mix, not one pixel (Wet Textured Soft)", sm.avg.every(v => v > 60 && v < 200), sm.avg.join(','));
    check('...and a pure smear lets go of what it carries (Krita 212, 41, 0)',
        Math.abs(sm.drag[0] - 212) <= 20 && Math.abs(sm.drag[1] - 41) <= 20 && sm.drag[2] <= 5, sm.drag.join(','));
    check('...and the opacity curve scales the smear: 0.5 at half pressure smears as a flat 0.25 (smudge6)',
        sm.flat.every((v, i) => Math.abs(v - sm.byOp[i]) <= 3) && sm.flat[0] > 20, sm.flat.join(',') + ' vs ' + sm.byOp.join(','));
    check("...and so does the opacity slider: 50% builds to Krita's 209, not 253 (smudge7)",
        Math.abs(sm.half - 209) <= 12, 'alpha ' + sm.half);
    check("...and dulling picks its colour up at the previous dab's rect centre, rounded to the top left",
        sm.dull > 100, 'alpha ' + sm.dull);
    check('...and dabs too faint for 8 bits still add up over a stroke, as on Krita\'s precise copy',
        sm.faint >= 4, 'alpha ' + sm.faint);
    check('...and a smear lays its dabs on whole pixels, as Krita turns its sub-pixel phase off (Basic Soft Wet)',
        sm.snap[0] > 20 && Math.abs(sm.snap[0] - sm.snap[1]) <= 3, sm.snap.join(','));
    /* ...and a picture tip turned with the line sits half a pixel higher
     * first: Rake Smudge's tines lay a row above where an unturned tip's do
     * (test/krita/probes/rksm). A tip inked in its top half, 30px. */
    const rks = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, L = __B.layer().ctx, c = document.createElement('canvas');
        c.width = c.height = 30; c.getContext('2d').fillRect(0, 0, 30, 15);
        const row = async (src) => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            b.loadCustomTip(c.toDataURL('image/png'), null); await new Promise(r => setTimeout(r, 300));
            for (const [k, v] of Object.entries({ smudgeMode: 0, colorRate: 100, smudgeRate: 50, size: 30, spacing: 10,
                flowSrc: 'none', sizeSrc: 'none', colorRateSrc: 'none', smoothingMode: 'none', angle: 0, angleSrc: src })) b.setParam(k, v);
            L.clearRect(0, 0, 200, 200);
            b.beginStroke(20, 100, 1, '#000000');
            for (let x = 21; x <= 180; x++) b.moveStroke(x, 100, 1, '#000000');
            b.endStroke();
            for (let y = 70; y < 100; y++) if (L.getImageData(100, y, 1, 1).data[3] > 20) return y;
            return -1;
        };
        return JSON.stringify([await row('none'), await row('direction')]);
    })()`, { awaitPromise: true }));
    check("...and a turned picture tip's smear sits a row above an unturned one's, as Krita's does (Rake Smudge)",
        rks[0] === 85 && rks[1] === 84, JSON.stringify(rks));
    /* Measured against a real Krita dab (test/krita): its "soft" tip reads
     * the curve at the SQUARED radius, and its curves are splines. Read at
     * the plain radius, Airbrush Soft came out at 0.59x Krita's ink. And a
     * subtract masking brush is a second stroke taken off the first, which
     * is what makes Waterpaint Soft Edges hollow (it was 4.2x too dark). */
    const soft = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        const dab = (set, at) => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            b.setParam('size', 40); b.setParam('hardness', 100);
            b.setParam('flowSrc', 'none'); b.setParam('sizeSrc', 'none'); b.setParam('smoothingMode', 'none');
            set();
            __B.layer().ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(100, 100, 1, '#000000');
            b.endStroke();
            return at.map(x => __B.layer().ctx.getImageData(x, 100, 1, 1).data[3]);
        };
        return JSON.stringify({
            line: dab(() => { b.setParam('curveSmooth', true); b.setParam('tipCurve', [[0, 1], [1, 0]]); }, [110]),
            spline: dab(() => { b.setParam('curveSmooth', true); b.setParam('tipCurve', [[0, 1], [0.5, 0.2], [1, 0]]); }, [110]),
            hollow: dab(() => { b.setParam('maskOp', 'subtract'); b.setParam('maskSize', 50); b.setParam('maskFlow', 100); }, [100, 116])
        });
    })()`));
    // r = 0.5: 1 - r^2 = 0.75 (191); read at r it was 0.5 (128).
    check("Krita's soft tip reads its curve at the squared radius",
        soft.line[0] > 175 && soft.line[0] < 205, 'alpha ' + soft.line[0]);
    // Spline through (0,1) (0.5,0.2) (1,0) at 0.25 is 0.55 (140); a straight line gives 0.6 (153).
    check("...and bends it the way Krita's spline does",
        soft.spline[0] > 125 && soft.spline[0] < 148, 'alpha ' + soft.spline[0]);
    check('a subtract masking brush hollows the dab out',
        soft.hollow[0] < 10 && soft.hollow[1] > 240, JSON.stringify(soft.hollow));
    /* Charcoal Pencil adds its masking stroke on (linear dodge), but only
     * where the stroke already has ink, and the mask builds up to its own
     * opacity like any Krita stroke (KisMaskingBrushCompositeOp). */
    const dodge = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        const run = (pts, pr) => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            b.setParam('size', 20); b.setParam('hardness', 100); b.setParam('flow', 20);
            b.setParam('flowSrc', 'none'); b.setParam('sizeSrc', 'none'); b.setParam('smoothingMode', 'none');
            b.setParam('maskOp', 'add'); b.setParam('maskSize', 200); b.setParam('maskSpacing', 10);
            b.setParam('maskOpacitySrc', 'pressure'); b.setParam('maskOpacityMin', 0); b.setParam('maskOpacityCurve', [[0, 0], [1, 1]]);
            __B.layer().ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(pts[0][0], pts[0][1], pr, '#000000');
            for (const p of pts.slice(1)) b.moveStroke(p[0], p[1], pr, '#000000');
            b.endStroke();
            return [100, 116].map(y => __B.layer().ctx.getImageData(100, y, 1, 1).data[3]);
        };
        const line = [];
        for (let x = 60; x <= 140; x += 2) line.push([x, 100]);
        return JSON.stringify({ one: run([[100, 100]], 0.5), many: run(line, 0.5) });
    })()`));
    check('a linear-dodge masking brush adds its stroke on where there is ink, and nowhere else',
        dodge.one[0] > 160 && dodge.one[0] < 200 && dodge.one[1] === 0, JSON.stringify(dodge));
    check('...and its dabs build up to their own opacity, not past it',
        dodge.many[0] - dodge.one[0] < 90 && dodge.many[1] === 0, JSON.stringify(dodge));
    /* The masking stroke keeps its own spacing between the main dabs:
     * riding them, Waterpaint Hard Edges' mask, spaced closer than its
     * brush, eroded a quarter too little. Main dabs 20px apart, mask dabs
     * 6px at a flow of 0.3: ten of them over the centre clear it, three
     * leave a third of the ink. */
    const mkGap = await page.eval(`(() => {
        const b = PaintApp.brush;
        b.forgetSaved('Round'); b.loadPreset('Round');
        b.setParam('size', 20); b.setParam('hardness', 100); b.setParam('spacing', 100);
        b.setParam('flowSrc', 'none'); b.setParam('sizeSrc', 'none'); b.setParam('smoothingMode', 'none');
        b.setParam('maskOp', 'subtract'); b.setParam('maskSize', 300); b.setParam('maskSpacing', 10); b.setParam('maskFlow', 30);
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(60, 100, 1, '#000000');
        for (let x = 61; x <= 140; x++) b.moveStroke(x, 100, 1, '#000000');
        b.endStroke();
        return __B.layer().ctx.getImageData(100, 100, 1, 1).data[3];
    })()`);
    check('a masking stroke spaces its own dabs, not only where the brush lays one',
        mkGap < 40, 'alpha ' + mkGap);
    /* RGBA Impasto multiplies its stroke by its masking stroke, and its
     * masking tip is a pipe of seven rocks: one at random a dab, not the
     * whole strip squeezed into one. A two-square strip stamped whole is a
     * bar half as tall as the dab, and cut it is the square. */
    const mul = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, c = document.createElement('canvas');
        c.width = 64; c.height = 32; c.getContext('2d').fillRect(0, 0, 64, 32);
        const run = async (set) => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            b.setParam('size', 40); b.setParam('hardness', 100);
            b.setParam('flowSrc', 'none'); b.setParam('sizeSrc', 'none'); b.setParam('smoothingMode', 'none');
            b.setParam('maskOp', 'multiply'); b.setParam('maskSize', 100); b.setParam('maskSpin', 0);
            await set();
            __B.layer().ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(100, 100, 1, '#000000');
            b.endStroke();
            return [100, 114].map(y => __B.layer().ctx.getImageData(100, y, 1, 1).data[3]);
        };
        return JSON.stringify({
            quarter: await run(() => b.setParam('maskOpacity', 25)),
            cells: await run(async () => { b.loadDualTip(c.toDataURL()); await new Promise(r => setTimeout(r, 300));
                b.setParam('maskPicture', true); b.setParam('maskCells', 2); })
        });
    })()`, { awaitPromise: true }));
    check('a multiply masking brush keeps the stroke times its mask',
        mul.quarter[0] > 55 && mul.quarter[0] < 75, JSON.stringify(mul.quarter));
    check("...and a strip of masking tips lays one of them a dab, at the dab's size",
        mul.cells[0] > 240 && mul.cells[1] > 240, JSON.stringify(mul.cells));
    /* RGBA Rake keeps the lesser of its stroke and its masking stroke
     * (Krita's darken), and its tines run along the line: a wide bar of a
     * mask, turned down a downward line, leaves a strip a bar tall wide. */
    const rake = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, c = document.createElement('canvas'), L = __B.layer().ctx;
        c.width = 64; c.height = 16; c.getContext('2d').fillRect(0, 0, 64, 16);
        const reset = () => { b.forgetSaved('Round'); b.loadPreset('Round');
            b.setParam('size', 40); b.setParam('hardness', 100);
            b.setParam('flowSrc', 'none'); b.setParam('sizeSrc', 'none'); b.setParam('smoothingMode', 'none');
            b.setParam('maskOp', 'min'); b.setParam('maskSize', 100); b.setParam('maskSpin', 0); };
        reset(); b.setParam('maskOpacity', 25);
        L.clearRect(0, 0, 200, 200);
        b.beginStroke(100, 100, 1, '#000000'); b.endStroke();
        const dark = L.getImageData(100, 100, 1, 1).data[3];
        reset(); b.loadDualTip(c.toDataURL()); await new Promise(r => setTimeout(r, 300));
        b.setParam('maskPicture', true); b.setParam('maskAlong', true);
        L.clearRect(0, 0, 200, 200);
        b.beginStroke(100, 40, 1, '#000000');
        for (let y = 41; y <= 160; y++) b.moveStroke(100, y, 1, '#000000');
        b.endStroke();
        const d = L.getImageData(0, 100, 200, 1).data; let w = 0;
        for (let x = 0; x < 200; x++) if (d[x * 4 + 3] > 128) w++;
        b.setParam('maskAlong', false);
        return JSON.stringify({ dark, w });
    })()`, { awaitPromise: true }));
    check('a darken masking brush keeps the lesser of the stroke and its mask',
        rake.dark > 55 && rake.dark < 75, 'alpha ' + rake.dark);
    check('...and a masking tip set to the drawing angle turns with the line',
        rake.w > 4 && rake.w < 20, rake.w + ' columns');
    /* Fuzzy is additive in Krita: it scales the size whatever the option's
     * mode. Impasto-details takes the max of fuzzy and pressure, and at full
     * pressure painted every dab full size here, random ones in Krita. */
    const fzAdd = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        b.forgetSaved('Round'); b.loadPreset('Round');
        b.setParam('size', 30); b.setParam('hardness', 100); b.setParam('spacing', 300);
        b.setParam('flowSrc', 'none'); b.setParam('smoothingMode', 'none');
        b.setParam('sizeSrc', 'random'); b.setParam('sizeMin', 0); b.setParam('sizeCombine', 2);
        b.setParam('sizeSensors', [{ src: 'random', curve: null, kind: 'scale' }, { src: 'pressure', curve: [[0, 0], [1, 1]], kind: 'scale' }]);
        const L = __B.layer().ctx;
        L.clearRect(0, 0, 200, 200);
        b._setStrokeSeed(7); b.beginStroke(10, 100, 1, '#000000');
        for (let x = 11; x <= 190; x++) b.moveStroke(x, 100, 1, '#000000');
        b.endStroke(); b._setStrokeSeed(null);
        const d = L.getImageData(0, 0, 200, 200).data, h = [];
        let run = 0;   // each dab's height: the tallest column of each run of inked columns
        for (let x = 0; x < 200; x++) { let n = 0; for (let y = 0; y < 200; y++) if (d[(y * 200 + x) * 4 + 3] > 128) n++;
            if (n) run = Math.max(run, n); else if (run) { h.push(run); run = 0; } }
        b.setParam('sizeSensors', null); b.setParam('sizeCombine', 0); b.setParam('sizeSrc', 'none');
        return JSON.stringify([Math.min(...h), Math.max(...h)]);
    })()`));
    check("Krita's fuzzy scales the size even under the max of it and pressure",
        fzAdd[1] - fzAdd[0] > 3, JSON.stringify(fzAdd));
    /* Krita's plain square, measured against lone Krita dabs (test/krita/
     * probes/chalk, gchar2): turned 270 it is square to the pixel grid
     * (the cache's 3.82-degree step for a 30px tip had it at 271.2, its
     * ends leaning a pixel), it sits at its sub-pixel phase like the
     * circle, and a thin one spaces on a slant by an ellipse whose axes
     * are each floored at half a pixel (MIN_DISTANCE_SPACING), not the
     * ellipse floored after. X1DC Chalk 0.64 -> 1, Grease Charcoal 1.09 -> 0.99. */
    const ksq = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = () => __B.layer().ctx;
        const base = () => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            b.setParam('shape', 'square'); b.setParam('falloff', 'krita'); b.setParam('hardness', 90);
            b.setParam('flowSrc', 'none'); b.setParam('sizeSrc', 'none'); b.setParam('smoothingMode', 'none'); b.setParam('angleSrc', 'none');
            L().clearRect(0, 0, 200, 200);
        };
        const ink = (x0, y0, w, h) => { let s = 0; const d = L().getImageData(x0, y0, w, h).data; for (let i = 3; i < d.length; i += 4) s += d[i]; return s; };
        // a 30x9 bar turned 270: its end row the same all along
        base(); b.setParam('size', 30); b.setParam('aspectRatio', 3.33); b.setParam('angle', 270);
        b.beginStroke(100, 100, 1, '#000000'); b.endStroke();
        let end = [];
        for (let y = 80; y < 120 && !end.length; y++) {
            const r = Array.from(L().getImageData(80, y, 40, 1).data).filter((v, i) => i % 4 === 3);
            if (r.filter(v => v > 0).length > 4) end = r.slice(r.findIndex(v => v > 0), 40 - r.slice().reverse().findIndex(v => v > 0));
        }
        // a 9px square a quarter pixel right of a pixel centre: its middle there too
        base(); b.setParam('size', 9);
        b.beginStroke(100.75, 100.5, 1, '#000000'); b.endStroke();
        const d = L().getImageData(90, 90, 20, 20).data; let s = 0, sx = 0;
        for (let i = 0; i < 400; i++) { s += d[i * 4 + 3]; sx += d[i * 4 + 3] * (90 + i % 20 + 0.5); }
        const row = Array.from(L().getImageData(92, 100, 16, 1).data).filter((v, i) => i % 4 === 3), col = Array.from(L().getImageData(100, 92, 1, 16).data).filter((v, i) => i % 4 === 3);
        // a 40x4 bar at 10% spacing, along and on the diagonal, the same length
        const bar = (x1, y1) => {
            base(); b.setParam('size', 40); b.setParam('aspectRatio', 10); b.setParam('angle', 90); b.setParam('spacing', 10); b.setParam('flow', 1);
            b.beginStroke(50, 50, 1, '#000000');
            for (let t = 1; t <= 100; t++) b.moveStroke(50 + x1 * t / 100, 50 + y1 * t / 100, 1, '#000000');
            b.endStroke();
            return ink(0, 0, 200, 200);
        };
        return JSON.stringify({ end, cx: sx / s, row: [row, col],
            slant: bar(70.71, 70.71) / bar(100, 0) });
    })()`));
    check("a Krita square turned square stays square to the pixels",
        ksq.end.every((v, i) => Math.abs(v - ksq.end[ksq.end.length - 1 - i]) <= 2), JSON.stringify(ksq.end));
    // Krita's mask is built at the phase: one soft column, none across.
    // Drawn whole and slid there, it smeared both edges (64/191, 128/128).
    check("...sits at its sub-pixel phase, built there rather than smeared",
        Math.abs(ksq.cx - 100.75) < 0.1 && ksq.row.flat().filter(v => v > 0 && v < 255).length <= 1,
        ksq.cx + ' ' + JSON.stringify(ksq.row));
    check("...and spaces a thin bar on a slant by an ellipse with each axis floored at half a pixel",
        ksq.slant < 0.85, String(ksq.slant));
    // A Clip Studio tip that turns with the stroke lays nothing on a click (dirWait); a plain one does.
    const dw = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = () => __B.layer().ctx, out = [];
        for (const w of [true, false]) {
            b.forgetSaved('Round'); b.loadPreset('Round'); b.setParam('dirWait', w); L().clearRect(0, 0, 200, 200);
            b.beginStroke(100, 100, 1, '#000000'); b.endStroke();
            let s = 0; const d = L().getImageData(80, 80, 40, 40).data; for (let i = 3; i < d.length; i += 4) s += d[i]; out.push(s);
        }
        b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify(out);
    })()`));
    check("a tip that turns with the stroke lays nothing on a click", dw[0] === 0 && dw[1] > 1000, JSON.stringify(dw));
    /* Krita's spikes fold every point back into the first wedge, so a 30x15
     * oval with 3 spikes is a rounded triangle: one point reaching 15px
     * along its axis, the far side only the oval's 8px at 60 degrees
     * (KisMaskGenerator::fixRotation; test/krita/probes/bbchalk, BB-Chalk
     * pencil 2 ink 1.7 -> 1.01). It was drawn as the plain oval. */
    const spk = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = () => __B.layer().ctx;
        b.forgetSaved('Round'); b.loadPreset('Round');
        b.setParam('falloff', 'krita'); b.setParam('hardness', 100); b.setParam('size', 30); b.setParam('aspectRatio', 2); b.setParam('spikes', 3);
        b.setParam('flowSrc', 'none'); b.setParam('sizeSrc', 'none'); b.setParam('smoothingMode', 'none'); b.setParam('angleSrc', 'none');
        L().clearRect(0, 0, 200, 200);
        b.beginStroke(100, 100, 1, '#000000'); b.endStroke();
        const r = Array.from(L().getImageData(80, 100, 40, 1).data).filter((v, i) => i % 4 === 3);
        return JSON.stringify({ left: 20 - r.findIndex(v => v > 0), right: 40 - r.slice().reverse().findIndex(v => v > 0) - 20 });
    })()`));
    check("a Krita tip with 3 spikes is a triangle: one point along its axis, the far side short",
        spk.right >= 14 && spk.left <= 10, JSON.stringify(spk));
    /* Sharpness snaps a dab to whole pixels only with "align outline"
     * ticked (KisSharpnessOption::apply), which no banked preset does; and
     * it thresholds the dab after the generator's noise. X1CI Sketch's 2px
     * oval, snapped, fell between pixel centres and painted nothing; its
     * density speckle, thresholded first, came out dimmed where Krita's is
     * solid (test/krita/probes/x1ci: lone dabs 0 -> 1.01, line 0.73 -> 0.98). */
    const ksh = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, L = () => __B.layer().ctx;
        const line = (dn) => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            b.setParam('falloff', 'krita-gauss'); b.setParam('size', 2); b.setParam('aspectRatio', 2.86); b.setParam('angle', 270);
            b.setParam('sharpness', 100); b.setParam('tipDensity', dn); b.setParam('tipRandomness', dn < 1 ? 0.5 : 0);
            b.setParam('flowSrc', 'none'); b.setParam('sizeSrc', 'none'); b.setParam('smoothingMode', 'none'); b.setParam('angleSrc', 'none');
            L().clearRect(0, 0, 200, 200);
            b.beginStroke(20, 100, 1, '#000000');
            for (let t = 1; t <= 50; t++) b.moveStroke(20 + t * 3, 100, 1, '#000000');
            b.endStroke();
            return Array.from(L().getImageData(0, 90, 200, 20).data).filter((v, i) => i % 4 === 3 && v > 0);
        };
        const a = line(1), n = line(0.7);
        return JSON.stringify({ plain: a.length, partial: n.filter(v => v < Math.max(...n)).length, noisy: n.length });
    })()`));
    check("a sharp 2px Krita oval paints off the pixel grid",
        ksh.plain > 100, JSON.stringify(ksh));
    check("...and its density speckle is thresholded solid, not dimmed",
        ksh.noisy > 50 && ksh.partial === 0, JSON.stringify(ksh));
    /* Krita spaces dabs by the box around the tip turned by its fixed angle
     * (KisBrush::characteristicSize). A 20x5 tip at 45 degrees has a
     * 17.7px box, so at 100% spacing its dabs stand apart along a line; an
     * ellipse turned with the tip packed them 6.9px apart, touching.
     * Charcoal Pencil laid a fifth too many dabs that way. */
    const boxRuns = await page.eval(`(() => {
        const b = PaintApp.brush;
        b.forgetSaved('Round'); b.loadPreset('Round');
        b.setParam('size', 20); b.setParam('aspectRatio', 4); b.setParam('angle', 45); b.setParam('spacing', 100);
        b.setParam('hardness', 100); b.setParam('falloff', 'krita');
        b.setParam('flowSrc', 'none'); b.setParam('sizeSrc', 'none'); b.setParam('smoothingMode', 'none');
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(30, 100, 1, '#000000');
        for (let x = 31; x <= 170; x++) b.moveStroke(x, 100, 1, '#000000');
        b.endStroke();
        const d = __B.layer().ctx.getImageData(30, 100, 140, 1).data;
        let runs = 0, on = false;
        for (let i = 3; i < d.length; i += 4) { const ink = d[i] > 20; if (ink && !on) runs++; on = ink; }
        return runs;
    })()`);
    check("dabs are spaced by the box around the turned tip, as Krita's are", boxRuns >= 6 && boxRuns <= 9, 'runs of ink ' + boxRuns);
    /* Krita keeps a generated tip's width and height as whole pixels and
     * spaces by them: 30 at ratio 0.28 is 30x8, so an upright line's dabs
     * fall 8 * 1.47 = 11.8 apart, not 12.4 (special_shadow 0.72 -> 0.96). */
    const whole = await page.eval(`(() => {
        const b = PaintApp.brush;
        b.forgetSaved('Round'); b.loadPreset('Round');
        for (const [k, v] of Object.entries({ size: 30, aspectRatio: 3.57, spacing: 147, hardness: 100, falloff: 'krita',
            spacingWhole: true, flowSrc: 'none', sizeSrc: 'none', smoothingMode: 'none' })) b.setParam(k, v);
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(100, 20, 1, '#000000');
        for (let y = 21; y <= 180; y++) b.moveStroke(100, y, 1, '#000000');
        b.endStroke();
        const d = __B.layer().ctx.getImageData(100, 0, 1, 200).data;
        let last = 0; for (let y = 0; y < 200; y++) if (d[y * 4 + 3] > 128) last = y;
        b.forgetSaved('Round'); b.loadPreset('Round');
        return last;
    })()`);
    // 13 gaps of 11.76 put the last dab's centre at 172.9, 12 of 12.35 at 168.2
    check("a Krita tip's dabs are spaced by its whole-pixel height", whole >= 175 && whole <= 178, 'last inked row ' + whole);
    /* Krita builds a small round dab at its true size and sub-pixel place;
     * rounded to a sixteenth, Line Marker's 1px line scored IoU 0.72. Dabs
     * a hundredth of a pixel or of a size apart must not come out the same. */
    const exact = await page.eval(`(() => {
        const b = PaintApp.brush;
        b.forgetSaved('Round'); b.loadPreset('Round');
        for (const [k, v] of Object.entries({ hardness: 50, falloff: 'krita', flowSrc: 'none', sizeSrc: 'none', smoothingMode: 'none' })) b.setParam(k, v);
        const dab = (x, sz) => {
            b.setParam('size', sz);
            __B.layer().ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(x, 100.53, 1, '#000000'); b.endStroke();
            return Array.from(__B.layer().ctx.getImageData(95, 95, 10, 10).data).join();
        };
        const r = [dab(100.30, 2.54) !== dab(100.31, 2.54), dab(100.30, 2.52) !== dab(100.30, 2.54)];
        b.forgetSaved('Round'); b.loadPreset('Round');
        return r;
    })()`);
    check("a small Krita dab is built at its exact place and size", exact[0] && exact[1], 'place, size differ: ' + exact);
    /* Krita caps a dab at the stroke's running opacity, which eases down a
     * tenth at a time when pressure falls: after a drop from 1 to 0.3 the
     * ink stacks past 0.3 (Nylnook Airbrush 0.88 -> 0.99). */
    const avgOp = await page.eval(`(() => {
        const b = PaintApp.brush;
        b.forgetSaved('Round'); b.loadPreset('Round');
        for (const [k, v] of Object.entries({ size: 20, spacing: 10, hardness: 100, falloff: 'krita', dabOpacitySrc: 'pressure', dabOpacityMin: 0,
            flowSrc: 'none', sizeSrc: 'none', smoothingMode: 'none' })) b.setParam(k, v);
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(30, 100, 1, '#000000');
        for (let x = 31; x <= 170; x++) b.moveStroke(x, 100, x <= 150 ? 1 : 0.3, '#000000');
        b.endStroke();
        const a = __B.layer().ctx.getImageData(174, 100, 1, 1).data[3];
        b.forgetSaved('Round'); b.loadPreset('Round');
        return a;
    })()`);
    check("a Krita dab caps at the stroke's running opacity when pressure falls", avgOp > 90, 'alpha after the drop ' + avgOp);
    /* Krita's softness option scales a soft tip's inner curve points, and
     * its plain circle's hardness, by the sensor (Watercolor Stroke Dry
     * 1.49x ink -> 0.88x at light pressure). One dab at pressure 0.3, 0.5: */
    const softK = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        const dab = (o, pr, x) => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            for (const [k, v] of Object.entries(Object.assign({ size: 40, spacing: 10, flowSrc: 'none', sizeSrc: 'none', smoothingMode: 'none',
                softnessSrc: 'pressure', softnessMin: 0, softnessCurve: [[0, 0], [1, 1]] }, o))) b.setParam(k, v);
            __B.layer().ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(100, 100, pr, '#000000'); b.endStroke();
            return __B.layer().ctx.getImageData(x, 100, 1, 1).data[3];
        };
        const r = { curve: dab({ tipCurve: [[0, 0.5], [1, 0.5]] }, 0.3, 114), circle: dab({ falloff: 'krita', hardness: 80 }, 0.5, 112) };
        b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify(r);
    })()`));
    /* A sketch line wider than a pixel is KisPainter::drawLine: every pixel
     * within half the width of it, hard -- 9 rows for 8, all solid. */
    const skRows = await page.eval(`(() => {
        const b = PaintApp.brush;
        b.forgetSaved('Round'); b.loadPreset('Round');
        for (const [k, v] of Object.entries({ engineKind: 'sketch', sketchWidth: 8, flow: 100, flowSrc: 'none', sizeSrc: 'none', smoothingMode: 'none' })) b.setParam(k, v);
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(40, 100, 1, '#000000'); b.moveStroke(160, 100, 1, '#000000'); b.endStroke();
        const d = __B.layer().ctx.getImageData(100, 80, 1, 40).data, a = [];
        for (let i = 0; i < 40; i++) if (d[i * 4 + 3]) a.push(d[i * 4 + 3]);
        b.forgetSaved('Round'); b.loadPreset('Round');
        return a.join();
    })()`);
    // Krita's round marker: solid to the radius, then a pixel's fade linear in the squared distance
    const mkRows = await page.eval(`(() => {
        const b = PaintApp.brush;
        b.forgetSaved('Round'); b.loadPreset('Round');
        b.setParam('size', 11); b.setParam('falloff', 'marker'); b.setParam('hardness', 100); b.setParam('spacing', 400);
        b.setParam('flowSrc', 'none'); b.setParam('sizeSrc', 'none'); b.setParam('smoothingMode', 'none');
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(100.5, 100.5, 1, '#000000'); b.endStroke();
        const d = __B.layer().ctx.getImageData(100, 80, 1, 40).data, a = [];
        for (let i = 0; i < 40; i++) if (d[i * 4 + 3]) a.push(d[i * 4 + 3]);
        b.forgetSaved('Round'); b.loadPreset('Round');
        return a.join();
    })()`);
    // Krita's soft square reads its curve as c(t) (1 - c(1 - t)) on each axis: a late fall keeps only the middle
    const csq = await page.eval(`(() => {
        const b = PaintApp.brush;
        b.forgetSaved('Round'); b.loadPreset('Round');
        for (const [k, v] of Object.entries({ shape: 'square', size: 40, hardness: 0, falloff: 'krita-soft', spacing: 400, flowSrc: 'none', sizeSrc: 'none',
            smoothingMode: 'none', tipCurve: [[0, 1], [0.73, 0.877], [0.767, 0.412], [1, 0]] })) b.setParam(k, v);
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(100, 100, 1, '#000000'); b.endStroke();
        const d = __B.layer().ctx.getImageData(70, 100, 60, 1).data;
        let n = 0; for (let i = 0; i < 60; i++) if (d[i * 4 + 3] > 128) n++;
        b.forgetSaved('Round'); b.loadPreset('Round');
        return n;
    })()`);
    check("a Krita soft square keeps only the middle its curve leaves (Block tilt fill)", csq >= 6 && csq <= 12, csq + 'px solid');
    // A curve that ends above nothing still stops at the rim, not the tip's box (Bold_marker)
    const cc = await page.eval(`(() => {
        const b = PaintApp.brush;
        b.forgetSaved('Round'); b.loadPreset('Round');
        for (const [k, v] of Object.entries({ size: 40, hardness: 0, spacing: 400, flowSrc: 'none', sizeSrc: 'none',
            smoothingMode: 'none', tipCurve: [[0, 0.4], [1, 0.4]] })) b.setParam(k, v);
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(100, 100, 1, '#000000'); b.endStroke();
        const L = __B.layer().ctx, r = { corner: L.getImageData(84, 84, 1, 1).data[3], mid: L.getImageData(100, 100, 1, 1).data[3] };
        b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify(r);
    })()`);
    check("a curved circle leaves its box corners clear (Bold_marker)", /"corner":0,/.test(cc) && !/"mid":0}/.test(cc), cc);

    // Krita's fan corners: a turn sharper than the step is filled a step at a time, and a stroke's first
    // turn is from the canvas origin's angle, so a thin bar drawn leftward fans up where it starts (Wood_Fiber)
    const fanc = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, out = [];
        for (const fanStep of [0, 10]) {
            b.forgetSaved('Round'); b.loadPreset('Round');
            for (const [k, v] of Object.entries({ size: 20, hardness: 100, shape: 'square', aspectRatio: 10, spacing: 10, flowSrc: 'none',
                sizeSrc: 'none', smoothingMode: 'none', angleSrc: 'direction', originAngle: true, fanStep })) b.setParam(k, v);
            __B.layer().ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(150, 100, 1, '#000000');
            for (let x = 149; x >= 50; x--) b.moveStroke(x, 100, 1, '#000000');
            b.endStroke();
            const d = __B.layer().ctx.getImageData(140, 88, 20, 8).data;
            let s = 0; for (let i = 3; i < d.length; i += 4) s += d[i];
            out.push(s);
        }
        b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify(out);
    })()`));
    check("a fanned brush turns through its corners, from the origin's angle at the start (Wood_Fiber)", fanc[1] > 4 * fanc[0], JSON.stringify(fanc));

    // Krita's alpha darken in its own 8 bits: at 3% flow (8 levels) a step under half a level is lost,
    // so a line at opacity 128 stalls about 16 levels under it, at 112 (Basic Paint); the browser's lighten sat at 97
    const stall = await page.eval(`(() => {
        const b = PaintApp.brush;
        b.forgetSaved('Round'); b.loadPreset('Round');
        for (const [k, v] of Object.entries({ size: 20, hardness: 100, spacing: 5, flow: 3, flowSrc: 'none', sizeSrc: 'none',
            dabOpacitySrc: 'pressure', dabOpacityCurve: [[0, 0], [1, 1]], smoothingMode: 'none', falloff: 'krita-aa' })) b.setParam(k, v);
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(20, 100, 0.5, '#000000');
        for (let i = 1; i <= 3200; i++) { const t = i % 320; b.moveStroke(20 + (t < 160 ? t : 320 - t), 100, 0.5, '#000000'); }   // ten times over
        b.endStroke();
        const a = __B.layer().ctx.getImageData(100, 100, 1, 1).data[3];
        b.forgetSaved('Round'); b.loadPreset('Round');
        return a;
    })()`);
    check("a low-flow line stalls short of its opacity, as Krita's 8 bits do (Basic Paint)", stall >= 108 && stall <= 116, stall);

    // Krita's soft circle, pixel for pixel: at 8px Layout_circle_soft's curve holds 14.2 of ink
    // (its bank line matches Krita within 2%); drawn as a gradient it held 13.0
    const scs = await page.eval(`(() => {
        const b = PaintApp.brush;
        b.forgetSaved('Round'); b.loadPreset('Round');
        for (const [k, v] of Object.entries({ size: 8, hardness: 0, spacing: 400, flowSrc: 'none', sizeSrc: 'none',
            smoothingMode: 'none', tipCurve: [[0, 1], [0.317269, 0.337662], [1, 0]], falloff: 'krita-soft-aa' })) b.setParam(k, v);
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(100, 100, 1, '#000000'); b.endStroke();
        const d = __B.layer().ctx.getImageData(90, 90, 20, 20).data; let s = 0;
        for (let i = 3; i < d.length; i += 4) s += d[i];
        b.forgetSaved('Round'); b.loadPreset('Round');
        return s / 255;
    })()`);
    check("a soft circle keeps all of Krita's ink at 8px (Layout_circle_soft)", scs > 13.8 && scs < 14.6, scs);
    check("a Krita round marker is a solid disc with a one-pixel fade", mkRows === [132].concat(Array(11).fill(255), [132]).join(), mkRows);
    check("a wide Krita sketch line is hard and a pixel past its width", skRows === Array(9).fill(255).join(), skRows);
    check("a Krita softness option softens the tip with pressure", softK.curve > 25 && softK.curve < 55 && softK.circle > 170 && softK.circle < 220, JSON.stringify(softK));
    /* Krita turns a tip by (1 - strength * sensor) * pi (KisRotationOption),
     * so Waterpaint's 0.19 random rotation is a small wobble about a half
     * turn, not the full spin it used to get. A flat 30x4 tip, dabs apart: */
    const wob = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        const tall = (strength, src = 'random') => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            b.setParam('size', 30); b.setParam('aspectRatio', 7.5); b.setParam('spacing', 150);
            b.setParam('hardness', 100); b.setParam('flowSrc', 'none'); b.setParam('sizeSrc', 'none'); b.setParam('smoothingMode', 'none');
            b.setParam('angleSrc', src); b.setParam('angleStrength', strength); b.setParam('angleCurve', [[0, 0], [1, 1]]);
            __B.layer().ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(20, 100, 1, '#000000');
            for (let x = 21; x <= 180; x++) b.moveStroke(x, 100, 1, '#000000');
            b.endStroke();
            const d = __B.layer().ctx.getImageData(0, 0, 200, 200).data;
            let top = 200, bot = 0;
            for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) if (d[(y * 200 + x) * 4 + 3] > 60) { top = Math.min(top, y); bot = Math.max(bot, y); }
            return bot - top + 1;
        };
        // pen rotation is additive in Krita: strength 0.5 at a 90 degree twist is a 225 degree turn, diagonal
        b.setPenState({ twist: 90 }); const tw = tall(0.5, 'twist'); b.setPenState({ twist: 0 });
        // drawing angle x pressure x tangential pressure (0 without a wheel): the list's scaling part is -1
        const list = (() => { const orig = b.setParam.bind(b); b.setParam = (k, v) => { orig(k, v); if (k === 'angleCurve') {
            orig('angleSensors', [{ src: 'direction', kind: 'abs', curve: [[0, 0], [1, 1]] }, { src: 'pressure', kind: 'scale' }, { kind: 'const', v: 0 }]); } };
            try { return tall(0.5, 'direction'); } finally { b.setParam = orig; } })();
        return JSON.stringify({ small: tall(0.1), full: tall(1), tw, list });
    })()`));
    check("a Krita rotation strength keeps the tip's turn to a wobble", wob.small <= 12 && wob.full >= 22, JSON.stringify(wob));
    check("...and so does pen rotation, an added turn: strength 0.5 at 90 degrees lies diagonal (Bear Paw)",
        wob.tw >= 18 && wob.tw <= 26, 'height ' + wob.tw);
    check("...and a list of inputs takes Krita's whole formula: a zero tangential pressure turns a flat tip a quarter off the stroke at strength 0.5 (Bristle_frottis0017)",
        wob.list >= 26, 'height ' + wob.list);
    /* A locked drawing angle belongs to the rotation that asked for it: a
     * size list reading the angle unlocked still follows the stroke
     * (Poska Triangle G's 13px bottom line came out 8). */
    const lockW = await page.eval(`(() => {
        const b = PaintApp.brush;
        b.forgetSaved('Round'); b.loadPreset('Round');
        for (const [k, v] of Object.entries({ size: 30, hardness: 100, spacing: 5, flowSrc: 'none', smoothingMode: 'none', sizeMin: 0,
            angleSrc: 'direction', angleLocked: true, sizeSensors: [{ kind: 'abs', curve: [[0, 0.3], [0.5, 1], [1, 0.3]] }] })) b.setParam(k, v);
        __B.layer().ctx.clearRect(0, 0, 200, 200);
        b.beginStroke(20, 100, 1, '#000000');
        for (let x = 21; x <= 180; x++) b.moveStroke(x, 100, 1, '#000000');
        b.endStroke();
        let n = 0;
        for (let y = 60; y < 140; y++) if (__B.layer().ctx.getImageData(100, y, 1, 1).data[3] > 128) n++;
        return n;
    })()`);
    check("a rotation's locked angle leaves an unlocked size input following the stroke", lockW >= 18, lockW + 'px');
    /* Krita smooths speed over the last few samples (KisSpeedSmoother) and
     * reads it against its own ceiling; with the clock stopped, as in the
     * headless Krita render, speed is 0. */
    const speed = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush, clock = performance.now;
        const run = (msPerPx) => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            b.setParam('size', 20); b.setParam('hardness', 100); b.setParam('smoothingMode', 'none');
            b.setParam('flowSrc', 'none'); b.setParam('speedMax', 3);
            b.setParam('sizeSrc', 'speed'); b.setParam('sizeMin', 20); b.setParam('sizeCurve', [[0, 0], [1, 1]]);
            __B.layer().ctx.clearRect(0, 0, 200, 200);
            let t = 1000; performance.now = () => t;
            try {
                b.beginStroke(20, 100, 1, '#000000');
                for (let x = 20.5; x <= 180; x += 0.5) { t += 0.5 * msPerPx; b.moveStroke(x, 100, 1, '#000000'); }   // 260 events by x=150 flush the 200-gap rate history earlier strokes left
                b.endStroke();
            } finally { performance.now = clock; }
            let n = 0;
            for (let y = 80; y < 120; y++) if (__B.layer().ctx.getImageData(150, y, 1, 1).data[3] > 128) n++;
            return n;
        };
        run(0);   // leaves a history of stopped-clock gaps behind, as the Krita harness does
        return JSON.stringify({ still: run(0), fast: run(1 / 3), slow: run(2 / 3) });
    })()`));
    check('speed reads 0 with the clock stopped, full at its ceiling, half at half of it',
        speed.still <= 5 && speed.fast >= 18 && speed.slow > speed.still + 3 && speed.slow < speed.fast - 3,
        JSON.stringify(speed));
    /* Small tips, measured against real Krita strokes (test/krita). */
    const small = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        const paint = (set, pts, x, ys, pr = 1) => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            b.setParam('flow', 100); b.setParam('hardness', 100);
            b.setParam('flowSrc', 'none'); b.setParam('sizeSrc', 'none'); b.setParam('smoothingMode', 'none');
            set();
            __B.layer().ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(pts[0][0], pts[0][1], pr, '#000000');
            for (const p of pts.slice(1)) b.moveStroke(p[0], p[1], pr, '#000000');
            b.endStroke();
            return ys.map(y => __B.layer().ctx.getImageData(x, y, 1, 1).data[3]);
        };
        const dot = [[100, 100]], line = [];
        for (let x = 40; x <= 160; x += 0.25) line.push([x, 100]);
        return JSON.stringify({
            aa: paint(() => { b.setParam('size', 5); b.setParam('falloff', 'krita-aa'); }, dot, 100, [97, 102]),
            // Pressure 0.08 of 5px: a 0.4px dab.
            tiny: paint(() => { b.setParam('size', 5); b.setParam('falloff', 'krita-aa');
                                b.setParam('sizeSrc', 'pressure'); b.setParam('sizeMin', 0); b.setParam('sizeCurve', [[0, 0], [1, 1]]); },
                        [[100.6, 100.6]], 100, [100], 0.08),   // lands up-left, see above
            rows: paint(() => { b.setParam('size', 3); b.setParam('hardness', 4); b.setParam('falloff', 'krita-gauss'); }, dot, 100, [98, 99, 100, 101]),
            stack: paint(() => { b.setParam('size', 3); b.setParam('hardness', 4); b.setParam('falloff', 'krita-gauss'); b.setParam('spacing', 15); }, line, 100, [99]),
            sharp: paint(() => { b.setParam('size', 1); b.setParam('falloff', 'krita-gauss'); b.setParam('sharpness', 100); }, dot, 100, [100])
        });
    })()`));
    // Supersampled from each pixel's corner (KisBrushMaskScalarApplicator): up and left by a third.
    check("Krita's small anti-aliased tip sits a third of a pixel up and left, as Krita's does",
        small.aa[0] > 20 && small.aa[1] === 0, JSON.stringify(small));
    check('a Krita dab under half a pixel still paints', small.tiny[0] > 0, 'alpha ' + small.tiny[0]);
    check('a 3px dab on a whole pixel covers two rows, not three',
        small.rows[1] === small.rows[2] && small.rows[1] > 60 && small.rows[0] < 10 && small.rows[3] < 10,
        JSON.stringify(small.rows));
    // Krita's floor is half a pixel (MIN_DISTANCE_SPACING); at 1px this line stacked to 159 where Krita's reach 225.
    check('dabs closer than a pixel apart stack up, as Krita lets them', small.stack[0] > 200, 'alpha ' + small.stack[0]);
    check('a sharpened 1px Krita tip still paints its pixel', small.sharp[0] > 200, 'alpha ' + small.sharp[0]);

    /* Found by the brush bank (test/krita/bank.mjs, test/gimp/bank.mjs). */
    const bank = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, L = () => __B.layer().ctx;
        const fresh = (set) => {
            b.forgetSaved('Round'); b.loadPreset('Round');
            b.setParam('flow', 100); b.setParam('hardness', 100); b.setParam('flowSrc', 'none');
            b.setParam('sizeSrc', 'none'); b.setParam('smoothingMode', 'none'); set();
        };
        const stroke = (pts) => {
            L().clearRect(0, 0, 200, 200);
            b.beginStroke(pts[0][0], pts[0][1], 1, '#000000');
            for (const p of pts.slice(1)) b.moveStroke(p[0], p[1], 1, '#000000');
            b.endStroke();
        };
        const col = (x, y0, y1) => Array.from({ length: y1 - y0 }, (_, i) => L().getImageData(x, y0 + i, 1, 1).data[3]);
        const out = {};
        // A 30x15 tip down a 60px line, dabs its own height apart twice over.
        fresh(() => { b.setParam('shape', 'square'); b.setParam('size', 30); b.setParam('aspectRatio', 2); b.setParam('spacing', 200); });
        const down = []; for (let y = 50; y <= 110; y++) down.push([100, y]);
        stroke(down);
        out.runs = col(100, 30, 140).reduce((n, a, i, c) => n + (a > 0 && !(c[i - 1] > 0) ? 1 : 0), 0);
        // EO Pixel Perfect: a 0.01px hard square.
        fresh(() => { b.setParam('shape', 'square'); b.setParam('size', 0.01); b.setParam('falloff', 'krita'); });
        stroke([[100.3, 100.3]]);
        out.hundredth = L().getImageData(95, 95, 10, 10).data.filter((v, i) => i % 4 === 3 && v > 0).length;
        // ZBlocks: Krita's gauss square, fade 0.43, is 18px of ink across 30.
        fresh(() => { b.setParam('shape', 'square'); b.setParam('size', 30); b.setParam('falloff', 'krita-gauss'); b.setParam('hardness', 43); });
        stroke([[100, 100]]);
        out.grect = [100, 112].map(x => L().getImageData(x, 100, 1, 1).data[3]);
        // Poska Square: a 7x4 anti-aliased gauss square is supersampled from the pixel's corner, a third up and left
        fresh(() => { b.setParam('shape', 'square'); b.setParam('size', 6.9); b.setParam('aspectRatio', 1.67); b.setParam('falloff', 'krita-gauss-aa'); b.setParam('hardness', 90); });
        stroke([[100, 60]]);
        { const d = L().getImageData(90, 50, 20, 20).data; let s = 0, sy = 0;
          for (let i = 3; i < d.length; i += 4) { s += d[i]; sy += d[i] * (50 + ((i - 3) / 4 / 20 | 0) + 0.5); }
          out.gsmall = sy / s; }
        // ...at its own size, not the first one cached for that whole pixel: 6.9 after 6.5 is bigger
        const gink = (sz) => { fresh(() => { b.setParam('shape', 'square'); b.setParam('size', sz); b.setParam('falloff', 'krita-gauss-aa'); b.setParam('hardness', 90); });
            stroke([[100, 60]]); return L().getImageData(90, 50, 20, 20).data.reduce((n, v, i) => n + (i % 4 === 3 ? v : 0), 0); };
        out.gsizes = [gink(6.5), gink(6.9)];
        // ...and its size option's strength scales the dab: 0.82 of 30 is 25 across
        fresh(() => { b.setParam('size', 30); b.setParam('sizeStrength', 0.82); });
        stroke([[100, 100]]);
        out.strength = L().getImageData(70, 100, 60, 1).data.filter((v, i) => i % 4 === 3 && v > 128).length;
        // Grease Charcoal: Krita's default square ramps straight from its fade to the edge.
        fresh(() => { b.setParam('shape', 'square'); b.setParam('size', 30); b.setParam('falloff', 'krita'); b.setParam('hardness', 50); });
        stroke([[100, 100]]);
        out.lrect = [100, 112].map(x => L().getImageData(x, 100, 1, 1).data[3]);
        // ...and anti-aliased, its fade reaches a pixel further in, so a 4.5px bar thins right through (Grease Charcoal)
        fresh(() => { b.setParam('shape', 'square'); b.setParam('size', 30); b.setParam('aspectRatio', 6.67); b.setParam('falloff', 'krita-aa');
                      b.setParam('hardness', 100); b.setParam('hardnessY', 31); });
        stroke([[100, 100]]);
        out.lrectAA = [97, 98, 99, 100, 101, 102].map(y => L().getImageData(100, y, 1, 1).data[3]);
        b.setParam('hardnessY', null);
        // PixelArt_Round: full sharpness keeps every pixel a cone tip touches.
        fresh(() => { b.setParam('size', 5); b.setParam('falloff', 'krita'); b.setParam('hardness', 0); b.setParam('sharpness', 100); });
        stroke([[100, 100]]);
        out.solid = L().getImageData(90, 90, 20, 20).data.filter((v, i) => i % 4 === 3 && v > 200).length;
        // Rock_flat: the threshold follows pressure, so a light dab keeps only its core
        const sharpDab = (pr) => { fresh(() => { b.setParam('size', 30); b.setParam('falloff', 'krita'); b.setParam('hardness', 0);
                b.setParam('sharpness', 100); b.setParam('sharpnessSrc', 'pressure'); b.setParam('sharpnessMin', 0); });
            L().clearRect(0, 0, 200, 200); b.beginStroke(100, 100, pr, '#000000'); b.endStroke();
            return L().getImageData(80, 80, 40, 40).data.filter((v, i) => i % 4 === 3 && v > 0).length; };
        out.sharpPress = [sharpDab(0.3), sharpDab(1)];
        b.setParam('sharpnessSrc', 'none');
        // Concept Line Marker: a 3px Krita round an eighth of a pixel on is not the one a quarter on.
        const edge = (x) => { fresh(() => { b.setParam('size', 3); b.setParam('falloff', 'krita'); b.setParam('hardness', 50); });
            stroke([[x, 100]]); return L().getImageData(101, 100, 1, 1).data[3]; };
        out.eighth = [edge(100.125), edge(100.25)];
        // Splats 02: a pipe stepped in order starts over when the brush is picked again.
        const gbr = (a) => { const n = new TextEncoder().encode('c\\0'), h = 28 + n.length, px = new Uint8Array(16); for (let y = 0; y < 4; y++) px[y * 4 + a] = 255;
            const u = new Uint8Array(h + 16), dv = new DataView(u.buffer);
            [h, 2, 4, 4, 1, 0x47494D50, 400].forEach((v, i) => dv.setUint32(i * 4, v)); u.set(n, 28); u.set(px, h); return u; };
        const head = new TextEncoder().encode('p\\n3 ncells:3 cellwidth:4 cellheight:4 step:100 dim:1 cols:1 rows:1 placement:constant rank0:3 sel0:incremental\\n');
        const cells = [0, 1, 2].map(gbr), gih = new Uint8Array(head.length + 3 * cells[0].length);
        gih.set(head); cells.forEach((c, i) => gih.set(c, head.length + i * c.length));
        const r = await b.importBrushTip(gih, 'cycle.gih');
        // each cell inks a different column, so the painted column names the cell
        const dot = () => { stroke([[100, 100]]); const d = L().getImageData(90, 100, 20, 1).data;
            let x = 0; for (let i = 1; i < 20; i++) if (d[i * 4 + 3] > d[x * 4 + 3]) x = i; return x; };
        const pick = async () => { b.loadPreset(r.name); b.setParam('size', 4); b.setParam('spacing', 100);
            await new Promise(res => setTimeout(res, 300)); };   // the strip decodes async
        await pick();
        const first = dot(), second = dot();
        await pick();
        out.cycle = [first, second, dot(), r.ok, r.name];
        b.deleteUserPreset(r.name);
        // paint_smudge_blurry: a pipe picked by pressure takes picture round(p * (n - 1))
        const headP = new TextEncoder().encode('p\\n3 ncells:3 cellwidth:4 cellheight:4 step:100 dim:1 cols:1 rows:1 placement:constant rank0:3 sel0:pressure\\n');
        const gihP = new Uint8Array(headP.length + 3 * cells[0].length);
        gihP.set(headP); cells.forEach((c, i) => gihP.set(c, headP.length + i * c.length));
        const rp = await b.importBrushTip(gihP, 'press.gih');
        b.loadPreset(rp.name); b.setParam('size', 4); b.setParam('spacing', 100); b.setParam('sizeSrc', 'none'); b.setParam('flowSrc', 'none');
        await new Promise(res => setTimeout(res, 300));
        const dotAt = (pr) => { L().clearRect(0, 0, 200, 200); b.beginStroke(100, 100, pr, '#000000'); b.endStroke();
            const d = L().getImageData(90, 100, 20, 1).data; let x = 0; for (let i = 1; i < 20; i++) if (d[i * 4 + 3] > d[x * 4 + 3]) x = i; return x; };
        out.pressPick = [0.1, 0.3, 0.5, 0.9, 1].map(dotAt);
        b.deleteUserPreset(rp.name);
        // GIMP's pixel.gbr: a 1px tip at a whole coordinate straddles four pixels.
        const one = (() => { const nm = new TextEncoder().encode('p' + String.fromCharCode(0)), h = 28 + nm.length, u = new Uint8Array(h + 1);
            const dv = new DataView(u.buffer); [h, 2, 1, 1, 1, 0x47494D50, 100].forEach((v, i) => dv.setUint32(i * 4, v));
            u.set(nm, 28); u[h] = 255; return u; })();
        const r1 = await b.importBrushTip(one, 'pixel.gbr');
        b.loadPreset(r1.name); b.setParam('size', 1); await new Promise(res => setTimeout(res, 300));
        stroke([[100, 100]]);
        out.straddle = [99, 100].flatMap(y => [99, 100].map(x => L().getImageData(x, y, 1, 1).data[3]));
        b.deleteUserPreset(r1.name);
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    check('a pipe picked by pressure takes the picture at round(pressure * (n - 1)) (paint_smudge_blurry)',
        bank.pressPick.join() === [0, 1, 1, 2, 2].map(i => bank.pressPick[0] + i).join(),
        JSON.stringify(bank.pressPick));
    check('the first gap is measured along the stroke too, not across it (GIMP goat)',
        bank.runs === 3, `${bank.runs} dabs`);
    check('a Krita tip a hundredth of a pixel wide still paints its pixel (EO Pixel Perfect)',
        bank.hundredth >= 1, `${bank.hundredth} pixels`);
    check("Krita's gauss square fades in from its edge, as Krita's does (ZBlocks)",
        bank.grect[0] > 200 && bank.grect[1] < 128, JSON.stringify(bank.grect));
    /* probes/defrect: it was drawn as a solid box whatever the fade. */
    check("Krita's default square fades linearly from its fade to the edge (Grease Charcoal)",
        bank.lrect[0] > 250 && bank.lrect[1] > 40 && bank.lrect[1] < 140, JSON.stringify(bank.lrect));
    // KisRectangleMaskGenerator's column integrates to 652 of 255ths; a plain ramp keeps 752
    { const sum = bank.lrectAA.reduce((a, v) => a + v, 0);
      check("an anti-aliased Krita square clears its thin side a pixel further in (Grease Charcoal)",
          Math.abs(sum - 652) <= 15, sum + ' ' + JSON.stringify(bank.lrectAA)); }
    check("a small anti-aliased gauss square sits a third of a pixel up, as Krita supersamples it from the corner (Poska Square)",
        bank.gsmall > 59.55 && bank.gsmall < 59.8, 'centre row ' + bank.gsmall.toFixed(3));
    check('...at its own fractional size, not the first one cached for that whole pixel', bank.gsizes[1] > bank.gsizes[0] * 1.05, bank.gsizes.join(' < '));
    check("a Krita size option's strength scales the dab (Poska Square's 0.82)", Math.abs(bank.strength - 25) <= 1, bank.strength + 'px');
    check("full sharpness keeps every pixel the tip touches, as Krita's threshold does",
        bank.solid >= 12, `${bank.solid} solid pixels`);
    check("Krita's sharpness follows its sensor: a light dab keeps only the core (Rock_flat)",
        bank.sharpPress[0] > 0 && bank.sharpPress[0] < bank.sharpPress[1] * 0.6, bank.sharpPress.join(' < '));
    check("a small Krita round sits at its own sixteenth of a pixel, not the nearest quarter",
        bank.eighth[0] < bank.eighth[1], JSON.stringify(bank.eighth));
    check('a GIMP pipe starts over from its first cell when the brush is picked again',
        bank.cycle[0] === bank.cycle[2] && bank.cycle[0] !== bank.cycle[1], JSON.stringify(bank.cycle));
    check('a 1px tip at a whole coordinate straddles four pixels, as GIMP places it',
        bank.straddle.every(a => a > 40 && a < 90), JSON.stringify(bank.straddle));
    check('pen rotation turns the tip', d.twistRotatesTip);
    check('hardness can be driven, which it never could', d.hardnessDrivable);
    check('scatter can be driven, which it never could', d.scatterDrivable);
    check('two parameters can follow different inputs at once', d.independent);
    check('the old Dynamics dropdown still works as a shortcut', d.shimSetsSizeSrc);
    check('switching that shortcut off restores the defaults', d.shimRestores);

    /* -- response curves ------------------------------------------------ */
    console.log('');
    console.log('== response curves ==');
    const cur = await page.eval(`(() => {
        const app = PaintApp, b = app.brush;
        __B.doc();
        const out = {};
        const fresh = () => {
            PaintApp.brush.forgetSaved('Round');
            b.loadPreset('Round');
            b.setParam('size', 20); b.setParam('spacing', 12);
            b.setParam('smoothingMode', 'none');
        };
        const strokePx = (pressure) => {
            __B.layer().ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(20, 100, pressure, '#000000');
            for (let i = 1; i <= 30; i++) b.moveStroke(20 + i * 5, 100, pressure, '#000000');
            b.endStroke();
            const d = __B.layer().ctx.getImageData(0, 0, 200, 200).data;
            let n = 0;
            for (let k = 3; k < d.length; k += 4) if (d[k] > 0) n++;
            return n;
        };

        // linear by default
        fresh();
        out.defaultLinear = [0, 0.25, 0.5, 0.75, 1]
            .every(v => Math.abs(b.evalCurve('size', v) - v) < 1e-6);

        // a curve is applied exactly as drawn
        fresh();
        b.setCurve('size', [[0, 0], [0.5, 0.9], [1, 1]]);
        out.at25  = +b.evalCurve('size', 0.25).toFixed(3);   // halfway to 0.9
        out.at50  = +b.evalCurve('size', 0.5).toFixed(3);
        out.at75  = +b.evalCurve('size', 0.75).toFixed(3);   // 0.9 -> 1.0
        out.piecewiseLinear = Math.abs(out.at25 - 0.45) < 1e-3
                           && Math.abs(out.at50 - 0.9) < 1e-3
                           && Math.abs(out.at75 - 0.95) < 1e-3;

        // and it actually changes what gets painted
        fresh();
        b.setParam('sizeSrc', 'pressure'); b.setParam('sizeMin', 0);
        const plain = strokePx(0.25);
        b.setCurve('size', [[0, 0], [0.5, 0.95], [1, 1]]);
        const curved = strokePx(0.25);
        out.curveChangesPaint = curved > plain * 1.3;

        // points come back sorted, clamped and capped
        fresh();
        b.setCurve('size', [[1, 1], [0.5, 2], [0, -1], [0.2, 0.3]]);
        const got = b.getCurve('size');
        out.sorted  = got.every((pt, i) => i === 0 || pt[0] >= got[i - 1][0]);
        out.clamped = got.every(pt => pt[0] >= 0 && pt[0] <= 1 && pt[1] >= 0 && pt[1] <= 1);
        fresh();
        b.setCurve('size', Array.from({ length: 20 }, (_, i) => [i / 19, i / 19]));
        out.capped = b.getCurve('size').length <= 8;

        // clearing goes back to linear
        fresh();
        b.setCurve('size', [[0, 0], [0.5, 0.9], [1, 1]]);
        b.setCurve('size', null);
        out.clearedLinear = Math.abs(b.evalCurve('size', 0.5) - 0.5) < 1e-6;

        // editing one brush's curve must not rewrite another's
        fresh();
        b.setCurve('size', [[0, 0], [0.5, 0.95], [1, 1]]);
        b.loadPreset('Thin Regular');
        out.otherPresetUntouched = Math.abs(b.evalCurve('size', 0.5) - 0.5) < 1e-6;
        b.loadPreset('Round');
        out.ownCurveKept = Math.abs(b.evalCurve('size', 0.5) - 0.95) < 1e-3;

        // the widget plots evalCurve, so what is drawn is what is applied
        const cv = document.getElementById('pb-size-curve');
        out.widgetExists = !!cv;
        return JSON.stringify(out);
    })()`);
    const c = JSON.parse(cur);
    console.log('  ' + cur);

    check('an untouched parameter responds linearly', c.defaultLinear);
    check('a curve is applied exactly as drawn', c.piecewiseLinear,
        `0.25→${c.at25}, 0.5→${c.at50}, 0.75→${c.at75}`);
    check('a curve changes what actually gets painted', c.curveChangesPaint);
    check('curve points are sorted by input', c.sorted);
    check('curve points are clamped into range', c.clamped);
    check('curve points are capped at 8', c.capped);
    check('clearing a curve returns it to linear', c.clearedLinear);
    check('editing one brush curve does not rewrite another brush',
        c.otherPresetUntouched, 'the curve leaked across presets');
    check('a brush keeps its own curve', c.ownCurveKept);
    check('the curve widget is in the panel', c.widgetExists);

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

    /* ================= brush library ================= */
    console.log('\n== brush library ==');

    const lib = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        const names = Object.keys(b.PRESETS);
        const filed = {};
        let dupes = [];
        let missing = [];
        b.PRESET_CATEGORIES.forEach(g => g.presets.forEach(n => {
            if (filed[n]) dupes.push(n);
            filed[n] = g.name;
            if (!b.PRESETS[n]) missing.push(n);
        }));
        const unfiled = names.filter(n => !filed[n]);
        // Every preset must load and leave the engine with usable params.
        let bad = [];
        names.forEach(n => {
            try {
                b.loadPreset(n);
                const p = b.getParams();
                if (!(p.size > 0) || !(p.spacing > 0)) bad.push(n);
            } catch (e) { bad.push(n + ':' + e.message); }
        });
        b.loadPreset('Round');
        return JSON.stringify({ count: names.length, dupes, missing, unfiled, bad,
            cats: b.PRESET_CATEGORIES.map(g => g.name) });
    })()`));
    console.log('  ' + JSON.stringify(lib));
    check('the library has a real number of brushes',
        lib.count >= 30, `only ${lib.count} presets`);
    check('every filed preset exists', lib.missing.length === 0, lib.missing.join(', '));
    check('no preset is filed under two families', lib.dupes.length === 0, lib.dupes.join(', '));
    check('every preset is filed under a family', lib.unfiled.length === 0, lib.unfiled.join(', '));
    check('every preset loads with usable params', lib.bad.length === 0, lib.bad.join(', '));

    /* Grain is what makes a chalk read as chalk. One shared white-noise tile
     * meant every textured brush fizzed the same way — and, being built with
     * Math.random(), differently in every session. */
    const tex = JSON.parse(await page.eval(`(() => {
        const app = PaintApp, b = app.brush;
        const run = (type) => {
            __B.doc();
            b.loadPreset('Round');
            ['sizeSrc','flowSrc','scatterSrc'].forEach(k => b.setParam(k, 'none'));
            b.setParam('size', 26);
            b.setParam('spacing', 12);
            b.setParam('texture', 90);
            b.setParam('textureScale', 3);
            b.setParam('textureType', type);
            b.beginStroke(30, 100, 1, '#000000');
            for (let x = 30; x <= 170; x += 4) b.moveStroke(x, 100, 1, '#000000');
            b.endStroke();
            return __B.hash(__B.layer());
        };
        const types = ['grain', 'chalk', 'canvas', 'spray', 'hatch'];
        const first = types.map(run);
        const second = types.map(run);
        PaintApp.brush.forgetSaved('Round');
        return JSON.stringify({ types, first, second });
    })()`));
    console.log('  ' + JSON.stringify(tex));
    check('each texture grain paints something different',
        new Set(tex.first).size === tex.types.length,
        'grains collided: ' + tex.first.join(' '));
    check('a texture grain is reproducible, not reseeded per run',
        tex.first.join() === tex.second.join(),
        'same brush, two runs, different pixels');

    const grid = JSON.parse(await page.eval(`(() => {
        PaintApp.brush.buildBrushGrid();
        const g = document.getElementById('pb-brush-grid');
        const heads = [...g.querySelectorAll('.pb-brush-group')].map(e => e.textContent);
        const tiles = g.querySelectorAll('.pb-brush-tile').length;
        // A header must be followed by at least one tile, never another header.
        let empty = [];
        [...g.children].forEach((el, i, all) => {
            if (el.classList.contains('pb-brush-group') &&
                (!all[i + 1] || all[i + 1].classList.contains('pb-brush-group'))) {
                empty.push(el.textContent);
            }
        });
        return JSON.stringify({ heads, tiles, empty,
            presets: Object.keys(PaintApp.brush.PRESETS).length });
    })()`));
    console.log('  ' + JSON.stringify(grid));
    check('the grid is grouped by family', grid.heads.length >= 6,
        `${grid.heads.length} family headers`);
    check('the grid shows every preset exactly once',
        grid.tiles === grid.presets, `${grid.tiles} tiles for ${grid.presets} presets`);
    check('no family header is left with no brushes under it',
        grid.empty.length === 0, grid.empty.join(', '));

    /* The fan used to be a radial burst: all its bristles pushed out from
     * the centre inside one wedge, so the head sat beside the pointer
     * instead of on it, further off the bigger the brush got. */
    const fan = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        const meas = (preset, angle) => {
            __B.doc();
            b.loadPreset(preset);
            b.setParam('angle', angle);
            b.beginStroke(40, 100, 1, '#000000');
            for (let x = 40; x <= 160; x += 3) b.moveStroke(x, 100, 1, '#000000');
            b.endStroke();
            const d = __B.layer().ctx.getImageData(0, 0, 200, 200).data;
            let sy = 0, n = 0, lo = 999, hi = -1;
            for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
                if (d[(y * 200 + x) * 4 + 3] > 20) {
                    sy += y; n++; if (y < lo) lo = y; if (y > hi) hi = y;
                }
            }
            return { preset, angle, n, cy: n ? sy / n : null, lo, hi };
        };
        const out = [meas('Fan Brush', 0), meas('Fan Brush', 90),
                     meas('Dry Brush', 0), meas('Oil Flat', 0)];
        ['Fan Brush', 'Dry Brush', 'Oil Flat'].forEach(n => {
            PaintApp.brush.forgetSaved(n);
        });
        b.loadPreset('Round');
        return JSON.stringify(out);
    })()`));
    console.log('  ' + JSON.stringify(fan));
    fan.forEach(f => {
        check(`${f.preset} at ${f.angle}deg paints on the cursor, not beside it`,
            f.n > 0 && Math.abs(f.cy - 100) < 2,
            `ink centre y=${f.cy && f.cy.toFixed(1)} for a stroke along y=100`);
        check(`${f.preset} at ${f.angle}deg spreads evenly either side of the stroke`,
            Math.abs((100 - f.lo) - (f.hi - 100)) <= 3,
            `${100 - f.lo}px above the line, ${f.hi - 100}px below`);
    });

    /* A bristle head has a front. With no sensor on angle it stays pinned
     * pointing east, so dragging downwards drags the fan sideways and a
     * 38px-wide brush paints a 9px line. Every bristle preset must track
     * the stroke. */
    const dir = JSON.parse(await page.eval(`(() => {
        const app = PaintApp, b = app.brush;
        const across = (preset, vert) => {
            __B.doc();
            b.loadPreset(preset);
            const at = (t) => vert ? [100, 40 + t] : [40 + t, 100];
            const s0 = at(0);
            b.beginStroke(s0[0], s0[1], 1, '#000000');
            for (let t = 0; t <= 120; t += 3) {
                const q = at(t);
                b.moveStroke(q[0], q[1], 1, '#000000');
            }
            b.endStroke();
            const d = __B.layer().ctx.getImageData(0, 0, 200, 200).data;
            let x0 = 999, x1 = -1, y0 = 999, y1 = -1;
            for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
                if (d[(y * 200 + x) * 4 + 3] > 20) {
                    if (x < x0) x0 = x; if (x > x1) x1 = x;
                    if (y < y0) y0 = y; if (y > y1) y1 = y;
                }
            }
            return vert ? x1 - x0 : y1 - y0;   // width ACROSS the path
        };
        const out = {};
        ['Fan Brush', 'Dry Brush', 'Oil Round', 'Oil Flat', 'Impasto',
         'Acrylic Dry', 'Bristle Blender'].forEach(n => {
            out[n] = { h: across(n, false), v: across(n, true) };
            PaintApp.brush.forgetSaved(n);
        });
        b.loadPreset('Round');
        return JSON.stringify(out);
    })()`));
    console.log('  ' + JSON.stringify(dir));
    Object.keys(dir).forEach(n => {
        const d = dir[n];
        check(`${n} turns with the stroke`,
            d.h > 0 && Math.abs(d.h - d.v) <= Math.max(3, d.h * 0.15),
            `${d.h}px wide drawn across, ${d.v}px drawn down`);
    });

    /* ================= saved brushes ================= */
    console.log('\n== saved brushes ==');

    const lb = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        const wipe = () => {
            b.userPresetNames().forEach(n => b.deleteUserPreset(n));
            Object.keys(b.PRESETS).forEach(n => {
                if (b.isFavourite(n)) b.toggleFavourite(n);
                PaintApp.brush.forgetSaved(n);
            });
            b.loadPreset('Round');
        };
        const out = {};
        wipe();

        // --- save -------------------------------------------------------
        b.loadPreset('Round');
        b.setParam('size', 37);
        b.setParam('hardness', 12);
        const saved = b.saveUserPreset('  My   Brush  ');
        out.savedOk = saved.ok;
        out.trimmedName = saved.name;                 // whitespace collapsed
        out.isMine = b.isUserPreset('My Brush');
        out.inNames = b.presetNames.indexOf('My Brush') !== -1;

        // The saved brush must not be a live view of the one it came from.
        b.loadPreset('Round');
        b.setParam('size', 3);
        b.loadPreset('My Brush');
        out.keptOwnSize = b.getParams().size;         // 37, not 3

        // --- built-ins are untouchable ----------------------------------
        out.cantShadow = b.saveUserPreset('Round');
        out.cantRename = b.renameUserPreset('Round', 'Nope');
        out.cantDelete = b.deleteUserPreset('Round');
        out.roundStillThere = !!b.PRESETS['Round'] && !b.isUserPreset('Round');

        // --- duplicate --------------------------------------------------
        b.loadPreset('Charcoal Rock');
        const dup = b.duplicatePreset('Charcoal Rock', null);
        out.dupName = dup.name;
        out.dupIsMine = b.isUserPreset(dup.name);
        b.loadPreset(dup.name);
        out.dupSize = b.getParams().size;
        out.rockSize = b.PRESETS['Charcoal Rock'].size;
        b.setParam('size', 99);
        out.builtinUntouched = b.PRESETS['Charcoal Rock'].size === out.rockSize;

        // --- rename -----------------------------------------------------
        const ren = b.renameUserPreset('My Brush', 'Renamed Brush');
        out.renOk = ren.ok;
        out.oldGone = !b.PRESETS['My Brush'];
        out.newHere = b.isUserPreset('Renamed Brush');
        b.loadPreset('Renamed Brush');
        out.renKeptSize = b.getParams().size;         // still 37

        // --- favourites -------------------------------------------------
        b.toggleFavourite('Thin Regular');
        out.favOn = b.isFavourite('Thin Regular');
        b.toggleFavourite('Thin Regular');
        out.favOff = b.isFavourite('Thin Regular');
        b.toggleFavourite('Thin Regular');

        // --- export / import --------------------------------------------
        const blob = await b.exportUserPresets();
        const before = b.userPresetNames().slice().sort();
        const imp = b.importUserPresets(blob);
        out.impOk = imp.ok;
        out.impRenamedAll = imp.renamed.length === before.length;
        out.impNoOverwrite = before.every(n => b.userPresetNames().indexOf(n) !== -1);
        out.impGrew = b.userPresetNames().length === before.length * 2;
        out.badImport = b.importUserPresets('{"format":"something-else"}');
        out.junkImport = b.importUserPresets('not json at all');

        // --- delete -----------------------------------------------------
        const doomed = b.userPresetNames()[0];
        b.deleteUserPreset(doomed);
        out.deleted = !b.PRESETS[doomed];

        out.names = b.userPresetNames().slice().sort();
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify(lb));

    check('a brush can be saved', lb.savedOk === true);
    check('a saved name is tidied, not taken raw',
        lb.trimmedName === 'My Brush', `got "${lb.trimmedName}"`);
    check('a saved brush joins the library', lb.isMine && lb.inNames);
    check('a saved brush is a snapshot, not a live view of its source',
        lb.keptOwnSize === 37, `size came back as ${lb.keptOwnSize}`);
    check('a saved brush cannot shadow a built-in',
        lb.cantShadow.ok === false, lb.cantShadow.error);
    check('a built-in cannot be renamed', lb.cantRename.ok === false);
    check('a built-in cannot be deleted', lb.cantDelete.ok === false);
    check('the built-in survives all three attempts', lb.roundStillThere === true);
    check('duplicate names itself out of the way',
        lb.dupName === 'Charcoal Rock copy', `got "${lb.dupName}"`);
    check('a duplicate copies the brush it came from',
        lb.dupIsMine && lb.dupSize === lb.rockSize,
        `${lb.dupSize} vs ${lb.rockSize}`);
    check('editing a copy never writes back to the built-in',
        lb.builtinUntouched === true);
    check('rename moves the brush', lb.renOk && lb.oldGone && lb.newHere);
    check('rename keeps the settings with it',
        lb.renKeptSize === 37, `size came back as ${lb.renKeptSize}`);
    check('a brush can be favourited and unfavourited',
        lb.favOn === true && lb.favOff === false);
    check('export then import brings the brushes back', lb.impOk === true);
    check('import never overwrites what is already saved',
        lb.impNoOverwrite && lb.impRenamedAll && lb.impGrew,
        JSON.stringify({ renamed: lb.impRenamedAll, kept: lb.impNoOverwrite, grew: lb.impGrew }));
    check('a foreign file is refused', lb.badImport.ok === false, lb.badImport.error);
    check('unreadable text is refused', lb.junkImport.ok === false, lb.junkImport.error);
    check('a brush can be deleted', lb.deleted === true);

    /* A brush name is user text. It reaches the DOM as text and nowhere
     * else, so a name that looks like markup stays a name. */
    const hostile = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        const evil = '<img src=x onerror="window.__pwned=1">';
        window.__pwned = 0;
        b.loadPreset('Round');
        const r = b.saveUserPreset(evil);
        b.buildBrushGrid();
        const grid = document.getElementById('pb-brush-grid');
        const tile = [...grid.querySelectorAll('.pb-brush-tile')]
            .find(t => t.getAttribute('data-preset') === r.name);
        const cap = tile && tile.querySelector('.pb-tile-name');
        const out = {
            saved: r.ok,
            pwned: window.__pwned,
            injected: grid.querySelectorAll('img').length,
            shownAsText: cap ? cap.textContent === r.name : false
        };
        b.deleteUserPreset(r.name);
        return JSON.stringify(out);
    })()`));
    console.log('  ' + JSON.stringify(hostile));
    check('a brush named like markup runs nothing',
        hostile.pwned === 0 && hostile.injected === 0);
    check('a brush named like markup shows as plain text',
        hostile.shownAsText === true);

    /* Search hides tiles instead of rebuilding them: re-rendering means
     * repainting a real stroke per swatch on every keystroke. */
    const srch = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        b.buildBrushGrid();
        const grid = document.getElementById('pb-brush-grid');
        const box = document.getElementById('pb-search');
        const canvases = () => grid.querySelectorAll('canvas').length;
        const visible = () => [...grid.querySelectorAll('.pb-brush-tile')]
            .filter(t => !t.hidden).length;
        const heads = () => [...grid.querySelectorAll('.pb-brush-group')]
            .filter(h => !h.hidden).length;
        const before = { tiles: visible(), canvases: canvases(), heads: heads() };
        const first = grid.querySelector('.pb-brush-tile');
        box.value = 'thin';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        const during = { tiles: visible(), canvases: canvases(), heads: heads(),
                         sameNode: grid.querySelector('.pb-brush-tile') === first };
        box.value = 'zzzznothing';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        const none = { tiles: visible(), heads: heads() };
        box.value = '';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        const after = { tiles: visible(), heads: heads() };
        return JSON.stringify({ before, during, none, after });
    })()`));
    console.log('  ' + JSON.stringify(srch));
    check('search narrows the grid',
        srch.during.tiles > 0 && srch.during.tiles < srch.before.tiles,
        `${srch.during.tiles} of ${srch.before.tiles} shown`);
    check('search does not re-render the swatches',
        srch.during.canvases === srch.before.canvases && srch.during.sameNode,
        `${srch.before.canvases} canvases became ${srch.during.canvases}`);
    check('a family header hides when nothing under it matches',
        srch.during.heads < srch.before.heads && srch.none.heads === 0,
        `${srch.during.heads} headers on a match, ${srch.none.heads} on no match`);
    check('clearing the search restores every brush',
        srch.after.tiles === srch.before.tiles && srch.after.heads === srch.before.heads);

    /* Favourites are a shortcut TO a brush, not a move: it shows in both
     * places, which is the one case where a name owns two tiles. */
    const favg = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        // Earlier blocks leave brushes and stars behind.
        b.userPresetNames().forEach(n => b.deleteUserPreset(n));
        Object.keys(b.PRESETS).forEach(n => { if (b.isFavourite(n)) b.toggleFavourite(n); });
        b.loadPreset('Round');
        b.buildBrushGrid();
        const grid = document.getElementById('pb-brush-grid');
        const headNames = () => [...grid.querySelectorAll('.pb-brush-group')]
            .map(h => h.textContent);
        const countOf = (n) => [...grid.querySelectorAll('.pb-brush-tile')]
            .filter(t => t.getAttribute('data-preset') === n).length;
        const plain = { heads: headNames(), ink: countOf('Thin Regular') };
        if (!b.isFavourite('Thin Regular')) b.toggleFavourite('Thin Regular');
        b.buildBrushGrid();
        const fav = { heads: headNames(), ink: countOf('Thin Regular'),
                      first: headNames()[0] };
        b.loadPreset('Round');
        b.saveUserPreset('Grid Test Brush');
        b.buildBrushGrid();
        const mine = { heads: headNames() };
        b.deleteUserPreset('Grid Test Brush');
        b.toggleFavourite('Thin Regular');
        b.buildBrushGrid();
        return JSON.stringify({ plain, fav, mine });
    })()`));
    console.log('  ' + JSON.stringify(favg));
    check('Favourites leads the grid once something is starred',
        favg.plain.heads.indexOf('Favourites') === -1 &&
        favg.fav.first === 'Favourites');
    check('a favourite still shows under its family too',
        favg.plain.ink === 1 && favg.fav.ink === 2,
        `${favg.fav.ink} tiles for Ink when favourited`);
    check('saved brushes get their own group',
        favg.mine.heads.indexOf('My Brushes') !== -1, favg.mine.heads.join(', '));

    /* Both of a favourite's tiles need their own swatch node. The cache
     * handed the same canvas to each, and appending a node twice moves it,
     * so the first tile went blank. */
    /* Tiles draw themselves when they scroll into view, so this waits for
     * the observer rather than reading straight after the build. */
    const twin = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        const sb = document.getElementById('paintbrush-sidebar');
        if (sb) { sb.style.display = 'block'; sb.classList.remove('collapsed'); }
        if (!b.isFavourite('Charcoal Rock')) b.toggleFavourite('Charcoal Rock');
        b.buildBrushGrid();
        const grid = document.getElementById('pb-brush-grid');
        const mine = [...grid.querySelectorAll('.pb-brush-tile')]
            .filter(t => t.getAttribute('data-preset') === 'Charcoal Rock');
        const settle = () => new Promise(r => setTimeout(r, 120));
        const ink = (t) => {
            const c = t.querySelector('canvas');
            if (!c) return 0;
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let n = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
            return n;
        };
        // what is in view draws lazily: a fixed wait found none drawn on a busy machine
        for (let i = 0; i < 16 && !grid.querySelector('.pb-brush-tile canvas'); i++) await settle();
        await settle();
        const drawnAtRest = [...grid.querySelectorAll('.pb-brush-tile')]
            .filter(t => t.querySelector('canvas')).length;
        const total = grid.querySelectorAll('.pb-brush-tile').length;
        // Scroll each of Charcoal's two tiles into view and let it draw.
        const inked = [];
        for (const t of mine) {
            grid.scrollTop = t.offsetTop - grid.offsetTop - 20;
            // a fixed wait raced the lazy draw; give it up to 2s
            for (let i = 0; i < 16 && !ink(t); i++) await settle();
            inked.push(ink(t));
        }
        // Walk the whole list; nothing may stay blank once it has been seen.
        for (let y = 0; y <= grid.scrollHeight; y += 150) {
            grid.scrollTop = y;
            await settle();
        }
        const blank = [...grid.querySelectorAll('.pb-brush-tile')]
            .filter(t => !t.querySelector('canvas'))
            .map(t => t.getAttribute('data-preset'));
        grid.scrollTop = 0;
        b.toggleFavourite('Charcoal Rock');
        b.buildBrushGrid();
        return JSON.stringify({ tiles: mine.length, inked, blank, drawnAtRest, total });
    })()`));
    console.log('  ' + JSON.stringify(twin));
    check('both tiles of a favourite draw their own swatch',
        twin.tiles === 2 && twin.inked.length === 2 && twin.inked.every(n => n > 50),
        `painted pixels per tile: ${twin.inked.join(', ')}`);
    check('opening the panel only draws the tiles you can see',
        twin.drawnAtRest > 0 && twin.drawnAtRest < twin.total / 2,
        `${twin.drawnAtRest} of ${twin.total} drawn before scrolling`);
    check('every tile draws its swatch once it has been scrolled to',
        twin.blank.length === 0, twin.blank.join(', '));

    /* ================= blend modes and erasers ================= */
    console.log('\n== blend modes ==');

    const bl = JSON.parse(await page.eval(`(() => {
        const app = PaintApp, b = app.brush;
        const lay = (fn) => {
            __B.doc();
            b.loadPreset('Round');
            ['sizeSrc', 'flowSrc'].forEach(k => b.setParam(k, 'none'));
            b.setParam('size', 20);
            b.setParam('spacing', 8);
            return fn();
        };
        const paint = (color, y) => {
            b.beginStroke(30, y, 1, color);
            for (let x = 30; x <= 170; x += 4) b.moveStroke(x, y, 1, color);
            b.endStroke();
        };
        const out = {};

        // --- erase removes what is there --------------------------------
        out.erase = lay(() => {
            b.setParam('blendMode', 'normal');
            paint('#ff0000', 100);
            paint('#ff0000', 60);           // a second band the eraser misses
            const before = __B.px(__B.layer(), 100, 100);
            b.loadPreset('Eraser Hard');
            b.setParam('size', 20);
            paint('#000000', 100);
            const after = __B.px(__B.layer(), 100, 100);
            const untouched = __B.px(__B.layer(), 100, 60);
            return { before, after, untouched };
        });

        // --- erase is a real hole, not white paint ----------------------
        out.notWhite = lay(() => {
            b.setParam('blendMode', 'normal');
            paint('#ff0000', 100);
            b.loadPreset('Eraser Hard');
            b.setParam('size', 20);
            paint('#00ff00', 100);          // colour must be irrelevant
            return __B.px(__B.layer(), 100, 100);
        });

        // --- multiply darkens, normal replaces --------------------------
        const cross = (mode) => lay(() => {
            b.setParam('blendMode', 'normal');
            paint('#ffcc00', 100);
            b.loadPreset('Round');
            ['sizeSrc', 'flowSrc'].forEach(k => b.setParam(k, 'none'));
            b.setParam('size', 20);
            b.setParam('spacing', 8);
            b.setParam('blendMode', mode);
            b.beginStroke(100, 60, 1, '#0066ff');
            for (let y = 60; y <= 140; y += 4) b.moveStroke(100, y, 1, '#0066ff');
            b.endStroke();
            return __B.px(__B.layer(), 100, 100);
        });
        out.normalCross = cross('normal');
        out.multiplyCross = cross('multiply');
        out.screenCross = cross('screen');

        // --- dabs inside ONE multiply stroke must not darken each other --
        out.selfDarken = lay(() => {
            b.setParam('blendMode', 'normal');
            paint('#ffffff', 100);
            b.loadPreset('Round');
            ['sizeSrc', 'flowSrc'].forEach(k => b.setParam(k, 'none'));
            b.setParam('size', 20);
            b.setParam('spacing', 2);       // heavy overlap
            b.setParam('blendMode', 'multiply');
            paint('#808080', 100);
            return __B.px(__B.layer(), 100, 100);
        });

        // --- alpha lock ---------------------------------------------------
        out.lock = lay(() => {
            b.setParam('blendMode', 'normal');
            paint('#ff0000', 100);
            const L = __B.layer();
            L.alphaLock = true;
            b.loadPreset('Eraser Hard');
            b.setParam('size', 20);
            paint('#000000', 100);
            const kept = __B.px(L, 100, 100);
            L.alphaLock = false;
            return kept;
        });

        out.lockedBlend = lay(() => {
            b.setParam('blendMode', 'normal');
            paint('#ffcc00', 100);
            const L = __B.layer();
            L.alphaLock = true;
            b.loadPreset('Round');
            ['sizeSrc', 'flowSrc'].forEach(k => b.setParam(k, 'none'));
            b.setParam('size', 20);
            b.setParam('blendMode', 'multiply');
            paint('#0066ff', 40);           // well clear of the yellow band
            const off = __B.px(L, 100, 40);
            b.setParam('spacing', 8);
            paint('#0066ff', 100);          // straight over it
            const on = __B.px(L, 100, 100);
            L.alphaLock = false;
            return { off, on };
        });

        b.loadPreset('Round');
        ['Round', 'Eraser Hard'].forEach(n => {
            PaintApp.brush.forgetSaved(n);
        });
        return JSON.stringify(out);
    })()`));
    console.log('  ' + JSON.stringify(bl));

    const alphaOf = (px) => Number(px.split(',')[3]);
    check('an eraser brush removes paint', alphaOf(bl.erase.after) === 0,
        `pixel was ${bl.erase.before}, is ${bl.erase.after}`);
    check('an eraser only takes what it passes over',
        alphaOf(bl.erase.untouched) > 200, bl.erase.untouched);
    check('erasing leaves a hole, not paint the colour of the brush',
        bl.notWhite === CLEAR, `left ${bl.notWhite}`);
    check('multiply darkens what is under it',
        alphaOf(bl.multiplyCross) > 200 &&
        Number(bl.multiplyCross.split(',')[0]) < Number(bl.normalCross.split(',')[0]) + 1 &&
        bl.multiplyCross !== bl.normalCross,
        `normal ${bl.normalCross} vs multiply ${bl.multiplyCross}`);
    check('screen lightens what is under it',
        bl.screenCross !== bl.normalCross &&
        Number(bl.screenCross.split(',')[1]) >= Number(bl.multiplyCross.split(',')[1]),
        `screen ${bl.screenCross} vs multiply ${bl.multiplyCross}`);
    /* This is the whole reason the blend runs on the finished stroke rather
     * than per dab: at spacing 2 a 50% grey would go almost black if each
     * dab multiplied the one before it. */
    check('overlapping dabs in one multiply stroke do not darken each other',
        Math.abs(Number(bl.selfDarken.split(',')[0]) - 128) <= 6,
        `50% grey over white came out ${bl.selfDarken}`);
    check('alpha lock stops an eraser punching holes',
        alphaOf(bl.lock) > 200, `pixel became ${bl.lock}`);
    check('alpha lock confines a blend-mode brush to existing pixels',
        bl.lockedBlend.off === CLEAR, `paint landed off-shape: ${bl.lockedBlend.off}`);
    check('...and the blend still runs where paint is allowed',
        alphaOf(bl.lockedBlend.on) > 200 && bl.lockedBlend.on !== '255,204,0,255',
        `yellow band came out ${bl.lockedBlend.on}`);

    /* An erase stroke on an empty tile paints nothing, so the swatch has to
     * give it something to bite out of. */
    const esw = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        const ink = (name) => {
            const c = b.generatePreview(name);
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let n = 0, clear = 0;
            for (let i = 3; i < d.length; i += 4) { if (d[i] > 8) n++; else clear++; }
            return { painted: n, clear };
        };
        return JSON.stringify({ hard: ink('Eraser Hard'), soft: ink('Eraser Kneaded'),
                                round: ink('Round') });
    })()`));
    console.log('  ' + JSON.stringify(esw));
    check('an eraser swatch shows the bite it takes',
        esw.hard.painted > 1000 && esw.hard.clear > 1000,
        `${esw.hard.painted} painted / ${esw.hard.clear} clear`);
    check('a normal brush swatch is unaffected by that',
        esw.round.painted > 500 && esw.round.clear > esw.round.painted,
        JSON.stringify(esw.round));

    const bfam = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        b.buildBrushGrid();
        const heads = [...document.querySelectorAll('.pb-brush-group')].map(h => h.textContent);
        const modes = b.BLEND_MODES;
        const unfiled = Object.keys(b.PRESETS).filter(n => {
            for (const g of b.PRESET_CATEGORIES) if (g.presets.indexOf(n) !== -1) return false;
            return !b.isUserPreset(n);
        });
        const badMode = Object.keys(b.PRESETS).filter(n =>
            b.PRESETS[n].blendMode && modes.indexOf(b.PRESETS[n].blendMode) === -1);
        return JSON.stringify({ heads, count: Object.keys(b.PRESETS).length,
                                modes: modes.length, unfiled, badMode });
    })()`));
    console.log('  ' + JSON.stringify(bfam));
    check('erasers and textured brushes have their own families',
        bfam.heads.indexOf('Erasers') !== -1 && bfam.heads.indexOf('Texture') !== -1,
        bfam.heads.join(', '));
    check('every preset is still filed', bfam.unfiled.length === 0, bfam.unfiled.join(', '));
    check('no preset asks for a blend mode the engine does not have',
        bfam.badMode.length === 0, bfam.badMode.join(', '));

    /* Save writes to whatever the name field says, so a stale field would
     * quietly overwrite the wrong brush. */
    const nf = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        b.loadPreset('Round');
        b.syncPanel();
        const first = document.getElementById('pb-preset-name').value;
        b.loadPreset('Eraser Hard');
        b.syncPanel();
        const second = document.getElementById('pb-preset-name').value;
        const renameOff = document.getElementById('pb-rename-btn').disabled;
        b.loadPreset('Round');
        b.saveUserPreset('Field Test');
        b.syncPanel();
        const mine = document.getElementById('pb-preset-name').value;
        const renameOn = document.getElementById('pb-rename-btn').disabled;
        b.deleteUserPreset('Field Test');
        b.loadPreset('Round');
        return JSON.stringify({ first, second, mine, renameOff, renameOn });
    })()`));
    console.log('  ' + JSON.stringify(nf));
    check('the name field follows whichever brush is active',
        nf.first === 'Round' && nf.second === 'Eraser Hard' && nf.mine === 'Field Test',
        JSON.stringify(nf));
    check('rename is off for a built-in and on for your own',
        nf.renameOff === true && nf.renameOn === false);

    /* ================= wet smudge ================= */
    console.log('\n== wet smudge ==');

    /* The test surface: a red half and a blue half, side by side. Drag a
     * smudge brush from red into blue and red pigment must show up inside
     * the blue — that is what "carries" means, and the old smudge could not
     * do it at all. */
    const wet = JSON.parse(await page.eval(`(() => {
        const app = PaintApp, b = app.brush;
        const halves = () => {
            __B.doc();
            const L = __B.layer();
            L.ctx.fillStyle = '#ff0000'; L.ctx.fillRect(0, 0, 100, 200);
            L.ctx.fillStyle = '#0000ff'; L.ctx.fillRect(100, 0, 100, 200);
            return L;
        };
        const drag = (carry, rate) => {
            const L = halves();
            b.loadPreset('Round');
            ['sizeSrc', 'flowSrc'].forEach(k => b.setParam(k, 'none'));
            b.setParam('size', 16);
            b.setParam('spacing', 4);
            b.setParam('hardness', 90);
            b.setParam('colorRate', rate);
            b.setParam('smudgeLength', carry);
            b.beginStroke(60, 100, 1, '#00ff00');   // green must not appear
            for (let x = 60; x <= 175; x += 3) b.moveStroke(x, 100, 1, '#00ff00');
            b.endStroke();
            const at = (x) => __B.px(L, x, 100).split(',').map(Number);
            return { in10: at(110), in25: at(125), in50: at(150), in70: at(170) };
        };
        const out = { carried: drag(85, 0), fresh: drag(0, 0), painted: drag(85, 100) };

        /* Spacing is a texture setting. It must not quietly decide how far
         * pigment travels, which it did while the load decayed per dab. */
        const spaced = (sp) => {
            const L = halves();
            b.loadPreset('Round');
            ['sizeSrc', 'flowSrc'].forEach(k => b.setParam(k, 'none'));
            b.setParam('size', 16); b.setParam('hardness', 90);
            b.setParam('colorRate', 0); b.setParam('smudgeLength', 85);
            b.setParam('spacing', sp);
            b.beginStroke(60, 100, 1, '#00ff00');
            for (let x = 60; x <= 175; x += 3) b.moveStroke(x, 100, 1, '#00ff00');
            b.endStroke();
            return __B.px(L, 140, 100).split(',').map(Number)[0];
        };
        out.tight = spaced(3);
        out.loose = spaced(25);

        // Smudging over empty canvas must not smear black out of nothing.
        __B.doc();
        b.loadPreset('Round');
        ['sizeSrc', 'flowSrc'].forEach(k => b.setParam(k, 'none'));
        b.setParam('size', 16);
        b.setParam('colorRate', 0);
        b.setParam('smudgeLength', 85);
        b.beginStroke(30, 40, 1, '#00ff00');
        for (let x = 30; x <= 170; x += 3) b.moveStroke(x, 40, 1, '#00ff00');
        b.endStroke();
        out.overNothing = __B.px(__B.layer(), 100, 40);

        b.loadPreset('Round');
        PaintApp.brush.forgetSaved('Round');
        return JSON.stringify(out);
    })()`));
    console.log('  ' + JSON.stringify(wet));

    const red = (p) => p[0], blue = (p) => p[2], green = (p) => p[1];
    check('pigment is carried across into the new colour',
        red(wet.carried.in10) > 120,
        `10px into the blue the red is only ${red(wet.carried.in10)}`);
    check('the carried pigment fades along the stroke',
        red(wet.carried.in10) > red(wet.carried.in50) &&
        red(wet.carried.in50) > red(wet.carried.in70),
        `red ran ${wet.carried.in10[0]} -> ${wet.carried.in50[0]} -> ${wet.carried.in70[0]}`);
    check('it eventually lets go and becomes the new colour',
        blue(wet.carried.in70) > 150 &&
        red(wet.carried.in70) < red(wet.carried.in10) * 0.4,
        `70px in it is still ${wet.carried.in70.join(',')}`);
    check('carry 0 is the old behaviour: nothing travels',
        red(wet.fresh.in10) < 30,
        `red ${red(wet.fresh.in10)} where nothing should have been carried`);
    check('a smudge brush paints no colour of its own',
        green(wet.carried.in25) < 40,
        `the brush colour bled through: ${wet.carried.in25.join(',')}`);
    check('mix at 100 goes back to plain painting',
        green(wet.painted.in25) > 200 && red(wet.painted.in25) < 40,
        wet.painted.in25.join(','));
    check('smudging over empty canvas smears nothing',
        wet.overNothing === CLEAR, `left ${wet.overNothing}`);
    check('spacing does not change how far pigment carries',
        Math.abs(wet.tight - wet.loose) <= 30,
        `red ${wet.tight} at spacing 3 vs ${wet.loose} at spacing 25`);

    const wp = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        b.buildBrushGrid();
        const heads = [...document.querySelectorAll('.pb-brush-group')].map(h => h.textContent);
        const unfiled = Object.keys(b.PRESETS).filter(n => {
            for (const g of b.PRESET_CATEGORIES) if (g.presets.indexOf(n) !== -1) return false;
            return !b.isUserPreset(n);
        });
        const slider = document.getElementById('pb-smudgeLength');
        b.loadPreset('Smudge');
        b.syncPanel();
        const shown = slider ? slider.value : null;
        b.loadPreset('Round');
        b.syncPanel();
        return JSON.stringify({ heads, unfiled, shown,
            count: Object.keys(b.PRESETS).length });
    })()`));
    console.log('  ' + JSON.stringify(wp));
    check('smudge brushes have their own family',
        wp.heads.indexOf('Smudge') !== -1, wp.heads.join(', '));
    check('every preset is still filed', wp.unfiled.length === 0, wp.unfiled.join(', '));
    check('the carry slider follows the loaded brush',
        Number(wp.shown) === 82, `slider read ${wp.shown}`);

    const fs2 = JSON.parse(await page.eval(`(() => {
        const box = document.getElementById('pb-search');
        const shown = () => [...document.querySelectorAll('.pb-brush-tile')]
            .filter(t => !t.hidden).map(t => t.getAttribute('data-preset'));
        const run = (q) => { box.value = q;
            box.dispatchEvent(new Event('input', { bubbles: true })); return shown(); };
        const byFamily = run('smudge');
        const byName = run('blender');
        run('');
        return JSON.stringify({ byFamily, byName });
    })()`));
    console.log('  ' + JSON.stringify(fs2));
    check('searching a family name finds the whole family',
        fs2.byFamily.indexOf('Wet Modeling') !== -1 &&
        fs2.byFamily.indexOf('Smudge') !== -1,
        fs2.byFamily.join(', '));
    check('searching a brush name still works',
        fs2.byName.indexOf('Bristle Blender') !== -1,
        fs2.byName.join(', '));

    /* ── dual tip ─────────────────────────────────────────────────────── */
    console.log('== the surface under the paint ==');
    const dt = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        const out = {};
        const setup = () => {
            const L = __B.doc();
            b.loadPreset('Round');
            b.setParam('dynamicsMode', 'off'); b.setParam('scatter', 0);
            b.setParam('size', 20); b.setParam('hardness', 100);
            b.setParam('opacity', 100); b.setParam('flow', 100);
            b.setParam('spacing', 3);
            b.setParam('dualTip', 'none');
            b.setParam('dualScale', 3); b.setParam('dualDepth', 80);
            return L;
        };
        // Alpha straight down the middle of the band, one sample per pixel.
        const row = (L) => {
            const d = L.ctx.getImageData(30, 100, 140, 1).data;
            const a = []; for (let i = 3; i < d.length; i += 4) a.push(d[i]);
            return a;
        };
        const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
        const sd = (a) => { const m = mean(a);
            return Math.sqrt(mean(a.map(v => (v - m) * (v - m)))); };
        const maxDiff = (a, c) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - c[i])), 0);

        let L = setup();
        await __B.stroke(20, 100, 180, 100);
        const plain = row(L);

        L = setup(); b.setParam('dualTip', 'canvas');
        await __B.stroke(20, 100, 180, 100);
        const grained = row(L);

        out.plainMean = Math.round(mean(plain));
        out.grainMean = Math.round(mean(grained));
        out.plainSd = Math.round(sd(plain));
        out.grainSd = Math.round(sd(grained));

        // Same band, walked the other way.
        L = setup(); b.setParam('dualTip', 'canvas');
        await __B.stroke(180, 100, 20, 100);
        out.dirDiff = maxDiff(grained, row(L));

        // Same band, far fewer dabs.
        L = setup(); b.setParam('dualTip', 'canvas'); b.setParam('spacing', 25);
        await __B.stroke(20, 100, 180, 100);
        out.spacingDiff = maxDiff(grained, row(L));

        /* Out and back over the same band, so the second half covers ground
         * the first half already grained — and split across two flushes, so
         * the grain gets a second chance to apply itself to paint that has
         * already had it. Both runs must land on the same pixels. */
        const outAndBack = async (pause) => {
            const L2 = setup(); b.setParam('dualTip', 'canvas');
            b.beginStroke(20, 100, 0.9, '#ff0000');
            for (let i = 1; i <= 16; i++) b.moveStroke(20 + i * 10, 100, 0.9, '#ff0000');
            if (pause) await new Promise(r => setTimeout(r, 140));
            for (let i = 15; i >= 0; i--) b.moveStroke(20 + i * 10, 100, 0.9, '#ff0000');
            b.endStroke();
            await new Promise(r => setTimeout(r, 180));
            return row(L2);
        };
        out.chunkDiff = maxDiff(await outAndBack(false), await outAndBack(true));

        // No bite asked for, nothing taken.
        L = setup(); b.setParam('dualTip', 'canvas'); b.setParam('dualDepth', 0);
        await __B.stroke(20, 100, 180, 100);
        out.offDiff = maxDiff(plain, row(L));

        // A coarser surface leaves bigger lumps than a fine one.
        L = setup(); b.setParam('dualTip', 'canvas'); b.setParam('dualScale', 1);
        await __B.stroke(20, 100, 180, 100);
        const fine = row(L);
        L = setup(); b.setParam('dualTip', 'canvas'); b.setParam('dualScale', 8);
        await __B.stroke(20, 100, 180, 100);
        const coarse = row(L);
        // Mean absolute step between neighbours: fine grain jumps every pixel,
        // coarse grain holds its value for a run of them.
        const churn = (a) => { let s = 0;
            for (let i = 1; i < a.length; i++) s += Math.abs(a[i] - a[i - 1]);
            return s / (a.length - 1); };
        out.fineChurn = Math.round(churn(fine));
        out.coarseChurn = Math.round(churn(coarse));

        b.setParam('dualTip', 'none'); b.setParam('dualDepth', 70);
        b.setParam('dualScale', 3);
        b.loadPreset('Round');
        return JSON.stringify(out);
    })()`));
    console.log('  ' + JSON.stringify(dt));

    check('a plain hard stroke lays down flat, solid paint',
        dt.plainMean > 250 && dt.plainSd < 3,
        `mean ${dt.plainMean} sd ${dt.plainSd}`);
    check('the surface bites paint out of the stroke',
        dt.grainMean < dt.plainMean - 15,
        `${dt.grainMean} vs ${dt.plainMean} ungrained`);
    check('what it leaves is mottled, not evenly thinner',
        dt.grainSd > 15, `sd only ${dt.grainSd}`);
    check('the grain does not care which way the stroke was drawn',
        dt.dirDiff === 0, `${dt.dirDiff} levels apart at the worst pixel`);
    check('the grain does not care how many dabs crossed it',
        dt.spacingDiff === 0, `${dt.spacingDiff} levels apart at spacing 25`);
    check('a stroke flushed in two pieces is grained once, not twice',
        dt.chunkDiff === 0, `${dt.chunkDiff} levels apart at the worst pixel`);
    check('bite 0 leaves the stroke exactly as it was',
        dt.offDiff === 0, `${dt.offDiff} levels of difference`);
    check('grain size makes the lumps bigger',
        dt.coarseChurn < dt.fineChurn * 0.6,
        `churn ${dt.fineChurn} at size 1 vs ${dt.coarseChurn} at size 8`);

    const dsw = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        const fam = b.PRESET_CATEGORIES.filter(g => g.name === 'Texture')[0];
        const blank = [];
        (fam ? fam.presets : []).forEach(n => {
            const c = b.generatePreview(n);
            if (!c) { blank.push(n + ':none'); return; }
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let ink = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 24) ink++;
            if (ink < 200) blank.push(n + ':' + ink);
        });
        b.buildBrushGrid();
        const heads = [...document.querySelectorAll('.pb-brush-group')]
            .map(h => h.textContent);
        return JSON.stringify({ blank, heads, fam: fam ? fam.presets.length : 0,
            count: Object.keys(b.PRESETS).length });
    })()`));
    console.log('  ' + JSON.stringify(dsw));
    check('every textured brush paints a visible swatch',
        dsw.blank.length === 0, dsw.blank.join(', '));
    check('textured brushes have their own family',
        dsw.heads.indexOf('Texture') !== -1, dsw.heads.join(', '));
    check('the library is the size it says it is',
        dsw.count === 48, 'count ' + dsw.count);

    /* ── taper ────────────────────────────────────────────────────────── */
    console.log('== taper ==');
    const tp = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, app = PaintApp;
        /* A wide, short canvas and one horizontal line, measured column by
         * column: how wide the ink is, and how dark. A width taper shows up
         * in the first, an opacity taper in the second. */
        const run = async (o) => {
            app.layerMgr.collapseToBase({ fresh: true });
            app.setSize(400, 120); app.config.zoom = 1; app.updateBounds();
            document.getElementById('lsys-add').click();
            app.state.selection = null;
            b.loadPreset('Round');
            b.setParam('dynamicsMode', 'off'); b.setParam('scatter', 0);
            b.setParam('size', o.size == null ? 16 : o.size);
            b.setParam('hardness', 100);
            b.setParam('opacity', 100); b.setParam('flow', 100);
            b.setParam('spacing', o.spacing == null ? 6 : o.spacing);
            b.setParam('taperStart', o.ts == null ? 30 : o.ts);
            b.setParam('taperEnd', o.te == null ? 30 : o.te);
            b.setParam('taperTarget', o.target || 'size');
            b.setParam('taperUnit', o.unit || 'brush');
            const L = app.layerMgr.layers[app.layerMgr.activeIdx];
            const x0 = o.x0 == null ? 40 : o.x0, x1 = o.x1 == null ? 360 : o.x1;
            b.beginStroke(x0, 60, 1.0, '#ff0000');
            for (let i = 1; i <= 60; i++) {
                b.moveStroke(x0 + (x1 - x0) * i / 60, 60, 1.0, '#ff0000');
                // A real stroke is drawn while the hand moves: the live
                // passes land on the layer before the final one runs.
                if (o.live) await new Promise(r => requestAnimationFrame(r));
            }
            b.endStroke();
            await new Promise(r => setTimeout(r, 200));
            const d = L.ctx.getImageData(0, 0, 400, 120).data;
            const w = [], a = [];
            for (let x = 0; x < 400; x++) {
                let lo = -1, hi = -1, peak = 0;
                for (let y = 0; y < 120; y++) {
                    const v = d[(y * 400 + x) * 4 + 3];
                    if (v > peak) peak = v;
                    if (v > 10) { if (lo < 0) lo = y; hi = y; }
                }
                w.push(lo < 0 ? 0 : hi - lo + 1); a.push(peak);
            }
            const first = w.findIndex(v => v > 0);
            let last = -1; for (let i = w.length - 1; i >= 0; i--) if (w[i] > 0) { last = i; break; }
            if (first < 0) return { empty: true };
            const maxW = Math.max.apply(null, w);
            const upto = (arr, lim) => {
                const u = arr.findIndex(v => v >= lim);
                let dn = -1; for (let i = arr.length - 1; i >= 0; i--) if (arr[i] >= lim) { dn = i; break; }
                return [u - first, last - dn];
            };
            return { first, last, maxW,
                     tipW: [w[first], w[last]], tipA: [a[first], a[last]],
                     midW: w[(first + last) >> 1], midA: a[(first + last) >> 1],
                     wRamp: upto(w, maxW * 0.9), aRamp: upto(a, 250) };
        };

        const out = {};
        out.off      = await run({ ts: 0, te: 0 });
        out.size     = await run({ target: 'size' });
        out.sizeLoose= await run({ target: 'size', spacing: 40 });
        out.ink      = await run({ target: 'opacity' });
        out.inkLoose = await run({ target: 'opacity', spacing: 40 });
        out.both     = await run({ target: 'both' });
        out.short    = await run({ target: 'size', x0: 180, x1: 220 });
        /* Brush size is what separates the two modes: measured against the
         * brush, halving the size halves the taper; measured against the
         * stroke, the same line tapers over the same distance whatever tip
         * is drawing it. Stroke length alone cannot tell them apart, because
         * the short-stroke fit above shrinks the brush-relative one too. */
        out.brushBig = await run({ target: 'size', size: 16 });
        out.brushSml = await run({ target: 'size', size: 8 });
        out.pctBig   = await run({ target: 'size', unit: 'stroke', size: 16 });
        out.pctSml   = await run({ target: 'size', unit: 'stroke', size: 8 });
        /* Drawn for real, frame by frame, against the same stroke rendered
         * in one go. A long end taper is the case that separates them. */
        out.endFast = await run({ target: 'size', ts: 0, te: 60, size: 20 });
        out.endLive = await run({ target: 'size', ts: 0, te: 60, size: 20, live: true });
        b.loadPreset('Round');
        return JSON.stringify(out);
    })()`));
    console.log('  ' + JSON.stringify(tp));

    /* A round brush ends in a half-circle, so even an untapered line climbs
     * to full width over its own radius. That cap is the baseline a taper
     * has to beat: blunt is an 8px-wide first column, tapered is 1px. */
    check('taper off leaves a blunt end, just the round tip itself',
        tp.off.tipW[0] >= 7 && tp.off.wRamp[0] <= 5 && tp.off.maxW === 16,
        `first column ${tp.off.tipW[0]}px, ramp ${tp.off.wRamp}`);
    /* Measured against the opacity taper rather than an absolute level: the
     * two differ in kind, and how dark a one-pixel antialiased tip lands is
     * a subpixel accident that says nothing about which taper ran. */
    check('a taper narrows the line to a point, not a see-through stub',
        tp.size.tipW[0] <= 3 && tp.size.tipW[1] <= 3 &&
        tp.size.tipA[0] > tp.ink.tipA[0] * 3 && tp.size.tipA[1] > tp.ink.tipA[1] * 3,
        `tips ${tp.size.tipW} wide at alpha ${tp.size.tipA}, ` +
        `against ${tp.ink.tipA} for an opacity taper`);
    check('...and it is still full width and full ink in the middle',
        tp.size.midW === 16 && tp.size.midA === 255,
        `${tp.size.midW}px at ${tp.size.midA}`);
    check('both ends taper by the same amount',
        Math.abs(tp.size.wRamp[0] - tp.size.wRamp[1]) <= 2,
        `${tp.size.wRamp[0]} in vs ${tp.size.wRamp[1]} out`);
    check('spacing does not change how long a width taper runs',
        Math.abs(tp.size.wRamp[0] - tp.sizeLoose.wRamp[0]) <= 8,
        `${tp.size.wRamp[0]} at spacing 6 vs ${tp.sizeLoose.wRamp[0]} at spacing 40`);
    check('an opacity taper fades the ink and leaves the width alone',
        tp.ink.maxW === 16 && tp.ink.tipA[0] < 120 && tp.ink.aRamp[0] > 60,
        `width ${tp.ink.maxW}, tip alpha ${tp.ink.tipA}, ramp ${tp.ink.aRamp}`);
    check('spacing does not change how long an opacity taper runs',
        Math.abs(tp.ink.aRamp[0] - tp.inkLoose.aRamp[0]) <= 15,
        `${tp.ink.aRamp[0]} at spacing 6 vs ${tp.inkLoose.aRamp[0]} at spacing 40`);
    check('both does both',
        tp.both.tipW[0] <= 3 && tp.both.aRamp[0] > 40,
        `tip ${tp.both.tipW[0]}px, ink ramp ${tp.both.aRamp}`);
    check('a stroke too short for its taper still tapers both ends',
        tp.short.tipW[0] <= 4 && tp.short.tipW[1] <= 4 && tp.short.maxW >= 10,
        `tips ${tp.short.tipW}, widest ${tp.short.maxW}`);
    /* The last pass repaints the stroke, and an end taper makes it stop
     * short of the blunt one already on the layer. Restore only the final
     * pass's own rect and the blunt end stays welded on. */
    check('a stroke drawn frame by frame ends where a re-rendered one does',
        Math.abs(tp.endLive.last - tp.endFast.last) <= 2 && tp.endLive.tipW[1] <= 3,
        `live ended at ${tp.endLive.last} (tip ${tp.endLive.tipW[1]}px), ` +
        `re-rendered at ${tp.endFast.last} (tip ${tp.endFast.tipW[1]}px)`);
    check('measured by brush size, a smaller tip tapers over a shorter run',
        tp.brushSml.wRamp[0] < tp.brushBig.wRamp[0] * 0.7,
        `${tp.brushBig.wRamp[0]} at size 16 vs ${tp.brushSml.wRamp[0]} at size 8`);
    check('measured by stroke length, the tip size stops mattering',
        Math.abs(tp.pctBig.wRamp[0] - tp.pctSml.wRamp[0]) <= 8,
        `${tp.pctBig.wRamp[0]} at size 16 vs ${tp.pctSml.wRamp[0]} at size 8`);

    /* ── tip shape ────────────────────────────────────────────────────── */
    console.log('== tip shape ==');
    const ts = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, app = PaintApp;
        /* One dab, measured. Aspect is width-to-height: the tip's long axis
         * is the size you asked for and the short one is what gets squashed.
         * It used to multiply the HEIGHT, so a flat brush came out four
         * times too big and standing on end. */
        const dab = async (o) => {
            app.layerMgr.collapseToBase({ fresh: true });
            app.setSize(300, 300); app.config.zoom = 1; app.updateBounds();
            document.getElementById('lsys-add').click();
            app.state.selection = null;
            b.loadPreset(o.preset || 'Round');
            b.setParam('dynamicsMode', 'off'); b.setParam('scatter', 0);
            if (o.shape) b.setParam('shape', o.shape);
            b.setParam('size', o.size); b.setParam('hardness', 100);
            b.setParam('angle', o.angle || 0);
            b.setParam('aspectRatio', o.aspect);
            const L = app.layerMgr.layers[app.layerMgr.activeIdx];
            b.beginStroke(150, 150, 1, '#ff0000');
            b.endStroke();
            await new Promise(r => setTimeout(r, 150));
            const d = L.ctx.getImageData(0, 0, 300, 300).data;
            let x1 = 1e9, x2 = -1, y1 = 1e9, y2 = -1;
            for (let y = 0; y < 300; y++) for (let x = 0; x < 300; x++) {
                if (d[(y * 300 + x) * 4 + 3] > 20) {
                    if (x < x1) x1 = x; if (x > x2) x2 = x;
                    if (y < y1) y1 = y; if (y > y2) y2 = y;
                }
            }
            return x2 < 0 ? { w: 0, h: 0 } : { w: x2 - x1 + 1, h: y2 - y1 + 1 };
        };
        const out = {};
        out.round   = await dab({ size: 40, aspect: 1 });
        out.flat    = await dab({ size: 40, aspect: 4 });
        out.tall    = await dab({ size: 40, aspect: 0.25 });
        out.turned  = await dab({ size: 40, aspect: 4, angle: 90 });
        out.square  = await dab({ size: 40, aspect: 4, shape: 'square' });
        b.loadPreset('Round');
        return JSON.stringify(out);
    })()`));
    console.log('  ' + JSON.stringify(ts));

    check('a squashed tip keeps the size you asked for as its long side',
        ts.flat.w === 40 && ts.flat.h <= 12,
        `aspect 4 on a 40px brush drew ${ts.flat.w}x${ts.flat.h}, wanted 40x10`);
    check('...and never comes out bigger than an unsquashed one',
        ts.flat.w <= ts.round.w && ts.flat.h <= ts.round.h,
        `${ts.flat.w}x${ts.flat.h} against a round ${ts.round.w}x${ts.round.h}`);
    check('under one squashes the other way instead',
        ts.tall.h === 40 && ts.tall.w <= 12,
        `aspect 0.25 drew ${ts.tall.w}x${ts.tall.h}, wanted 10x40`);
    check('the angle turns the flat tip on its side',
        ts.turned.h === 40 && ts.turned.w <= 12,
        `${ts.turned.w}x${ts.turned.h}`);
    check('a square tip squashes the same way a round one does',
        ts.square.w === 40 && ts.square.h <= 12,
        `${ts.square.w}x${ts.square.h}`);

    /* ── the stroke-position sensors, and the dials they can now drive ── */
    console.log('\n== fade, distance, and dynamics on four more dials ==');
    const b3 = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        /* How thick the line is at one x, in pixels of ink. Fade and
         * distance are the only two sensors that are not the pen, so the
         * only way to see them is to look at two places along ONE stroke. */
        const thick = (L, x) => {
            const d = L.ctx.getImageData(x, 0, 1, 200).data;
            let n = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++;
            return n;
        };
        const ink = (L) => {
            const d = L.ctx.getImageData(0, 0, 400, 200).data;
            let n = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++;
            return n;
        };
        const line = async (set) => {
            __B.doc(400, 200);
            /* Settings are saved per preset, so an earlier test's Round is
             * still Round when this one loads it. Put every dial this block
             * touches back to its default first. */
            ['colorRate', 'texture', 'opacity', 'flow', 'aspectRatio', 'shape',
             'tipCells', 'bristleCount', 'sizeSrc', 'sizeMin', 'sizeCurve',
             'aspectRatioSrc', 'aspectRatioMin', 'spacingSrc', 'spacingMin',
             'fadeSteps', 'distanceLength', 'smoothingMode', 'taperStart',
             'taperEnd', 'flowSrc', 'flowMin', 'angleSrc'].forEach(k => b.setParam(k, b.DEFAULTS[k]));
            b.setParam('dynamicsMode', 'off'); b.setParam('scatter', 0);
            b.setParam('size', 30); b.setParam('hardness', 100);
            b.setParam('spacing', 10);
            b.setParam('sizeSrc', 'none');
            set(b);
            const L = __B.layer();
            await __B.stroke(20, 100, 380, 100, '#ff0000');
            return L;
        };
        const out = {};
        // Fade runs a dial DOWN over a count of dabs, Photoshop's way.
        let L = await line(b => { b.setParam('sizeSrc', 'fade'); b.setParam('sizeMin', 10);
                                  b.setParam('fadeSteps', 30); });
        out.fade = [thick(L, 40), thick(L, 360)];
        // Distance runs it UP over a count of pixels, Krita's way.
        L = await line(b => { b.setParam('sizeSrc', 'distance'); b.setParam('sizeMin', 10);
                              b.setParam('distanceLength', 300); });
        out.dist = [thick(L, 40), thick(L, 360)];
        // Krita's bank line counts its distance from the canvas origin
        b.distanceFrom = 150;
        L = await line(b => { b.setParam('sizeSrc', 'distance'); b.setParam('sizeMin', 10);
                              b.setParam('distanceLength', 300); });
        b.distanceFrom = 0;
        out.distFrom = thick(L, 40);
        // a turn read off distance keeps its own reach, not the size's (X3CD Doodle)
        const turn = (reach) => line(b => { b.setParam('aspectRatio', 3); b.setParam('angleSrc', 'distance');
            b.setParam('distanceLength', 1000); b.setParam('angleReach', reach); });
        L = await turn({ length: 120, periodic: false });
        out.reach = thick(L, 60);
        L = await turn(null);
        out.noReach = thick(L, 60);
        b.setParam('angleReach', null);
        // Roundness dynamics squash the tip; ours is the reciprocal, so a
        // driven aspect has to get FLATTER as the sensor falls, not rounder.
        L = await line(b => { b.setParam('aspectRatio', 1); b.setParam('aspectRatioSrc', 'fade');
                              b.setParam('aspectRatioMin', 20); b.setParam('fadeSteps', 30); });
        out.round = [thick(L, 40), thick(L, 360)];
        // Spacing dynamics change how many dabs a line is made of, so a
        // tighter spacing at the end lays down more ink than a flat one.
        L = await line(b => { b.setParam('spacing', 60); });
        out.flatInk = ink(L);
        L = await line(b => { b.setParam('spacing', 60); b.setParam('spacingSrc', 'fade');
                              b.setParam('spacingMin', 10); b.setParam('fadeSteps', 20); });
        out.tightInk = ink(L);
        b.loadPreset('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify(b3));
    check('a fading dial starts full and ends at its floor',
        b3.fade[0] > b3.fade[1] * 2, b3.fade.join(' -> '));
    check('a distance-driven dial does the opposite',
        b3.dist[1] > b3.dist[0] * 2, b3.dist.join(' -> '));
    check('a distance counted from the canvas origin starts that far along (Krita bank)',
        b3.distFrom > b3.dist[0] * 1.5, b3.dist[0] + ' -> ' + b3.distFrom);
    check('a turn read off distance keeps its own reach (X3CD Doodle)',
        b3.reach > b3.noReach * 1.5, b3.noReach + ' -> ' + b3.reach);
    check('driven roundness flattens the tip rather than rounding it',
        b3.round[1] < b3.round[0], b3.round.join(' -> '));
    check('spacing can follow a sensor too',
        b3.tightInk > b3.flatInk, `${b3.flatInk} then ${b3.tightInk}`);

    /* ── several dabs a stop, and dabs off the line ───────────────────── */
    console.log('\n== dab count, dab offset, and which way "across" points ==');
    const b4 = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        const box = (L) => {
            const d = L.ctx.getImageData(0, 0, 400, 400).data;
            let x1 = 1e9, x2 = -1, y1 = 1e9, y2 = -1, n = 0;
            for (let i = 3; i < d.length; i += 4) {
                if (d[i] <= 20) continue;
                const px = (i / 4) % 400, py = (i / 4 / 400) | 0;
                n++;
                if (px < x1) x1 = px; if (px > x2) x2 = px;
                if (py < y1) y1 = py; if (py > y2) y2 = py;
            }
            return n ? { n: n, w: x2 - x1 + 1, h: y2 - y1 + 1, cy: (y1 + y2) >> 1 } : { n: 0 };
        };
        let lastL = null;
        const line = async (set, vertical) => {
            __B.doc(400, 400);
            ['colorRate', 'texture', 'opacity', 'flow', 'aspectRatio', 'shape',
             'tipCells', 'bristleCount', 'sizeSrc', 'sizeMin', 'scatter',
             'scatterAxis', 'dabCount', 'offsetAlong', 'offsetAcross', 'offsetSrc',
             'smoothingMode', 'taperStart', 'taperEnd', 'flowSrc', 'angleSrc', 'ribbonClip']
                .forEach(k => b.setParam(k, b.DEFAULTS[k]));
            b.setParam('dynamicsMode', 'off');
            b.setParam('size', 20); b.setParam('hardness', 100);
            b.setParam('spacing', 40); b.setParam('sizeSrc', 'none');
            b._setStrokeSeed(4242);
            set(b);
            const L = lastL = __B.layer();
            if (vertical) await __B.stroke(200, 40, 200, 360, '#ff0000');
            else await __B.stroke(40, 200, 360, 200, '#ff0000');
            return box(L);
        };
        const out = {};
        /* Wide spacing so the dabs are separate blobs -- at a spacing that
         * overlaps, three extra dabs mostly land on ink that is already
         * there and the count says almost nothing. */
        out.one = await line(b => { b.setParam('spacing', 300); b.setParam('scatter', 200);
                                    b.setParam('dabCount', 1); });
        out.four = await line(b => { b.setParam('spacing', 300); b.setParam('scatter', 200);
                                     b.setParam('dabCount', 4); });
        out.plain = await line(() => {});
        out.shifted = await line(b => { b.setParam('offsetAcross', 100); });
        // "Across" a VERTICAL line is sideways. strokeAngle arrives in
        // degrees, and this used to be fed to cos and sin as if it were
        // radians, so the one-axis scatter pointed somewhere arbitrary.
        out.acrossV = await line(b => { b.setParam('scatter', 150);
                                        b.setParam('scatterAxis', 'across'); }, true);
        out.alongV = await line(b => { b.setParam('scatter', 150);
                                       b.setParam('scatterAxis', 'along'); }, true);
        // How far off the line the ink sits on average, and how many separate blobs.
        const spread = (L) => {
            const d = L.ctx.getImageData(0, 0, 400, 400).data, col = new Uint8Array(400);
            let s = 0, n = 0, runs = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 20) { s += Math.abs(((i / 4 / 400) | 0) - 200); n++; col[((i - 3) / 4) % 400] = 1; }
            for (let x = 1; x < 400; x++) if (col[x] && !col[x - 1]) runs++;
            return { off: n ? s / n : 0, runs };
        };
        const cloud = async (axis) => { await line(b => { b.setParam('size', 4); b.setParam('spacing', 1000);
            b.setParam('scatter', 1000); b.setParam('dabCount', 30); b.setParam('scatterAxis', axis); });
            return spread(lastL); };
        out.both = await cloud('both');
        out.disk = await cloud('disk');
        const stops = async (each) => { await line(b => { b.setParam('spacing', 300);
            b.setParam('sizeSrc', 'random'); b.setParam('sizeMin', 0); b.setParam('sprayEach', each); });
            const r = spread(lastL); b.setParam('sprayEach', false); return r.runs; };
        // dabs laid a whole tip ahead of the pen, cut off where it stopped or not
        out.ahead = await line(b => { b.setParam('size', 40); b.setParam('spacing', 100); b.setParam('offsetAlong', 100); });
        out.cut = await line(b => { b.setParam('size', 40); b.setParam('spacing', 100); b.setParam('offsetAlong', 100);
                                    b.setParam('ribbonClip', true); });
        b.setParam('ribbonClip', false);
        out.stopsEach = await stops(true);
        out.stopsShared = await stops(false);
        b._setStrokeSeed(null);
        b.loadPreset('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify(b4));
    check('four dabs a stop lay down four times the ink of one',
        b4.four.n > b4.one.n * 2.5, `${b4.one.n} then ${b4.four.n}`);
    check('an offset across the line moves the whole line off it',
        b4.shifted.cy - b4.plain.cy > 15, `${b4.plain.cy} then ${b4.shifted.cy}`);
    /* The tip is 20 across. Scattered sideways by 150 per cent of it the
     * line has to come out about 80 wide; scattered along its own length it
     * stays exactly as wide as the tip. */
    check('"across" a vertical stroke spreads it sideways',
        b4.acrossV.w > 60, JSON.stringify(b4.acrossV));
    check('...and "along" it leaves the width alone',
        b4.alongV.w <= 22 && b4.alongV.h > b4.acrossV.h,
        `${b4.alongV.w} wide against ${b4.acrossV.w}`);
    /* A Clip Studio ribbon stops where the pen stops, its last picture cut
     * straight across (Chain ran 90px past the end of a line here). */
    check('a ribbon is cut off where the pen stopped',
        b4.ahead.w >= 335 && b4.cut.w <= 301, `${b4.ahead.w} wide, then ${b4.cut.w}`);
    /* Clip Studio sprays evenly over the whole patch (Spray's band is a
     * semicircle across); a random direction and a random distance pile the
     * particles up in the middle instead: 4R/3pi off the line against R/pi. */
    check('a disk spray spreads its particles evenly over the patch',
        b4.disk.off > b4.both.off * 1.2, `${b4.both.off.toFixed(1)} then ${b4.disk.off.toFixed(1)}`);
    /* Each particle takes its own random size, and the stops stay a plain
     * size apart: spaced by the random size, Droplet laid five times the ink. */
    check('particles sized one by one keep their stops a plain size apart',
        b4.stopsEach <= 6 && b4.stopsShared > b4.stopsEach, `${b4.stopsEach} stops against ${b4.stopsShared}`);

    /* ── how wide a smudge reaches ────────────────────────────────────── */
    console.log('\n== a smudge can reach past the dab it is making ==');
    const b5 = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        /* A red field with one thin blue stripe in it. The stroke runs
         * alongside the stripe, never over it: a brush that samples only the
         * dab's own radius cannot see the blue, and a brush that reaches
         * four times as far can. */
        const run = async (reach) => {
            __B.doc(400, 200);
            ['texture', 'opacity', 'flow', 'aspectRatio', 'shape', 'tipCells',
             'bristleCount', 'scatter', 'dabCount', 'offsetAlong', 'offsetAcross',
             'sizeSrc', 'smoothingMode', 'taperStart', 'taperEnd', 'flowSrc']
                .forEach(k => b.setParam(k, b.DEFAULTS[k]));
            b.setParam('dynamicsMode', 'off');
            b.setParam('size', 12); b.setParam('hardness', 100);
            b.setParam('spacing', 20); b.setParam('sizeSrc', 'none');
            b.setParam('colorRate', 0); b.setParam('smudgeLength', 90);
            b.setParam('smudgeRadius', reach);
            const L = __B.layer();
            L.ctx.fillStyle = '#ff0000'; L.ctx.fillRect(0, 0, 400, 200);
            L.ctx.fillStyle = '#0000ff'; L.ctx.fillRect(140, 0, 20, 200);
            await __B.stroke(170, 40, 170, 170, '#ff0000');
            const d = L.ctx.getImageData(170, 160, 1, 1).data;
            return [d[0], d[2]];
        };
        const out = { near: await run(25), far: await run(400) };
        b.loadPreset('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify(b5));
    check('a narrow smudge never sees the stripe beside it',
        b5.near[1] < 20, b5.near.join(','));
    check('...and a wide one picks it up',
        b5.far[1] > b5.near[1] + 10, `${b5.near.join(',')} against ${b5.far.join(',')}`);

    /* ── a second tip, stamped through the first ──────────────────────── */
    console.log('\n== a second tip carves the first ==');
    const b2 = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        /* A black bar on nothing. The loader reads darkness as coverage, so
         * this is a tip that covers a stripe across the middle and nothing
         * else -- which is exactly what a carve should leave behind. */
        const c = document.createElement('canvas');
        c.width = 64; c.height = 64;
        const cx = c.getContext('2d');
        cx.fillStyle = '#000';
        cx.fillRect(0, 24, 64, 16);
        const url = c.toDataURL('image/png');

        /* __B.doc loads Round, and loading a preset is what decides which
         * second tip is in play -- so the tip has to go on AFTER the doc, not
         * before it. */
        const run = async (depth, size, tip) => {
            __B.doc(400, 200);
            b.loadDualTip(tip || '');
            if (tip) await new Promise(r => setTimeout(r, 300));
            ['texture', 'opacity', 'flow', 'aspectRatio', 'shape', 'tipCells',
             'bristleCount', 'scatter', 'dabCount', 'offsetAlong', 'offsetAcross',
             'colorRate', 'sizeSrc', 'smoothingMode', 'taperStart', 'taperEnd',
             'flowSrc', 'sharpness']
                .forEach(k => b.setParam(k, b.DEFAULTS[k]));
            b.setParam('dynamicsMode', 'off');
            b.setParam('size', 60); b.setParam('hardness', 100);
            b.setParam('spacing', 100); b.setParam('sizeSrc', 'none');
            b.setParam('tip2Depth', depth); b.setParam('tip2Size', size);
            b.setParam('tip2Angle', 0);
            const L = __B.layer();
            b.beginStroke(200, 100, 1, '#ff0000');
            b.endStroke();
            await new Promise(r => setTimeout(r, 200));
            const d = L.ctx.getImageData(0, 0, 400, 200).data;
            let ink = 0, faint = 0;
            for (let i = 3; i < d.length; i += 4) {
                if (d[i] > 200) ink++; else if (d[i] > 20) faint++;
            }
            return { ink: ink, faint: faint };
        };
        const out = {};
        out.off = await run(0, 100, url);
        out.full = await run(100, 100, url);
        out.half = await run(50, 100, url);
        out.gone = await run(100, 100, null);
        b.loadPreset('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify(b2));
    check('a second tip at full bite cuts the dab down to where both agree',
        b2.full.ink > 0 && b2.full.ink < b2.off.ink * 0.5,
        `${b2.off.ink} then ${b2.full.ink}`);
    check('...and at half bite it thins the rest instead of cutting it away',
        b2.half.ink < b2.off.ink && b2.half.faint > b2.full.faint,
        JSON.stringify([b2.off, b2.half, b2.full]));
    check('a brush with no second tip is untouched by the setting',
        b2.gone.ink === b2.off.ink, `${b2.off.ink} against ${b2.gone.ink}`);

    /* A tip's pixels normally never reach the canvas -- it is a cut-out and
     * only its alpha counts. Krita can also read them as lightness over the
     * chosen colour, or stamp the picture as it stands. */
    console.log('\n== a tip can paint with its own pixels ==');
    const tm = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        /* Half the tip dark, half light, and a transparent margin round the
         * lot so the picture is read as a picture rather than as a stamp
         * scanned on white. Coverage is then flat and only the greys can
         * make the two halves differ. */
        const c = document.createElement('canvas');
        c.width = 64; c.height = 64;
        const cx = c.getContext('2d');
        cx.fillStyle = '#202020'; cx.fillRect(2, 2, 30, 60);
        cx.fillStyle = '#e0e0e0'; cx.fillRect(32, 2, 30, 60);
        // and its dark half's foot half clear, the way a thin line is once shrunk
        cx.clearRect(2, 44, 30, 18); cx.fillStyle = 'rgba(32,32,32,0.5)'; cx.fillRect(2, 44, 30, 18);
        const url = c.toDataURL('image/png');
        const run = async (mode, sub) => {
            __B.doc(200, 200);
            b.loadCustomTip(url, null);
            await new Promise(r => setTimeout(r, 400));
            ['texture', 'opacity', 'flow', 'scatter', 'colorRate', 'sizeSrc',
             'taperStart', 'taperEnd', 'tip2Depth', 'valJitter', 'jitterSub', 'colorJitterRange', 'subMix', 'dabOpacitySrc', 'dabOpacityMin', 'tipTint'].forEach(k => b.setParam(k, b.DEFAULTS[k]));
            b.setParam('dynamicsMode', 'off');
            b.setParam('size', 80); b.setParam('hardness', 100);
            b.setParam('tipMode', mode);
            // the sub colour (white) taken half down, every dab
            if (sub === 'tintjit') { b.setParam('tipTint', true); b.setParam('valJitter', 50); b.setParam('colorJitterRange', [[0, 0], [0, 0], [-1, -1]]); b.setParam('jitterSub', true); }
            else if (sub === 'tint') b.setParam('tipTint', true);
            else if (sub === 'mix') b.setParam('subMix', 50);
            else if (sub === 'ad') { b.setParam('dabOpacitySrc', 'random'); b.setParam('dabOpacityMin', 100); }
            else if (sub) { b.setParam('valJitter', 50); b.setParam('colorJitterRange', [[0, 0], [0, 0], [-1, -1]]); b.setParam('jitterSub', true); }
            const L = __B.layer();
            b.beginStroke(100, 100, 1, '#808080');
            b.endStroke();
            await new Promise(r => setTimeout(r, 200));
            return { left: __B.px(L, 80, 100), right: __B.px(L, 120, 100), half: __B.px(L, 80, 128) };
        };
        const out = { alpha: await run('alpha'), light: await run('lightness'),
                      color: await run('color'), sub: await run('color', true), mix: await run('color', 'mix'),
                      ad: await run('color', 'ad'), tint: await run('color', 'tint'), tintjit: await run('color', 'tintjit') };
        b.setParam('subMix', 0); b.setParam('dabOpacitySrc', 'none'); b.setParam('dabOpacityMin', b.DEFAULTS.dabOpacityMin);
        b.forgetSaved(b._currentPreset || 'Round');
        b.loadPreset('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify(tm));
    const redOf = (s) => parseInt(s.split(',')[0], 10);
    check('a cut-out tip paints the colour it was given, evenly',
        redOf(tm.alpha.left) === redOf(tm.alpha.right) && Math.abs(redOf(tm.alpha.left) - 128) < 3,
        JSON.stringify(tm.alpha));
    check('a lightness-mapped tip darkens under its dark half and lightens under its light one',
        redOf(tm.light.left) < 100 && redOf(tm.light.right) > 160, JSON.stringify(tm.light));
    check('a tip that stamps its own picture ignores the colour entirely',
        redOf(tm.color.left) < 60 && redOf(tm.color.right) > 200, JSON.stringify(tm.color));
    // A random opacity a dab flattened it to one colour: WC Generic Flower's white hearts went grey.
    check('...and keeps its own shading under a random opacity a dab',
        redOf(tm.ad.left) < 60 && redOf(tm.ad.right) > 200, JSON.stringify(tm.ad));
    /* Clip Studio's sub colour is a picture's whites: changed by value it
     * greys Building's faces and leaves the lines as they were. */
    // its darks in the half-mixed ink (128 -> 192), its lights toward white: 32 -> 200, 224 -> 247
    check('a sub colour mix lightens a picture as Clip Studio tints it, ink to white',
        Math.abs(redOf(tm.mix.left) - 200) < 4 && Math.abs(redOf(tm.mix.right) - 247) < 4, JSON.stringify(tm.mix));
    /* A grey Clip Studio picture (Button, Braid, Chain, Grass patch) paints its darks in the colour you
     * picked and its lights in white -- screen(ink, picture): ink 128 over 32 -> 144, over 224 -> 240.
     * Stamped as it was it came out black whatever the colour (Button in purple, CSP vs ours: 145 off). */
    check('a grey picture takes the picked colour in its darks and white in its lights',
        Math.abs(redOf(tm.tint.left) - 144) < 6 && Math.abs(redOf(tm.tint.right) - 240) < 6, JSON.stringify(tm.tint));
    /* ...and a jitter on its sub colour shades only the lights: Thin chain's links stay the ink over grey 204. */
    check("a jittered sub colour leaves a grey picture's darks in the ink",
        redOf(tm.tintjit.left) > redOf(tm.tint.left) - 40 && redOf(tm.tintjit.right) < redOf(tm.tint.right) - 20, JSON.stringify([tm.tint, tm.tintjit]));
    // a canvas blend mixed a half-clear pixel with the fill: 32 at half alpha came out 72 (Rubble lost a third of its ink)
    check('a sub colour shades a half-clear pixel no lighter than it was',
        redOf(tm.sub.half) <= redOf(tm.color.half) && Math.abs(redOf(tm.mix.half) - 200) < 4 && tm.sub.half.split(',')[3] === tm.color.half.split(',')[3],
        JSON.stringify([tm.color.half, tm.sub.half, tm.mix.half]));
    check('a change to the sub colour shades the picture and leaves its dark ink dark',
        Math.abs(redOf(tm.sub.right) - redOf(tm.color.right) / 2) < 4 && redOf(tm.sub.left) <= redOf(tm.color.left),
        JSON.stringify([tm.color, tm.sub]));

    /* Two engines that are not brushes. The experiment brush fills the
     * outline the stroke draws; the deform brush moves pixels that are
     * already on the layer and lays no paint of its own. */
    console.log('\n== an engine that fills what the stroke encloses ==');
    const shp = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        const L = __B.doc(300, 300);
        b.setParam('engineKind', 'shape');
        b.setParam('flow', 100);
        b.beginStroke(60, 60, 1, '#ff0000');
        for (const [x, y] of [[240, 60], [240, 240], [60, 240], [60, 60]]) {
            for (let i = 0; i < 6; i++) b.moveStroke(x, y, 1, '#ff0000');
        }
        b.endStroke();
        await new Promise(r => setTimeout(r, 200));
        const out = { middle: __B.px(L, 150, 150), corner: __B.px(L, 20, 20),
                      edge: __B.px(L, 150, 62) };
        b.setParam('engineKind', 'brush');
        b.forgetSaved(b._currentPreset || 'Round');
        b.loadPreset('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify(shp));
    check('the inside of the outline is filled', shp.middle === '255,0,0,255', shp.middle);
    check('...and the outside of it is not', shp.corner === CLEAR, shp.corner);

    console.log('\n== an engine that moves the pixels it finds ==');
    const dfm = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        const L = __B.doc(300, 300);
        // A hard red square to push about, and nothing else on the layer.
        L.ctx.fillStyle = '#ff0000';
        L.ctx.fillRect(100, 100, 100, 100);
        const at = (x, y) => __B.px(L, x, y);
        const before = { inside: at(150, 150), rightOfIt: at(230, 150) };
        b.setParam('engineKind', 'deform');
        b.setParam('deformAction', 'move');
        b.setParam('deformAmount', 100);
        b.setParam('size', 160);
        b.setParam('spacing', 15);
        b.beginStroke(150, 150, 1, '#0000ff');
        for (let i = 1; i <= 40; i++) {
            b.moveStroke(150 + i * 2, 150, 1, '#0000ff');
            if (i % 8 === 0) await new Promise(r => requestAnimationFrame(r));
        }
        b.endStroke();
        await new Promise(r => setTimeout(r, 200));
        const after = { inside: at(150, 150), rightOfIt: at(230, 150) };
        b.setParam('engineKind', 'brush');
        b.forgetSaved(b._currentPreset || 'Round');
        b.loadPreset('Round');
        return JSON.stringify({ before, after, steps: PaintApp.state.history.length });
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify(dfm));
    check('the paint it dragged over lands where it was dragged to',
        dfm.before.rightOfIt === CLEAR && dfm.after.rightOfIt !== CLEAR,
        JSON.stringify([dfm.before.rightOfIt, dfm.after.rightOfIt]));
    check('...and it painted none of its own colour doing it',
        !/^0,0,255/.test(dfm.after.rightOfIt), dfm.after.rightOfIt);
    check('...and a deform is one undo step like any other stroke',
        dfm.steps === 2, String(dfm.steps));

    /* Krita keeps a shrunk tip's ink; the browser's own shrink lost the
     * faint part (X2DA Soft Mix's 602px speckle tip laid 0.905 of Krita's
     * ink at 40px, probes/dullgbr). A 400px tip speckled over 6% of it at
     * random strengths must lay its own share at 40px: the browser's shrink
     * kept 0.925 of it. GIMP's 'halve' must keep it too. */
    for (const mode of ['area', 'halve']) {
    const shrink = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        __B.doc(200, 200);
        const c = document.createElement('canvas'); c.width = c.height = 400;
        const g = c.getContext('2d'), im = g.createImageData(400, 400);
        let seed = 7, tot = 0;
        const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        for (let i = 0; i < 160000; i++) if (rnd() < 0.06) { const a = 40 + (rnd() * 215) | 0; im.data[i * 4 + 3] = a; tot += a; }
        g.putImageData(im, 0, 0);
        b.loadCustomTip(c.toDataURL('image/png'), null);
        await new Promise(r => setTimeout(r, 600));
        ['texture', 'opacity', 'flow', 'scatter', 'sizeSrc', 'taperStart', 'taperEnd', 'tip2Depth'].forEach(k => b.setParam(k, b.DEFAULTS[k]));
        b.setParam('dynamicsMode', 'off'); b.setParam('size', 40); b.setParam('hardness', 100); b.setParam('tipShrink', '${mode}');
        b.beginStroke(100, 100, 1, '#000000'); b.endStroke();
        await new Promise(r => setTimeout(r, 200));
        const d = __B.layer().ctx.getImageData(0, 0, 200, 200).data;
        let sum = 0; for (let i = 3; i < d.length; i += 4) sum += d[i];
        return JSON.stringify({ ink: sum / 255, want: tot / 255 / 160000 * 1600 });
    })()`, { awaitPromise: true }));
    check(`a tip shrunk tenfold (${mode}) keeps its ink, faint as it gets`,
        Math.abs(shrink.ink / shrink.want - 1) <= 0.02, 'ink ' + shrink.ink.toFixed(2) + ' of ' + shrink.want.toFixed(2));
    }

    /* A Clip Studio spray lays nothing at the pen: the first stop is a
     * quarter of a particle on (40px: at 10), or a step if nearer. */
    const first = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, out = [];
        for (const [spacing, at] of [[200, 0.25], [10, 0.25], [200, 0]]) {
            __B.doc(400, 100);
            b.forgetSaved('Round'); b.loadPreset('Round');
            b.setParam('dynamicsMode', 'off'); b.setParam('scatter', 0); b.setParam('size', 40); b.setParam('hardness', 100);
            b.setParam('spacing', spacing); b.setParam('firstDabAt', at);
            const L = __B.layer();
            await __B.stroke(20, 50, 380, 50, '#000000');
            out.push([2, 5, 30].map(x => +__B.px(L, x, 50).split(',')[3]));
        }
        b.setParam('firstDabAt', 0); b.setParam('spacing', b.DEFAULTS.spacing);
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    check('a Clip Studio spray starts a quarter of a particle on, or a step if nearer, not at the pen',
        first[0][1] === 0 && first[0][2] > 200 && first[1][0] === 0 && first[1][1] > 200 && first[2][1] > 200, JSON.stringify(first));

    /* Clip Studio's auto spacing on a picture follows the size, squeezed
     * by thickness only, not the picture's own narrow side: Charcoal's
     * 105x147 picture lays the ink of a fixed 12% of its size. A 1:2 tip
     * spaced by width lays what one spaced by its 40px size does. */
    const tall = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, out = [];
        const c = document.createElement('canvas'); c.width = 32; c.height = 64;
        const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 32, 64);
        b.loadCustomTip(c.toDataURL('image/png'), null);
        await new Promise(r => setTimeout(r, 400));
        for (const byWidth of [true, false]) {
            __B.doc(300, 100);
            ['texture', 'opacity', 'scatter', 'sizeSrc', 'taperStart', 'taperEnd', 'tip2Depth', 'angle', 'aspectRatio'].forEach(k => b.setParam(k, b.DEFAULTS[k]));
            b.setParam('dynamicsMode', 'off'); b.setParam('size', 40); b.setParam('spacing', 50); b.setParam('flow', 5);
            b.setParam('spacingIsotropic', !byWidth); b.setParam('spacingByWidth', byWidth);
            await __B.stroke(50, 50, 250, 50, '#000000');
            const d = __B.layer().ctx.getImageData(0, 0, 300, 100).data;
            let s = 0; for (let i = 3; i < d.length; i += 4) s += d[i];
            out.push(s);
        }
        b.setParam('spacingByWidth', false); b.setParam('spacingIsotropic', b.DEFAULTS.spacingIsotropic); b.setParam('flow', 100);
        b.forgetSaved(b._currentPreset || 'Round'); b.loadPreset('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    check('a Clip Studio picture on auto spacing steps by its size, not its narrow side',
        Math.abs(tall[0] / tall[1] - 1) < 0.05, JSON.stringify(tall));

    /* Krita draws a picture tip once from its halving pyramid, bilinear at
     * the true scale and the dab's sub-pixel phase (KisQImagePyramid): a
     * 64px tip at 22px comes from its 32px level at 0.69, so a 2px line
     * lands on one column at 0.77 of full. Averaged straight to 22px and
     * shifted again it smeared over three (Light Shine's stars, IoU 0.59). */
    const kp = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        __B.doc(200, 200);
        const c = document.createElement('canvas'); c.width = c.height = 64;
        const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(30, 0, 2, 64);
        b.loadCustomTip(c.toDataURL('image/png'), null);
        await new Promise(r => setTimeout(r, 400));
        ['texture', 'opacity', 'flow', 'scatter', 'sizeSrc', 'taperStart', 'taperEnd', 'tip2Depth', 'sharpness'].forEach(k => b.setParam(k, b.DEFAULTS[k]));
        b.setParam('dynamicsMode', 'off'); b.setParam('size', 22); b.setParam('hardness', 100); b.setParam('tipShrink', 'area');
        b.beginStroke(100, 100, 1, '#000000'); b.endStroke();
        await new Promise(r => setTimeout(r, 200));
        // an eighth of a pixel on: 151 drawn at its own phase, 104 rounded to a quarter
        b.beginStroke(100.125, 150, 1, '#000000'); b.endStroke();
        await new Promise(r => setTimeout(r, 200));
        const d = __B.layer().ctx.getImageData(95, 100, 10, 1).data, row = [];
        for (let i = 3; i < d.length; i += 4) row.push(d[i]);
        row.push(__B.layer().ctx.getImageData(99, 150, 1, 1).data[3]);
        b.forgetSaved(b._currentPreset || 'Round'); b.loadPreset('Round');
        return JSON.stringify(row);
    })()`, { awaitPromise: true }));
    check("a Krita picture tip is drawn once from its pyramid: a thin line stays one column",
        kp[4] >= 185 && kp[4] <= 205 && kp[3] <= 8 && kp[5] <= 8, JSON.stringify(kp));
    check('...and at its own sub-pixel phase, not rounded to a quarter pixel',
        Math.abs(kp[10] - 151) <= 8, 'alpha ' + kp[10] + ', want ~151');

    /* A tip Krita keeps as grey paper is shrunk by Qt, which drops the grey's
     * fraction: ink rounds up. One faint pixel in every 2x2 of a 64px tip
     * averages to a quarter level at 32px and keeps a whole one, which a 22px
     * dab shows where a quarter rounds away; FX_splat_starfield's stars lost
     * 15% of Krita's ink without it. */
    const paper = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, out = [];
        const c = document.createElement('canvas'); c.width = c.height = 64;
        const g = c.getContext('2d'), im = g.createImageData(64, 64);
        for (let y = 0; y < 64; y += 2) for (let x = 0; x < 64; x += 2) im.data[(y * 64 + x) * 4 + 3] = 1;
        g.putImageData(im, 0, 0);
        b.loadCustomTip(c.toDataURL('image/png'), null);
        await new Promise(r => setTimeout(r, 400));
        ['texture', 'opacity', 'flow', 'scatter', 'sizeSrc', 'taperStart', 'taperEnd', 'tip2Depth', 'sharpness'].forEach(k => b.setParam(k, b.DEFAULTS[k]));
        b.setParam('dynamicsMode', 'off'); b.setParam('size', 22); b.setParam('hardness', 100); b.setParam('tipShrink', 'area');
        for (const on of [false, true]) {
            __B.doc(200, 200); b.setParam('tipPaper', on);
            b.beginStroke(100, 100, 1, '#000000'); b.endStroke();
            await new Promise(r => setTimeout(r, 200));
            const d = __B.layer().ctx.getImageData(0, 0, 200, 200).data;
            let s = 0; for (let i = 3; i < d.length; i += 4) s += d[i];
            out.push(s);
        }
        b.forgetSaved(b._currentPreset || 'Round'); b.loadPreset('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    check("a Krita paper tip's faint ink rounds up as Qt shrinks it (FX_splat_starfield)",
        paper[0] === 0 && paper[1] > 100, JSON.stringify(paper));

    /* Clip Studio's anti-aliasing off shrinks a picture without smoothing:
     * one dot in every 4x4 at a quarter size is a dot of ink, where smoothed
     * it is a sixteenth (Pastel's specks). And a mirror flips each dab at
     * random whatever the order: two pictures taken in turn, the second
     * blank, ink every other dab, the first landing both ways (Pastel's
     * reverse 2); cycling the flips as pictures inked two dabs in four. */
    const crisp = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, out = { max: [], dabs: [] };
        const c = document.createElement('canvas'); c.width = c.height = 64;
        const g = c.getContext('2d'); g.fillStyle = '#000';
        for (let y = 2; y < 64; y += 4) for (let x = 2; x < 64; x += 4) g.fillRect(x, y, 1, 1);
        b.loadCustomTip(c.toDataURL('image/png'), null);
        await new Promise(r => setTimeout(r, 400));
        ['texture', 'opacity', 'flow', 'scatter', 'sizeSrc', 'taperStart', 'taperEnd', 'tip2Depth', 'sharpness', 'angleSrc'].forEach(k => b.setParam(k, b.DEFAULTS[k]));
        b.setParam('dynamicsMode', 'off'); b.setParam('size', 16); b.setParam('hardness', 100);
        for (const mode of ['nearest', '']) {
            const L = __B.doc(200, 200); b.setParam('tipShrink', mode);
            b.beginStroke(100, 100, 1, '#000000'); b.endStroke();
            await new Promise(r => setTimeout(r, 200));
            const d = L.ctx.getImageData(80, 80, 40, 40).data;
            let m = 0; for (let i = 3; i < d.length; i += 4) m = Math.max(m, d[i]);
            out.max.push(m);
        }
        g.clearRect(0, 0, 64, 64);
        for (let y = 0; y < 64; y++) for (let x = (y & 1); x < 64; x += 2) g.fillRect(x, y, 1, 1);   // a one-pixel checker
        b.loadCustomTip(c.toDataURL('image/png'), null);
        await new Promise(r => setTimeout(r, 400));
        b.setParam('tipShrink', '');
        for (const n of [2, 0]) {
            const L = __B.doc(200, 200); b.setParam('tipSamples', n); b.setParam('tipShift', 0.5);
            b.beginStroke(100, 100, 1, '#000000'); b.endStroke();
            await new Promise(r => setTimeout(r, 200));
            const d = L.ctx.getImageData(80, 80, 40, 40).data;
            let m = 0; for (let i = 3; i < d.length; i += 4) m = Math.max(m, d[i]);
            out.max.push(m);
        }
        b.setParam('tipSamples', 0); b.setParam('tipShift', 0);
        const s = document.createElement('canvas'); s.width = 128; s.height = 64;
        const sg = s.getContext('2d'); sg.fillRect(0, 0, 12, 64); sg.fillRect(0, 48, 64, 16);   // an L: its foot finds the dab, its bar the side
        b.loadCustomTip(s.toDataURL('image/png'), null);
        b.setParam('tipCells', 2); b.setParam('tipPick', 'cycle'); b.setParam('tipMirror', 'h');
        await new Promise(r => setTimeout(r, 400));
        b.setParam('tipShrink', ''); b.setParam('size', 20); b.setParam('spacing', 200); b.setParam('autoSpacing', 0);
        const L = __B.doc(400, 100);
        b._setStrokeSeed(1);   // flips at random: a seed whose seven dabs show both sides
        await __B.stroke(20, 50, 380, 50, '#000000');
        const foot = L.ctx.getImageData(0, 54, 400, 1).data, bar = L.ctx.getImageData(0, 46, 400, 1).data;
        for (let x = 0; x < 400; x++) {
            if (!(foot[x * 4 + 3] > 128) || foot[x * 4 - 1] > 128) continue;
            let e = x; while (e < 399 && foot[(e + 1) * 4 + 3] > 128) e++;
            const m = (x + e) >> 1; let l = 0, r = 0;
            for (let i = x; i <= e; i++) (i < m ? (l += bar[i * 4 + 3]) : (r += bar[i * 4 + 3]));
            out.dabs.push([x, l > r ? 'L' : 'R']); x = e;
        }
        ['tipCells', 'tipPick', 'tipMirror', 'spacing', 'autoSpacing'].forEach(k => b.setParam(k, b.DEFAULTS[k])); b._setStrokeSeed(null);
        b.forgetSaved(b._currentPreset || 'Round'); b.loadPreset('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    check("a picture shrunk without smoothing keeps its specks whole (Clip Studio's anti-aliasing off)",
        crisp.max[0] > 100 && crisp.max[1] < 60, JSON.stringify(crisp.max));
    // a pixel's four samples land the checker's pitch apart: all on its black or all off
    check("Clip Studio's low anti-aliasing point-samples a picture, not averages it",
        crisp.max[2] > 250 && crisp.max[3] < 160, JSON.stringify(crisp.max));
    /* Clip Studio starts every stroke at the first of a picture pipe, so the same drag laid twice is the same
     * picture (Crack); without it the pipe goes on from where the last stroke stopped. */
    const cyc = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, out = [];
        const c = document.createElement('canvas'); c.width = 192; c.height = 64;
        const g = c.getContext('2d'); g.fillRect(0, 0, 40, 64); g.fillRect(64, 0, 64, 20); g.fillRect(128, 40, 64, 24);   // three different pictures
        b.setParam('tipCells', 3);
        b.loadCustomTip(c.toDataURL('image/png'), null);
        await new Promise(r => setTimeout(r, 400));
        b.setParam('tipCells', 3); b.setParam('tipPick', 'cycle'); b.setParam('size', 30); b.setParam('spacing', 100); b.setParam('autoSpacing', 0);
        for (const reset of [true, false]) {
            b.setParam('tipCycleReset', reset);
            const L = __B.doc(200, 100);
            await __B.stroke(30, 50, 75, 50, '#000000'); const a = Array.from(L.ctx.getImageData(0, 0, 200, 100).data);
            L.ctx.clearRect(0, 0, 200, 100);
            await __B.stroke(30, 50, 75, 50, '#000000'); const d = Array.from(L.ctx.getImageData(0, 0, 200, 100).data);
            out.push(a.every((v, i) => v === d[i])); 
        }
        ['tipCells', 'tipPick', 'spacing', 'autoSpacing', 'tipCycleReset', 'size'].forEach(k => b.setParam(k, b.DEFAULTS[k]));
        b.forgetSaved(b._currentPreset || 'Round'); b.loadPreset('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    check("a stroke starts the picture pipe again from its first picture when the format says so (Clip Studio's Crack)",
        cyc[0] === true && cyc[cyc.length - 1] === false, JSON.stringify(cyc));
    const dabs = crisp.dabs.map(d => d[1]).join(''), mgaps = crisp.dabs.slice(1).map((d, i) => d[0] - crisp.dabs[i][0]);
    check('a mirrored tip taken in turn keeps its turn and flips each dab at random',
        dabs.length >= 4 && Math.max(...mgaps) - Math.min(...mgaps) <= 2 && dabs.includes('L') && dabs.includes('R'), dabs + ' ' + mgaps);

    /* A ribbon's pictures meet end to end at fractions of a pixel, and
     * where two met each half covered the pixel: a light seam every link of
     * Thin chain. A solid bar laid as a ribbon is solid; one inked on its
     * left half only (Dashed line's gaps are its blank ends) keeps its gaps.
     * The same through Clip Studio's low anti-aliasing (tipSamples): Rough
     * pen's ribbon showed a seam every piece. And a dash cut in two pieces
     * (blank only at its outer ends, Dashed line) meets itself whole. */
    const rib = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, out = {};
        for (const ss of [0, 2, 4]) for (const half of [false, true, 'cut']) {
            if (half === 'cut' && !ss) continue;
            const c = document.createElement('canvas'); c.width = half === 'cut' ? 128 : 64; c.height = 16;
            const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(half === 'cut' ? 16 : 0, 0, half === 'cut' ? 96 : half ? 32 : 64, 16);
            b.setParam('tipCells', half === 'cut' ? 2 : 1); b.setParam('tipPick', half === 'cut' ? 'cycle' : b.DEFAULTS.tipPick);   // cut as the tip loads
            b.loadCustomTip(c.toDataURL('image/png'), null);
            await new Promise(r => setTimeout(r, 400));
            ['texture', 'opacity', 'flow', 'scatter', 'sizeSrc', 'taperStart', 'taperEnd', 'tip2Depth', 'angleSrc', 'tipShrink'].forEach(k => b.setParam(k, b.DEFAULTS[k]));
            b.setParam('dynamicsMode', 'off'); b.setParam('size', 21.3); b.setParam('hardness', 100);
            b.setParam('spacing', 100); b.setParam('spacingIsotropic', false); b.setParam('autoSpacing', 0);
            b.setParam('angle', 0); b.setParam('angleSrc', 'direction'); b.setParam('ribbonClip', true);
            b.setParam('tipSamples', ss); b.setParam('tipShift', ss ? 0.25 : 0);
            const L = __B.doc(400, 100);
            await __B.stroke(20.3, 50, 380, 50, '#000000');
            const row = L.ctx.getImageData(60, 50, 280, 1).data;
            let min = 255, clear = 0;
            for (let i = 3; i < row.length; i += 4) { min = Math.min(min, row[i]); if (row[i] < 10) clear++; }
            const all = []; for (let i = 3; i < row.length; i += 4) all.push(row[i]);
            if (half === 'cut') {   // the faintest pixel inside each dash, its two edge pixels aside
                let worst = 255;
                for (let i = 0, run = []; i <= all.length; i++) {
                    if (i < all.length && all[i] > 10) { run.push(all[i]); continue; }
                    if (run.length > 6) worst = Math.min(worst, ...run.slice(2, -2));
                    run = [];
                }
                out['cut' + ss] = worst; continue;
            }
            out[(half ? 'dash' : 'bar') + ss] = [min, clear, all.sort((p, q) => p - q)[all.length >> 1]];
        }
        ['spacing', 'spacingIsotropic', 'autoSpacing', 'angle', 'angleSrc', 'ribbonClip', 'tipSamples', 'tipShift', 'tipCells', 'tipPick'].forEach(k => b.setParam(k, b.DEFAULTS[k]));
        b.forgetSaved(b._currentPreset || 'Round'); b.loadPreset('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    check('a ribbon of solid pictures has no seams where they meet',
        [rib.bar0, rib.bar2, rib.bar4].every(r => r[1] === 0 && r[0] >= r[2] - 5) && rib.cut2 >= rib.bar2[2] - 5 && rib.cut4 >= rib.bar4[2] - 5, JSON.stringify(rib));
    check('...and one whose pictures end blank keeps its gaps',
        rib.dash0[1] > 100 && rib.dash2[1] > 100 && rib.dash4[1] > 100, JSON.stringify(rib));

    /* A picture turned a quarter turn keeps its pixels: turned about the
     * middle of a square as wide as its diagonal, an odd-by-even picture
     * landed half a pixel off the grid and every line went two pixels grey
     * (Braid, turned 270 in Clip Studio, came out soft). A one-pixel line
     * across a 63x16 picture, turned 90, in one dab. */
    const quarter = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, L = __B.doc(200, 200);
        const c = document.createElement('canvas'); c.width = 63; c.height = 16;
        const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 8, 63, 1);
        b.loadCustomTip(c.toDataURL('image/png'), null);
        await new Promise(r => setTimeout(r, 400));
        ['texture', 'opacity', 'flow', 'scatter', 'sizeSrc', 'taperStart', 'taperEnd', 'tip2Depth', 'angleSrc', 'tipShrink', 'ribbonClip'].forEach(k => b.setParam(k, b.DEFAULTS[k]));
        b.setParam('dynamicsMode', 'off'); b.setParam('size', 63); b.setParam('hardness', 100);
        b.setParam('angle', 90); b.setParam('sizeSrc', 'none');
        b.beginStroke(100, 100, 1, '#000000'); b.endStroke();   // one dab
        await new Promise(r => setTimeout(r, 180));
        const row = L.ctx.getImageData(80, 100, 40, 1).data, a = [];
        for (let i = 3; i < row.length; i += 4) if (row[i] > 10) a.push(row[i]);
        b.setParam('angle', b.DEFAULTS.angle);
        b.forgetSaved(b._currentPreset || 'Round'); b.loadPreset('Round');
        return JSON.stringify(a);
    })()`, { awaitPromise: true }));
    check('a picture turned a quarter turn keeps a one-pixel line one pixel wide',
        quarter.length === 1, JSON.stringify(quarter));

    /* Clip Studio's thickness past 100 stretches a picture (Feather's 150):
     * a solid 20x40 picture at size 40 lays 30 wide, as tall as it was --
     * through Clip Studio's low anti-aliasing too (Rough pen). */
    const stretch = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, L = __B.doc(200, 200);
        const c = document.createElement('canvas'); c.width = 20; c.height = 40;
        const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 20, 40);
        b.loadCustomTip(c.toDataURL('image/png'), null);
        await new Promise(r => setTimeout(r, 400));
        ['texture', 'opacity', 'flow', 'scatter', 'taperStart', 'taperEnd', 'tip2Depth', 'angleSrc', 'tipShrink', 'ribbonClip', 'angle'].forEach(k => b.setParam(k, b.DEFAULTS[k]));
        b.setParam('dynamicsMode', 'off'); b.setParam('size', 40); b.setParam('hardness', 100); b.setParam('sizeSrc', 'none');
        b.setParam('tipStretch', [1.5, 1]);
        const out = [];
        for (const ss of [0, 2]) {
            b.setParam('tipSamples', ss); L.ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(100, 100, 1, '#000000'); b.endStroke();
            await new Promise(r => setTimeout(r, 180));
            const d = L.ctx.getImageData(0, 0, 200, 200).data; let w = 0, h = 0;
            for (let i = 0; i < 200; i++) { if (d[(100 * 200 + i) * 4 + 3] > 128) w++; if (d[(i * 200 + 100) * 4 + 3] > 128) h++; }
            out.push(w, h);
        }
        b.setParam('tipStretch', null); b.setParam('tipSamples', 0);
        b.forgetSaved(b._currentPreset || 'Round'); b.loadPreset('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    check("a picture tip's stretch widens it and leaves its height (Clip Studio's thickness past 100)",
        JSON.stringify(stretch) === '[30,40,30,40]', JSON.stringify(stretch));

    /* At precision 1-3 Krita reuses the last dab while the next is close
     * enough, sub-pixel phase and all, just moved to the new whole pixel. A
     * one-column tip stepped 33.3px spreads the same three alphas on every
     * dab; drawn afresh, each dab's phase spreads its own. Pencil-5 Tilted's
     * hatching came out 0.84 like Krita without it. */
    const reuse = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, out = [];
        const c = document.createElement('canvas'); c.width = c.height = 10;
        const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(5, 0, 1, 10);
        b.loadCustomTip(c.toDataURL('image/png'), null);
        await new Promise(r => setTimeout(r, 400));
        ['texture', 'opacity', 'flow', 'scatter', 'sizeSrc', 'taperStart', 'taperEnd', 'tip2Depth', 'sharpness'].forEach(k => b.setParam(k, b.DEFAULTS[k]));
        b.setParam('dynamicsMode', 'off'); b.setParam('size', 10); b.setParam('hardness', 100); b.setParam('spacing', 333); b.setParam('smoothingMode', 'none'); b.setParam('tipShrink', 'area');
        for (const pl of [5, 1]) {
            __B.doc(200, 200); b.setParam('kPrecision', pl);
            b.beginStroke(20.5, 100, 1, '#000000');
            for (let x = 21.5; x < 180; x++) b.moveStroke(x, 100, 1, '#000000');
            b.endStroke();
            await new Promise(r => setTimeout(r, 200));
            const d = __B.layer().ctx.getImageData(0, 100, 200, 1).data;
            const v = new Set(); for (let i = 3; i < d.length; i += 4) if (d[i]) v.add(d[i]);
            out.push(v.size);
        }
        b.forgetSaved(b._currentPreset || 'Round'); b.loadPreset('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    check("a low-precision Krita dab is reused at its old sub-pixel phase (Pencil-5 Tilted)",
        reuse[0] > 5 && reuse[1] === 3, JSON.stringify(reuse) + ' distinct alphas');

    /* Tips are 1024px now rather than 200, and every distinct size, angle
     * and squash of one is baked and kept. A stroke whose size rides the pen
     * asks for a different one per pressure step, so unbounded that cache is
     * a leak t the brush. */
    console.log('== a big tip does not fill memory with itself ==');
    const tc = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        __B.doc();
        const c = document.createElement('canvas'); c.width = c.height = 500;
        const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 500, 500);
        b.loadCustomTip(c.toDataURL('image/png'), null);
        await new Promise(r => setTimeout(r, 800));
        const out = { peak: 0, shape: b.getParams().shape };
        for (let s = 200; s <= 700; s += 10) {
            b.setParam('size', s);
            b.beginStroke(40, 40, 0.9, '#000');
            for (let i = 1; i <= 8; i++) b.moveStroke(40 + i * 16, 40 + i * 16, 0.9, '#000');
            b.endStroke();
            await new Promise(r => setTimeout(r, 0));
            out.peak = Math.max(out.peak, b._tipCacheBytes());
        }
        out.end = b._tipCacheBytes();
        /* Settings persist per preset, so a tip loaded onto Round stays on
         * Round and the next test paints with somebody else's chalk. */
        b.forgetSaved(b._currentPreset || 'Round');
        b.loadPreset('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify(tc));
    check('baking fifty sizes of a 500px tip stays inside its budget',
        tc.peak > 0 && tc.peak <= 24 * 1024 * 1024,
        `${Math.round(tc.peak / 1048576)}MB at its highest`);

    /* ── multi-shape tips ─────────────────────────────────────────────── */
    console.log('== a tip with several shapes ==');
    const mt = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, app = PaintApp;
        /* Six of our stamp brushes come from GIMP .gih files, which hold
         * four to nine shapes side by side. We used to keep the first one
         * and throw the rest away, so every dab was the same rubber stamp.
         * Each dab is drawn on its own so the shapes cannot overlap. */
        const run = async (preset, xs) => {
            app.layerMgr.collapseToBase({ fresh: true });
            app.setSize(600, 200); app.config.zoom = 1; app.updateBounds();
            document.getElementById('lsys-add').click();
            app.state.selection = null;
            const L = app.layerMgr.layers[app.layerMgr.activeIdx];
            b.loadPreset(preset);
            await new Promise(r => setTimeout(r, 600));   // the tip is fetched
            b.setParam('dynamicsMode', 'off');
            b.setParam('scatter', 0);
            b.setParam('angleSrc', 'none');
            b.setParam('angle', 0);
            b.setParam('size', 40);
            const out = [];
            for (const x of xs) {
                L.ctx.clearRect(0, 0, 600, 200);
                b.beginStroke(x, 100, 1, '#ff0000');
                b.endStroke();
                await new Promise(r => setTimeout(r, 90));
                const d = L.ctx.getImageData(x - 45, 55, 90, 90).data;
                let h = 0, ink = 0, x1 = 1e9, x2 = -1, y1 = 1e9, y2 = -1;
                for (let i = 0; i < d.length; i += 4) {
                    const a = d[i + 3];
                    h = (h * 31 + a) | 0;
                    if (a > 20) {
                        ink++;
                        const px = (i / 4) % 90, py = (i / 4 / 90) | 0;
                        if (px < x1) x1 = px; if (px > x2) x2 = px;
                        if (py < y1) y1 = py; if (py > y2) y2 = py;
                    }
                }
                out.push({ h: h, ink: ink,
                    w: x2 < 0 ? 0 : x2 - x1 + 1, hgt: x2 < 0 ? 0 : y2 - y1 + 1 });
            }
            return out;
        };
        const xs = [60, 160, 260, 360, 460, 550];
        const out = {};
        out.chalk  = await run('Charcoal Rock', xs);     // 4 shapes, picked at random
        out.splats = await run('Splatter Large', xs);    // 5 shapes, taken in turn
        out.round  = await run('Round', xs);             // no strip: must not vary
        b.loadPreset('Round');
        return JSON.stringify(out);
    })()`));
    const shapes = (a) => new Set(a.map(s => s.h)).size;
    console.log('  chalk ' + JSON.stringify(mt.chalk));
    console.log('  splats ' + JSON.stringify(mt.splats));

    check('a strip brush stamps more than one shape',
        shapes(mt.chalk) >= 3, `${shapes(mt.chalk)} different shapes in 6 dabs`);
    check('...and never twice the same in a row',
        mt.splats.every((s, i) => i === 0 || s.h !== mt.splats[i - 1].h),
        JSON.stringify(mt.splats.map(s => s.ink)));
    check('a strip is cut apart, not stamped whole',
        mt.chalk.every(s => s.hgt > s.w * 0.5),
        JSON.stringify(mt.chalk.map(s => s.w + 'x' + s.hgt)));
    check('every shape in the strip actually paints',
        mt.chalk.every(s => s.ink > 100) && mt.splats.every(s => s.ink > 100),
        JSON.stringify(mt.chalk.concat(mt.splats).map(s => s.ink)));
    check('a plain brush still stamps the same shape every time',
        shapes(mt.round) === 1, `${shapes(mt.round)} shapes`);

    /* ── panel cost ───────────────────────────────────────────────────── */
    console.log('== what the panel costs to use ==');
    const pf = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, out = {};
        const sb = document.getElementById('paintbrush-sidebar');
        if (sb) { sb.style.display = 'block'; sb.classList.remove('collapsed'); }
        b.loadPreset('Round');

        const t0 = performance.now();
        b.buildBrushGrid();
        out.buildMs = +(performance.now() - t0).toFixed(1);

        const grid = document.getElementById('pb-brush-grid');
        const tile = grid.querySelector('.pb-brush-tile[data-preset="Round"]');
        grid.scrollTop = tile.offsetTop - grid.offsetTop - 20;
        await new Promise(r => setTimeout(r, 250));

        /* A slider drag is one event per pointer move. Each used to redraw
         * the swatch — a whole brush stroke — and write the brush to disk. */
        let redraws = 0, writes = 0;
        const mo = new MutationObserver(ms => {
            for (const m of ms) if (m.addedNodes.length) redraws++;
        });
        mo.observe(tile, { childList: true });
        const realSet = localStorage.setItem.bind(localStorage);
        localStorage.setItem = function (k, v) {
            if (String(k).indexOf('pb-saved-') === 0) writes++;
            return realSet(k, v);
        };
        const el = document.getElementById('pb-hardness');
        const t1 = performance.now();
        for (let i = 0; i < 60; i++) {
            el.value = String(20 + (i % 60));
            el.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => requestAnimationFrame(r));
        }
        out.dragMs = +(performance.now() - t1).toFixed(0);
        await new Promise(r => setTimeout(r, 700));
        mo.disconnect();
        localStorage.setItem = realSet;
        out.events = 60;
        out.redraws = redraws;
        out.writes = writes;
        out.settled = Number(el.value);
        out.paramAfter = b.getParams().hardness;

        // ...and the value that survives is the one the slider stopped on.
        b.forgetSaved('Round');
        b.loadPreset('Round');
        return JSON.stringify(out);
    })()`));
    console.log('  ' + JSON.stringify(pf));

    check('building the grid does not render a hundred swatches',
        pf.buildMs < 120, `${pf.buildMs}ms to build`);
    check('a slider drag does not redraw the swatch on every event',
        pf.redraws > 0 && pf.redraws < pf.events / 3,
        `${pf.redraws} redraws for ${pf.events} events`);
    check('a slider drag does not write to disk on every event',
        pf.writes > 0 && pf.writes < pf.events / 3,
        `${pf.writes} writes for ${pf.events} events`);
    check('the brush still ends up on the value the slider stopped at',
        pf.paramAfter === pf.settled, `${pf.paramAfter} vs slider ${pf.settled}`);

    const pf2 = JSON.parse(await page.eval(`(() => {
        const b = PaintApp.brush;
        /* Saved tweaks live in a write queue before they reach the store, so
         * clearing the store by hand is not enough to forget them. */
        b.loadPreset('Round');
        b.setParam('hardness', 33);
        const straightAfter = JSON.parse(localStorage.getItem('pb-saved-Round') || '{}').hardness;
        b.loadPreset('Thin Regular');
        b.loadPreset('Round');
        const kept = b.getParams().hardness;
        b.forgetSaved('Round');
        b.loadPreset('Round');
        const forgotten = b.getParams().hardness;
        return JSON.stringify({ straightAfter, kept, forgotten,
            dflt: b.PRESETS.Round.hardness });
    })()`));
    console.log('  ' + JSON.stringify(pf2));
    check('a tweak survives a trip to another brush and back',
        pf2.kept === 33, `came back as ${pf2.kept}`);
    check('...even though it has not reached the store yet',
        pf2.straightAfter !== 33,
        `it was written immediately (${pf2.straightAfter}), so nothing was batched`);
    check('forgetting a brush drops the queued write too',
        pf2.forgotten === pf2.dflt,
        `${pf2.forgotten}, expected the preset default ${pf2.dflt}`);

    /* ── what a stroke costs to start ─────────────────────────────────── */
    console.log('== stroke setup ==');
    const sc = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, app = PaintApp;
        const out = {};

        /* The flow buffer is only blanked where the last stroke left ink,
         * so a mistake there leaves the previous stroke sitting in it.
         *
         * It only shows where the NEXT stroke's dirty rectangle covers the
         * old ink, because a flush only composites its own rectangle. So the
         * second stroke is an L: its rectangle is the whole square it spans,
         * its ink runs along two edges, and the first stroke is drawn
         * through the empty middle. */
        const setup = () => {
            __B.doc(400, 240);
            b.loadPreset('Round');
            b.setParam('dynamicsMode', 'off'); b.setParam('scatter', 0);
            b.setParam('size', 14); b.setParam('hardness', 100);
            b.setParam('smoothingMode', 'none');
            return __B.layer();
        };
        const elStroke = async (L, colour) => {
            b.beginStroke(60, 40, 0.9, colour);
            for (let i = 1; i <= 20; i++) b.moveStroke(60 + 14 * i, 40, 0.9, colour);
            for (let i = 1; i <= 15; i++) b.moveStroke(340, 40 + 10 * i, 0.9, colour);
            b.endStroke();
            await new Promise(r => setTimeout(r, 200));
        };
        const L = setup();
        await __B.stroke(90, 130, 260, 130, '#ff0000');   // through the middle
        out.firstLanded = __B.px(L, 180, 130);
        L.ctx.clearRect(0, 0, 400, 240);                  // wipe it off the layer
        await elStroke(L, '#0000ff');
        out.ghostInside = __B.px(L, 180, 130);            // inside the L's rect
        out.elLanded = __B.px(L, 180, 40);                // on the L itself

        /* Same thing, but the second stroke is drawn before the first has
         * been wiped, so a stale buffer would double-composite instead. */
        const L1 = setup();
        await elStroke(L1, '#0000ff');
        L1.ctx.clearRect(0, 0, 400, 240);
        const L1b = L1;
        await __B.stroke(90, 130, 260, 130, '#ff0000');
        out.reverseGhost = __B.px(L1b, 180, 40);

        /* A swatch drives the same painter over its own little buffer. If it
         * leaves its bounds behind, the next real stroke blanks a tile-sized
         * corner and the one before it ghosts back. */
        __B.doc(400, 200);
        b.loadPreset('Round');
        b.setParam('dynamicsMode', 'off'); b.setParam('scatter', 0);
        b.setParam('size', 16); b.setParam('hardness', 100);
        const L2 = __B.layer();
        await __B.stroke(40, 60, 100, 60, '#ff0000');
        b.generatePreview('Fan Brush');
        b.generatePreview('Glaze Textured');
        L2.ctx.clearRect(0, 0, 400, 200);
        await __B.stroke(280, 140, 340, 140, '#0000ff');
        out.afterSwatch = { ghost: __B.px(L2, 70, 60), real: __B.px(L2, 310, 140) };

        /* Only a brush that mixes with the canvas needs the layer read back.
         * Both still have to paint the same thing they always did. */
        __B.doc(400, 200);
        b.loadPreset('Round');
        b.setParam('dynamicsMode', 'off'); b.setParam('scatter', 0);
        b.setParam('size', 16); b.setParam('hardness', 100);
        const L3 = __B.layer();
        L3.ctx.fillStyle = '#ff0000';
        L3.ctx.fillRect(0, 0, 200, 200);
        await __B.stroke(20, 100, 380, 100, '#0000ff');
        out.plainOverInk = __B.px(L3, 100, 100);

        __B.doc(400, 200);
        const L4 = __B.layer();
        L4.ctx.fillStyle = '#ff0000';
        L4.ctx.fillRect(0, 0, 200, 200);
        b.loadPreset('Smudge');
        b.setParam('dynamicsMode', 'off'); b.setParam('scatter', 0);
        await __B.stroke(20, 100, 380, 100, '#00ff00');
        out.smudgeCarries = __B.px(L4, 240, 100);

        /* Colour variation. Four of the brush formats we read ask for it,
         * and the engine had none -- so four readers had to report it lost.
         * The wobble has to be real, and it has to be repeatable: it comes
         * off the same per-position hash as scatter, so the same stroke with
         * the same seed has to redraw the same speckle. */
        function jitterStrip() {
            __B.doc(400, 200);
            b.loadPreset('Round');
            b.setParam('dynamicsMode', 'off'); b.setParam('scatter', 0);
            b.setParam('size', 10); b.setParam('hardness', 100);
            b.setParam('spacing', 30);
            b.setParam('hueJitter', 60); b.setParam('satJitter', 0); b.setParam('valJitter', 0);
            b._setStrokeSeed(12345);
            return __B.layer();
        }
        const LJ = jitterStrip();
        await __B.stroke(20, 100, 380, 100, '#808000');
        out.jitterA = __B.hash(LJ);
        out.jitterPix = [__B.px(LJ, 60, 100), __B.px(LJ, 200, 100), __B.px(LJ, 340, 100)];

        const LJ2 = jitterStrip();
        await __B.stroke(20, 100, 380, 100, '#808000');
        out.jitterB = __B.hash(LJ2);

        const LJ3 = jitterStrip();
        b.setParam('hueJitter', 0);
        await __B.stroke(20, 100, 380, 100, '#808000');
        out.plainPix = [__B.px(LJ3, 60, 100), __B.px(LJ3, 200, 100), __B.px(LJ3, 340, 100)];

        /* Clip Studio's colour change: each dab lands evenly between two
         * ends cut at black and white. Glitter (value 100 from floor -10,
         * saturation 50) on black paints greys from black to white in Clip
         * Studio; clamped the other way, half its dabs stayed black and the
         * saturation tinted the rest. */
        const LC = jitterStrip();
        b.setParam('hueJitter', 15); b.setParam('satJitter', 50); b.setParam('valJitter', 100);
        b.setParam('colorJitterRange', [[-1, 1], [-1, 1], [-0.1, 1]]);
        await __B.stroke(20, 100, 380, 100, '#000000');
        out.cspDabs = [];
        for (let x = 30; x < 370; x += 3) out.cspDabs.push(__B.px(LC, x, 100));
        b.setParam('colorJitterRange', null);
        b._setStrokeSeed(null);

        /* Clip Studio's second brush lays its dabs in turn with the first's
         * (cdp-csp/wb): a 40px brush moving on fills back in what a 10px cut
         * took, so only the stroke's end stays cut; laid under, a wider
         * second brush widens the stroke. */
        /* Clip Studio's spray bias moves its particles to the rim (-100: a
         * ring) or the middle (+100) of the patch (cdp-csp/sb): the share
         * of the ink in the middle 60px of a 200px patch's stroke. At 100 the
         * distance thins evenly to the rim (cdp-csp/qg): 0.69 here, where
         * r(1 - r)^2 gave 0.63. */
        out.bias = [];
        for (const bias of [-100, 0, 100]) {
            __B.doc(400, 300);
            b.loadPreset('Round');
            b.setParam('dynamicsMode', 'off'); b.setParam('size', 4); b.setParam('hardness', 100);
            b.setParam('scatter', 2500); b.setParam('scatterAxis', 'disk'); b.setParam('dabCount', 16);
            b.setParam('spacing', 100); b.setParam('sprayBias', bias);
            b._setStrokeSeed(3);
            const LB = __B.layer();
            await __B.stroke(40, 150, 360, 150, '#000000');
            const d = LB.ctx.getImageData(0, 0, 400, 300).data;
            let mid = 0, all = 0;
            for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) {
                const a = d[(y * 400 + x) * 4 + 3]; all += a; if (Math.abs(y - 150) < 30) mid += a;
            }
            out.bias.push(+(mid / Math.max(1, all)).toFixed(3));
        }
        /* Thin particles on a ring round one stop: pointing away from the
         * centre, their ink spreads along the radius; lying level, only the
         * ones at the sides do. */
        out.radial = [];
        for (const src of ['radial', 'none']) {
            __B.doc(400, 300);
            b.loadPreset('Round');
            b.setParam('dynamicsMode', 'off'); b.setParam('size', 40); b.setParam('hardness', 100);
            b.setParam('aspectRatio', 8); b.setParam('angle', 0); b.setParam('angleSrc', src); b.setParam('sprayEach', true);
            b.setParam('scatter', 200); b.setParam('scatterAxis', 'disk'); b.setParam('dabCount', 16); b.setParam('sprayBias', -100);
            b._setStrokeSeed(3);
            const LR = __B.layer();
            await __B.stroke(200, 150, 201, 150, '#000000');
            const d = LR.ctx.getImageData(0, 0, 400, 300).data;
            let s = 0, s1 = 0, s2 = 0;
            for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) {
                const a = d[(y * 400 + x) * 4 + 3], r = Math.hypot(x - 200, y - 150); s += a; s1 += a * r; s2 += a * r * r;
            }
            out.radial.push(+Math.sqrt(s2 / s - (s1 / s) ** 2).toFixed(1));
        }
        b.setParam('sprayBias', 0); b.setParam('sprayEach', false); b.setParam('aspectRatio', 1); b.setParam('angleSrc', 'none'); b._setStrokeSeed(null);

        /* A thin tip turned to lie along the line, spaced by its own width
         * (Clip Studio's pictures on auto spacing) lays four times the dabs,
         * which build up to half as much ink again at this flow. */
        out.byWidth = [];
        for (const on of [true, false]) {
            __B.doc(300, 100);
            b.loadPreset('Round');
            b.setParam('dynamicsMode', 'off'); b.setParam('scatter', 0); b.setParam('size', 40); b.setParam('hardness', 100);
            b.setParam('aspectRatio', 0.25); b.setParam('angle', 90); b.setParam('spacing', 50); b.setParam('flow', 5);
            b.setParam('spacingIsotropic', false); b.setParam('spacingByWidth', on);
            const LW = __B.layer();
            await __B.stroke(50, 50, 250, 50, '#000000');
            const d = LW.ctx.getImageData(0, 0, 300, 100).data;
            let s = 0; for (let i = 3; i < d.length; i += 4) s += d[i];
            out.byWidth.push(s);
        }
        b.setParam('spacingByWidth', false); b.setParam('aspectRatio', 1); b.setParam('angle', 0); b.setParam('flow', 100);

        __B.doc(200, 100);
        b.loadPreset('Round');
        b.setParam('dynamicsMode', 'off'); b.setParam('scatter', 0); b.setParam('size', 30); b.setParam('hardness', 100); b.setParam('subMix', 50);
        ['hueJitter', 'satJitter', 'valJitter', 'dabCount', 'scatterAxis'].forEach(k => b.setParam(k, b.DEFAULTS[k]));   // left by the tests above
        const LM = __B.layer();
        await __B.stroke(50, 50, 150, 50, '#000000');
        out.subMix = __B.px(LM, 100, 50);
        b.setParam('subMix', 0);

        // a dab cutting by lightness (Clip Studio's mode 2 second brush) is as strong as its colour is light
        out.cutLight = [];
        for (const col of ['#ffffff', '#000000']) {
            const LC = __B.doc();
            b.setParam('dynamicsMode', 'off'); b.setParam('size', 30); b.setParam('hardness', 100); b.setParam('cutByLight', true);
            await __B.stroke(50, 50, 150, 50, col);
            out.cutLight.push(+__B.px(LC, 100, 50).split(',')[3]);
        }
        b.setParam('cutByLight', false);

        // dabs laid by darken (Clip Studio's Soft bleed) hold their flow, anti-aliased or not
        out.dabMax = [];
        for (const [max, aliased] of [[false, false], [true, false], [true, true]]) {
            const LD = __B.doc();
            b.setParam('dynamicsMode', 'off'); b.setParam('size', 30); b.setParam('hardness', 100); b.setParam('flow', 50); b.setParam('flowSrc', 'none');
            b.setParam('dabMax', max); b.setParam('aliased', aliased);
            await __B.stroke(50, 50, 150, 50, '#000000');
            out.dabMax.push(+__B.px(LD, 100, 50).split(',')[3]);
        }
        b.setParam('dabMax', false); b.setParam('aliased', false); b.setParam('flow', 100); b.setParam('flowSrc', b.DEFAULTS.flowSrc);

        out.second = {};
        for (const [op, sz, main, flow] of [['destination-out', 10, 40, 100], ['destination-over', 40, 20, 100], ['subtract', 40, 40, 10], ['min', 10, 40, 100]]) {
            __B.doc(400, 200);
            b.PRESETS.Round.second = { op, p: { size: sz, flow, spacing: 10, hardness: 100 } };
            b.loadPreset('Round');
            b.setParam('dynamicsMode', 'off'); b.setParam('scatter', 0);
            b.setParam('size', main); b.setParam('hardness', 100); b.setParam('spacing', 10);
            const L2 = __B.layer();
            await __B.stroke(20, 100, 380, 100, '#000000');
            out.second[op] = [__B.px(L2, 200, 100), __B.px(L2, 380, 100), __B.px(L2, 200, 116)].map(s => +s.split(',')[3]);
            delete b.PRESETS.Round.second;
        }
        // Clip Studio's cut: a solid line under a solid cut stays solid, a faint isolated dab goes
        out.cut = [];
        for (const [flow, spacing] of [[100, 10], [20, 400]]) {
            __B.doc(400, 200);
            b.PRESETS.Round.second = { op: 'cut', p: { size: 10, flow: 100, spacing: 10, hardness: 100 } };
            b.loadPreset('Round');
            b.setParam('dynamicsMode', 'off'); b.setParam('scatter', 0);
            b.setParam('size', 40); b.setParam('hardness', 100); b.setParam('spacing', spacing); b.setParam('flow', flow);
            const L3 = __B.layer();
            await __B.stroke(20, 100, 380, 100, '#000000');
            const x = flow === 100 ? 380 : 20;
            out.cut.push([__B.px(L3, x, 100), __B.px(L3, x, 115)].map(s => +s.split(',')[3]));
            delete b.PRESETS.Round.second;
        }
        b.setParam('flow', 100);

        b.loadPreset('Round');
        return JSON.stringify(out);
    })()`));
    console.log('  ' + JSON.stringify(sc));

    /* Even over the disk, the middle 60px holds about 38% of the ink; a
     * ring leaves it about 20%, a centre-heavy spray about 55%. */
    check('a tip spaced by its own width lays its dabs by that width, not its length along the line',
        sc.byWidth[0] > sc.byWidth[1] * 1.3, JSON.stringify(sc.byWidth));
    /* Clip Studio's sub colour mix takes each dab that far toward white
     * (Generic Flower's black flowers paint grey). */
    check('a dab that cuts by its lightness is whole in white and nothing in black',
        sc.cutLight[0] > 245 && sc.cutLight[1] === 0, JSON.stringify(sc.cutLight));
    check('a sub colour mix of half paints black as mid grey',
        Math.abs(parseInt(sc.subMix) - 128) < 3, sc.subMix);
    check('a Clip Studio spray can point each particle away from its patch centre',
        sc.radial[0] > sc.radial[1] * 1.15, JSON.stringify(sc.radial));
    check('a Clip Studio spray bias moves particles to the rim or the middle',
        sc.bias[0] < sc.bias[1] * 0.75 && sc.bias[2] > 0.67, JSON.stringify(sc.bias));
    check('a Clip Studio second brush cuts in turn with the first: filled back in mid-stroke, cut at the end',
        sc.second['destination-out'][0] > 200 && sc.second['destination-out'][1] < 64, JSON.stringify(sc.second));
    check('a Clip Studio cut leaves a solid stroke solid and takes a faint dab by its own alpha',
        sc.cut[0][0] > 250 && sc.cut[0][1] > 250 && sc.cut[1][0] < 4 && sc.cut[1][1] > 40, JSON.stringify(sc.cut));
    check('...and one laid under a narrower first brush widens the stroke',
        sc.second['destination-over'][0] === 255 && sc.second['destination-over'][2] === 255, JSON.stringify(sc.second));
    /* Clip Studio's mode 3 (Dappled light): the second is a whole stroke taken
     * off the first, not a dab at a time that the first fills back in. Ten
     * 10% dabs over a point leave about a third of solid ink. */
    check('dabs laid by darken hold the flow instead of piling up, and anti-aliasing off keeps it',
        sc.dabMax[0] > 160 && Math.abs(sc.dabMax[1] - 128) <= 2 && Math.abs(sc.dabMax[2] - 128) <= 2, JSON.stringify(sc.dabMax));
    check('...and one that subtracts takes its whole stroke off the finished first',
        sc.second.subtract[0] > 60 && sc.second.subtract[0] < 120, JSON.stringify(sc.second));

    /* Mode 4 with the colour change off (Watercolor splash): a mask, ink
     * only where both strokes are. */
    check('...and one that masks keeps the first only where the second lies too',
        sc.second.min[0] === 255 && sc.second.min[2] === 0, JSON.stringify(sc.second));

    const clear = '0,0,0,0';
    check('the previous stroke does not ghost back into the next',
        sc.firstLanded !== clear && sc.ghostInside === clear,
        `first stroke ${sc.firstLanded}, ghost left behind ${sc.ghostInside}`);
    check('...and the new stroke still lands',
        sc.elLanded !== clear, `the L came out ${sc.elLanded}`);
    check('nor the other way round',
        sc.reverseGhost === clear, `ghost ${sc.reverseGhost}`);
    check('drawing a swatch in between does not ghost either',
        sc.afterSwatch.ghost === clear && sc.afterSwatch.real !== clear,
        `ghost ${sc.afterSwatch.ghost}, stroke ${sc.afterSwatch.real}`);
    check('a plain brush paints its own colour over what is there',
        sc.plainOverInk === '0,0,255,255', sc.plainOverInk);
    check('a smudge brush still picks colour up off the canvas',
        Number(sc.smudgeCarries.split(',')[0]) > 60,
        `carried ${sc.smudgeCarries}`);
    check('colour jitter really varies the colour along a stroke',
        new Set(sc.jitterPix).size === 3, sc.jitterPix.join(' | '));
    /* Within one level: sample points sit at different dab-overlap counts,
     * and a translucent pixel's colour rounds differently at each. */
    check('...and with it off the stroke is one colour',
        sc.plainPix.every(s => s.split(',').slice(0, 3).every((v, i) =>
            Math.abs(v - sc.plainPix[0].split(',')[i]) <= 1)), sc.plainPix.join(' | '));
    check('...and the same stroke on the same seed comes out the same',
        sc.jitterA === sc.jitterB, `${sc.jitterA} vs ${sc.jitterB}`);
    {
        const g = sc.cspDabs.map(s => s.split(',').map(Number));
        const black = g.filter(p => p[0] + p[1] + p[2] < 8).length / g.length;
        check('a Clip Studio colour change spreads black into greys, not half of them black',
            black < 0.15 && g.some(p => p[0] > 200), `${Math.round(black * 100)}% black`);
        check('...and a grey takes no tint from its saturation change',
            g.every(p => Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]) <= 2), sc.cspDabs.slice(0, 8).join(' | '));
    }

    /* Spacing, as Krita's effectiveSpacing does it. Each case is a hard
     * stroke that Krita paints unbroken; count bare pixels down its middle. */
    const gaps = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        const run = async (set, x0, y0, x1, y1, pr) => {
            __B.doc(200, 200);
            ['sizeSrc','sizeMin','sizeCurve','flowSrc','angleSrc','aspectRatio','angle','autoSpacing',
             'spacingIsotropic','taperStart','taperEnd','smoothingMode']
                .forEach(k => b.setParam(k, b.DEFAULTS[k]));
            b.setParam('hardness', 100); b.setParam('flowSrc', 'none');
            set();
            const L = __B.layer();
            b.beginStroke(x0, y0, pr, '#000000');
            for (let i = 1; i <= 40; i++)
                b.moveStroke(x0 + (x1 - x0) * i / 40, y0 + (y1 - y0) * i / 40, pr, '#000000');
            b.endStroke();
            await new Promise(r => setTimeout(r, 150));
            let bare = 0;
            for (let i = 10; i <= 30; i++) {
                const x = Math.round(x0 + (x1 - x0) * i / 40), y = Math.round(y0 + (y1 - y0) * i / 40);
                if (L.ctx.getImageData(x, y, 1, 1).data[3] < 128) bare++;
            }
            return bare;
        };
        const out = {};
        // Light pressure on a pressure-sized brush: a 10px dab spaced for 40.
        out.pressure = await run(() => { b.setParam('size', 40); b.setParam('spacing', 50);
            b.setParam('sizeSrc', 'pressure'); b.setParam('sizeMin', 0); b.setParam('sizeCurve', 1); },
            20, 100, 180, 100, 0.25);
        // A 5:1 flat tip dragged across its thin side.
        out.flat = await run(() => { b.setParam('size', 50); b.setParam('spacing', 40);
            b.setParam('sizeSrc', 'none'); b.setParam('aspectRatio', 5); b.setParam('angle', 0); },
            100, 20, 100, 180, 1);
        // Auto spacing: 1 x sqrt(4) = 2px between 4px dabs, not 25% of 4.
        out.auto = await run(() => { b.setParam('size', 4); b.setParam('spacing', 400);
            b.setParam('sizeSrc', 'none'); b.setParam('autoSpacing', 1); },
            20, 100, 180, 100, 1);
        b.loadPreset('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    check('spacing follows the pressure-scaled dab, so a light stroke does not bead',
        gaps.pressure === 0, `${gaps.pressure} bare px`);
    check('a flat tip is spaced by its thin side when dragged across it',
        gaps.flat === 0, `${gaps.flat} bare px`);
    check('auto spacing is coeff * sqrt(size) and overrides the percentage',
        gaps.auto === 0, `${gaps.auto} bare px`);
    console.log('== Krita inputs: fade, locked angle, turned ovals ==');
    const kr = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        // Inked rows down each column of one horizontal stroke.
        const run = async (set, x0, y0, x1, cols) => {
            __B.doc(200, 200);
            ['sizeSrc','sizeMin','sizeCurve','flowSrc','angleSrc','aspectRatio','angle','fadeSteps',
             'angleLocked','sizeSensors','falloff','shape','spacing','taperStart','taperEnd','smoothingMode']
                .forEach(k => b.setParam(k, b.DEFAULTS[k]));
            b.setParam('hardness', 100); b.setParam('flowSrc', 'none');
            set();
            const L = __B.layer();
            b.beginStroke(x0, y0, 1, '#000000');
            for (let i = 1; i <= 40; i++) b.moveStroke(x0 + (x1 - x0) * i / 40, y0, 1, '#000000');
            b.endStroke();
            await new Promise(r => setTimeout(r, 150));
            return cols.map(x => { let n = 0;
                for (let y = 0; y < 200; y++) if (L.ctx.getImageData(x, y, 1, 1).data[3] >= 128) n++;
                return n; });
        };
        const oval = () => { b.setParam('falloff', 'krita'); b.setParam('shape', 'circle');
            b.setParam('size', 30); b.setParam('aspectRatio', 2); b.setParam('spacing', 5); };
        const out = {};
        // Turned a quarter, the oval's long axis stands across the stroke.
        out.turned = await run(() => { oval(); b.setParam('angle', 90); }, 40, 100, 160, [100]);
        // Krita's fade grows 0 -> 1 over fadeSteps dabs, then holds.
        out.fade = await run(() => { b.setParam('size', 30); b.setParam('spacing', 5);
            b.setParam('sizeSrc', 'fadein'); b.setParam('sizeMin', 0); b.setParam('sizeCurve', 1);
            b.setParam('fadeSteps', 40); }, 20, 100, 180, [25, 170]);
        // Locked: the first dab's angle, measured from the canvas origin (45 degrees here).
        out.free = await run(() => { oval(); b.setParam('aspectRatio', 3); b.setParam('angleSrc', 'direction'); }, 100, 100, 180, [150]);
        out.locked = await run(() => { oval(); b.setParam('aspectRatio', 3); b.setParam('angleSrc', 'direction');
            b.setParam('angleLocked', true); }, 100, 100, 180, [150]);
        // Unlocked too, Krita's first dab is turned by the angle from the origin (Lace).
        const first = async (origin) => {
            __B.doc(200, 200);
            ['sizeSrc','flowSrc','angle','angleLocked','sizeSensors','spacing','taperStart','taperEnd','smoothingMode']
                .forEach(k => b.setParam(k, b.DEFAULTS[k]));
            oval(); b.setParam('size', 40); b.setParam('aspectRatio', 6); b.setParam('angleSrc', 'direction');
            b.setParam('originAngle', origin);
            b.beginStroke(100, 100, 1, '#000000'); b.endStroke();
            await new Promise(r => setTimeout(r, 150));
            const d = __B.layer().ctx.getImageData(112, 0, 1, 200).data;
            let top = -1; for (let y = 0; y < 200 && top < 0; y++) if (d[y * 4 + 3] >= 128) top = y;
            return top;
        };
        out.firstFlat = await first(false);
        out.firstTurned = await first(true);
        // ...and its ellipse spaces the second dab: turned 45 degrees, 27px on, not 60,
        // so the gap at 122 between the first dab and the next one fills.
        const reach = async (origin) => {
            __B.doc(200, 200);
            ['sizeSrc','flowSrc','angle','angleLocked','sizeSensors','taperStart','taperEnd','smoothingMode','autoSpacing']
                .forEach(k => b.setParam(k, b.DEFAULTS[k]));
            oval(); b.setParam('aspectRatio', 3); b.setParam('spacing', 200); b.setParam('angleSrc', 'direction');
            b.setParam('originAngle', origin);
            b.beginStroke(100, 100, 1, '#000000');
            for (let i = 1; i <= 50; i++) b.moveStroke(100 + i, 100, 1, '#000000');
            b.endStroke();
            await new Promise(r => setTimeout(r, 150));
            const d = __B.layer().ctx.getImageData(0, 100, 200, 1).data;
            return d[122 * 4 + 3];
        };
        out.reachPlain = await reach(false);
        out.reachOrigin = await reach(true);
        b.setParam('originAngle', false);
        b.loadPreset('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify(kr));
    check('a Krita oval turned upright is not clipped to its unturned height',
        kr.turned[0] >= 27, `${kr.turned[0]} rows, want ~30`);
    check("Krita's fade grows a stroke from nothing rather than shrinking it",
        kr.fade[0] < kr.fade[1] / 2 && kr.fade[1] >= 27, kr.fade.join(' -> '));
    check("a locked drawing angle holds the first dab's turn, measured from the origin",
        kr.free[0] <= 12 && kr.locked[0] >= 18, `free ${kr.free[0]}, locked ${kr.locked[0]}`);
    check("...and unlocked, Krita's first dab still turns by the angle from the origin",
        kr.firstFlat >= 95 && kr.firstFlat <= 99 && kr.firstTurned >= 105, `flat ${kr.firstFlat}, turned ${kr.firstTurned}`);
    check("...and the second dab is spaced by that first dab's turned ellipse",
        kr.reachPlain === 0 && kr.reachOrigin >= 128, `alpha at 122: plain ${kr.reachPlain}, origin ${kr.reachOrigin}`);

    // Clip Studio's watercolour edge (cdp-csp/we): power 5, radius 10 on a 40% stroke adds
    // 0.5 * (11 - D) / 11 of full alpha D px in, over the opacity, not under it.
    const we = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        b.forgetSaved('Round');
        __B.doc(200, 200);
        b.setParam('size', 60); b.setParam('hardness', 100); b.setParam('flowSrc', 'none'); b.setParam('sizeSrc', 'none');
        b.setParam('opacity', 40); b.setParam('edgeWidth', 10); b.setParam('edgeDensity', 5); b.setParam('edgeAdd', true);
        b.beginStroke(50, 100, 1, '#000000');
        for (let i = 1; i <= 100; i++) b.moveStroke(50 + i, 100, 1, '#000000');
        b.endStroke();
        await new Promise(r => setTimeout(r, 150));
        const d = __B.layer().ctx.getImageData(100, 0, 1, 200).data;
        let top = 0; while (top < 200 && !d[top * 4 + 3]) top++;
        const col = [...Array(14)].map((_, i) => d[(top + i) * 4 + 3]);
        b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify({ col, mid: d[100 * 4 + 3] });
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify(we));
    const weAdd = D => Math.round(127.5 * (11 - D) / 11);
    check("a Clip Studio watercolour edge adds power/10 at the rim, falling straight to nothing at its radius",
        Math.abs(we.mid - 102) <= 2 && [1, 3, 5, 7].every(i => Math.abs(we.col[i] - we.mid - weAdd(i + 1)) <= 6) && Math.abs(we.col[12] - we.mid) <= 2,
        `rows from the top ${we.col.join(' ')}, middle ${we.mid}; want +${[2, 4, 6, 8].map(weAdd).join(' +')} on rows 1 3 5 7`);

    // ...and its tone takes value off the colour, the same levels whatever the colour (cdp-csp/kv: 97 -> 13 and 55, 18px in)
    const wt = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, out = {};
        for (const v of [0, 50, 100]) {
            b.forgetSaved('Round');
            __B.doc(200, 200);
            b.setParam('size', 100); b.setParam('hardness', 100); b.setParam('flowSrc', 'none'); b.setParam('sizeSrc', 'none');
            b.setParam('edgeWidth', 20); b.setParam('edgeDensity', 50); b.setParam('edgeAdd', true); b.setParam('edgeValue', v);
            b.beginStroke(100, 100, 1, '#616161'); b.endStroke();
            await new Promise(r => setTimeout(r, 150));
            const d = __B.layer().ctx.getImageData(100, 0, 1, 200).data;
            let top = 0; while (top < 200 && !d[top * 4 + 3]) top++;
            out[v] = [d[(top + 17) * 4], d[100 * 4]];
        }
        b.setParam('edgeValue', 0); b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    check("a Clip Studio watercolour edge's tone darkens an opaque stroke's rim, not its middle",
        wt[0][0] === 97 && Math.abs(wt[50][0] - 55) <= 6 && Math.abs(wt[100][0] - 13) <= 6 && wt[100][1] === 97,
        JSON.stringify(wt));

    // Clip Studio's fixed interval is a share of the size however the tip is turned (cdp-csp/kw: WC Generic Flower at 291 degrees).
    const sbs = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush, out = [];
        for (const on of [false, true]) {
            b.forgetSaved('Round');
            __B.doc(500, 200);
            b.setParam('size', 20); b.setParam('hardness', 100); b.setParam('flowSrc', 'none'); b.setParam('sizeSrc', 'none');
            b.setParam('spacing', 200); b.setParam('angle', 45); b.setParam('spacingBySize', on);
            b.beginStroke(50, 100, 1, '#000000');
            for (let i = 1; i <= 80; i++) b.moveStroke(50 + 5 * i, 100, 1, '#000000');
            b.endStroke();
            await new Promise(r => setTimeout(r, 150));
            const d = __B.layer().ctx.getImageData(0, 100, 500, 1).data;
            let n = 0; for (let x = 1; x < 500; x++) if (d[x * 4 + 3] && !d[x * 4 - 1]) n++;
            out.push(n);
        }
        b.setParam('spacingBySize', false); b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    check('a turned tip spaced by its size stops every share of the size, not of its turned box',
        sbs[1] >= 10 && sbs[1] > sbs[0], `dabs over 400px at 40px: turned box ${sbs[0]}, by size ${sbs[1]}`);

    // 200 steps of 0.8px sum to a hair past 160 in floats: the dab on the pen must still land.
    const pe = JSON.parse(await page.eval(`(async () => {
        const b = PaintApp.brush;
        b.forgetSaved('Round');
        __B.doc(200, 200);
        b.setParam('size', 20); b.setParam('spacing', 4); b.setParam('hardness', 100);
        b.setParam('flowSrc', 'none'); b.setParam('sizeSrc', 'none'); b.setParam('smoothingMode', 'none');
        b.beginStroke(20, 100, 1, '#000000');
        for (let i = 1; i <= 70; i++) b.moveStroke(20 + 160 * i / 70, 100, 1, '#000000');
        b.endStroke();
        await new Promise(r => setTimeout(r, 150));
        const d = __B.layer().ctx.getImageData(0, 100, 200, 1).data;
        b.forgetSaved('Round'); b.loadPreset('Round');
        return JSON.stringify({ start: d[10 * 4 + 3], end: d[189 * 4 + 3] });
    })()`, { awaitPromise: true }));
    check('a stroke reaches as far past the pen-up as past the pen-down',
        Math.abs(pe.end - pe.start) <= 8, `alpha a radius before the start ${pe.start}, after the end ${pe.end}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
