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
            readBytes: (p) => files[p] ? Promise.resolve(files[p]) : Promise.reject(new Error(p)),
            /* Stubbed at the same seam the real one lives at, so this covers
               both modes — PokeProject.writeBytes is Rust on the desktop and a
               file handle in the browser, and neither is reachable from here. */
            writeBytes: (path, bytes) => {
                window.__written.push({ path, bytes: Array.from(bytes) });
                return Promise.resolve();
            }
        });
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
        saved.paths.every(p => p.indexOf('graphics/map_preview/x/') === 0),
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

    /* A battle background's map is two screenblocks: the picture, then the
       intro slide. Only the picture is on the canvas, so a save that wrote back
       what it could see would delete the slide — and one that renumbered the
       tiles would leave the slide pointing at the wrong art. */
    const twoBlocks = [];
    for (let i = 0; i < 2048; i++) {
        const e = i < 640 ? (0 | (13 << 12)) : (1 | (14 << 12));   // tail names tile 1
        twoBlocks.push(e & 0xff, (e >> 8) & 0xff);
    }
    const tail = await page.eval(`(async () => {
        ${setup}
        files['graphics/map_preview/x/map.bin'] = new Uint8Array(${JSON.stringify(twoBlocks)});
        await window.TiledScreen.open(desc, { path: 'C:/proj/graphics/map_preview/x/tiles.png' });
        window.__written = [];
        PaintApp.spriteIndices[0] = 3;                 // an edit inside the picture
        await PaintApp.saveFile();
        const map = window.__written.find(f => /map\\.bin$/.test(f.path));
        const at = (i) => map.bytes[i * 2] | (map.bytes[i * 2 + 1] << 8);

        // Tile 1 of the sheet that was just written — the tile the untouched
        // half of the map still points at.
        const sheet = window.__written.find(f => /tiles\\.png$/.test(f.path));
        const meta = PaintApp.parsePngPalette(new Uint8Array(sheet.bytes));
        const px = await PaintApp.decodePngIndices(meta);
        const tileAt = (n) => {
            const across = meta.width / 8, ox = (n % across) * 8, oy = ((n / across) | 0) * 8;
            const out = [];
            for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out.push(px[(oy + y) * meta.width + ox + x] & 0xf);
            return out;
        };
        return {
            len: map.bytes.length, tailEntry: at(1024), lastEntry: at(2047),
            tile1: tileAt(1), tiles: (meta.width / 8) * (meta.height / 8)
        };
    })()`);

    check('a two-screenblock map is written back at its full size',
        tail.len === 4096, String(tail.len));
    check('the half the canvas never showed is returned untouched',
        tail.tailEntry === (1 | (14 << 12)) && tail.lastEntry === (1 | (14 << 12)),
        `${tail.tailEntry.toString(16)} / ${tail.lastEntry.toString(16)}`);
    /* The reference, not just the bytes. Renumbering the picture's tiles would
       leave this half of the map addressing whatever landed on id 1. */
    check('and tile 1 still holds what that half expects to find there',
        tail.tile1.every(v => v === 2), JSON.stringify(tail.tile1.slice(0, 8)));
    check('the edit appended a tile rather than overwriting one',
        tail.tiles > 2, String(tail.tiles));

    /* Pairing is a guess made from two filenames. Most of the project names
       both halves after the screen, so a PNG that merely shares a name with a
       .bin now gets offered — and in these repos that PNG is quite often a
       reference picture the tilemap was traced from, not its sheet. */
    const wrongPair = [];
    for (let i = 0; i < 640; i++) { const e = 900 | (13 << 12); wrongPair.push(e & 0xff, e >> 8); }
    const mismatch = await page.eval(`(async () => {
        ${setup}
        files['graphics/map_preview/x/map.bin'] = new Uint8Array(${JSON.stringify(wrongPair)});
        const said = [];
        const realToast = window.showToast;
        window.showToast = (m, k) => { said.push(m); };
        const ok = await window.TiledScreen.open(desc, {});
        window.showToast = realToast;
        return { ok, said };
    })()`);
    check('a map that asks for more tiles than the sheet holds is not opened',
        mismatch.ok === false, JSON.stringify(mismatch.said));
    check('and the reason names both numbers rather than just failing',
        /901/.test(mismatch.said.join(' ')) && /\b2\b/.test(mismatch.said.join(' ')),
        JSON.stringify(mismatch.said));

    /* Half these screens keep no palette file at all — the build extracts the
       colours from the PNG itself, `INCGFX_U16(".../aurora.png", ".gbapal")`.
       Two things went wrong here at once and both looked like art: the folder's
       nearest .pal was preferred over the sheet's own table, so `aurora` opened
       in `aeroblast`'s colours; and the table was read as flat bytes when it is
       {r,g,b} entries, so the fallback that was supposed to save it produced
       black. A six-colour table also has to be padded to a whole bank, as the
       build pads it, or the screen is refused for a shortfall that is not real. */
    const sixColours = [[0, 0, 0], [24, 131, 98], [41, 139, 106], [57, 156, 123], [82, 172, 139], [98, 180, 148]];
    const ownPalPng = Array.from(makePng({
        w: 16, h: 8, depth: 4, palette: sixColours,
        indices: Uint8Array.from({ length: 128 }, (_, i) => ((i % 16) < 8 ? 1 : 4))
    }));
    const flatMap = [];
    for (let i = 0; i < 640; i++) { const e = (i % 2) | (0 << 12); flatMap.push(e & 0xff, e >> 8); }

    const ownPalette = await page.eval(`(async () => {
        const files = {
            'g/aurora.png': new Uint8Array(${JSON.stringify(ownPalPng)}),
            'g/aurora.bin': new Uint8Array(${JSON.stringify(flatMap)}),
            'g/aeroblast.pal': new TextEncoder().encode('JASC-PAL\\r\\n0100\\r\\n2\\r\\n255 0 0\\r\\n0 255 0\\r\\n')
        };
        window.__written = [];
        window.PokeProject = Object.assign({}, window.PokeProject, {
            model: () => ({ root: 'C:/proj', sourceText: new Map() }),
            coordsFor: () => [],
            readBytes: (p) => files[p] ? Promise.resolve(files[p]) : Promise.reject(new Error(p)),
            writeBytes: () => Promise.resolve()
        });
        const desc = window.TiledAsset.describe('g/aurora.png', ['aurora.png', 'aurora.bin', 'aeroblast.pal']);
        const ok = await window.TiledScreen.open(desc, {});
        return { ok, named: desc.named, n: PaintApp.palette.length,
                 c1: PaintApp.palette[1], c4: PaintApp.palette[4] };
    })()`);

    check('a screen with no palette of its own opens on the sheet’s own table',
        ownPalette.ok === true && ownPalette.named === 0, JSON.stringify(ownPalette));
    check('and those are its real colours, not the neighbour’s and not black',
        ownPalette.c1 && ownPalette.c1.r === 24 && ownPalette.c1.g === 131 && ownPalette.c1.b === 98,
        JSON.stringify(ownPalette.c1));
    check('a table shorter than a bank is padded rather than rejected',
        ownPalette.n === 16, String(ownPalette.n));

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
