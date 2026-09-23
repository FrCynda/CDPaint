import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Which edit stopped Basic_mix painting in job.mjs's first run.
const root = path.resolve('test/krita/out/smudge-bisect');
const kpp = path.resolve('test/krita/out/bank-run/krita3/flat/paintoppresets/Basic_mix.kpp');
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const lines = [[40, 60, 1, 440, 60, 1]];
const V = {
    asis: [],
    offop: [val('PressureOpacity', 'false')],
    offcr: [val('PressureColorRate', 'false')],
    offsr: [val('PressureSmudgeRate', 'false')],
    offsz: [val('PressureSize', 'false'), val('PressureSpacing', 'false')],
    values: [val('ColorRateValue', 1), val('SmudgeRateValue', 1)],
    mode: [val('SmudgeRateMode', 0)],
};
fs.mkdirSync(root, { recursive: true });
const order = process.argv.includes('--rev') ? Object.entries(V).reverse() : Object.entries(V);
const renders = order.map(([name, xmlSub]) => ({ name, file: path.basename(kpp), size: 30, lines, xmlSub }));
const job = { width: 480, height: 120, out: root.split(path.sep).join('/'), renders };
fs.writeFileSync(path.join(root, 'job.json'), JSON.stringify(job, null, 1));
const res = path.join(root, 'kres');
fs.rmSync(res, { recursive: true, force: true }); fs.mkdirSync(path.join(res, 'paintoppresets'), { recursive: true });
fs.copyFileSync(kpp, path.join(res, 'paintoppresets', path.basename(kpp)));
renderKrita(path.join(root, 'job.json'), { resourceDir: res });
