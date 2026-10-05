import fs from 'fs'; import path from 'path';
// Black-box probe: Waterpaint Hard Edges is lighter inside in Krita than here.
// nomask switches its subtract masking brush off, to tell the stroke from the mask.
// The preset and its two tips are staged in out/whe-src from Krita_4_Default_Resources.bundle.
//   node job.mjs   then   node ../solo.mjs whe <variants>   then   node ../probe-cdp.mjs whe
const root = path.resolve('test/krita/out/whe');
const kpp = path.resolve('test/krita/out/whe-src/paintoppresets/j)_Waterpaint_Hard_Edges.kpp');
const tip = path.resolve('test/krita/out/whe-src/brushes/circle_hard_eroded.gih');
const val = (k, v) => [String.raw`(name="` + k + String.raw`"[^>]*>(?:<!\[CDATA\[)?)[^\]<]+`, String.raw`\g<1>` + v];
const V = {
    nomask: [val('MaskingBrush/Enabled', 'false')],
    p1: [val('MaskingBrush/Enabled', 'false')],
    base: [],
    mscat0: [val('MaskingBrush/Preset/PressureScatter', 'false')],
    mrot0: [val('MaskingBrush/Preset/PressureRotation', 'false')],
    mbare: [val('MaskingBrush/Preset/PressureScatter', 'false'), val('MaskingBrush/Preset/PressureRotation', 'false')],
    mflow: [val('MaskingBrush/Preset/PressureScatter', 'false'), val('MaskingBrush/Preset/PressureRotation', 'false'), val('MaskingBrush/Preset/FlowUseCurve', 'false')],
    msize: [val('MaskingBrush/Preset/PressureScatter', 'false'), val('MaskingBrush/Preset/PressureRotation', 'false'), val('MaskingBrush/Preset/PressureSize', 'false')],
    mdab1: [val('MaskingBrush/Preset/PressureScatter', 'false'), val('MaskingBrush/Preset/PressureRotation', 'false'), ['spacing="0.25"', 'spacing="3"']],
    mbare1: [val('MaskingBrush/Preset/PressureScatter', 'false'), val('MaskingBrush/Preset/PressureRotation', 'false')],
};
for (const [name, xmlSub] of Object.entries(V)) {
    const lines = /1$/.test(name) ? [[40, 100, 1, 440, 100, 1]] : [[40, 100, 0, 440, 100, 1]];
    const r = { name, file: path.basename(kpp), size: 30, lines, rects: [], src: kpp, tip, xmlSub };
    const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ width: 480, height: 200, out: dir.split(path.sep).join('/'), renders: [r] }, null, 1));
}
