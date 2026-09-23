import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe, third pass on Krita's colour smudge: Basic_mix exactly as
// shipped, at pressure 1, 0.5 and a 0 -> 1 ramp -- how its pressure curves
// (colour rate, smudge rate, opacity) act on the fitted model.
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs smudge3
const root = path.resolve('test/krita/out/smudge3');
const kpp = path.resolve('test/krita/out/bank-run/krita3/flat/paintoppresets/Basic_mix.kpp');
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const flat = k => ['(name="' + k + 'Sensor".*?<curve>)[^<]*', '\\g<1>0,1;1,1;'];
const base = [flat('ColorRate'), flat('SmudgeRate'), flat('Opacity'), val('PressureSize', 'false'), val('PressureSpacing', 'false')];
const red = [255, 0, 0, 255], blue = [0, 0, 255, 255];
const V = [
    ['asis-p1', null, [], [[40, 60, 1, 440, 60, 1]]],
    ['asis-p05', null, [], [[40, 60, 0.5, 440, 60, 0.5]]],
    ['asis-ramp', null, [], [[40, 60, 0, 440, 60, 1]]],
];
const renders = V.map(([name, fill, rects, lines, c, s, m = 0, size = 30]) => ({ name, file: path.basename(kpp), size, lines, rects,
    ...(fill ? { fill } : {}), xmlSub: [] }));
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
