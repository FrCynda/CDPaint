import fs from 'fs'; import path from 'path';
// Black-box probe: portnov-muses muses_04_04_Palette_knive, a colour smudge
// brush on a 35 x 2 rect whose spacing falls to nothing at full pressure,
// lays 1.6x Krita's ink. Each variant switches one option off.
//   node job.mjs   then   node ../solo.mjs knive <variants>
const root = path.resolve('test/krita/out/knive');
const kpp = path.resolve('test/krita/out/bank-run/portnov-muses/flat/paintoppresets/muses_04_04_Palette_knive.kpp');
const val = (k, v) => [String.raw`(name="` + k + String.raw`"[^>]*>(?:<!\[CDATA\[)?)[^\]<]+`, String.raw`\g<1>` + v];
const plain = [val('PressureScatter', 'false'), ['density="0.78"', 'density="1"']];
const V = {
    line1: plain,
    line5: plain,
    ramp: plain,
    nosp1: [...plain, val('PressureSpacing', 'false')],
    norot1: [...plain, val('PressureRotation', 'false')],
    dens1: [val('PressureScatter', 'false')],
    scat1: [['density="0.78"', 'density="1"']],
    bank: [],
    rl1: plain,
    rlnorot1: [...plain, val('PressureRotation', 'false')],
    rldab1: [...plain, val('PressureSpacing', 'false'), ['spacing="0.02"', 'spacing="3"']],
    dec: plain,
    dab1: [...plain, val('PressureSpacing', 'false'), ['spacing="0.02"', 'spacing="3"']],
};
for (const [name, xmlSub] of Object.entries(V)) {
    const p = /5$/.test(name) ? 0.5 : 1;
    const lines = name === 'bank' ? [[40, 50, 0.1, 440, 50, 1], [60, 185, 0.8, 200, 115, 0.8], [300, 115, 0.5, 300, 185, 0.5], [440, 250, 1, 40, 250, 0.5]]
        : /^rl/.test(name) ? [[440, 100, 1, 40, 100, 1]] : name === 'dec' ? [[40, 100, 1, 440, 100, 0.5]]
        : name === 'ramp' ? [[40, 100, 0.1, 440, 100, 1]] : [[40, 100, p, 440, 100, p]];
    const r = { name, file: path.basename(kpp), maxSize: 30, lines, rects: [], src: kpp, xmlSub };
    const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ width: 480, height: name === 'bank' ? 300 : 200, out: dir.split(path.sep).join('/'), renders: [r] }, null, 1));
}
