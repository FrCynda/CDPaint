import fs from 'fs'; import path from 'path';
// Black-box probe: which tip pixels become a hairy brush's bristles? 鬃毛-4p
// (a 4px soft auto tip, bristle scale 10) with bristle density 100 and one
// near-zero step, so each bristle is a lone spot 10px from the next, as
// strong as its tip pixel. Variants change the tip's diameter and fade.
//   node job.mjs   then   node ../solo.mjs hairtip <variants>   then   node ../probe-cdp.mjs hairtip
const root = path.resolve('test/krita/out/hairtip');
const kpp = path.resolve('test/krita/out/bank/holdout/condexpr01_krita-config/unpacked/paintoppresets/鬃毛-4p.kpp');
const val = (k, v) => [String.raw`(name="` + k + String.raw`"[^>]*>(?:<!\[CDATA\[)?)[^\]<]+`, String.raw`\g<1>` + v];
const tip = (d, f) => [['diameter="[^"]*"', 'diameter="' + d + '"'], ['hfade="[^"]*"', 'hfade="' + f + '"'], ['vfade="[^"]*"', 'vfade="' + f + '"']];
const V = { d4: [4, 0.5], d4h: [4, 1], d5: [5, 0.5], d6: [6, 0.5], d3: [3, 0.5], d75: [7.5, 0.5] };
for (const [name, [d, f]] of Object.entries(V)) {
    const r = { name, file: path.basename(kpp), size: d, lines: [[200, 100, 1, 200.25, 100, 1]], rects: [], src: kpp,
        xmlSub: [val('HairyBristle/density', 100), ...tip(d, f)] };
    const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ width: 400, height: 200, out: dir.split(path.sep).join('/'), renders: [r] }, null, 1));
}
