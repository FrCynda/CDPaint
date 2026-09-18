/* Import warnings, end to end: from the file to the toast to the panel.
 *
 * brush-import.mjs checks the brushes that come out of importFiles. This one
 * checks the warnings alongside: the toast names them, they persist in
 * localStorage under NOTES_KEY, the panel shows the current brush's, and the
 * library operations carry or drop them as decided.
 */
import { withPage } from '../browser.mjs';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

const F = new URL('../fixtures/brushes/', import.meta.url);
const b64 = (n) => readFileSync(new URL(n, F)).toString('base64');
const FILES = {
    'rough-scrape.sut': b64('rough-scrape.sut'),
    'two-brushes.brushset': b64('two-brushes.brushset'),
};

await withPage(async (page) => {
    await page.run(`
        window.__files = {};
        const raw = ${JSON.stringify(FILES)};
        for (const n in raw) {
            const bin = atob(raw[n]);
            const u = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
            window.__files[n] = new File([u], n);
        }
        window.__said = [];
        window.__realToast = window.showToast;
        window.showToast = (m, k) => { window.__said.push(m); };
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        return true;
    `);

    console.log('== a single changed brush names the change ==');
    const single = await page.eval(`(async () => {
        window.__said.length = 0;
        const r = await PaintApp.brush.importFiles([window.__files['rough-scrape.sut']]);
        const name = PaintApp.brush.userPresetNames()[0];
        const stored = JSON.parse(localStorage.getItem('pb-preset-notes') || '{}');
        PaintApp.brush.loadPreset(name);
        const el = document.getElementById('pb-preset-notes');
        return JSON.stringify({ r, name, toast: window.__said.slice(),
            stored, panel: el ? { text: el.textContent, hidden: el.hidden } : null });
    })()`, { awaitPromise: true }).then(JSON.parse);
    console.log('  ' + JSON.stringify(single));
    check('one brush installs', single.r.brushes === 1 && single.r.failed === 0);
    check('the toast names what was dropped',
        single.toast.some(m => /dropped: blur/.test(m)), JSON.stringify(single.toast));
    check('the note persists under the installed name',
        Array.isArray(single.stored[single.name]) &&
        single.stored[single.name].some(w => /dropped: blur/.test(w)),
        JSON.stringify(single.stored));
    check('a bare loadPreset shows it on the panel',
        single.panel && !single.panel.hidden && /Changed to fit:.*dropped: blur/.test(single.panel.text),
        JSON.stringify(single.panel));

    console.log('== library operations carry or drop the note ==');
    const life = await page.eval(`(() => {
        const out = {};
        const stored = () => JSON.parse(localStorage.getItem('pb-preset-notes') || '{}');
        const name = PaintApp.brush.userPresetNames()[0];
        PaintApp.brush.duplicatePreset(name, name + ' copy');
        out.dupe = !!stored()[name + ' copy'];
        PaintApp.brush.renameUserPreset(name + ' copy', name + ' renamed');
        const s2 = stored();
        out.rename = !!s2[name + ' renamed'] && !s2[name + ' copy'];
        PaintApp.brush.deleteUserPreset(name + ' renamed');
        out.delete = !stored()[name + ' renamed'];
        PaintApp.brush.loadPreset(name);
        PaintApp.brush.saveUserPreset(name);
        out.save = !stored()[name];
        out.panelHidden = document.getElementById('pb-preset-notes').hidden;
        return JSON.stringify(out);
    })()`).then(JSON.parse);
    console.log('  ' + JSON.stringify(life));
    check('duplicate carries the note', life.dupe === true);
    check('rename carries the note', life.rename === true);
    check('delete drops the note', life.delete === true);
    check('save clears the note and hides the panel',
        life.save === true && life.panelHidden === true, JSON.stringify(life));

    console.log('== a batch counts and points at the panel ==');
    const batch = await page.eval(`(async () => {
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        window.__said.length = 0;
        const r = await PaintApp.brush.importFiles(
            [window.__files['rough-scrape.sut'], window.__files['two-brushes.brushset']]);
        return JSON.stringify({ r, toast: window.__said.slice() });
    })()`, { awaitPromise: true }).then(JSON.parse);
    console.log('  ' + JSON.stringify(batch));
    check('batch installs', batch.r.brushes >= 2 && batch.r.failed === 0, JSON.stringify(batch.r));
    check('batch toast keeps the changed count',
        batch.toast.some(m => /changed to fit/.test(m)), JSON.stringify(batch.toast));
    check('batch toast points at the panel',
        batch.toast.some(m => /select the brush to see what changed/.test(m)),
        JSON.stringify(batch.toast));

    await page.run(`
        window.showToast = window.__realToast;
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        return true;
    `);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
