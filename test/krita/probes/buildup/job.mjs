import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe: how Krita's build-up / wash modes combine opacity, flow and
// a pressure-driven opacity. One fresh Krita per variant.
//   node job.mjs [a,b,...]   then   python measure.py
const root = path.resolve('test/krita/out/buildup');
const P = [1, 0.75, 0.5, 0.25];
// a long line per pressure, and a lone dab per pressure at the right
const lines = [...P.map((p, i) => [40, 30 + i * 50, p, 360, 30 + i * 50, p]),
    ...P.map((p, i) => [430, 30 + i * 50, p, 431, 30 + i * 50, p])];
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const sensor = '<param type="string" name="OpacitySensor"><![CDATA[<!DOCTYPE params> <params id="pressure"> <curve>0,0;1,1;</curve> </params> ]]></param></Preset>';
const pressureOpacity = [val('OpacityUseCurve', 'true'), ['</Preset>', sensor]];
const base = [['(name="PressureSize"[^>]*>(?:<!\\[CDATA\\[)?)true', '\\g<1>false']];
const V = {
  b_o100_f100: [val('PaintOpAction', 1), val('OpacityValue', 1), val('FlowValue', 1)],
  b_o50_f100: [val('PaintOpAction', 1), val('OpacityValue', 0.5), val('FlowValue', 1)],
  b_o100_f50: [val('PaintOpAction', 1), val('OpacityValue', 1), val('FlowValue', 0.5)],
  b_o50_f50: [val('PaintOpAction', 1), val('OpacityValue', 0.5), val('FlowValue', 0.5)],
  b_press: [val('PaintOpAction', 1), val('OpacityValue', 1), val('FlowValue', 1), ...pressureOpacity],
  b_press_f20: [val('PaintOpAction', 1), val('OpacityValue', 1), val('FlowValue', 0.2), ...pressureOpacity],
  w_o50_f50: [val('PaintOpAction', 2), val('OpacityValue', 0.5), val('FlowValue', 0.5)],
  w_press_f20: [val('PaintOpAction', 2), val('OpacityValue', 1), val('FlowValue', 0.2), ...pressureOpacity],
};
const only = process.argv[2] ? process.argv[2].split(',') : Object.keys(V);
for (const name of only) {
  const out = path.join(root, name);
  fs.mkdirSync(out, { recursive: true });
  const job = { width: 480, height: 220, out: out.split(path.sep).join('/'),
    renders: [{ name, preset: 'd) Ink-1 Precision', size: 12, lines, xmlSub: [...base, ...V[name]], dumpXml: false }] };
  fs.writeFileSync(path.join(out, 'job.json'), JSON.stringify(job, null, 1));
  renderKrita(path.join(out, 'job.json'));
  console.log(name, fs.readFileSync(path.join(out, 'harness.log'), 'utf8').split('\n').filter(l => /xmlSub/.test(l)).map(l => l.replace(/.*: /, '')).join(' '));
}
