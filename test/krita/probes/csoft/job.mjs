import fs from 'fs'; import path from 'path';
// Black-box probe: X2AF - Charcoal Soft (T) lays 0.53x Krita's ink, its
// plain twin 1.0. The (T) adds Sharpness on declination and declination to
// size and opacity. Each variant switches one of those off.
//   node job.mjs   then   node ../solo.mjs csoft <variants>
const root = path.resolve('test/krita/out/csoft');
const kpp = path.resolve('test/krita/out/bank-run/portnov-modular/flat/paintoppresets/X2AF_CharcoalSoft_T.kpp');
const val = (k, v) => [String.raw`(name="` + k + String.raw`"[^>]*>(?:<!\[CDATA\[)?)[^\]<]+`, String.raw`\g<1>` + v];
const nosharp = val('PressureSharpness', 'false'), notex = val('Texture/Pattern/Enabled', 'false'),
    norot = val('PressureRotation', 'false');
const V = {
    base1: [norot],
    nosharp1: [norot, nosharp],
    notex1: [norot, notex],
    plain1: [norot, notex, nosharp],
    dab1: [norot, ['spacing="0.3"', 'spacing="5"']],
    dabns1: [norot, nosharp, ['spacing="0.3"', 'spacing="5"']],
    bank: [],
    bankr: [norot],
    ramp: [norot],
    rampns: [norot, nosharp],
};
for (const [name, xmlSub] of Object.entries(V)) {
    const lines = /^bank/.test(name) ? [[40, 50, 0.1, 440, 50, 1], [60, 185, 0.8, 200, 115, 0.8], [300, 115, 0.5, 300, 185, 0.5], [440, 250, 1, 40, 250, 0.5]]
        : /^ramp/.test(name) ? [[40, 100, 0.1, 440, 100, 1]] : [[40, 100, 1, 440, 100, 1]];
    const r = { name, file: path.basename(kpp), maxSize: 30, lines, rects: [], src: kpp, xmlSub };
    const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ width: 480, height: /^bank/.test(name) ? 300 : 200, out: dir.split(path.sep).join('/'), renders: [r] }, null, 1));
}
