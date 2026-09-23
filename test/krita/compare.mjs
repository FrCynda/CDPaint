// CDPaint against real Krita pixels.
//
//   node test/krita/compare.mjs            compare against the stored references
//   node test/krita/compare.mjs --render   re-render the references with Krita first
//   node test/krita/compare.mjs --only basic-5-size,pencil-2
//   node test/krita/compare.mjs --check    exit 1 if a case with `expect` drifts
//
// References live in test/fixtures/brushes/krita-ref/ (PNG per case plus
// meta.json: the preset and the size Krita painted at). The presets are read
// from Krita's own installed bundle through CDPaint's real import path, so a
// case measures import + engine together, the way a user meets them.
// Side-by-sides (CDPaint | Krita | difference) go to test/krita/out/.
import { withPage, REPO_ROOT } from '../browser.mjs';
import { renderKrita } from './render.mjs';
import { measureCase } from './measure.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HERE = path.join(REPO_ROOT, 'test', 'krita');
const REF = path.join(REPO_ROOT, 'test', 'fixtures', 'brushes', 'krita-ref');
const OUT = path.join(HERE, 'out');
const corpus = JSON.parse(fs.readFileSync(path.join(HERE, 'corpus.json'), 'utf8'));
const KRITA_SHARE = process.env.KRITA_SHARE || 'C:/Program Files/Krita (x64)/share/krita';
const argv = process.argv.slice(2);
const onlyArg = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : null;
const cases = corpus.cases.filter(c => !onlyArg || onlyArg.includes(c.name));

if (argv.includes('--render')) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-krita-'));
    const job = { width: corpus.width, height: corpus.height, out: tmp.replace(/\\/g, '/'),
        renders: cases.map(c => ({ name: c.name, preset: c.preset, size: c.size, lines: c.lines, xmlSub: c.xmlSub })) };
    job.renders.forEach(r => { if (r.size === undefined) delete r.size; if (!r.xmlSub) delete r.xmlSub; });
    const jf = path.join(tmp, 'job.json');
    fs.writeFileSync(jf, JSON.stringify(job));
    console.log(renderKrita(jf).trim());
    fs.mkdirSync(REF, { recursive: true });
    const metaFile = path.join(REF, 'meta.json');
    const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
    Object.assign(meta, JSON.parse(fs.readFileSync(path.join(tmp, 'meta.json'), 'utf8')));
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 1) + '\n');
    for (const c of cases) fs.copyFileSync(path.join(tmp, c.name + '.png'), path.join(REF, c.name + '.png'));
    fs.rmSync(tmp, { recursive: true, force: true });
}

const meta = JSON.parse(fs.readFileSync(path.join(REF, 'meta.json'), 'utf8'));
const bundle = fs.readFileSync(path.join(KRITA_SHARE, 'bundles', corpus.bundle)).toString('base64');
fs.mkdirSync(OUT, { recursive: true });

const results = await withPage(async (page) => {
    await page.run(`
        const bin = atob(${JSON.stringify(bundle)});
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        window.__bundle = u;
        return true;
    `);
    const out = {};
    for (const c of cases) {
        const ref = fs.readFileSync(path.join(REF, c.name + '.png')).toString('base64');
        const r = await measureCase(page, { ...c, size: meta[c.name] ? meta[c.name].size : undefined },
            { packVar: 'window.__bundle', packName: corpus.bundle, refB64: ref, W: corpus.width, H: corpus.height });
        if (r.png) { fs.writeFileSync(path.join(OUT, c.name + '.png'), Buffer.from(r.png, 'base64')); delete r.png; }
        out[c.name] = r;
    }
    return out;
});

console.log('case'.padEnd(24), 'ink(C/K)'.padEnd(9), 'IoU'.padEnd(6), 'meanΔ'.padEnd(6), 'thick CDPaint'.padEnd(18), 'thick Krita');
for (const [k, r] of Object.entries(results)) {
    if (r.error) { console.log(k.padEnd(24), 'ERROR', r.error); continue; }
    console.log(k.padEnd(24), String(r.inkRatio).padEnd(9), String(r.iou).padEnd(6), String(r.meanDiff).padEnd(6),
        r.ours.thick.join(',').padEnd(18), r.krita.thick.join(','));
}
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));

if (argv.includes('--check')) {
    let bad = 0;
    for (const c of cases) {
        const e = c.expect, r = results[c.name];
        if (!e) continue;
        const why = [];
        if (r.error) why.push(r.error);
        else {
            if (e.inkRatio && (r.inkRatio < e.inkRatio[0] || r.inkRatio > e.inkRatio[1])) why.push(`ink ${r.inkRatio}`);
            if (e.iouMin != null && r.iou < e.iouMin) why.push(`IoU ${r.iou}`);
            if (e.thickTol != null && r.ours.thick.some((t, i) => Math.abs(t - r.krita.thick[i]) > e.thickTol))
                why.push(`thickness ${r.ours.thick} vs ${r.krita.thick}`);
        }
        console.log(`  ${why.length ? 'FAIL' : 'ok  '} ${c.name} matches Krita${why.length ? ' — ' + why.join(', ') : ''}`);
        if (why.length) bad++;
    }
    if (bad) process.exit(1);
}
