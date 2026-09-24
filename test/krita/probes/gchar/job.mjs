import fs from 'fs'; import path from 'path';
// Black-box probe: Grease Charcoal (flat rect tip, texture in subtract mode at
// scale 0.19, fuzzy scatter) lays 2.4x Krita's ink: Krita's stroke is grainy
// where ours fills in. Fixed pressure, the preset as it is and with its parts
// switched off one at a time.
//   node job.mjs   then   node ../solo.mjs gchar <variants>   then   node ../probe-cdp.mjs gchar
const root = path.resolve('test/krita/out/gchar');
const kpp = path.resolve('test/krita/out/bank-run/portnov-pencils/flat/paintoppresets/Grease Charcoalm17906.kpp');
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const lines = pr => [[40, 50, pr, 440, 50, pr], [60, 250, pr, 200, 180, pr], [300, 110, pr, 300, 230, pr],
    [400, 150, pr, 401.5, 150, pr]];
const V = { as: [], notex: [val('Texture/Pattern/Enabled', 'false')], sc1: [val('Texture/Pattern/Scale', '1')],
    noscat: [val('PressureScatter', 'false')], s05: [val('Texture/Strength/Value', '0.5')],
    m0: [val('Texture/Pattern/TexturingMode', '0')],
    plain: [val('Texture/Pattern/Enabled', 'false'), val('PressureScatter', 'false')],
    // flow 0.05, untextured: how many dabs cover a pixel (1 - (1 - 0.05a)^N)
    lowflow: [val('Texture/Pattern/Enabled', 'false'), val('FlowValue', '0.05')] };
const renders = [];
for (const [name, subs] of Object.entries(V)) for (const pr of [1, 0.5])
    renders.push({ name: name + (pr === 1 ? '' : '5'), file: path.basename(kpp), size: 30, lines: lines(pr), rects: [], xmlSub: subs });
for (const r of renders) {
    const d = path.join(root, r.name); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ width: 480, height: 300, out: d.split(path.sep).join('/'), renders: [{ src: kpp, ...r }] }, null, 1));
}
console.log(renders.map(r => r.name).join(' '));
