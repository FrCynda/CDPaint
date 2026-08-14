/* Verifies the save/export routing for layered documents.
 *
 * The bug: saveFile() begins with its own "layers active -> save as ORA" check,
 * so an export routed through it came back out as another .ora. And saveAsORA
 * wrote via a hidden <a download> click, so "Save" appeared to do nothing.
 */
import { readFileSync } from 'fs';
import vm from 'vm';

const SRC = process.argv[2] || 'src/js/paint-engine.js';
const text = readFileSync(SRC, 'utf8');
const lines = text.split(/\r?\n/);

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

function extractFn(name) {
    const start = lines.findIndex(l => new RegExp(`^        (?:async )?function ${name}\\s*\\(`).test(l));
    if (start < 0) throw new Error(`function ${name} not found`);
    let depth = 0, started = false, out = [];
    for (let i = start; i < lines.length; i++) {
        out.push(lines[i]);
        for (const ch of lines[i]) {
            if (ch === '{') { depth++; started = true; }
            else if (ch === '}') depth--;
        }
        if (started && depth === 0) return out.join('\n');
    }
    throw new Error(`unbalanced braces in ${name}`);
}

console.log('== 1. only ONE layers->ORA check exists ==');
{
    const checks = text.split('save as ORA').length - 1
                 + text.split('always save as ORA').length - 1;
    const wrapperGone = !/const _origSaveFile/.test(text);
    check('the duplicate saveFile wrapper is gone', wrapperGone,
        'two checks could disagree about when to write ORA');
    check('export does not route through saveFile',
        !/exportFlattenedPng[\s\S]{0,600}_origSaveFile/.test(text));
}

console.log('\n== 2. export builds its own blob from the flattened canvas ==');
{
    const m = /app\.exportFlattenedPng = async function \(\) \{[\s\S]*?\n        \};/.exec(text);
    check('exportFlattenedPng found', !!m);
    if (m) {
        const body = m[0];
        check('uses the flattened canvas', /getFlattenedCanvas\(\)/.test(body));
        check('encodes a PNG', /toBlob\(res, 'image\/png'\)/.test(body));
        check('writes through the shared save helper', /_saveBlobAs\(/.test(body));
        check('does not mark the document saved (an export is not a save)',
            !/markSaved/.test(body));
    }
}

console.log('\n== 3. ORA save writes through the shared helper, not a hidden link ==');
{
    // The body lives in _saveAsORAInner; app.saveAsORA is the reporting wrapper.
    const m = /async function _saveAsORAInner\(\) \{[\s\S]*?\n        \}/.exec(text);
    check('_saveAsORAInner found', !!m);
    if (m) {
        const body = m[0];
        check('uses the shared save helper', /_saveBlobAs\(/.test(body));
        check('no bare download-link click left in it',
            !/a\.click\(\)/.test(body),
            'a hidden <a download> click is why Save looked like a no-op');
        check('respects cancellation', /if \(!saved\) return;/.test(body));
        check('skips group folders, which have no pixels to encode',
            /isGroup/.test(body));
    }
    const w = /app\.saveAsORA = async function \(\) \{[\s\S]*?\n        \};/.exec(text);
    check('saveAsORA reports failures instead of swallowing them',
        !!w && /showToast/.test(w[0]) && /console\.error/.test(w[0]));
}

console.log('\n== 3b. save entry points surface errors ==');
{
    check('saveFile / saveAsFile are wrapped for reporting',
        /for \(const _fn of \['saveFile', 'saveAsFile'\]\)/.test(text),
        'inline onclick handlers never catch, so a throw is invisible');
}

console.log('\n== 4. the save helper prefers a real picker ==');
{
    const sandbox = { console, window: {}, document: {}, app: {} };
    vm.createContext(sandbox);
    vm.runInContext(extractFn('_saveBlobAs') + '\nglobalThis.__f = _saveBlobAs;', sandbox);
    const _saveBlobAs = sandbox.__f;

    const blob = { arrayBuffer: async () => new ArrayBuffer(4) };
    let downloaded = false;
    const resetDom = () => {
        downloaded = false;
        sandbox.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
        sandbox.document = { createElement: () => ({ click() { downloaded = true; } }) };
        sandbox.setTimeout = () => {};
        sandbox.window = {};
        sandbox.app = {};
    };

    // Browser with the File System Access API -> picker
    resetDom();
    let wrote = null;
    sandbox.window.showSaveFilePicker = async (opts) => {
        wrote = { picker: true, name: opts.suggestedName };
        return {
            name: opts.suggestedName,
            createWritable: async () => ({ write: async () => {}, close: async () => {} })
        };
    };
    const r1 = await _saveBlobAs(blob, 'art.ora', 'OpenRaster Image', { 'image/openraster': ['.ora'] });
    check('opens a file picker when available', wrote && wrote.picker === true);
    check('returns the chosen name', r1 === 'art.ora', String(r1));

    // User cancels the picker -> null, and nothing is written
    resetDom();
    sandbox.window.showSaveFilePicker = async () => {
        const e = new Error('cancelled'); e.name = 'AbortError'; throw e;
    };
    const r2 = await _saveBlobAs(blob, 'art.ora', 'OpenRaster Image', {});
    check('cancelling the picker returns null and writes nothing',
        r2 === null && downloaded === false, String(r2));

    // Desktop app -> native dialog + allowed-path write
    resetDom();
    let written = null;
    sandbox.window.__TAURI__ = {};
    sandbox.app.tauriSaveFileDialog = async (opts) => {
        check('native dialog gets a default filename', opts.defaultPath === 'art.ora', opts.defaultPath);
        check('native dialog gets an extension filter',
            opts.filters && opts.filters[0].extensions[0] === 'ora',
            JSON.stringify(opts.filters));
        return '/tmp/art.ora';
    };
    sandbox.app.tauriWriteAllowedFile = async (p) => { written = p; };
    const r3 = await _saveBlobAs(blob, 'art.ora', 'OpenRaster Image', {});
    check('writes to the chosen path in the desktop app', written === '/tmp/art.ora', String(written));
    check('returns the path', r3 === '/tmp/art.ora', String(r3));

    // Explicit cancel of the native dialog
    resetDom(); written = null;
    sandbox.window.__TAURI__ = {};
    sandbox.app.tauriSaveFileDialog = async () => null;
    sandbox.app.tauriWriteAllowedFile = async (p) => { written = p; };
    const r4 = await _saveBlobAs(blob, 'art.ora', 'OpenRaster Image', {});
    check('cancelling the native dialog writes nothing',
        written === null && r4 === null && downloaded === false);

    // THE BUG: an unavailable dialog returns undefined, which must NOT be
    // mistaken for a cancel — that is what made Save do nothing at all.
    resetDom(); written = null;
    sandbox.window.__TAURI__ = {};
    sandbox.app.tauriSaveFileDialog = async () => undefined;
    sandbox.app.tauriWriteAllowedFile = async (p) => { written = p; };
    const r5 = await _saveBlobAs(blob, 'art.ora', 'OpenRaster Image', {});
    check('an unavailable dialog falls through instead of aborting silently',
        r5 === 'art.ora' && downloaded === true,
        'undefined was treated as "cancelled", so the save vanished');

    // A dialog that throws must also fall through rather than kill the save.
    resetDom();
    sandbox.window.__TAURI__ = {};
    sandbox.app.tauriSaveFileDialog = async () => { throw new Error('no plugin'); };
    const r6 = await _saveBlobAs(blob, 'art.ora', 'OpenRaster Image', {});
    check('a throwing dialog falls through too', r6 === 'art.ora' && downloaded === true,
        String(r6));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
