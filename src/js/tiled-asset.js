/* Recognising a screen that is stored as tiles, and working out its shape.
 *
 * A map preview, a battle background and a title screen are all the same
 * construction: `tiles.png` beside a tilemap, sometimes beside a palette. What
 * differs between them — how wide the picture is, which palette row the game
 * loads into — is not written down anywhere a tool can read. It is implied by
 * the tilemap, so it is derived from the tilemap rather than kept in a table
 * here that a fork would immediately make wrong.
 */

/* The files that make up a screen, given one of them and what else is in that
 * folder.
 *
 * Most folders hold one screen called tiles.png + map.bin. Some hold several,
 * named for what is on them — `metapod_tiles.png` beside `metapod_map.bin` —
 * so the stem is what pairs them, not the folder.
 *
 * Palettes come back as a list rather than a single answer, because one
 * picture genuinely has several: the expansion's `stadium/` is one tiles.png
 * and one map.bin with nine palettes beside it, one per Elite Four member, and
 * picking the alphabetically first would be inventing an answer. Ordered
 * best-guess first — a palette named for this screen's stem, then the folder's
 * shared one — so a caller wanting one can take the first. The older half of
 * Gaia's previews keep no palette file at all, their colours living in the
 * PNG's own table, and come back with an empty list rather than as a failure.
 */
export function describe(relPath, siblings) {
    const m = /^(.*\/)?([^/]+)\.png$/i.exec(String(relPath || ''));
    if (!m) return null;
    const dir = m[1] || '', name = m[2];
    const all = siblings || [];
    /* Matched case-insensitively but answered with the name the folder really
       uses, because the path goes back out to a filesystem that may not be as
       forgiving as the one it was authored on. */
    const has = (f) => f && all.find(s => s.toLowerCase() === f.toLowerCase());

    /* Two naming habits, both common enough that supporting one alone leaves
       most of the game unreachable. `tiles.png` + `map.bin` is what the battle
       backgrounds and map previews use; everything else — the bag, the pokédex,
       the intro — names both halves after the screen: `menu.png` + `menu.bin`,
       `cool.png` + `cool_map.bin`. Measured across pokegaia: the first habit
       covers about 50 screens, both together about 340. */
    const t = /^(.*?)tiles$/i.exec(name);
    const stem = t ? t[1] : name + '_';
    let maps = [
        t && t[1] + 'map.bin', t && t[1] + 'tilemap.bin',
        name + '.bin', name + '_map.bin', name + '_tilemap.bin'
    ].map(has).filter(Boolean).slice(0, 1);

    /* One sheet, several tilemaps. The title screen's regigigas is six frames
       of an animation over one `tiles.png`; `valoon_reserve` is four map
       previews sharing one. Neither names its tilemaps after the sheet, and
       nothing in the folder says which belongs to what — but when the folder
       holds exactly one PNG there is nothing to be wrong about. With more than
       one, which sheet serves which map is only knowable from the C, so the
       folder is left alone rather than guessed at. */
    if (!maps.length && all.filter(f => /\.png$/i.test(f)).length === 1) {
        const loose = all.filter(f => /\.bin$/i.test(f) &&
            !/^(border|collision|metatiles|metatile_attributes)\.bin$/i.test(f)).sort();
        /* Two or more, because a set is the evidence. One lone .bin beside one
           lone PNG is the shape of a genuine pair and equally the shape of two
           unrelated files that happen to share a folder, and there is nothing
           in the names to tell those apart. Several tilemaps over one sheet is
           only ever the first. */
        if (loose.length > 1) maps = loose;
    }
    if (!maps.length) return null;
    const map = maps[0];

    // `altaria_tiles.png` is served by `altaria.pal`, not `altaria_palette.pal`.
    const bare = stem.replace(/_$/, '');
    const named = [stem + 'palette.pal', bare && bare + '.pal', 'palette.pal', 'bg.pal']
        .map(has).filter(Boolean);

    /* Everything else in the folder still comes back, because a screen can
       genuinely have several — the expansion's stadium has nine, one per Elite
       Four member. But it comes back *after* the named ones and marked as such,
       because "some .pal in the same folder" is not evidence. Gaia's battle
       animation backgrounds share one folder holding 61 of them, and half those
       screens keep their colours in the PNG rather than in any file: taking the
       alphabetically first handed `aurora` the palette belonging to
       `aeroblast`, which looks like art and is not. */
    const pals = named.slice();
    for (const f of all) {
        if (/\.pal$/i.test(f) && pals.indexOf(f) < 0) pals.push(f);
    }

    return {
        stem: stem,
        tilesPath: relPath,
        mapPath: dir + map,
        // Every tilemap this sheet serves, the opened one first. Usually just it.
        maps: maps.map(f => dir + f),
        palettes: pals.map(f => dir + f),
        // How many of the leading entries are named for this screen. May be 0.
        named: named.length
    };
}

/* Width, height and palette row, read out of the tilemap.
 *
 * A GBA screen map is 32 entries across — that is the hardware's screenblock,
 * not a choice — so the picture is 32 tiles wide and as many rows as the file
 * holds, capped at the 20 that fit on screen. A battle background's map is
 * 2048 entries because it carries a second screenblock for the intro slide;
 * only the first is the picture.
 *
 * The palette row is the lowest bank any cell names, ignoring cells whose
 * entry is *entirely* zero. Those are the ones nobody filled in: the 16-pixel
 * strip down the right of a map preview is 40 such cells, and letting them vote
 * would put every preview's palette at row 0 instead of 13.
 *
 * "Entirely zero" rather than "tile id 0" on purpose. Tilemap Studio is
 * configured to give blank tiles id 0, so the two agree on everything shipped —
 * but a project that puts real art in tile 0 and names it from a real bank
 * would have its whole palette read one row too high, and the failure looks
 * like the picture opening in someone else's colours. Measured against 46
 * shipped previews and 11 battle backgrounds in test/tiled-asset.test.mjs. */
export function layoutFrom(map) {
    const stride = 32;
    /* A whole number of rows or it is not a screen map at all. Roughly a fifth
       of the `.bin` files under `graphics/` are something else — a 10×10 window,
       a strip of animation frames — and they land here looking plausible. */
    if (!map || map.length < stride || map.length % stride) return null;
    const rows = Math.min(20, map.length / stride);

    let base = 15, top = 0, tiles = 0, sawContent = false;
    for (let i = 0; i < rows * stride; i++) {
        if (map[i] === 0) continue;
        sawContent = true;
        const bank = (map[i] >> 12) & 0xf;
        if (bank < base) base = bank;
        if (bank > top) top = bank;
        if ((map[i] & 0x3ff) >= tiles) tiles = (map[i] & 0x3ff) + 1;
    }
    if (!sawContent) base = top = 0;
    return {
        stride: stride,
        width: stride * 8,
        height: rows * 8,
        paletteBase: base,
        /* What the sheet and the palette beside it have to supply for this map
           to mean anything: the highest tile it names, and how many palette
           banks it spans. A pairing that fails either is not a pairing. */
        tiles: tiles,
        banks: top - base + 1
    };
}

/* Which cells of a screen the hardware never shows.
 *
 * The GBA loads 32 tiles across but displays 30, so a map preview's artist
 * fills the last two columns with junk to stop real tiles landing there. It has
 * to stay in the file — the picture is 256 wide on disk — but drawing on it is
 * wasted effort, and not saying so is how someone spends an afternoon detailing
 * a strip nobody will ever see. */
export function offscreenColumns(layout) {
    if (!layout || layout.width <= 240) return null;
    return { x: 240, width: layout.width - 240 };
}
