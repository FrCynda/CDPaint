/* Sprite coordinates, checked against fixtures and against a real decomp.
 *
 * The fixtures pin the parsing and the rewriting. The decomp run is the claim
 * that matters: that y_offset really is a function of the artwork, so telling
 * someone theirs is wrong is a fact rather than an opinion. It reproduces the
 * numbers quoted at the top of src/js/sprite-coords.js, which is what stops
 * those numbers rotting into folklore.
 *
 *   node test/sprite-coords.test.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import * as SC from '../src/js/sprite-coords.js';
import * as PM from '../src/js/project-model.js';
import { readIndexedPng } from './png-read.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let passed = 0, failed = 0;
const check = (name, ok, detail) => {
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

/* A 64×64 frame with a solid block in it, so the expected answer is arithmetic
   rather than a second implementation of the thing under test. */
function frameWithBlock(x0, y0, w, h, frames = 1) {
    const px = new Uint8Array(64 * 64 * frames);
    for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) px[y * 64 + x] = 5;
    }
    return px;
}

console.log('bounds and coordinates');
{
    const px = frameWithBlock(13, 14, 38, 39);
    const b = SC.boundsOf(px, 64, 64, 0, 0);
    check('the bounding box is the drawn pixels, nothing else',
        b.minX === 13 && b.minY === 14 && b.maxX === 50 && b.maxY === 52,
        JSON.stringify(b));
    const c = SC.coordsFromBounds(b);
    check('size rounds up to whole tiles', c.width === 40 && c.height === 40,
        `${c.width}x${c.height}`);
    check('y_offset counts from the bottom edge of the frame', c.yOffset === 11,
        String(c.yOffset));
    check('and encodes the way the GBA reads it',
        c.size === SC.encodeSize(40, 40) && SC.decodeSize(c.size).w === 40);

    const touching = SC.coordsFromBounds(SC.boundsOf(frameWithBlock(0, 0, 64, 64), 64, 64, 0, 0));
    check('artwork touching the bottom is offset zero', touching.yOffset === 0);
    check('an empty frame measures as nothing rather than as everything',
        SC.boundsOf(new Uint8Array(64 * 64), 64, 64, 0, 0) === null);
    check('a sheet measures the frame asked for, in that frame’s own coordinates',
        (() => {
            const sheet = new Uint8Array(64 * 128);
            sheet.set(frameWithBlock(10, 20, 4, 4), 0);
            for (let y = 100; y < 104; y++) for (let x = 30; x < 34; x++) sheet[y * 64 + x] = 7;
            const f1 = SC.boundsOf(sheet, 64, 128, 0, 1);
            return f1.minX === 30 && f1.minY === 36;
        })());
    check('a frame past the end of the sheet is refused',
        SC.boundsOf(new Uint8Array(64 * 64), 64, 64, 0, 1) === null);
}

console.log('\nwhat counts as wrong');
{
    const computed = SC.coordsFromBounds(SC.boundsOf(frameWithBlock(12, 12, 40, 40), 64, 64, 0, 0));
    check('agreement reports nothing at all',
        SC.compareCoords(computed, { size: { w: 40, h: 40 }, yOffset: computed.yOffset }).length === 0);
    const sunk = SC.compareCoords(computed, { size: { w: 40, h: 40 }, yOffset: computed.yOffset + 4 });
    check('too large an offset pushes the sprite down, and is called sinking',
        sunk.length === 1 && sunk[0].field === 'yOffset' && /4px too low/.test(sunk[0].text),
        sunk[0] && sunk[0].text);
    const floating = SC.compareCoords(computed, { size: { w: 40, h: 40 }, yOffset: computed.yOffset - 4 });
    check('and too small an offset leaves it floating',
        /4px too high/.test(floating[0].text), floating[0] && floating[0].text);
    const small = SC.compareCoords(computed, { size: { w: 32, h: 40 }, yOffset: computed.yOffset });
    check('a size smaller than the artwork is a fault',
        small.length === 1 && small[0].severity === 'wrong', JSON.stringify(small));
    const big = SC.compareCoords(computed, { size: { w: 64, h: 64 }, yOffset: computed.yOffset });
    check('a size larger than the artwork is not — the decomp ships hundreds',
        big.length === 1 && big[0].severity === 'loose', JSON.stringify(big));
}

console.log('\nreading the declarations');
{
    const expansion = `
    [SPECIES_BULBASAUR] =
    {
        .frontPic = gMonFrontPic_Bulbasaur,
        .frontPicSize = P_GBA_STYLE_SPECIES_GFX ? MON_COORDS_SIZE(32, 40) : MON_COORDS_SIZE(40, 40),
        .frontPicYOffset = P_GBA_STYLE_SPECIES_GFX ? 14 : 13,
        .backPic = gMonBackPic_Bulbasaur,
        .backPicSize = MON_COORDS_SIZE(56, 40),
        .backPicYOffset = 13, // hand-checked
    },
    [SPECIES_IVYSAUR] =
    {
        .frontPic = gMonFrontPic_Ivysaur,
        .frontPicSize = MON_COORDS_SIZE(56, 48),
        .frontPicYOffset = 8,
    },
`;
    const recs = SC.parseSpeciesCoords([{ path: 'species_info/gen_1_families.h', text: expansion }]);
    const front = recs.filter(r => r.species === 'SPECIES_BULBASAUR' && r.kind === 'front');
    check('a ternary is read as two declarations, one per artwork set',
        front.length === 2 && front.some(r => r.variant === 'standard') && front.some(r => r.variant === 'gba'),
        JSON.stringify(front.map(r => r.variant)));
    const std = front.find(r => r.variant === 'standard');
    const gba = front.find(r => r.variant === 'gba');
    check('the standard branch is the one after the colon',
        std.size.w === 40 && std.size.h === 40 && std.yOffset === 13,
        JSON.stringify(std.size) + ' y' + std.yOffset);
    check('and the _gba branch the one before it',
        gba.size.w === 32 && gba.size.h === 40 && gba.yOffset === 14);
    check('it carries the symbol that names the artwork',
        std.symbol === 'gMonFrontPic_Bulbasaur', std.symbol);
    const back = recs.filter(r => r.species === 'SPECIES_BULBASAUR' && r.kind === 'back');
    check('a plain value is one declaration covering both sets',
        back.length === 1 && back[0].variant === 'any' && back[0].yOffset === 13,
        JSON.stringify(back.map(r => r.variant)));
    check('a trailing comment is not read as part of the value',
        back[0].yOffset === 13 && back[0].size.w === 56);
    check('the next species is not swallowed by the previous one',
        recs.some(r => r.species === 'SPECIES_IVYSAUR' && r.yOffset === 8));

    const vanilla = `
const struct MonCoords gMonFrontPicCoords[] =
{
    [SPECIES_NONE] = {.size = MON_COORDS_SIZE(64, 64), .y_offset = 0},
    [SPECIES_BULBASAUR] = {.size = MON_COORDS_SIZE(40, 40), .y_offset = 13},
    [SPECIES_IVYSAUR] = {.size = MON_COORDS_SIZE(56, 48), .y_offset = 8},
};
`;
    const v = SC.parseSpeciesCoords([{ path: 'src/data/pokemon_graphics/front_pic_coordinates.h', text: vanilla }]);
    check('vanilla’s coordinate table is read too',
        v.length === 3 && v[1].species === 'SPECIES_BULBASAUR' && v[1].yOffset === 13,
        JSON.stringify(v.map(r => r.species)));
    check('and the table says which pic it is about',
        v.every(r => r.kind === 'front'));
    check('a fork that inlined the macro still parses',
        SC.parseSpeciesCoords([{
            path: 'x.h',
            text: 'const struct MonCoords gMonFrontPicCoords[] = {\n[SPECIES_X] = {.size = 0x55, .y_offset = 3},\n};'
        }])[0].size.w === 40);
}

console.log('\nwriting a correction back');
{
    const text = `        .frontPicYOffset = P_GBA_STYLE_SPECIES_GFX ? 14 : 13,\n`;
    const rec = SC.parseSpeciesCoords([{ path: 'a.h', text: '[SPECIES_X] =\n{\n' + text + '}' }]);
    const std = rec.find(r => r.variant === 'standard');
    const whole = '[SPECIES_X] =\n{\n' + text + '}';
    const patched = SC.patchCoord(whole, std.yAt, '9');
    check('only the branch being corrected changes',
        patched.includes('P_GBA_STYLE_SPECIES_GFX ? 14 : 9,'), patched.trim());
    check('and the file is otherwise byte-identical',
        patched.replace('? 14 : 9', '? 14 : 13') === whole);
    const gba = rec.find(r => r.variant === 'gba');
    check('the other branch is reachable on its own',
        SC.patchCoord(whole, gba.yAt, '7').includes('? 7 : 13'));

    const sizeText = '[SPECIES_X] =\n{\n    .frontPicSize = MON_COORDS_SIZE(40, 40),\n    .frontPicYOffset = 3,\n}';
    const sr = SC.parseSpeciesCoords([{ path: 'a.h', text: sizeText }])[0];
    check('a size containing its own comma is replaced whole',
        SC.patchCoord(sizeText, sr.sizeAt, SC.formatSize(56, 48))
            .includes('.frontPicSize = MON_COORDS_SIZE(56, 48),'),
        SC.patchCoord(sizeText, sr.sizeAt, SC.formatSize(56, 48)));
    check('and re-parsing the patched text reads the new value',
        SC.parseSpeciesCoords([{
            path: 'a.h', text: SC.patchCoord(sizeText, sr.sizeAt, SC.formatSize(56, 48))
        }])[0].size.h === 48);
}

/* ── Against a real decomp ────────────────────────────────────────────── */
const CANDIDATES = [
    process.env.CDPAINT_DECOMP,
    join(ROOT, '..', 'pokeemerald-expansion'),
    join(ROOT, '..', 'pokeemerald')
].filter(Boolean);
const decomp = CANDIDATES.find(p => existsSync(join(p, 'graphics')));

if (!decomp) {
    console.log('\nreal decomp');
    console.log('  skip  none found — set CDPAINT_DECOMP or clone one beside the repo');
} else {
    console.log(`\nreal decomp  (${relative(join(ROOT, '..'), decomp).replace(/\\/g, '/')})`);
    const walk = (dir, test, out = []) => {
        let names;
        try { names = readdirSync(dir); } catch { return out; }
        for (const n of names) {
            if (n === '.git' || n === 'build' || n === 'tools') continue;
            const f = join(dir, n);
            let st;
            try { st = statSync(f); } catch { continue; }
            if (st.isDirectory()) walk(f, test, out);
            else if (test(n)) out.push(f);
        }
        return out;
    };
    const sources = [
        ...walk(join(decomp, 'src'), n => /\.(c|h|inc)$/.test(n)),
        ...walk(join(decomp, 'include'), n => /\.(c|h|inc)$/.test(n))
    ].map(f => ({ path: relative(decomp, f).replace(/\\/g, '/'), text: readFileSync(f, 'utf8') }));

    const index = PM.buildIndex(sources);
    const t0 = Date.now();
    const records = SC.parseSpeciesCoords(sources);
    const byPath = SC.coordsIndex(records, index);
    const ms = Date.now() - t0;
    console.log(`  ${records.length} declared coordinates over ${byPath.size} files, in ${ms}ms`);

    let measured = 0, yExact = 0, sizeExact = 0, sizeAtLeast = 0;
    const drift = new Map();
    for (const [path, recs] of byPath) {
        const file = join(decomp, path);
        if (!existsSync(file)) continue;
        const png = readIndexedPng(readFileSync(file));
        if (!png || png.width < 64) continue;
        const c = SC.coordsFromBounds(SC.boundsOf(png.indices, png.width, png.height, png.transparentIndex, 0));
        if (!c) continue;
        for (const r of recs) {
            if (typeof r.yOffset !== 'number' || !r.size) continue;
            measured++;
            const d = c.yOffset - r.yOffset;
            drift.set(d, (drift.get(d) || 0) + 1);
            if (d === 0) yExact++;
            if (r.size.w === c.width && r.size.h === c.height) sizeExact++;
            if (r.size.w >= c.width && r.size.h >= c.height) sizeAtLeast++;
        }
    }

    const pct = (n) => `${n}/${measured} (${(n / measured * 100).toFixed(1)}%)`;
    console.log(`  measured ${measured} entries against their artwork`);
    console.log(`  y_offset exact          ${pct(yExact)}`);
    console.log(`  size exact              ${pct(sizeExact)}`);
    console.log(`  size at least the art   ${pct(sizeAtLeast)}`);
    const worst = [...drift].filter(([d]) => d !== 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (worst.length) console.log(`  commonest disagreements: ${worst.map(([d, n]) => `${d > 0 ? '+' : ''}${d}px ×${n}`).join(', ')}`);

    check('enough of the project was read to mean anything', measured > 1000, String(measured));
    /* The claim the feature rests on. Not 100%: a handful of species really are
       misplaced in the decomp, and this tool exists to say so. But 99% is what
       makes the other 1% worth reporting instead of noise. */
    check('y_offset is a function of the artwork', yExact / measured > 0.97, pct(yExact));
    /* And the claim the feature deliberately does *not* make. If this ever went
       above ~0.95 the size rule could tighten; while it sits at ~0.7, calling a
       loose size wrong would be crying wolf on a quarter of the project. */
    check('size is an upper bound, not a computed value',
        sizeExact / measured < 0.95 && sizeAtLeast / measured > 0.98,
        `exact ${pct(sizeExact)}, at least ${pct(sizeAtLeast)}`);
    check('the declarations parse fast enough to do at hook time', ms < 4000, `${ms}ms`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
