import fs from 'fs'; import path from 'path';
// A - Aquarelle Paint (Krita 2 colour smudge): its ink falls with pressure
// far faster than ours. One level line at one pressure per render, and the
// same with the smudge rate's and colour rate's pressure switched off.
//   node job.mjs   then   node ../solo.mjs aqp <variants...>
const root = path.resolve('test/krita/out/aqp');
const kpp = path.resolve('test/krita/out/bank-run/portnov-comics/flat/paintoppresets/A - Aquarelle Paint.kpp');
const val = (k, v) => ['(name="' + k + '">)[^<]+', String.raw`\g<1>` + v];
const L = (p) => [[40, 50, p, 440, 50, p]];
const V = {
    p100: [L(1), []], p075: [L(0.75), []], p050: [L(0.5), []], p030: [L(0.3), []],
    nosr050: [L(0.5), [val('PressureSmudgeRate', 'false')]],
    nocr050: [L(0.5), [val('PressureColorRate', 'false')]],
    nosc050: [L(0.5), [val('PressureScatter', 'false')]],
};
for (const [name, [lines, xmlSub]] of Object.entries(V)) {
    const d = path.join(root, name); fs.mkdirSync(d, { recursive: true });
    const r = { name, file: path.basename(kpp), src: kpp, maxSize: 30, lines, rects: [], xmlSub };
    fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ width: 480, height: 100, out: d.split(path.sep).join('/'), renders: [r] }, null, 1));
}
