import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe, eighth pass on Krita's colour smudge: every rule so far was
// measured on Basic_mix's hard round tip. Do they hold on soft tips (gauss and
// linear fades) and on picture tips (.gbr and .png)? Four situations per tip:
// paint on empty, paint over red, a pure smear out of a blue block, dulling.
// Every render sets its tip and every value it uses (xmlSub edits persist).
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs smudge8
const root = path.resolve('test/krita/out/smudge8');
const kpp = path.resolve('test/krita/out/bank-run/krita3/flat/paintoppresets/Basic_mix.kpp');
const brushes = path.resolve('test/krita/out/bank-run/krita3/flat/brushes');
const curve = (k, c) => ['(name="' + k + 'Sensor".*?<curve>)[^<]*', '\\g<1>' + c];
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const tipDef = d => ['(name="brush_definition"[^>]*><!\\[CDATA\\[)[\\s\\S]*?(\\]\\]>)', '\\g<1>' + d + '\\g<2>'];
const auto = (id, fade) => '<Brush type="auto_brush" useAutoSpacing="1" randomness="0" density="1" autoSpacingCoeff="0.3" BrushVersion="2" spacing="0.1" angle="0">' +
    '<MaskGenerator ratio="1" type="circle" vfade="' + fade + '" id="' + id + '" spikes="2" antialiasEdges="1" hfade="' + fade + '" diameter="50"/></Brush>';
const pic = (type, file) => '<Brush type="' + type + '" filename="' + file + '" name="' + file.replace(/\.\w+$/, '') +
    '" scale="1" spacing="0.1" useAutoSpacing="1" autoSpacingCoeff="0.3" angle="0" BrushVersion="2" ColorAsMask="1"/>';
const TIPS = [
    ['gauss05', auto('gauss', 0.5)], ['gauss02', auto('gauss', 0.2)], ['lin05', auto('default', 0.5)],
    ['gbr', pic('gbr_brush', 'A_crayon.gbr'), 'A_crayon.gbr'], ['png', pic('png_brush', '3_brush.png'), '3_brush.png'],
];
const FLAT = '0,1;1,1;', red = [255, 0, 0, 255], blue = [[0, 0, 120, 120, 0, 0, 255, 255]];
const set = (c, s, m) => [curve('ColorRate', FLAT), curve('SmudgeRate', FLAT), curve('Opacity', FLAT),
    val('ColorRateValue', c), val('SmudgeRateValue', s), val('SmudgeRateMode', m), val('OpacityValue', 1)];
const SIT = [   // name, c, s, mode, fill, rects
    ['empty', 0.5, 0.5, 0, null, []], ['red', 0.25, 1, 0, red, []],
    ['drag', 0, 0.75, 0, null, blue], ['dull', 0.5, 0.5, 1, null, []],
];
const renders = [];
for (const [tn, def, file] of TIPS) for (const [sn, c, s, m, fill, rects] of SIT)
    renders.push({ name: tn + '-' + sn, file: path.basename(kpp), size: 30, rects, ...(fill ? { fill } : {}),
        ...(file ? { tip: path.join(brushes, file).split(path.sep).join('/') } : {}),
        lines: [[rects.length ? 60 : 40, 60, 1, 440, 60, 1]], xmlSub: [tipDef(def), ...set(c, s, m)] });
fs.mkdirSync(root, { recursive: true });
const job = { width: 480, height: 120, out: root.split(path.sep).join('/'), renders };
fs.writeFileSync(path.join(root, 'job.json'), JSON.stringify(job, null, 1));
for (const r of renders) {
    const d = path.join(root, r.name); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ ...job, out: d.split(path.sep).join('/'), renders: [{ ...r, src: kpp }] }, null, 1));
}
if (!process.argv.includes('--dry')) {
    const res = path.join(root, 'kres');
    fs.rmSync(res, { recursive: true, force: true });
    fs.mkdirSync(path.join(res, 'paintoppresets'), { recursive: true });
    fs.mkdirSync(path.join(res, 'brushes'), { recursive: true });
    fs.copyFileSync(kpp, path.join(res, 'paintoppresets', path.basename(kpp)));
    for (const [, , file] of TIPS) if (file) fs.copyFileSync(path.join(brushes, file), path.join(res, 'brushes', file));
    renderKrita(path.join(root, 'job.json'), { resourceDir: res, timeoutMs: 600000 });
    for (const r of renders) fs.renameSync(path.join(root, r.name + '.png'), path.join(root, r.name, r.name + '.png'));
    console.log(fs.readFileSync(path.join(root, 'harness.log'), 'utf8').split('\n').filter(l => /MISSING|rror|FAIL/.test(l)).join('\n') || 'ok');
}
