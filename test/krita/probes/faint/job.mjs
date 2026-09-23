import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe: how Krita accumulates very faint build-up dabs on an 8-bit
// layer. Ink-1, hard-ish 20px tip, spacing 0.1 (so ~10 dabs over a pixel),
// build-up at a constant per-dab opacity; lines at several opacities are in
// separate variants because opacity is per preset.
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs faint   then   python measure.py
const root = path.resolve('test/krita/out/faint');
const lines = [[20, 40, 1, 400, 40, 1]];
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const V = {};
for (const o of [0.001, 0.002, 0.004, 0.006, 0.01, 0.02, 0.05]) {
    V['o' + String(o).slice(2).padEnd(3, '0')] = [val('PressureSize', 'false'), val('PaintOpAction', 1),
        val('OpacityValue', o), val('OpacityUseCurve', 'false'), val('FlowValue', 1), ['spacing="0.15"', 'spacing="0.1"']];
}
const dry = process.argv.includes('--dry');
for (const name of Object.keys(V)) {
    const out = path.join(root, name);
    fs.mkdirSync(out, { recursive: true });
    const job = { width: 420, height: 80, out: out.split(path.sep).join('/'),
        renders: [{ name, preset: 'd) Ink-1 Precision', size: 20, lines, xmlSub: V[name], dumpXml: false }] };
    fs.writeFileSync(path.join(out, 'job.json'), JSON.stringify(job, null, 1));
    if (dry) continue;
    renderKrita(path.join(out, 'job.json'));
}
