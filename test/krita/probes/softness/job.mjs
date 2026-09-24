import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe: X1CG Fineliner (an old-format preset: no flow option,
// PaintOpAction 2) fades at light pressure far more than ours. Which of its
// options does it: softness (curve on, flag off), opacity (flag on, curve
// off), size? Constant-pressure lines at 0.1, 0.3, 0.6, 1.
//   node job.mjs   then   node ../probe-cdp.mjs softness
const root = path.resolve('test/krita/out/softness');
const kpp = path.resolve('test/krita/out/bank-run/portnov-modular/flat/paintoppresets/X1CG_Fineliner.kpp');
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const P = [0.1, 0.3, 0.6, 1];
const V = { base: [], softOff: [val('SoftnessUseCurve', 'false')], opacOff: [val('PressureOpacity', 'false')],
    sizeOff: [val('PressureSize', 'false')], sizeOffSoftOff: [val('PressureSize', 'false'), val('SoftnessUseCurve', 'false')] };
const renders = Object.entries(V).map(([name, xmlSub]) => ({ name, file: path.basename(kpp), size: 7,
    lines: P.map((p, i) => [40, 30 + i * 30, p, 400, 30 + i * 30, p]), rects: [], xmlSub }));
fs.mkdirSync(root, { recursive: true });
const job = { width: 440, height: 150, out: root.split(path.sep).join('/'), renders };
for (const r of renders) {
    const d = path.join(root, r.name); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ ...job, out: d.split(path.sep).join('/'), renders: [{ ...r, src: kpp }] }, null, 1));
}
