/* Wand-select, Ctrl+X to cut, then undo once — the selection should come back.
 *
 * Repro: wand-select a region, cut it (Ctrl+X → execCut(), which copies then
 * calls deleteSelection()). A single undo should restore not just the pixels
 * but the active floating selection itself (marching ants, region, source),
 * so the user can immediately keep working with it instead of losing it and
 * having to re-select from scratch.
 *
 * deleteSelection() used to call collapseSelectionCutStep() after saving its
 * own "cut finalized" history entry. That collapse spliced out the PRECEDING
 * wand-select's own history entry — the only one carrying the wandSelSnap a
 * wand/lasso/smart-brush selection needs to reconstruct itself on undo — so
 * undo after a cut restored the pixels but left no active selection behind.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

await withPage(async (page) => {
    console.log('== wand select, cut, undo ==');
    const result = await page.run(`
        PaintApp.config.width = 60; PaintApp.config.height = 20;
        const ctx = PaintApp.ctx;
        const imgData = ctx.createImageData(60, 20);
        const d = imgData.data;
        for (let y = 0; y < 20; y++) {
            for (let x = 0; x < 60; x++) {
                const i = (y*60+x)*4;
                let r,g,b;
                if (x < 20) { r=255; g=0; b=0; }
                else if (x < 40) { r=0; g=255; b=0; }
                else { r=0; g=0; b=255; }
                d[i]=r; d[i+1]=g; d[i+2]=b; d[i+3]=255;
            }
        }
        ctx.putImageData(imgData, 0, 0);
        PaintApp.saveState();

        PaintApp.setTool('wand');
        PaintApp.magicWandSelect(10, 10, 0, 'replace', null, true);
        const selBeforeCut = { x: PaintApp.state.selection.x, y: PaintApp.state.selection.y, w: PaintApp.state.selection.w, h: PaintApp.state.selection.h, source: PaintApp.state.selection.source };
        const selPixelBeforeCut = Array.from(PaintApp.state.selection.canvas.getContext('2d').getImageData(0, 0, 1, 1).data);

        return PaintApp.execCut().then(() => {
            const selAfterCut = PaintApp.state.selection;

            PaintApp.undo();
            const sel = PaintApp.state.selection;
            const selAfterUndo = sel ? { x: sel.x, y: sel.y, w: sel.w, h: sel.h, source: sel.source } : null;
            const selPixelAfterUndo = sel ? Array.from(sel.canvas.getContext('2d').getImageData(0, 0, 1, 1).data) : null;

            return { selBeforeCut, selAfterCut, selAfterUndo, selPixelBeforeCut, selPixelAfterUndo };
        });
    `);
    console.log('  ' + JSON.stringify(result, null, 1).replace(/\n/g, '\n  '));

    check('cut removed the selection', result.selAfterCut === null, JSON.stringify(result.selAfterCut));
    check('undo after cut restores an active selection', result.selAfterUndo !== null, JSON.stringify(result.selAfterUndo));
    check('undo restores the same selection region that was cut',
        result.selAfterUndo && result.selAfterUndo.x === result.selBeforeCut.x && result.selAfterUndo.w === result.selBeforeCut.w,
        JSON.stringify(result.selAfterUndo));
    check('undo restores the wand source tag', result.selAfterUndo && result.selAfterUndo.source === 'wand', JSON.stringify(result.selAfterUndo));
    check('undo restores the cut content (selection canvas pixel matches original)',
        result.selPixelAfterUndo && result.selPixelAfterUndo[0] === result.selPixelBeforeCut[0] && result.selPixelAfterUndo[1] === result.selPixelBeforeCut[1] && result.selPixelAfterUndo[2] === result.selPixelBeforeCut[2],
        JSON.stringify({ before: result.selPixelBeforeCut, after: result.selPixelAfterUndo }));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
