// CDPaint against real Krita, over every brush pack we can get hold of.
//
//   node test/krita/bank.mjs                 score against stored renders
//   node test/krita/bank.mjs --render        render the missing packs in Krita first
//   node test/krita/bank.mjs --packs deevad23,eo-v3
//   node test/krita/bank.mjs --holdout [--render]
//   node test/krita/bank.mjs --random [--render]   the presets that ask for chance, by statistics
//   node test/krita/bank.mjs -j 1             one pack at a time (default: several at once)
//   node test/krita/bank.mjs --scene [--render]    the scene: strokes crossing, in colour, over paint, a curve, a tap
//   node test/krita/bank.mjs --engine colorsmudge  only presets of the engines it matches (a regex)
//
// The fixed corpus (compare.mjs) tests seventeen brushes by hand; this runs
// the whole of Krita's own bundles plus the packs downloaded into
// test/krita/out/bank/ (see README "brush bank"). Only brushes that paint the
// same thing twice are scored: a preset is left out when its settings ask
// for chance (a fuzzy sensor, scatter, tip randomness, a shuffled texture)
// or, whatever the settings say, when Krita's two renders of it differ.
//
// Each pack renders in a private Krita resource folder, so none of it
// enters the user's own library. Everything written goes under test/krita/out/.
import { withPage, REPO_ROOT } from '../browser.mjs';
import { renderKrita } from './render.mjs';
import { measureCase } from './measure.mjs';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import os from 'os';
import fs from 'fs';
import path from 'path';

const OUT = path.join(REPO_ROOT, 'test', 'krita', 'out');
const BANK = path.join(OUT, 'bank');
// --holdout scores only the held-out packs (out/bank/holdout/, cloned after
// the fixes were made), in a run folder of their own.
const HOLDOUT = process.argv.includes('--holdout');
const RUN = path.join(OUT, HOLDOUT ? 'bank-holdout' : 'bank-run');
const KRITA_SHARE = process.env.KRITA_SHARE || 'C:/Program Files/Krita (x64)/share/krita';
const W = 480, H = 300, MAX_SIZE = 30;
// Three strips: a pressure ramp left to right, a diagonal and an upright at
// fixed pressure, and a stroke drawn right to left.
const LINES = [[40, 50, 0.1, 440, 50, 1.0], [60, 185, 0.8, 200, 115, 0.8], [300, 115, 0.5, 300, 185, 0.5],
    [440, 250, 1.0, 40, 250, 0.5]];
const BANDS = [[0, 100], [100, 200], [200, 300]];
/* --scene: what the strips never ask. Orange paint (each channel different,
 * so a swapped or greyed colour shows) over a red and a blue block, a ramp
 * across both; two strokes crossing; two overlapping strokes over a
 * half-transparent green; a curve (Krita's paintPath, full pressure); a tap.
 * Scored on how far each pixel moved off the start, and on colour. */
const SCENE = process.argv.includes('--scene');
const SCENE_SET = {
    color: [220, 110, 30],
    rects: [[60, 30, 120, 80, 200, 40, 40, 255], [260, 30, 120, 80, 40, 80, 200, 255], [260, 140, 190, 50, 40, 160, 60, 128]],
    paths: [Array.from({ length: 61 }, (_, i) => { const t = i / 60 * 5 * Math.PI / 3; return [355 + 35 * Math.cos(t), 245 + 35 * Math.sin(t)]; })
        .flat().map(v => +v.toFixed(2))],
};
const SCENE_LINES = [[30, 70, 0.3, 450, 70, 1.0], [40, 140, 0.6, 210, 280, 1.0], [210, 140, 1.0, 40, 280, 0.6],
    [270, 160, 0.8, 440, 160, 0.8], [270, 168, 0.8, 440, 168, 0.8], [235, 215, 1.0, 236, 215, 1.0]];
const engineRe = process.argv.includes('--engine') ? new RegExp(process.argv[process.argv.indexOf('--engine') + 1], 'i') : null;

const argv = process.argv.slice(2);
/* --random scores the presets left out for chance: Krita renders each twice,
 * ours paints once, and the grade is the ink and where it lies (12px blur)
 * against how far Krita's two renders agree with each other. */
const RANDOM = argv.includes('--random');
// --only <regex>: just the presets it names, printed and not saved
const only = argv.includes('--only') ? new RegExp(argv[argv.indexOf('--only') + 1], 'i') : null;
const onlyPacks = argv.includes('--packs') ? argv[argv.indexOf('--packs') + 1].split(',') : null;

// A pack is a .bundle, or a folder of paintoppresets/brushes/patterns (nested
// any depth) which is flattened into one -- Krita's folder storage does not
// look into subfolders.
const packs = (HOLDOUT ? fs.readdirSync(path.join(BANK, 'holdout')).map(d => ['ho-' + d, path.join(BANK, 'holdout', d)])
    .filter(([, d]) => walk(d).some(f => /\.kpp$/i.test(f))) : [
    ['krita4', path.join(KRITA_SHARE, 'bundles', 'Krita_4_Default_Resources.bundle')],
    ['krita3', path.join(KRITA_SHARE, 'bundles', 'Krita_3_Default_Resources.bundle')],
    ['rgba', path.join(KRITA_SHARE, 'bundles', 'RGBA_brushes.bundle')],
    ['deevad21', path.join(BANK, 'deevad21', 'Deevad_2021.bundle')],
    ['deevad23', path.join(BANK, 'deevad23', 'deevad-bundle_23-01.bundle')],
    ['eo-v2', path.join(BANK, 'eo', 'EO_Bundle_v2.bundle')],
    ['eo-v3', path.join(BANK, 'eo', 'Eo_Bundle_v3.bundle')],
    ...(fs.existsSync(path.join(BANK, 'portnov')) ? fs.readdirSync(path.join(BANK, 'portnov'))
        .filter(d => fs.statSync(path.join(BANK, 'portnov', d)).isDirectory() && d !== '.git')
        .map(d => ['portnov-' + d, path.join(BANK, 'portnov', d)]) : []),
]).filter(([id, p]) => fs.existsSync(p) && (!onlyPacks || onlyPacks.includes(id)))
    .map(([id, src]) => ({ id, src, folder: fs.statSync(src).isDirectory() }));

function walk(d) {
    return fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
}
function flatten(src, dst) {   // folder pack -> dst/{paintoppresets,brushes,patterns}/<file>
    for (const f of walk(src)) {
        const kind = /\.kpp$/i.test(f) ? 'paintoppresets'
            : /[\\/]patterns[\\/]/i.test(f) ? 'patterns' : /[\\/]brushes[\\/]/i.test(f) ? 'brushes' : null;
        if (!kind) continue;
        fs.mkdirSync(path.join(dst, kind), { recursive: true });
        fs.copyFileSync(f, path.join(dst, kind, path.basename(f)));
    }
}

async function scoreRandom(page, p, e, row, refDir, meta) {
    if (!meta) { row.status = 'not rendered'; return; }
    if (!meta[e.key + 'a'] || !meta[e.key + 'b']) { row.status = 'Krita could not load it'; return; }
    const A = fs.readFileSync(path.join(refDir, e.key + 'a.png')).toString('base64');
    const B = fs.readFileSync(path.join(refDir, e.key + 'b.png')).toString('base64');
    row.size = meta[e.key + 'a'].size;
    let r;
    try {
        r = await measureCase(page, { preset: e.name, file: e.file, size: row.size, lines: LINES, bands: BANDS },
            { packVar: 'window.__pk', packName: path.basename(p.zip), refB64: A, refB: B, W, H, seed: 1 });
    } catch (err) { row.status = 'harness error'; row.why = [err.message]; return; }
    if (r.error) { row.status = 'CDPaint could not import it'; row.why = [r.error, ...(r.skipped || []).map(s => s.why)]; return; }
    const km = (r.krita.ink + r.kk.ink) / 2;
    if (!km) { row.status = 'Krita painted nothing'; row.ourInk = r.ours.ink; return; }
    fs.writeFileSync(path.join(p.dir, e.key + '.png'), Buffer.from(r.png, 'base64'));
    Object.assign(row, { status: 'scored', key: e.key, inkRatio: +(r.ours.ink / km).toFixed(3),
        kSpread: +(Math.abs(r.krita.ink - r.kk.ink) / km).toFixed(3), soft: r.soft, kSoft: r.kk.soft,
        iou: r.iou, why: e.random, warnings: (r.warnings[0] || {}).warnings || [] });
    console.log(`  ${e.name.padEnd(46).slice(0, 46)} ink ${String(row.inkRatio).padEnd(6)} soft ${r.soft} (Krita ${r.kk.soft})`);
}
/* A random brush is close when its ink is within 10% (or twice Krita's own
 * spread) and its blurred overlap with Krita comes within 0.05 of Krita's
 * with itself; near within 25% and three quarters of that overlap. */
const gradeRandom = r => {
    const d = Math.abs(r.inkRatio - 1);
    return d <= Math.max(0.1, 2 * r.kSpread) && r.soft >= r.kSoft - 0.05 ? 'close'
        : d <= Math.max(0.25, 3 * r.kSpread) && r.soft >= 0.75 * r.kSoft ? 'near' : 'off';
};

fs.mkdirSync(RUN, { recursive: true });
for (const p of packs) {
    p.dir = path.join(RUN, p.id);
    p.zip = p.src;
    /* Krita ships its Krita 3 bundle switched off, and knows a copy of it
     * for the same bundle whatever it is called -- so it goes in unpacked. */
    if (p.id === 'krita3') {
        p.folder = true; p.src = path.join(p.dir, 'unpacked');
        if (!fs.existsSync(p.src))
            execFileSync('python', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', p.zip, p.src]);
    }
    if (p.folder) {
        p.flat = path.join(p.dir, 'flat');
        if (!fs.existsSync(p.flat)) flatten(p.src, p.flat);
        p.zip = path.join(p.dir, p.id + '.zip');
        if (!fs.existsSync(p.zip))
            execFileSync('python', ['-c', 'import shutil,sys; shutil.make_archive(sys.argv[1][:-4], "zip", sys.argv[2])', p.zip, p.flat]);
    }
}

const results = [];
// Packs not run this time keep their last results.
const save = () => {
    const file = path.join(RUN, RANDOM ? 'results-random.json' : SCENE ? 'results-scene.json' : 'results.json'), ids = new Set(results.map(r => r.pack));
    const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).filter(r => !ids.has(r.pack)) : [];
    if (!only && !engineRe) fs.writeFileSync(file, JSON.stringify([...old, ...results], null, 1));
};
/* -j N scores N packs at once, each in a browser of its own (BANK_CHILD:
 * a child scores the one pack it is given and hands its rows back in that
 * file). Rendering stays one Krita at a time (render.mjs borrows the user's
 * kritarc): with --render, Krita renders pack after pack in children of
 * their own (--render-only) while the scorers take each pack once it is
 * rendered. Default: half the cores, to 6. */
const CHILD = process.env.BANK_CHILD;
const RENDER = argv.includes('--render') || argv.includes('--render-only'), RENDER_ONLY = argv.includes('--render-only');
const JOBS = CHILD ? 1
    : argv.includes('-j') ? +argv[argv.indexOf('-j') + 1] : Math.max(1, Math.min(6, os.cpus().length >> 1));
if (JOBS > 1 && packs.length > 1) {
    const queue = [...packs].sort((a, b) => fs.statSync(b.zip).size - fs.statSync(a.zip).size);   // biggest first
    const pass = argv.filter((a, i) => a !== '-j' && argv[i - 1] !== '-j' && a !== '--packs' && argv[i - 1] !== '--packs' && a !== '--render');
    const child = (args, out) => new Promise(res => {
        const c = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { env: { ...process.env, BANK_CHILD: out } });
        let s = ''; c.stdout.on('data', d => s += d); c.stderr.on('data', d => s += d);
        c.on('close', () => res(s));
    });
    const rendered = {};   // pack id -> done; one Krita at a time, in the order the scorers want them
    let chain = Promise.resolve();
    for (const p of queue) rendered[p.id] = chain = !RENDER ? chain : chain.then(async () => {
        const log = await child([...pass, '--render-only', '--packs', p.id], path.join(RUN, `.render-${p.id}.json`));
        fs.rmSync(path.join(RUN, `.render-${p.id}.json`), { force: true });
        process.stdout.write(log.split('\n').filter(l => /rendered|Krita failed|harness error/.test(l)).map(l => p.id + ':' + l).join('\n') + '\n');
    });
    await Promise.all(Array.from({ length: JOBS }, async () => {
        for (let p; (p = queue.shift());) {
            await rendered[p.id];
            const out = path.join(RUN, `.child-${p.id}.json`);
            fs.rmSync(out, { force: true });
            const log = await child([...pass, '--packs', p.id], out);
            process.stdout.write(log.split('\n').filter(l => !/^\s*$|^ \{|^worst:/.test(l)).join('\n') + '\n');
            if (fs.existsSync(out)) { results.push(...JSON.parse(fs.readFileSync(out, 'utf8'))); fs.rmSync(out); }
            else results.push({ pack: p.id, status: 'harness error', why: ['the child scored nothing'] });
        }
    }));
    save();
} else await withPage(async (page) => {
    for (const p of packs) {
        console.log(`== ${p.id}`);
        try { await scorePack(page, p); }
        catch (e) { console.log('  harness error: ' + e.message); results.push({ pack: p.id, status: 'harness error', why: [e.message] }); }
        if (CHILD) fs.writeFileSync(CHILD, JSON.stringify(results));
        else save();
    }
});
if (CHILD) process.exit(0);

async function scorePack(page, p) {
        // In pieces: a 91MB pack in one message outlives the CDP timeout.
        const buf = fs.readFileSync(p.zip), CH = 6 << 20;
        await page.run(`window.__pk = new Uint8Array(${buf.length}); return true;`);
        for (let o = 0; o < buf.length; o += CH)
            await page.run(`const s = atob(${JSON.stringify(buf.subarray(o, o + CH).toString('base64'))});
                for (let i = 0; i < s.length; i++) window.__pk[${o} + i] = s.charCodeAt(i); return true;`);
        // What is in it, and which presets ask for chance.
        const list = JSON.parse(await page.eval(`(async () => {
            const pack = await BrushPack.read(window.__pk);
            const seen = {};
            return JSON.stringify(pack.presets.map(pr => {
                const P = pr.params, why = [];
                for (const k in P) {
                    const m = /^(.*)Pressure(\\w+)$/.exec(k);
                    if (!m || P[k] !== 'true') continue;
                    if (m[1] && P[m[1].replace(/Preset\\/$/, '') + 'Enabled'] !== 'true') continue;   // a masking brush that is off
                    if (/id="fuzzy/i.test(P[m[1] + m[2] + 'Sensor'] || '')) why.push('random ' + m[2]);
                    if (m[2] === 'Scatter') why.push('scatter');
                }
                const bd = BrushPack.brushDefinition(pr) || {};
                if (+bd.randomness > 0) why.push('tip randomness');
                if (bd.density != null && +bd.density < 1) why.push('tip density');
                if (/\\.gih$/i.test(bd.filename || '')) why.push('animated tip');
                if (P['Texture/Pattern/Enabled'] === 'true' &&
                    (P['Texture/Pattern/isRandomOffsetX'] === 'true' || P['Texture/Pattern/isRandomOffsetY'] === 'true'))
                    why.push('texture at a random offset');
                if (/^(spraybrush|particlepaintop)$/.test(pr.paintop)) why.push(pr.paintop + ' engine');
                if (seen[pr.name]) why.push('name used twice in the pack');
                seen[pr.name] = 1;
                return { name: pr.name, file: pr.file.split('/').pop(), engine: pr.paintop, random: why };
            }));
        })()`, { awaitPromise: true }));
        const todo = list.filter(e => RANDOM ? e.random.length : !e.random.length);
        todo.forEach((e, i) => { e.key = (RANDOM ? 'r' : SCENE ? 's' : 'p') + i; });
        const refDir = path.join(p.dir, RANDOM ? 'rref' : SCENE ? 'sref' : 'ref');

        if (RENDER && !fs.existsSync(path.join(refDir, 'meta.json'))) {
            const res = path.join(p.dir, 'kres');
            fs.rmSync(res, { recursive: true, force: true });
            fs.mkdirSync(res, { recursive: true });
            if (p.folder) fs.cpSync(p.flat, res, { recursive: true });
            else fs.copyFileSync(p.src, path.join(res, path.basename(p.src)));
            const job = { width: W, height: H, out: refDir.replace(/\\/g, '/'), renders: todo.flatMap(e =>
                ['a', 'b'].map(s => SCENE ? { name: e.key + s, file: e.file, maxSize: MAX_SIZE, lines: SCENE_LINES, ...SCENE_SET }
                    : { name: e.key + s, file: e.file, maxSize: MAX_SIZE, lines: LINES })) };
            fs.mkdirSync(p.dir, { recursive: true });
            fs.writeFileSync(path.join(p.dir, 'job.json'), JSON.stringify(job));
            const t = Date.now();
            try {
                const log = renderKrita(path.join(p.dir, 'job.json'), { resourceDir: res, timeoutMs: 1800000 });
                fs.writeFileSync(path.join(p.dir, 'krita.log'), log);
            } catch (e) { console.log('  Krita failed: ' + e.message.split('\n')[0]); }
            fs.rmSync(res, { recursive: true, force: true });
            console.log(`  rendered ${todo.length} presets in ${Math.round((Date.now() - t) / 1000)}s`);
        }
        if (RENDER_ONLY) return;
        const meta = fs.existsSync(path.join(refDir, 'meta.json')) ? JSON.parse(fs.readFileSync(path.join(refDir, 'meta.json'), 'utf8')) : null;

        for (const e of RANDOM ? todo : list) {
            if (only && !only.test(e.name) || engineRe && !engineRe.test(e.engine)) continue;
            const row = { pack: p.id, name: e.name, engine: e.engine };
            results.push(row);
            if (RANDOM) { await scoreRandom(page, p, e, row, refDir, meta); continue; }
            if (e.random.length) { row.status = 'random'; row.why = e.random; continue; }
            if (!meta) { row.status = 'not rendered'; continue; }
            if (!meta[e.key + 'a']) { row.status = 'Krita could not load it'; continue; }
            const A = fs.readFileSync(path.join(refDir, e.key + 'a.png')).toString('base64');
            const B = fs.readFileSync(path.join(refDir, e.key + 'b.png')).toString('base64');
            if (A !== B) {   // same pixels encode to the same PNG; a mismatch is checked properly
                const d = await page.eval(`(async () => {
                    const px = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode();
                        const c = new OffscreenCanvas(${W}, ${H}), x = c.getContext('2d'); x.drawImage(i, 0, 0);
                        return x.getImageData(0, 0, ${W}, ${H}).data; };
                    const a = await px(${JSON.stringify(A)}), b = await px(${JSON.stringify(B)});
                    let n = 0; for (let i = 3; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 2) n++;
                    return n;
                })()`, { awaitPromise: true });
                if (d > 0) { row.status = 'random'; row.why = [`Krita painted it differently twice (${d} px)`]; continue; }
            }
            row.size = meta[e.key + 'a'].size;
            if (!(fs.readFileSync(path.join(refDir, e.key + 'a.png')).length > 0)) { row.status = 'no render'; continue; }
            let r;
            try {
                r = await measureCase(page, { preset: e.name, file: e.file, size: row.size, lines: SCENE ? SCENE_LINES : LINES, bands: BANDS },
                    { packVar: 'window.__pk', packName: path.basename(p.zip), refB64: A, W, H, scene: SCENE ? SCENE_SET : null, keepErase: SCENE });
            } catch (err) { row.status = 'harness error'; row.why = [err.message]; continue; }
            if (r.error) { row.status = 'CDPaint could not import it'; row.why = [r.error, ...(r.skipped || []).map(s => s.why)]; continue; }
            // ours should be blank too: say how much we laid down where Krita laid none
            if (!r.krita.ink) { row.status = 'Krita painted nothing'; row.ourInk = r.ours.ink; continue; }
            fs.writeFileSync(path.join(p.dir, e.key + '.png'), Buffer.from(r.png, 'base64'));
            Object.assign(row, { status: 'scored', key: e.key, inkRatio: r.inkRatio, bandInk: r.bandInk, iou: r.iou,
                meanDiff: r.meanDiff, colErr: r.colErr, warnings: (r.warnings[0] || {}).warnings || [] });
            console.log(`  ${e.name.padEnd(46).slice(0, 46)} ink ${String(r.inkRatio).padEnd(6)} IoU ${r.iou}${SCENE ? ' colour ' + r.colErr : ''}`);
        }
}

const scored = results.filter(r => r.status === 'scored');
// scene: right shape, wrong colour is not close. Colour errors split at 9 -> 22 (a gap in all 386 rows)
const ce = r => r.colErr ?? 0;
const grade = RANDOM ? gradeRandom : r => r.iou >= 0.9 && r.inkRatio >= 0.9 && r.inkRatio <= 1.1 && ce(r) <= 10 ? 'close'
    : r.iou >= 0.75 && r.inkRatio >= 0.8 && r.inkRatio <= 1.25 && ce(r) <= 25 ? 'near' : 'off';
const tally = {};
for (const r of results) {
    const k = r.status === 'scored' ? grade(r) : r.status;
    tally[k] = (tally[k] || 0) + 1;
}
console.log('\n', tally);
console.log('\nworst:');
for (const r of scored.sort((a, b) => RANDOM ? a.soft / a.kSoft - b.soft / b.kSoft : a.iou - b.iou).slice(0, 40))
    console.log(RANDOM ? `  ${r.pack.padEnd(18)} ${r.name.padEnd(46).slice(0, 46)} ${r.engine.padEnd(14)} ink ${String(r.inkRatio).padEnd(6)} (Krita +-${r.kSpread}) soft ${r.soft} / ${r.kSoft}  ${grade(r)}`
        : `  ${r.pack.padEnd(18)} ${r.name.padEnd(46).slice(0, 46)} ${r.engine.padEnd(14)} ink ${String(r.inkRatio).padEnd(6)} IoU ${r.iou}  bands ${r.bandInk.join('/')}`);
