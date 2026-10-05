import fs from 'fs'; import path from 'path';
// Black-box probe: portnov-pencils BB-Chalk pencil 2 lays 0.87x Krita's ink,
// run to run the same: build up, a flat inverted texture, a fully random
// 3-spiked circle. Each variant switches one of them off.
//   node job.mjs   then   node ../solo.mjs bbchalk <variants>
const root = path.resolve('test/krita/out/bbchalk');
const kpp = path.resolve('test/krita/out/bank-run/portnov-pencils/flat/paintoppresets/BB-Chalk pencil 2.kpp');
const val = (k, v) => [String.raw`(name="` + k + String.raw`"[^>]*>(?:<!\[CDATA\[)?)[^\]<]+`, String.raw`\g<1>` + v];
const notex = val('Texture/Pattern/Enabled', 'false'), norand = ['randomness="1"', 'randomness="0"'], nospike = ['spikes="3"', 'spikes="2"'];
const V = {
    line1: [],
    notex1: [notex],
    norand1: [norand],
    plain1: [notex, norand],
    plainsp1: [notex, norand, nospike],
    dab1: [notex, norand, ['spacing="0.02"', 'spacing="3"']],
    dabsp1: [notex, norand, nospike, ['spacing="0.02"', 'spacing="3"']],
    ramp: [],
};
for (const [name, xmlSub] of Object.entries(V)) {
    const lines = name === 'ramp' ? [[40, 100, 0.1, 440, 100, 1]] : [[40, 100, 1, 440, 100, 1]];
    const r = { name, file: path.basename(kpp), maxSize: 30, lines, rects: [], src: kpp, xmlSub };
    const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ width: 480, height: 200, out: dir.split(path.sep).join('/'), renders: [r] }, null, 1));
}
