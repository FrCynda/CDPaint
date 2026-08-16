/* Where the sprite actually sits in its 64×64 box.
 *
 * Phase 3.4. Two numbers per battle sprite, and getting either wrong is the
 * single most common "my custom sprite looks wrong in game" bug:
 *
 *   size      the drawn pixel area, in multiples of 8. Battle animations aim at
 *             it — GET_MON_COORDS_WIDTH/HEIGHT give the box a hit flash, a
 *             status icon or a move effect is placed against.
 *   y_offset  the number of pixels between the drawn area and the *bottom* edge
 *             of the frame. Wrong by four and the sprite floats or sinks.
 *
 * Both are computable from the artwork, and neither is stored in the PNG. The
 * project declares them in C — `species_info/*.h` in expansion,
 * `front_pic_coordinates.h` in vanilla — and this reads and rewrites that.
 *
 * ── What is exact and what is not ────────────────────────────────────────
 *
 * Measured against pokeemerald-expansion 1.16.4, 3444 declared front/back
 * entries with their real artwork:
 *
 *   y_offset === 63 - bottomRow    3411/3444 (99.0%)
 *   size     === bbox rounded up      2495/3444 (72%)
 *   size     >= bbox rounded up       3430/3444 (99.6%)
 *
 * So y_offset is a function of the artwork and is checked as one. `size` is
 * not: the decomp's own values are an upper bound, generous by a tile or two
 * on a quarter of its species, because they came from the original ROM tables
 * rather than from a measuring tool. Calling those 949 entries wrong would be
 * the F4 mistake again — a confident answer where the project has a different
 * convention. So a size larger than the artwork is reported as fine, and only
 * a size *smaller* than the artwork is a fault, because that one really does
 * clip: an animation aimed at the declared box misses the pixels outside it.
 *
 * Pure functions over indices and text. No DOM, no engine, no fetch.
 */

/* GBA-side encoding: four bits of width-in-tiles, four of height-in-tiles.
   include/data.h:
     #define MON_COORDS_SIZE(w, h) (DIV_ROUND_UP(w, 8) << 4 | DIV_ROUND_UP(h, 8)) */
export const encodeSize = (w, h) => ((Math.ceil(w / 8) & 0xf) << 4) | (Math.ceil(h / 8) & 0xf);
export const decodeSize = (v) => ({ w: ((v >> 4) & 0xf) * 8, h: (v & 0xf) * 8 });

const up8 = (n) => Math.ceil(n / 8) * 8;

/* The drawn area of one 64×64 frame, in that frame's own coordinates.
   `indices` is the whole sheet; `frame` picks the 64-row band. Returns null for
   a frame with nothing in it, which is a real state — an unfinished back sprite
   — and not an error. */
export function boundsOf(indices, sheetWidth, sheetHeight, transparentIndex, frame) {
    const size = 64;
    const y0 = (frame || 0) * size;
    if (!indices || y0 + size > sheetHeight || size > sheetWidth) return null;
    let minX = size, minY = size, maxX = -1, maxY = -1;
    for (let y = 0; y < size; y++) {
        const row = (y0 + y) * sheetWidth;
        for (let x = 0; x < size; x++) {
            if (indices[row + x] === transparentIndex) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    if (maxX < 0) return null;
    return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/* What the project should be declaring for that artwork. */
export function coordsFromBounds(bounds) {
    if (!bounds) return null;
    const w = up8(bounds.width), h = up8(bounds.height);
    return { width: w, height: h, size: encodeSize(w, h), yOffset: 63 - bounds.maxY, bounds };
}

/* Measured against declared, in the terms above: y_offset exact, size a floor.
   Returns [] when they agree — the caller shows nothing rather than a green
   badge nobody reads. */
export function compareCoords(computed, declared) {
    const out = [];
    if (!computed || !declared) return out;
    if (typeof declared.yOffset === 'number' && declared.yOffset !== computed.yOffset) {
        /* y_offset is how far the game pushes the sprite *down* from the battle
           coordinate, to make up for artwork that does not reach the bottom of
           its frame. Declare less than the artwork needs and it is not pushed
           far enough, so it floats; declare more and it sinks. */
        const drift = computed.yOffset - declared.yOffset;
        out.push({
            field: 'yOffset', severity: 'wrong',
            declared: declared.yOffset, computed: computed.yOffset,
            text: `sits ${Math.abs(drift)}px too ${drift > 0 ? 'high' : 'low'} — ` +
                `y_offset says ${declared.yOffset}, the artwork needs ${computed.yOffset}`
        });
    }
    const d = declared.size;
    if (d && (d.w < computed.width || d.h < computed.height)) {
        out.push({
            field: 'size', severity: 'wrong',
            declared: d, computed: { w: computed.width, h: computed.height },
            text: `drawn area is ${computed.width}×${computed.height} but size says ` +
                `${d.w}×${d.h} — animations will aim inside the artwork`
        });
    } else if (d && (d.w > computed.width || d.h > computed.height)) {
        out.push({
            field: 'size', severity: 'loose',
            declared: d, computed: { w: computed.width, h: computed.height },
            text: `size ${d.w}×${d.h} is larger than the ${computed.width}×${computed.height} ` +
                `artwork — harmless, and how a quarter of the stock species ship`
        });
    }
    return out;
}

/* ── Reading the declarations ─────────────────────────────────────────────

   Two layouts, and a fork may have either:

   expansion, src/data/pokemon/species_info/gen_1_families.h
       [SPECIES_BULBASAUR] =
       {
           .frontPic = gMonFrontPic_Bulbasaur,
           .frontPicSize = P_GBA_STYLE_SPECIES_GFX ? MON_COORDS_SIZE(32, 40) : MON_COORDS_SIZE(40, 40),
           .frontPicYOffset = P_GBA_STYLE_SPECIES_GFX ? 14 : 13,

   vanilla, src/data/pokemon_graphics/front_pic_coordinates.h
       [SPECIES_BULBASAUR] = {.size = MON_COORDS_SIZE(40, 40), .y_offset = 13},

   The species entry is found by its `[SPECIES_X] =` header rather than by
   brace matching, because the bodies contain macros with their own braces and
   a fork reformats freely. Everything up to the next header is that species'. */

const SPECIES_HEAD = /\[(SPECIES_\w+)\]\s*=/g;
const GBA_TERNARY = /^\s*P_GBA_STYLE_SPECIES_GFX\s*\?([\s\S]+?):([\s\S]+)$/;

const sizeOf = (expr) => {
    const m = /MON_COORDS_SIZE\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(expr || '');
    if (m) return { w: +m[1], h: +m[2] };
    // A fork that inlined the macro leaves the packed byte behind.
    const n = /^\s*(0[xX][0-9a-fA-F]+|\d+)\s*$/.exec(expr || '');
    return n ? decodeSize(Number(n[1])) : null;
};
const numberOf = (expr) => {
    const n = /^\s*(\d+)\s*$/.exec(expr || '');
    return n ? +n[1] : null;
};

/* One `.field = value,` inside a body, with where the value sits in the whole
   file so it can be rewritten later. Deliberately anchored to a comma or a
   line end so a value containing a comma — MON_COORDS_SIZE(40, 40) — is not
   cut in half; the tail is trimmed of a trailing comment instead. */
function readField(text, bodyStart, bodyEnd, field) {
    const re = new RegExp('\\.' + field + '\\s*=\\s*', 'g');
    re.lastIndex = bodyStart;
    const m = re.exec(text);
    if (!m || m.index >= bodyEnd) return null;
    const start = m.index + m[0].length;
    // Scan to the comma that closes this field, ignoring commas inside parens.
    let depth = 0, i = start;
    for (; i < bodyEnd; i++) {
        const c = text[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth <= 0) break;
        else if (c === '}' && depth <= 0) break;
    }
    let end = i;
    const raw = text.slice(start, end);
    const clean = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    return { start, end, raw, expr: clean.trim() };
}

/* Split a field into its standard and _gba readings. A plain value applies to
   both; a P_GBA_STYLE_SPECIES_GFX ternary gives one to each, and each branch
   keeps its own offsets so only the branch being corrected is rewritten. */
function splitVariants(field) {
    if (!field) return null;
    const t = GBA_TERNARY.exec(field.expr);
    if (!t) return { standard: field, gba: field };
    // Offsets of the branches inside the original raw text.
    const gbaStart = field.start + field.raw.indexOf(t[1]);
    const stdStart = field.start + field.raw.indexOf(t[2], gbaStart - field.start + t[1].length);
    return {
        gba: { start: gbaStart, end: gbaStart + t[1].length, expr: t[1].trim(), raw: t[1] },
        standard: { start: stdStart, end: stdStart + t[2].length, expr: t[2].trim(), raw: t[2] }
    };
}

const KINDS = [
    { kind: 'front', pic: 'frontPic', size: 'frontPicSize', y: 'frontPicYOffset' },
    { kind: 'back', pic: 'backPic', size: 'backPicSize', y: 'backPicYOffset' },
    // Vanilla's two coordinate tables have no pic field of their own; the
    // species id is the whole key, and the table the file belongs to says
    // which pic it is about.
    { kind: 'table', pic: null, size: 'size', y: 'y_offset' }
];

/* Every declared coordinate in the project, one record per species/kind/variant.
   `sources` is [{ path, text }], same shape project-model.js takes. */
export function parseSpeciesCoords(sources) {
    const out = [];
    for (const src of sources || []) {
        const text = src && src.text;
        if (!text || !/PicYOffset|y_offset/.test(text)) continue;

        // A vanilla coordinates file says in its own table name which pic it is.
        const table = /gMonBackPicCoords/.test(text) ? 'back'
            : /gMonFrontPicCoords/.test(text) ? 'front' : null;

        const heads = [];
        SPECIES_HEAD.lastIndex = 0;
        let m;
        while ((m = SPECIES_HEAD.exec(text))) heads.push({ species: m[1], at: m.index + m[0].length });

        for (let i = 0; i < heads.length; i++) {
            const bodyStart = heads[i].at;
            const bodyEnd = i + 1 < heads.length ? heads[i + 1].at : text.length;
            for (const k of KINDS) {
                const sizeField = readField(text, bodyStart, bodyEnd, k.size);
                const yField = readField(text, bodyStart, bodyEnd, k.y);
                if (!sizeField && !yField) continue;
                const kind = k.kind === 'table' ? table : k.kind;
                if (!kind) continue;
                const symbolField = k.pic ? readField(text, bodyStart, bodyEnd, k.pic) : null;
                const symbol = symbolField && /^g\w+$/.test(symbolField.expr) ? symbolField.expr : null;
                const sizes = splitVariants(sizeField);
                const ys = splitVariants(yField);
                /* A plain value is one declaration covering both artwork sets;
                   only a P_GBA_STYLE_SPECIES_GFX ternary splits into two. Saying
                   'any' rather than picking a side is what lets a fork that
                   never uses the flag still match its _gba files. */
                const split = (sizes && sizes.standard !== sizes.gba)
                    || (ys && ys.standard !== ys.gba);
                for (const variant of split ? ['standard', 'gba'] : ['any']) {
                    const pick = variant === 'any' ? 'standard' : variant;
                    const s = sizes && sizes[pick];
                    const y = ys && ys[pick];
                    const size = s ? sizeOf(s.expr) : null;
                    const yOffset = y ? numberOf(y.expr) : null;
                    if (size === null && yOffset === null) continue;
                    out.push({
                        species: heads[i].species, kind, variant, symbol,
                        file: src.path, size, yOffset,
                        sizeAt: s ? { start: s.start, end: s.end } : null,
                        yAt: y ? { start: y.start, end: y.end } : null
                    });
                }
            }
        }
    }
    return out;
}

/* Look a record up the way the caller has it: by the artwork's path, through
   the symbol the project-model index already resolved. Falls back to the
   species name in the path — a fork can declare coordinates for a species
   whose pic symbol it never spells out. */
export function coordsIndex(records, projectIndex) {
    const byPath = new Map();
    for (const r of records || []) {
        const paths = (r.symbol && projectIndex && projectIndex.pathsBySymbol
            && projectIndex.pathsBySymbol.get(r.symbol)) || [];
        for (const p of paths) {
            const isGba = /_gba\.(png|pal)$/i.test(p);
            if (r.variant !== 'any' && (r.variant === 'gba') !== isGba) continue;
            if (!byPath.has(p)) byPath.set(p, []);
            byPath.get(p).push(r);
        }
    }
    return byPath;
}

/* The corrected file text, with only the one value replaced.
   `at` is the {start,end} the parse recorded, so a ternary keeps its other
   branch, the comment after it, and the project's own formatting. */
export function patchCoord(text, at, value) {
    if (!text || !at || typeof at.start !== 'number') return null;
    const before = text.slice(0, at.start);
    const after = text.slice(at.end);
    // Keep the leading and trailing space the branch had; a ternary reads
    // `A ? x : y` and eating its spaces would leave `A ? x :y`.
    const raw = text.slice(at.start, at.end);
    const lead = /^\s*/.exec(raw)[0];
    const tail = /\s*$/.exec(raw)[0];
    return before + lead + value + tail + after;
}

export const formatSize = (w, h) => `MON_COORDS_SIZE(${w}, ${h})`;

if (typeof window !== 'undefined') {
    window.SpriteCoords = {
        encodeSize, decodeSize, boundsOf, coordsFromBounds, compareCoords,
        parseSpeciesCoords, coordsIndex, patchCoord, formatSize
    };
}
