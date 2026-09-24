import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe, ninth pass on Krita's colour smudge: smudge rate switched
// OFF, as the X2F "Smeary" presets have it (they paint lighter as pressure
// rises in Krita and darker in ours). Colour rate on a linear pressure curve
// at 0.5 / 0.75 / 1, at constant pressures, on empty and over red; then the
// Smeary presets' opacity curve with its switch off.
// xmlSub edits persist on the preset, so every render sets every value it uses.
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs smudge9
const root = path.resolve('test/krita/out/smudge9');
const kpp = path.resolve('test/krita/out/bank-run/krita3/flat/paintoppresets/Basic_mix.kpp');
const curve = (k, c) => ['(name="' + k + 'Sensor".*?<curve>)[^<]*', '\\g<1>' + c];
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const FLAT = '0,1;1,1;', LIN = '0,0;1,1;', OPX = '0,0.0763052;0.417671,1;', red = [255, 0, 0, 255];
const set = (cv, oc, srOn) => [val('PressureSmudgeRate', srOn ? 'true' : 'false'), curve('ColorRate', LIN), val('ColorRateValue', cv),
    curve('SmudgeRate', FLAT), val('SmudgeRateValue', 1), curve('Opacity', oc)];
const V = [];   // name, xmlSub, pressure, fill
for (const cv of [0.5, 0.75, 1]) for (const p of [0.25, 0.5, 1]) {
    V.push(['e-c' + cv + '-p' + p, set(cv, FLAT, false), p, null]);
    V.push(['r-c' + cv + '-p' + p, set(cv, FLAT, false), p, red]);
}
for (const p of [0.1, 0.25, 1]) V.push(['e-opx-p' + p, set(0.75, OPX, false), p, null]);
const renders = V.map(([name, xmlSub, p, fill]) => ({ name, file: path.basename(kpp), size: 30,
    lines: [[40, 60, p, 440, 60, p]], rects: [], ...(fill ? { fill } : {}), xmlSub }));
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
