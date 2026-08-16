/* Turning a picture back into tiles + tilemap.
 *
 * The claim: an artist can edit the assembled picture and CDPaint can put it
 * back into the three files the build wants, without Tilemap Studio. The way to
 * be sure is a round trip against real projects — take a shipped screen apart,
 * put it back together, and require the picture to be identical pixel for
 * pixel. A retiler that drops a flip bit or picks the wrong bank produces
 * something that still looks like scenery, so eyeballing it proves nothing.
 *
 *   node test/retile.test.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { retile, tilemapBytes, toJascPal } from '../src/js/retile.js';
import { assembleIndices, parseTilemap, parseJascPal } from '../src/js/battle-scene.js';
import { readIndexedPng } from './png-read.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('retile');

/* ── the basics, on something small enough to reason about ───────────────── */
{
    // 32×16: four cells across, two down. Cell (0,0) is a gradient; (1,0) is
    // that gradient mirrored; (2,0) and everything else is flat colour 1.
    const W = 32, H = 16;
    const px = new Uint8Array(W * H).fill(1);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        px[y * W + x] = 1 + (x % 4);
        px[y * W + (15 - x)] = 1 + (x % 4);   // cell 1 is cell 0 mirrored
    }

    const r = retile(px, W, H, { paletteBase: 13 });
    check('a picture comes back as a sheet, a grid and no complaints',
        r && r.map.length === 8 && r.conflicts.length === 0, JSON.stringify(r && r.conflicts));
    check('repeated cells are stored once',
        r.tileCount === 2, `${r.tileCount} tiles for 8 cells`);
    check('and a mirrored repeat costs a flip bit rather than a tile',
        (r.map[1] & 0x3ff) === (r.map[0] & 0x3ff) && (r.map[1] & 0x400) !== 0,
        `entry0 ${r.map[0].toString(16)}, entry1 ${r.map[1].toString(16)}`);
    check('the palette row the project loads into is written into every entry',
        [...r.map].every(e => ((e >> 12) & 0xf) === 13),
        [...r.map].map(e => (e >> 12) & 0xf).join(','));

    const back = assembleIndices(r.tiles, r.map, { width: W, height: H, paletteBase: 13, mapStride: 4 });
    check('and the whole thing reassembles into what went in',
        back && back.indices.every((v, i) => v === px[i]));

    // Turning flips off has to cost tiles rather than change the picture.
    const noFlip = retile(px, W, H, { paletteBase: 13, allowFlips: false });
    const backNoFlip = assembleIndices(noFlip.tiles, noFlip.map,
        { width: W, height: H, paletteBase: 13, mapStride: 4 });
    check('without flips it uses more tiles and draws the same picture',
        noFlip.tileCount === 3 && backNoFlip.indices.every((v, i) => v === px[i]),
        `${noFlip.tileCount} tiles`);
}

/* ── the rule a paint program cannot enforce ─────────────────────────────── */
{
    /* One 8×8 cell may only use colours from one 16-colour bank. Nothing stops
       an artist blending across that line, and the error Tilemap Studio gives
       for it names neither the cell nor the colour — which is the whole reason
       this reports a position. */
    const px = new Uint8Array(8 * 8).fill(1);
    px[9] = 0x12;                      // bank 1, colour 2 in a bank 0 cell
    const r = retile(px, 8, 8, { paletteBase: 13 });
    check('a cell drawing from two banks is reported, with where and which',
        r.conflicts.length === 1 && r.conflicts[0].x === 0 && r.conflicts[0].y === 0 &&
        r.conflicts[0].banks.join(',') === '0,1', JSON.stringify(r.conflicts));
    check('and the majority bank is the one kept, so the output is still usable',
        r.conflicts[0].kept === 0 && ((r.map[0] >> 12) & 0xf) === 13,
        JSON.stringify(r.conflicts[0]));

    /* Colour 0 is transparent in every bank, so it says nothing about which
       bank a cell belongs to. Counting it made an empty cell conflict with
       whichever bank happened to be listed first. */
    const empty = new Uint8Array(8 * 8);
    for (let i = 0; i < 32; i++) empty[i] = 0x20;   // bank 2, colour 0
    empty[40] = 0x35;                                // bank 3, a real colour
    const e = retile(empty, 8, 8, { paletteBase: 0 });
    check('a transparent pixel does not drag a cell into another bank',
        e.conflicts.length === 0 && ((e.map[0] >> 12) & 0xf) === 3,
        JSON.stringify(e.conflicts) + ' bank ' + ((e.map[0] >> 12) & 0xf));
}

/* ── the files that go on disk ───────────────────────────────────────────── */
{
    const bytes = tilemapBytes(Uint16Array.from([0xd000, 0x0401]));
    check('the grid is written little-endian, as the build reads it',
        bytes.length === 4 && bytes[0] === 0x00 && bytes[1] === 0xd0 &&
        bytes[2] === 0x01 && bytes[3] === 0x04, [...bytes].join(','));
    const pal = toJascPal([{ r: 1, g: 2, b: 3 }, { r: 255, g: 0, b: 0 }]);
    check('a palette goes back out as the JASC text the project keeps',
        parseJascPal(pal).length === 2 && /^JASC-PAL\r\n0100\r\n2\r\n/.test(pal),
        JSON.stringify(pal.slice(0, 24)));
}

/* ── against real projects ───────────────────────────────────────────────── */
function roundTrip(label, tilesPath, mapPath, opts) {
    const tiles = readIndexedPng(readFileSync(tilesPath));
    const map = parseTilemap(readFileSync(mapPath));
    const before = assembleIndices({ indices: tiles.indices, width: tiles.width }, map, opts);
    if (!before) return { label, error: 'did not assemble' };

    const r = retile(before.indices, opts.width, opts.height, { paletteBase: opts.paletteBase });
    if (!r) return { label, error: 'did not retile' };
    const after = assembleIndices(r.tiles, r.map,
        Object.assign({}, opts, { mapStride: opts.width / 8 }));
    if (!after) return { label, error: 'did not reassemble' };

    /* Compare the picture, not the bookkeeping. Colour 0 is transparent in
       every bank, so a cell with nothing visible in it can be tagged bank 14 in
       the shipped file and bank 13 here and paint exactly the same nothing.
       sabulo_tower has one such cell. Requiring the tag to match as well would
       be asserting a fact about Tilemap Studio's habits, not about the art. */
    const visible = (v) => (v & 0xf) === 0 ? 0 : v;
    let diff = 0;
    for (let i = 0; i < before.indices.length; i++) {
        if (visible(before.indices[i]) !== visible(after.indices[i])) diff++;
    }
    const wasDistinct = new Set();
    for (let i = 0; i < opts.mapStride * (opts.height / 8); i++) wasDistinct.add(map[i] & 0x3ff);
    return { label, diff, tiles: r.tileCount, was: wasDistinct.size, conflicts: r.conflicts.length };
}

const GAIA = join(process.cwd(), '../pokegaia');
if (!existsSync(join(GAIA, 'graphics/map_preview'))) {
    console.log('  --   no pokegaia beside the repo; skipping the map preview round trip');
} else {
    const dir = join(GAIA, 'graphics/map_preview');
    const opts = { width: 256, height: 160, paletteBase: 13, mapStride: 32 };
    const results = [], skipped = [];
    for (const name of readdirSync(dir)) {
        /* Most folders hold one preview called tiles.png + map.bin, but some
           hold several named for the Pokémon on them — metapod_tiles.png beside
           metapod_map.bin. Pair by prefix rather than assuming the common case,
           or a third of the project goes untested. */
        const files = readdirSync(join(dir, name));
        for (const f of files.filter(f => /tiles\.png$/.test(f))) {
            const stem = f.replace(/tiles\.png$/, '');
            const map = [stem + 'map.bin', stem + 'tilemap.bin'].find(m => files.includes(m));
            if (!map) { skipped.push(`${name}/${f} (no tilemap beside it)`); continue; }
            results.push(roundTrip(`${name}/${stem || ''}`, join(dir, name, f), join(dir, name, map), opts));
        }
    }
    const bad = results.filter(r => r.error || r.diff !== 0);
    const saved = results.reduce((n, r) => n + (r.was - r.tiles), 0);
    console.log(`       ${results.length} map previews round-tripped, ${saved} tiles saved against what shipped`);
    if (skipped.length) console.log(`       skipped ${skipped.length}: ${skipped.join(', ')}`);
    check('every shipped map preview survives a round trip pixel for pixel',
        results.length >= 30 && bad.length === 0,
        `${results.length} tried; ` + JSON.stringify(bad.slice(0, 3)));
    check('and none of them needed a colour moved between banks',
        results.every(r => r.conflicts === 0),
        JSON.stringify(results.filter(r => r.conflicts).slice(0, 3)));
    /* Not a promise of a smaller sheet — the point is to be no worse. Tilemap
       Studio does not look for mirrored repeats, so mirror-heavy art comes out
       ahead and everything else comes out level. */
    check('the sheet it produces is never larger than the one that shipped',
        results.every(r => r.tiles <= r.was),
        JSON.stringify(results.filter(r => r.tiles > r.was).slice(0, 3)));
}

const EXP = join(process.cwd(), '../pokeemerald-expansion');
if (!existsSync(join(EXP, 'graphics/battle_environment'))) {
    console.log('  --   no expansion beside the repo; skipping the battle background round trip');
} else {
    /* The same code against the other tiled screen in the project, at a
       different size and a different palette row — a retiler that has quietly
       hardcoded either would pass the map previews and fail here. */
    const dir = join(EXP, 'graphics/battle_environment');
    const opts = { width: 240, height: 160, paletteBase: 2, mapStride: 32 };
    const results = [];
    for (const name of readdirSync(dir)) {
        const tiles = join(dir, name, 'tiles.png'), map = join(dir, name, 'map.bin');
        if (existsSync(tiles) && existsSync(map)) results.push(roundTrip(name, tiles, map, opts));
    }
    const bad = results.filter(r => r.error || r.diff !== 0);
    console.log(`       ${results.length} battle backgrounds round-tripped`);
    check('battle backgrounds round-trip too, at their own size and palette row',
        results.length >= 8 && bad.length === 0, JSON.stringify(bad.slice(0, 3)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
