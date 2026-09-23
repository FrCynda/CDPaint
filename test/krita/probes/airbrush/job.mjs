import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe: does Krita's airbrush option add dabs to a scripted
// (instant) stroke? Ink-1 in build-up at 5% a dab, bank lines, air on/off.
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs airbrush   then   python measure.py
const root = path.resolve('test/krita/out/airbrush');
const lines = [[40, 50, 0.1, 440, 50, 1.0], [60, 185, 0.8, 200, 115, 0.8], [300, 115, 0.5, 300, 185, 0.5],
    [440, 250, 1.0, 40, 250, 0.5]];
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const p = (k, v) => '<param type="string" name="' + k + '"><![CDATA[' + v + ']]></param>';
const common = [val('PressureSize', 'false'), val('PressureOpacity', 'false'), val('PaintOpAction', 1),
    val('OpacityValue', 0.05), val('FlowValue', 1)];
const air = (on, rate) => ['</Preset>', p('AirbrushOption/isAirbrushing', on) + p('AirbrushOption/rate', rate) +
    p('AirbrushOption/ignoreSpacing', 'false') + '</Preset>'];
const V = { off: [...common, air('false', 100)], on100: [...common, air('true', 100)], on10: [...common, air('true', 10)] };
const dry = process.argv.includes('--dry');
for (const name of Object.keys(V)) {
    const out = path.join(root, name);
    fs.mkdirSync(out, { recursive: true });
    const job = { width: 480, height: 300, out: out.split(path.sep).join('/'),
        renders: [{ name, preset: 'd) Ink-1 Precision', size: 30, lines, xmlSub: V[name], dumpXml: false }] };
    fs.writeFileSync(path.join(out, 'job.json'), JSON.stringify(job, null, 1));
    if (dry) continue;
    renderKrita(path.join(out, 'job.json'));
}
