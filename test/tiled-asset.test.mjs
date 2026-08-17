/* Recognising a tiled screen and reading its shape off the files.
 *
 * The shape is derived rather than looked up, which is only defensible if the
 * derivation is measured against every such file two real projects ship. That
 * is what the second half does: if `layoutFrom` gets the palette row wrong the
 * assembled picture comes out in someone else's colours, and it will say so
 * here rather than in a screenshot three days later.
 *
 *   node test/tiled-asset.test.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, layoutFrom, offscreenColumns } from '../src/js/tiled-asset.js';
import { parseTilemap } from '../src/js/battle-scene.js';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('tiled assets');

/* ── pairing ─────────────────────────────────────────────────────────────── */
{
    const d = describe('graphics/map_preview/wisp_forest/tiles.png',
        ['tiles.png', 'map.bin', 'palette.pal']);
    check('a tiles.png beside a map.bin is a screen',
        d && d.mapPath === 'graphics/map_preview/wisp_forest/map.bin' &&
        d.palettes[0] === 'graphics/map_preview/wisp_forest/palette.pal', JSON.stringify(d));

    const old = describe('graphics/map_preview/mt_moon/tiles.png', ['tiles.png', 'tilemap.bin']);
    check('the older name for the tilemap counts too, palette or no palette',
        old && /tilemap\.bin$/.test(old.mapPath) && old.palettes.length === 0, JSON.stringify(old));

    /* The expansion's stadium is one picture with nine palettes beside it, one
       per Elite Four member. Answering with the alphabetically first would be
       inventing a fact; the caller has to be given the choice. */
    const stadium = describe('graphics/battle_environment/stadium/tiles.png',
        ['tiles.png', 'map.bin', 'sidney.pal', 'phoebe.pal', 'glacia.pal', 'drake.pal']);
    check('a screen with several palettes offers all of them',
        stadium && stadium.palettes.length === 4, JSON.stringify(stadium && stadium.palettes));

    // altaria_tiles.png is served by altaria.pal, not altaria_palette.pal.
    const bare = describe('graphics/map_preview/emerald_peak/altaria_tiles.png',
        ['altaria_tiles.png', 'altaria_map.bin', 'altaria.pal', 'rayquaza.pal']);
    check('and the one named for this screen comes first',
        bare && /altaria\.pal$/.test(bare.palettes[0]) && bare.palettes.length === 2,
        JSON.stringify(bare && bare.palettes));

    const stemmed = describe('graphics/map_preview/valoon_reserve/metapod_tiles.png',
        ['metapod_tiles.png', 'metapod_map.bin', 'corsola_map.bin', 'palette.pal']);
    check('several screens in one folder pair by their stem, not by the folder',
        stemmed && /metapod_map\.bin$/.test(stemmed.mapPath), JSON.stringify(stemmed));

    check('a lone PNG is not a screen',
        describe('graphics/pokemon/bulbasaur/anim_front.png', ['anim_front.png', 'normal.pal']) === null);
    check('and neither is a tiles.png with nothing to arrange it',
        describe('graphics/x/tiles.png', ['tiles.png', 'palette.pal']) === null);

    /* The tiles.png convention covers about fifty screens. The rest of the game
       names both halves after the screen instead, and supporting only the first
       habit left the bag, the pokédex, the intro and the frontier unreachable. */
    const bag = describe('graphics/bag/menu.png', ['menu.png', 'menu.bin', 'menu_male.pal', 'menu_female.pal']);
    check('a PNG named for its screen pairs with the .bin of the same name',
        bag && bag.mapPath === 'graphics/bag/menu.bin' && bag.palettes.length === 2,
        JSON.stringify(bag));

    const frame = describe('graphics/picture_frame/cool.png',
        ['cool.png', 'cool_map.bin', 'cute.png', 'cute_map.bin', 'bg.pal']);
    check('and the _map suffix pairs too, without swallowing the neighbour',
        frame && frame.mapPath === 'graphics/picture_frame/cool_map.bin' &&
        frame.palettes[0] === 'graphics/picture_frame/bg.pal', JSON.stringify(frame));

    check('a PNG whose folder holds only other screens’ tilemaps is not one',
        describe('graphics/picture_frame/bg.png',
            ['bg.png', 'cool.png', 'cool_map.bin', 'cute.png', 'cute_map.bin']) === null);

    /* One sheet, several tilemaps: the title screen's regigigas is six frames
       of an animation over one `tiles.png`, and `valoon_reserve` is four map
       previews sharing one. Nothing in the names says which .bin goes with
       which sheet — so this only fires when the folder holds a single PNG, and
       then there is nothing to be wrong about. */
    const frames = describe('graphics/title_screen/regigigas/tiles.png',
        ['tiles.png', 'frame0.bin', 'frame1.bin', 'frame2.bin', '0.pal', '1.pal']);
    check('a sheet serving several tilemaps offers all of them, in order',
        frames && frames.maps.length === 3 && /frame0\.bin$/.test(frames.mapPath),
        JSON.stringify(frames && frames.maps));

    check('but not when the folder holds more than one sheet to choose between',
        describe('graphics/pokedex/list.png',
            ['list.png', 'other.png', 'cry_screen.bin', 'info_screen.bin']) === null);

    /* A set is the evidence. One .bin beside one PNG is equally the shape of a
       genuine pair and of two unrelated files sharing a folder. */
    check('and not for a single unnamed tilemap, which proves nothing',
        describe('graphics/x/sheet.png', ['sheet.png', 'something_else.bin']) === null);

    /* A neighbour's palette is not this screen's palette. Gaia's battle
       animation backgrounds all share one folder holding 61 .pal files, and
       about half those screens keep their colours in the PNG instead — the
       build extracts them with INCGFX_U16(".../aurora.png", ".gbapal"). Taking
       the alphabetically first opened `aurora` in `aeroblast`'s colours, which
       looks like art rather than like a fault. */
    const anim = describe('graphics/battle_anims/backgrounds/aurora.png',
        ['aurora.png', 'aurora.bin', 'aeroblast.pal', 'aeroblast_tiles.png', 'aura_sphere.pal']);
    check('a screen with no palette of its own says so rather than borrowing one',
        anim && anim.named === 0, JSON.stringify(anim));
    check('though the folder’s palettes are still listed, after the named ones',
        anim.palettes.length === 2, JSON.stringify(anim.palettes));

    const ownPal = describe('graphics/battle_anims/backgrounds/aeroblast_tiles.png',
        ['aeroblast_tiles.png', 'aeroblast_map.bin', 'aeroblast.pal', 'aura_sphere.pal']);
    check('and one that does have its own gets it, marked as evidence',
        ownPal && ownPal.named === 1 && /aeroblast\.pal$/.test(ownPal.palettes[0]),
        JSON.stringify(ownPal && ownPal.palettes));

    /* Case is not a reliable signal on the filesystems these repos live on, but
       the name that goes back out has to be the one really there. */
    const cased = describe('graphics/x/Menu.png', ['Menu.png', 'MENU.BIN']);
    check('matching ignores case but the path answers with the real name',
        cased && cased.mapPath === 'graphics/x/MENU.BIN', JSON.stringify(cased));
}

/* ── shape ───────────────────────────────────────────────────────────────── */
{
    // 32×20 of tile 1 at bank 13, except a right-hand strip of blank bank 0.
    const map = new Uint16Array(640);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 32; x++) {
        map[y * 32 + x] = x < 30 ? (1 | (13 << 12)) : (0 | (0 << 12));
    }
    const l = layoutFrom(map);
    check('a 640-entry map is a 256×160 picture',
        l && l.width === 256 && l.height === 160 && l.stride === 32, JSON.stringify(l));
    check('and the blank off-screen strip does not drag the palette row to zero',
        l.paletteBase === 13, String(l.paletteBase));

    /* Only a wholly empty entry is ignored. A cell naming tile 0 from a real
       bank is real art, and treating it as blank read the palette a row too
       high — which looks like the picture opening in someone else's colours. */
    const zeroTile = new Uint16Array(640);
    for (let i = 0; i < 640; i++) zeroTile[i] = 0 | (13 << 12);
    zeroTile[5] = 1 | (14 << 12);
    check('a cell using tile 0 from a real bank still counts as art',
        layoutFrom(zeroTile).paletteBase === 13, String(layoutFrom(zeroTile).paletteBase));

    const tall = layoutFrom(new Uint16Array(2048).fill(1 | (2 << 12)));
    check('a two-screenblock map is still one screen tall',
        tall && tall.height === 160 && tall.paletteBase === 2, JSON.stringify(tall));

    check('the columns the hardware never shows are named',
        JSON.stringify(offscreenColumns(l)) === '{"x":240,"width":16}',
        JSON.stringify(offscreenColumns(l)));
    check('and a 240-wide screen has none',
        offscreenColumns({ width: 240 }) === null);
    check('a map too small to be a screen is refused rather than guessed at',
        layoutFrom(new Uint16Array(4)) === null);

    /* Roughly a fifth of the .bin files under graphics/ are not screen maps at
       all — a 10×10 window, a strip of animation frames. They pair by name just
       as convincingly, so the shape is the only thing that tells them apart. */
    check('and so is one that is not a whole number of rows',
        layoutFrom(new Uint16Array(360)) === null);

    /* What the sheet beside it has to supply. A pairing found by filename is a
       guess until these two are checked against the real files. */
    const demands = new Uint16Array(640);
    demands[0] = 40 | (2 << 12);
    demands[1] = 5 | (4 << 12);
    const dl = layoutFrom(demands);
    check('the map says how many tiles it needs and how many banks it spans',
        dl.tiles === 41 && dl.banks === 3 && dl.paletteBase === 2, JSON.stringify(dl));
    check('an entirely blank map demands nothing',
        layoutFrom(new Uint16Array(640)).tiles === 0);
}

/* ── against real projects ───────────────────────────────────────────────── */
function sweep(label, dir, expectBase, mainOnly) {
    if (!existsSync(dir)) {
        console.log(`  --   no ${label} beside the repo; skipping`);
        return;
    }
    const found = [], wrong = [], noPal = [];
    for (const name of readdirSync(dir)) {
        const folder = join(dir, name);
        let files;
        try { files = readdirSync(folder); } catch { continue; }
        for (const f of files.filter(f => /tiles\.png$/.test(f))) {
            const d = describe(`${name}/${f}`, files);
            if (!d) continue;
            found.push(d);
            /* `anim_tiles.png` beside a battle background is the intro-slide
               overlay, not the scenery — a real screen, but drawn over the top
               at whatever palette row suits it. Recognising it is right;
               expecting the scenery's row from it is not. */
            if (mainOnly && d.stem) continue;
            const l = layoutFrom(parseTilemap(readFileSync(join(folder, d.mapPath.split('/').pop()))));
            if (!l || l.paletteBase !== expectBase || l.height !== 160) wrong.push({ file: `${name}/${f}`, got: l });
            if (!l) continue;
            if (!d.palettes.length && !/tilemap\.bin$/.test(d.mapPath)) noPal.push(`${name}/${f}`);
        }
    }
    console.log(`       ${label}: ${found.length} screens found`);
    check(`every ${label} is recognised and lands on palette row ${expectBase}`,
        found.length >= 10 && wrong.length === 0, JSON.stringify(wrong.slice(0, 4)));
    check(`and every ${label} finds its colours, in a .pal or in the PNG`,
        noPal.length === 0, JSON.stringify(noPal.slice(0, 4)));
}

sweep('Gaia map preview', join(process.cwd(), '../pokegaia/graphics/map_preview'), 13, false);
sweep('battle background', join(process.cwd(), '../pokeemerald-expansion/graphics/battle_environment'), 2, true);

/* One flat folder, many screens, many palettes — the arrangement that broke
   pairing by proximity. Every .pal named here belongs to *some* screen, so a
   wrong answer is indistinguishable from a right one by eye. */
{
    const dir = join(process.cwd(), '../pokegaia/graphics/battle_anims/backgrounds');
    if (!existsSync(dir)) {
        console.log('  --   no Gaia battle animation backgrounds beside the repo; skipping');
    } else {
        const files = readdirSync(dir);
        const screens = [], borrowed = [];
        for (const f of files.filter(f => /\.png$/i.test(f))) {
            const d = describe(`x/${f}`, files);
            if (!d) continue;
            screens.push(d);
            /* The one thing that must never happen: a named palette that is not
               this screen's. Its stem has to be a prefix of the screen's. */
            for (let i = 0; i < d.named; i++) {
                const pal = d.palettes[i].split('/').pop().replace(/\.pal$/i, '');
                const stem = f.replace(/\.png$/i, '').replace(/_?tiles$/i, '');
                if (pal !== stem && pal !== 'palette' && pal !== 'bg') borrowed.push(`${f} -> ${pal}.pal`);
            }
        }
        console.log(`       Gaia battle anim backgrounds: ${screens.length} screens, ${files.filter(f => /\.pal$/i.test(f)).length} palettes in one folder`);
        check('no screen in a crowded folder is given a neighbour’s palette',
            screens.length >= 40 && borrowed.length === 0, JSON.stringify(borrowed.slice(0, 5)));
        check('and the ones that keep their colours in the PNG say they have none',
            screens.some(d => d.named === 0) && screens.some(d => d.named === 1),
            JSON.stringify(screens.slice(0, 3).map(d => [d.tilesPath, d.named])));
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
