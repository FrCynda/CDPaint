// CDPaint against real GIMP, over every GIMP brush we can get hold of.
//
//   node test/gimp/bank.mjs            score against stored renders
//   node test/gimp/bank.mjs --render   render them with GIMP first
//   node test/gimp/bank.mjs --only extras,slos
//
// GIMP 2.10 runs headless (gimp-console, Script-Fu, no window) with a private
// profile folder, so none of this enters the user's own GIMP. Brushes come
// from GIMP's own install and the packs downloaded into test/krita/out/bank/.
// Strokes are painted with Dynamics Off, which leaves one source of chance:
// a brush pipe (.gih) that picks its cells at random. Those are left out.
import { withPage, REPO_ROOT } from '../browser.mjs';
import { measureCase } from '../krita/measure.mjs';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const OUT = path.join(REPO_ROOT, 'test', 'krita', 'out');
const BANK = path.join(OUT, 'bank');
const RUN = path.join(OUT, 'gimp-run');
const GIMP = process.env.GIMP_CONSOLE || 'C:/Program Files/GIMP 2/bin/gimp-console-2.10.exe';
const GIMP_BRUSHES = process.env.GIMP_BRUSHES || 'C:/Program Files/GIMP 2/share/gimp/2.0/brushes';
const W = 480, H = 300, MAX_SIZE = 30;
// The same strips as the Krita bank; Dynamics Off has no pressure, so 1.
const LINES = [[40, 50, 1, 440, 50, 1], [60, 185, 1, 200, 115, 1], [300, 115, 1, 300, 185, 1],
    [440, 250, 1, 40, 250, 1]];
const BANDS = [[0, 100], [100, 200], [200, 300]];

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : null;
const sources = [['gimp', GIMP_BRUSHES], ['extras', path.join(BANK, 'gimp-extras', 'brushes')],
    ['slos', path.join(BANK, 'gimp-SLOS-GIMPainter')], ['pixelart', path.join(BANK, 'gimp-GIMP-pixelart-brushes')],
    ['leaves', path.join(BANK, 'gimp-Gimp_Leaves-Brush-Pack')], ['vasco', path.join(BANK, 'gimp-gimp-brush-collection')]]
    .filter(([, d]) => fs.existsSync(d));

function walk(d) {
    return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.name === '.git' ? []
        : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
}
const u32 = (b, o) => b.readUInt32BE(o);
// The name GIMP lists a brush under, read the way GIMP reads it.
function describe(file) {
    const b = fs.readFileSync(file), ext = path.extname(file).toLowerCase();
    if (ext === '.vbr') {
        const l = b.toString('utf8').split(/\r?\n/);
        return { name: l[2], random: [] };
    }
    let off = 0, name, random = [];
    if (ext === '.gih') {
        const n1 = b.indexOf(10), n2 = b.indexOf(10, n1 + 1);
        name = b.slice(0, n1).toString('utf8');
        const params = b.slice(n1 + 1, n2).toString('latin1');
        if (/sel\d+:random/.test(params)) random.push('picks its shapes at random');
        off = n2 + 1;
    }
    const hs = u32(b, off), ver = u32(b, off + 4);
    if (ext === '.gbr') name = b.slice(off + (ver >= 2 ? 28 : 20), off + hs).toString('utf8').replace(/\0+$/, '');
    return { name, random };
}

const brushes = [];
for (const [src, dir] of sources) {
    if (only && !only.includes(src)) continue;
    for (const f of walk(dir).filter(f => /\.(gbr|gih|vbr)$/i.test(f))) {
        try { brushes.push({ src, file: f, ...describe(f) }); }
        catch (e) { brushes.push({ src, file: f, name: path.basename(f), unreadable: e.message }); }
    }
}
// GIMP tells same-named brushes apart only by load order, so a name that
// turns up twice (here or in GIMP's own set) cannot be asked for reliably.
const count = {};
for (const s of [GIMP_BRUSHES, ...sources.map(s => s[1])].filter((v, i, a) => a.indexOf(v) === i))
    for (const f of walk(s).filter(f => /\.(gbr|gih|vbr)$/i.test(f))) {
        try { const n = describe(f).name; count[n] = (count[n] || 0) + 1; } catch { /* unreadable */ }
    }
brushes.forEach((e, i) => {
    e.key = 'g' + i;
    if (count[e.name] > 1) e.random = [...(e.random || []), 'name shared with another brush'];
});
const todo = brushes.filter(e => !e.unreadable && !e.random.length && e.name && !/[\\"]/.test(e.name));

fs.mkdirSync(RUN, { recursive: true });
const refDir = path.join(RUN, 'ref');
if (argv.includes('--render')) {
    const prof = path.join(RUN, 'profile');
    fs.rmSync(prof, { recursive: true, force: true });
    fs.mkdirSync(path.join(prof, 'brushes'), { recursive: true });
    fs.mkdirSync(refDir, { recursive: true });
    for (const e of todo) if (e.src !== 'gimp')
        fs.copyFileSync(e.file, path.join(prof, 'brushes', e.key + path.extname(e.file)));
    const q = s => '"' + s.replace(/\\/g, '/') + '"';
    const scm = [`(gimp-message-set-handler 1)
(define (cdp-render name out cap)
  (let* ((img (car (gimp-image-new ${W} ${H} RGB)))
         (lay (car (gimp-layer-new img ${W} ${H} RGBA-IMAGE "ink" 100 LAYER-MODE-NORMAL))))
    (gimp-image-insert-layer img lay 0 0)
    (gimp-context-set-brush name)
    (gimp-context-set-brush-default-size)
    (if (> (car (gimp-context-get-brush-size)) cap) (gimp-context-set-brush-size cap))
    (gimp-context-set-brush-default-spacing)
    (gimp-context-set-brush-default-hardness)
    ; What picking the brush in GIMP's window does ("link to brush default",
    ; gimp_paint_options_set_default_brush_aspect_ratio): the tool option
    ; REPLACES a generated brush's own shape, so it has to carry it.
    (if (= (car (gimp-brush-is-generated name)) 1)
        (begin (gimp-context-set-brush-aspect-ratio (* (- (car (gimp-brush-get-aspect-ratio name)) 1) (/ 20 19)))
               (gimp-context-set-brush-angle (car (gimp-brush-get-angle name))))
        (begin (gimp-context-set-brush-aspect-ratio 0) (gimp-context-set-brush-angle 0)))
${LINES.map(([x0, y0, , x1, y1]) => `    (gimp-paintbrush lay 0 4 #(${x0}.0 ${y0}.0 ${x1}.0 ${y1}.0) PAINT-CONSTANT 0)`).join('\n')}
    (gimp-file-save RUN-NONINTERACTIVE img lay out out)
    (gimp-message (string-append "CDPSIZE\\t" out "\\t" (number->string (car (gimp-context-get-brush-size)))))
    (gimp-image-delete img)))
(gimp-context-set-dynamics "Dynamics Off")
(gimp-context-set-opacity 100)
(gimp-context-set-paint-mode LAYER-MODE-NORMAL)
(gimp-context-set-foreground '(0 0 0))`,
        ...todo.map(e => `(catch (gimp-message (string-append "CDPFAIL\\t" ${q(e.key)})) (cdp-render ${JSON.stringify(e.name)} ${q(path.join(refDir, e.key + '.png'))} ${MAX_SIZE}))`),
        '(gimp-quit 0)'].join('\n');
    fs.writeFileSync(path.join(RUN, 'render.scm'), scm);
    const t = Date.now();
    const r = spawnSync(GIMP, ['-i', '-f', '-b', '-'], { input: scm, encoding: 'utf8', timeout: 3600000,
        env: { ...process.env, GIMP2_DIRECTORY: prof }, maxBuffer: 1 << 28, windowsHide: true });
    const log = (r.stdout || '') + (r.stderr || '');
    fs.writeFileSync(path.join(RUN, 'gimp.log'), log);
    const sizes = {};
    // Script-Fu prints 12.5 as "12,5.0" under a French locale.
    for (const m of log.matchAll(/CDPSIZE\t([^\t]+)\t(\d+)(?:,(\d+))?\.0/g)) sizes[path.basename(m[1], '.png')] = +(m[2] + '.' + (m[3] || 0));
    fs.writeFileSync(path.join(refDir, 'meta.json'), JSON.stringify(sizes, null, 1));
    fs.rmSync(prof, { recursive: true, force: true });
    console.log(`GIMP rendered ${Object.keys(sizes).length} of ${todo.length} in ${Math.round((Date.now() - t) / 1000)}s`);
}
const meta = JSON.parse(fs.readFileSync(path.join(refDir, 'meta.json'), 'utf8'));

const results = [];
await withPage(async (page) => {
    for (const e of brushes) {
        const row = { src: e.src, name: e.name, file: path.relative(REPO_ROOT, e.file).replace(/\\/g, '/'), type: path.extname(e.file).slice(1).toLowerCase() };
        results.push(row);
        if (e.unreadable) { row.status = 'unreadable'; row.why = [e.unreadable]; continue; }
        if (e.random.length) { row.status = 'random'; row.why = e.random; continue; }
        if (meta[e.key] == null) { row.status = 'GIMP could not paint it'; continue; }
        row.size = meta[e.key];
        const bytes = fs.readFileSync(e.file), fname = path.basename(e.file);
        const importExpr = row.type === 'vbr'
            ? `b.importVbr(${JSON.stringify(bytes.toString('utf8'))}, ${JSON.stringify(fname)})`
            : `await b.importBrushTip(Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}), c => c.charCodeAt(0)), ${JSON.stringify(fname)})
                .then(r => ({ ok: r.ok, added: r.ok ? [r.name] : [], error: r.error }))`;
        const r = await measureCase(page, { preset: e.name, size: row.size, lines: LINES, bands: BANDS },
            { importExpr, refB64: fs.readFileSync(path.join(refDir, e.key + '.png')).toString('base64'), W, H });
        if (r.error) { row.status = 'CDPaint could not import it'; row.why = [r.error]; continue; }
        if (!r.krita.ink) { row.status = 'GIMP painted nothing'; continue; }
        fs.writeFileSync(path.join(RUN, e.key + '.png'), Buffer.from(r.png, 'base64'));
        Object.assign(row, { status: 'scored', key: e.key, inkRatio: r.inkRatio, bandInk: r.bandInk, iou: r.iou, meanDiff: r.meanDiff });
    }
});
fs.writeFileSync(path.join(RUN, 'results.json'), JSON.stringify(results, null, 1));

const grade = r => r.iou >= 0.9 && r.inkRatio >= 0.9 && r.inkRatio <= 1.1 ? 'close'
    : r.iou >= 0.75 && r.inkRatio >= 0.8 && r.inkRatio <= 1.25 ? 'near' : 'off';
const tally = {};
for (const r of results) { const k = r.status === 'scored' ? grade(r) : r.status; tally[k] = (tally[k] || 0) + 1; }
console.log(tally);
for (const r of results.filter(r => r.status === 'scored').sort((a, b) => a.iou - b.iou).slice(0, 40))
    console.log(`  ${r.src.padEnd(8)} ${r.type} ${r.name.padEnd(40).slice(0, 40)} size ${String(r.size).padEnd(4)} ink ${String(r.inkRatio).padEnd(6)} IoU ${r.iou}  bands ${r.bandInk.join('/')}  ${r.key}`);
