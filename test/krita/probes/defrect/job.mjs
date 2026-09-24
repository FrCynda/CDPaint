import fs from 'fs'; import path from 'path';
// Black-box probe: Krita's default (not gauss) rectangle tip with its fades,
// which ~40 bank presets use (Grease Charcoal, Charcoal shader, the muses
// charcoals, pastel smearing...). Ours drew it as a blurred box. One lone dab
// each (a 1.5 px stroke), pen options off, flow and opacity 1.
//   node job.mjs   then   node ../solo.mjs defrect <variants>   then   node ../probe-cdp.mjs defrect
const root = path.resolve('test/krita/out/defrect');
const kpp = path.resolve('test/krita/out/bank-run/portnov-modular/flat/paintoppresets/X1CC_Flat.kpp');
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const tipDef = d => ['(name="brush_definition"[^>]*><!\\[CDATA\\[)[\\s\\S]*?(\\]\\]>)', '\\g<1>' + d + '\\g<2>'];
const tip = (hf, vf, ratio, aa) => '<Brush type="auto_brush" randomness="0" density="1" BrushVersion="2" spacing="0.2" angle="0">' +
    '<MaskGenerator ratio="' + ratio + '" type="rect" vfade="' + vf + '" id="default" spikes="2" antialiasEdges="' + aa + '" hfade="' + hf + '" diameter="60"/></Brush>';
const OFF = ['Size', 'Rotation', 'Ratio', 'Spacing', 'Opacity', 'Flow', 'Mirror', 'Scatter', 'Darken', 'Mix', 'Sharpness', 'Softness', 'h', 's', 'v']
    .map(o => val(o + 'UseCurve', 'false'));
const add = (k, v) => ['(<param [^>]*name="PressureOpacity")', '<param name="' + k + '" type="string"><![CDATA[' + v + ']]></param>\n \\g<1>'];
const V = { f1: [1, 1, 1, 1], f9: [0.9, 0.9, 1, 1], f5: [0.5, 0.5, 1, 1], f2: [0.2, 0.2, 1, 1], f0: [0, 0, 1, 1],
    h1v3: [1, 0.31, 1, 1], h3v1: [0.31, 1, 1, 1], h5v2: [0.5, 0.2, 1, 1], f5q: [0.5, 0.5, 0.5, 1], f5n: [0.5, 0.5, 1, 0],
    gc: [1, 0.31, 0.15, 1] };
const renders = Object.entries(V).map(([name, [hf, vf, r, aa]]) => ({ name, file: path.basename(kpp), size: 60,
    lines: [[120, 60, 1, 121.5, 60, 1]], rects: [], xmlSub: [tipDef(tip(hf, vf, r, aa)), ...OFF, add('FlowUseCurve', 'false')] }));
for (const r of renders) {
    const d = path.join(root, r.name); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ width: 240, height: 120, out: d.split(path.sep).join('/'), renders: [{ ...r, src: kpp }] }, null, 1));
}
console.log(renders.map(r => r.name).join(' '));
