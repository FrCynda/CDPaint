import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe: Krita's colour smudge engine. Basic_mix with every
// pressure input off, one flat stroke at pressure 1, over a grid of
// colour rate c, smudge rate s and smudge mode m (0 smearing, 1 dulling),
// on an empty layer and on one filled red -- what it picks up and how it
// mixes. One Krita for the lot.
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs smudge   then   python measure.py
const root = path.resolve('test/krita/out/smudge');
const kpp = path.resolve('test/krita/out/bank-run/krita3/flat/paintoppresets/Basic_mix.kpp');
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
// Colour and smudge rate stay switched on with a flat curve: switched off,
// colour rate adds no paint at all (bisect.mjs) -- off means off, not
// "ignore the pen". Size and spacing follow their flags.
const flat = k => ['(name="' + k + 'Sensor".*?<curve>)[^<]*', '\\g<1>0,1;1,1;'];
const off = [flat('ColorRate'), flat('SmudgeRate'), flat('Opacity'), val('PressureSize', 'false'), val('PressureSpacing', 'false')];
const lines = [[40, 60, 1, 440, 60, 1]];
const renders = [];
for (const fill of [null, [255, 0, 0, 255]])
    for (const m of [0, 1]) for (const c of [0, 0.25, 0.5, 1]) for (const s of [0, 0.25, 0.5, 1]) {
        const name = `${fill ? 'red' : 'empty'}-m${m}-c${c}-s${s}`;
        renders.push({ name, file: path.basename(kpp), size: 30, lines, ...(fill ? { fill } : {}),
            xmlSub: [...off, val('ColorRateValue', c), val('SmudgeRateValue', s), val('SmudgeRateMode', m)] });
    }
// The options' own off switches, last: an xmlSub edit stays on the preset for
// every later render in the session (see the harness), so nothing may follow.
const q = [...off, val('ColorRateValue', 0.25), val('SmudgeRateValue', 0.25), val('SmudgeRateMode', 0)];
renders.push({ name: 'red-offsr', file: path.basename(kpp), size: 30, lines, fill: [255, 0, 0, 255], xmlSub: [...q, val('PressureSmudgeRate', 'false')] });
renders.push({ name: 'red-offcr', file: path.basename(kpp), size: 30, lines, fill: [255, 0, 0, 255], xmlSub: [...q, val('PressureSmudgeRate', 'true'), val('PressureColorRate', 'false')] });
// probe-cdp.mjs reads one render per folder: a folder each, one Krita job for all
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
