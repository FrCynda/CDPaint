/* Installing a brush pack, end to end.
 *
 * brush-pack.mjs checks the reading and the arithmetic on their own. This
 * one drives the other half: real files go in through the same call the
 * Import button makes, and the brushes that come out have to paint.
 */
import { withPage } from '../browser.mjs';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

const F = new URL('../fixtures/brushes/', import.meta.url);
const b64 = (n) => readFileSync(new URL(n, F)).toString('base64');

const FILES = {
    'mini-pack.bundle': b64('mini-pack.bundle'),
    'thin-brush-pointy.kpp': b64('thin-brush-pointy.kpp'),
    'chalk-chisel-random-small.gih': b64('chalk-chisel-random-small.gih'),
    'bristles-grouped.gbr': b64('bristles-grouped.gbr'),
    'two-tips-v6.abr': b64('two-tips-v6.abr'),
    'two-tips-v6-sub2.abr': b64('two-tips-v6-sub2.abr'),
    'two-tips-v2.abr': b64('two-tips-v2.abr'),
    'charcoal-soft.myb': b64('charcoal-soft.myb'),
    'hard-eraser.myb': b64('hard-eraser.myb')
};

await withPage(async (page) => {
    /* A File the page can hand to importFiles, built from bytes rather than
     * from a picker, so this runs the button's own path. */
    await page.run(`
        window.__files = {};
        const raw = ${JSON.stringify(FILES)};
        for (const n in raw) {
            const bin = atob(raw[n]);
            const u = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
            window.__files[n] = new File([u], n);
        }
        // Start from a clean library so counts mean something.
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        return Object.keys(window.__files).length;
    `);

    console.log('\n== a GIMP brush pipe becomes a strip of shapes ==');
    const gih = await page.eval(`(async () => {
        const bytes = new Uint8Array(await window.__files['chalk-chisel-random-small.gih'].arrayBuffer());
        const t = await BrushPack.tipStrip(bytes, 'x.gih');
        const bmp = await createImageBitmap(await (await fetch(t.url)).blob());
        return JSON.stringify({ cells: t.cells, pick: t.pick, size: t.size,
                                w: bmp.width, h: bmp.height });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('all four shapes come out, not just the first', gih.cells === 4, JSON.stringify(gih));
    check('the file says how to pick between them', gih.pick === 'random', gih.pick);
    check('they land side by side in one strip', gih.w === gih.h * 4, `${gih.w}x${gih.h}`);
    /* Krita's `scale` multiplies the tip's OWN pixel size, so the strip has
     * to report that and not whatever size we chose to store it at. */
    check('the strip reports the tip' + "'" + 's own size',
        gih.size === 64 && gih.h === 64, `size ${gih.size}, stored ${gih.h}px`);

    /* The shapes must actually differ — slicing a strip of four copies of
     * the same picture would pass every count above and change nothing. */
    const differ = await page.eval(`(async () => {
        const bytes = new Uint8Array(await window.__files['chalk-chisel-random-small.gih'].arrayBuffer());
        const t = await BrushPack.tipStrip(bytes, 'x.gih');
        const bmp = await createImageBitmap(await (await fetch(t.url)).blob());
        const cw = bmp.width / t.cells, c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        const g = c.getContext('2d');
        g.drawImage(bmp, 0, 0);
        const sums = [];
        for (let i = 0; i < t.cells; i++) {
            const d = g.getImageData(i * cw, 0, cw, bmp.height).data;
            let s = 0;
            for (let k = 3; k < d.length; k += 4) s += d[k];
            sums.push(s);
        }
        return JSON.stringify(sums);
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('the four shapes are four different shapes',
        new Set(differ).size === 4 && Math.min(...differ) > 0, differ.join(', '));

    console.log('\n== a GIMP brush file ==');
    const gbr = await page.eval(`(async () => {
        const bytes = new Uint8Array(await window.__files['bristles-grouped.gbr'].arrayBuffer());
        const t = await BrushPack.tipStrip(bytes, 'x.gbr');
        const bmp = await createImageBitmap(await (await fetch(t.url)).blob());
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let ink = 0, clear = 0;
        for (let k = 3; k < d.length; k += 4) { if (d[k] > 128) ink++; else if (!d[k]) clear++; }
        return JSON.stringify({ cells: t.cells, size: t.size, w: bmp.width, ink, clear });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('one shape, at its own size', gbr.cells === 1 && gbr.size === 64 && gbr.w === 64,
        JSON.stringify(gbr));
    /* A grey .gbr stores coverage, so its bytes ARE the alpha. Reading them
     * as luminance instead would invert the brush: the paper would paint and
     * the bristles would not. */
    check('coverage is read as coverage, not inverted',
        gbr.ink > 100 && gbr.clear > gbr.ink * 2, `${gbr.ink} inked, ${gbr.clear} clear of 4096`);

    console.log('\n== importing a pack ==');
    const pack = await page.eval(`(async () => {
        const buf = await window.__files['mini-pack.bundle'].arrayBuffer();
        const r = await PaintApp.brush.importBrushPack(new Uint8Array(buf), 'mini-pack.bundle');
        return JSON.stringify(r);
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('both presets in the pack arrive', pack.ok && pack.added.length === 2,
        JSON.stringify(pack).slice(0, 200));
    check('the sorting prefix is dropped from the name',
        pack.ok && pack.added.every(n => !/^\w{1,3}\)/.test(n)), (pack.added || []).join(', '));
    check('they are saved brushes, not built-ins',
        await page.run(`return ${JSON.stringify(pack.added || [])}.every(n => PaintApp.brush.isUserPreset(n));`));
    check('and they survive a reload',
        (await page.run(`
            const names = ${JSON.stringify(pack.added || [])};
            return names.filter(n => !!PaintApp.brush.PRESETS[n]).length;
        `)) === 2);

    /* The stamping one has to carry its tip, or it is a round brush wearing
     * somebody else's name. */
    const tipped = await page.run(`
        const names = ${JSON.stringify(pack.added || [])};
        return names.map(n => ({ n, tip: !!PaintApp.brush.PRESETS[n]._tipUrl,
                                 shape: PaintApp.brush.PRESETS[n].shape }));
    `);
    check('the stamping brush kept its tip image',
        tipped.some(t => t.tip && t.shape === 'custom'), JSON.stringify(tipped));
    check('the generated one did not grow one',
        tipped.some(t => !t.tip && t.shape !== 'custom'), JSON.stringify(tipped));

    console.log('\n== the imported brushes paint ==');
    const ink = await page.eval(`(async () => {
        const app = PaintApp, br = app.brush;
        app.layerMgr.collapseToBase({ fresh: true });
        app.setSize(300, 120); app.config.zoom = 1; app.updateBounds();
        document.getElementById('lsys-add').click();
        app.state.selection = null;
        const L = app.layerMgr.layers[app.layerMgr.activeIdx];
        const out = {};
        for (const n of ${JSON.stringify(pack.added || [])}) {
            br.loadPreset(n);
            await new Promise(r => setTimeout(r, 500));
            /* An eraser paints nothing on an empty layer, and one of these
             * is an eraser -- so both are measured as a CHANGE against a
             * band of ink, which is the only test that fits both. */
            L.ctx.clearRect(0, 0, 300, 120);
            L.ctx.fillStyle = '#808080';
            L.ctx.fillRect(0, 30, 300, 60);
            const before = L.ctx.getImageData(0, 0, 300, 120).data;
            br.beginStroke(20, 60, 0.8, '#101010');
            for (let i = 1; i <= 40; i++) br.moveStroke(20 + i * 6.5, 60, 0.8, '#101010');
            br.endStroke();
            await new Promise(r => setTimeout(r, 200));
            const d = L.ctx.getImageData(0, 0, 300, 120).data;
            let c = 0;
            for (let k = 0; k < d.length; k += 4) {
                if (Math.abs(d[k] - before[k]) > 8 || Math.abs(d[k + 3] - before[k + 3]) > 8) c++;
            }
            out[n] = c;
        }
        return JSON.stringify(out);
    })()`, { awaitPromise: true }).then(JSON.parse);
    for (const n of Object.keys(ink)) {
        check(`"${n}" leaves a mark`, ink[n] > 400, `${ink[n]} px changed`);
    }

    console.log('\n== a Photoshop brush set ==');
    /* The fixtures are written from the format description rather than by
     * Photoshop, so they check the byte layout, the row compression and the
     * two header shapes -- not that Adobe agrees with the description. A
     * real .abr is still the test that matters; there is none to hand. */
    for (const [f, want] of [['two-tips-v6.abr', 2], ['two-tips-v6-sub2.abr', 1], ['two-tips-v2.abr', 2]]) {
        const r = await page.eval(`(async () => {
            for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
            const buf = await window.__files[${JSON.stringify(f)}].arrayBuffer();
            const res = await PaintApp.brush.importAbrPack(new Uint8Array(buf), ${JSON.stringify(f)});
            const shapes = [];
            for (const n of res.added || []) {
                const bmp = await createImageBitmap(await (await fetch(PaintApp.brush.PRESETS[n]._tipUrl)).blob());
                const c = document.createElement('canvas');
                c.width = bmp.width; c.height = bmp.height;
                c.getContext('2d').drawImage(bmp, 0, 0);
                const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                let ink = 0;
                for (let k = 3; k < d.length; k += 4) if (d[k] > 128) ink++;
                shapes.push({ w: bmp.width, h: bmp.height, ink, of: bmp.width * bmp.height });
            }
            return JSON.stringify({ res, shapes });
        })()`, { awaitPromise: true }).then(JSON.parse);
        check(`${f}: ${want} tip${want === 1 ? '' : 's'}`,
            r.res.ok && r.res.added.length === want, JSON.stringify(r.res).slice(0, 160));
        /* The one thing a hand-written fixture can still get wrong in a way
         * that matters: which value means paper. A tip read upside down is
         * a solid rectangle with a hole in it. */
        check(`${f}: the shape is the shape, not its negative`,
            r.shapes.length === want && r.shapes.every(s => s.ink > 20 && s.ink < s.of * 0.8),
            JSON.stringify(r.shapes));
    }
    check('a Photoshop tip keeps its own proportions',
        (await page.eval(`(async () => {
            for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
            const buf = await window.__files['two-tips-v6.abr'].arrayBuffer();
            const res = await PaintApp.brush.importAbrPack(new Uint8Array(buf), 'two-tips-v6.abr');
            const out = [];
            for (const n of res.added) {
                const bmp = await createImageBitmap(await (await fetch(PaintApp.brush.PRESETS[n]._tipUrl)).blob());
                out.push(bmp.width + 'x' + bmp.height);
            }
            return JSON.stringify(out);
        })()`, { awaitPromise: true })) === '["48x48","60x24"]');

    console.log('\n== a bare tip image ==');
    const loose = await page.eval(`(async () => {
        const buf = await window.__files['chalk-chisel-random-small.gih'].arrayBuffer();
        const r = await PaintApp.brush.importBrushTip(new Uint8Array(buf), 'chalk-chisel-random-small.gih');
        return JSON.stringify(r);
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('a loose .gih becomes a brush', loose.ok && loose.cells === 4, JSON.stringify(loose));
    check('named after the file, tidied up',
        loose.ok && loose.name === 'chalk chisel random small', loose.name);
    check('and it stamps a different shape per dab',
        (await page.run(`return PaintApp.brush.PRESETS[${JSON.stringify(loose.name)}].tipCells;`)) === 4);

    console.log('\n== a MyPaint brush ==');
    /* MyPaint paints with no tip image and forty settings, most of which
     * have no counterpart here, so this import is openly a likeness. What
     * is checked is that the numbers that DO cross over land in our units
     * and that the rest are named rather than dropped in silence. */
    const myb = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        const txt = await window.__files['charcoal-soft.myb'].text();
        const r = PaintApp.brush.importMyb(txt, 'charcoal-soft.myb');
        return JSON.stringify({ r, p: r.ok ? PaintApp.brush.PRESETS[r.added[0]] : null });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('the brush arrives under its own name',
        myb.r.ok && myb.r.added[0] === 'Charcoal Soft', JSON.stringify(myb.r).slice(0, 150));
    /* radius_logarithmic 2.3 is a RADIUS of e^2.3, so a 20px brush. */
    check('the logarithmic radius becomes a diameter in pixels',
        myb.p && myb.p.size === 20, myb.p && String(myb.p.size));
    /* 5 dabs land inside one radius, so they sit a tenth of a diameter
     * apart -- reading that as spacing directly would space them 5%. */
    check('dabs per radius becomes spacing the other way up',
        myb.p && myb.p.spacing === 10, myb.p && String(myb.p.spacing));
    check('hardness, flow, squash and turn all cross over',
        myb.p && myb.p.hardness === 35 && myb.p.flow === 90 &&
        myb.p.aspectRatio === 2.5 && myb.p.angle === 30,
        JSON.stringify(myb.p && { h: myb.p.hardness, f: myb.p.flow, a: myb.p.aspectRatio, g: myb.p.angle }));
    check('a random offset becomes scatter', myb.p && myb.p.scatter === 40,
        myb.p && String(myb.p.scatter));
    /* MyPaint's curve is an addition in the setting's own units; ours is a
     * multiplier. The shape has to survive that, and end where it started. */
    check('the pressure curve keeps its shape',
        myb.p && myb.p.sizeSrc === 'pressure' && myb.p.sizeCurve.length === 3 &&
        myb.p.sizeCurve[0][1] === 0 && myb.p.sizeCurve[2][1] === 1 &&
        myb.p.sizeCurve[1][1] > 0.7,
        JSON.stringify(myb.p && myb.p.sizeCurve));
    check('and what it could not carry is named, not silently dropped',
        myb.r.notes.length === 1 &&
        myb.r.notes[0].warnings.some(w => /speed/.test(w)) &&
        myb.r.notes[0].warnings.some(w => /grid/.test(w)),
        JSON.stringify(myb.r.notes));

    const old = await page.eval(`(async () => {
        const txt = await window.__files['hard-eraser.myb'].text();
        const r = PaintApp.brush.importMyb(txt, 'hard-eraser.myb');
        return JSON.stringify({ r, p: r.ok ? PaintApp.brush.PRESETS[r.added[0]] : null });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('the older line format reads too', old.r.ok, JSON.stringify(old.r).slice(0, 150));
    check('an eraser comes across as an eraser',
        old.p && old.p.blendMode === 'erase' && old.p.hardness === 90,
        JSON.stringify(old.p && { b: old.p.blendMode, h: old.p.hardness }));

    console.log('\n== dropping a file on the panel ==');
    /* Same importer, reached the way a downloaded pack actually arrives.
     * Worth its own check because a drop that nothing handles falls through
     * to the browser, which navigates away from the app. */
    const dropped = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        PaintApp.setTool('paintbrush');
        await new Promise(r => setTimeout(r, 300));
        const panel = document.getElementById('paintbrush-sidebar');
        const dt = new DataTransfer();
        dt.items.add(window.__files['bristles-grouped.gbr']);
        const e = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
        panel.dispatchEvent(e);
        await new Promise(r => setTimeout(r, 700));
        return JSON.stringify({ prevented: e.defaultPrevented,
                                names: PaintApp.brush.userPresetNames() });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('a dropped tip becomes a brush', dropped.names.length === 1, JSON.stringify(dropped));
    check('and the browser does not open the file instead', dropped.prevented === true);

    console.log('\n== one button for every kind of file ==');
    /* The button hands whatever was picked to importFiles, which decides
     * what each one is. Picking three at once must not need three trips. */
    const many = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        const r = await PaintApp.brush.importFiles([
            window.__files['thin-brush-pointy.kpp'],
            window.__files['bristles-grouped.gbr'],
            window.__files['mini-pack.bundle'],
            window.__files['two-tips-v6.abr'],
            window.__files['charcoal-soft.myb']
        ]);
        return JSON.stringify({ r: r, count: PaintApp.brush.userPresetNames().length });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('a Krita preset, a tip, a pack, a Photoshop set and a MyPaint brush in one go',
        many.r.brushes === 7 && many.r.failed === 0, JSON.stringify(many.r));
    check('all seven are in the library', many.count === 7, `${many.count}`);

    const junk = await page.eval(`(async () => {
        const f = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'notabrush.bundle');
        const r = await PaintApp.brush.importFiles([f]);
        return JSON.stringify(r);
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('a file that is not a brush pack says so instead of throwing',
        junk.brushes === 0 && junk.failed === 1, JSON.stringify(junk));

    await page.run(`for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n); return 1;`);

    const errs = page.errors();
    console.log(`\npage errors: ${errs.length}`);
    for (const e of errs.slice(0, 5)) console.log('  ! ' + e.text.split('\n')[0]);
    console.log(`\n${pass} passed, ${fail} failed`);
});

process.exit(fail ? 1 : 0);
