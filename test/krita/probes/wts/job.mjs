import fs from 'fs'; import path from 'path';
// Black-box probe: i) Wet Textured Soft (dulling colour smudge, .gbr tip, texture)
// lays 25% too much ink along the bank's right-to-left line and not along the
// others. The same line both ways decides whether direction is what differs.
//   node job.mjs   then   node ../solo.mjs wts rl lr   then   node ../probe-cdp.mjs wts
const root = path.resolve('test/krita/out/wts');
const kpp = path.join(root, 'flat/paintoppresets/i)_Wet_Textured_Soft.kpp');
const V = { rl: [[440, 60, 1, 40, 60, 0.5]], lr: [[40, 60, 0.5, 440, 60, 1]] };
for (const [name, lines] of Object.entries(V)) {
    const d = path.join(root, name); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ width: 480, height: 120, out: d.split(path.sep).join('/'),
        renders: [{ name, file: path.basename(kpp), size: 30, lines, rects: [], src: kpp.split(path.sep).join('/'),
            tip: path.join(root, 'flat/brushes/bristles_grouped.gbr').split(path.sep).join('/') }] }, null, 1));
}
