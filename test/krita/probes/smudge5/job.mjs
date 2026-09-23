import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe, fifth pass on Krita's colour smudge: smudge4 could not tell
// colour rate from smudge rate (black on empty looks alike along a ridge), so
// here each is read where only it matters -- smudge rate alone as a pure smear
// out of a blue block (colour rate 0), colour rate against a red fill.
// xmlSub edits persist on the preset, so every render sets every value it uses.
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs smudge5
const root = path.resolve('test/krita/out/smudge5');
const kpp = path.resolve('test/krita/out/bank-run/krita3/flat/paintoppresets/Basic_mix.kpp');
const curve = (k, c) => ['(name="' + k + 'Sensor".*?<curve>)[^<]*', '\\g<1>' + c];
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const CR = '0,0;0.526104,0;1,1;', SR = '0,1;0.506024,1;1,0.484716;', FLAT = '0,1;1,1;', LIN = '0,0;1,1;';
const blue = [[0, 0, 120, 120, 0, 0, 255, 255]], red = [255, 0, 0, 255];
const set = (cc, cv, sc, sv) => [curve('ColorRate', cc), val('ColorRateValue', cv), curve('SmudgeRate', sc), val('SmudgeRateValue', sv)];
const V = [];   // name, xmlSub, pressure, fill, rects
for (const L of [0.25, 0.5, 0.75]) V.push(['drag-flat' + L, set(FLAT, 0, FLAT, L), 1, null, blue]);
for (const p of [0.25, 0.5, 0.75, 1]) V.push(['drag-lin-p' + p, set(FLAT, 0, LIN, 1), p, null, blue]);
for (const p of [0.6, 0.8, 1]) {
    V.push(['drag-sr-p' + p, set(FLAT, 0, SR, 0.65), p, null, blue]);
    V.push(['red-cr-p' + p, set(CR, 1, FLAT, 0.65), p, red, []]);
    V.push(['red-sr-p' + p, set(FLAT, 1, SR, 0.65), p, red, []]);
}
for (const p of [0.5, 1]) V.push(['red-crlin-p' + p, set(LIN, 1, FLAT, 0.65), p, red, []]);
const renders = V.map(([name, xmlSub, p, fill, rects]) => ({ name, file: path.basename(kpp), size: 30,
    lines: [[rects.length ? 60 : 40, 60, p, 440, 60, p]], rects, ...(fill ? { fill } : {}), xmlSub }));
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
