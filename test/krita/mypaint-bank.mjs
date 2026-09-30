// CDPaint against real MyPaint brushes, painted by libmypaint itself (the copy
// Krita ships, see mypaint-render.py), over every .myb in test/krita/out/bank/mypaint (a clone
// of mypaint/mypaint-brushes).
//
//   node test/krita/mypaint-bank.mjs [--render] [--only name,name]
//
// Same strokes, sizes and grading as bank.mjs. A brush libmypaint paints
// differently twice is marked random but still scored: a fresh brush draws
// the same random numbers in both programs. CDPaint imports each .myb the way a
// user does (importFiles), so this tests the reader and the engine together.
import { withPage, REPO_ROOT } from '../browser.mjs';
import { spawnSync } from 'child_process';
import { measureCase } from './measure.mjs';
import fs from 'fs';
import path from 'path';

const OUT = path.join(REPO_ROOT, 'test', 'krita', 'out');
const SRC = path.join(OUT, 'bank', 'mypaint', 'brushes');
const RUN = path.join(OUT, 'mypaint-run');
const W = 480, H = 300, MAX_SIZE = 30, MS_PER_PX = 2;   // a pen at 500 px/s, a sample a pixel
const LINES = [[40, 50, 0.1, 440, 50, 1.0], [60, 185, 0.8, 200, 115, 0.8], [300, 115, 0.5, 300, 185, 0.5],
    [440, 250, 1.0, 40, 250, 0.5]];
const BANDS = [[0, 100], [100, 200], [200, 300]];
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : null;

if (!fs.existsSync(SRC)) { console.log('no brushes: git clone https://github.com/mypaint/mypaint-brushes test/krita/out/bank/mypaint'); process.exit(1); }
// folder_name.myb: three names (pen, brush, 2B_pencil) are used in more than one folder
const brushes = fs.readdirSync(SRC, { withFileTypes: true }).filter(d => d.isDirectory())
    .flatMap(d => fs.readdirSync(path.join(SRC, d.name)).filter(f => f.endsWith('.myb'))
        .map(f => ({ dir: path.join(SRC, d.name), stem: f.slice(0, -4), name: d.name + '_' + f.slice(0, -4) })))
    .filter(b => !only || only.includes(b.name));
brushes.forEach(b => { b.key = b.name; });   // stable across --only
const refDir = path.join(RUN, 'ref');
fs.mkdirSync(RUN, { recursive: true });

if (argv.includes('--render')) {
    const job = { width: W, height: H, out: refDir, msPerPx: MS_PER_PX, renders: brushes.flatMap(b =>
        ['a', 'b'].map(s => ({ name: b.key + s, file: path.join(b.dir, b.stem + '.myb'), maxSize: MAX_SIZE, lines: LINES, warm: s === 'b' }))) };
    const run = (job) => {
        fs.writeFileSync(path.join(RUN, 'job.json'), JSON.stringify(job));
        const r = spawnSync('python', [path.join(REPO_ROOT, 'test', 'krita', 'mypaint-render.py'), path.join(RUN, 'job.json')], { encoding: 'utf8' });
        if (r.status) { console.log(r.stderr); process.exit(1); }
    };
    run(job);
    // a blender, an eraser or clean water leaves an empty surface as it was: paint those over stripes
    const m = JSON.parse(fs.readFileSync(path.join(refDir, 'meta.json'), 'utf8'));
    run({ ...job, renders: job.renders.filter(r => m[r.name.slice(0, -1) + 'a'] && !m[r.name.slice(0, -1) + 'a'].ink).map(r => ({ ...r, under: true })) });
}
const meta = fs.existsSync(path.join(refDir, 'meta.json')) ? JSON.parse(fs.readFileSync(path.join(refDir, 'meta.json'), 'utf8')) : {};

const results = [];
await withPage(async (page) => {
    for (const b of brushes) {
        const row = { name: b.name };
        results.push(row);
        if (!meta[b.key + 'a']) { row.status = 'libmypaint could not load it'; continue; }
        if (meta[b.key + 'a'].ink === false) { row.status = 'libmypaint painted nothing'; continue; }
        const A = fs.readFileSync(path.join(refDir, b.key + 'a.png')).toString('base64');
        const B = fs.readFileSync(path.join(refDir, b.key + 'b.png')).toString('base64');
        if (A !== B) {
            const d = await page.eval(`(async () => {
                const px = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode();
                    const c = new OffscreenCanvas(${W}, ${H}), x = c.getContext('2d'); x.drawImage(i, 0, 0);
                    return x.getImageData(0, 0, ${W}, ${H}).data; };
                const a = await px(${JSON.stringify(A)}), b = await px(${JSON.stringify(B)});
                let n = 0; for (let i = 3; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 2) n++;
                return n;
            })()`, { awaitPromise: true });
            row.random = d > 0;   // scored all the same: the engine draws libmypaint's own random numbers
        }
        row.size = meta[b.key + 'a'].size;
        const text = fs.readFileSync(path.join(b.dir, b.stem + '.myb'), 'utf8');
        const importExpr = `await (async () => {
            const br = PaintApp.brush, before = new Set(br.userPresetNames());
            const r = await br.importFiles([new File([${JSON.stringify(text)}], ${JSON.stringify(b.name + '.myb')})]);
            return { ok: r.brushes > 0, added: br.userPresetNames().filter(n => !before.has(n)), error: JSON.stringify(r) };
        })()`;
        const r = await measureCase(page, { preset: b.name, size: row.size, lines: LINES, bands: BANDS },
            { importExpr, refB64: A, W, H, msPerPx: MS_PER_PX, kritaStart: false, under: meta[b.key + 'a'].under, keepErase: true });
        if (r.error) { row.status = 'CDPaint could not import it'; row.why = r.error; continue; }
        if (!r.krita.ink) { row.status = 'libmypaint painted nothing'; continue; }
        fs.writeFileSync(path.join(RUN, b.key + '.png'), Buffer.from(r.png, 'base64'));
        Object.assign(row, { status: 'scored', key: b.key, inkRatio: r.inkRatio, bandInk: r.bandInk, iou: r.iou });
        row.under = meta[b.key + 'a'].under;
        console.log(`  ${b.name.padEnd(40).slice(0, 40)} ink ${String(r.inkRatio).padEnd(6)} IoU ${r.iou}${row.random ? ' (random)' : ''}${row.under ? ' (over stripes)' : ''}`);
    }
});
fs.writeFileSync(path.join(RUN, 'results.json'), JSON.stringify(results, null, 1));
const grade = r => r.iou >= 0.9 && r.inkRatio >= 0.9 && r.inkRatio <= 1.1 ? 'close'
    : r.iou >= 0.75 && r.inkRatio >= 0.8 && r.inkRatio <= 1.25 ? 'near' : 'off';
const tally = {};
for (const r of results) { const k = r.status === 'scored' ? grade(r) + (r.random ? ' random' : '') : r.status; tally[k] = (tally[k] || 0) + 1; }
console.log('\n', tally);
