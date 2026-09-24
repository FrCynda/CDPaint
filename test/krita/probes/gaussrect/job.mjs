import fs from 'fs'; import path from 'path';
// Black-box probe: Krita's soft (gauss) rectangle tip -- X1CC Flat's, and the
// shape EO Pixel Taper's "rct" left unresolved. One lone dab each (a 1.5 px
// stroke; Krita paints nothing shorter), pen options off, flow and opacity 1,
// beside the gauss circle we already match.
//   node job.mjs   then   node ../solo.mjs gaussrect <variants>   then   node ../probe-cdp.mjs gaussrect
const root = path.resolve('test/krita/out/gaussrect');
const kpp = path.resolve('test/krita/out/bank-run/portnov-modular/flat/paintoppresets/X1CC_Flat.kpp');
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const tipDef = d => ['(name="brush_definition"[^>]*><!\\[CDATA\\[)[\\s\\S]*?(\\]\\]>)', '\\g<1>' + d + '\\g<2>'];
const tip = (type, fade, ratio, hv) => '<Brush type="auto_brush" randomness="0" density="1" BrushVersion="2" spacing="0.2" angle="0">' +
    '<MaskGenerator ratio="' + ratio + '" type="' + type + '" vfade="' + (hv ?? fade) + '" id="gauss" spikes="2" antialiasEdges="1" hfade="' + fade + '" diameter="60"/></Brush>';
const OFF = ['Size', 'Rotation', 'Ratio', 'Spacing', 'Opacity', 'Flow', 'Mirror', 'Scatter', 'Darken', 'Mix', 'Sharpness', 'Softness', 'h', 's', 'v']
    .map(o => val(o + 'UseCurve', 'false'));
const add = (k, v) => ['(<param [^>]*name="PressureOpacity")', '<param name="' + k + '" type="string"><![CDATA[' + v + ']]></param>\n \\g<1>'];
const V = { c9: ['circle', 0.9, 1], r9: ['rect', 0.9, 1], r5: ['rect', 0.5, 1], r2: ['rect', 0.2, 1], r1: ['rect', 1, 1],
    r9h5: ['rect', 0.9, 1, 0.5], c5: ['circle', 0.5, 1], r9q: ['rect', 0.9, 0.5] };
const renders = Object.entries(V).map(([name, [t, f, r, hv]]) => ({ name, file: path.basename(kpp), size: 60,
    lines: [[120, 60, 1, 121.5, 60, 1]], rects: [], xmlSub: [tipDef(tip(t, f, r, hv)), ...OFF, add('FlowUseCurve', 'false')] }));
for (const r of renders) {
    const d = path.join(root, r.name); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ width: 240, height: 120, out: d.split(path.sep).join('/'), renders: [{ ...r, src: kpp }] }, null, 1));
}
