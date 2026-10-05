import fs from 'fs'; import path from 'path';
// Black-box probe: Grease Pencil Square lays a sparse line at light pressure in
// Krita and a fuller one here. Each variant switches one of its options off.
//   node job.mjs   then   node ../solo.mjs gpsq <variants>   then   node ../probe-cdp.mjs gpsq
const root = path.resolve('test/krita/out/gpsq');
const kpp = path.resolve('test/krita/out/bank/portnov/pencils/paintoppresets/Grease Pencil SquareuD3659.kpp');
const val = (k, v) => [String.raw`(name="` + k + String.raw`"[^>]*>(?:<!\[CDATA\[)?)[^\]<]+`, String.raw`\g<1>` + v];
const V = {
    base: [],
    notex: [val('Texture/Pattern/Enabled', 'false')],
    noscat: [val('PressureScatter', 'false')],
    dens1: [['density="[^"]*"', 'density="1"']],
    texflat: [val('PressureTexture/Strength/', 'false')],
    cut0: [val('Texture/Pattern/CutoffPolicy', '0')],
    mode0: [val('Texture/Pattern/TexturingMode', '0')],
    flatcut0: [val('PressureTexture/Strength/', 'false'), val('Texture/Pattern/CutoffPolicy', '0')],
    noopac: [val('PressureTexture/Strength/', 'false'), val('PressureOpacity', 'false')],
    nosize: [val('PressureTexture/Strength/', 'false'), val('PressureSize', 'false')],
    dab: [['spacing="0.05"', 'spacing="10"'], val('Texture/Pattern/Enabled', 'false'), val('PressureScatter', 'false'), ['density="[^"]*"', 'density="1"']],
    bare: [val('Texture/Pattern/Enabled', 'false'), val('PressureScatter', 'false'), ['density="[^"]*"', 'density="1"']],
};
for (const [name, xmlSub] of Object.entries(V)) {
    const r = { name, file: path.basename(kpp), size: 30, lines: name.startsWith('dab') ? [[100, 100, 1, 400, 100, 1]] : [[40, 100, 0, 440, 100, 1]], rects: [], src: kpp, xmlSub };
    const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ width: 480, height: 200, out: dir.split(path.sep).join('/'), renders: [r] }, null, 1));
}
