/* Nothing that only a hidden panel needs may be fetched during boot.
 *
 * The paint brush sidebar's preset grid used to be built on DOMContentLoaded.
 * Building it fetches every preset's custom tip PNG — ~570kB across a dozen
 * files — decodes each one, and runs a full-resolution luminance-to-alpha pass
 * over it, all to draw 66px thumbnails into a panel parked at left:-296px
 * until someone picks the Paint Brush tool. That landed squarely on the main
 * thread in the first moments after launch, which is exactly when the app is
 * asked to accept a paste or open a file, and it made both feel stuck.
 *
 * The grid now builds on first intersection, so the two halves are tested
 * separately: boot must stay clean, and opening the panel must still produce
 * a fully populated grid — deferring work is only correct if the work still
 * happens when it is actually needed.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

/* Brush tips are the payload under test; toolbar icons are legitimately
 * visible at boot and are left alone. */
const PROBE = `
    const res = performance.getEntriesByType('resource')
        .filter(r => r.name.includes('/brushes/'));
    return {
        count: res.length,
        kb: Math.round(res.reduce((a, r) => a + r.transferSize, 0) / 1024),
        tiles: document.querySelectorAll('.pb-brush-tile').length,
        canvases: document.querySelectorAll('.pb-brush-tile canvas').length
    };
`;

await withPage(async (page) => {
    /* Reload so the measurement covers a fresh document — withPage() has
     * already booted once by the time this runs. */
    await page.reloadWith('');
    await new Promise(r => setTimeout(r, 1200));

    const boot = await page.run(PROBE);
    check('no brush tip images fetched at boot', boot.count === 0,
        `${boot.count} requests, ${boot.kb}kB`);
    check('no preset tiles built at boot', boot.tiles === 0, `${boot.tiles} tiles`);

    /* Picking the tool slides the sidebar to left:0, which is what the
     * observer is watching for. */
    await page.run(`PaintApp.setTool('paintbrush'); return 1;`);
    await new Promise(r => setTimeout(r, 2000));

    const open = await page.run(PROBE);
    check('opening the panel builds the grid', open.tiles > 0, `${open.tiles} tiles`);
    check('every tile gets a rendered preview', open.canvases === open.tiles,
        `${open.canvases} canvases for ${open.tiles} tiles`);
    check('and the tip images load then', open.count > 0,
        `${open.count} requests, ${open.kb}kB`);

    /* Re-entering the tool must not rebuild — the observer disconnects on the
     * first hit, so the tile count stays put rather than doubling. */
    await page.run(`PaintApp.setTool('pencil'); return 1;`);
    await new Promise(r => setTimeout(r, 300));
    await page.run(`PaintApp.setTool('paintbrush'); return 1;`);
    await new Promise(r => setTimeout(r, 800));
    const again = await page.run(PROBE);
    check('reopening does not duplicate tiles', again.tiles === open.tiles,
        `${open.tiles} then ${again.tiles}`);

    const errs = page.errors();
    console.log(`\npage errors: ${errs.length}`);
    for (const e of errs.slice(0, 5)) console.log('  ! ' + e.text.split('\n')[0]);
    console.log(`\n${pass} passed, ${fail} failed`);
});

process.exit(fail ? 1 : 0);
