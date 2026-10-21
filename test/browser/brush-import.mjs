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
    'three-tips-v10.abr': b64('three-tips-v10.abr'),
    'abr-tip-pack.bundle': b64('abr-tip-pack.bundle'),
    'one-tool.tpl': b64('one-tool.tpl'),
    'round-soft.vbr': b64('round-soft.vbr'),
    'block-wide.vbr': b64('block-wide.vbr'),
    'star-ten.vbr': b64('star-ten.vbr'),
    'sai-shape.bmp': b64('sai-shape.bmp'),
    'charcoal-soft.myb': b64('charcoal-soft.myb'),
    'hard-eraser.myb': b64('hard-eraser.myb'),
    'deevad-airbrush.myb': b64('deevad-airbrush.myb'),
    'deevad-knife-smudging.myb': b64('deevad-knife-smudging.myb'),
    'borrowed-tip.bundle': b64('borrowed-tip.bundle'),
    'two-brushes.brushset': b64('two-brushes.brushset'),
    'seed-csp2pc.brush': b64('seed-csp2pc.brush'),
    'rough-scrape.sut': b64('rough-scrape.sut'),
    'pixel-select.sut': b64('pixel-select.sut'),
    'multiply-scrape.sut': b64('multiply-scrape.sut'),
    'multiply-dry.sut': b64('multiply-dry.sut'),
    'taper-lens.sut': b64('taper-lens.sut'),
    'taper-unflagged.sut': b64('taper-unflagged.sut'),
    'mix-spray-scrape.sut': b64('mix-spray-scrape.sut'),
    'dot-pen.sut': b64('dot-pen.sut'),
    'library-tips.sut': b64('library-tips.sut'),
    'library-repeat.sut': b64('library-repeat.sut'),
    'layer-tip.sut': b64('layer-tip.sut'),
    'masked-generated.kpp': b64('masked-generated.kpp'),
    'masked-file.kpp': b64('masked-file.kpp'),
    'itxt-binary-md5.kpp': b64('itxt-binary-md5.kpp'),
    'shapes-alchemy.kpp': b64('shapes-alchemy.kpp'),
    'distort-move.kpp': b64('distort-move.kpp'),
    'default-tip.kpp': b64('default-tip.kpp'),
    'shapes-leftover-tip.kpp': b64('shapes-leftover-tip.kpp')
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
        return JSON.stringify({ cells: t.cells, size: t.size, w: bmp.width, ink, clear, spacing: t.spacing });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('one shape, at its own size', gbr.cells === 1 && gbr.size === 64 && gbr.w === 64,
        JSON.stringify(gbr));
    /* A grey .gbr stores coverage, so its bytes ARE the alpha. Reading them
     * as luminance instead would invert the brush: the paper would paint and
     * the bristles would not. */
    check('coverage is read as coverage, not inverted',
        gbr.ink > 100 && gbr.clear > gbr.ink * 2, `${gbr.ink} inked, ${gbr.clear} clear of 4096`);

    /* The fixture's own header asks for 1% spacing (heavy dab overlap), not
     * our fallback default of 10 -- a bare-tip import must keep the file's
     * own number instead of silently overriding it. */
    check('a .gbr\'s own spacing is read, not defaulted', gbr.spacing === 1,
        JSON.stringify(gbr));

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
     * two header shapes -- not that Adobe agrees with the description.
     *
     * three-tips-v10.abr is written from two REAL packs instead: 130
     * brushes between them, which is where the version-10 layout below
     * was measured. Neither pack allows redistribution, so the layout is
     * rebuilt rather than the files shipped. */
    for (const [f, want] of [['two-tips-v6.abr', 2], ['two-tips-v6-sub2.abr', 1],
                             ['two-tips-v2.abr', 2], ['three-tips-v10.abr', 3]]) {
        const r = await page.eval(`(async () => {
            for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
            const buf = await window.__files[${JSON.stringify(f)}].arrayBuffer();
            const res = await PaintApp.brush.importAbrPack(new Uint8Array(buf), ${JSON.stringify(f)});
            const shapes = [];
            for (const n of res.added || []) {
                const bmp = await createImageBitmap(await (await fetch(await PaintApp.brush.tipUrl(PaintApp.brush.PRESETS[n]._tipUrl))).blob());
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
                const bmp = await createImageBitmap(await (await fetch(await PaintApp.brush.tipUrl(PaintApp.brush.PRESETS[n]._tipUrl))).blob());
                out.push(bmp.width + 'x' + bmp.height);
            }
            return JSON.stringify(out);
        })()`, { awaitPromise: true })) === '["48x48","60x24"]');

    /* Krita's masking brush: a whole second preset stamped through the
     * first as an alpha mask, which is what our second tip already is. Both
     * fixtures are Revoy's own presets with that one flag flipped on --
     * every preset in his bundles carries the entire masking preset with it
     * switched off, so the structure is real and only the switch is ours. */
    console.log('== a Krita brush masked by a second one ==');
    const msk = await page.eval(`(async () => {
        const out = {};
        for (const f of ['masked-generated.kpp', 'masked-file.kpp']) {
            for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
            const r = await PaintApp.brush.importFiles([window.__files[f]]);
            const n = PaintApp.brush.userPresetNames()[0];
            const p = n ? PaintApp.brush.PRESETS[n] : {};
            let w = 0;
            if (p._tip2Url) {
                const bmp = await createImageBitmap(await (await fetch(await PaintApp.brush.tipUrl(p._tip2Url))).blob());
                w = bmp.width;
            }
            out[f] = { lines: r.lines, ref: String(p._tip2Url || '').slice(0, 4),
                       w, op: p.maskOp || '', pic: !!p.maskPicture, size: p.maskSize || 0 };
        }
        return JSON.stringify(out);
    })()`, { awaitPromise: true }).then(JSON.parse);
    console.log('  ' + JSON.stringify(msk));
    // multiply is a second stroke, as subtract is: a generated tip strokes with its own falloff, no picture
    check('a masking brush that generates its tip strokes the mask with it',
        msk['masked-generated.kpp'].op === 'multiply' && !msk['masked-generated.kpp'].pic,
        JSON.stringify(msk['masked-generated.kpp']));
    check('a masking brush that names a tip resolves it like any other',
        msk['masked-file.kpp'].w > 0 && msk['masked-file.kpp'].op === 'multiply' && msk['masked-file.kpp'].pic,
        JSON.stringify(msk['masked-file.kpp']));
    /* MasterSizeCoeff is the mask's size over the brush's: 8.5415 against
     * 250 is the 0.034166 the file holds, to the digit. */
    check('...and the mask keeps its real size against the dab',
        msk['masked-generated.kpp'].size === 3 && msk['masked-file.kpp'].size === 1592,
        JSON.stringify([msk['masked-generated.kpp'].size, msk['masked-file.kpp'].size]));
    check('...and neither still reports the mask as dropped',
        !/used as a mask/.test(JSON.stringify(msk)), JSON.stringify(msk));

    /* Two of David Revoy's presets are not brushes at all: one fills the
     * outline you draw, the other pushes the pixels already on the layer
     * about. Both used to import as a plain round brush with a note saying
     * so; both are engines of their own now. */
    console.log('\n== the two brushes that are not brushes ==');
    const eng = await page.eval(`(async () => {
        const out = {};
        for (const f of ['shapes-alchemy.kpp', 'distort-move.kpp']) {
            for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
            const r = await PaintApp.brush.importFiles([window.__files[f]]);
            const n = PaintApp.brush.userPresetNames()[0];
            const p = n ? PaintApp.brush.PRESETS[n] : {};
            out[f] = { lines: r.lines, kind: p.engineKind, winding: p.shapeWinding,
                       action: p.deformAction, amount: p.deformAmount,
                       size: p.size, spacing: p.spacing };
        }
        return JSON.stringify(out);
    })()`, { awaitPromise: true }).then(JSON.parse);
    console.log('  ' + JSON.stringify(eng));
    check('the experiment brush arrives as the engine that fills an outline',
        eng['shapes-alchemy.kpp'].kind === 'shape',
        JSON.stringify(eng['shapes-alchemy.kpp']));
    check('the deform brush arrives as the engine that moves pixels',
        eng['distort-move.kpp'].kind === 'deform' &&
        eng['distort-move.kpp'].action === 'move' &&
        eng['distort-move.kpp'].amount === 30 &&
        eng['distort-move.kpp'].size === 200 && eng['distort-move.kpp'].spacing === 15,
        JSON.stringify(eng['distort-move.kpp']));
    check('...and neither says it was painted as an ordinary brush any more',
        !/ordinary brush|no tip definition|blend mode/.test(JSON.stringify(eng)),
        JSON.stringify(eng));

    /* Krita writes its bigger presets into an iTXt chunk, and a textured one
     * carries its pattern's md5 as sixteen RAW BYTES inside a CDATA block.
     * Several of those bytes are characters XML does not allow at all, which
     * stops a parser dead and took the whole preset with it -- eight of the
     * forty-six presets in Revoy's 25.01 bundle, silently left out. */
    console.log('\n== a preset whose checksum is raw bytes ==');
    const itx = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        const r = await PaintApp.brush.importFiles([window.__files['itxt-binary-md5.kpp']]);
        const n = PaintApp.brush.userPresetNames()[0];
        const p = n ? PaintApp.brush.PRESETS[n] : {};
        return JSON.stringify({ r, name: n || '', size: p.size, spacing: p.spacing });
    })()`, { awaitPromise: true }).then(JSON.parse);
    console.log('  ' + JSON.stringify(itx));
    check('a preset stored in an iTXt chunk is read like any other',
        itx.r.brushes === 1 && itx.r.failed === 0, JSON.stringify(itx.r));
    check('...and the bytes XML forbids do not take it down with them',
        itx.size > 0 && itx.spacing > 0, JSON.stringify([itx.size, itx.spacing]));

    /* A real Photoshop brush is authored at 1000 pixels and up, and 200 --
     * where every imported tip used to land -- is exactly where the grain of
     * a chalk or a drip brush lives. The picture is in IndexedDB now and the
     * preset keeps a key, so the record in localStorage is tiny however big
     * the tip is. */
    const big = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        const c = document.createElement('canvas');
        c.width = c.height = 700;
        const g = c.getContext('2d');
        g.fillStyle = '#000';
        for (let i = 0; i < 700; i += 7) g.fillRect(i, 0, 4, 700);   // a grain that dies if squashed
        const blob = await new Promise(r => c.toBlob(r, 'image/png'));
        const buf = new Uint8Array(await blob.arrayBuffer());
        const res = await PaintApp.brush.importBrushTip(buf, 'big-grain.png');
        const p = PaintApp.brush.PRESETS[res.name] || {};
        const bmp = await createImageBitmap(await (await fetch(await PaintApp.brush.tipUrl(p._tipUrl))).blob());
        return JSON.stringify({ res, w: bmp.width, size: p.size,
            ref: String(p._tipUrl).slice(0, 4),
            stored: (localStorage.getItem('pb-user-presets') || '').length });
    })()`, { awaitPromise: true }).then(JSON.parse);
    console.log('  ' + JSON.stringify(big));
    check('a 700px tip arrives at 700px, not squashed to 200',
        big.res.ok && big.w === 700, JSON.stringify([big.res.ok, big.w]));
    check('...and the brush is sized to match it',
        big.size === 700, String(big.size));
    check('...while the saved record keeps only a key to the picture',
        big.ref === 'idb:' && big.stored < 2000, JSON.stringify([big.ref, big.stored]));

    /* Photoshop keeps a brush's name nowhere near its image: the sample
     * carries a UUID and the names live in a descriptor at the end of the
     * file, in a different order. Getting this wrong is not subtle -- a
     * downloaded pack of a hundred arrives as "pack 1" ... "pack 100". */
    const res10 = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        const buf = await window.__files['three-tips-v10.abr'].arrayBuffer();
        const res = await PaintApp.brush.importAbrPack(new Uint8Array(buf), 'three-tips-v10.abr');
        return JSON.stringify(res);
    })()`, { awaitPromise: true }).then(JSON.parse);
    const named = res10.added;
    check('a version 10 set brings Photoshop own names across',
        named[0] === 'a blob' && named[1] === 'a bar', JSON.stringify(named));
    /* The third sample is not in the descriptor at all, which is what a pack
     * looks like when its author deleted a brush without rewriting the
     * names. It must not inherit the name above it. */
    check('and a tip the descriptor forgot is numbered, not misnamed',
        named[2] === 'three tips v10 3', JSON.stringify(named));

    /* A Krita preset can take its tip out of a Photoshop set beside it,
     * naming only "<set>_<n>" (n from 1). Unresolved, portnov's pastel
     * brushes came in as plain squares -- 6.4x Krita's ink. */
    const abrTip = await page.eval(`(async () => {
        const buf = await window.__files['abr-tip-pack.bundle'].arrayBuffer();
        const r = await PaintApp.brush.importBrushPack(new Uint8Array(buf), 'abr-tip-pack.bundle');
        const P = PaintApp.brush.PRESETS;
        const got = r.added.length ? P[r.added[0]] : {};
        return JSON.stringify({ r, shape: got.shape, same: !!got._tipUrl && got._tipUrl === P['a bar']._tipUrl,
            other: got._tipUrl === P['a blob']._tipUrl });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('a Krita preset finds its tip inside the .abr beside it, counted from 1',
        abrTip.shape === 'custom' && abrTip.same && !abrTip.other, JSON.stringify(abrTip).slice(0, 300));

    /* The same descriptor holds every dial Photoshop paints with, and until
     * this session we read none of them: a downloaded pack arrived as flat
     * stamps at whatever size we guessed. */
    const blob = await page.run(`return PaintApp.brush.PRESETS['a blob'];`);
    const bar = await page.run(`return PaintApp.brush.PRESETS['a bar'];`);
    check('its real diameter and spacing come across',
        blob.size === 150 && blob.spacing === 9, JSON.stringify([blob.size, blob.spacing]));
    check('so does a turned, squashed tip',
        blob.angle === 30 && blob.aspectRatio === 2, JSON.stringify([blob.angle, blob.aspectRatio]));
    check('a pressure-driven brush arrives pressure-driven',
        blob.sizeSrc === 'pressure' && blob.sizeMin === 20,
        JSON.stringify([blob.sizeSrc, blob.sizeMin]));
    /* 4% angle jitter is a wobble. Read as a bare "random angle" it would
     * spin every dab to a random heading, which is a different brush. */
    check('a small angle jitter stays a wobble, not a spin',
        blob.angleSrc === 'random' && blob.angleRange === 7,
        JSON.stringify([blob.angleSrc, blob.angleRange]));
    check('scatter comes across at its own width, on both axes',
        blob.scatter === 60 && blob.scatterAxis === 'both',
        JSON.stringify([blob.scatter, blob.scatterAxis]));
    /* Photoshop's fade is not a pen input at all: it counts dabs and runs
     * the dial down over `fStp` of them. It used to be reported as dropped,
     * which meant a fading brush painted a constant one. */
    check('a dial that fades over a dab count comes across as one',
        blob.aspectRatioSrc === 'fade' && blob.aspectRatioMin === 30 &&
        blob.fadeSteps === 40,
        JSON.stringify([blob.aspectRatioSrc, blob.aspectRatioMin, blob.fadeSteps]));
    check('a brush with no dynamics gets none of them',
        bar.sizeSrc !== 'pressure' && !bar.scatter,
        JSON.stringify([bar.sizeSrc, bar.scatter]));
    /* Photoshop's flipX turns the tip over and leaves it turned over. Read as
     * Krita's mirror -- which is what it used to be -- half the dabs come out
     * the right way round, which is a different brush. */
    check('...but the bar is still flipped across, once and for good',
        bar.tipFlip === 'h' && !bar.tipMirror,
        JSON.stringify([bar.tipFlip, bar.tipMirror]));
    /* `Intr` off means it does not step at all. */
    check('and one that paints as fast as the pointer moves steps by one',
        bar.spacing === 1, String(bar.spacing));
    /* The paper texture is in a section of its own, in the layout a .pat
     * file uses, and it is a picture rather than a cut-out: read as coverage
     * it would come out as a hole rather than a grain. */
    const grain = await page.eval(`(async () => {
        const url = PaintApp.brush.PRESETS['a blob'].texturePattern;
        if (!url) return '{}';
        const bmp = await createImageBitmap(await (await fetch(url)).blob());
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        return JSON.stringify({ w: bmp.width, h: bmp.height,
            tl: d[0], next: d[5 * 4], opaque: d[3] });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('a brush that asks for paper gets the paper out of the file',
        grain.w === 16 && grain.h === 16, JSON.stringify(grain));
    check('and the grain is light and dark, not a hole',
        grain.tl === 40 && grain.next === 240 && grain.opaque === 255, JSON.stringify(grain));
    check('so it is no longer reported as dropped',
        !/paper texture/.test(((res10.notes || []).find(n => n.name === 'a blob') || {}).warnings || []),
        JSON.stringify((res10.notes || []).map(n => n.name)));

    const psNotes = (res10.notes || []).filter(n => n.name === 'a blob')
        .map(n => n.warnings.join('; ')).join('');
    /* Several dabs at every stop is what makes a Photoshop scatter brush a
     * spray rather than a dotted line, so it was the half of scatter that
     * did the most work and the half we threw away. */
    check('and the dabs it lays at every stop come across',
        blob.dabCount === 3, String(blob.dabCount));
    check('what Photoshop can do and we cannot is named, not swallowed',
        /wet edges/.test(psNotes) &&
        !/second brush tip/.test(psNotes) && !/3 dabs/.test(psNotes), psNotes);
    /* Colour dynamics: the flag says it varies, and three separate dials say
     * by how much. Hue is a share of the whole wheel there and degrees
     * here. */
    check('a brush that varies its colour as you draw does so',
        blob.hueJitter === 18 && blob.satJitter === 25 && blob.valJitter === 40 &&
        !/colour variation/.test(psNotes),
        JSON.stringify([blob.hueJitter, blob.satJitter, blob.valJitter]));
    /* A dual brush names its second tip by the UUID of a sample in the same
     * file, exactly the way a brush names its own -- here the third sample,
     * which no brush of its own claims. Its tip is 75px against the brush's
     * 150, so it carves at half the size. */
    check('a second tip is resolved out of the same file',
        typeof blob._tip2Url === 'string' && blob._tip2Url.indexOf('idb:') === 0 &&
        blob.tip2Depth === 100 && blob.tip2Size === 50 && blob.tip2Angle === 15 &&
        blob.tip2Spacing === 140,
        JSON.stringify([String(blob._tip2Url).slice(0, 22), blob.tip2Depth,
                        blob.tip2Size, blob.tip2Angle, blob.tip2Spacing]));
    check('...and a blend we do have is not complained about',
        !/second tip blends/.test(psNotes), psNotes);

    /* A Photoshop tool preset. A saved tool, not a saved brush -- but a
     * saved paintbrush carries the whole brush with it, under different
     * block names, with a shorter settings block in front of each tip and
     * the dials in a descriptor keyed for the paintbrush tool. It also
     * carries what an .abr never does: the opacity, flow and blend mode the
     * tool was saved at. */
    console.log('\n== a Photoshop tool preset ==');
    const tpl = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        const r = await PaintApp.brush.importFiles([window.__files['one-tool.tpl']]);
        const ps = PaintApp.brush.userPresetNames().map(n => {
            const p = PaintApp.brush.PRESETS[n];
            return { n, size: p.size, flow: p.flow, opacity: p.opacity,
                blendMode: p.blendMode || '', spacing: p.spacing,
                sizeSrc: p.sizeSrc || '', sizeMin: p.sizeMin };
        });
        return JSON.stringify({ r, ps });
    })()`, { awaitPromise: true }).then(JSON.parse);
    console.log('  ' + JSON.stringify(tpl.ps));
    check('a .tpl installs the brush its tool was saved with',
        tpl.r.brushes === 2 && tpl.r.failed === 0, JSON.stringify(tpl.r));
    check('the tool preset is read past the tool that is not a brush',
        tpl.ps[0].n === 'a saved blob' && tpl.ps[0].size === 60 &&
        tpl.ps[0].spacing === 12, JSON.stringify(tpl.ps[0]));
    check('and its dynamics come with it',
        tpl.ps[0].sizeSrc === 'pressure' && tpl.ps[0].sizeMin === 20,
        JSON.stringify(tpl.ps[0]));
    /* The three a saved tool has and a saved brush does not. */
    check('the opacity, flow and blend mode the tool was saved at arrive',
        tpl.ps[0].flow === 19 && tpl.ps[0].opacity === 80 &&
        tpl.ps[0].blendMode === 'multiply', JSON.stringify(tpl.ps[0]));
    check('a tip no tool preset claims is still installed as a stamp',
        tpl.ps[1] && tpl.ps[1].size === 24 && tpl.ps[1].flow === 100,
        JSON.stringify(tpl.ps[1]));

    /* A GIMP generated brush: a shape described in eight or ten numbers of
     * plain text, with no picture in it at all. GIMP builds the dab from
     * the numbers every time it paints, so we have to as well -- there is
     * nothing else in the file to use. */
    console.log('\n== a GIMP generated brush ==');
    const vbr = await page.eval(`(async () => {
        const out = {};
        for (const f of ['round-soft.vbr', 'block-wide.vbr', 'star-ten.vbr']) {
            for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
            const r = await PaintApp.brush.importFiles([window.__files[f]]);
            const n = PaintApp.brush.userPresetNames()[0];
            const p = n ? PaintApp.brush.PRESETS[n] : {};
            let w = 0, h = 0, mid = 0, corner = 0;
            if (p._tipUrl) {
                const bmp = await createImageBitmap(await (await fetch(await PaintApp.brush.tipUrl(p._tipUrl))).blob());
                const c = document.createElement('canvas');
                c.width = bmp.width; c.height = bmp.height;
                const g = c.getContext('2d');
                g.drawImage(bmp, 0, 0);
                const d = g.getImageData(0, 0, c.width, c.height).data;
                w = bmp.width; h = bmp.height;
                const at = (x, y) => d[((y * w + x) << 2) + 3];
                mid = at(w >> 1, h >> 1);
                corner = at(2, 2);
            }
            out[f] = { r, n, size: p.size, spacing: p.spacing, shape: p.shape,
                       hardness: p.hardness, w, h, mid, corner };
        }
        return JSON.stringify(out);
    })()`, { awaitPromise: true }).then(JSON.parse);
    console.log('  ' + JSON.stringify(vbr));

    check('all three generated brushes install',
        ['round-soft.vbr', 'block-wide.vbr', 'star-ten.vbr']
            .every(f => vbr[f].r.brushes === 1 && vbr[f].r.failed === 0),
        JSON.stringify(Object.keys(vbr).map(f => vbr[f].r)));
    check('the brush keeps the name written in the file',
        vbr['star-ten.vbr'].n === 'a ten-pointed star', vbr['star-ten.vbr'].n);
    /* The size is GIMP's own mask box -- 2 x sqrt(r^2 + (r/aspect)^2) for a
     * spiked one, made odd -- and the spacing is a percentage of the
     * diameter, so over that 55px box it is 50 x 50/55 (GIMP 2. Star). */
    check('the size is the box GIMP draws the dab in, spacing steps by the diameter',
        vbr['star-ten.vbr'].size === 55 && vbr['star-ten.vbr'].spacing === 45.5,
        JSON.stringify(vbr['star-ten.vbr']));
    /* A plain round one needs no picture: that is the brush we already are,
     * and keeping it parametric means it stays sharp at any size. */
    check('a plain round one stays a round brush, softness and all',
        vbr['round-soft.vbr'].shape === 'circle' && vbr['round-soft.vbr'].w === 0 &&
        vbr['round-soft.vbr'].hardness === 40, JSON.stringify(vbr['round-soft.vbr']));
    /* Everything else has to be drawn. A square of 4:1 is a wide block:
     * GIMP's box for it is 51 x 13, solid in the middle. */
    check('a shape we cannot make parametrically is drawn instead',
        vbr['block-wide.vbr'].shape === 'custom' && vbr['block-wide.vbr'].w === 51 &&
        vbr['block-wide.vbr'].h === 13 && vbr['block-wide.vbr'].mid === 255,
        JSON.stringify(vbr['block-wide.vbr']));
    /* Spikes are what make these stars: GIMP folds the plane into that
     * many wedges. Its exact pixels are checked in brush-fidelity.mjs. */
    check('and a spiked one comes out as a star, not as its base shape',
        vbr['star-ten.vbr'].mid === 255 && vbr['star-ten.vbr'].corner === 0,
        JSON.stringify(vbr['star-ten.vbr']));

    /* A SAI brush shape. SAI keeps no brush file at all -- a brush there is
     * a row in a text index naming a .bmp in one of four folders -- so the
     * .bmp is the whole of what is portable. It is drawn on a template: a
     * white square with a pale blue guide circle and crosshair already on
     * it, the shape in plain grey. SAI ignores any pixel that is not a
     * grey, and read as ink the guide puts a faint ring round every stamp. */
    console.log('\n== a SAI brush shape ==');
    const sai = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        const r = await PaintApp.brush.importFiles([window.__files['sai-shape.bmp']]);
        const n = PaintApp.brush.userPresetNames()[0];
        const p = n ? PaintApp.brush.PRESETS[n] : {};
        let w = 0, h = 0, bar = -1, guide = -1, corner = -1;
        if (p._tipUrl) {
            const bmp = await createImageBitmap(await (await fetch(await PaintApp.brush.tipUrl(p._tipUrl))).blob());
            const c = document.createElement('canvas');
            c.width = bmp.width; c.height = bmp.height;
            const g = c.getContext('2d');
            g.drawImage(bmp, 0, 0);
            const d = g.getImageData(0, 0, c.width, c.height).data;
            const at = (x, y) => d[((y * c.width + x) << 2) + 3];
            w = bmp.width; h = bmp.height;
            bar = at(10, 31); guide = at(31, 3); corner = at(1, 1);
        }
        return JSON.stringify({ r, n, size: p.size, w, h, bar, guide, corner });
    })()`, { awaitPromise: true }).then(JSON.parse);
    console.log('  ' + JSON.stringify(sai));
    check('a SAI .bmp shape installs as a brush',
        sai.r.brushes === 1 && sai.r.failed === 0 && sai.w === 63 && sai.h === 63,
        JSON.stringify(sai));
    check('the shape drawn on the template is the ink',
        sai.bar === 255 && sai.corner === 0, JSON.stringify(sai));
    check('and the template' + "'" + 's own guide lines are not',
        sai.guide === 0, String(sai.guide));

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
    /* The engine carries a port of libmypaint, so a .myb is handed over whole
     * and painted as MyPaint paints it (test/krita/mypaint-bank.mjs measures
     * that against libmypaint itself). What is checked here is the handing over. */
    const myb = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        const txt = await window.__files['charcoal-soft.myb'].text();
        const r = PaintApp.brush.importMyb(txt, 'charcoal-soft.myb');
        return JSON.stringify({ r, p: r.ok ? PaintApp.brush.PRESETS[r.added[0]] : null });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('the brush arrives under its own name',
        myb.r.ok && myb.r.added[0] === 'Charcoal Soft', JSON.stringify(myb.r).slice(0, 150));
    check('and is painted by the MyPaint engine, every setting and curve with it',
        myb.p && myb.p.engineKind === 'mypaint' && myb.p.mypaint.settings.offset_by_random.base === 0.4 &&
        myb.p.mypaint.settings.radius_logarithmic.inputs.pressure.length === 3,
        JSON.stringify(myb.p && myb.p.mypaint).slice(0, 150));
    /* radius_logarithmic 2.3 is a RADIUS of e^2.3, so a 20px brush. */
    check('the logarithmic radius becomes a diameter in pixels',
        myb.p && myb.p.size === 19.95, myb.p && String(myb.p.size));
    check('the cursor gets its squash and turn',
        myb.p && myb.p.aspectRatio === 2.5 && myb.p.angle === 30,
        JSON.stringify(myb.p && { a: myb.p.aspectRatio, g: myb.p.angle }));
    check('and nothing is reported as left behind', !myb.r.notes.length, JSON.stringify(myb.r.notes));

    /* A brush's random numbers run in order from the same seed MyPaint uses,
     * so a stroke lands where MyPaint's does. The brush's preview tile used
     * to paint with the canvas brush and use up its numbers first: Charcoal
     * matched libmypaint's ink but only half its pixels. */
    const rnd = await page.eval(`(async () => {
        const app = PaintApp, b = app.brush, txt = await window.__files['charcoal-soft.myb'].text();
        const clock = performance.now; let tick = 0; performance.now = () => tick;
        const paint = (preview) => {
            for (const n of b.userPresetNames()) b.deleteUserPreset(n);
            const name = b.importMyb(txt, 'charcoal-soft.myb').added[0];
            b.loadPreset(name);
            if (preview) b.generatePreview(name);
            const ctx = app.layerMgr.layers[app.layerMgr.activeIdx].ctx;
            ctx.clearRect(0, 0, 200, 100);
            b.beginStroke(20, 50, 0.8, '#000000');
            for (let x = 21; x <= 180; x++) { tick += 2; b.moveStroke(x, 50, 0.8, '#000000'); }
            b.endStroke();
            return Array.from(ctx.getImageData(0, 0, 200, 100).data.filter((v, i) => i % 4 === 3));
        };
        try {
            const a = paint(false), c = paint(true);
            return JSON.stringify({ ink: a.reduce((s, v) => s + v, 0), diff: a.filter((v, i) => v !== c[i]).length });
        } finally { performance.now = clock; }
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('the preview tile does not use up the brush\'s random numbers',
        rnd.ink > 0 && rnd.diff === 0, JSON.stringify(rnd));
    /* libmypaint keeps positions in floats. A stroke along y = 50 with slow
     * tracking creeps up on 50 and lands on it there; kept in doubles it
     * stayed a hair short and a snapped 1px pen drew the row above
     * (experimental/1pixel). */
    const snap = await page.eval(`(() => {
        const app = PaintApp, b = app.brush, NL = String.fromCharCode(10);
        const clock = performance.now; let tick = 0; performance.now = () => tick;
        try {
            for (const n of b.userPresetNames()) b.deleteUserPreset(n);
            b.loadPreset(b.importMyb(['version 2', 'radius_logarithmic -0.58', 'hardness 1', 'opaque 1',
                'dabs_per_actual_radius 0.9', 'slow_tracking 2', 'snap_to_pixel 1'].join(NL), 'px.myb').added[0]);
            const ctx = app.layerMgr.layers[app.layerMgr.activeIdx].ctx;
            ctx.clearRect(0, 0, 200, 100);
            b.beginStroke(20, 50, 1, '#000000');
            for (let x = 21; x <= 120; x++) { tick += 2; b.moveStroke(x, 50, 1, '#000000'); }
            b.endStroke();
            const d = ctx.getImageData(0, 0, 200, 100).data, rows = new Set();
            for (let i = 3; i < d.length; i += 4) if (d[i]) rows.add((i - 3) / 4 / 200 | 0);
            return JSON.stringify([...rows]);
        } finally { performance.now = clock; }
    })()`).then(JSON.parse);
    check('a snapped 1px pen draws on the row it was drawn along', snap.length === 1 && snap[0] === 50, JSON.stringify(snap));
    /* The selection and the layer's alpha lock are the app's, not MyPaint's,
     * and a MyPaint stroke used to ignore both. */
    const clip = await page.eval(`(() => {
        const app = PaintApp, b = app.brush, NL = String.fromCharCode(10);
        const clock = performance.now; let tick = 0; performance.now = () => tick;
        const L = app.layerMgr.layers[app.layerMgr.activeIdx], ctx = L.ctx;
        const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data).join(',');
        const line = (y) => { b.beginStroke(10, y, 1, '#000000');
            for (let x = 11; x <= 190; x++) { tick += 2; b.moveStroke(x, y, 1, '#000000'); } b.endStroke(); };
        try {
            for (const n of b.userPresetNames()) b.deleteUserPreset(n);
            b.loadPreset(b.importMyb(['version 2', 'radius_logarithmic 2.0', 'hardness 1', 'opaque 1',
                'dabs_per_actual_radius 2'].join(NL), 'solid.myb').added[0]);
            ctx.clearRect(0, 0, 200, 100);
            app.state.selection = { x: 20, y: 20, w: 60, h: 60, rotation: 0, canvas: null, originalX: 20, originalY: 20 };
            app.state.selectionOriginalPos = { x: 20, y: 20, w: 60, h: 60, rotation: 0 };
            line(50);
            app.state.selection = null; app.state.selectionOriginalPos = null;
            const sel = [px(50, 50), px(150, 50)];
            ctx.clearRect(0, 0, 200, 100);
            ctx.fillStyle = '#00ff00'; ctx.fillRect(20, 20, 40, 40);
            L.alphaLock = true;
            line(40);
            L.alphaLock = false;
            return JSON.stringify({ sel, lock: [px(40, 40), px(150, 40)] });
        } finally { performance.now = clock; L.alphaLock = false; app.state.selection = null; }
    })()`).then(JSON.parse);
    check('a MyPaint stroke paints inside the selection and not outside it',
        clip.sel[0] === '0,0,0,255' && clip.sel[1] === '0,0,0,0', JSON.stringify(clip.sel));
    check('and under alpha lock it recolours the paint that is there and nothing else',
        clip.lock[0] === '0,0,0,255' && clip.lock[1] === '0,0,0,0', JSON.stringify(clip.lock));

    console.log('\n== two of David Revoy own MyPaint brushes ==');
    /* Revoy's own, straight out of the CC-0 collection -- not something
     * written here from the format description. */
    const real = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        const out = {};
        for (const f of ['deevad-airbrush.myb', 'deevad-knife-smudging.myb']) {
            const r = PaintApp.brush.importMyb(await window.__files[f].text(), f);
            out[f] = { r, p: r.ok ? PaintApp.brush.PRESETS[r.added[0]] : null };
        }
        return JSON.stringify(out);
    })()`, { awaitPromise: true }).then(JSON.parse);
    const air = real['deevad-airbrush.myb'], knife = real['deevad-knife-smudging.myb'];
    /* Every one of these files says "MyPaint brush file" in `comment` -- it
     * is the format's banner, not a name. The name is the description. */
    check('a real brush is named by its description, not the banner line',
        air.r.ok && air.r.added[0] === 'An airbrush' &&
        knife.r.added[0].startsWith('A flat brush'),
        JSON.stringify([air.r.added, knife.r.added]));
    /* radius_logarithmic 4.7 -> a radius of e^4.7, so a 220px brush. */
    check('his airbrush keeps its size and softness',
        air.p && Math.round(air.p.size) === 220 && air.p.hardness === 48,
        JSON.stringify(air.p && { s: air.p.size, h: air.p.hardness }));
    /* The dab is round here, and MyPaint still stores an angle of 90. */
    check('a round dab brings no angle across',
        air.p && !air.p.aspectRatio && air.p.angle === undefined,
        JSON.stringify(air.p && { a: air.p.aspectRatio, g: air.p.angle }));
    check('his knife is a flattened dab, turned, that smudges',
        knife.p && knife.p.aspectRatio === 3.61 && knife.p.angle === 160 &&
        knife.p.mypaint.settings.smudge.base > 0.9,
        JSON.stringify(knife.p && { a: knife.p.aspectRatio, g: knife.p.angle }));

    const old = await page.eval(`(async () => {
        const txt = await window.__files['hard-eraser.myb'].text();
        const r = PaintApp.brush.importMyb(txt, 'hard-eraser.myb');
        return JSON.stringify({ r, p: r.ok ? PaintApp.brush.PRESETS[r.added[0]] : null });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('the older line format reads too, curves and all',
        old.r.ok && old.p.engineKind === 'mypaint' &&
        Object.values(old.p.mypaint.settings).some(s => Object.keys(s.inputs).length),
        JSON.stringify(old.r).slice(0, 150));
    check('an eraser comes across as an eraser',
        old.p && old.p.blendMode === 'erase' && old.p.hardness === 90,
        JSON.stringify(old.p && { b: old.p.blendMode, h: old.p.hardness }));

    /* Krita drives the fresh-colour half of a smudge from the pen. It is the
     * same dial ours drives -- it just had nowhere to be driven from until
     * colorRate grew a sensor of its own. (Krita spells it ColorRate; an
     * older "Mix" spelling here matched no preset in the whole bank.) */
    const mix = await page.eval(`(() => {
        const t = BrushPack.toPreset({ paintop: 'colorsmudge', name: 'Blender', params: {
            ColorRateValue: '0.4', SmudgeRateValue: '0.6',
            PressureColorRate: 'true', ColorRateUseCurve: 'true', PressureSmudgeRate: 'true',
            ColorRateSensor: '<params id="pressure"/>'
        } });
        return JSON.stringify({ p: t.params, w: t.warnings });
    })()`).then(JSON.parse);
    check('colour mixing driven by the pen comes across now',
        mix.p.colorRateSrc === 'pressure' && mix.p.colorRate === 40,
        JSON.stringify([mix.p.colorRateSrc, mix.p.colorRate]));
    check('...and is no longer in the list of things we dropped',
        !/colour mixing/.test(mix.w.join(' ')), mix.w.join(' | '));

    /* Smudge rate switched off still smears, at full strength, with the
     * colour rate and its pen curve as they are: Krita's stroke builds up
     * out of what it picks up (test/krita/probes/smudge9). It used to come
     * across as plain paint at the colour rate, solid from the first pixel,
     * and the X2F "Smeary" brushes laid about twice Krita's ink. */
    const off = await page.eval(`(() => {
        const t = BrushPack.toPreset({ paintop: 'colorsmudge', name: 'Smeary', params: {
            ColorRateValue: '0.75', SmudgeRateValue: '0.65',
            PressureColorRate: 'true', ColorRateUseCurve: 'true', PressureSmudgeRate: 'false',
            ColorRateSensor: '<params id="pressure"/>'
        } });
        return JSON.stringify(t.params);
    })()`).then(JSON.parse);
    check('smudge rate switched off smears at full strength, colour rate kept',
        off.smudgeFull === true && off.smudgeRate === 65 && !off.smudgeRateSrc && off.colorRate === 75 && off.colorRateSrc === 'pressure',
        JSON.stringify([off.smudgeFull, off.smudgeRate, off.smudgeRateSrc, off.colorRate, off.colorRateSrc]));

    /* Several inputs on one option, sharing one curve with none stored:
     * Krita runs every input through the LAST one's curve and multiplies
     * (test/krita/probes/sensorlist). X2FA's pressure-then-speed colour rate
     * is the speed curve read at the pressure -- 1 - p here -- times that
     * curve at rest (speed 0). Taking the pressure child's own curve made
     * its paint rise with pressure where Krita's fell away. */
    const list = await page.eval(`(() => {
        const t = BrushPack.toPreset({ paintop: 'colorsmudge', name: 'List', params: {
            ColorRateValue: '1', SmudgeRateValue: '1', PressureColorRate: 'true', ColorRateUseCurve: 'true',
            PressureSmudgeRate: 'false',
            ColorRateSensor: '<params id="sensorslist"> <ChildSensor id="pressure"> <curve>0,0;1,1;</curve> </ChildSensor>' +
                ' <ChildSensor id="speed"> <curve>0,0.8;1,0;</curve> </ChildSensor> </params>'
        } });
        return JSON.stringify(t.params);
    })()`).then(JSON.parse);
    check('a sensor list shares its last curve and folds speed in at rest',
        list.colorRateSrc === 'pressure' && list.colorRateCurve.length === 2 &&
            Math.abs(list.colorRateCurve[0][1] - 0.64) < 1e-9 && list.colorRateCurve[1][1] === 0,
        JSON.stringify([list.colorRateSrc, list.colorRateCurve]));

    /* Krita's hatching brush (test/krita/probes/hatch, hatchp): a thickness
     * option switched off reads 0.5, on without its curve reads 1, on with
     * one follows the pen. It used to come across as a round brush. */
    const hat = await page.eval(`(() => {
        const t = BrushPack.toPreset({ paintop: 'hatchingbrush', name: 'Hatch', params: {
            'Hatching/angle': '-60', 'Hatching/separation': '6', 'Hatching/thickness': '4',
            'Hatching/origin_x': '50', 'Hatching/origin_y': '50', 'Hatching/separationintervals': '3',
            'Hatching/bool_antialias': 'true', 'Hatching/bool_perpendicular': 'true', 'Hatching/bool_nocrosshatching': 'false',
            'Hatching/bool_subpixelprecision': 'false',
            PressureThickness: 'false', PressureSeparation: 'true', SeparationUseCurve: 'true',
            SeparationSensor: '<params id="pressure"> <curve>0,0;1,1;</curve> </params>'
        } });
        return JSON.stringify({ h: t.params.hatch, w: t.warnings || [] });
    })()`).then(JSON.parse);
    /* A colour smudge's spacing option counts too (bank: Wet_Smear, whose
     * gaps close as the pen presses, 0.61x -> 0.96x ink). It was skipped
     * along with the pixel brush's leftover build-up keys. */
    const smsp = await page.eval(`(() => JSON.stringify(BrushPack.toPreset({ paintop: 'colorsmudge', name: 'S', params: {
        PressureSpacing: 'true', SpacingValue: '1', SpacingUseCurve: 'true',
        SpacingSensor: '<params id="pressure"> <curve>0,1;1,0;</curve> </params>'
    } }).params))()`).then(JSON.parse);
    check("a colour smudge's spacing follows its pen curve",
        smsp.spacingSrc === 'pressure' && smsp.spacingStrength === 1 && smsp.spacingCurve && smsp.spacingCurve[0][1] === 1,
        JSON.stringify([smsp.spacingSrc, smsp.spacingStrength, smsp.spacingCurve]));
    /* Krita's ratio option squashes the tip by its pen curve (bank: EO Pixel
     * Square, Cloud and Soft Cloud went from near to close). It used to be
     * dropped without a word. */
    const rto = await page.eval(`(() => JSON.stringify(BrushPack.toPreset({ paintop: 'paintbrush', name: 'R', params: {
        PressureRatio: 'true', RatioUseCurve: 'true', RatioValue: '1',
        RatioSensor: '<params id="pressure"> <curve>0,0.2;1,1;</curve> </params>'
    } }).params))()`).then(JSON.parse);
    check("a Krita ratio option drives the tip's aspect from the pen",
        rto.aspectRatioSrc === 'pressure' && rto.aspectRatioCurve && rto.aspectRatioCurve[0][1] === 0.2,
        JSON.stringify([rto.aspectRatioSrc, rto.aspectRatioCurve]));
    /* A preset from before Krita had a flow option stores no flow keys, and
     * Krita reads that as flow on pressure (probes/softness: X1CG Fineliner
     * at p0.1 painted 19 there, 153 here). */
    const oldFlow = await page.eval(`(() => JSON.stringify(BrushPack.toPreset({ paintop: 'paintbrush', name: 'F', params: {
        PressureOpacity: 'true', OpacityUseCurve: 'false', FlowValue: '1'
    } }).params))()`).then(JSON.parse);
    const markFlow = await page.eval(`(() => JSON.stringify(BrushPack.toPreset({ paintop: 'roundmarker', name: 'M', params: {
        FlowValue: '1', OpacityValue: '1'
    } }).params.flowSrc || null))()`).then(JSON.parse);
    check('a Krita preset with no flow keys takes its flow from pressure (pixel engine only)',
        oldFlow.flowSrc === 'pressure' && !oldFlow.dabOpacitySrc && (markFlow === null || markFlow === 'none'),
        JSON.stringify([oldFlow.flowSrc, oldFlow.dabOpacitySrc, markFlow]));
    const hgt = await page.eval(`(() => JSON.stringify(BrushPack.toPreset({ paintop: 'paintbrush', name: 'H', params: {
        'Texture/Pattern/Enabled': 'true', 'Texture/Pattern/Name': 'rock.png', 'Texture/Pattern/TexturingMode': '12',
        'Texture/Pattern/NeutralPoint': '0.3'
    } })))()`).then(JSON.parse);
    check("Krita's height texture imports as height with its neutral point, not as multiply",
        hgt.params.textureMode === 'height' && hgt.params.textureNeutral === 0.3 && !(hgt.warnings || []).some(w => /texture/.test(w)),
        JSON.stringify([hgt.params.textureMode, hgt.params.textureNeutral, hgt.warnings]));
    const grid = await page.eval(`(() => JSON.stringify(BrushPack.toPreset({ paintop: 'gridbrush', name: 'Grid', params: {
        'Grid/gridWidth': '25', 'Grid/gridHeight': '20', 'Grid/divisionLevel': '2', 'Grid/scale': '1', 'GridShape/shape': '0'
    } }).params.grid))()`).then(JSON.parse);
    check('a grid preset imports its cells, not a round brush',
        grid && grid.w === 25 && grid.h === 20 && grid.div === 2 && grid.shape === 0, JSON.stringify(grid));
    check('a hatching preset imports its lines, not a round brush',
        hat.h && hat.h.angle === -60 && hat.h.separation === 6 && hat.h.thickness === 4 && hat.h.ox === 50 &&
            hat.h.intervals === 3 && hat.h.style === 'perpendicular' && !hat.h.xs && hat.h.whole && hat.h.thick.v === 0.5 && hat.h.sep.src === 'pressure' &&
            !/hatchingbrush/.test(hat.w.join(' ')),
        JSON.stringify(hat));
    const hstyle = await page.eval(`(() => JSON.stringify([
        { 'Hatching/bool_nocrosshatching': 'false', 'Hatching/bool_moirepattern': 'true', PressureCrosshatching: 'true',
          CrosshatchingUseCurve: 'true', CrosshatchingSensor: '<params id="fuzzy"> <curve>0,0;1,1;</curve> </params>' },
        { 'Hatching/bool_perpendicular': 'true' }
    ].map(params => { const h = BrushPack.toPreset({ paintop: 'hatchingbrush', name: 'H', params }); return [h.params.hatch.style, h.params.hatch.xs, h.warnings]; })))()`).then(JSON.parse);
    check("a hatching preset's moire style imports with its crosshatching sensor, and one that never unticks 'none' has none, as in Krita",
        hstyle[0][0] === 'moirepattern' && hstyle[0][1].src === 'random' && !hstyle[0][2].some(w => /hatch/.test(w)) && hstyle[1][0] === null,
        JSON.stringify(hstyle));

    /* A Krita tip can be read as coverage, as lightness, as a gradient, or
     * painted as it stands. Three of the four are what the engine does with
     * a tip's pixels; the gradient one has no gradient to read. */
    const appn = await page.eval(`(() => {
        const mk = (n) => BrushPack.toPreset({ name: 'x', params: {
            brush_definition: '<Brush type="brush_tip" brushApplication="' + n +
                '" filename="t.png" scale="1" spacing="0.1"/>'
        } }, { tipSize: 30 });
        return JSON.stringify([0, 1, 2, 3].map((n) => {
            const t = mk(n);
            return [t.params.tipMode || 'alpha', t.warnings.join(' | ')];
        }));
    })()`).then(JSON.parse);
    check('a tip read as plain coverage stays a cut-out',
        appn[0][0] === 'alpha' && !/tip/.test(appn[0][1]), appn[0].join(' | '));
    check('a lightness-mapped tip comes across as one',
        appn[1][0] === 'lightness', appn[1].join(' | '));
    check('...and so does one that paints its own colours',
        appn[3][0] === 'color', appn[3].join(' | '));
    check('the one we cannot do -- reading a gradient -- still says so',
        appn[2][0] === 'alpha' && /gradient/.test(appn[2][1]), appn[2].join(' | '));
    /* RGBA Rake: a darken mask whose tines turn with the drawing angle. */
    const rk = await page.eval(`BrushPack.toPreset({ name: 'x', params: {
        brush_definition: '<Brush type="auto_brush" spacing="0.1"><MaskGenerator id="default" diameter="30" ratio="1" hfade="1" vfade="1" spikes="2" type="circle"/></Brush>',
        'MaskingBrush/Enabled': 'true', 'MaskingBrush/MaskingCompositeOp': 'darken',
        'MaskingBrush/Preset/brush_definition': '<Brush type="gbr_brush" filename="rake.png" scale="1" spacing="0.1"/>',
        'MaskingBrush/Preset/PressureRotation': 'true',
        'MaskingBrush/Preset/RotationSensor': '<params id="drawingangle"/>' } }, { tipSize: 30 }).params`);
    check("a Krita darken mask comes across as one, its tip turned along the line",
        rk.maskOp === 'min' && rk.maskAlong === true, JSON.stringify([rk.maskOp, rk.maskAlong]));
    /* Krita 2 stored scatter as Scattering/Amount (Aquarelle Paint); Krita
     * still reads it when ScatterValue is missing. */
    const aq = await page.eval(`BrushPack.toPreset({ name: 'x', params: {
        brush_definition: '<Brush type="auto_brush" spacing="0.1"><MaskGenerator id="default" diameter="30" ratio="1" hfade="1" vfade="1" spikes="2" type="circle"/></Brush>',
        PressureScatter: 'true', 'Scattering/Amount': '2.5' } }, { tipSize: 30 }).params.scatter`);
    check("a Krita 2 preset's Scattering/Amount still scatters", aq === 250, String(aq));
    /* A colour smudge that stores no opacity curve box reads it ticked, as
     * Krita does, though PressureOpacity says false (Aquarelle Paint); a
     * pixel brush stored the same way stays flat. */
    const op = await page.eval(`JSON.stringify(['colorsmudge', 'paintbrush'].map(id => BrushPack.toPreset({ name: 'x', paintop: id, params: {
        brush_definition: '<Brush type="auto_brush" spacing="0.1"><MaskGenerator id="default" diameter="30" ratio="1" hfade="1" vfade="1" spikes="2" type="circle"/></Brush>',
        PressureOpacity: 'false', OpacitySensor: '<params id="pressure"><curve>0,0;1,1;</curve></params>' } }, { tipSize: 30 }).params.dabOpacitySrc || null))`).then(JSON.parse);
    check('a colour smudge with no opacity curve box follows pressure, a pixel brush does not',
        op[0] === 'pressure' && op[1] === null, JSON.stringify(op));
    /* Krita 4 wrote lightness as its own flag, and its ratio option at a
     * fixed strength squashes the tip with no curve at all (RGBA Impasto:
     * preserveLightness="1", ratio 0.68 with the curve box clear). An RGBA
     * tip read as lightness keeps the file's own alpha, its greys the
     * shading: read dark-as-ink, Impasto's grey paint was 0.87 of Krita's. */
    const k4 = await page.eval(`(async () => {
        const t = BrushPack.toPreset({ name: 'x', params: {
            brush_definition: '<Brush type="gbr_brush" preserveLightness="1" ColorAsMask="1" filename="t.gih" scale="1" spacing="0.1"/>',
            PressureRatio: 'true', RatioUseCurve: 'false', RatioValue: '0.5' } }, { tipSize: 30 });
        const g = new Uint8Array(34), v = new DataView(g.buffer);
        [30, 2, 1, 1, 4].forEach((n, i) => v.setUint32(i * 4, n)); g.set([71, 73, 77, 80], 20); v.setUint32(24, 10);
        g.set([120, 0, 128, 128, 128, 255], 28);   // a name, then one grey pixel, wholly opaque
        const alpha = async (o) => {
            const s = await BrushPack.tipStrip(g, 't.gbr', o), bmp = await createImageBitmap(await (await fetch(s.url)).blob());
            const c = new OffscreenCanvas(1, 1), x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
            return x.getImageData(0, 0, 1, 1).data[3];
        };
        return JSON.stringify([t.params.tipMode, t.params.aspectRatio, await alpha({ krita: true }), await alpha({ krita: true, ownAlpha: true })]);
    })()`, { awaitPromise: true }).then(JSON.parse);
    check("a Krita 4 preset's lightness flag reads its tip as lightness",
        k4[0] === 'lightness', JSON.stringify(k4));
    check("...its ratio's strength squashes the tip with the curve box clear",
        k4[1] === 2, JSON.stringify(k4));
    check('...and its RGBA tip keeps its own alpha as lightness, where a coverage tip reads grey as half ink',
        k4[2] > 120 && k4[2] < 135 && k4[3] === 255, JSON.stringify(k4));

    /* Krita's colour rules, found painting in colour over painted blocks
     * (bank.mjs --scene): each case is a Krita preset's settings, a stroke,
     * and the pixel Krita's rule gives. */
    const kc = await page.eval(`(() => {
        const app = PaintApp, b = app.brush, ctx = app.layerMgr.layers[app.layerMgr.activeIdx].ctx;
        const clock = performance.now; let tick = 0; performance.now = () => tick;
        const tip = '<Brush type="auto_brush" spacing="0.1"><MaskGenerator id="default" diameter="20" ratio="1" hfade="1" vfade="1" spikes="2" type="circle"/></Brush>';
        const paint = (paintop, params, under, pts, pr) => {
            b.PRESETS.__kc = Object.assign({}, BrushPack.toPreset({ name: '__kc', paintop, params: Object.assign({ brush_definition: tip }, params) }, { tipSize: 20 }).params);
            b.loadPreset('__kc');
            ctx.clearRect(0, 0, 200, 100);
            if (under) { ctx.fillStyle = under; ctx.fillRect(0, 0, 200, 100); }
            b.beginStroke(pts[0][0], pts[0][1], pr, '#dc6e1e');
            for (const [x, y] of pts.slice(1)) { tick += 2; b.moveStroke(x, y, pr, '#dc6e1e'); }
            b.endStroke();
            return Array.from(ctx.getImageData(100, 50, 1, 1).data);
        };
        const line = [[60, 50], [70, 50], [80, 50], [90, 50], [100, 50], [110, 50], [120, 50], [130, 50], [140, 50]];
        const ring = Array.from({ length: 40 }, (_, i) => [100 + 8 * Math.cos(i / 6), 50 + 8 * Math.sin(i / 6)]);
        try {
            app.config.c2 = '#000000';
            const up = { PaintOpAction: '1', OpacityValue: '0.5', PressureOpacity: 'false', OpacityUseCurve: 'false' };
            const r = {
                add: paint('paintbrush', Object.assign({ CompositeOp: 'add' }, up), null, line, 1),
                mult: paint('paintbrush', Object.assign({ CompositeOp: 'multiply' }, up), '#808080', line, 1),
                union: paint('paintbrush', { CompositeOp: 'add', OpacityValue: '0.5', PressureOpacity: 'false', OpacityUseCurve: 'false' }, 'rgba(220,110,30,0.5)', [[100, 50], [100.5, 50]], 1),
                mix: paint('paintbrush', { PressureMix: 'true', MixUseCurve: 'true', MixSensor: '<params id="pressure"><curve>0,0;1,1;</curve></params>' }, null, line, 0.5),
                normal: paint('tangentnormal', {}, null, line, 1)
            };
            paint('sketchbrush', { 'Sketch/randomRGB': 'true', 'Sketch/probability': '1', 'Sketch/offset': '0', 'Sketch/lineWidth': '1' }, null, ring, 1);
            const d = ctx.getImageData(80, 30, 40, 40).data;
            r.chrome = 0;
            for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && Math.abs(d[i] - 220) + Math.abs(d[i + 1] - 110) > 40) r.chrome++;
            return JSON.stringify(r);
        } finally { performance.now = clock; delete b.PRESETS.__kc; b.loadPreset('Round'); }
    })()`).then(JSON.parse);
    check('build-up in add: each dab adds onto the last, so the stroke burns past its colour',
        kc.add[1] > 150 && kc.add[0] >= 250, JSON.stringify(kc.add));
    check('build-up in multiply: each dab multiplies the last, darker than one pass of the colour',
        kc.mult[0] < 100, JSON.stringify(kc.mult));
    check("add's cover is a union: half paint over half paint is 3/4, not full",
        kc.union[3] > 180 && kc.union[3] < 200, JSON.stringify(kc.union));
    check("Mix goes from the background colour toward the paint as pressure rises: half pressure is half the orange",
        kc.mix[0] > 95 && kc.mix[0] < 125, JSON.stringify(kc.mix));
    check("a tangent normal paints the upright pen's normal, 127,127,255, not the paint",
        kc.normal.slice(0, 3).join() === '127,127,255', JSON.stringify(kc.normal));
    check("chrome's random colour shades its lines away from the paint",
        kc.chrome > 20, JSON.stringify(kc.chrome));

    /* Wet wash (Clip Studio multiply + colour mixing) darkens faster than plain multiply as strokes
     * stack: light blue's green 255 -> 236 -> 218 -> 192 -> 159 over four strokes in Clip Studio;
     * plain multiply gets 184 on the fourth, a brush that also takes up the canvas colour 150-160. */
    const ww = await page.eval(`(() => {
        const app = PaintApp, b = app.brush, ctx = app.layerMgr.layers[app.layerMgr.activeIdx].ctx;
        const clock = performance.now; let tick = 0; performance.now = () => tick;
        try {
            b.PRESETS.__w = Object.assign({}, b.DEFAULTS, { size: 30, spacing: 5, hardness: 100, flow: 100, opacity: 100, blendMode: 'multiply', mixAlpha: 50, mixColor: 70, mixStretch: 10 });
            b.loadPreset('__w');
            ctx.clearRect(0, 0, 300, 100);
            const g = [];
            for (let k = 0; k < 4; k++) {
                b.beginStroke(40, 50, 1, '#bfebff');
                for (let x = 41; x <= 200; x++) { tick += 2; b.moveStroke(x, 50, 1, '#bfebff'); }
                b.endStroke();
                const d = ctx.getImageData(120, 50, 1, 1).data;
                g.push(Math.round(d[3] / 255 * d[1] + (1 - d[3] / 255) * 255));
            }
            return JSON.stringify(g);
        } finally { performance.now = clock; delete b.PRESETS.__w; b.loadPreset('Round'); }
    })()`).then(JSON.parse);
    check("a multiply mixing brush stacks darker than plain multiply: light blue's green after 4 strokes is 130-175, not 184",
        ww[3] > 130 && ww[3] < 175 && ww[3] < ww[2] && ww[2] < ww[1], JSON.stringify(ww));

    /* Clip Studio's Wet wash edge: ten strokes over one another leave a soft edge no wider than one stroke
     * (its alpha does not pile up), and what is there is as dark as the middle, not a purple fringe. */
    const we = await page.eval(`(() => {
        const app = PaintApp, b = app.brush, ctx = app.layerMgr.layers[app.layerMgr.activeIdx].ctx;
        const clock = performance.now; let tick = 0; performance.now = () => tick;
        try {
            b.PRESETS.__w = Object.assign({}, b.DEFAULTS, { size: 30, spacing: 5, hardness: 0, flow: 100, opacity: 100, blendMode: 'multiply', mixAlpha: 50, mixColor: 70, mixStretch: 10 });
            b.loadPreset('__w');
            ctx.clearRect(0, 0, 300, 100);
            const out = [];
            for (let k = 0; k < 10; k++) {
                b.beginStroke(40, 50, 1, '#912dcd');
                for (let x = 41; x <= 200; x++) { tick += 2; b.moveStroke(x, 50, 1, '#912dcd'); }
                b.endStroke();
                if (k === 0 || k === 9) { let best = null; for (let y = 30; y < 50; y++) { const d = ctx.getImageData(120, y, 1, 1).data; if (d[3] > 40 && d[3] < 200) { best = [d[3], d[0], d[1], d[2]]; break; } } out.push(best); }
            }
            return JSON.stringify(out);
        } finally { performance.now = clock; delete b.PRESETS.__w; b.loadPreset('Round'); }
    })()`).then(JSON.parse);
    check("a multiply mixing brush's thin edge keeps its alpha across strokes but darkens: first partly covered row, strokes 1 and 10",
        we[0] && we[1] && we[1][0] < we[0][0] * 2 + 20 && we[1][2] < we[0][2] * 0.5, JSON.stringify(we));

    /* A deform brush dabs every spacing along the path and pushes by the
     * distance since the dab before; a push read at every input point is
     * under half a pixel and moves nothing. What it drags keeps its colour. */
    const dfm = await page.eval(`(() => {
        const app = PaintApp, b = app.brush, ctx = app.layerMgr.layers[app.layerMgr.activeIdx].ctx;
        const clock = performance.now; let tick = 0; performance.now = () => tick;
        try {
            b.PRESETS.__d = Object.assign({}, b.DEFAULTS, { engineKind: 'deform', deformAction: 'move', deformAmount: 30, deformBilinear: true, size: 50, spacing: 15, shape: 'circle' });
            b.loadPreset('__d');
            ctx.clearRect(0, 0, 300, 100); ctx.fillStyle = '#c82828'; ctx.fillRect(60, 30, 120, 40);
            b.beginStroke(30, 50, 1, '#000000');
            for (let x = 31; x <= 200; x++) { tick += 2; b.moveStroke(x, 50, 1, '#000000'); }
            b.endStroke();
            return JSON.stringify([Array.from(ctx.getImageData(186, 50, 1, 1).data), Array.from(ctx.getImageData(62, 50, 1, 1).data)]);
        } finally { performance.now = clock; delete b.PRESETS.__d; b.loadPreset('Round'); }
    })()`).then(JSON.parse);
    check("a move deform drags the block's edge out, still red, not grey",
        dfm[0][3] > 200 && dfm[0][0] > 190 && dfm[0][1] < 60, JSON.stringify(dfm[0]));
    check('...and leaves the edge it started from a little hollow', dfm[1][3] < 255, JSON.stringify(dfm[1]));

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

    /* Two presets lifted straight out of Krita's own Extras pack, which is
     * built on top of Krita's default resources and so names a tip and a
     * pattern that are not inside it. Hand-written fixtures never showed
     * this: a real pack does it constantly, and it used to cost a brush. */
    console.log('== a pack that leans on Krita' + "'" + 's own resources ==');
    const borrowed = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        const r = await PaintApp.brush.importFiles([window.__files['borrowed-tip.bundle']]);
        const notes = [];
        for (const n of PaintApp.brush.userPresetNames()) {
            const p = PaintApp.brush.PRESETS[n];
            notes.push({ name: n, tip: p._tipUrl || null, texture: p.texture || 0 });
        }
        return JSON.stringify({ r, notes });
    })()`, { awaitPromise: true }).then(JSON.parse);
    console.log('  ' + JSON.stringify(borrowed));

    check('a brush whose tip is only named, not carried, still arrives',
        borrowed.r.brushes === 2 && borrowed.r.failed === 0, JSON.stringify(borrowed.r));
    check('...borrowing the tip of that name we already ship',
        borrowed.notes.some(n => n.tip === 'brushes/bristle.png'),
        JSON.stringify(borrowed.notes.map(n => n.tip)));
    check('a texture we cannot find leaves the brush grainy, not smooth',
        borrowed.notes.some(n => n.texture > 0),
        JSON.stringify(borrowed.notes.map(n => n.texture)));
    const dflt = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        const r = await PaintApp.brush.importFiles([window.__files['default-tip.kpp']]);
        const n = PaintApp.brush.userPresetNames()[0];
        return JSON.stringify({ r, tip: n ? PaintApp.brush.PRESETS[n]._tipUrl || null : null });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check("a tip named from Krita's own default bundle comes from the copy we ship",
        dflt.r.brushes === 1 && !!dflt.tip, JSON.stringify(dflt));
    const leftover = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        const r = await PaintApp.brush.importFiles([window.__files['shapes-leftover-tip.kpp']]);
        const n = PaintApp.brush.userPresetNames()[0];
        return JSON.stringify({ r, kind: n ? PaintApp.brush.PRESETS[n].engineKind : null });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('a Shapes brush naming a tip it never uses still arrives, as a Shapes brush',
        leftover.r.brushes === 1 && leftover.kind === 'shape', JSON.stringify(leftover));
    const svgTip = await page.eval(`(async () => {
        const s = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="10" height="10"/></svg>';
        const t = await BrushPack.tipStrip(new TextEncoder().encode(s), 'half.svg', { krita: true });
        const c = document.createElement('canvas'), im = await createImageBitmap(await (await fetch(t.url)).blob());
        c.width = im.width; c.height = im.height; c.getContext('2d').drawImage(im, 0, 0);
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        return JSON.stringify({ w: im.width, h: im.height, left: d[5 * c.width * 4 + 5 * 4 + 3], right: d[5 * c.width * 4 + 15 * 4 + 3] });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('an SVG tip is drawn at its own size, ink where it is filled',
        svgTip.w === 20 && svgTip.h === 10 && svgTip.left > 200 && svgTip.right < 20, JSON.stringify(svgTip));

    /* Procreate. Two formats stacked: a ZIP holding a binary property list
     * written by NSKeyedArchiver. The fixture's plist half comes out of
     * Python's plistlib, an encoder with nothing to do with this reader, so
     * agreeing with it means agreeing with the format. */
    console.log('== a Procreate brush set ==');
    const pro = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        const r = await PaintApp.brush.importFiles([window.__files['two-brushes.brushset']]);
        const ps = {};
        for (const n of PaintApp.brush.userPresetNames()) {
            const p = PaintApp.brush.PRESETS[n];
            ps[n] = { size: p.size, spacing: p.spacing, scatter: p.scatter || 0,
                      angle: p.angle || 0, angleSrc: p.angleSrc || 'none',
                      texture: p.texture || 0, hasGrain: !!p.texturePattern,
                      hasTip: !!p._tipUrl, taperStart: p.taperStart || 0,
                      taperEnd: p.taperEnd || 0, aspectRatio: p.aspectRatio || 1,
                      sizeSrc: p.sizeSrc, flowMin: p.flowMin, opacity: p.opacity,
                      sizeCurve: p.sizeCurve, flowCurve: p.flowCurve,
                      taperTarget: p.taperTarget, smoothingMode: p.smoothingMode,
                      smoothingStabilizer: p.smoothingStabilizer,
                      hueJitter: p.hueJitter || 0, satJitter: p.satJitter || 0,
                      valJitter: p.valJitter || 0, colorJitterPer: p.colorJitterPer,
                      colorRate: p.colorRate, colorRateSrc: p.colorRateSrc,
                      tipMirror: p.tipMirror };
        }
        return JSON.stringify({ r, ps });
    })()`, { awaitPromise: true }).then(JSON.parse);
    console.log('  ' + JSON.stringify(pro.ps));

    check('both brushes in the set arrive', pro.r.brushes === 2 && pro.r.failed === 0,
        JSON.stringify(pro.r));
    const roughInk = pro.ps['Rough Ink'] || {};
    check('its shape image becomes the tip, at its own size',
        roughInk.hasTip && roughInk.size === 48, JSON.stringify(roughInk));
    check('spacing is a fraction there and a percentage here',
        roughInk.spacing === 6, `${roughInk.spacing}`);
    check('the shape angle is read as radians, not degrees',
        roughInk.angle === 45, `${roughInk.angle}`);
    check('its grain image becomes the canvas texture',
        roughInk.texture === 80 && roughInk.hasGrain, JSON.stringify(roughInk));
    check('a pressure dial of 0.5 means pressure takes it half way down',
        roughInk.sizeSrc === 'pressure' && roughInk.flowMin === 50, JSON.stringify(roughInk));
    check('roundness is how round it stays there and how long it is here',
        roughInk.aspectRatio === 2, `${roughInk.aspectRatio}`);
    check('the two taper ends are set apart, not together',
        roughInk.taperStart === 40 && roughInk.taperEnd === 20, JSON.stringify(roughInk));
    /* The trap every Krita reader here has already fallen into once: a
     * setting sitting at zero is a setting that is off, and reporting it as
     * lost buries the ones that really are. Procreate adds a second kind:
     * dials that are neutral at ONE, and settings whose names merely look
     * like features (smudgeOpacity is a remembered slider, and
     * shapeRoundnessTiltAngle is a threshold, not an angle to turn the tip
     * by). The fixture carries all three. */
    const notes = (pro.r.lines || []).join(' ');
    check('a feature that is switched off is not reported as dropped',
        !/colour mixing/.test(notes), notes);
    check('...nor one whose dial is neutral at 1', !/pen tilt/.test(notes), notes);
    check('...nor a remembered slider', !/smudge|bleed/.test(notes), notes);
    check('...and one that is switched on is', /blur/.test(notes), notes);
    check('a key that merely ends in "Angle" does not turn the tip',
        roughInk.angle === 45, `${roughInk.angle}`);

    /* The dial says how far pressure takes the size; the curve says how it
     * gets there. Reading only the dial made every Procreate brush answer
     * the pen in a straight line. */
    check('the pressure curve comes across as its own shape',
        JSON.stringify(roughInk.sizeCurve) ===
            JSON.stringify([[0, 0], [0.5, 0.8], [1, 1]]), JSON.stringify(roughInk.sizeCurve));
    check('but a curve that was never drawn on is left alone',
        roughInk.flowCurve === undefined, JSON.stringify(roughInk.flowCurve));
    check('a taper that only thins the line does not also fade it',
        roughInk.taperTarget === 'size', String(roughInk.taperTarget));
    check('StreamLine becomes the stabilizer',
        roughInk.smoothingMode === 'stabilizer' && roughInk.smoothingStabilizer === 35,
        JSON.stringify([roughInk.smoothingMode, roughInk.smoothingStabilizer]));
    check('and a blend mode we have no reference for is owned up to',
        /blend mode/.test(notes), notes);
    /* Colour that wanders is what four of these formats ask for and the
     * engine had none of. Lightness and darkness are two halves of one dial
     * there, so the larger is the one that counts. */
    check('colour jitter comes across, per dab',
        roughInk.hueJitter === 45 && roughInk.satJitter === 0 &&
        roughInk.valJitter === 40 && roughInk.colorJitterPer !== 'stroke',
        JSON.stringify([roughInk.hueJitter, roughInk.satJitter, roughInk.valJitter]));
    /* One set or the other, so a brush that asks for both has to say which
     * it lost -- and a brush that asks only per stroke gets it per stroke. */
    check('...and the set it could not also have is named',
        /per-stroke colour jitter/.test(notes), notes);

    const wash = pro.ps['Soft Wash'] || {};
    /* Nothing from the pen, so the way it is held drives the size instead --
     * and speed, which cannot also drive it, stays in the warnings. */
    check('a brush the pen does not drive can still be driven by tilt',
        wash.sizeSrc === 'tilt', String(wash.sizeSrc));
    check('and the driver that lost still says so',
        /speed-driven/.test(notes), notes);
    check('a brush that only wanders per stroke wanders per stroke',
        wash.satJitter === 60 && wash.colorJitterPer === 'stroke',
        JSON.stringify([wash.satJitter, wash.colorJitterPer]));
    check('...and nothing is reported lost for it',
        !/per-dab colour jitter/.test(notes), notes);
    /* Procreate's wet mix says how much of the canvas comes in; ours says
     * how much of the brush's own colour stays, which is the same dial read
     * the other way up. */
    check('a brush that mixes with the canvas mixes here too',
        wash.colorRate === 25 && wash.colorRateSrc === 'pressure',
        JSON.stringify([wash.colorRate, wash.colorRateSrc]));
    check('...and a dab flipped at random every time it lands still is',
        wash.tipMirror === 'h', String(wash.tipMirror));
    check('neither is reported as dropped any more',
        !/colour mixing/.test(notes) && !/shape flipping/.test(notes), notes);
    check('a brush with no grain gets no texture',
        wash.texture === 0 && !wash.hasGrain, JSON.stringify(wash));
    check('a randomised shape angle turns the tip per dab',
        wash.angleSrc === 'random', JSON.stringify(wash));

    /* And the same reader against a file we did not write. Seed.brush is a
     * real Brush.archive: around two hundred keys, most of them sitting at
     * their defaults. It is here because the generated fixture above can
     * only prove we agree with ourselves about what the keys are called. */
    console.log('== a .brush from outside this repo ==');
    const seed = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        const r = await PaintApp.brush.importFiles([window.__files['seed-csp2pc.brush']]);
        const n = PaintApp.brush.userPresetNames()[0];
        const p = n ? PaintApp.brush.PRESETS[n] : {};
        return JSON.stringify({ r, name: n, angle: p.angle || 0, hasTip: !!p._tipUrl,
                                flowSrc: p.flowSrc, sizeSrc: p.sizeSrc });
    })()`, { awaitPromise: true }).then(JSON.parse);
    console.log('  ' + JSON.stringify(seed));

    check('a real .brush installs', seed.r.brushes === 1 && seed.r.failed === 0,
        JSON.stringify(seed.r));
    check('its Shape.png becomes the tip', seed.hasTip, JSON.stringify(seed));
    check('a brush with no rotation set is not turned', seed.angle === 0, `${seed.angle}`);
    check('pressure drives its opacity and not its size',
        seed.flowSrc === 'pressure' && seed.sizeSrc === 'none', JSON.stringify(seed));
    /* Two hundred keys at their defaults must produce no complaints at all.
     * The pattern-matching version of this reader found five features in
     * this file, every one of them a default it had misread. */
    check('a file full of defaults reports nothing as dropped',
        !(seed.r.lines || []).some(l => /dropped/.test(l)),
        JSON.stringify(seed.r.lines || []));

    /* Clip Studio. The file is a SQLite database, so most of this is really
     * checking a hand-rolled SQLite reader: the fixture's blobs are far
     * bigger than a page, which is the case that has to chain overflow pages
     * back together, and its defaults row is written before its live one. */
    console.log('== a Clip Studio sub tool ==');
    const sut = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        const r = await PaintApp.brush.importFiles([window.__files['rough-scrape.sut']]);
        const n = PaintApp.brush.userPresetNames()[0];
        const p = n ? PaintApp.brush.PRESETS[n] : {};
        let tipW = 0, tipH = 0;
        if (p._tipUrl) {
            const bmp = await createImageBitmap(await (await fetch(await PaintApp.brush.tipUrl(p._tipUrl))).blob());
            tipW = bmp.width; tipH = bmp.height;
        }
        return JSON.stringify({ r, name: n, tipW, tipH, hasTex: !!p.texturePattern,
            size: p.size, flow: p.flow, spacing: p.spacing, aspectRatio: p.aspectRatio,
            angle: p.angle, scatter: p.scatter || 0, taperStart: p.taperStart || 0,
            taperEnd: p.taperEnd || 0, texture: p.texture || 0,
            colorRate: p.colorRate, smudgeLength: p.smudgeLength,
            smudgeRadius: p.smudgeRadius, watercolor: p.watercolor, wetBlend: p.wetBlend,
            flowSrc: p.flowSrc, flowCurve: p.flowCurve, flowMin: p.flowMin,
            sizeSrc: p.sizeSrc, sizeCurve: p.sizeCurve, sizeMin: p.sizeMin, sizeSensors: p.sizeSensors, speedMax: p.speedMax, speedPerReport: p.speedPerReport, scatterSensors: p.scatterSensors,
            tipCells: p.tipCells || 1, has2: !!p._tip2Url,
            tip2Depth: p.tip2Depth || 0, tip2Size: p.tip2Size || 0,
            tip2Spacing: p.tip2Spacing || 0, tip2Angle: p.tip2Angle || 0,
            scatterSrc: p.scatterSrc, hueJitter: p.hueJitter || 0,
            satJitter: p.satJitter || 0, valJitter: p.valJitter || 0,
            colorJitterPer: p.colorJitterPer, secondOp: p.second ? p.second.op : null });
    })()`, { awaitPromise: true }).then(JSON.parse);
    console.log('  ' + JSON.stringify(sut));

    check('a .sut installs', sut.r.brushes === 1 && sut.r.failed === 0, JSON.stringify(sut.r));
    check('the sub tool keeps its name', sut.name === 'Rough Scrape', `${sut.name}`);
    /* Pointillism's colour change shows about a quarter in Clip Studio when the brush sprays and mixes; Pastel's (mixes, no spray) shows whole. */
    const msj = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        const out = [];
        for (const f of ['rough-scrape.sut', 'mix-spray-scrape.sut']) {
            await PaintApp.brush.importFiles([window.__files[f]]);
            const p = PaintApp.brush.PRESETS[PaintApp.brush.userPresetNames()[0]];
            out.push([p.hueJitter, p.satJitter]);
            for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        }
        return JSON.stringify(out);
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('a spraying mixing brush takes a quarter of its colour jitter, a plain spray all of it',
        msj[0][0] === 30 && msj[0][1] === 20 && msj[1][0] === 8 && msj[1][1] === 5, JSON.stringify(msj));

    /* Composite mode 2 is Multiply with colour mixing off: zb132 dry, ten strokes stack to
     * (18,11,141) in Clip Studio. With mixing on they stay the ink colour, (98,73,217). */
    const mul = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        const mode = async (f) => {
            for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
            await PaintApp.brush.importFiles([window.__files[f]]);
            return PaintApp.brush.PRESETS[PaintApp.brush.userPresetNames()[0]].blendMode || 'normal';
        };
        const a = await mode('multiply-dry.sut'), w = await mode('multiply-scrape.sut');
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        await PaintApp.brush.importFiles([window.__files['rough-scrape.sut']]);
        return JSON.stringify([a, PaintApp.brush.PRESETS[PaintApp.brush.userPresetNames()[0]].blendMode || 'normal', w]);
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('Clip Studio composite mode 2 imports as multiply unless it mixes, mode 0 stays normal', mul[0] === 'multiply' && mul[1] === 'normal' && mul[2] === 'normal', JSON.stringify(mul));
    /* Start and end only taper what the in/out target flags: G-pen ticks both boxes and flags
     * nothing, full width in Clip Studio. Flagged, the size runs up from its floor. */
    const tap = await page.eval(`(async () => {
        const get = async (f) => {
            for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
            await PaintApp.brush.importFiles([window.__files[f]]);
            const p = PaintApp.brush.PRESETS[PaintApp.brush.userPresetNames()[0]];
            return [p.taperStart || 0, p.taperEnd || 0, p.taperUnit || '', p.taperFloor || null, p.taperTarget || ''];
        };
        const r = [await get('taper-unflagged.sut'), await get('taper-lens.sut')];
        await get('rough-scrape.sut');   // the tests below paint with it
        return JSON.stringify(r);
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('Clip Studio start/end taper only when its target is flagged, from its floor',
        tap[0][0] === 0 && tap[0][1] === 0 && tap[1][0] === 80 && tap[1][1] === 80 && tap[1][2] === 'stroke' &&
        tap[1][3] && tap[1][3][0] === 0.5 && tap[1][3][1] === 0 && tap[1][4] === 'size', JSON.stringify(tap));
    /* Clip Studio stores a real diameter, unlike Procreate, so the size is
     * the brush's own and not the tip image's. This one sprays, so each
     * dab is a particle of its spray size (14.1) over an 80px patch. */
    check('the size is the brush' + "'" + 's, not the tip image' + "'" + 's',
        sut.size === 14 && sut.tipH === 96, JSON.stringify(sut));
    /* Which material is which is settled by the catalogue path both the
     * material row and the brush's reference carry -- and the fixture
     * stores them in the wrong order on purpose, paper last, so a reader
     * that counted rows would paint with the paper here. */
    check('the two tip materials come out as a strip of two',
        sut.tipCells === 2 && sut.tipW === 192 && sut.tipH === 96,
        `${sut.tipW}x${sut.tipH} in ${sut.tipCells}`);
    check('and the paper texture is found by name, not by its place',
        sut.hasTex && sut.texture === 50, JSON.stringify(sut));
    /* The live settings, not the ones the brush resets to — and those are
     * written into the file first, so reading "the first row" fails here. */
    check('the live settings win over the reset-to defaults',
        sut.angle === 220, JSON.stringify(sut));
    /* Thickness squeezes an image tip too (measured in Clip Studio on Real
     * G-Pen's picture); this one's flag says side to side, so 16% thick
     * is 0.16 of its width. */
    check('thickness squeezes an image tip side to side',
        sut.aspectRatio === 0.16, JSON.stringify(sut));
    check('spray is a patch there and a spread of particles here',
        sut.scatter === 286, `${sut.scatter}`);
    /* Clip Studio's starting and ending is not our taper: real Clip Studio
     * draws a mouse stroke of G-pen full width to both ends. */
    check('its starting and ending never becomes our taper',
        !sut.taperStart && !sut.taperEnd, JSON.stringify(sut));
    /* Deliberately NOT mapped onto our smudge, which is what it looks like it
     * should be: measured against real Clip Studio, a white stroke laid over
     * an existing one leaves that stroke untouched, so its mixing does not
     * contaminate the colour a dab deposits -- and our smudge does exactly
     * that. Mapping the two together drank a fresh document's white
     * background into every dab. Named instead of substituted. */
    check('watercolour mixing is owned up to, not turned into our smudge',
        sut.colorRate === undefined && sut.smudgeLength === undefined &&
        (sut.r.lines || []).some(l => /mixes with colour already on the canvas/.test(l)),
        JSON.stringify(sut));
    /* ...and the brush is marked so the engine lays a wash instead of ink. */
    check('watercolour mixing marks the brush for the wash curve',
        sut.watercolor === 1, JSON.stringify(sut));
    /* ...and so one wet stroke cannot darken itself where it overlaps: only
     * new coverage lands (W1). */
    check('watercolour mixing switches on wet blending',
        sut.wetBlend === 1, JSON.stringify(sut));
    /* How far it reaches for the colour it mixes went with the mixing: with
     * nothing gathering that colour, a reach is a dial on nothing. */
    check('and the reach it gathered that colour over goes with it',
        sut.smudgeRadius === undefined, String(sut.smudgeRadius));

    /* Clip Studio keeps the way a dial answers the pen in a blob of its own:
     * a 48-byte header (which inputs are on, each one's floor, each curve's
     * length) and the curves. Our first reader took it for 44 bytes and
     * never read one, so every .sut arrived as a flat stroke. The curve is
     * the file's, points and all. */
    check('flow follows the pen, along the curve the file drew',
        sut.flowSrc === 'pressure' && sut.flowMin === 0 && JSON.stringify(sut.flowCurve) ===
            JSON.stringify([[0, 0], [0.25, 0.6], [1, 1]]), JSON.stringify(sut.flowCurve));
    /* Two inputs multiply, each curve lifted by its own floor; speed reads
     * as ours does (0 standing still), so this spray gathers in as it speeds up.
     * Full speed is 97.5px a report, counted per report and not per ms: a Clip
     * Studio stroke of 11.4px moves read 0.117 however long each move took. */
    check('a dial driven by two things keeps both, each over its floor',
        sut.scatterSrc === 'none' && JSON.stringify(sut.scatterSensors) === JSON.stringify([
            { src: 'pressure', curve: [[0, 0.28], [1, 1]] },
            { src: 'speed', curve: [[0, 1], [1, 0.5]] }]) && sut.speedMax === 97.5 && sut.speedPerReport === true,
        JSON.stringify([sut.scatterSrc, sut.scatterSensors, sut.speedMax, sut.speedPerReport]));
    check('an input we cannot name drives nothing',
        sut.sizeSrc === 'none' && !sut.sizeSensors, String(sut.sizeSrc));
    /* Colour change is a range either side of the colour there, and a
     * negative range is still a range. */
    check('its colour change becomes colour that wanders',
        sut.hueJitter === 30 && sut.satJitter === 20 && sut.valJitter === 0 &&
        sut.colorJitterPer !== 'stroke',
        JSON.stringify([sut.hueJitter, sut.satJitter, sut.valJitter]));
    const sutNotes = (sut.r.lines || []).join(' ');
    check('and the per-stroke set it could not also have is named',
        /per-stroke colour shifting/.test(sutNotes), sutNotes);
    check('and the rules we could not place are counted, not swallowed',
        /an unknown rule that changes its spray/.test(sutNotes), sutNotes);
    check('a setting that is switched on is reported', /blur/.test(sutNotes), sutNotes);
    check('...and one that is off is not', !/ribbon/.test(sutNotes), sutNotes);

    /* The second tip. Clip Studio's is a brush of its own -- its own
     * picture, size, spacing and turn -- and until now the whole Dual
     * column family was one line of apology. Size is in pixels there and a
     * share of the brush here: 30 against 80 is 38%. */
    check('the second tip arrives as a picture of its own',
        sut.has2, JSON.stringify(sut));
    /* Its mode 3 takes the second brush's whole stroke off the first's
     * (Dappled light, measured in Clip Studio), so it is a brush of its own,
     * not carved with as it used to be. */
    check('...and a second brush that subtracts is a brush of its own, not carved with',
        sut.tip2Depth === 0 && sut.secondOp === 'subtract', JSON.stringify(sut.secondOp));

    const sutInk = await page.eval(`(async () => {
        const app = PaintApp, br = app.brush;
        app.layerMgr.collapseToBase({ fresh: true });
        app.setSize(300, 120); app.config.zoom = 1; app.updateBounds();
        document.getElementById('lsys-add').click();
        app.state.selection = null;
        const L = app.layerMgr.layers[app.layerMgr.activeIdx];
        br.loadPreset('Rough Scrape');
        await new Promise(r => setTimeout(r, 500));
        br.beginStroke(40, 60, 1, '#000000');
        for (let x = 46; x <= 260; x += 6) br.moveStroke(x, 60, 1, '#000000');
        br.endStroke();
        const d = L.ctx.getImageData(0, 0, 300, 120).data;
        let ink = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 8) ink++;
        return ink;
    })()`, { awaitPromise: true });
    check('the imported Clip Studio brush paints', sutInk > 500, `${sutInk} pixels`);

    /* The second tip has to actually reach the paper: the same dab with it
     * turned off covers more. */
    const sutCarve = await page.eval(`(async () => {
        const app = PaintApp, br = app.brush;
        app.layerMgr.collapseToBase({ fresh: true });
        app.setSize(300, 300); app.config.zoom = 1; app.updateBounds();
        br.loadPreset('Rough Scrape');
        await new Promise(r => setTimeout(r, 400));
        const one = async (depth) => {
            app.ctx.clearRect(0, 0, 300, 300);
            br.setParam('tip2Depth', depth); br.setParam('size', 120); br.setParam('scatter', 0);
            // Two tip pictures, picked at random: pin the seed so the two
            // dabs differ only by the second tip.
            br._setStrokeSeed(7);
            br.beginStroke(150, 150, 1, '#000000');
            br.endStroke();
            await new Promise(r => setTimeout(r, 150));
            const d = app.ctx.getImageData(80, 80, 140, 140).data;
            let n = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
            return n;
        };
        const off = await one(0), on = await one(100);
        br._setStrokeSeed(null);
        br.forgetSaved('Rough Scrape'); br.loadPreset('Round');
        return JSON.stringify([off, on]);
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('and the second tip bites a hole in the dab',
        sutCarve[1] < sutCarve[0] * 0.8, JSON.stringify(sutCarve));

    /* Not every .sut is a brush. A fill or a selection tool is stored the
     * same way and has no brush settings at all, so importing one would
     * invent a plain round brush out of a tool that never painted. */
    const sutTool = await page.eval(`(async () => {
        const r = await PaintApp.brush.importFiles([window.__files['pixel-select.sut']]);
        return JSON.stringify(r);
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('a Clip Studio tool that is not a brush is refused, and says why',
        sutTool.brushes === 0 && /tool rather than a brush/.test(JSON.stringify(sutTool)),
        JSON.stringify(sutTool));

    /* Dot pen keeps no size at all, only its opacity and flow, and Clip
     * Studio paints it a pixel a column: the pixel the line is in where it
     * crosses the column's middle (cdp-csp/qd, every pixel of two slants
     * drawn from whole-pixel mouse reports). */
    const dot = await page.eval(`(async () => {
        const app = PaintApp, br = app.brush;
        const r = await br.importFiles([window.__files['dot-pen.sut']]);
        app.layerMgr.collapseToBase({ fresh: true });
        app.setSize(300, 120); app.config.zoom = 1; app.updateBounds();
        app.state.selection = null;
        br.loadPreset('Dot pen');
        await new Promise(r => setTimeout(r, 400));
        app.ctx.clearRect(0, 0, 300, 120);
        const P = [];
        for (let i = 0; i <= 20; i++) P.push([20 + Math.trunc(200 * i / 20 + i % 3 * 0.4), 30 + Math.trunc(67 * i / 20)]);
        br.beginStroke(P[0][0], P[0][1], 1, '#000000');
        for (const [x, y] of P.slice(1)) br.moveStroke(x, y, 1, '#000000');
        br.endStroke();
        await new Promise(r => setTimeout(r, 200));
        const d = app.ctx.getImageData(0, 0, 300, 120).data;
        let bad = 0, grey = 0, n = 0;
        for (let c = 20; c < 220; c++) {
            const m = c + 0.5; let k = 0;
            while (P[k + 1][0] < m) k++;
            const want = Math.floor(P[k][1] + (P[k + 1][1] - P[k][1]) * (m - P[k][0]) / (P[k + 1][0] - P[k][0]));
            for (let y = 0; y < 120; y++) {
                const a = d[(y * 300 + c) * 4 + 3];
                if (a) n++;
                if (a && a < 255) grey++;
                if (!!a !== (y === want)) bad++;
            }
        }
        br.forgetSaved('Dot pen'); br.loadPreset('Round');
        return JSON.stringify({ brushes: r.brushes, bad, grey, n });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check("Clip Studio's Dot pen imports, though it keeps no size", dot.brushes === 1, JSON.stringify(dot));
    check("...and paints a solid pixel a column, the one the line is in at the column's middle",
        dot.bad === 0 && dot.grey === 0 && dot.n === 200, JSON.stringify(dot));

    /* A brush built on Clip Studio's own library stores no catalogue path:
     * the material lives in the program. Then the order is all there is,
     * and the brush has to say so rather than pretend it knew. */
    const sutLib = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        const r = await PaintApp.brush.importFiles([window.__files['library-tips.sut']]);
        const n = PaintApp.brush.userPresetNames()[0];
        const p = n ? PaintApp.brush.PRESETS[n] : {};
        return JSON.stringify({ r, cells: p.tipCells || 1, has2: !!p._tip2Url,
            tex: !!p.texturePattern, watercolor: p.watercolor, wetBlend: p.wetBlend,
            angleSrc: p.angleSrc, angleRange: p.angleRange });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('pictures with no path are taken in order',
        sutLib.cells === 2 && sutLib.has2 && sutLib.tex, JSON.stringify(sutLib));
    check('...and the brush owns up to having guessed',
        /taken from their order/.test((sutLib.r.lines || []).join(' ')),
        (sutLib.r.lines || []).join(' '));
    /* A real library brush keeps where each picture came from, and lists a
     * picture as often as it wants it picked: Droplet names its smallest
     * droplet five times in fifteen, and Clip Studio lays it 0.30 of the
     * time. Read in stored order, the paper here would be a tip. */
    const sutRep = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        const r = await PaintApp.brush.importFiles([window.__files['library-repeat.sut']]);
        const n = PaintApp.brush.userPresetNames()[0];
        const p = n ? PaintApp.brush.PRESETS[n] : {};
        return JSON.stringify({ r, cells: p.tipCells || 1, tex: !!p.texturePattern });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('a library brush takes each picture as often as it is listed, by where it came from',
        sutRep.cells === 3 && sutRep.tex && !/taken from their order/.test((sutRep.r.lines || []).join(' ')),
        JSON.stringify(sutRep));
    /* The thumbnail beside a material is a quarter of Chain's picture and a
     * thirteenth of its length; the picture itself is in the .layer, 256px
     * blocks of it, a bit a pixel here, and the tip is that. */
    const sutLayer = await page.eval(`(async () => {
        const bytes = new Uint8Array(await window.__files['layer-tip.sut'].arrayBuffer());
        const t = await BrushPack.tipStrip(BrushPack.readSut(bytes).presets[0].tips.slice(0, 1), 'tip.png', { csp: true });
        const bmp = await createImageBitmap(await (await fetch(t.url)).blob());
        const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
        const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
        const a = (x, y) => g.getImageData(x, y, 1, 1).data[3];
        return JSON.stringify({ w: t.w, h: t.h, px: [a(8, 8), a(24, 8), a(8, 24), a(300, 190), a(340, 190)] });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('a Clip Studio picture is read at its own size from the .layer, not the thumbnail',
        sutLayer.w === 384 && sutLayer.h === 200 && sutLayer.px.join() === '255,0,0,0,255', JSON.stringify(sutLayer));
    // Clip Studio fits each picture to the brush by its own longer side: the 96px second tip stands as tall as the 384px first
    const sutFit = await page.eval(`(async () => {
        const bytes = new Uint8Array(await window.__files['layer-tip.sut'].arrayBuffer());
        const t = await BrushPack.tipStrip(BrushPack.readSut(bytes).presets[0].tips, 'tip.png', { csp: true });
        return JSON.stringify({ w: t.w, h: t.h, cells: t.cells });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('...each picture fitted to the brush by its own longer side', sutFit.cells === 2 && sutFit.w === 384 && sutFit.h === 384, JSON.stringify(sutFit));
    // ...its paper too, filed away like a tip: a 1001px paper is too big for the preset itself
    const sutPaper = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        await PaintApp.brush.importFiles([window.__files['layer-tip.sut']]);
        const p = PaintApp.brush.PRESETS[PaintApp.brush.userPresetNames()[0]] || {};
        const u = await PaintApp.brush.tipUrl(p.texturePattern || '');
        const bmp = u && await createImageBitmap(await (await fetch(u)).blob());
        return JSON.stringify({ ref: String(p.texturePattern).slice(0, 4), w: bmp && bmp.width });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('...and so is its paper, kept out of the preset', sutPaper.ref === 'idb:' && sutPaper.w === 320, JSON.stringify(sutPaper));
    /* Clip Studio has three switches for mixing and they usually agree, but
     * the markers and the flat watercolour brushes leave the two obvious
     * ones off and set the third. Reading only the obvious ones imported
     * those brushes bone dry. */
    check('a brush that mixes by the third switch is still a wash',
        sutLib.watercolor === 1 && sutLib.wetBlend === 1, JSON.stringify(sutLib));
    /* The rotation dropdown is a mask, and the bit for random turns is the
     * one the file scales -- a quarter of a turn here, not the whole 180. */
    check('a tip set to turn at random does turn, by the amount asked',
        sutLib.angleSrc === 'random' && sutLib.angleRange === 45,
        JSON.stringify([sutLib.angleSrc, sutLib.angleRange]));

    /* The mappings measured against Clip Studio's own renders, one variant
     * row each, straight through the reader. */
    const sm = await page.eval(`(() => {
        const P = (v, o) => BrushPack.sutToPreset(v, 'x', o || {}).params;
        const W = (v, o) => BrushPack.sutToPreset(v, 'x', o || {}).warnings.join(' ');
        // A 48-byte effector with one curve on the tilt input.
        const eff = (mask, curve) => {
            const b = new DataView(new ArrayBuffer(48 + 12 + curve.length * 16));
            [48, 0xf0, mask, 0, 0, 0, 0, 0, 0, 12 + curve.length * 16, 0, 0]
                .forEach((x, i) => b.setUint32(i * 4, x));
            b.setUint32(48, 12); b.setUint32(52, curve.length); b.setUint32(56, 16);
            curve.forEach((p, i) => { b.setFloat64(60 + i * 16, p[0]); b.setFloat64(68 + i * 16, p[1]); });
            return new Uint8Array(b.buffer);
        };
        const tilt = P({ BrushSize: 20, BrushFlowEffector: eff(0x20, [[0, 0], [1, 1]]) });
        // Chalk's paper: on each dab, subtracted, at a random 40-100% of 80.
        const rnd = new DataView(new ArrayBuffer(48));
        [48, 0xf0, 0x80, 0, 0, 0, 40, 0, 0, 0, 0, 0].forEach((x, i) => rnd.setUint32(i * 4, x));
        const plot = P({ TextureDensity: 80, TextureCompositeMode: 2, TextureForPlot: 1, TextureScale2: 20,
                         TextureDensityEffector: new Uint8Array(rnd.buffer) }, { hasTexture: true });
        const flat = P({ BrushSize: 20, BrushThickness: 30 });
        const mm = P({ BrushSize: 5, BrushSizeUnit: 2 }), cm = P({ BrushSize: 1, BrushSizeUnit: 1 });
        const spray = P({ BrushSize: 100, BrushUseSpray: 1, BrushSpraySize: 10, BrushSprayDensity: 6 });
        const rndE = new Uint8Array(rnd.buffer), sp = { BrushSize: 100, BrushUseSpray: 1, BrushSpraySize: 10 };
        const sprayRnd = P(Object.assign({ BrushIntervalEffector: rndE, BrushThicknessEffector: rndE, BrushSprayDensityEffector: rndE }, sp));
        const plainRnd = P({ BrushIntervalEffector: rndE, BrushThicknessEffector: rndE });
        // Oil paint's thickness: speed, falling to a floor of 59 (its curve in the speed slot).
        const spdE = new DataView(new ArrayBuffer(48 + 44));
        [48, 0xf0, 0x40, 0, 0, 59, 0, 0, 0, 0, 0, 44].forEach((x, i) => spdE.setUint32(i * 4, x));
        spdE.setUint32(48, 12); spdE.setUint32(52, 2); spdE.setUint32(56, 16); spdE.setFloat64(60, 0); spdE.setFloat64(68, 1); spdE.setFloat64(76, 1); spdE.setFloat64(84, 0);
        const plainSpd = P({ BrushThicknessEffector: new Uint8Array(spdE.buffer) }, { hasTip: true, tipW: 100, tipH: 100 });
        const tallRnd = P(Object.assign({ BrushThicknessEffector: rndE, BrushVerticalThicknes: 1 }, sp), { hasTip: true, tipW: 100, tipH: 100 });
        const tallPlain = P({ BrushThicknessEffector: rndE, BrushVerticalThicknes: 1 }, { hasTip: true, tipW: 100, tipH: 100 });
        const ribRnd = P({ BrushSize: 30, BrushRibbon: 1, BrushThickness: 150, BrushThicknessEffector: rndE }, { hasTip: true, tipW: 30, tipH: 90 });
        const rib = { BrushSize: 30, BrushRibbon: 1, BrushRotation: 0 };
        const ribbon = P(rib, { hasTip: true, tipW: 30, tipH: 90 });
        const ribbonNote = W(rib, { hasTip: true, tipW: 30, tipH: 90 });
        const ribTilt = P(Object.assign({}, rib, { BrushRotation: 1, BrushSize: 10 }), { hasTip: true, tipW: 117, tipH: 300 });
        // A colour-change effector: random from floor f, or no input at all.
        const cjE = (mask, f) => { const d = new DataView(new ArrayBuffer(48));
            [48, 0xf0, mask, 0, 0, 0, f, 0, 0, 0, 0, 0].forEach((x, i) => d.setUint32(i * 4, x)); return new Uint8Array(d.buffer); };
        const cj = { BrushHueChange: 15, BrushSaturationChange: -50, BrushValueChange: 100,
            BrushHueChangeEffector: cjE(0x80, -100), BrushSaturationChangeEffector: cjE(0x80, 0), BrushValueChangeEffector: cjE(0, 0) };
        return JSON.stringify({ tilt: [tilt.flowSrc, tilt.flowCurve],
            flat: [flat.aspectRatio, flat.angle], mm: mm.size, cm: cm.size,
            spray: [spray.size, spray.scatter, spray.dabCount],
            dense: [20, 40].map(d => P(Object.assign({}, sp, { BrushSprayDensity: d })).dabCount),
            sprayHow: [spray.scatterAxis, spray.sprayEach, P({ BrushSize: 100, BrushUseSpray: 1, BrushSpraySize: 2, BrushSpraySizeUnit: 2 }).size],
            spin: [65, 1, 129].map(e => { const o = P({ BrushSize: 100, BrushUseSpray: 1, BrushSpraySize: 20, BrushThickness: 30,
                BrushRotation: 45, BrushRotationEffector: 131, BrushRotationRandomScale: 25,
                BrushRotationInSpray: 90, BrushRotationEffectorInSpray: e, BrushRotationRandomInSpray: 0 });
                return [o.angle || 0, o.angleSrc || null, o.firstDabAt || 0]; }),
            drop: (o => [o.angleSrc, !!o.aspectThinsWidth])(P({ BrushSize: 250, BrushUseSpray: 1, BrushSpraySize: 20,
                BrushRotationInSpray: 90, BrushRotationEffectorInSpray: 513, BrushThicknessEffector: rndE }, { hasTip: true, tipW: 200, tipH: 300 })),
            bias: [-100, 0, 50].map(b => P({ BrushSize: 100, BrushUseSpray: 1, BrushSpraySize: 2, BrushSprayBias: b }).sprayBias || 0),
            sprayPr: P(Object.assign({ BrushIntervalEffector: eff(0x10, [[0, 1], [1, 0]]) }, sp)).spacingSrc || 'none',
            sprayRnd: [sprayRnd.spacingSrc, sprayRnd.aspectRatioSrc, sprayRnd.dabCountSrc].map(s => s || 'none'),
            plainRnd: [plainRnd.spacingSrc, plainRnd.aspectRatioSrc].map(s => s || 'none'),
            plainSpd: [plainSpd.aspectRatioSrc, plainSpd.aspectRatioMin, !!plainSpd.aspectThinsWidth], tallRnd: [tallRnd.aspectRatioSrc || 'none', tallPlain.aspectRatioSrc || 'none'], ribRnd: ribRnd.aspectRatioSrc || 'none',
            iso: [P({ BrushAutoIntervalType: 2 }, { hasTip: true }), P({ BrushAutoIntervalType: 0 }, { hasTip: true }),
                  P({ BrushAutoIntervalType: 2 })].map(p => !!p.spacingBySize),
            byWidth: [P({ BrushSize: 100, BrushAutoIntervalType: 1 }, { hasTip: true, tipW: 100, tipH: 100 }).spacingByWidth || false,
                P({ BrushSize: 100, BrushAutoIntervalType: 1 }).spacingByWidth || false, ribbon.spacingByWidth || false],
            ribbon: [ribbon.size, +(ribbon.size * ribbon.sizeAcross).toFixed(2), ribbon.spacing, ribbon.angle, ribbon.angleSrc, ribbon.offsetAlong], ribbonNote,
            ribTilt: [ribTilt.angle, ribTilt.size, +(ribTilt.size * ribTilt.sizeAcross).toFixed(2), ribTilt.ribbonClip],
            cj: [P(cj).colorJitterRange, [P(cj).hueJitter, P(cj).satJitter, P(cj).valJitter],
                 P(Object.assign({ BrushChangePatternColor: 0 }, cj)).valJitter || 0,
                 [P(Object.assign({ BrushChangeColorTarget: 2 }, cj)).valJitter, P(Object.assign({ BrushChangeColorTarget: 2 }, cj)).jitterSub],
                 W(Object.assign({ BrushChangeColorTarget: 2 }, cj)),
                 ['[[0,1],[1,0]]', '[[0,0],[1,0.5]]'].map(k => P({ BrushValueChange: 40, BrushChangePatternColor: 1,
                     BrushValueChangeEffector: eff(0x20, JSON.parse(k)) }).valJitter || 0)],
            dual: [0, 2, 3, 5, 12].map(m => { const d = { BrushSize: 100, BrushFlow: 100, UseDualBrush: 1, DualBrushCompositeMode: m, DualSize: 76, DualFlow: 20 },
                                               sec = BrushPack.sutSecond(d);
                                           return [P(d, { hasTip2: true }).tip2Depth || 0, sec && sec.op, sec && sec.variant.BrushSize, sec && sec.variant.BrushFlow,
                                                   ['dropped: the colour its second brush blends in', 'dropped: its second brush tip'].find(t => W(d, { hasTip2: true }).includes(t)) || '',
                                                   !!(sec && sec.light), sec ? sec.variant.BrushChangePatternColor : null]; }),
            mask4: [1, 0].map(c => (BrushPack.sutSecond({ UseDualBrush: 1, DualBrushCompositeMode: 4, ChangeRGBByDual: c }) || {}).op),
            mode12: [1, 0].map(c => (BrushPack.sutSecond({ UseDualBrush: 1, DualBrushCompositeMode: 12, ChangeRGBByDual: c }) || {}).op),
            opac: [{}, { BrushBlendPatternByDarken: 1 }, { UseDualBrush: 1, DualBrushCompositeMode: 12 }, { UseDualBrush: 1, DualBrushCompositeMode: 4, ChangeRGBByDual: 0 }]
                .map(x => P(Object.assign({ BrushOpacityEffector: rndE }, x))).map(q => [q.dabOpacitySrc || 'none', q.dabOpacityAvg === false, q.flowSrc]),
            opac2: 'BrushOpacityEffector' in BrushPack.sutSecond({ UseDualBrush: 1, DualBrushCompositeMode: 4, BrushOpacityEffector: rndE }).variant,
            cycle: P({ BrushPatternOrderType: 0 }).tipPick || '', pingpong: P({ BrushPatternOrderType: 1 }).tipPick || '', random: P({ BrushPatternOrderType: 3 }).tipPick || '',
            plot: [plot.texture, plot.textureBlend, plot.textureSrc, plot.textureMin, plot.textureScale],
            paperPx: P({ TextureDensity: 70, TextureScale2: 28 }, { hasTexture: true, texReal: 1001 }).textureScale * 64 * 1.83,
            stress: [plot.textureStress || false, P({ TextureDensity: 12, TextureCompositeMode: 1, TextureForPlot: 1, TextureStressDensity: 1 }, { hasTexture: true }).textureStress],
            erase: [P({ CompositeMode: 27 }).blendMode, P({}).blendMode || 'normal'],
            gap: [0, 1, 2, 3].map(m => P({ BrushInterval: 1, BrushAutoIntervalType: m }).spacing),
            minStep: P({ BrushInterval: 1 }).minStep,
            ramp: [0, 1, 2, 3].map(a => P({ AntiAlias: a }).edgeRamp || 0),
            softGap: [P({ BrushAutoIntervalType: 2, BrushHardness: 50 }), P({ BrushAutoIntervalType: 2, BrushHardness: 50 }, { hasTip: true }),
                      P({ BrushInterval: 20, BrushHardness: 0 })].map(p => p.spacing),
            subMix: [P({ BrushSubColor: 38 }).subMix, P({ BrushSubColor: 38, BrushChangePatternColor: 0 }).subMix || 0],
            wholeAliased: [P({ AntiAlias: 0 }, { hasTip: true }).aliased, P({ AntiAlias: 0 }, { hasTip: true, tipWhole: true }).aliased].map(Boolean),
            softAliased: [P({ AntiAlias: 0, BrushHardness: 50 }).aliased, P({ AntiAlias: 0, BrushHardness: 50 }, { hasTip: true }).aliased].map(Boolean),
            fracSize: P({ BrushSize: 5.1 }).size,
            pic: [P({ BrushThickness: 85, BrushVerticalThicknes: 1 }, { hasTip: true }),
                  P({ BrushThickness: 50 }, { hasTip: true })].map(p => [p.aspectRatio, p.angle || 0]),
            stretch: [P({ BrushThickness: 150 }, { hasTip: true }), P({ BrushThickness: 150, BrushVerticalThicknes: 1 }, { hasTip: true }),
                      P({ BrushThickness: 150, BrushRibbon: 1 }, { hasTip: true, tipW: 10, tipH: 40 }), P({ BrushThickness: 150 })].map(o => o.tipStretch || null),
            adj: [5, 20, 40].map(i => P({ BrushFlow: 50, BrushInterval: i, BrushAdjustFlowByInterval: 1 }))
                .concat(P({ BrushFlow: 50, BrushInterval: 5, BrushAdjustFlowByInterval: 1, BrushRibbon: 1 }, { hasTip: true, tipW: 10, tipH: 40 }))
                .map(o => [o.flow, !!o.flowByGap]),
            paper: [[1], [2], [4], [0], [1, 1]].map(([m, r]) => P({ TextureDensity: 50, TextureCompositeMode: m, TextureReverseDensity: r || 0 }, { hasTexture: true }))
                .map(o => [o.texture || 0, o.textureStroke ?? null]),
            paperMods: (o => [o.textureBrightness, o.textureRotate, !!o.textureInvert])(P({ TextureDensity: 50, TextureCompositeMode: 1,
                TextureReverseDensity: 1, TextureBrightness: 40, TextureRotate: 45 }, { hasTexture: true })),
            darken: [P({ BrushBlendPatternByDarken: 1, BrushWaterColor: 2, BrushUseWaterEdge: 1, BrushWaterEdgeRadius: 2, BrushWaterEdgeAlphaPower: 25 }),
                     P({ BrushBlendPatternByDarken: 1, TextureDensity: 50, TextureCompositeMode: 0 }, { hasTexture: true }),
                     P({ BrushBlendPatternByDarken: 1, TextureDensity: 0, TextureCompositeMode: 0, BrushFlow: 50 }, { hasTexture: true })]
                .map(o => [!!o.dabMax, !!o.watercolor, o.edgeWidth || 0, o.texture || 0, o.textureBlend == null ? null : o.textureBlend, o.flow]),
            darkMix: !!P({ BrushBlendPatternByDarken: 1, BrushUseWaterColor: 1, BrushUseWaterColor2: 1, BrushMixColor: 70, BrushMixAlpha: 50 }).dabMax,
            picHard: [P({ BrushHardness: 1 }, { hasTip: true }).hardness, P({ BrushHardness: 1 }).hardness],
            ribbonFlip: [P({ BrushPatternReverseVertical: 2 }, { hasTip: true }), P({ BrushPatternReverseVertical: 2, BrushRibbon: 1 }, { hasTip: true, tipW: 10, tipH: 40 })]
                .map(o => o.tipMirror || ''),
            flips: [[2, 2], [1, 0], [0, 2], [3, 0]].map(([h, v]) => { const o = P({ BrushPatternReverseHorizontal: h, BrushPatternReverseVertical: v }, { hasTip: true });
                                                           return (o.tipFlip || '-') + '/' + (o.tipMirror || '-'); }).join(' '),
            crispPic: [P({ AntiAlias: 0, TextureDensity: 60, TextureCompositeMode: 4, TextureForPlot: 1 }, { hasTip: true, hasTexture: true }),
                       P({ AntiAlias: 1 }, { hasTip: true }), P({ AntiAlias: 0 }), P({ AntiAlias: 0 }, { hasTip: true, tipWhole: true })]
                .map(o => [o.tipSamples || 0, o.tipShift || 0, o.tipShrink || '']),
            lowAA: [P({ AntiAlias: 1 }, { hasTip: true }), P({ AntiAlias: 1, BrushRibbon: 1 }, { hasTip: true }), P({ AntiAlias: 2 }, { hasTip: true }), P({ AntiAlias: 1 }),
                    P({ AntiAlias: 3 }, { hasTip: true }), P({ AntiAlias: 2, BrushRibbon: 1 }, { hasTip: true }),
                    P({ AntiAlias: 2, BrushRibbon: 1, BrushSize: 50 }, { hasTip: true, tipW: 1469, tipH: 635 }),
                    P({ AntiAlias: 1, BrushRibbon: 1, BrushSize: 50 }, { hasTip: true, tipW: 1469, tipH: 635 })]
                .map(o => [o.tipSamples || 0, o.tipShift || 0, o.tipShiftY ?? null]),
            zipAlong: P({ BrushRibbon: 1, BrushSize: 50 }, { hasTip: true, tipW: 1469, tipH: 635 }).offsetAlong,
            contrast: [-30, 30].map(c => P({ TextureDensity: 60, TextureCompositeMode: 4, TextureForPlot: 1, TextureContrast: c }, { hasTexture: true }).textureContrast),
            reverse: [0, 1].map(r => !!P({ TextureDensity: 50, TextureCompositeMode: 4, TextureForPlot: 1, TextureReverseDensity: r }, { hasTexture: true }).textureInvert),
            aliased: [P({ AntiAlias: 0 }).aliased, P({ AntiAlias: 1 }).aliased,
                      P({ AntiAlias: 0, BrushUseWaterColor: 1, BrushMixColor: 80 }).aliased].map(Boolean),
            mix: [P({ BrushUseWaterColor: 1, BrushMixColor: 80, BrushMixAlpha: 50, BrushMixColorExtension: 100 }),
                  P({ BrushUseWaterColor: 1, BrushMixColor: 80, BrushMixAlpha: 100 }),
                  P({ BrushWaterColor: 2, BrushMixColor: 30, BrushMixAlpha: 50 }),
                  P({ BrushUseWaterColor: 1, BrushMixColor: 0, BrushMixAlpha: 0 }),
                  P({ BrushUseWaterColor: 1, BrushWaterColor: 1, BrushMixColor: 80, BrushMixAlpha: 50 }),
                  P({ BrushUseWaterColor: 1, BrushWaterColor: 2, BrushMixColor: 80, BrushMixAlpha: 50 })]
                .map(p => [p.mixAlpha ?? -1, p.mixStretch ?? -1, p.watercolor || 0, +!!p.mixFlat]) });
    })()`).then(JSON.parse);
    console.log('  ' + JSON.stringify(sm));
    /* Clip Studio's tilt is how upright the pen stands, so a mouse reads 1;
     * read as our lean, Charcoal and Chalk painted nothing with a mouse. */
    /* Pastel, measured in Clip Studio one setting at a time (cdp-csp/pr-dab,
     * pr-ref pa*): mixing lays its dabs over each other, not by darken; a
     * picture takes no hardness; reverse 1 flips every dab and 2 each one
     * at random; anti-aliasing off shrinks the picture unsmoothed; paper
     * contrast spreads the paper about mid grey. */
    check('a brush that mixes colour lays its dabs over each other even when set to blend by darken',
        sm.darkMix === false, JSON.stringify(sm.darkMix));
    check('a picture tip takes no hardness', JSON.stringify(sm.picHard) === '[100,1]', JSON.stringify(sm.picHard));
    check('reverse 1 flips every dab, 2 flips each at random',
        sm.flips === '-/both h/- -/v -/-', sm.flips);
    check("anti-aliasing off point-samples a picture once a pixel, unshifted (Cross-hatching for tone scraping lands on Clip Studio's pixels)",
        JSON.stringify(sm.crispPic) === '[[1,0,""],[2,0.25,""],[0,0,""],[1,0,""]]', JSON.stringify(sm.crispPic));
    check("a Clip Studio picture at low anti-aliasing is point-sampled a quarter pixel on, a dab as a ribbon (Chalk's 30px picture is 30 rows)",
        JSON.stringify(sm.lowAA.slice(0, 2)) === '[[2,0.25,null],[2,0.25,null]]' && JSON.stringify(sm.lowAA[3]) === '[0,0,null]', JSON.stringify(sm.lowAA));
    // one Bumpy dab at medium and high is all sixteenths, a quarter pixel on (cdp-csp/aa4fit.py)
    check("...and at medium and high 4x4, a quarter pixel on",
        JSON.stringify([sm.lowAA[2], sm.lowAA[4]]) === '[[4,0.25,null],[4,0.25,null]]', JSON.stringify(sm.lowAA));
    // Braid, Waved line, Rough edged sit on Clip Studio's pixels at half the shrink's error (cdp-csp/qx)
    check("...a ribbon too, 4x4 an eighth across at medium and high, a quarter at low",
        JSON.stringify(sm.lowAA.slice(5)) === '[[4,0.25,null],[4,0.25,0.125],[2,0.25,null]]', JSON.stringify(sm.lowAA));
    check("a ribbon's first picture starts on the pen to the fraction (Zipper's 21.61, not 22)",
        Math.abs(sm.zipAlong - 50 * 635 / 1469) < 1e-9, sm.zipAlong);
    check('paper contrast -30 and +30 spread the paper 0.7 and 1/0.7 times',
        Math.abs(sm.contrast[0] - 0.7) < 1e-9 && Math.abs(sm.contrast[1] - 1 / 0.7) < 1e-9, JSON.stringify(sm.contrast));
    /* Dry ink with reverse on lays 24.7k of ink in Clip Studio, 29.6k off
     * (cdp-csp/pr-dua zdiE, zdiF): the paper's light is read as its dark. */
    check('paper reverse density on each dab reads the paper inverted',
        JSON.stringify(sm.reverse) === '[false,true]', JSON.stringify(sm.reverse));
    check('a tilt rule reads how upright the pen stands',
        sm.tilt[0] === 'elevation', JSON.stringify(sm.tilt));
    /* Thickness squeezes the width, so an unturned flat tip stands upright. */
    check('a thin tip stands upright, its thickness kept exactly',
        sm.flat[0] === 3.33 && sm.flat[1] === 90, JSON.stringify(sm.flat));
    check('a size in millimetres or centimetres is 10px a millimetre, as Clip Studio paints G-pen', sm.mm === 50 && sm.cm === 100, `${sm.mm} ${sm.cm}`);
    /* Spray: the size is the patch, the spray size is each particle. */
    check('a spray paints particles over a patch of its size',
        JSON.stringify(sm.spray) === '[10,500,6]', JSON.stringify(sm.spray));
    // Clip Studio's draws hold the same ink at density 20 and 40 (cdp-csp/bsn), ours at 16 0.78 of it.
    check('a spray lays up to 20 particles a stop',
        JSON.stringify(sm.dense) === '[20,20]', JSON.stringify(sm.dense));
    const dense = await page.eval(`(async () => {
        const app = PaintApp, br = app.brush;
        app.layerMgr.collapseToBase({ fresh: true });
        app.setSize(400, 400); app.config.zoom = 1; app.updateBounds();
        app.state.selection = null;
        br.loadPreset('Round');
        const one = async (n) => {
            app.ctx.clearRect(0, 0, 400, 400);
            br.setParam('size', 2); br.setParam('scatter', 8000); br.setParam('scatterAxis', 'disk');
            br.setParam('sprayEach', true); br.setParam('dabCount', n);
            let ink = 0;
            for (let k = 0; k < 20; k++) {
                br.beginStroke(200, 200, 1, '#000000'); br.endStroke();
            }
            await new Promise(r => setTimeout(r, 200));
            const d = app.ctx.getImageData(0, 0, 400, 400).data;
            for (let i = 3; i < d.length; i += 4) ink += d[i] / 255;
            return ink;
        };
        const a = await one(10), b = await one(20);
        br.loadPreset('Round');
        return b / a;
    })()`, { awaitPromise: true });
    check('...and the engine lays all 20 (twice the ink of 10)', Math.abs(dense - 2) < 0.15, dense.toFixed(3));
    /* Measured with 1px particles there: evenly over the patch, each its own
     * size, and a spray size in millimetres converted like the brush size. */
    check('a spray covers its patch evenly, sizes each particle, and reads its unit',
        JSON.stringify(sm.sprayHow) === '["disk",true,20]', JSON.stringify(sm.sprayHow));
    // ...and only a particle that follows the line waits a quarter of itself before the first (cdp-csp/stk sw-pt5)
    check('a spray turns its particles by the in-spray rotation (bit 64 follows the line), not the brush rotation',
        JSON.stringify(sm.spin) === '[[180,"direction",0.25],[180,null,0],[180,null,0]]', JSON.stringify(sm.spin));
    check('Droplet: particles point away from the patch centre (in-spray bit 512) and random thickness thins a picture by width',
        JSON.stringify(sm.drop) === '["radial",true]', JSON.stringify(sm.drop));
    check('a picture on auto spacing is spaced by its own width however it is turned (Pointillism), a round tip or a ribbon not',
        JSON.stringify(sm.byWidth) === '[true,false,false]', JSON.stringify(sm.byWidth));
    check('a spray keeps its bias (where in the patch its particles land)',
        JSON.stringify(sm.bias) === '[-100,0,50]', JSON.stringify(sm.bias));
    /* Trees' random interval varies its gaps; in a spray it did nothing
     * (60px apart with it on or off). Droplet's random thickness took a
     * quarter off its ink; Dry Gouache's kept its line (width 74 either way). */
    check('a spray takes random thickness and density, not a random interval',
        JSON.stringify(sm.sprayRnd) === '["none","random","random"]', JSON.stringify(sm.sprayRnd));
    check('a plain brush takes a random interval, not random thickness',
        JSON.stringify(sm.plainRnd) === '["random","none"]', JSON.stringify(sm.plainRnd));
    /* Oil paint (thickness on speed, floor 59) is 68px across in Clip
     * Studio and was 72 here; a spray picture squeezed top to bottom kept
     * Clip Studio's ink unthinned (Ground 0.98, thinned 0.79). */
    check('a plain picture brush takes a speed thickness, by width',
        JSON.stringify(sm.plainSpd) === '["speed",59,true]', JSON.stringify(sm.plainSpd));
    // WC Generic Flower's flowers, one at a time, stand 0.90-0.98 of their height at random floor 88 (cdp-csp/kx)
    check('a picture squeezed top to bottom takes random thickness, sprayed or not',
        JSON.stringify(sm.tallRnd) === '["random","random"]', JSON.stringify(sm.tallRnd));
    /* A ribbon lays each picture once, nothing over it to hide a thin one:
     * Rough pen (random floor 85) paints 0.92 the width of ours unthinned,
     * over every stretch of its line (ink 1.049 -> 1.01 of Clip Studio's). */
    check('a ribbon takes a random thickness',
        sm.ribRnd === 'random', sm.ribRnd);
    check('...but its pressure does (Leaves closes its gaps to half at full pressure)',
        sm.sprayPr === 'pressure', sm.sprayPr);
    /* A picture tip on automatic spacing follows its squeezed width (Chalk);
     * a fixed interval and a generated tip go by the size, however turned. */
    check('a fixed interval or a generated tip is spaced by the size alone',
        JSON.stringify(sm.iso) === '[false,true,true]', JSON.stringify(sm.iso));
    /* A ribbon tiles its picture end to end, as wide as the brush -- its
     * size Clip Studio's own, the picture's side across the stroke (zb216)
     * -- the first starting at the stroke's start (Dashed line's first dash). */
    check('a ribbon lays its picture end to end along the stroke',
        JSON.stringify(sm.ribbon) === '[30,90,100,270,"direction",50]', JSON.stringify(sm.ribbon));
    check('...and is no longer reported as dropped', !/ribbon/.test(sm.ribbonNote), sm.ribbonNote);
    /* Bumpy's turn of 1 lays level there; Waved line's 10 x 300/117 is 25.64,
     * and rounded to 26 it drifted a whole wave over a line; it stops at the pen. */
    check('a ribbon lies straight, keeps its length to a hundredth and stops at the pen',
        JSON.stringify(sm.ribTilt) === '[270,10,25.64,true]', JSON.stringify(sm.ribTilt));
    /* Colour change, measured in Clip Studio: a dab lands evenly between
     * x + floor * change and x + change, so hue at floor -100 goes both ways,
     * saturation -50 at floor 0 only down, and a value with no random input
     * takes the whole change every dab. BrushChangePatternColor 0 paints the
     * same settings flat; target 2 changes only the sub colour, a picture's
     * whites (Building's faces). */
    check('a Clip Studio colour change keeps which way it goes and how far',
        JSON.stringify(sm.cj.slice(0, 2)) === '[[[-1,1],[-1,0],[1,1]],[15,50,100]]', JSON.stringify(sm.cj));
    check('a colour change is read at full pressure and tilt, as a mouse paints it (Leaves: +25 falling to 0 there)',
        JSON.stringify(sm.cj[5]) === '[0,20]', JSON.stringify(sm.cj[5]));
    /* Clip Studio's second brush is a brush of its own, its Dual columns
     * read as the Brush ones: laid over the first in modes 0/1 with the
     * colour change on (cdp-csp/w159), darkening it in 4 (sw-n172), blended into it in 5-8
     * (w174m), cut out of it in 12. Mode 2 adds its colour to the first's wherever that has ink
     * and keeps its colour change (Glitter: purple turns magenta, 240,141,251 as in Clip Studio). Mode 3 subtracts;
     * none of them carves, as we used to. */
    check('a second brush becomes a brush of its own, laid over, blended or cut out, never carved with',
        JSON.stringify(sm.dual) === JSON.stringify([[0, 'over', 76, 20, '', false, 0], [0, 'add', 76, 20, '', true, null],
            [0, 'subtract', 76, 20, '', false, 0], [0, 'over', 76, 20, '', false, 0], [0, 'cut', 76, 20, '', false, 0]]), JSON.stringify(sm.dual));
    check('...mode 4 darkens it while it changes the colour, and with the change off keeps the lesser of the two strokes',
        JSON.stringify(sm.mask4) === '["over","min"]', JSON.stringify(sm.mask4));
    // Wet blotting ink: mode 12 cuts with the colour change on, pushes from half with it off (cdp-csp/qw)
    check('...and mode 12 cuts while it changes the colour, and with the change off pushes ink away from half',
        JSON.stringify(sm.mode12) === '["cut","contrast"]', JSON.stringify(sm.mode12));
    /* Opacity caps each dab at its own level (cdp-csp/pr-dua zwiG); laid
     * by darken, or under a second brush cut in turn, it stays on flow. */
    check("a Clip Studio brush's opacity is a per-dab cap; laid by darken or under a cutting second brush it stays on flow",
        JSON.stringify(sm.opac) === JSON.stringify([['random', true, 'none'], ['none', false, 'random'], ['none', false, 'random'], ['random', true, 'none']]) && !sm.opac2,
        JSON.stringify([sm.opac, sm.opac2]));
    check('...switched off it paints flat, and on the sub colour it shades the whites alone',
        sm.cj[2] === 0 && JSON.stringify(sm.cj[3]) === '[100,true]' && !/sub colour/.test(sm.cj[4]), JSON.stringify(sm.cj));
    check('pictures set to take turns take turns', sm.cycle === 'cycle' && sm.pingpong === 'pingpong' && sm.random === '',
        JSON.stringify([sm.cycle, sm.pingpong, sm.random]));
    /* How much paper shows is the blend's doing: subtract at half density
     * matched multiply at full, 4 barely showed and 0 not at all. Gouache
     * (4 at 100) came out a speckled grey at full grain. */
    /* Anti-aliasing off draws ink or paper -- unless the greys are colour
     * (Gouache mixes, and stays grey there with it off). */
    check('a brush with no anti-aliasing paints hard pixels, a mixing one does not',
        JSON.stringify(sm.aliased) === '[true,false,false]', JSON.stringify(sm.aliased));
    /* Density of paint and colour stretch, measured in Clip Studio; at
     * full density its line is the plain one, but it still takes up the
     * colour under it by its amount of paint (sw-an046). The watercolour kind alone
     * moves no ink (Round watercolor brush the same pixels at 2 and 0).
     * Mixing, its watercolour kind 1 lays the density flat and 2 is solid
     * (cdp-csp/qo: Thick oil paint's 2 lays 255 from its first pixel). */
    /* A blender (no paint, density 0: Gouache blender) mixes too -- as a
     * plain brush it painted a solid line where Clip Studio paints nothing. */
    check('colour mixing brings its density of paint, the watercolour kind alone no wash',
        JSON.stringify(sm.mix) === '[[50,100,0,0],[100,0,0,0],[-1,-1,0,0],[0,0,0,0],[50,0,0,1],[-1,-1,0,0]]', JSON.stringify(sm.mix));
    /* Blend mode 27 (Watery brush) thins paint in place and lays none. */
    /* 1% of 20 and 4% of 20 paint the same stroke there. */
    check('dabs never land closer than a pixel', sm.minStep === 1, `${sm.minStep}`);
    /* A round dab's rim fades over AA + 0.5 px, measured at sizes 5-40. */
    check('anti-aliasing fades a round rim by its level',
        JSON.stringify(sm.ramp) === '[0.01,1.5,2.5,3.5]', JSON.stringify(sm.ramp));
    /* Soft lines there sit 1 + 2 x softness further apart (a picture tip
     * takes no hardness; a fixed interval stays put). */
    check('auto spacing opens up as a round tip softens',
        JSON.stringify(sm.softGap) === '[16,8,20]', JSON.stringify(sm.softGap));
    check('a soft round tip keeps its greys with anti-aliasing off',
        JSON.stringify(sm.softAliased) === '[false,true]', JSON.stringify(sm.softAliased));
    /* G-pen is 5.1: six rows there, five when rounded to 5. */
    check('a fractional size is kept', sm.fracSize === 5.1, `${sm.fracSize}`);
    /* Real G-Pen's picture at thickness 85 was a full-height line here. */
    check("a ribbon's pieces are not flipped one by one at random: Rough pen lays one unbroken band",
        JSON.stringify(sm.ribbonFlip) === '["v",""]', JSON.stringify(sm.ribbonFlip));
    check('a picture tip is squeezed by its thickness, the way the file says',
        JSON.stringify(sm.pic) === '[[1.18,0],[0.5,0]]', JSON.stringify(sm.pic));
    check("...and past 100 stretches it: Feather's 150 lays each picture half again as wide, or tall with the vertical flag, a ribbon's across its stroke (Rough pen), not a generated tip",
        JSON.stringify(sm.stretch) === '[[1.5,1],[1,1.5],[1.5,1],null]', JSON.stringify(sm.stretch));
    check('blend mode 27 erases', JSON.stringify(sm.erase) === '["erase","normal"]', JSON.stringify(sm.erase));
    check('paper on each dab keeps its blend, its scale and its own strength rule',
        JSON.stringify(sm.plot) === '[80,2,"random",40,1.6]', JSON.stringify(sm.plot));
    check("a Clip Studio paper's scale is of its real picture, not its preview: 1001px at 28% tiles every 280",
        Math.abs(sm.paperPx - 280.28) < 0.01, sm.paperPx);
    check('a paper on each dab keeps its emphasised density (Oil paint)',
        JSON.stringify(sm.stress) === '[false,true]', JSON.stringify(sm.stress));
    /* Wide, normal and narrow spacing ignore the interval: faint strokes
     * at sizes 20-200 in Clip Studio laid dabs 12, 8 and 4% apart; read
     * as the interval, Oil paint (1 on narrow) packed four times too many. */
    check('automatic spacing ignores the interval',
        JSON.stringify(sm.gap) === '[1,12,8,4]', JSON.stringify(sm.gap));
    /* Adjusting density by interval scales each dab's flow with the
     * spacing, flow x spacing / 33.1: a single hard dab at 10 and 23.8%
     * takes 0.30 and 0.72 off solid ink in Clip Studio (cdp-csp/pr-dc,
     * zdah*), and 40% at 50 lays the flow. Soft had twice Clip Studio's ink without it. */
    // ...but not a ribbon's pictures, laid end to end: Braid's outlines are black in Clip Studio
    check("density adjusted by interval thins each dab with the spacing (in the engine, at the real step), not a ribbon's",
        JSON.stringify(sm.adj) === '[[50,true],[50,true],[50,true],[50,false]]', JSON.stringify(sm.adj));
    /* Blend by darken (Soft bleed, measured in Clip Studio): dabs never pile
     * up, its watercolour and edge move no ink on an empty layer, and its
     * paper blends on each dab as it would on the stroke -- blend 0 half
     * again the flow even at density 0. */
    check('a brush laid by darken keeps its strongest dab and drops the wash, its paper on each dab',
        JSON.stringify(sm.darken) === '[[true,false,0,0,null,100],[true,false,0,50,0,100],[true,false,0,0,null,75]]', JSON.stringify(sm.darken));
    /* Multiply and subtract blend once over the whole stroke (Round
     * watercolor brush), reversed or not (cdp-csp/pa); so do 3 to 8
     * (cdp-csp/stk sw-q85); mode 0 keeps a strength of its own. */
    check('the paper shows as strongly as its blend lets it, every blend but 0 on the whole stroke',
        JSON.stringify(sm.paper) === '[[50,1],[50,2],[50,4],[0,null],[50,1]]', JSON.stringify(sm.paper));
    check('...brightened, turned and reversed as Clip Studio does the paper on a whole stroke',
        JSON.stringify(sm.paperMods) === '[0.2,45,true]', JSON.stringify(sm.paperMods));
    /* Clip Studio's pictures (Book, Building) stamp their own greys and
     * whites; a tip of one flat grey is ink, its greys only density
     * (Crayon's grey blob paints solid black there, zb015's grey 24 too),
     * but greys that vary shade it (zb143's 23-147, cdp-csp/stk sw-m143). */
    const shade = await page.eval(`(async () => {
        const png = async (fill, flat) => {
            const c = new OffscreenCanvas(24, 16), x = c.getContext('2d'); // 16..24 left clear
            x.fillStyle = flat ? fill : '#000'; x.fillRect(0, 0, 8, 16);
            x.fillStyle = fill; x.fillRect(8, 0, 8, 16);
            return new Uint8Array(await (await c.convertToBlob()).arrayBuffer());
        };
        const mode = async (fill, flat) => ((await BrushPack.tipStrip([await png(fill, flat)], 'tip.png', { csp: true })).params || {}).tipMode || '';
        const whole = async (real) => { const b = await png('#888'); if (real) b.real = real;
                                        return !!(await BrushPack.tipStrip([b], 'tip.png', { csp: true })).whole; };
        const blob = async () => {   // a soft cloud, as Soft bleed's is, shown shrunk
            const c = new OffscreenCanvas(96, 96), x = c.getContext('2d'), g = x.createRadialGradient(48, 48, 0, 48, 48, 48);
            g.addColorStop(0, 'rgba(0,0,0,0.8)'); g.addColorStop(1, 'rgba(0,0,0,0)');
            x.fillStyle = g; x.fillRect(0, 0, 96, 96);
            const b = new Uint8Array(await (await c.convertToBlob()).arrayBuffer()); b.real = [300, 300];
            return !!(await BrushPack.tipStrip([b], 'tip.png', { csp: true })).whole;
        };
        return JSON.stringify([await mode('#fff'), await mode('#888'), await mode('#000'),
                               [await whole([24, 16]), await whole([96, 64]), await whole(null), await blob()], await mode('#181818', true)]);
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('a picture tip stamps its own whites and varying greys, a flat grey or black one stays ink',
        shade[0] === 'color' && shade[1] === 'color' && shade[2] === '' && shade[4] === '', JSON.stringify(shade));
    /* Anti-aliasing off sharpens a preview shrunk from a bigger picture (Black
     * soot's), not one that is the picture (Noise's soft 210x204 tip keeps
     * its greys in Clip Studio with it off or on). */
    check('only a preview shrunk from its picture is known to be crisper than it looks',
        JSON.stringify(shade[3].slice(0, 3)) === '[true,false,false]', JSON.stringify(shade[3]));
    /* ...unless it is a soft cloud: Soft bleed's, shrunk from 491px, paints
     * its greys in Clip Studio with anti-aliasing off. */
    check('...and a shrunk soft cloud keeps its greys', shade[3][3] === true, JSON.stringify(shade[3]));
    check('a sub colour mix is read, and only with colour change on',
        JSON.stringify(sm.subMix) === '[38,0]', JSON.stringify(sm.subMix));
    check('a picture shown whole keeps its greys with anti-aliasing off',
        JSON.stringify(sm.wholeAliased) === '[true,false]', JSON.stringify(sm.wholeAliased));
    /* Ribbon pictures. Clip Studio's preview is its picture squeezed into a
     * square, so it is cut back to the real shape, margins kept (Dashed
     * line's gaps are its margins); a long one is laid in pieces so a
     * stroke stops near the pen (Rough pen ran 100px on); order 1 runs out
     * and back (Bead chain); a coloured one paints its own colours. */
    const rib = await page.eval(`(async () => {
        const png = async (w, h, draw) => {
            const c = new OffscreenCanvas(w, h), x = c.getContext('2d'); draw(x);
            return new Uint8Array(await (await c.convertToBlob()).arrayBuffer());
        };
        const bar = await png(24, 24, x => { x.fillStyle = '#000'; x.fillRect(10, 0, 4, 24); });
        bar.real = [8, 24];
        const cut = await BrushPack.tipStrip([bar], 'tip.png', { csp: true, crop: 'w' });
        const odd = await png(24, 24, x => { x.fillStyle = '#000'; x.fillRect(8, 0, 9, 24); });
        odd.real = [5, 13];
        const cut2 = await BrushPack.tipStrip([odd], 'tip.png', { csp: true, crop: 'w' });
        const pics = await Promise.all([10, 20, 30].map(w => png(w, 10, x => { x.fillStyle = '#000'; x.fillRect(0, 0, w, 10); })));
        const bounce = await BrushPack.tipStrip(pics, 'tip.png', { csp: true, crop: 'h', join: 1 });
        const pink = await png(8, 8, x => { x.fillStyle = '#fff'; x.fillRect(4, 0, 2, 8); x.fillStyle = '#ff80c0'; x.fillRect(0, 0, 4, 8); });
        const g = await BrushPack.tipStrip([pink], 'tip.png', { csp: true });
        const im = new Image(); im.src = g.url; await im.decode();
        const cv = new OffscreenCanvas(im.width, im.height), cx = cv.getContext('2d'); cx.drawImage(im, 0, 0);
        const halves = await Promise.all([0, 5].map(y => png(10, 10, x => { x.fillStyle = '#000'; x.fillRect(0, y, 10, 5); })));
        const st = await BrushPack.tipStrip(halves, 'tip.png', { csp: true, crop: 'w', stack: 0.5 });
        const sm = new Image(); sm.src = st.url; await sm.decode();
        const sv = new OffscreenCanvas(sm.width, sm.height), sx = sv.getContext('2d'); sx.drawImage(sm, 0, 0);
        return JSON.stringify({ cut: [cut.w, cut.h, cut.cells, cut.pick], bounce: [bounce.cells, bounce.w, bounce.h],
            own: [g.params && g.params.tipMode].concat(Array.from(cx.getImageData(1, 1, 1, 1).data.slice(0, 3))),
            exact: [cut2.w, +cut2.h.toFixed(2)],
            stack: [st.cells, sx.getImageData(5, 2, 1, 1).data[3], sx.getImageData(5, 7, 1, 1).data[3]] });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('a ribbon picture is cut to its real shape and laid in pieces',
        JSON.stringify(rib.cut) === '[8,12,2,"cycle"]', JSON.stringify(rib.cut));
    /* Cut back from the preview it comes out 9x24; the picture is 5x13, so
     * 9 across is 23.4 along (Chain's links came 1.8% short off its preview). */
    check("a ribbon picture keeps its own proportions, not its preview's",
        JSON.stringify(rib.exact) === '[9,23.4]', JSON.stringify(rib.exact));
    check('...its pictures joined out and back in order 1',
        JSON.stringify(rib.bounce) === '[4,20,10]', JSON.stringify(rib.bounce));
    // Bead chain's beads paint red and pink with black, zb095's smear tan with its colour change on
    check('a coloured picture paints its own colours',
        JSON.stringify(rib.own) === '["color",255,128,192]', JSON.stringify(rib.own));
    /* Zipper's second ribbon is its upper row of teeth: laid over the first,
     * not cut through it (one row with the second brush off there). */
    // ...at its own flow: Braid's hatching (50) is faint over its black outlines
    check('a second ribbon in normal mode is laid over the first, at its own flow',
        rib.stack[0] === 1 && rib.stack[1] === 255 && Math.abs(rib.stack[2] - 128) <= 1, JSON.stringify(rib.stack));

    /* The pack chooser. It lists what is in a pack before anything is
     * installed, then installs only what was ticked -- so the two halves
     * worth checking are that listing has no side effect, and that `only`
     * really is a filter and not a suggestion. */
    console.log('\nPicking brushes out of a pack');
    const pick = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        const buf = await window.__files['mini-pack.bundle'].arrayBuffer();
        const u8 = new Uint8Array(buf);
        const sum = await PaintApp.brush.packSummary(u8, 'mini-pack.bundle');
        const afterSummary = PaintApp.brush.userPresetNames().length;
        const want = sum.brushes[1].name;
        const r = await PaintApp.brush.importBrushPack(u8, 'mini-pack.bundle', { only: [want] });
        return JSON.stringify({ sum, afterSummary, want, added: r.added, installed: PaintApp.brush.userPresetNames() });
    })()`, { awaitPromise: true }).then(JSON.parse);
    console.log('  ' + JSON.stringify(pick.sum.brushes.map(b => b.name)));

    check('the summary lists every brush in the pack',
        pick.sum.ok && pick.sum.brushes.length === 2, JSON.stringify(pick.sum.brushes));
    check('each one carries the author own icon',
        pick.sum.brushes.every(b => /^data:image\/png/.test(b.icon || '')),
        JSON.stringify(pick.sum.brushes.map(b => (b.icon || '').slice(0, 20))));
    check('looking inside a pack installs nothing', pick.afterSummary === 0, `${pick.afterSummary}`);
    check('ticking one brush installs exactly that one',
        pick.installed.length === 1 && pick.added.length === 1, JSON.stringify(pick.installed));
    /* The library shows a tidied name, so compare against the raw one the
     * chooser ticked with the same tidying applied. */
    check('...and it is the one that was ticked',
        pick.installed[0] === 'Thin Brush Pointy',
        `${pick.want} -> ${pick.installed[0]}`);

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
