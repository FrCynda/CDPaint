/* What the project knows about its own assets.
 *
 * Phase 3.1 and 3.2. Everything above this layer — the battle preview, the
 * sprite coordinates, the conformance strip — needs three facts about a file
 * that the file itself cannot supply:
 *
 *   what depth is this slot?     the PNG's own depth is not the answer; an
 *                                expansion icon.png is 8bpp and becomes a 4bpp
 *                                asset, and 32 stock assets are the reverse
 *   which palette applies?       only 17 of 449 object-event pictures share a
 *                                name with their palette, so the path cannot
 *                                say and guessing is finding F4
 *   which of these is live?      every species ships two complete sets of
 *                                artwork and one config flag picks between them
 *
 * All three are written down in the project, in C. So this reads the project
 * instead of assuming it, which is the only thing that survives contact with
 * someone's fork: hackers add species, reformat files, sit on old versions and
 * move things around, but they do not stop declaring their assets, because the
 * build would stop working if they did.
 *
 * Everything here is a pure function over text. No fetch, no DOM, no engine —
 * which is what lets it be tested against a real decomp in node, in a second,
 * without a browser.
 *
 * Where the project says nothing, every function returns null or an empty list
 * rather than a guess, and the caller falls back to convention. Silence is a
 * better answer than a confident wrong one; that lesson cost 469 false alarms.
 */

/* ── Declarations ─────────────────────────────────────────────────────────
   Three spellings, all common:

     const u32 gMonFrontPic_Bulbasaur[] =
         INCGFX_U32("graphics/pokemon/bulbasaur/anim_front.png", ".4bpp.smol");
     const u32 gFooTiles[] = INCBIN_U32("graphics/foo/tiles.4bpp");
     const u32 gObjectEventPic_AguavBerryTree[] =
         INCGFX_U32("graphics/object_events/pics/berry_trees/aguav.png",
                    ".4bpp", "-mwidth 2 -mheight 4");

   The first names the source file and the target format separately; the second
   folds the format into the extension and leaves the source implied; the third
   adds gbagfx flags on the end. Insisting on exactly two arguments lost every
   declaration of the third kind — 359 object-event pictures and most of the
   assets whose depth we could not find.

   So the match is structural rather than type-led: an identifier, `[] =`, and
   the macro. Nothing here depends on how the declaration is spelled, which is
   the point — `static const`, an alignment attribute or a hacker's own macro
   wrapper all still name a symbol and a file the same way. */
const DECL_RE =
    /(\w+)\s*\[\s*\]\s*(?:__attribute__\s*\(\([^)]*\)\)\s*)?=\s*INC(?:GFX|BIN)_U(?:8|16|32)\(\s*"([^"]+)"\s*((?:,\s*"[^"]*"\s*)*)\)/g;

/* `TRUE`/`FALSE` config switches. P_GBA_STYLE_SPECIES_GFX is the one that
   decides which half of every species folder the game actually loads. */
const CONFIG_RE = /^[ \t]*#define[ \t]+(P_\w+)[ \t]+(TRUE|FALSE)[ \t]*(?:\/[/*].*)?$/gm;

/* The object-event chain. Four hops, each one a plain pattern:
     picture symbol → frame table → graphics info → palette tag → palette symbol
   It exists because many pictures share one palette — every Brendan pose uses
   gObjectEventPal_Brendan — which is exactly why the name cannot be trusted. */
const PIC_TABLE_RE = /struct\s+SpriteFrameImage\s+(\w+)\s*\[\s*\]\s*=\s*\{([\s\S]*?)\}\s*;/g;
/* Three frame macros are in use — obj_frame_tiles, overworld_frame and
   overworld_ascending_frames — and all three take the picture symbol first.
   Matching any lowercase call whose first argument is a picture symbol covers
   a fork that adds a fourth, which the decomp's own history suggests it will. */
const FRAME_RE = /\b[a-z_]+\(\s*(g\w*Pic\w*)\s*[,)]/g;
const GFX_INFO_RE = /struct\s+ObjectEventGraphicsInfo\s+\w+\s*=\s*\{([\s\S]*?)\}\s*;/g;
const PAL_TAG_ROW_RE = /\{\s*(\w+)\s*,\s*(OBJ_EVENT_PAL_TAG_\w+)\s*\}/g;

const stripExt = (p) => p.replace(/\.[^./]+$/, '');
const dirOf = (p) => p.slice(0, p.lastIndexOf('/') + 1);
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const nameOf = (p) => stripExt(baseOf(p));

/* One declaration → everything it tells us, as a list, because a declaration
   can name more than one file:

     INCBIN_U32("…/brendan/walking.4bpp", "…/brendan/running.4bpp")

   concatenates two sheets under one symbol. Reading the second argument as a
   format spec — which is what it is in the INCGFX form — lost 111 object-event
   pictures. So arguments are told apart by shape rather than by position: one
   starting with a dot is a format, one starting with a dash is a gbagfx flag,
   and anything else is a file.

   Returns [] for the lines naming something we do not care about (tilemaps and
   other .bin blobs). */
function readDeclaration(symbol, args) {
    const files = args.filter(a => a && a[0] !== '.' && a[0] !== '-');
    const format = args.find(a => a && a[0] === '.') || null;
    if (!files.length) return [];

    // The format, when given, applies to every file the line names. Otherwise
    // each path carries its own in the extension.
    const formatBpp = format && /\.(\d)bpp/.exec(format);
    const formatPal = format && /gbapal/.test(format);

    const out = [];
    for (const file of files) {
        const own = /\.(\d)bpp$/.exec(file);
        const ownPal = /\.(gbapal|pal)$/.test(file);
        const bpp = formatBpp || own;
        if (bpp) {
            // A spec means the path is a real file; otherwise the path carries
            // the format and the artwork beside it is the .png.
            out.push({
                symbol, kind: 'gfx', depth: Number(bpp[1]),
                path: own ? stripExt(file) + '.png' : file
            });
        } else if (formatPal || ownPal) {
            /* A palette is often extracted from the artwork rather than from a
               .pal file — `INCGFX_U16("…/water_splash.png", ".gbapal")` builds
               the palette out of that PNG's own table. Rewriting the path to
               `.pal` invented a file that is not there, and the resolver then
               dropped the declaration for not existing: it resolved *fewer*
               assets than were declared, which is how this was noticed. Only
               synthesise when the path itself carries `.gbapal`. */
            out.push({
                symbol, kind: 'palette', depth: null,
                path: /\.gbapal$/.test(file) ? stripExt(file) + '.pal' : file
            });
        }
    }
    return out;
}

/* Read every declaration in the project. `sources` is [{ path, text }] — the
   caller decides what counts as a source file, because that differs between
   desktop and browser mode and neither of them belongs in here. */
export function parseDeclarations(sources) {
    const pathBySymbol = new Map();
    const pathsBySymbol = new Map();   // one symbol can name several files
    const symbolsByPath = new Map();
    const depthByPath = new Map();
    const palettePaths = new Set();

    for (const src of sources || []) {
        const text = src && src.text;
        if (!text) continue;
        DECL_RE.lastIndex = 0;
        let m;
        while ((m = DECL_RE.exec(text))) {
            const args = [m[2], ...(m[3] || '').match(/"[^"]*"/g)?.map(s => s.slice(1, -1)) || []];
            for (const decl of readDeclaration(m[1], args)) {
                /* One symbol can name several files. Keep the first for the
                   symbol→path direction (it is the one the symbol is named
                   after) but record every file in the reverse direction. */
                if (!pathBySymbol.has(decl.symbol)) pathBySymbol.set(decl.symbol, decl.path);
                if (!pathsBySymbol.has(decl.symbol)) pathsBySymbol.set(decl.symbol, []);
                if (!pathsBySymbol.get(decl.symbol).includes(decl.path)) {
                    pathsBySymbol.get(decl.symbol).push(decl.path);
                }
                if (!symbolsByPath.has(decl.path)) symbolsByPath.set(decl.path, []);
                if (!symbolsByPath.get(decl.path).includes(decl.symbol)) {
                    symbolsByPath.get(decl.path).push(decl.symbol);
                }
                if (decl.kind === 'palette') palettePaths.add(decl.path);
                /* A file can be declared more than once — the _gba branch of an
                   #if, say. The depths agree in practice; keep the first and do
                   not pretend to arbitrate. */
                if (decl.depth && !depthByPath.has(decl.path)) depthByPath.set(decl.path, decl.depth);
            }
        }
    }
    return { pathBySymbol, pathsBySymbol, symbolsByPath, depthByPath, palettePaths };
}

/* The config switches, as booleans. */
export function parseConfig(sources) {
    const out = {};
    for (const src of sources || []) {
        const text = src && src.text;
        if (!text) continue;
        CONFIG_RE.lastIndex = 0;
        let m;
        while ((m = CONFIG_RE.exec(text))) out[m[1]] = m[2] === 'TRUE';
    }
    return out;
}

/* Palettes paired to pictures by the symbol they share.
     gTrainerFrontPic_Brendan ↔ gTrainerPalette_Brendan
   Nails all 156 trainer front pics on expansion 1.16.4, and costs nothing.
   Deliberately narrow: it only fires when both halves are declared and the
   prefixes are a known pair, so it cannot invent a relationship. */
const SUFFIX_PAIRS = [
    ['gTrainerFrontPic_', 'gTrainerPalette_'],
    ['gTrainerBackPic_', 'gTrainerBackPalette_'],
    ['gMonFrontPic_', 'gMonPalette_'],
    ['gMonBackPic_', 'gMonPalette_'],
    ['gObjectEventPic_', 'gObjectEventPal_']
];

function suffixPairs(pathsBySymbol) {
    const pairs = new Map();
    const add = (pic, pal) => {
        if (!pairs.has(pic)) pairs.set(pic, []);
        if (!pairs.get(pic).includes(pal)) pairs.get(pic).push(pal);
    };
    for (const [symbol, paths] of pathsBySymbol) {
        for (const [picPrefix, palPrefix] of SUFFIX_PAIRS) {
            if (!symbol.startsWith(picPrefix)) continue;
            const tail = symbol.slice(picPrefix.length);
            for (const palPath of (pathsBySymbol.get(palPrefix + tail) || [])) {
                for (const path of paths) add(path, palPath);
            }
        }
    }
    return pairs;
}

/* The object-event chain, walked. Anything that breaks mid-chain is dropped
   rather than half-resolved — a wrong palette shown confidently is worse than
   no palette shown at all. */
function objectEventPairs(sources, pathsBySymbol) {
    const picsByTable = new Map();      // sPicTable_X → [picture symbols]
    const tagByTable = new Map();       // sPicTable_X → OBJ_EVENT_PAL_TAG_Y
    const palByTag = new Map();         // OBJ_EVENT_PAL_TAG_Y → gObjectEventPal_Z

    for (const src of sources || []) {
        const text = src && src.text;
        if (!text) continue;

        PIC_TABLE_RE.lastIndex = 0;
        let m;
        while ((m = PIC_TABLE_RE.exec(text))) {
            const syms = [];
            FRAME_RE.lastIndex = 0;
            let f;
            while ((f = FRAME_RE.exec(m[2]))) if (!syms.includes(f[1])) syms.push(f[1]);
            if (syms.length) picsByTable.set(m[1], syms);
        }

        GFX_INFO_RE.lastIndex = 0;
        while ((m = GFX_INFO_RE.exec(text))) {
            const body = m[1];
            const tag = /\.paletteTag\s*=\s*(OBJ_EVENT_PAL_TAG_\w+)/.exec(body);
            const images = /\.images\s*=\s*(\w+)/.exec(body);
            if (tag && images) tagByTable.set(images[1], tag[1]);
        }

        PAL_TAG_ROW_RE.lastIndex = 0;
        while ((m = PAL_TAG_ROW_RE.exec(text))) {
            // The row is {symbol, TAG}; guard against a stray literal matching.
            if (/^g\w*Pal/.test(m[1])) palByTag.set(m[2], m[1]);
        }
    }

    const pairs = new Map();
    for (const [table, syms] of picsByTable) {
        const tag = tagByTable.get(table);
        if (!tag) continue;
        const palSymbol = palByTag.get(tag);
        if (!palSymbol) continue;
        const palPaths = pathsBySymbol.get(palSymbol) || [];
        if (!palPaths.length) continue;
        for (const sym of syms) {
            for (const picPath of (pathsBySymbol.get(sym) || [])) {
                if (!pairs.has(picPath)) pairs.set(picPath, []);
                for (const palPath of palPaths) {
                    if (!pairs.get(picPath).includes(palPath)) pairs.get(picPath).push(palPath);
                }
            }
        }
    }
    return pairs;
}

/* The whole index, in one pass over the project's source. */
export function buildIndex(sources) {
    const decls = parseDeclarations(sources);
    const config = parseConfig(sources);

    /* Both rules contribute, chain first. The chain is the better authority
       where they disagree — the suffix rule pairs each Brendan pose with a
       palette of its own, and only the chain knows they all share one — but it
       must not *replace* the suffix answer, because it can also land on a
       shared NPC tag whose palette is chosen at runtime and has no file. Doing
       that lost 31 correct pairings in `pokemon_old` while fixing 102 in
       `people`. Offer both, best first, and let the caller's `exists` drop
       whichever points at nothing. */
    const declared = new Map();
    const merge = (from) => {
        for (const [pic, pals] of from) {
            if (!declared.has(pic)) declared.set(pic, []);
            const into = declared.get(pic);
            for (const pal of pals) if (!into.includes(pal)) into.push(pal);
        }
    };
    merge(objectEventPairs(sources, decls.pathsBySymbol));
    merge(suffixPairs(decls.pathsBySymbol));

    return {
        pathBySymbol: decls.pathBySymbol,
        pathsBySymbol: decls.pathsBySymbol,
        symbolsByPath: decls.symbolsByPath,
        depthByPath: decls.depthByPath,
        palettePaths: decls.palettePaths,
        declaredPalettes: declared,
        config,
        stats: {
            symbols: decls.pathBySymbol.size,
            depths: decls.depthByPath.size,
            pairs: declared.size,
            configFlags: Object.keys(config).length
        }
    };
}

/* ── Which artwork the game actually loads ────────────────────────────────
   Every species ships `anim_front.png` and `anim_front_gba.png`, `normal.pal`
   and `normal_gba.pal`. P_GBA_STYLE_SPECIES_GFX picks one set; the other is
   dead weight in that build. Painting the dead one for an hour is a real way
   to lose an afternoon, and nothing in the file says which it is. */
export function variantOf(path) {
    return /_gba\.(png|pal)$/i.test(path || '') ? 'gba' : 'standard';
}

export function liveVariant(config) {
    if (!config) return null;
    if (typeof config.P_GBA_STYLE_SPECIES_GFX !== 'boolean') return null;
    return config.P_GBA_STYLE_SPECIES_GFX ? 'gba' : 'standard';
}

/* True/false/null — null meaning the project did not say, which is different
   from "no". Only meaningful for species artwork, where the pair exists. */
export function isLiveAsset(path, config) {
    const live = liveVariant(config);
    if (!live) return null;
    if (!/graphics\/pokemon\//i.test(path || '')) return null;
    return variantOf(path) === live;
}

/* ── Target depth ─────────────────────────────────────────────────────────
   The project's declaration first, because it is the only authority. */
export function targetDepthFor(path, index) {
    if (!index || !index.depthByPath) return null;
    const direct = index.depthByPath.get(path);
    if (direct) return direct;
    // Windows paths and leading ./ turn up in scan output; normalise and retry.
    const norm = String(path || '').replace(/\\/g, '/').replace(/^\.?\//, '');
    return index.depthByPath.get(norm) || null;
}

/* ── Palette resolution ───────────────────────────────────────────────────
   Ordered best-first, each with a `why` the panel can show, because "which
   palette is this?" is a question the artist has to be able to check rather
   than take on trust. `exists` is optional; when the caller can say which
   files the scan actually found, conventions that point at nothing are
   dropped instead of offered. */
export function palettesFor(path, opts) {
    const o = opts || {};
    const index = o.index || null;
    const exists = typeof o.exists === 'function' ? o.exists : null;
    const p = String(path || '').replace(/\\/g, '/');
    const dir = dirOf(p);
    const name = nameOf(p);
    const out = [];
    const seen = new Set();

    const push = (palPath, why) => {
        if (!palPath || seen.has(palPath)) return;
        if (exists && !exists(palPath)) return;
        seen.add(palPath);
        out.push({ path: palPath, label: nameOf(palPath), why });
    };

    // 1. What the project actually says.
    if (index && index.declaredPalettes) {
        for (const declaredPath of (index.declaredPalettes.get(p) || [])) {
            push(declaredPath, 'declared in the project');
        }
    }

    const gba = variantOf(p) === 'gba';
    const suffix = gba ? '_gba' : '';

    // 2. Conventions, in the order the decomp actually uses them.
    if (/graphics\/pokemon\//i.test(p)) {
        if (name.replace(/_gba$/, '') === 'footprint') {
            // 1bpp, two colours, no palette file anywhere. Say so by saying
            // nothing rather than offering the species palette.
        } else if (/overworld/i.test(name)) {
            push(dir + 'overworld_normal.pal', 'the species’ overworld palette');
            push(dir + 'overworld_shiny.pal', 'the species’ shiny overworld palette');
        } else if (/^icon/i.test(name)) {
            /* Icons do not have their own palette: they share six, and which one
               a species uses is `.iconPalIndex` in its species entry. Offer the
               lot rather than pick wrong. Both spellings are in the wild —
               expansion has pal0..pal5, older pokeemerald icon_palette_0..2. */
            const iconDir = 'graphics/pokemon/icon_palettes/';
            for (let i = 0; i < 6; i++) push(iconDir + 'pal' + i + '.pal', 'a shared icon palette');
            for (let i = 0; i < 3; i++) push(iconDir + 'icon_palette_' + i + '.pal', 'a shared icon palette');
        } else {
            push(dir + 'normal' + suffix + '.pal', 'the species’ normal palette');
            push(dir + 'shiny' + suffix + '.pal', 'the species’ shiny palette');
            /* A form folder (bulbasaur/gmax/) often has no palettes of its own
               and uses the species'. Look one level up before giving in. */
            const up = dirOf(dir.replace(/\/$/, ''));
            if (up && up !== dir) {
                push(up + 'normal' + suffix + '.pal', 'the base species’ normal palette');
                push(up + 'shiny' + suffix + '.pal', 'the base species’ shiny palette');
            }
        }
    }

    // Tilesets keep sixteen numbered palettes in a folder beside the sheet.
    if (/\/tilesets\//i.test(p)) {
        for (let i = 0; i < 16; i++) {
            push(dir + 'palettes/' + String(i).padStart(2, '0') + '.pal', 'tileset palette ' + i);
        }
    }

    // Battle backdrops keep theirs beside the tiles, plus named variants.
    if (/battle_environment\//i.test(p)) push(dir + 'palette.pal', 'the backdrop palette');

    /* Trainers and object events keep palettes in a sibling *folder*, which is
       the rule the old code did not have (F4). Name-matching only works for
       half of them, which is why the declarations above come first. */
    const parent = dirOf(dir.replace(/\/$/, ''));
    if (parent) push(parent + 'palettes/' + name + '.pal', 'the sibling palettes folder');
    push(dir + 'palettes/' + name + '.pal', 'the sibling palettes folder');

    // Same folder, same name — the simplest case, and still common.
    push(dir + name + '.pal', 'the file beside it');
    if (gba) push(dir + name.replace(/_gba$/, '') + '.pal', 'the file beside it');

    return out;
}

/* ── One record per asset ─────────────────────────────────────────────────
   The thing everything above this layer actually consumes. `png` carries what
   the file itself said (shape, depth, palette size) when the caller has
   decoded it; everything else comes from the project. */
export function describeAsset(path, opts) {
    const o = opts || {};
    const index = o.index || null;
    const p = String(path || '').replace(/\\/g, '/');
    return {
        path: p,
        name: baseOf(p),
        symbols: (index && index.symbolsByPath && index.symbolsByPath.get(p)) || [],
        targetDepth: targetDepthFor(p, index),
        variant: variantOf(p),
        live: isLiveAsset(p, index && index.config),
        palettes: palettesFor(p, o),
        png: o.png || null
    };
}

if (typeof window !== 'undefined') {
    window.ProjectModel = {
        parseDeclarations, parseConfig, buildIndex, palettesFor,
        targetDepthFor, describeAsset, variantOf, liveVariant, isLiveAsset
    };
}
