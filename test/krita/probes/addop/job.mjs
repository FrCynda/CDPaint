import fs from 'fs'; import path from 'path';
// Black-box probe: does a stroke in a blend mode other than normal build up
// dab on dab, or cap at its opacity the way a normal (alpha darken) stroke
// does? X1BB Addition Soft (add, opacity 5%) came out at 0.68x Krita's ink.
// Pen options off; one stroke and one lone dab (a 1.5 px stroke) per mode.
//   node job.mjs   then   node ../solo.mjs addop <variants>   then   node ../probe-cdp.mjs addop
const root = path.resolve('test/krita/out/addop');
const kpp = path.resolve('test/krita/out/bank-run/portnov-modular/flat/paintoppresets/X1BB_AdditionSoft.kpp');
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const OFF = ['Size', 'Opacity', 'Spacing'].map(o => val(o + 'UseCurve', 'false'));
const add = (k, v) => ['(<param [^>]*name="PressureOpacity")', '<param name="' + k + '" type="string"><![CDATA[' + v + ']]></param>\n \\g<1>'];
const V = { add: ['add', 0.05], normal: ['normal', 0.05], add30: ['add', 0.3], normal30: ['normal', 0.3], mult30: ['multiply', 0.3],
    addDab: ['add', 0.3, 1], normalDab: ['normal', 0.3, 1] };
// The preset as it is, pens on, at fixed pressures (the bank's middle band is 0.8 and 0.5).
Object.assign(V, { p5: ['add', null, 0, 0.5], p8: ['add', null, 0, 0.8], p5n: ['normal', null, 0, 0.5], p1: ['add', null, 0, 1],
    d5: ['add', null, 1, 0.5], d8: ['add', null, 1, 0.8], d1: ['add', null, 1, 1] });
const renders = Object.entries(V).map(([name, [op, o, dab, pr]]) => ({ name, file: path.basename(kpp), size: 50,
    lines: dab ? [[200, 60, pr ?? 1, 201.5, 60, pr ?? 1]] : [[40, 60, pr ?? 1, 360, 60, pr ?? 1]], rects: [],
    xmlSub: o == null ? [val('CompositeOp', op)] : [...OFF, val('CompositeOp', op), val('OpacityValue', o), add('FlowUseCurve', 'false')] }));
for (const r of renders) {
    const d = path.join(root, r.name); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ width: 400, height: 120, out: d.split(path.sep).join('/'), renders: [{ ...r, src: kpp }] }, null, 1));
}
