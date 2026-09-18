/* Saving a flat-coloured picture writes a palette PNG, not a 32-bit one.
 *
 * The browser's canvas encoder always writes four bytes a pixel however few
 * colours are on screen, which is why a CDPaint save came out several times
 * larger than the same picture saved from another editor. pngBlobFromCanvas
 * indexes the picture instead when its colours fit in a palette.
 *
 * The whole point is that this costs nothing: these tests check the file got
 * smaller AND that every pixel survives the round trip unchanged, because an
 * encoder that shrinks files by altering colours would be worse than useless
 * on sprite work.
 */
import { withPage } from '../browser.mjs';
import { readIndexedPng } from '../png-read.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

await withPage(async (page) => {
    /* Paint a picture out of a handful of flat colours, one of them fully
     * transparent, then encode it both ways. */
    const flat = await page.eval(`(async () => {
        const W = 64, H = 64;
        PaintApp.layerMgr.collapseToBase({ fresh: true });
        PaintApp.setSize(W, H);
        const c = PaintApp.ctx;
        c.clearRect(0, 0, W, H);
        const colours = ['#ff0000', '#0080ff', '#202020'];
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const pick = (x / 7 + y % 5) | 0;
                if (pick % 4 === 2) continue;          // leave it transparent
                c.fillStyle = colours[pick % 3];
                c.fillRect(x, y, 1, 1);
            }
        }
        PaintApp.compositeLayers && PaintApp.compositeLayers();

        const want = Array.from(PaintApp.ui.cMain.getContext('2d')
            .getImageData(0, 0, W, H).data);
        const ours = await PaintApp.pngBlobFromCanvas(PaintApp.ui.cMain);
        const theirs = await new Promise(r => PaintApp.ui.cMain.toBlob(r, 'image/png'));
        return {
            want,
            ours: Array.from(new Uint8Array(await ours.arrayBuffer())),
            theirSize: theirs.size
        };
    })()`);

    const png = readIndexedPng(Uint8Array.from(flat.ours));
    check('a flat picture encodes as an indexed PNG', png !== null);
    check('the file got smaller than the browser encoder wrote',
        flat.ours.length < flat.theirSize,
        `${flat.theirSize} -> ${flat.ours.length} bytes`);

    if (png) {
        /* Rebuild RGBA from palette + tRNS and compare against what was painted. */
        let same = true, firstBad = null;
        for (let i = 0; i < png.indices.length && same; i++) {
            const idx = png.indices[i];
            const got = [
                png.palette[idx * 3], png.palette[idx * 3 + 1], png.palette[idx * 3 + 2],
                png.trns && idx < png.trns.length ? png.trns[idx] : 255
            ];
            for (let ch = 0; ch < 4; ch++) {
                /* A fully transparent pixel's colour channels are not visible and
                   the encoder is free to keep whichever it was given, so only the
                   alpha has to match there. */
                if (got[3] === 0 && flat.want[i * 4 + 3] === 0) break;
                if (got[ch] !== flat.want[i * 4 + ch]) {
                    same = false; firstBad = `pixel ${i} channel ${ch}: ${got[ch]} != ${flat.want[i * 4 + ch]}`;
                    break;
                }
            }
        }
        check('every pixel survives the round trip', same, firstBad);
        check('a small palette uses fewer than 8 bits per pixel', png.depth < 8, `depth ${png.depth}`);
    }

    /* Too many colours to index: it must hand back the browser's own PNG
     * rather than crushing the picture into 256 colours. */
    const rich = await page.eval(`(async () => {
        const W = 64, H = 64;
        PaintApp.setSize(W, H);
        const c = PaintApp.ctx;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            c.fillStyle = 'rgb(' + x * 4 + ',' + y * 4 + ',' + ((x + y) * 2) + ')';
            c.fillRect(x, y, 1, 1);
        }
        PaintApp.compositeLayers && PaintApp.compositeLayers();
        const indexed = await PaintApp.indexedPngFromCanvas(PaintApp.ui.cMain);
        const blob = await PaintApp.pngBlobFromCanvas(PaintApp.ui.cMain);
        return { indexed, type: blob.type, size: blob.size };
    })()`);
    check('a full-colour picture is not indexed', rich.indexed === null);
    check('and still comes back as a PNG', rich.type === 'image/png' && rich.size > 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
