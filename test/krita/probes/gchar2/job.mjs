import fs from 'fs'; import path from 'path';
// Black-box probe: the fixed-spacing Grease Charcoal (portnov-MostUsed) went
// 1.014 -> 1.094 when Krita's square tip was placed at its sub-pixel phase,
// while every other square-tip brush came closer. Lone dabs and the line,
// with scatter off, grain on and off.
//   node job.mjs   then   node ../solo.mjs gchar2 <variants>
const root = path.resolve('test/krita/out/gchar2');
const kpp = path.resolve('test/krita/out/bank-run/portnov-MostUsed/flat/paintoppresets/Grease CharcoalF15482.kpp');
const val = (k, v) => [String.raw`(name="` + k + String.raw`"[^>]*>(?:<!\[CDATA\[)?)[^\]<]+`, String.raw`\g<1>` + v];
const noscat = val('PressureScatter', 'false'), notex = val('Texture/Pattern/Enabled', 'false'), lone = ['spacing="0.05"', 'spacing="3"'];
const V = {
    bank: [],
    as1: [],
    line1: [noscat],
    linen1: [noscat, notex],
    dab1: [noscat, lone],
    dabn1: [noscat, notex, lone],
};
for (const [name, xmlSub] of Object.entries(V)) {
    // whole pixels: Krita's paintLine takes a QPoint
    const lines = name === 'bank' ? [[40, 50, 0.1, 440, 50, 1], [60, 185, 0.8, 200, 115, 0.8], [300, 115, 0.5, 300, 185, 0.5], [440, 250, 1, 40, 250, 0.5]]
        : [[40, 100, 1, 440, 100, 1]];
    const r = { name, file: path.basename(kpp), maxSize: 30, lines, rects: [], src: kpp, xmlSub };
    const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ width: 480, height: name === 'bank' ? 300 : 200, out: dir.split(path.sep).join('/'), renders: [r] }, null, 1));
}
