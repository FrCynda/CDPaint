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
 */
import { spawnSync } from 'child_process';
import { readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { findBrowser } from './browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const only = process.argv[2];   // 'engine' | 'browser' | undefined

const run = (label, file, args = []) => {
    const r = spawnSync(process.execPath, [file, ...args], { cwd: ROOT, encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    const m = out.match(/(\d+) passed, (\d+) failed/);
    const passed = m ? +m[1] : 0;
    const failed = m ? +m[2] : (r.status === 0 ? 0 : 1);
    const ok = r.status === 0 && !failed;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(22)} ${m ? `${passed} assertions` : (ok ? 'passed' : 'errored')}`);
    if (!ok) {
        const tail = out.trim().split('\n').filter(l => /FAIL|Error|error:/.test(l)).slice(0, 6);
        for (const l of tail) console.log(`          ${l.trim()}`);
    }
    return { passed, failed: failed || (ok ? 0 : 1) };
};

let totalPassed = 0, totalFailed = 0, suites = 0;
const tally = (r) => { totalPassed += r.passed; totalFailed += r.failed; suites++; };

if (only !== 'browser') {
    console.log('syntax');
    tally(run('all source files', join(ROOT, 'scripts', 'smoke-test.mjs')));

    console.log('\nengine  (static analysis of paint-engine.js)');
    for (const f of readdirSync(join(HERE, 'engine')).filter(f => f.endsWith('.mjs')).sort()) {
        // tab-roundtrip needs the tab system as its first argument.
        const args = f.startsWith('tab-')
            ? ['src/js/tab-system.js', 'src/js/paint-engine.js']
            : [];
        tally(run(f.replace('.mjs', ''), join(HERE, 'engine', f), args));
    }

    console.log('\nunit');
    for (const f of ['wand-algorithms.test.mjs', 'project-model.test.mjs']) {
        const p = join(HERE, f);
        if (existsSync(p)) tally(run(f.replace(/\.test\.mjs$|\.mjs$/, ''), p));
    }
}

if (only !== 'engine') {
    console.log('\nbrowser  (the real app, driven over CDP)');
    if (!findBrowser()) {
        console.log('  skip  no Chromium found — install Playwright browsers or Chrome to run these');
    } else {
        for (const f of readdirSync(join(HERE, 'browser')).filter(f => f.endsWith('.mjs')).sort()) {
            tally(run(f.replace('.mjs', ''), join(HERE, 'browser', f)));
        }
    }
}

console.log(`\n${suites} suites · ${totalPassed} assertions · ${totalFailed} failed`);
process.exit(totalFailed ? 1 : 0);
