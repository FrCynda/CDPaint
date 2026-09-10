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
