/* Opening a screen assembled, and saving it back as tiles.
 *
 * The engine either side of this is unit-tested — battle-scene assembles,
 * retile takes apart — so what is checked here is the part only the real app
 * can answer: that clicking a tile sheet puts the *picture* on the canvas with
 * its palette intact, that Ctrl+S writes two files rather than one, and that a
 * picture breaking the one-bank-per-tile rule writes nothing at all.
 *
 * That last one is the reason this exists. A screen saved with a split tile
 * still builds; it comes out in the wrong colours in game, days later.
 *
 *   node test/browser/tiled-screen.mjs
 */
import { withPage } from '../browser.mjs';
import { makePng } from '../png-fixture.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

/* A two-tile sheet: tile 0 is solid colour 1, tile 1 is solid colour 2. Eight
   bpp with a 48-colour table, which is the shape a map preview's sheet has. */
const palette = [];
for (let i = 0; i < 48; i++) palette.push([i * 5, 40 + (i % 3) * 60, 200 - i * 3]);
const tilesPng = Array.from(makePng({
    w: 16, h: 8, depth: 8, palette,
    trns: [0, 255, 255, 255],
    indices: Uint8Array.from({ length: 128 }, (_, i) => ((i % 16) < 8 ? 1 : 2))
}));

/* 32×20 of tile 0 at bank 13, with one cell of tile 1 at bank 14 — so a wrong
   palette base, a lost flip or a dropped bank all show up as one wrong pixel. */
const ODD_X = 3, ODD_Y = 1;
const mapBin = [];
for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 32; x++) {
        const e = (x === ODD_X && y === ODD_Y) ? (1 | (14 << 12)) : (0 | (13 << 12));
        mapBin.push(e & 0xff, (e >> 8) & 0xff);
    }
}
const palText = 'JASC-PAL\r\n0100\r\n48\r\n' +
    palette.map(c => `${c[0]} ${c[1]} ${c[2]}`).join('\r\n') + '\r\n';

await withPage(async (page) => {
    console.log('tiled screens');

    const setup = `
        const files = {
            'graphics/map_preview/x/tiles.png': new Uint8Array(${JSON.stringify(tilesPng)}),
            'graphics/map_preview/x/map.bin': new Uint8Array(${JSON.stringify(mapBin)}),
            'graphics/map_preview/x/palette.pal': new TextEncoder().encode(${JSON.stringify(palText)})
        };
        window.__written = [];
        window.PokeProject = Object.assign({}, window.PokeProject, {
            model: () => ({ root: 'C:/proj', sourceText: new Map() }),
            coordsFor: () => [],
            readBytes: (p) => files[p] ? Promise.resolve(files[p]) : Promise.reject(new Error(p))
        });
        PaintApp.tauriWriteAllowedFile = (path, bytes) => {
            window.__written.push({ path, bytes: Array.from(bytes) });
            return Promise.resolve();
        };
        const desc = window.TiledAsset.describe('graphics/map_preview/x/tiles.png',
            ['tiles.png', 'map.bin', 'palette.pal']);
    `;

    const opened = await page.eval(`(async () => {
        ${setup}
        const ok = await window.TiledScreen.open(desc, { path: 'C:/proj/graphics/map_preview/x/tiles.png' });
        const at = (x, y) => PaintApp.spriteIndices[y * PaintApp.config.width + x];
        return {
            ok,
            w: PaintApp.config.width, h: PaintApp.config.height,
            plain: at(0, 0),
            odd: at(${ODD_X} * 8 + 2, ${ODD_Y} * 8 + 2),
            base: window.TiledScreen.current().layout.paletteBase,
            isOpen: window.TiledScreen.isOpen(),
            palette: PaintApp.palette.length
        };
    })()`);

    check('a tile sheet with a tilemap beside it opens as the picture',
        opened.ok && opened.w === 256 && opened.h === 160, `${opened.w}×${opened.h}`);
    check('the palette row is read off the tilemap, not assumed',
        opened.base === 13, String(opened.base));
    check('a cell drawn from the first bank keeps that bank in its index',
        opened.plain === 1, String(opened.plain));
    check('and a cell drawn from the second is offset by a whole bank',
        opened.odd === 16 + 2, String(opened.odd));
    check('the whole multi-bank palette comes with it',
        opened.palette === 48, String(opened.palette));
    check('and the editor knows this canvas is a screen', opened.isOpen === true);

    /* Saving. The picture is unchanged, so the files written have to describe
       the same screen — same tile count, same grid. */
    const saved = await page.eval(`(async () => {
        window.__written = [];
        await PaintApp.saveFile();
        const w = window.__written;
        const map = w.find(f => /map\\.bin$/.test(f.path));
        const entry = (x, y) => map ? map.bytes[(y * 32 + x) * 2] | (map.bytes[(y * 32 + x) * 2 + 1] << 8) : -1;
        return {
            paths: w.map(f => f.path),
            mapLen: map ? map.bytes.length : 0,
            plainEntry: entry(0, 0),
            oddEntry: entry(${ODD_X}, ${ODD_Y})
        };
    })()`);

    check('saving writes the tiles and the tilemap, not one flattened PNG',
        saved.paths.length === 2 &&
        saved.paths.some(p => /tiles\.png$/.test(p)) &&
        saved.paths.some(p => /map\.bin$/.test(p)),
        JSON.stringify(saved.paths));
    check('both go beside the originals in the project',
        saved.paths.every(p => p.indexOf('C:/proj/graphics/map_preview/x/') === 0),
        JSON.stringify(saved.paths));
    check('the grid it writes is the same 640 cells',
        saved.mapLen === 1280, String(saved.mapLen));
    check('an untouched screen comes back with its palette banks unchanged',
        ((saved.plainEntry >> 12) & 0xf) === 13 && ((saved.oddEntry >> 12) & 0xf) === 14,
        `${saved.plainEntry.toString(16)} / ${saved.oddEntry.toString(16)}`);
    check('and the two cells still point at different tiles',
        (saved.plainEntry & 0x3ff) !== (saved.oddEntry & 0x3ff),
        `${saved.plainEntry & 0x3ff} vs ${saved.oddEntry & 0x3ff}`);

    /* The rule no paint program enforces: one 8×8 cell, one 16-colour bank.
       Painting a colour from another bank into an otherwise clean cell has to
       stop the save dead rather than write a screen that renders wrong. */
    const conflict = await page.eval(`(async () => {
        window.__written = [];
        const seen = [];
        window.TiledScreen.onConflicts = (c) => seen.push(...c);
        PaintApp.spriteIndices[10 * PaintApp.config.width + 10] = 16 + 5;   // bank 1 in a bank 0 cell
        await PaintApp.saveFile();
        return { wrote: window.__written.length, conflicts: seen };
    })()`);

    check('a tile drawing from two banks stops the save',
        conflict.wrote === 0, `${conflict.wrote} files written`);
    check('and the artist is told which tile, by position',
        conflict.conflicts.length === 1 &&
        conflict.conflicts[0].x === 8 && conflict.conflicts[0].y === 8,
        JSON.stringify(conflict.conflicts));

    /* Opening anything else has to hand saving back to the ordinary path, or
       the next Ctrl+S writes a sprite into a map preview's tile sheet. */
    const after = await page.eval(`(async () => {
        const bytes = new Uint8Array(${JSON.stringify(tilesPng)});
        await PaintApp.applyProjectImageBytes(bytes, 'tiles.png', '', [],
            'graphics/pokemon/testmon/anim_front.png');
        return window.TiledScreen.isOpen();
    })()`);
    check('opening another asset stops it being treated as a screen', after === false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
