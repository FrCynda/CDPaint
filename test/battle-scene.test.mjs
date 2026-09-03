/* The battle background reassembled from tiles + tilemap + palette.
 *
 * Fixtures first, then — when a decomp is sitting next to the repo — every
 * environment it declares, rebuilt for real. The synthetic half proves the
 * blitter; only the real half can catch the two things that were actually
 * wrong on the first attempt, which were both facts about the decomp rather
 * than bugs in the loop: the palette lands in BG row 2, and the right-hand half
 * of the tilemap is padding.
 *
 *   node test/battle-scene.test.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import {
    parseJascPal, parseEnvironments, resolveEnvironments,
    renderBackground, parseTilemap, PALETTE_BASE, SCREEN_W, SCREEN_H
} from '../src/js/battle-scene.js';
import { readIndexedPng } from './png-read.mjs';
import { parseDeclarations } from '../src/js/project-model.js';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('battle scene');

/* ── the palette ─────────────────────────────────────────────────────────── */
const pal = parseJascPal('JASC-PAL\r\n0100\r\n3\r\n0 0 0\r\n255 128 0\r\n1 2 3\r\n');
check('a JASC palette reads back as RGB triples',
    pal && pal.length === 3 && pal[1].r === 255 && pal[1].g === 128 && pal[1].b === 0,
    JSON.stringify(pal));
check('anything that is not JASC-PAL is refused rather than half-read',
    parseJascPal('GIMP Palette\n0 0 0\n') === null);

/* ── the tilemap ─────────────────────────────────────────────────────────── */
const tm = parseTilemap(new Uint8Array([0x62, 0x20, 0x00, 0x30]));
check('tilemap entries are little-endian u16',
    tm && tm.length === 2 && tm[0] === 0x2062 && tm[1] === 0x3000, JSON.stringify([...(tm || [])]));

/* ── the blitter ─────────────────────────────────────────────────────────── */
{
    // One 8×8 tile sheet: colour 0 top row, colour 1 everywhere else.
    const tiles = { width: 8, indices: new Uint8Array(64).fill(1) };
    for (let x = 0; x < 8; x++) tiles.indices[x] = 0;
    const palette = [];
    for (let i = 0; i < 48; i++) palette.push({ r: i, g: 0, b: 0 });
    // Every cell: tile 0, bank 2 → file colours 0..15.
    const map = new Uint16Array(32 * 20).fill(0x2000);

    const bg = renderBackground(tiles, palette, map);
    check('a background comes back at screen size',
        bg && bg.width === SCREEN_W && bg.height === SCREEN_H && bg.data.length === 240 * 160 * 4);
    check('colour 0 stays transparent so the textbox area is a hole',
        bg.data[3] === 0, `alpha ${bg.data[3]}`);
    const second = (1 * SCREEN_W + 0) * 4;   // row 1 = colour 1
    check('bank 2 reads the first sixteen colours of the file, not the forty-ninth',
        bg.data[second] === 1 && bg.data[second + 3] === 255,
        `r=${bg.data[second]} a=${bg.data[second + 3]}`);

    // Flips.
    const vf = new Uint16Array(32 * 20).fill(0x2800);
    const flipped = renderBackground(tiles, palette, vf);
    check('the vertical flip bit is obeyed',
        flipped.data[3] === 255 && flipped.data[(7 * SCREEN_W) * 4 + 3] === 0,
        `top a=${flipped.data[3]}, row7 a=${flipped.data[(7 * SCREEN_W) * 4 + 3]}`);

    const low = renderBackground(tiles, palette, new Uint16Array(32 * 20).fill(0x0000));
    check('a bank below the palette base is skipped rather than read out of range',
        low && low.data.every(v => v === 0));
}

/* ── the table ───────────────────────────────────────────────────────────── */
{
    const src = `
const struct BattleEnvironment gBattleEnvironmentInfo[BATTLE_ENVIRONMENT_COUNT] =
{
    [BATTLE_ENVIRONMENT_GRASS] =
    {
        .name = _("Grass"),
        .background = ENVIRONMENT_BACKGROUND(TallGrass),
        .palette = gBattleEnvironmentPalette_TallGrass,
    },
    [BATTLE_ENVIRONMENT_CAVE] =
    {
        .name = _("Cave"),
        .background = ENVIRONMENT_BACKGROUND(Cave),
        .palette = gBattleEnvironmentPalette_Cave,
    },
};`;
    const envs = parseEnvironments(src);
    check('both environments are read, in declaration order',
        envs.length === 2 && envs[0].id === 'BATTLE_ENVIRONMENT_GRASS' && envs[1].label === 'Cave',
        JSON.stringify(envs.map(e => e.label)));
    check('the macro suffix becomes the tile and tilemap symbols',
        envs[0].tiles === 'gBattleEnvironmentTiles_TallGrass' &&
        envs[0].tilemap === 'gBattleEnvironmentTilemap_TallGrass', JSON.stringify(envs[0]));
    check('an environment whose files do not resolve is dropped, not half-drawn',
        resolveEnvironments(envs, { pathsBySymbol: new Map() }).length === 0);

    /* The macro is token-pasting, and what it pastes is only knowable from its
       definition — which is why the definition is read rather than the prefix
       assumed. A fork that renames the symbols renames them here too. */
    const forked = parseEnvironments(`
#define SCENE(Bg)                          \\
{                                          \\
    .tileset = gCoolBattleTiles_##Bg,      \\
    .tilemap = gCoolBattleTilemap_##Bg,    \\
}
const struct BattleEnvironment gBattleEnvironmentInfo[] = {
    [BATTLE_ENVIRONMENT_VOLCANO] = { .name = _("Volcano"), .background = SCENE(Volcano),
                                     .palette = gCoolBattlePalette_Volcano },
};`);
    check('a fork’s own background macro is expanded from its definition',
        forked.length === 1 && forked[0].tiles === 'gCoolBattleTiles_Volcano' &&
        forked[0].tilemap === 'gCoolBattleTilemap_Volcano', JSON.stringify(forked));

    /* Vanilla writes the fields out in full and has no `.name`; older checkouts
       of both projects spell the whole thing TERRAIN. Neither is exotic — they
       are what most existing fan projects are branched from. */
    const vanilla = parseEnvironments(`
static const struct BattleBackground sBattleTerrainTable[] =
{
    [BATTLE_TERRAIN_LONG_GRASS] =
    {
        .tileset = gBattleTerrainTiles_LongGrass,
        .tilemap = gBattleTerrainTilemap_LongGrass,
        .entryTileset = gBattleTerrainAnimTiles_LongGrass,
        .entryTilemap = gBattleTerrainAnimTilemap_LongGrass,
        .palette = gBattleTerrainPalette_LongGrass,
    },
};`);
    check('the vanilla table shape is read without a macro',
        vanilla.length === 1 && vanilla[0].tiles === 'gBattleTerrainTiles_LongGrass' &&
        vanilla[0].tilemap === 'gBattleTerrainTilemap_LongGrass' &&
        vanilla[0].palette === 'gBattleTerrainPalette_LongGrass', JSON.stringify(vanilla));
    check('and names itself from the constant when the project gives no name',
        vanilla[0] && vanilla[0].label === 'long_grass', vanilla[0] && vanilla[0].label);

    /* `[BATTLE_ENVIRONMENT_CAVE]` also keys the camouflage and nature-power
       tables. Anchoring on the entry key instead of the table's name is what
       makes all three dialects readable, so the guard against reading the wrong
       table has to be the entry's own contents. */
    check('a table keyed the same way but holding no scenery is ignored',
        parseEnvironments(`
static const u16 sCamouflageTypes[] = {
    [BATTLE_ENVIRONMENT_CAVE] = { TYPE_ROCK },
    [BATTLE_ENVIRONMENT_WATER] = { TYPE_WATER },
};`).length === 0);
}

/* ── against a real decomp, when one is there ────────────────────────────── */
const DECOMP = ['../pokeemerald-expansion', '../pokeemerald']
    .map(p => join(process.cwd(), p)).find(p => existsSync(join(p, 'src')));

if (!DECOMP) {
    console.log('  --   no decomp beside the repo; skipping the real-project checks');
} else {
    console.log(`  ..   against ${DECOMP}`);
    const files = [];
    (function walk(dir, rel) {
        for (const n of readdirSync(dir, { withFileTypes: true })) {
            if (n.name.startsWith('.')) continue;
            const p = join(dir, n.name), r = rel ? rel + '/' + n.name : n.name;
            if (n.isDirectory()) walk(p, r);
            else if (/\.(c|h|inc)$/i.test(n.name)) {
                const text = readFileSync(p, 'utf8');
                // In step with SOURCE_MARKERS; the environment table names no
                // files of its own, so it is found by its entry constant.
                if (/INCBIN_U|INCGFX_U|BATTLE_ENVIRONMENT_|BATTLE_TERRAIN_/.test(text)) {
                    files.push({ path: r, text });
                }
            }
        }
    })(join(DECOMP, 'src'), 'src');

    const index = parseDeclarations(files);
    const declared = parseEnvironments(files.map(f => f.text).join('\n'));
    const envs = resolveEnvironments(declared, index);
    console.log(`       ${declared.length} environments declared, ${envs.length} fully resolvable`);
    check('the project declares battle environments', declared.length >= 8, String(declared.length));
    check('and most of them resolve to files on disk',
        envs.length >= declared.length - 2, `${envs.length}/${declared.length}`);

    let drew = 0, opaque = [];
    for (const e of envs) {
        const t = join(DECOMP, e.tilesPath), mp = join(DECOMP, e.tilemapPath), pp = join(DECOMP, e.palettePath);
        if (!existsSync(t) || !existsSync(mp) || !existsSync(pp)) continue;
        const tiles = readIndexedPng(readFileSync(t));
        const palette = parseJascPal(readFileSync(pp, 'latin1'));
        const map = parseTilemap(readFileSync(mp));
        const bg = renderBackground(tiles, palette, map);
        if (!bg) continue;
        drew++;
        let solid = 0;
        for (let i = 3; i < bg.data.length; i += 4) if (bg.data[i]) solid++;
        opaque.push({ label: e.label, pct: Math.round(solid / (SCREEN_W * SCREEN_H) * 100) });
    }
    console.log('       ' + opaque.map(o => `${o.label} ${o.pct}%`).join(', '));
    check('every resolvable environment renders', drew === envs.length, `${drew}/${envs.length}`);
    check('each one covers most of the screen but leaves the textbox area clear',
        opaque.length > 0 && opaque.every(o => o.pct >= 50 && o.pct <= 95),
        JSON.stringify(opaque.filter(o => o.pct < 50 || o.pct > 95)));

    // The palette base is a fact about the decomp, so assert it against it: at
    // base 2 the banks in use are covered by a 48-colour file; at 0 they are not.
    const cave = envs.find(e => /cave/i.test(e.label)) || envs[0];
    const map = parseTilemap(readFileSync(join(DECOMP, cave.tilemapPath)));
    const banks = new Set();
    for (let i = 0; i < 32 * 20; i++) banks.add((map[i] >> 12) & 0xf);
    const used = [...banks].filter(b => b >= PALETTE_BASE);
    const palLen = parseJascPal(readFileSync(join(DECOMP, cave.palettePath), 'latin1')).length;
    check('the banks in use fit the palette file once the BG row offset is applied',
        used.every(b => (b - PALETTE_BASE) * 16 < palLen),
        `banks ${[...banks].join(',')} against ${palLen} colours`);

    /* The second screenblock is not padding — it is the intro slide's other
       half, a near-copy without the platforms. Worth pinning down, because the
       tempting reading of a 4096-byte file is one 64-wide map, and reading it
       that way interleaves the two blocks into something that still looks like
       scenery. If this ever stops holding, the crop is the thing to re-check. */
    const twin = envs.map(e => {
        const m = parseTilemap(readFileSync(join(DECOMP, e.tilemapPath)));
        if (m.length < 2048) return null;
        let same = 0;
        for (let i = 0; i < 1024; i++) if (m[i] === m[1024 + i]) same++;
        return { label: e.label, same };
    }).filter(Boolean);
    check('the two screenblocks are near-twins, so the crop must be block 0 alone',
        twin.length > 0 && twin.every(t => t.same > 800 && t.same < 1024),
        JSON.stringify(twin.filter(t => t.same <= 800 || t.same >= 1024).slice(0, 4)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
