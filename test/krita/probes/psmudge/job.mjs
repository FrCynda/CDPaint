import fs from 'fs'; import path from 'path';
// Black-box probe: portnov-MostUsed paint_smudge_blurry, a colour smudge
// brush on a pressure-picked .gih, lays 0.44x Krita's ink in blotches where
// Krita's stroke is smooth. Lone dabs (spacing 5, auto spacing off) and lines.
//   node job.mjs   then   node ../solo.mjs psmudge <variants>
const root = path.resolve('test/krita/out/psmudge');
const kpp = path.resolve('test/krita/out/bank-run/portnov-MostUsed/flat/paintoppresets/paint_smudge_blurry.kpp');
const lone = ['useAutoSpacing="1" autoSpacingCoeff="0.5" ColorAsMask="0" BrushVersion="2" filename="w_natural_brush-pressure-3b.gih" spacing="0.1"',
    'useAutoSpacing="0" autoSpacingCoeff="0.5" ColorAsMask="0" BrushVersion="2" filename="w_natural_brush-pressure-3b.gih" spacing="5"'];
const V = {
    line1: [],
    ramp: [],
    dab1: [lone],
    dab5: [lone],
};
for (const [name, xmlSub] of Object.entries(V)) {
    const p = name === 'dab5' ? 0.5 : 1;
    const lines = name === 'ramp' ? [[40, 100, 0.1, 440, 100, 1]] : [[40, 100, p, 440, 100, p]];
    const r = { name, file: path.basename(kpp), maxSize: 30, lines, rects: [], src: kpp, xmlSub };
    const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ width: 480, height: 200, out: dir.split(path.sep).join('/'), renders: [r] }, null, 1));
}
