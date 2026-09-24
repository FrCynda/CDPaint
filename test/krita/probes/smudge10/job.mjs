import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe, tenth pass on Krita's colour smudge: does its size curve
// act with the size switch off, as its opacity curve does (smudge6)? The X2F
// "Smeary" presets have a shrinking size curve and the switch off, and
// Krita's strokes narrow as pressure rises. Plain smudge (smudge off, colour
// rate 1) at constant pressures, size curve 1 -> 0.3.
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs smudge10
const root = path.resolve('test/krita/out/smudge10');
const kpp = path.resolve('test/krita/out/bank-run/krita3/flat/paintoppresets/Basic_mix.kpp');
const curve = (k, c) => ['(name="' + k + 'Sensor".*?<curve>)[^<]*', '\\g<1>' + c];
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const FLAT = '0,1;1,1;', SHR = '0,1;1,0.3;';
const set = on => [val('PressureSmudgeRate', 'false'), curve('ColorRate', FLAT), val('ColorRateValue', 1), curve('Opacity', FLAT),
    val('PressureSize', on ? 'true' : 'false'), val('SizeUseCurve', 'true'), curve('Size', SHR)];
const V = [];
for (const on of [false, true]) for (const p of [0.25, 1]) V.push(['size-' + (on ? 'on' : 'off') + '-p' + p, set(on), p]);
const renders = V.map(([name, xmlSub, p]) => ({ name, file: path.basename(kpp), size: 30,
    lines: [[40, 60, p, 440, 60, p]], rects: [], xmlSub }));
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
