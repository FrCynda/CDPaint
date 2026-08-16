/* The battle background, rebuilt from what the project ships.
 *
 * A GBA background is not a picture. It is a 256-tile sheet (`tiles.png`,
 * 4bpp), a 32×32 grid of 16-bit entries saying which tile goes where
 * (`map.bin`), and a palette (`palette.pal`). The ROM stores all three
 * compressed; the *files on disk are not*, because the compression happens in
 * the build. So the whole thing can be reassembled here with no decompressor:
 * read the PNG the app already knows how to read, read 2048 little-endian u16s,
 * and blit.
 *
 * Two details that are not guessable and were read out of the decomp rather
 * than assumed:
 *
 *   - `battle_bg.c:872` does `LoadPalette(…, BG_PLTT_ID(2), 3 * PLTT_SIZE_4BPP)`.
 *     The 48-colour file lands in BG palette rows 2, 3 and 4, so a map entry
 *     naming bank 3 wants colours 16..31 of the file, not 48..63. Ignoring that
 *     offset renders the whole scene out of a palette it never uses.
 *
 *   - `map.bin` is 4096 bytes, a 64×32 map, and a GBA stores that as *two 32×32
 *     screenblocks* rather than as one 64-wide array. Reading it row-major at a
 *     stride of 64 interleaves the two and produces a convincing-looking scene
 *     that is wrong. Screenblock 0 (entries 0..1023, stride 32) is the battle
 *     scene, and it is the one whose platforms sit under sBattlerCoords;
 *     screenblock 1 is its near-twin — 929 of 1024 entries identical — and
 *     holds no platforms, being the other half of the intro slide.
 *
 * Colour 0 of any bank is transparent on a GBA background, which is what leaves
 * the message-box area of the map empty: the game draws the textbox over it.
 * Rendering it as transparent rather than as black is what makes that read as a
 * hole rather than as scenery.
 */

export const SCREEN_W = 240;
export const SCREEN_H = 160;
const MAP_W = 32, TILE = 8;

/* BG palette row the environment palette is loaded into. battle_bg.c:872. */
export const PALETTE_BASE = 2;

/* JASC-PAL, 0–255 per channel. The decomp writes every palette this way and
   PaintEngine already reads it; this is the same format read without a
   PaintEngine to hand, so the scene can be built and tested outside a browser. */
export function parseJascPal(text) {
    const lines = String(text).split(/\r?\n/);
    if (lines[0] !== 'JASC-PAL' || lines[1] !== '0100') return null;
    const out = [];
    for (let i = 3; i < lines.length; i++) {
        const m = lines[i].trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
        if (m) out.push({ r: +m[1], g: +m[2], b: +m[3] });
    }
    return out.length ? out : null;
}

/* The environments the project declares, in the order it declares them.
 *
 * Read rather than hardcoded because the whole point of this app is forks: an
 * added environment should appear in the cycler without anyone editing CDPaint.
 *
 * Three dialects are in the wild and none of them is worth privileging. Current
 * expansion writes `.background = ENVIRONMENT_BACKGROUND(TallGrass)`, a macro
 * naming a pair of symbols by suffix, plus a `.name` for the UI. Current
 * vanilla writes `.tileset` and `.tilemap` out in full and has no name. Older
 * checkouts of both spell the whole thing TERRAIN rather than ENVIRONMENT. So
 * the anchor is the entry key, not the table's name — which also means a fork
 * that keeps its environments in a file of its own is found without CDPaint
 * knowing that file exists.
 *
 * An entry that names no background or no palette is skipped rather than
 * half-drawn: `[BATTLE_ENVIRONMENT_CAVE]` also keys camouflage and nature-power
 * tables, and those are not scenery. */
const ENV_KEY = /\[(BATTLE_(?:ENVIRONMENT|TERRAIN)_[A-Z0-9_]+)\]\s*=\s*\{/g;

/* `.background = ENVIRONMENT_BACKGROUND(TallGrass)` is a token-pasting macro,
   and its definition is the only thing that says what it pastes. Reading it
   beats assuming `gBattleEnvironmentTiles_`: the same project spelled that
   `gBattleTerrainTiles_` a year ago, and a fork is free to spell it anything.

   When the definition is not in the text CDPaint was given — it lives in a
   header nothing else made it read — the current convention is the fallback.
   That is a guess, but a checked one: a symbol that does not exist is dropped
   by resolveEnvironments, so the worst case is the environment being missing,
   which is exactly what returning nothing would have done. */
function expandBackgroundMacro(text, name, arg) {
    const def = new RegExp('#define\\s+' + name + '\\s*\\(\\s*\\w+\\s*\\)').exec(text);
    if (def) {
        const body = text.slice(def.index, def.index + 600);
        const t = body.match(/\.tileset\s*=\s*(\w+?)##/);
        const m = body.match(/\.tilemap\s*=\s*(\w+?)##/);
        if (t && m) return { tiles: t[1] + arg, tilemap: m[1] + arg };
    }
    return { tiles: 'gBattleEnvironmentTiles_' + arg, tilemap: 'gBattleEnvironmentTilemap_' + arg };
}

export function parseEnvironments(sourceText) {
    const text = String(sourceText || '');
    const keys = [];
    ENV_KEY.lastIndex = 0;
    let m;
    while ((m = ENV_KEY.exec(text))) keys.push({ id: m[1], at: m.index });
    if (!keys.length) return [];

    const out = [], seen = new Set();
    for (let i = 0; i < keys.length; i++) {
        const body = text.slice(keys[i].at,
            i + 1 < keys.length ? keys[i + 1].at : keys[i].at + 4000);
        const macro = body.match(/\.background\s*=\s*(\w+)\(\s*(\w+)\s*\)/);
        const expanded = macro ? expandBackgroundMacro(text, macro[1], macro[2]) : null;
        const tiles = expanded || body.match(/\.tileset\s*=\s*(\w+)/) && {
            tiles: body.match(/\.tileset\s*=\s*(\w+)/)[1],
            tilemap: (body.match(/\.tilemap\s*=\s*(\w+)/) || [])[1]
        };
        const pal = body.match(/\.palette\s*=\s*(\w+)/);
        if (!pal || !tiles || !tiles.tiles || !tiles.tilemap) continue;
        if (seen.has(keys[i].id)) continue;
        seen.add(keys[i].id);

        const name = body.match(/\.name\s*=\s*_\("([^"]*)"\)/);
        out.push({
            id: keys[i].id,
            label: name ? name[1]
                : keys[i].id.replace(/^BATTLE_(ENVIRONMENT|TERRAIN)_/, '').toLowerCase(),
            tiles: tiles.tiles,
            tilemap: tiles.tilemap,
            palette: pal[1]
        });
    }
    return out;
}

/* Symbols → the files that back them, using the index the project browser
   already builds out of every INCBIN/INCGFX in the tree. An environment whose
   three files are not all resolvable is dropped rather than half-drawn. */
export function resolveEnvironments(envs, index) {
    if (!index || !index.pathsBySymbol) return [];
    const one = (sym) => {
        const paths = index.pathsBySymbol.get(sym);
        return paths && paths.length ? paths[0] : null;
    };
    const out = [];
    for (const e of envs) {
        const tiles = one(e.tiles), tilemap = one(e.tilemap), palette = one(e.palette);
        if (!tiles || !tilemap || !palette) continue;
        out.push(Object.assign({}, e, { tilesPath: tiles, tilemapPath: tilemap, palettePath: palette }));
    }
    return out;
}

/* One screen of tiled background, as RGBA.
 *
 * `tiles` is the decoded tiles.png — {indices, width} — `pal` the parsed
 * palette, `map` a Uint16Array of the tilemap. Returns a plain object rather
 * than ImageData so this runs in node.
 *
 * Defaults describe a battle background: 240×160, palette at BG row 2. A map
 * preview is the same construction at 256×160 and row 13, which is why the
 * options exist rather than a second copy of this loop.
 */
export function renderBackground(tiles, pal, map, opts) {
    const o = opts || {};
    const width = o.width || SCREEN_W;
    const height = o.height || SCREEN_H;
    const base = o.paletteBase == null ? PALETTE_BASE : o.paletteBase;
    const stride = o.mapStride || MAP_W;

    const cols = Math.ceil(width / TILE);
    const rows = Math.ceil(height / TILE);
    if (!tiles || !tiles.indices || !pal || !pal.length || !map || map.length < stride * rows) return null;
    const data = new Uint8ClampedArray(width * height * 4);
    const tilesPerRow = (tiles.width / TILE) | 0;
    if (!tilesPerRow) return null;

    for (let my = 0; my < rows; my++) {
        for (let mx = 0; mx < cols; mx++) {
            const e = map[my * stride + mx];
            const id = e & 0x3ff;
            const hflip = e & 0x400, vflip = e & 0x800;
            const bank = ((e >> 12) & 0xf) - base;
            if (bank < 0) continue;            // a row this palette does not cover
            const tx = (id % tilesPerRow) * TILE, ty = ((id / tilesPerRow) | 0) * TILE;

            for (let y = 0; y < TILE; y++) {
                const py = my * TILE + y;
                if (py >= height) break;
                const sy = vflip ? TILE - 1 - y : y;
                const srcRow = (ty + sy) * tiles.width + tx;
                let out = (py * width + mx * TILE) * 4;
                for (let x = 0; x < TILE; x++, out += 4) {
                    if (mx * TILE + x >= width) break;
                    /* Low nibble only. A 4bpp sheet has nothing above it, but a
                       map preview's sheet is an 8bpp PNG whose high nibble
                       carries the palette bank a second time — gbagfx does the
                       same mask at gfx.c:339 before applying the tilemap's
                       bank, and the two disagree in files Tilemap Studio wrote,
                       where the sheet says bank 0 for everything. The tilemap
                       is the one the hardware believes. */
                    const ci = tiles.indices[srcRow + (hflip ? TILE - 1 - x : x)] & 0xf;
                    if (!ci) continue;         // colour 0 is transparent on a BG
                    const c = pal[bank * 16 + ci];
                    if (!c) continue;
                    data[out] = c.r; data[out + 1] = c.g; data[out + 2] = c.b; data[out + 3] = 255;
                }
            }
        }
    }
    return { data, width, height };
}

/* The same assembly, but as palette indices rather than colour.
 *
 * What an editor needs: one byte per pixel holding the whole-palette index —
 * bank in the high nibble, colour in the low one — so painting stays indexed
 * and saving can put the picture back into tiles. Rendering to RGBA and reading
 * colours back would lose that, because two banks can hold the same colour.
 */
export function assembleIndices(tiles, map, opts) {
    const o = opts || {};
    const width = o.width || SCREEN_W;
    const height = o.height || SCREEN_H;
    const base = o.paletteBase == null ? PALETTE_BASE : o.paletteBase;
    const stride = o.mapStride || MAP_W;

    const cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE);
    if (!tiles || !tiles.indices || !map || map.length < stride * rows) return null;
    const tilesPerRow = (tiles.width / TILE) | 0;
    if (!tilesPerRow) return null;

    const out = new Uint8Array(width * height);
    for (let my = 0; my < rows; my++) {
        for (let mx = 0; mx < cols; mx++) {
            const e = map[my * stride + mx];
            const id = e & 0x3ff;
            const hflip = e & 0x400, vflip = e & 0x800;
            const bank = ((e >> 12) & 0xf) - base;
            if (bank < 0) continue;
            const tx = (id % tilesPerRow) * TILE, ty = ((id / tilesPerRow) | 0) * TILE;
            for (let y = 0; y < TILE; y++) {
                const py = my * TILE + y;
                if (py >= height) break;
                const srcRow = (ty + (vflip ? TILE - 1 - y : y)) * tiles.width + tx;
                for (let x = 0; x < TILE; x++) {
                    const pxx = mx * TILE + x;
                    if (pxx >= width) break;
                    const ci = tiles.indices[srcRow + (hflip ? TILE - 1 - x : x)] & 0xf;
                    out[py * width + pxx] = bank * 16 + ci;
                }
            }
        }
    }
    return { indices: out, width, height };
}

/* An indexed image as RGBA, with one index knocked out.
 *
 * The interface sheets (the healthbox and friends) are ordinary 4bpp PNGs whose
 * on-screen appearance is the file's own layout — the `-mwidth/-mheight` flags
 * in their declarations reorder tiles for the ROM's OAM, not for the eye. So
 * they need no tilemap, only their own palette and their transparent index. */
export function indexedToRgba(indices, width, height, palette, transparentIndex) {
    if (!indices || !palette || !width || !height) return null;
    if (indices.length < width * height) return null;
    const data = new Uint8ClampedArray(width * height * 4);
    const ti = transparentIndex < 0 ? 0 : transparentIndex;
    for (let i = 0, o = 0; i < width * height; i++, o += 4) {
        const ci = indices[i];
        if (ci === ti) continue;
        const c = palette[ci];
        if (!c) continue;
        data[o] = c.r; data[o + 1] = c.g; data[o + 2] = c.b; data[o + 3] = 255;
    }
    return { data, width, height };
}

/* map.bin as u16s. Written little-endian by the build, and a DataView read
   keeps that true on a big-endian host rather than trusting the platform. */
export function parseTilemap(bytes) {
    if (!bytes || bytes.length < 2) return null;
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const out = new Uint16Array(b.byteLength >> 1);
    for (let i = 0; i < out.length; i++) out[i] = view.getUint16(i * 2, true);
    return out;
}
