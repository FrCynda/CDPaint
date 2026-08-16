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
    const m = /^(.*\/)?(.*?)tiles\.png$/i.exec(String(relPath || ''));
    if (!m) return null;
    const dir = m[1] || '', stem = m[2] || '';
    const all = siblings || [];
    const has = (f) => all.indexOf(f) >= 0;

    const map = [stem + 'map.bin', stem + 'tilemap.bin'].find(has);
    if (!map) return null;

    // `altaria_tiles.png` is served by `altaria.pal`, not `altaria_palette.pal`.
    const bare = stem.replace(/_$/, '');
    const preferred = [stem + 'palette.pal', bare && bare + '.pal', 'palette.pal'].filter(Boolean);
    const pals = preferred.filter(has);
    for (const f of all) {
        if (/\.pal$/i.test(f) && pals.indexOf(f) < 0) pals.push(f);
    }

    return {
        stem: stem,
        tilesPath: relPath,
        mapPath: dir + map,
        palettes: pals.map(f => dir + f)
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
    if (!map || map.length < stride) return null;
    const rows = Math.min(20, Math.floor(map.length / stride));
    if (!rows) return null;

    let base = 15, sawContent = false;
    for (let i = 0; i < rows * stride; i++) {
        if (map[i] === 0) continue;
        sawContent = true;
        const bank = (map[i] >> 12) & 0xf;
        if (bank < base) base = bank;
    }
    return {
        stride: stride,
        width: stride * 8,
        height: rows * 8,
        paletteBase: sawContent ? base : 0
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
