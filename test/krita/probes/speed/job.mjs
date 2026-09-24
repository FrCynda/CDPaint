import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe: what does Krita's speed sensor read in the headless
// harness? measure.mjs assumed 0 (paintLine carries no timestamps), but X2FA
// Smeary Bristle, whose colour rate is pressure x speed, fades along its
// strokes in Krita. Opacity driven by speed alone (curve: opacity = speed,
// and inverted), lines of three lengths and two directions, pressure 1.
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs speed
const root = path.resolve('test/krita/out/speed');
const kpp = path.resolve('test/krita/out/bank-run/krita3/flat/paintoppresets/Basic_tip_default.kpp');
const sensor = c => ['(name="OpacitySensor"[^>]*>(?:<!\\[CDATA\\[)?)[\\s\\S]*?</params>',
    '\\g<1><!DOCTYPE params> <params id="speed"> <curve>' + c + '</curve> </params>'];
const V = { up: '0,0;1,1;', down: '0,1;1,0;' };
const renders = [];
for (const [n, c] of Object.entries(V))
    renders.push({ name: 'speed-' + n, file: path.basename(kpp), size: 20, xmlSub: [sensor(c)],
        lines: [[20, 30, 1, 460, 30, 1], [20, 80, 1, 120, 80, 1], [20, 130, 1, 60, 130, 1], [460, 180, 1, 20, 180, 1], [240, 230, 1, 241, 230, 1]] });
fs.mkdirSync(root, { recursive: true });
const job = { width: 480, height: 260, out: root.split(path.sep).join('/'), renders };
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
