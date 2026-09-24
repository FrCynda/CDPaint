import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe: how does Krita combine a "sensorslist" (several sensors
// on one option)? X2FA Smeary Bristle's colour rate is pressure + speed, and
// in the harness speed reads 0 (probes/speed), yet its paint FALLS as pressure
// rises. Colour smudge, smudge off, colour rate = [pressure 0,0;1,1] with
// [speed 0,1;1,0] (1 at rest), each <X>curveMode from none to 4, at constant
// pressures. Second pass: pressure alone in a list, speed alone, and plain;
// third: speed's curve held at 0.5, and the two in the other order.
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs sensorlist
const root = path.resolve('test/krita/out/sensorlist');
const kpp = path.resolve('test/krita/out/bank-run/krita3/flat/paintoppresets/Basic_mix.kpp');
const curve = (k, c) => ['(name="' + k + 'Sensor".*?<curve>)[^<]*', '\\g<1>' + c];
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const FLAT = '0,1;1,1;';
const P = '<ChildSensor id="pressure"> <curve>0,0;1,1;</curve> </ChildSensor>', S = '<ChildSensor id="speed"> <curve>0,1;1,0;</curve> </ChildSensor>';
const SENS = '(name="ColorRateSensor"[^>]*><!\\[CDATA\\[)[\\s\\S]*?(\\]\\]>)';
const list = kids => [SENS, '\\g<1><!DOCTYPE params> <params id="sensorslist"> ' + kids + ' </params> \\g<2>'];
const plain = [SENS, '\\g<1><!DOCTYPE params> <params id="pressure"> <curve>0,0;1,1;</curve> </params> \\g<2>'];
const set = s => [val('PressureSmudgeRate', 'false'), val('ColorRateValue', 1), curve('Opacity', FLAT), s];
const V = [];
for (const p of [0.1, 0.25, 0.5, 0.75, 1]) {
    V.push(['both-p' + p, set(list(P + ' ' + S)), p]);
    V.push(['ponly-p' + p, set(list(P)), p]);
    V.push(['sonly-p' + p, set(list(S)), p]);
    V.push(['plain-p' + p, set(plain), p]);
    V.push(['half-p' + p, set(list(P + ' ' + S.replace('0,1;1,0;', '0,0.5;1,0.5;'))), p]);
    V.push(['rev-p' + p, set(list(S + ' ' + P)), p]);
}
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
