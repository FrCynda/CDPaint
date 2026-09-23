import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe, second pass on Krita's colour smudge (see ../smudge):
// what ONE dab does, what a short stroke does, and how far a pure smear
// (no paint) carries colour out of a blue block. Basic_mix, smearing unless
// named -d (dulling), pressure-free curves, one Krita for the lot.
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs smudge2
const root = path.resolve('test/krita/out/smudge2');
const kpp = path.resolve('test/krita/out/bank-run/krita3/flat/paintoppresets/Basic_mix.kpp');
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const flat = k => ['(name="' + k + 'Sensor".*?<curve>)[^<]*', '\\g<1>0,1;1,1;'];
const base = [flat('ColorRate'), flat('SmudgeRate'), flat('Opacity'), val('PressureSize', 'false'), val('PressureSpacing', 'false')];
const red = [255, 0, 0, 255], blue = [0, 0, 255, 255];
const V = [
    ['dot-c25-s100', red, [], [[200, 60, 1, 200, 60, 1]], 0.25, 1],
    ['dot-c25-s25', red, [], [[200, 60, 1, 200, 60, 1]], 0.25, 0.25],
    ['dot-c100-s25', null, [], [[200, 60, 1, 200, 60, 1]], 1, 0.25],
    ['short-c25-s100', red, [], [[200, 60, 1, 210, 60, 1]], 0.25, 1],
    ['short-c100-s25', null, [], [[200, 60, 1, 210, 60, 1]], 1, 0.25],
    ['drag-c0-s100', null, [[0, 0, 120, 120, ...blue]], [[60, 60, 1, 440, 60, 1]], 0, 1],
    ['drag-c0-s50', null, [[0, 0, 120, 120, ...blue]], [[60, 60, 1, 440, 60, 1]], 0, 0.5],
    ['drag-c0-s100-d', null, [[0, 0, 120, 120, ...blue]], [[60, 60, 1, 440, 60, 1]], 0, 1, 1],
    ['drag-c0-s50-d', null, [[0, 0, 120, 120, ...blue]], [[60, 60, 1, 440, 60, 1]], 0, 0.5, 1],
    ['ondrag-c0-s100', red, [[0, 0, 120, 120, ...blue]], [[60, 60, 1, 440, 60, 1]], 0, 1],
    // where the paint's share stops falling as smudge rate rises, and whether size moves it
    ['red-c50-s75', red, [], [[40, 60, 1, 440, 60, 1]], 0.5, 0.75],
    ['red-c50-s90', red, [], [[40, 60, 1, 440, 60, 1]], 0.5, 0.9],
    ['red-c50-s100', red, [], [[40, 60, 1, 440, 60, 1]], 0.5, 1],
    ['big-c50-s50', red, [], [[40, 60, 1, 440, 60, 1]], 0.5, 0.5, 0, 60],
    ['big-c50-s100', red, [], [[40, 60, 1, 440, 60, 1]], 0.5, 1, 0, 60],
];
const renders = V.map(([name, fill, rects, lines, c, s, m = 0, size = 30]) => ({ name, file: path.basename(kpp), size, lines, rects,
    ...(fill ? { fill } : {}), xmlSub: [...base, val('ColorRateValue', c), val('SmudgeRateValue', s), val('SmudgeRateMode', m)] }));
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
