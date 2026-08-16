/* Runs the whole validator over a real decomp and insists it stays quiet.
 *
 * Every other suite here checks the validator against fixtures we wrote, which
 * can only ever confirm what we already believed. This one points it at eleven
 * thousand files somebody else wrote, all of which are known-good because the
 * project they come from builds and runs. Anything it complains about is either
 * a genuine find or — far more often — a rule of ours that is wrong.
 *
 * That distinction is the whole point. The first run of this against
 * pokeemerald-expansion 1.16.4 produced 469 problems on a repo with nothing
 * wrong with it: profiles written from pokeemerald's shapes, a palette-length
 * rule gbagfx does not have, and a transparency question asked of the PNG
 * instead of the hardware. A profile that rejects a correct file is worse than
 * no profile, because it teaches people to click through the warning that was
 * meant to save them.
 *
 * Opt-in: needs a decomp checkout, which is far too big to vendor. Set
 * CDPAINT_DECOMP, or drop one beside the repo, and it runs. Otherwise it skips.
 */
import { existsSync, readdirSync, statSync } from 'fs';
import { join, relative, dirname } from 'path';
import { fileURLToPath } from 'url';
import { withPage, findBrowser, REPO_ROOT } from '../browser.mjs';

/* Kept low deliberately. This is not "how many problems does the repo have" —
 * it is "how many of our rules are still wrong", and the honest answer should
 * stay near zero. Raising this number is a decision, not a chore: whatever
 * pushed it up is a rule to fix, or a finding to write down and explain. */
const ALLOWED_WRONG_IN_GAME = 3;

const CANDIDATES = [
    process.env.CDPAINT_DECOMP,
    join(REPO_ROOT, '..', 'pokeemerald-expansion'),
    join(REPO_ROOT, '..', 'pokeemerald')
].filter(Boolean);

const decomp = CANDIDATES.find(p => existsSync(join(p, 'graphics')));

if (!decomp) {
    console.log('decomp audit');
    console.log('  skip  no decomp found — set CDPAINT_DECOMP or clone one beside the repo');
    process.exit(0);
}
if (!findBrowser()) {
    console.log('decomp audit');
    console.log('  skip  no Chromium found');
    process.exit(0);
}

/* Serve the parent of both, so the app and the decomp share an origin and the
 * page can just fetch the files. */
const SERVE_ROOT = join(REPO_ROOT, '..');
const decompName = relative(SERVE_ROOT, decomp).replace(/\\/g, '/');
const appPage = '/' + relative(SERVE_ROOT, join(REPO_ROOT, 'src/index.html')).replace(/\\/g, '/');

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        let st;
        try { st = statSync(full); } catch { return out; }
        if (st.isDirectory()) walk(full, out);
        else if (name.toLowerCase().endsWith('.png')) out.push(full);
    }
    return out;
}

let files = [];
for (const sub of ['graphics', 'data']) {
    const d = join(decomp, sub);
    if (existsSync(d)) walk(d, files);
}
files = files.map(f => relative(decomp, f).replace(/\\/g, '/')).sort();

let passed = 0, failed = 0;
const check = (name, ok, detail) => {
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

console.log(`decomp audit  (${files.length} PNGs from ${decompName})`);

await withPage(async (page) => {
    await page.run(`window.__audit = async (list, root) => {
        const out = [];
        for (const rel of list) {
            try {
                const res = await fetch('/' + root + '/' + rel);
                const bytes = new Uint8Array(await res.arrayBuffer());
                const r = await PaintApp.validateProjectAsset(bytes, rel);
                if (!r.ok) out.push({ path: rel, label: r.label, buildOk: r.buildOk,
                    problems: r.problems.map(p => p.kind + ':' + p.id + ' ' + p.text) });
            } catch (e) {
                out.push({ path: rel, label: 'unreadable', buildOk: false,
                           problems: ['build:fetchFailed ' + (e && e.message || e)] });
            }
        }
        return out;
    }; return true;`);

    // Chunked because a CDP call is capped at 30s and this is 11k decodes.
    const bad = [];
    for (let i = 0; i < files.length; i += 150) {
        bad.push(...await page.eval(
            `await window.__audit(${JSON.stringify(files.slice(i, i + 150))}, ${JSON.stringify(decompName)})`));
    }

    const wontBuild = bad.filter(r => !r.buildOk);
    const wrongInGame = bad.filter(r => r.buildOk);

    const show = (rows) => rows.slice(0, 8).map(r => `${r.path} [${r.problems[0]}]`).join('\n         ');

    check('no stock asset is called unbuildable',
        wontBuild.length === 0,
        wontBuild.length ? `${wontBuild.length} flagged\n         ${show(wontBuild)}` : '');
    check(`at most ${ALLOWED_WRONG_IN_GAME} stock assets look wrong in game`,
        wrongInGame.length <= ALLOWED_WRONG_IN_GAME,
        wrongInGame.length > ALLOWED_WRONG_IN_GAME
            ? `${wrongInGame.length} flagged\n         ${show(wrongInGame)}` : '');
    check('the sweep actually ran', files.length > 100, `${files.length} files`);

    if (wrongInGame.length) {
        console.log(`  note  ${wrongInGame.length} advisory: ${show(wrongInGame)}`);
    }
}, { root: SERVE_ROOT, page: appPage });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
