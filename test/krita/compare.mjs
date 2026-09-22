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
        renders: cases.map(c => ({ name: c.name, preset: c.preset, size: c.size, lines: c.lines })) };
    job.renders.forEach(r => { if (r.size === undefined) delete r.size; });
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
        const r = JSON.parse(await page.eval(`(async () => {
            const app = PaintApp, b = app.brush, W = ${corpus.width}, H = ${corpus.height};
            const imp = await b.importBrushPack(window.__bundle, ${JSON.stringify(corpus.bundle)},
                                                { only: ${JSON.stringify([c.preset, c.preset.replace(/ /g, '_')])} });   // the file says b)_Basic-2, Krita shows b) Basic-2
            if (!imp.ok || !imp.added.length) return JSON.stringify({ error: imp.error || 'not imported', imp });
            app.layerMgr.collapseToBase({ fresh: true });
            app.setSize(W, H); app.config.zoom = 1; app.updateBounds();
            document.getElementById('lsys-add').click();
            app.state.selection = null;
            const L = app.layerMgr.layers[app.layerMgr.activeIdx];
            b.loadPreset(imp.added[0]);
            ${meta[c.name] ? `b.setParam('size', ${meta[c.name].size});` : ''}
            await new Promise(res => setTimeout(res, 600));          // let the tip load
            L.ctx.clearRect(0, 0, W, H);
            // Krita's paintLine interpolates pressure along the line; a
            // tablet reports about one sample a pixel at this speed.
            for (const [x0, y0, p0, x1, y1, p1] of ${JSON.stringify(c.lines)}) {
                const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0)));
                b.beginStroke(x0, y0, p0, '#000000');
                for (let i = 1; i <= n; i++) {
                    const t = i / n;
                    b.moveStroke(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, p0 + (p1 - p0) * t, '#000000');
                }
                b.endStroke();
            }
            await new Promise(res => setTimeout(res, 250));
            const ours = L.ctx.getImageData(0, 0, W, H).data;
            const img = new Image(); img.src = 'data:image/png;base64,${ref}'; await img.decode();
            const kc = new OffscreenCanvas(W, H), kx = kc.getContext('2d');
            kx.drawImage(img, 0, 0);
            const theirs = kx.getImageData(0, 0, W, H).data;

            const stat = (d) => {
                let ink = 0, px = 0, part = 0, x0 = W, x1 = -1, y0 = H, y1 = -1, cy = 0;
                const cols = new Float64Array(W);
                for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                    const a = d[(y * W + x) * 4 + 3];
                    if (!a) continue;
                    ink += a; px++; if (a < 255) part++; cy += a * y; cols[x]++;
                    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
                }
                // Stroke thickness sampled at four points along its length.
                const at = (f) => cols[Math.round(${c.lines[0][0]} + (${c.lines[0][3]} - ${c.lines[0][0]}) * f)];
                return { ink: Math.round(ink / 255), pixels: px, partial: part,
                         box: [x0, y0, x1 - x0 + 1, y1 - y0 + 1], centreY: +(cy / Math.max(1, ink)).toFixed(2),
                         thick: [at(0.1), at(0.35), at(0.65), at(0.95)] };
            };
            let diff = 0, n = 0, maxd = 0, both = 0, either = 0;
            const dc = new OffscreenCanvas(W, H * 3), dx = dc.getContext('2d');
            dx.fillStyle = '#fff'; dx.fillRect(0, 0, W, H * 3);
            dx.drawImage(L.canvas, 0, 0); dx.drawImage(kc, 0, H);
            const dd = dx.getImageData(0, H * 2, W, H);
            for (let i = 0; i < W * H; i++) {
                const a = ours[i * 4 + 3], k = theirs[i * 4 + 3];
                if (a || k) { n++; diff += Math.abs(a - k); }
                if (Math.abs(a - k) > maxd) maxd = Math.abs(a - k);
                if (a > 127 && k > 127) both++;
                if (a > 127 || k > 127) either++;
                // red: CDPaint has more ink, blue: Krita has more
                const e = Math.min(255, Math.abs(a - k) * 2);
                dd.data[i * 4] = a >= k ? 255 : 255 - e;
                dd.data[i * 4 + 1] = 255 - e;
                dd.data[i * 4 + 2] = a >= k ? 255 - e : 255;
                dd.data[i * 4 + 3] = 255;
            }
            dx.putImageData(dd, 0, H * 2);
            dx.fillStyle = '#888'; dx.fillRect(0, H - 1, W, 1); dx.fillRect(0, 2 * H - 1, W, 1);
            const blob = await dc.convertToBlob();
            const u8 = new Uint8Array(await blob.arrayBuffer());
            let s = ''; for (const x of u8) s += String.fromCharCode(x);
            const so = stat(ours), sk = stat(theirs);
            return JSON.stringify({ png: btoa(s), ours: so, krita: sk,
                inkRatio: +(so.ink / Math.max(1, sk.ink)).toFixed(3),
                meanDiff: +(diff / Math.max(1, n)).toFixed(1), maxDiff: maxd,
                iou: +(both / Math.max(1, either)).toFixed(3),
                warnings: imp.warnings || imp.notes || [],
                // What the import actually produced, long strings (tip data) cut.
                params: JSON.parse(JSON.stringify(b.getParams(), (k, v) =>
                    typeof v === 'string' && v.length > 80 ? v.slice(0, 40) + '...' : v)) });
        })()`, { awaitPromise: true }));
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
