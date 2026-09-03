/* A paste that arrives before the engine is up must not be lost.
 *
 * PaintEngine installs its paste handler part-way through init(), which cannot
 * run until paint-engine.js has been fetched, compiled and executed. Before
 * that there is no listener on the window at all, and a clipboard event does
 * not queue or replay — press Ctrl+V in that gap and the paste is gone, with
 * nothing on screen to say so. A catcher in index.html's <head> now holds it
 * until the engine can draw it.
 *
 * The interesting property is the ordering, so the test asserts on it directly:
 * the paste is dispatched while `window.PaintApp` is still undefined, and the
 * image is expected on the canvas afterwards anyway. A test that pasted after
 * boot would pass with the catcher deleted.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

/* Runs at document start, ahead of every app script. Waits for the <head>
 * catcher to exist and then fires immediately — the engine must still be
 * missing at that instant or the test is not measuring anything. */
const EARLY_PASTE = `
(function () {
    window.__probe = { dispatched: false, engineWasUp: null, caught: null, at: null };
    (function poll() {
        if (window.PaintApp) { window.__probe.engineWasUp = true; return; }
        if (!window.__earlyPaste) { setTimeout(poll, 0); return; }

        var c = document.createElement('canvas');
        c.width = 8; c.height = 8;
        var x = c.getContext('2d');
        x.fillStyle = '#ff0000';
        x.fillRect(0, 0, 8, 8);
        var bin = atob(c.toDataURL('image/png').split(',')[1]);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);

        var dt = new DataTransfer();
        dt.items.add(new File([arr], 'clip.png', { type: 'image/png' }));

        window.__probe.engineWasUp = !!window.PaintApp;
        window.__probe.at = performance.now();
        window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }));
        window.__probe.dispatched = true;
        window.__probe.caught = !!window.__pendingPaste;
    })();
})();
`;

await withPage(async (page) => {
    await page.reloadWith(EARLY_PASTE);
    await new Promise(r => setTimeout(r, 2500));

    const probe = await page.eval('window.__probe');
    check('paste was dispatched during boot', probe.dispatched === true,
        JSON.stringify(probe));
    check('and the engine really was not up yet', probe.engineWasUp === false,
        `engineWasUp=${probe.engineWasUp}`);
    check('the head catcher held it', probe.caught === true);

    /* isPaste=true drops the image in as a floating selection. */
    const after = await page.run(`
        const sel = PaintApp.state.selection;
        let red = false;
        if (sel) {
            const c = PaintApp.getRenderedSelectionCanvas
                ? PaintApp.getRenderedSelectionCanvas() : null;
            if (c) {
                const d = c.getContext('2d').getImageData(0, 0, 1, 1).data;
                red = d[0] > 200 && d[1] < 60 && d[2] < 60 && d[3] > 200;
            }
        }
        return {
            drained: window.__pendingPaste === null,
            hasSelection: !!sel,
            w: sel ? sel.w : null,
            h: sel ? sel.h : null,
            red
        };
    `);
    check('the pending paste was drained', after.drained === true);
    check('and it landed on the canvas', after.hasSelection === true,
        JSON.stringify(after));
    check('at the right size', after.w === 8 && after.h === 8,
        `${after.w}x${after.h}`);
    check('with the pasted pixels', after.red === true, JSON.stringify(after));

    /* The catcher must stand down once the engine owns the event, or every
     * later paste would be handled now and replayed on the next drain. */
    const handover = await page.eval('({ early: window.__earlyPaste, pending: window.__pendingPaste })');
    check('the catcher detached after handover', handover.early === null,
        JSON.stringify(handover));

    const errs = page.errors();
    console.log(`\npage errors: ${errs.length}`);
    for (const e of errs.slice(0, 5)) console.log('  ! ' + e.text.split('\n')[0]);
    console.log(`\n${pass} passed, ${fail} failed`);
});

process.exit(fail ? 1 : 0);
