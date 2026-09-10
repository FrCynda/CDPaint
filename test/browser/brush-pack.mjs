/* Reading brush packs made for other programs.
 *
 * Everything here runs against real files from David Revoy's 2023-01 Krita
 * bundle (CC-0), not against something we wrote ourselves — a decoder tested
 * on its own output proves nothing. See test/fixtures/brushes/README.md.
 */
import { withPage, REPO_ROOT } from '../browser.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

const FIX = join(REPO_ROOT, 'test', 'fixtures', 'brushes');
const b64 = (f) => readFileSync(join(FIX, f)).toString('base64');

await withPage(async (page) => {
    /* The fixtures reach the page as base64 rather than over HTTP, so the
     * decoder is what is under test and not the server. */
    await page.run(`
        window.__fx = {};
        const put = (k, s) => {
            const bin = atob(s);
            const u = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
            window.__fx[k] = u;
        };
        put('auto', ${JSON.stringify(b64('eraser-kneaded-soft.kpp'))});
        put('stamp', ${JSON.stringify(b64('thin-brush-pointy.kpp'))});
        put('pack', ${JSON.stringify(b64('mini-pack.bundle'))});
        return 1;
    `);

    console.log('== a single preset ==');
    const one = JSON.parse(await page.eval(`(async () => {
        const p = await BrushPack.read(window.__fx.auto);
        const pr = p.presets[0];
        const bd = BrushPack.brushDefinition(pr);
        return JSON.stringify({
            kind: p.kind, count: p.presets.length,
            name: pr.name, paintop: pr.paintop,
            paramCount: Object.keys(pr.params).length,
            spacing: bd && bd.spacing, type: bd && bd.type,
            diameter: bd && bd.mask && bd.mask.diameter,
            ratio: bd && bd.mask && bd.mask.ratio,
            curve: BrushPack.parseCurve(pr.params.SizeSensor),
            opacity: pr.params.OpacityValue
        });
    })()`));
    console.log('  ' + JSON.stringify(one));

    check('a .kpp is read straight, without a pack around it',
        one.kind === 'kpp' && one.count === 1, `${one.kind}, ${one.count} presets`);
    check('the brush keeps the name its author gave it',
        /Eraser Kneaded Soft/.test(one.name), one.name);
    check('...and says which engine drew it',
        one.paintop === 'paintbrush', one.paintop);
    check('the settings come through in bulk, not a handful',
        one.paramCount > 100, `${one.paramCount} settings`);
    /* A generated tip carries its shape as numbers: how wide, how squashed,
     * how soft. Those are the sliders we already have. */
    check('a generated tip reports its diameter and squash',
        one.type === 'auto_brush' && Number(one.diameter) > 0 && Number(one.ratio) > 0,
        `${one.type} ${one.diameter} x ratio ${one.ratio}`);
    check('spacing comes through as a fraction of the tip',
        Number(one.spacing) > 0 && Number(one.spacing) < 2, String(one.spacing));
    check('a pressure curve arrives as points, the same shape our editor uses',
        Array.isArray(one.curve) && one.curve.length >= 2 &&
        one.curve.every(pt => pt.length === 2 && pt[0] >= 0 && pt[0] <= 1),
        JSON.stringify(one.curve));

    console.log('== a preset that stamps a tip ==');
    const two = JSON.parse(await page.eval(`(async () => {
        const p = await BrushPack.read(window.__fx.stamp);
        const pr = p.presets[0];
        const bd = BrushPack.brushDefinition(pr);
        const keys = Object.keys(pr.resources);
        const first = keys.length ? pr.resources[keys[0]] : null;
        /* The tip has to survive as an image, not just as bytes. */
        let drew = null;
        if (first && /\\.png$/i.test(keys[0])) {
            const bmp = await createImageBitmap(new Blob([first.bytes], { type: 'image/png' }));
            drew = { w: bmp.width, h: bmp.height };
        }
        return JSON.stringify({
            name: pr.name, type: bd && bd.type, tipFile: bd && bd.filename,
            resources: keys, bytes: first ? first.bytes.length : 0, drew
        });
    })()`));
    console.log('  ' + JSON.stringify(two));

    check('a stamped brush names the tip it stamps',
        !!two.tipFile && /gbr_brush|png_brush|gih/.test(two.type),
        `${two.type} / ${two.tipFile}`);
    check('the tip travels inside the preset itself',
        two.resources.length > 0 && two.bytes > 500,
        `${two.resources.length} resources, ${two.bytes} bytes`);
    check('...and what comes out is a real image',
        two.drew === null || (two.drew.w > 0 && two.drew.h > 0),
        JSON.stringify(two.drew));

    console.log('== a whole pack ==');
    const pack = JSON.parse(await page.eval(`(async () => {
        const p = await BrushPack.read(window.__fx.pack);
        return JSON.stringify({
            kind: p.kind,
            names: p.presets.map(x => x.name).sort(),
            thumbs: p.presets.filter(x => x.thumbnail && x.thumbnail.length > 1000).length,
            tips: Object.keys(p.tips),
            warnings: p.warnings
        });
    })()`));
    console.log('  ' + JSON.stringify(pack));

    check('a pack yields every preset inside it',
        pack.kind === 'bundle' && pack.names.length === 2, JSON.stringify(pack.names));
    /* Each preset file IS a thumbnail Krita rendered of that brush, which is
     * what lets us check our own rendering against the original later. */
    check('every preset brings Krita’s own picture of it',
        pack.thumbs === 2, `${pack.thumbs} of 2`);
    check('loose tips in the pack are collected too',
        pack.tips.indexOf('chisel_streaks.png') >= 0, JSON.stringify(pack.tips));
    check('nothing in the pack failed to read',
        pack.warnings.length === 0, JSON.stringify(pack.warnings));

    console.log('== turning a Krita brush into one of ours ==');
    const tr = JSON.parse(await page.eval(`(async () => {
        const out = {};
        const one = async (key) => {
            const p = await BrushPack.read(window.__fx[key]);
            const pr = p.presets[0];
            const bd = BrushPack.brushDefinition(pr);
            /* A stamped tip's real size is its image scaled by the preset's
             * own factor, so the tip has to be decoded before the size means
             * anything. */
            let tipSize = 0, tipUrl = null;
            if (bd && bd.filename && pr.resources[bd.filename]) {
                const blob = new Blob([pr.resources[bd.filename].bytes], { type: 'image/png' });
                const bmp = await createImageBitmap(blob);
                tipSize = Math.max(bmp.width, bmp.height);
                tipUrl = await new Promise(r => {
                    const fr = new FileReader();
                    fr.onload = () => r(fr.result);
                    fr.readAsDataURL(blob);
                });
            }
            const t = BrushPack.toPreset(pr, { tipSize });
            t.tipSize = tipSize; t.tipUrl = tipUrl;
            return t;
        };
        out.eraser = await one('auto');
        out.stamp = await one('stamp');

        /* The real test of a translation is that the engine accepts it. */
        const b = PaintApp.brush, app = PaintApp;
        const paint = async (t) => {
            app.layerMgr.collapseToBase({ fresh: true });
            app.setSize(400, 200); app.config.zoom = 1; app.updateBounds();
            document.getElementById('lsys-add').click();
            app.state.selection = null;
            const L = app.layerMgr.layers[app.layerMgr.activeIdx];
            const ps = Object.assign({}, t.params, { size: 30 });
            if (t.tipUrl) ps._tipUrl = t.tipUrl;
            b.PRESETS.__imported = ps;
            b.loadPreset('__imported');
            await new Promise(r => setTimeout(r, 500));
            b.beginStroke(40, 100, 0.9, '#ff0000');
            for (let x = 60; x <= 360; x += 10) b.moveStroke(x, 100, 0.9, '#ff0000');
            b.endStroke();
            await new Promise(r => setTimeout(r, 250));
            const d = L.ctx.getImageData(0, 0, 400, 200).data;
            let ink = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 20) ink++;
            delete b.PRESETS.__imported;
            return ink;
        };
        out.stampInk = await paint(out.stamp);
        b.loadPreset('Round');
        out.blendKnown = b.BLEND_MODES.indexOf(out.eraser.params.blendMode) >= 0;
        return JSON.stringify(out, (k, v) => k === 'tipUrl' ? (v ? 'data:' : null) : v);
    })()`, { awaitPromise: true }));
    console.log('  eraser ' + JSON.stringify(tr.eraser));
    console.log('  stamp  ' + JSON.stringify(tr.stamp) + '  ink ' + tr.stampInk);

    const E = tr.eraser.params, S = tr.stamp.params;
    check('a generated tip becomes a shape, a size and a squash',
        E.shape === 'circle' && E.size === 250 && E.aspectRatio === 1,
        `${E.shape} ${E.size} aspect ${E.aspectRatio}`);
    /* Krita's spacing is a fraction of the tip; ours is a percentage of it,
     * which is the same number written differently. */
    check('spacing arrives as our percentage of the tip',
        E.spacing === 10 && S.spacing === 4, `${E.spacing}% and ${S.spacing}%`);
    check('opacity and flow come across as percentages',
        E.opacity === 100 && S.opacity === 100 && S.flow === 40,
        `${E.opacity}/${E.flow} and ${S.opacity}/${S.flow}`);
    /* A gaussian tip has no hard edge even with both fade sliders at zero,
     * so reading the sliders literally would import a soft eraser as a disc. */
    check('a soft generated tip does not arrive hard-edged',
        E.hardness > 20 && E.hardness < 80, `hardness ${E.hardness}`);
    check('an eraser still erases',
        E.blendMode === 'erase' && tr.blendKnown, String(E.blendMode));
    check('the pressure curve carries over point for point',
        Array.isArray(E.sizeCurve) && E.sizeSrc === 'pressure' &&
        E.sizeCurve.length === 2 && Math.abs(E.sizeCurve[0][1] - 0.487437) < 1e-4,
        JSON.stringify(E.sizeCurve));
    check('...and a four-point one keeps all four',
        Array.isArray(S.sizeCurve) && S.sizeCurve.length === 4,
        JSON.stringify(S.sizeCurve));
    /* Krita keeps every widget's last value whether or not the option is
     * switched on, so reading values alone flings unscattered brushes apart. */
    check('a setting the brush had switched off stays off',
        E.scatter === 0 && S.scatter === 0, `${E.scatter} / ${S.scatter}`);
    check('a stamped tip is sized from its image, not from the scale alone',
        S.shape === 'custom' && tr.stamp.tipFile === 'bristle.png' &&
        S.size === Math.round(tr.stamp.tipSize * 0.296296) && S.size > 1,
        `${S.size} from a ${tr.stamp.tipSize}px tip`);
    check('a translated brush is one our engine will actually paint with',
        tr.stampInk > 500, `${tr.stampInk} pixels of ink`);
    check('a brush we can reproduce exactly reports nothing',
        tr.stamp.warnings.length === 0, JSON.stringify(tr.stamp.warnings));
    /* This eraser drives its opacity from pressure as well as its flow, and
     * we only have the one dab-level control. Losing it silently is what an
     * importer must not do. */
    check('...and one we cannot says which part it could not keep',
        tr.eraser.warnings.length === 1 && /opacity/.test(tr.eraser.warnings[0]),
        JSON.stringify(tr.eraser.warnings));

    console.log('== junk in, no crash out ==');
    const junk = JSON.parse(await page.eval(`(async () => {
        const out = {};
        const bad = new Uint8Array([1,2,3,4,5,6,7,8,9,10]);
        try { await BrushPack.read(bad); out.raw = 'resolved'; }
        catch (e) { out.raw = e.message; }
        // A ZIP with nothing brush-shaped in it.
        const empty = new Uint8Array([0x50,0x4b,0x05,0x06,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]);
        try { await BrushPack.read(empty); out.empty = 'resolved'; }
        catch (e) { out.empty = e.message; }
        return JSON.stringify(out);
    })()`));
    console.log('  ' + JSON.stringify(junk));
    check('a file that is not a brush pack is refused, not swallowed',
        junk.raw !== 'resolved' && junk.empty !== 'resolved',
        `${junk.raw} / ${junk.empty}`);
    check('...with a message a person can act on',
        /brush|ZIP|preset/i.test(junk.raw) && /brush|preset/i.test(junk.empty),
        `${junk.raw} / ${junk.empty}`);

    const errs = page.errors();
    console.log(`\npage errors: ${errs.length}`);
    for (const e of errs.slice(0, 5)) console.log('  ! ' + e.text.split('\n')[0]);
    console.log(`\n${pass} passed, ${fail} failed`);
});

process.exit(fail ? 1 : 0);
