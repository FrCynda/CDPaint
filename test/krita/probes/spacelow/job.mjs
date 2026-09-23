import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe: Krita's gap at light pressure when spacing follows pressure.
// Build-up at 2% a dab, so a line's darkness counts the dabs over a pixel:
//   dabs = ln(1 - a) / ln(0.98),  gap = size / dabs.
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs spacelow   then   python measure.py
const root = path.resolve('test/krita/out/spacelow');
export const P = [1, 0.5, 0.2, 0.1, 0.05, 0.02];
const lines = P.map((p, i) => [40, 30 + i * 40, p, 440, 30 + i * 40, p]);
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const common = [val('PressureSize', 'false'), val('PressureOpacity', 'false'), val('PaintOpAction', 1),
    val('OpacityValue', 0.02), val('FlowValue', 1), val('PressureSpacing', 'true'), val('SpacingUseCurve', 'true'),
    ['(name="SpacingSensor"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]]+', '\\g<1><!DOCTYPE params> <params id="pressure"> <curve>0,0;1,1;</curve> </params> '],
    val('SpacingValue', 1)];
const V = {
    s10: [...common, ['spacing="0.15"', 'spacing="0.1"']],
    s50: [...common, ['spacing="0.15"', 'spacing="0.5"']],
};
const dry = process.argv.includes('--dry');
for (const name of Object.keys(V)) {
    const out = path.join(root, name);
    fs.mkdirSync(out, { recursive: true });
    const job = { width: 480, height: 260, out: out.split(path.sep).join('/'),
        renders: [{ name, preset: 'd) Ink-1 Precision', size: 30, lines, xmlSub: V[name], dumpXml: false }] };
    fs.writeFileSync(path.join(out, 'job.json'), JSON.stringify(job, null, 1));
    if (dry) continue;
    renderKrita(path.join(out, 'job.json'));
    console.log(name, fs.readFileSync(path.join(out, 'harness.log'), 'utf8').split('\n').filter(l => /xmlSub|rror/.test(l)).map(l => l.replace(/.*: /, '')).join(' '));
}
