import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe, seventh pass on Krita's colour smudge: the bank's worst
// misses are dulling brushes, often with an opacity slider under 1. Earlier
// passes met dulling only as a smear out of a block and opacity only at 1.
// Here: dulling painting on an empty layer and a red one, and the opacity
// slider in both modes. Flat curves throughout; every render sets every value.
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs smudge7
const root = path.resolve('test/krita/out/smudge7');
const kpp = path.resolve('test/krita/out/bank-run/krita3/flat/paintoppresets/Basic_mix.kpp');
const curve = (k, c) => ['(name="' + k + 'Sensor".*?<curve>)[^<]*', '\\g<1>' + c];
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const FLAT = '0,1;1,1;', red = [255, 0, 0, 255];
const set = (c, s, m, op) => [curve('ColorRate', FLAT), curve('SmudgeRate', FLAT), curve('Opacity', FLAT),
    val('ColorRateValue', c), val('SmudgeRateValue', s), val('SmudgeRateMode', m), val('OpacityValue', op)];
const V = [];   // name, xmlSub, fill
for (const m of [0, 1]) for (const op of [1, 0.5]) for (const [c, s] of [[1, 1], [1, 0.5], [0.5, 0.5], [0.25, 1]]) {
    const n = 'm' + m + '-op' + op + '-c' + c + '-s' + s;
    V.push(['empty-' + n, set(c, s, m, op), null]);
    if (op === 1) V.push(['red-' + n, set(c, s, m, op), red]);
}
const renders = V.map(([name, xmlSub, fill]) => ({ name, file: path.basename(kpp), size: 30,
    lines: [[40, 60, 1, 440, 60, 1]], rects: [], ...(fill ? { fill } : {}), xmlSub }));
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
    fs.copyFileSync(kpp, path.join(res, 'paintoppresets', path.basename(kpp)));
    renderKrita(path.join(root, 'job.json'), { resourceDir: res, timeoutMs: 600000 });
    for (const r of renders) fs.renameSync(path.join(root, r.name + '.png'), path.join(root, r.name, r.name + '.png'));
    console.log(fs.readFileSync(path.join(root, 'harness.log'), 'utf8').split('\n').filter(l => /MISSING|rror|FAIL/.test(l)).join('\n') || 'ok');
}
