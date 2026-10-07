import fs from 'fs'; import path from 'path';
// Rake Smudge (a smearing smudge, image tip turned by the drawing angle) lays
// its tines a row above ours. One level line at pressure 1; each render
// changes one thing: the size, the line's height, or the turn switched off.
//   node job.mjs   then   node ../solo.mjs rksm <variants...>
const root = path.resolve('test/krita/out/rksm');
const kpp = path.resolve('test/krita/out/bank-run/portnov-MostUsed/flat/paintoppresets/Rake SmudgepG3220.kpp');
const val = (k, v) => ['(name="' + k + String.raw`"[^>]*>(?:<!\[CDATA\[)?)[^\]<]+`, String.raw`\g<1>` + v];
const L = (y) => [[40, y, 1, 440, y, 1]];
const V = {
    s30: [30, L(50), []], s31: [31, L(50), []], s29: [29, L(50), []], s32: [32, L(50), []],
    y25: [30, L(50.25), []], y75: [30, L(50.75), []],
    norot: [30, L(50), [val('PressureRotation', 'false')]],
    rtl: [30, [[440, 50, 1, 40, 50, 1]], []],
};
const job = { width: 480, height: 100, renders: [] };
for (const [name, [size, lines, xmlSub]] of Object.entries(V)) {
    const d = path.join(root, name); fs.mkdirSync(d, { recursive: true });
    const r = { name, file: path.basename(kpp), src: kpp, size, lines, rects: [], xmlSub };
    fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ ...job, out: d.split(path.sep).join('/'), renders: [r] }, null, 1));
}
