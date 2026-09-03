/* A picture back into the three files a GBA screen is made of.
 *
 * This is the half of the workflow that no tool in a decomp does. `make` turns
 * a PNG into tile data, but only by cutting it up in reading order — it never
 * looks for repeats and never writes a tilemap. So `map.bin` has no build rule
 * anywhere in the project: every one was made by hand in Tilemap Studio and
 * committed, and nothing in the repo can regenerate it. That is the reason an
 * artist has to leave their editor to change a map preview.
 *
 * What the hardware actually wants:
 *
 *   - a sheet of 8×8 tiles, each pixel a 4-bit index into a 16-colour bank
 *   - a grid of 16-bit entries: 10 bits of tile id, one bit each for horizontal
 *     and vertical flip, four bits naming the bank
 *   - the banks themselves
 *
 * Two consequences shape everything here. Repeats cost nothing, so identical
 * cells — including mirrored ones — share a single tile. And the bank lives in
 * the *grid*, not in the tile, so two cells drawn from the same shape in
 * different colours are still one tile.
 *
 * The one rule a picture can break: every pixel of a single 8×8 cell must come
 * from one bank. Nothing in a paint program stops someone blending across that
 * line, and the error Tilemap Studio gives for it — "too many palettes" — names
 * neither the cell nor the colour. So a conflict is reported with its position
 * and the banks involved, and the caller decides whether to write.
 */

const TILE = 8;

/* Indices as the editor holds them: one byte per pixel, the palette index into
   the whole multi-bank palette. Bank is the high nibble, colour the low one —
   the same split gbagfx makes at gfx.c:339. */
const bankOf = (i) => i >> 4;
const colourOf = (i) => i & 0xf;

/* A tile's 64 colours as a string key, in four orientations. Strings rather
   than a hash because a collision here silently corrupts the picture, and 64
   bytes is small enough that the honest comparison is also the cheap one. */
function tileKeys(px) {
    let plain = '', h = '', v = '', hv = '';
    for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
            plain += String.fromCharCode(px[y * TILE + x]);
            h += String.fromCharCode(px[y * TILE + (TILE - 1 - x)]);
            v += String.fromCharCode(px[(TILE - 1 - y) * TILE + x]);
            hv += String.fromCharCode(px[(TILE - 1 - y) * TILE + (TILE - 1 - x)]);
        }
    }
    return { plain, h, v, hv };
}

/* Picture → { tiles, map, conflicts }.
 *
 * `indices` is width×height palette indices. `paletteBase` is the BG row the
 * project loads bank 0 of the palette file into — 13 for a map preview, 2 for a
 * battle background — because the grid stores the hardware's row number, not
 * the file's.
 *
 * `sheetWidthTiles` only decides the shape of the emitted sheet; the build
 * reads it in reading order, so it is cosmetic. 16 keeps a sheet that a person
 * can still scroll through.
 *
 * `seed` is the sheet that is already on disk. Passing it keeps every tile at
 * the id it already has and appends only what is new, which matters more than
 * it looks: a tile id is a *reference*, and things outside this picture hold
 * them. A battle background's map is two screenblocks — the picture and the
 * intro slide — and renumbering the picture's tiles leaves the slide pointing
 * at whatever landed on those ids. It also keeps the git diff to the tiles that
 * actually changed. The cost is that a seeded sheet never shrinks; tiles the
 * picture stopped using stay in the file, unnamed and harmless.
 */
export function retile(indices, width, height, opts) {
    const o = opts || {};
    const base = o.paletteBase == null ? 0 : o.paletteBase;
    const sheetW = o.sheetWidthTiles || 16;
    const allowFlips = o.allowFlips !== false;
    if (!indices || indices.length < width * height) return null;
    if (width % TILE || height % TILE) return null;

    const cols = width / TILE, rows = height / TILE;
    const map = new Uint16Array(cols * rows);
    const conflicts = [];
    const seen = new Map();          // key → { id, hflip, vflip }
    const tiles = [];                // each 64 low-nibble values
    const px = new Uint8Array(TILE * TILE);

    if (o.seed && o.seed.indices && o.seed.width) {
        const s = o.seed;
        const sc = (s.width / TILE) | 0, sr = (s.height / TILE) | 0;
        for (let n = 0; n < sc * sr; n++) {
            const ox = (n % sc) * TILE, oy = (((n / sc) | 0)) * TILE;
            for (let y = 0; y < TILE; y++)
                for (let x = 0; x < TILE; x++)
                    px[y * TILE + x] = colourOf(s.indices[(oy + y) * s.width + ox + x]);
            tiles.push(Uint8Array.from(px));
            // First writer of a shape owns its id, exactly as below.
            const k = tileKeys(px).plain;
            if (!seen.has(k)) seen.set(k, { id: n });
        }
    }
    const seeded = tiles.length;

    for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
            // Which banks this cell draws from, and its colours regardless.
            const banks = new Map();
            for (let y = 0; y < TILE; y++) {
                const row = (cy * TILE + y) * width + cx * TILE;
                for (let x = 0; x < TILE; x++) {
                    const i = indices[row + x];
                    px[y * TILE + x] = colourOf(i);
                    /* Colour 0 is transparent in every bank, so a pixel using
                       it says nothing about which bank the cell belongs to.
                       Counting it would make a mostly-empty cell conflict with
                       whatever bank the file happens to list first. */
                    if (colourOf(i)) banks.set(bankOf(i), (banks.get(bankOf(i)) || 0) + 1);
                }
            }

            let bank = 0, most = -1;
            for (const [b, n] of banks) if (n > most) { most = n; bank = b; }
            if (banks.size > 1) {
                conflicts.push({
                    x: cx * TILE, y: cy * TILE,
                    banks: [...banks.keys()].sort((a, b) => a - b),
                    kept: bank
                });
            }

            const k = tileKeys(px);
            let hit = seen.get(k.plain);
            if (!hit && allowFlips) {
                // A mirrored match costs a flip bit and saves a whole tile.
                const hf = seen.get(k.h), vf = seen.get(k.v), bf = seen.get(k.hv);
                if (hf) hit = { id: hf.id, hflip: 1, vflip: 0 };
                else if (vf) hit = { id: vf.id, hflip: 0, vflip: 1 };
                else if (bf) hit = { id: bf.id, hflip: 1, vflip: 1 };
            }
            if (!hit) {
                hit = { id: tiles.length, hflip: 0, vflip: 0 };
                tiles.push(Uint8Array.from(px));
                /* Only the unflipped orientation is registered, so the first
                   cell to use a shape owns it and later cells match against
                   that one. Registering all four would let a tile match itself
                   flipped and pick an arbitrary orientation. */
                seen.set(k.plain, { id: hit.id });
            }

            map[cy * cols + cx] = (hit.id & 0x3ff)
                | (hit.hflip ? 0x400 : 0)
                | (hit.vflip ? 0x800 : 0)
                | (((bank + base) & 0xf) << 12);
        }
    }

    return {
        tiles: sheetOf(tiles, sheetW), map, conflicts,
        tileCount: tiles.length,
        // What the edit cost. The build asserts a tile budget on some assets
        // (`-num_tiles 53 -Wnum_tiles`), so growth is worth saying out loud.
        added: tiles.length - seeded
    };
}

/* The tiles laid out as an image, padded to a full last row with blank tiles
   the grid never names. */
function sheetOf(tiles, sheetW) {
    const rows = Math.max(1, Math.ceil(tiles.length / sheetW));
    const width = sheetW * TILE, height = rows * TILE;
    const indices = new Uint8Array(width * height);
    tiles.forEach((t, n) => {
        const ox = (n % sheetW) * TILE, oy = ((n / sheetW) | 0) * TILE;
        for (let y = 0; y < TILE; y++)
            for (let x = 0; x < TILE; x++)
                indices[(oy + y) * width + ox + x] = t[y * TILE + x];
    });
    return { indices, width, height };
}

/* The grid as the bytes that go on disk: little-endian u16, written through a
   DataView so a big-endian host cannot quietly change the file. */
export function tilemapBytes(map) {
    const out = new Uint8Array(map.length * 2);
    const view = new DataView(out.buffer);
    for (let i = 0; i < map.length; i++) view.setUint16(i * 2, map[i], true);
    return out;
}

/* A palette back to the JASC-PAL text the decomp keeps in the tree. CRLF and
   the three-line header are what every .pal in the project uses; gbagfx reads
   the count from line 3 rather than from the number of lines that follow. */
export function toJascPal(colours) {
    const rows = colours.map(c => `${c.r} ${c.g} ${c.b}`);
    return 'JASC-PAL\r\n0100\r\n' + rows.length + '\r\n' + rows.join('\r\n') + '\r\n';
}
