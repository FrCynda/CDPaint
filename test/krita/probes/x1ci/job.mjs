import fs from 'fs'; import path from 'path';
// Black-box probe: portnov-modular X1CI - Sketch lays 0.75x Krita's ink, run
// to run the same: wash, flow 0.4, a pressure-driven sharpness threshold, a
// 0.7-density gauss oval. Each variant switches one of them off.
//   node job.mjs   then   node ../solo.mjs x1ci <variants>
const root = path.resolve('test/krita/out/x1ci');
const kpp = path.resolve('test/krita/out/bank-run/portnov-modular/flat/paintoppresets/X1CI_Sketch.kpp');
const val = (k, v) => [String.raw`(name="` + k + String.raw`"[^>]*>(?:<!\[CDATA\[)?)[^\]<]+`, String.raw`\g<1>` + v];
const nosharp = val('PressureSharpness', 'false'), noscat = val('PressureScatter', 'false'), norot = val('PressureRotation', 'false');
const dense = [['density="0.7"', 'density="1"'], ['randomness="0.5"', 'randomness="0"']], lone = ['spacing="0.02"', 'spacing="3"'];
const V = {
    bank: [],
    line1: [],
    plain1: [noscat, norot, ...dense],
    nosharp1: [noscat, norot, ...dense, nosharp],
    dab1: [noscat, norot, ...dense, lone],
    dabns1: [noscat, norot, ...dense, nosharp, lone],
    ramp: [noscat, norot, ...dense],
    dens1: [noscat, norot],
    scat1: [norot, ...dense],
    rot1: [noscat, ...dense],
};
for (const [name, xmlSub] of Object.entries(V)) {
    const lines = name === 'bank' ? [[40, 50, 0.1, 440, 50, 1], [60, 185, 0.8, 200, 115, 0.8], [300, 115, 0.5, 300, 185, 0.5], [440, 250, 1, 40, 250, 0.5]]
        : name === 'ramp' ? [[40, 100, 0.1, 440, 100, 1]] : [[40, 100, 1, 440, 100, 1]];
    const r = { name, file: path.basename(kpp), maxSize: 30, lines, rects: [], src: kpp, xmlSub };
    const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ width: 480, height: name === 'bank' ? 300 : 200, out: dir.split(path.sep).join('/'), renders: [r] }, null, 1));
}
