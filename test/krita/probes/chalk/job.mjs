import fs from 'fs'; import path from 'path';
// Black-box probe: X1DC - Chalk lays 0.64x Krita's ink, run to run the same.
// Each variant switches one of its options off, in Krita and (by param) in ours.
//   node job.mjs   then   node ../solo.mjs chalk <variants>
const root = path.resolve('test/krita/out/chalk');
const kpp = path.resolve('test/krita/out/bank-run/portnov-modular/flat/paintoppresets/X1DC_Chalk.kpp');
const val = (k, v) => [String.raw`(name="` + k + String.raw`"[^>]*>(?:<!\[CDATA\[)?)[^\]<]+`, String.raw`\g<1>` + v];
const notex = val('Texture/Pattern/Enabled', 'false');
const V = {
    base1: [],
    notex1: [notex],
    plain1: [notex, ['randomness="0.6" density="0.4"', 'randomness="0" density="1"']],
    norot1: [notex, val('PressureRotation', 'false')],
    nosize1: [notex, val('PressureSize', 'false')],
    noop1: [notex, val('PressureOpacity', 'false')],
    nospace1: [notex, val('PressureSpacing', 'false')],
    ptex1: [['randomness="0.6" density="0.4"', 'randomness="0" density="1"']],
    sdab1: [['spacing="0.04"', 'spacing="3"']],
    sdabn1: [notex, ['spacing="0.04"', 'spacing="3"']],
    spdab1: [['randomness="0.6" density="0.4" BrushVersion="2" spacing="0.04"', 'randomness="0" density="1" BrushVersion="2" spacing="3"']],
    spn1: [notex, ['randomness="0.6" density="0.4" BrushVersion="2" spacing="0.04"', 'randomness="0" density="1" BrushVersion="2" spacing="3"']],
    base: [],
    notex: [notex],
};
for (const [name, xmlSub] of Object.entries(V)) {
    const lines = /1$/.test(name) ? [[40, 100, 1, 440, 100, 1]] : [[40, 100, 0.1, 440, 100, 1]];
    const r = { name, file: path.basename(kpp), maxSize: 30, lines, rects: [], src: kpp, xmlSub };
    const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ width: 480, height: 200, out: dir.split(path.sep).join('/'), renders: [r] }, null, 1));
}
