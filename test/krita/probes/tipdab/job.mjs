import fs from 'fs'; import path from 'path';
// Black-box probe: how Krita shrinks a picture tip. One lone dab (a 1.5 px
// stroke; Krita paints nothing shorter) of a preset's own tip at three sizes,
// texture, masking brush and pen options off.
//   KPP=<preset.kpp> TIP=<tip file> [OUT=name] [TEX=1: keep its texture] node job.mjs
//   then   node ../solo.mjs <OUT> s20 s40 s80   and   node ../probe-cdp.mjs <OUT>
const out = process.env.OUT || 'tipdab';
const root = path.resolve('test/krita/out', out);
const kpp = path.resolve(process.env.KPP), tip = path.resolve(process.env.TIP);
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const OFF = ['Size', 'Rotation', 'Ratio', 'Spacing', 'Opacity', 'Flow', 'Mirror', 'Scatter', 'Darken', 'Mix', 'Sharpness', 'Softness', 'h', 's', 'v']
    .map(o => val(o + 'UseCurve', 'false'));
const xmlSub = [...OFF, ...(process.env.TEX ? [] : [val('Texture/Pattern/Enabled', 'false')]), val('MaskingBrush/Enabled', 'false'), val('FlowValue', 1), val('OpacityValue', 1)];
for (const sz of [20, 40, 80]) {
    const name = 's' + sz, d = path.join(root, name); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ width: 200, height: 200, out: d.split(path.sep).join('/'),
        renders: [{ name, file: path.basename(kpp), src: kpp, size: sz, lines: [[100, 100, 1, 101.5, 100, 1]], rects: [], xmlSub,
            tip: tip.split(path.sep).join('/') }] }, null, 1));
}
