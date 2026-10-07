/* Runs every suite and reports one total.
 *
 *   npm test                 everything available
 *   npm run test:engine      source-analysis suites only (no browser needed)
 *   npm run test:browser     the live-app suite only
 *
 * Engine suites take an optional source path as their first argument, which is
 * what makes mutation testing possible — point one at a deliberately broken
 * copy of paint-engine.js and it should fail. A suite that still passes
 * against a mutant is not testing what it claims to.
 *
 * Suites run side by side, JOBS at a time (each browser suite gets its own
 * port and profile); the ones that time themselves run alone afterwards, so a
 * busy machine cannot fail them. TEST_JOBS=1 is the old one-at-a-time run.
 * boot-paste runs alone too: under load a paste made during boot is lost
 * (drained, never drawn, even after 10s) -- an app race, not the test's.
 */
import { spawn } from 'child_process';
import { readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { cpus } from 'os';
import { fileURLToPath } from 'url';
import { findBrowser } from './browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const only = process.argv[2];   // 'engine' | 'browser' | undefined
const JOBS = +process.env.TEST_JOBS || Math.max(1, Math.min(6, cpus().length >> 1));
const ALONE = new Set(['boot-paste', 'boot-payload', 'brush-perf', 'dirty-tracking', 'stroke-end']);

const exec = (file, args) => new Promise(res => {
    const c = spawn(process.execPath, [file, ...args], { cwd: ROOT });
    let out = '';
    c.stdout.on('data', d => out += d); c.stderr.on('data', d => out += d);
    c.on('close', status => res({ out, status }));
});

const report = (label, { out, status }) => {
    const m = out.match(/(\d+) passed, (\d+) failed/);
    const passed = m ? +m[1] : 0;
    const failed = m ? +m[2] : (status === 0 ? 0 : 1);
    const ok = status === 0 && !failed;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(22)} ${m ? `${passed} assertions` : (ok ? 'passed' : 'errored')}`);
    if (!ok) {
        const lines = out.trim().split('\n'), hit = lines.filter(l => /FAIL|Error|error:/.test(l));
        const tail = (hit.length ? hit : lines.slice(-3)).slice(0, 6);   // a suite that died quietly: how it ended
        for (const l of tail) console.log(`          ${l.trim()}`);
    }
    return { passed, failed: failed || (ok ? 0 : 1) };
};

const jobs = [];   // [section, label, file, args], reported in this order
if (only !== 'browser') {
    jobs.push(['syntax', 'all source files', join(ROOT, 'scripts', 'smoke-test.mjs'), []]);
    for (const f of readdirSync(join(HERE, 'engine')).filter(f => f.endsWith('.mjs')).sort()) {
        // tab-roundtrip needs the tab system as its first argument.
        const args = f.startsWith('tab-')
            ? ['src/js/tab-system.js', 'src/js/paint-engine.js']
            : [];
        jobs.push(['\nengine  (static analysis of paint-engine.js)', f.replace('.mjs', ''), join(HERE, 'engine', f), args]);
    }
    for (const f of ['wand-algorithms.test.mjs', 'project-model.test.mjs', 'sprite-coords.test.mjs',
                     'battle-scene.test.mjs', 'retile.test.mjs', 'tiled-asset.test.mjs']) {
        const p = join(HERE, f);
        if (existsSync(p)) jobs.push(['\nunit', f.replace(/\.test\.mjs$|\.mjs$/, ''), p, []]);
    }
}
const browser = only !== 'engine' && findBrowser();
if (browser) for (const f of readdirSync(join(HERE, 'browser')).filter(f => f.endsWith('.mjs')).sort())
    jobs.push(['\nbrowser  (the real app, driven over CDP)', f.replace('.mjs', ''), join(HERE, 'browser', f), []]);

// brush-engine is a third of the whole run: started first, it is not the tail on its own
const pool = jobs.map((j, i) => i).filter(i => !ALONE.has(jobs[i][1]))
    .sort((a, b) => (jobs[b][1] === 'brush-engine') - (jobs[a][1] === 'brush-engine'));
const results = [];
let next = 0;
await Promise.all(Array.from({ length: JOBS }, async () => {
    while (next < pool.length) { const i = pool[next++]; results[i] = await exec(jobs[i][2], jobs[i][3]); }
}));
for (let i = 0; i < jobs.length; i++) if (!results[i]) results[i] = await exec(jobs[i][2], jobs[i][3]);

let totalPassed = 0, totalFailed = 0, section = null;
jobs.forEach(([sec, label], i) => {
    if (sec !== section) console.log(section = sec);
    const r = report(label, results[i]);
    totalPassed += r.passed; totalFailed += r.failed;
});
if (only !== 'engine' && !browser)
    console.log('\nbrowser  (the real app, driven over CDP)\n  skip  no Chromium found — install Playwright browsers or Chrome to run these');

console.log(`\n${jobs.length} suites · ${totalPassed} assertions · ${totalFailed} failed`);
process.exit(totalFailed ? 1 : 0);
