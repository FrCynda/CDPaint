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
        await settle();
        const drawnAtRest = [...grid.querySelectorAll('.pb-brush-tile')]
            .filter(t => t.querySelector('canvas')).length;
        const total = grid.querySelectorAll('.pb-brush-tile').length;
        // Scroll each of Charcoal's two tiles into view and let it draw.
        const inked = [];
        for (const t of mine) {
            grid.scrollTop = t.offsetTop - grid.offsetTop - 20;
            await settle();
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
        const line = async (set, vertical) => {
            __B.doc(400, 400);
            ['colorRate', 'texture', 'opacity', 'flow', 'aspectRatio', 'shape',
             'tipCells', 'bristleCount', 'sizeSrc', 'sizeMin', 'scatter',
             'scatterAxis', 'dabCount', 'offsetAlong', 'offsetAcross', 'offsetSrc',
             'smoothingMode', 'taperStart', 'taperEnd', 'flowSrc', 'angleSrc']
                .forEach(k => b.setParam(k, b.DEFAULTS[k]));
            b.setParam('dynamicsMode', 'off');
            b.setParam('size', 20); b.setParam('hardness', 100);
            b.setParam('spacing', 40); b.setParam('sizeSrc', 'none');
            b._setStrokeSeed(4242);
            set(b);
            const L = __B.layer();
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
        const url = c.toDataURL('image/png');
        const run = async (mode) => {
            __B.doc(200, 200);
            b.loadCustomTip(url, null);
            await new Promise(r => setTimeout(r, 400));
            ['texture', 'opacity', 'flow', 'scatter', 'colorRate', 'sizeSrc',
             'taperStart', 'taperEnd', 'tip2Depth'].forEach(k => b.setParam(k, b.DEFAULTS[k]));
            b.setParam('dynamicsMode', 'off');
            b.setParam('size', 80); b.setParam('hardness', 100);
            b.setParam('tipMode', mode);
            const L = __B.layer();
            b.beginStroke(100, 100, 1, '#808080');
            b.endStroke();
            await new Promise(r => setTimeout(r, 200));
            return { left: __B.px(L, 80, 100), right: __B.px(L, 120, 100) };
        };
        const out = { alpha: await run('alpha'), light: await run('lightness'),
                      color: await run('color') };
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
        b._setStrokeSeed(null);

        b.loadPreset('Round');
        return JSON.stringify(out);
    })()`));
    console.log('  ' + JSON.stringify(sc));

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
    check('...and with it off the stroke is one colour',
        new Set(sc.plainPix).size === 1, sc.plainPix.join(' | '));
    check('...and the same stroke on the same seed comes out the same',
        sc.jitterA === sc.jitterB, `${sc.jitterA} vs ${sc.jitterB}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
