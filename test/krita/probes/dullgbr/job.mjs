import fs from 'fs'; import path from 'path';
// Black-box probe: X2DA Soft Mix builds its ink up along a stroke far sooner
// in Krita than here. It dulls (SmudgeRateMode 1) through a .gbr tip used as
// a picture, not a mask (ColorAsMask 0) -- neither of which the smudge
// probes so far measured together. Pen options off; one stroke at pressure 1.
//   node job.mjs   then   node ../solo.mjs dullgbr <variants>   then   node ../probe-cdp.mjs dullgbr
const root = path.resolve('test/krita/out/dullgbr');
const kpp = path.resolve('test/krita/out/bank-run/portnov-modular/flat/paintoppresets/X2DA_SoftMix.kpp');
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const attr = (k, v) => ['(<Brush[^>]*?\\b' + k + '=")[^"]*', '\\g<1>' + v];
const OFF = ['Size', 'Rotation', 'Spacing', 'Opacity', 'Scatter', 'Mirror', 'Gradient', 'SmudgeRate', 'ColorRate', 'Texture/Strength/']
    .map(o => val(o + 'UseCurve', 'false'));
const set = o => [...OFF, val('SmudgeRateMode', o.mode ?? 1), attr('ColorAsMask', o.mask ?? 0),
    val('SmudgeRateValue', o.s ?? 1), val('ColorRateValue', o.c ?? 0.65)];
const V = { base: {}, mask1: { mask: 1 }, mode0: { mode: 0 }, mode0mask1: { mode: 0, mask: 1 }, s05: { s: 0.5 }, s05mask1: { s: 0.5, mask: 1 },
    dab: { mode: 0, c: 1, s: 0, dab: 1 }, dabsp: { mode: 0, c: 1, s: 0, sp: 1 } };   // plain paint: one dab (1.5 px stroke), and the spacing
const renders = Object.entries(V).map(([name, o]) => ({ name, file: path.basename(kpp), size: 40,
    lines: o.dab ? [[240, 60, 1, 241.5, 60, 1]] : [[40, 60, 1, 440, 60, 1]], rects: [], xmlSub: set(o),
    tip: path.resolve('test/krita/out/bank-run/portnov-modular/flat/brushes/Brush212141.gbr').split(path.sep).join('/') }));
for (const r of renders) {
    const d = path.join(root, r.name); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ width: 480, height: 120, out: d.split(path.sep).join('/'), renders: [{ ...r, src: kpp }] }, null, 1));
}
