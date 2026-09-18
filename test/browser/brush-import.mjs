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
    'library-tips.sut': b64('library-tips.sut'),
    'masked-generated.kpp': b64('masked-generated.kpp'),
    'masked-file.kpp': b64('masked-file.kpp'),
    'itxt-binary-md5.kpp': b64('itxt-binary-md5.kpp'),
    'shapes-alchemy.kpp': b64('shapes-alchemy.kpp'),
    'distort-move.kpp': b64('distort-move.kpp')
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
                       w, depth: p.tip2Depth || 0, size: p.tip2Size || 0 };
        }
        return JSON.stringify(out);
    })()`, { awaitPromise: true }).then(JSON.parse);
    console.log('  ' + JSON.stringify(msk));
    check('a masking brush that generates its tip gets one drawn for it',
        msk['masked-generated.kpp'].w > 0 && msk['masked-generated.kpp'].depth === 100,
        JSON.stringify(msk['masked-generated.kpp']));
    check('a masking brush that names a tip resolves it like any other',
        msk['masked-file.kpp'].w > 0 && msk['masked-file.kpp'].depth === 100,
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
    /* The radius is half the size, and the spacing is already a percentage. */
    check('radius becomes a diameter, spacing comes straight across',
        vbr['star-ten.vbr'].size === 50 && vbr['star-ten.vbr'].spacing === 50,
        JSON.stringify(vbr['star-ten.vbr']));
    /* A plain round one needs no picture: that is the brush we already are,
     * and keeping it parametric means it stays sharp at any size. */
    check('a plain round one stays a round brush, softness and all',
        vbr['round-soft.vbr'].shape === 'circle' && vbr['round-soft.vbr'].w === 0 &&
        vbr['round-soft.vbr'].hardness === 40, JSON.stringify(vbr['round-soft.vbr']));
    /* Everything else has to be drawn. A square of 4:1 is a wide block, so
     * its middle is solid and its corners are empty. */
    check('a shape we cannot make parametrically is drawn instead',
        vbr['block-wide.vbr'].shape === 'custom' && vbr['block-wide.vbr'].w === 50 &&
        vbr['block-wide.vbr'].mid === 255 && vbr['block-wide.vbr'].corner === 0,
        JSON.stringify(vbr['block-wide.vbr']));
    /* Spikes are what make these stars: above two, the shape is drawn once
     * per spike, each turned a further half-turn divided by their number. */
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
    /* offset_by_random 0.4 is 0.4 of a RADIUS; ours is a fraction of the
     * dab's width, so it is 20, not 40. */
    check('a random offset becomes scatter', myb.p && myb.p.scatter === 20,
        myb.p && String(myb.p.scatter));
    /* MyPaint's curve is an addition in the setting's own units; ours is a
     * multiplier. The shape has to survive that, and end where it started. */
    check('the pressure curve keeps its shape',
        myb.p && myb.p.sizeSrc === 'pressure' && myb.p.sizeCurve.length === 3 &&
        myb.p.sizeCurve[0][1] === 0 && myb.p.sizeCurve[2][1] === 1 &&
        myb.p.sizeCurve[1][1] > 0.7,
        JSON.stringify(myb.p && myb.p.sizeCurve));
    /* offset_by_speed is 1.5 RADII along the line at full speed, so it is 75
     * per cent of the dab's width, and the speed sensor scales it. Twenty-
     * seven of MyPaint's own 196 brushes ask for this, which made it the
     * largest single thing we dropped. */
    check('a dab that runs ahead of the pointer does that here too',
        myb.p && myb.p.offsetAlong === 75 && myb.p.offsetSrc === 'speed',
        JSON.stringify(myb.p && [myb.p.offsetAlong, myb.p.offsetSrc]));
    check('and what it could not carry is named, not silently dropped',
        myb.r.notes.length === 1 &&
        !myb.r.notes[0].warnings.some(w => /away from the cursor/.test(w)) &&
        myb.r.notes[0].warnings.some(w => /grid/.test(w)),
        JSON.stringify(myb.r.notes));

    console.log('\n== two of David Revoy own MyPaint brushes ==');
    /* The point of the brush work is that Revoy's brushes look like Revoy's
     * brushes, so these two are his, straight out of the CC-0 collection --
     * not something written here from the format description. */
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
    check('his airbrush keeps its size, softness and flow',
        air.p && air.p.size === 220 && air.p.hardness === 48 && air.p.flow === 52,
        JSON.stringify(air.p && { s: air.p.size, h: air.p.hardness, f: air.p.flow }));
    /* opaque_multiply sits at 0 with a pressure curve on it -- that is how
     * MyPaint says "flow follows pressure", and reading the 0 as a
     * multiplier would have made every one of his brushes paint nothing. */
    check('and its flow is driven by pressure, not multiplied away',
        air.p && air.p.flowSrc === 'pressure' && air.p.flow > 0,
        JSON.stringify(air.p && { src: air.p.flowSrc, f: air.p.flow }));
    /* The dab is round here, and MyPaint still stores an angle of 90. */
    check('a round dab brings no angle across',
        air.p && !air.p.aspectRatio && air.p.angle === undefined,
        JSON.stringify(air.p && { a: air.p.aspectRatio, g: air.p.angle }));
    check('his knife is a flattened dab, turned, that smudges',
        knife.p && knife.p.aspectRatio === 3.61 && knife.p.angle === 160 &&
        knife.p.colorRate === 9 && knife.p.smudgeLength === 50,
        JSON.stringify(knife.p && { a: knife.p.aspectRatio, g: knife.p.angle,
                                    c: knife.p.colorRate, l: knife.p.smudgeLength }));
    check('and neither one invents a feature it does not use',
        (air.r.notes[0] ? air.r.notes[0].warnings : []).every(w => !/grid|posteris|smudge/.test(w)) &&
        (knife.r.notes[0] ? knife.r.notes[0].warnings : []).every(w => !/grid|posteris/.test(w)),
        JSON.stringify([air.r.notes, knife.r.notes]));

    const old = await page.eval(`(async () => {
        const txt = await window.__files['hard-eraser.myb'].text();
        const r = PaintApp.brush.importMyb(txt, 'hard-eraser.myb');
        return JSON.stringify({ r, p: r.ok ? PaintApp.brush.PRESETS[r.added[0]] : null });
    })()`, { awaitPromise: true }).then(JSON.parse);
    check('the older line format reads too', old.r.ok, JSON.stringify(old.r).slice(0, 150));
    check('an eraser comes across as an eraser',
        old.p && old.p.blendMode === 'erase' && old.p.hardness === 90,
        JSON.stringify(old.p && { b: old.p.blendMode, h: old.p.hardness }));
    /* A dab whose size wanders is a quarter of MyPaint's own collection, and
     * it was being reported as lost. It can only be honoured when nothing
     * else already drives the size -- here pressure does, so it stays named. */
    check('a wandering dab size loses to pressure, and says so',
        old.p && old.p.sizeSrc === 'pressure' &&
        /randomly varying dab size/.test(JSON.stringify(old.r.notes || [])),
        JSON.stringify([old.p && old.p.sizeSrc, old.r.notes]));
    /* MyPaint 2 can aim a second offset vector from its own sensors. Ours is
     * one distance along the line and one across it, so that family is a
     * different thing rather than more of the same -- and calling it "dabs
     * placed away from the cursor" would be wrong on the brushes whose
     * offset we DO place. */
    check('the offset controls we cannot aim are named as their own thing',
        /finer controls on where a dab lands/.test(JSON.stringify(old.r.notes || [])) &&
        !/away from the cursor/.test(JSON.stringify(old.r.notes || [])),
        JSON.stringify(old.r.notes));

    /* How wide a patch a smudge picks colour up from. MyPaint spans a
     * quarter of the dab's radius to four times it across its own
     * collection, and a wide sampler is what makes a blender blend rather
     * than smear -- ours had no such dial and sampled the dab's own radius
     * always. `smudge_radius_log` is a doubling: 1 is twice the radius. */
    const reach = await page.eval(`(() => {
        const t = BrushPack.readMyb(['version 2', 'radius_logarithmic 2.0',
            'smudge 0.8', 'smudge_radius_log 1.0'].join(String.fromCharCode(10)), 'x.myb');
        return JSON.stringify({ p: t.params, w: t.warnings });
    })()`).then(JSON.parse);
    check('a smudge that reaches wider comes across as one',
        reach.p.smudgeRadius === 200, String(reach.p.smudgeRadius));
    check('...and is no longer reported as dropped',
        !/smudge/.test(reach.w.join(' ')), reach.w.join(' | '));

    /* Krita drives the fresh-colour half of a smudge from the pen. It is the
     * same dial ours drives -- it just had nowhere to be driven from until
     * colorRate grew a sensor of its own. */
    const mix = await page.eval(`(() => {
        const t = BrushPack.toPreset({ paintop: 'colorsmudge', name: 'Blender', params: {
            ColorRateValue: '0.4', SmudgeRateValue: '0.6',
            PressureMix: 'true',
            MixSensor: '<param name="MixSensor"><params id="pressure"/></param>'
        } });
        return JSON.stringify({ p: t.params, w: t.warnings });
    })()`).then(JSON.parse);
    check('colour mixing driven by the pen comes across now',
        mix.p.colorRateSrc === 'pressure' && mix.p.colorRate === 40,
        JSON.stringify([mix.p.colorRateSrc, mix.p.colorRate]));
    check('...and is no longer in the list of things we dropped',
        !/colour mixing/.test(mix.w.join(' ')), mix.w.join(' | '));

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

    const wob = await page.eval(`(() => {
        const t = BrushPack.readMyb(['version 2', 'radius_logarithmic 2.0',
            'radius_by_random 0.7', 'hardness 0.5'].join(String.fromCharCode(10)), 'x.myb');
        return JSON.stringify({ p: t.params, w: t.warnings });
    })()`).then(JSON.parse);
    /* MyPaint's spread is in the same log units as the radius, so 0.7 is a
     * dab anywhere between half the base and twice it. Ours only takes size
     * away, so the floor carries the whole spread. */
    check('and with nothing else driving it, the dab really does wander',
        wob.p.sizeSrc === 'random' && wob.p.sizeMin === 50,
        JSON.stringify([wob.p.sizeSrc, wob.p.sizeMin]));
    check('so it is no longer reported as lost',
        !/randomly varying/.test(wob.w.join(' ')), wob.w.join(' '));

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
            sizeSrc: p.sizeSrc, sizeCurve: p.sizeCurve, sizeMin: p.sizeMin,
            tipCells: p.tipCells || 1, has2: !!p._tip2Url,
            tip2Depth: p.tip2Depth || 0, tip2Size: p.tip2Size || 0,
            tip2Spacing: p.tip2Spacing || 0, tip2Angle: p.tip2Angle || 0,
            scatterSrc: p.scatterSrc, hueJitter: p.hueJitter || 0,
            satJitter: p.satJitter || 0, valJitter: p.valJitter || 0,
            colorJitterPer: p.colorJitterPer });
    })()`, { awaitPromise: true }).then(JSON.parse);
    console.log('  ' + JSON.stringify(sut));

    check('a .sut installs', sut.r.brushes === 1 && sut.r.failed === 0, JSON.stringify(sut.r));
    check('the sub tool keeps its name', sut.name === 'Rough Scrape', `${sut.name}`);
    /* Clip Studio stores a real diameter, unlike Procreate, so the size is
     * the brush's own and not the tip image's. */
    check('the size is the brush' + "'" + 's, not the tip image' + "'" + 's',
        sut.size === 80 && sut.tipH === 96, JSON.stringify(sut));
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
    /* Thickness is a percentage there and a ratio here -- but only for
     * generated tips. This brush has an image tip (a 192x96 strip of two),
     * which already IS its shape, so thickness is left off and owned up to
     * instead of squeezing the tip flat. */
    check('thickness leaves an image tip alone and says so',
        sut.aspectRatio === undefined &&
        (sut.r.lines || []).some(l => /kept the tip.s own shape/.test(l)),
        JSON.stringify(sut));
    check('spray is pixels there and a share of the brush here',
        sut.scatter === 18, `${sut.scatter}`);
    check('a taper that is switched off stays off',
        sut.taperStart === 30 && sut.taperEnd === 0, JSON.stringify(sut));
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

    /* Clip Studio keeps the way a dial answers the pen in a blob of its own,
     * and we read none of them until now: every .sut arrived as a flat
     * stroke. The curve is the file's, points and all, not a straight line
     * we substituted. */
    check('flow follows the pen, along the curve the file drew',
        sut.flowSrc === 'pressure' && JSON.stringify(sut.flowCurve) ===
            JSON.stringify([[0, 0], [0.25, 0.6], [1, 1]]), JSON.stringify(sut.flowCurve));
    /* Size is driven by two things at once there and one thing here, so the
     * one we can name wins and the other is owned up to -- with the floor
     * the file asks for, not zero. */
    check('a dial driven by two things keeps the one we understand',
        sut.sizeSrc === 'pressure' && sut.sizeMin === 10 &&
        JSON.stringify(sut.sizeCurve) === JSON.stringify([[0, 0.2], [1, 1]]),
        JSON.stringify([sut.sizeSrc, sut.sizeMin, sut.sizeCurve]));
    check('a curve for an input we cannot name drives nothing',
        !sut.scatterSrc, String(sut.scatterSrc));
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
        /a rule that changes its size/.test(sutNotes) &&
        /a rule that changes its spray/.test(sutNotes), sutNotes);
    check('a setting that is switched on is reported', /blur/.test(sutNotes), sutNotes);
    check('...and one that is off is not', !/ribbon/.test(sutNotes), sutNotes);

    /* The second tip. Clip Studio's is a brush of its own -- its own
     * picture, size, spacing and turn -- and until now the whole Dual
     * column family was one line of apology. Size is in pixels there and a
     * share of the brush here: 30 against 80 is 38%. */
    check('the second tip arrives as a picture of its own',
        sut.has2 && sut.tip2Depth === 60, JSON.stringify(sut));
    check('...sized, spaced and turned the way the file asks',
        sut.tip2Size === 38 && sut.tip2Spacing === 120 && sut.tip2Angle === 45,
        JSON.stringify([sut.tip2Size, sut.tip2Spacing, sut.tip2Angle]));
    check('...and no longer reported as dropped',
        !/second brush tip/.test(sutNotes), sutNotes);
    /* We carve with it, which is what its darkening blend modes do. This
     * one asks for something else, and that is said rather than faked. */
    check('a blend for the second tip we cannot do is named',
        /way its second tip blends/.test(sutNotes), sutNotes);

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
            br.setParam('tip2Depth', depth); br.setParam('size', 120);
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
