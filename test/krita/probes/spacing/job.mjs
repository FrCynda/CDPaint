import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// node job.mjs  -> one fresh Krita per variant; prints the dab gaps per pressure
const root = path.resolve('test/krita/out/spacing');
const P = [1, 0.75, 0.5, 0.25, 0.1];
const lines = P.map((p, i) => [40, 30 + i * 50, p, 440, 30 + i * 50, p]);
const set = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)(true|false)', '\\g<1>' + v];
const base = [set('PressureSize', 'false'), ['spacing="0.15"', 'spacing="SP"']];
const variants = {
  off5: { sp: 5, subs: [set('PressureSpacing', 'false')] },
  on5: { sp: 5, subs: [set('PressureSpacing', 'true'), set('SpacingUseCurve', 'true'), ['(?s)(name="SpacingSensor".*?<curve>)[^<]*', '\\g<1>0,0;1,1;']] },
  on5nocurve: { sp: 5, subs: [set('PressureSpacing', 'true'), set('SpacingUseCurve', 'false')] },
  on5s24: { sp: 5, size: 24, subs: [set('PressureSpacing', 'true'), set('SpacingUseCurve', 'false')] },
  on2: { sp: 2, subs: [set('PressureSpacing', 'true'), set('SpacingUseCurve', 'false')] },
  on2s40: { sp: 2, size: 40, subs: [set('PressureSpacing', 'true'), set('SpacingUseCurve', 'false')] },
  on5v05: { sp: 5, subs: [set('PressureSpacing', 'true'), set('SpacingUseCurve', 'false'), ['(name="SpacingValue"[^>]*>(?:<!\\[CDATA\\[)?)[0-9.]+', '\\g<1>0.5']] },
  off5s24: { sp: 5, size: 24, subs: [set('PressureSpacing', 'false')] },
  on20: { sp: 20, subs: [set('PressureSpacing', 'true'), set('SpacingUseCurve', 'false')] },
  on5flat: { sp: 5, subs: [set('PressureSpacing', 'true'), set('SpacingUseCurve', 'true'), ['(?s)(name="SpacingSensor".*?<curve>)[^<]*', '\\g<1>0,0.5;1,0.5;']] },
};
const only = process.argv[2] ? process.argv[2].split(',') : Object.keys(variants);
for (const name of only) {
  const v = variants[name], out = path.join(root, name);
  fs.mkdirSync(out, { recursive: true });
  const xmlSub = [...base.map(([a, b]) => [a, b.replace('SP', String(v.sp))]), ...v.subs];
  const job = { width: 480, height: 260, out: out.split(path.sep).join('/'),
    renders: [{ name, preset: 'd) Ink-1 Precision', size: v.size || 12, lines, xmlSub }] };
  fs.writeFileSync(path.join(out, 'job.json'), JSON.stringify(job, null, 1));
  renderKrita(path.join(out, 'job.json'));
  console.log(name, fs.readFileSync(path.join(out, 'harness.log'), 'utf8').split('\n').filter(l => /xmlSub/.test(l)).map(l => l.replace(/.*: /, '')).join(' '));
}
