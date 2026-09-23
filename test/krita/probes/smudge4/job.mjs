import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe, fourth pass on Krita's colour smudge: Basic_mix's two
// pressure curves one at a time (the other flat), at constant pressures, to
// read off what colour rate and smudge rate each curve really gives.
// xmlSub edits persist on the preset, so every render sets both curves.
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs smudge4
const root = path.resolve('test/krita/out/smudge4');
const kpp = path.resolve('test/krita/out/bank-run/krita3/flat/paintoppresets/Basic_mix.kpp');
const curve = (k, c) => ['(name="' + k + 'Sensor".*?<curve>)[^<]*', '\\g<1>' + c];
const CR = '0,0;0.526104,0;1,1;', SR = '0,1;0.506024,1;1,0.484716;', FLAT = '0,1;1,1;';
const V = [];
for (const p of [0.6, 0.7, 0.8, 0.9, 1]) {
    V.push(['cr-p' + p, [curve('ColorRate', CR), curve('SmudgeRate', FLAT)], p]);
    V.push(['sr-p' + p, [curve('ColorRate', FLAT), curve('SmudgeRate', SR)], p]);
}
const renders = V.map(([name, xmlSub, p]) => ({ name, file: path.basename(kpp), size: 30, lines: [[40, 60, p, 440, 60, p]], rects: [], xmlSub }));
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
