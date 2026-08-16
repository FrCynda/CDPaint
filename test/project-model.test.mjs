/* The asset model, checked twice: against fixtures we wrote, and against a real
 * decomp when one is present.
 *
 * The fixtures pin the behaviour. The decomp run is what stops the behaviour
 * being confidently wrong — every rule in here was written from a repo somebody
 * else wrote, and the numbers below are the evidence that it still reads it.
 *
 * Pure text in, data out, so this needs no browser and runs in a second.
 *
 *   node test/project-model.test.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import * as PM from '../src/js/project-model.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let passed = 0, failed = 0;
const check = (name, ok, detail) => {
    if (ok) { passed++; console.log(`  ok   ${name}`); }
    else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

/* ── Fixtures ─────────────────────────────────────────────────────────── */
console.log('declarations');
{
    const sources = [{
        path: 'src/graphics.c',
        text: `
const u32 gMonFrontPic_Bulbasaur[] = INCGFX_U32("graphics/pokemon/bulbasaur/anim_front.png", ".4bpp.smol");
const u16 gMonPalette_Bulbasaur[] = INCGFX_U16("graphics/pokemon/bulbasaur/normal.pal", ".gbapal");
const u32 gBattleAnimSplash[] = INCGFX_U32("graphics/battle_anims/unused/water_splash.png", ".8bpp.smol");
const u32 gFooTiles[] = INCBIN_U32("graphics/foo/tiles.4bpp");
const u32 gFooMap[] = INCGFX_U32("graphics/foo/bg.bin", ".smolTM");
const u8 gCrashFont[] = INCBIN_U8("graphics/crash_screen/font.1bpp");
`}];
    const idx = PM.buildIndex(sources);
    check('reads the two-argument INCGFX form',
        idx.depthByPath.get('graphics/pokemon/bulbasaur/anim_front.png') === 4);
    check('reads an 8bpp declaration as 8bpp',
        idx.depthByPath.get('graphics/battle_anims/unused/water_splash.png') === 8);
    check('reads the one-argument INCBIN form, implying the .png',
        idx.depthByPath.get('graphics/foo/tiles.png') === 4);
    check('reads 1bpp', idx.depthByPath.get('graphics/crash_screen/font.png') === 1);
    check('ignores tilemaps and other blobs',
        !idx.depthByPath.has('graphics/foo/bg.bin') && !idx.depthByPath.has('graphics/foo/bg.png'));
    check('records palette declarations as palettes',
        idx.palettePaths.has('graphics/pokemon/bulbasaur/normal.pal'));
    check('maps symbol to file',
        idx.pathBySymbol.get('gMonFrontPic_Bulbasaur') === 'graphics/pokemon/bulbasaur/anim_front.png');
    check('targetDepthFor tolerates a windows path',
        PM.targetDepthFor('graphics\\foo\\tiles.png', idx) === 4);
    check('and says null rather than guessing when nothing declares it',
        PM.targetDepthFor('graphics/never/declared.png', idx) === null);
}

console.log('\nconfig and live variants');
{
    const sources = [{
        path: 'include/config/pokemon.h',
        text: `
#define P_GBA_STYLE_SPECIES_GFX         FALSE       // By default, Gen 4/5's style.
#define P_GBA_STYLE_SPECIES_ICONS       TRUE
#define P_SOMETHING_ELSE                4
`}];
    const idx = PM.buildIndex(sources);
    check('reads FALSE and TRUE', idx.config.P_GBA_STYLE_SPECIES_GFX === false
        && idx.config.P_GBA_STYLE_SPECIES_ICONS === true);
    check('ignores non-boolean defines', !('P_SOMETHING_ELSE' in idx.config));
    check('the live variant is the standard set when the flag is off',
        PM.liveVariant(idx.config) === 'standard');
    check('a _gba asset is not the live one there',
        PM.isLiveAsset('graphics/pokemon/bulbasaur/anim_front_gba.png', idx.config) === false);
    check('and the plain one is',
        PM.isLiveAsset('graphics/pokemon/bulbasaur/anim_front.png', idx.config) === true);
    check('with the flag on it reverses',
        PM.isLiveAsset('graphics/pokemon/bulbasaur/anim_front_gba.png',
            { P_GBA_STYLE_SPECIES_GFX: true }) === true);
    check('a project that never says gets null, not false',
        PM.isLiveAsset('graphics/pokemon/bulbasaur/anim_front.png', {}) === null);
    check('and the question is meaningless off the species tree',
        PM.isLiveAsset('graphics/items/icons/potion.png', idx.config) === null);
}

console.log('\npalette resolution by convention');
{
    const all = new Set([
        'graphics/pokemon/bulbasaur/normal.pal',
        'graphics/pokemon/bulbasaur/shiny.pal',
        'graphics/pokemon/bulbasaur/normal_gba.pal',
        'graphics/pokemon/bulbasaur/overworld_normal.pal',
        'graphics/pokemon/icon_palettes/pal0.pal',
        'graphics/pokemon/lapras/normal.pal',
        'data/tilesets/primary/general/palettes/00.pal',
        'graphics/battle_environment/cave/palette.pal',
        'graphics/trainers/palettes/brendan.pal'
    ]);
    const exists = (p) => all.has(p);
    const paths = (p) => PM.palettesFor(p, { exists }).map(x => x.path);

    check('a front sprite gets normal then shiny, in that order',
        JSON.stringify(paths('graphics/pokemon/bulbasaur/anim_front.png')) ===
        JSON.stringify(['graphics/pokemon/bulbasaur/normal.pal', 'graphics/pokemon/bulbasaur/shiny.pal']),
        JSON.stringify(paths('graphics/pokemon/bulbasaur/anim_front.png')));
    check('a _gba sprite gets the _gba palette',
        paths('graphics/pokemon/bulbasaur/anim_front_gba.png')[0] ===
        'graphics/pokemon/bulbasaur/normal_gba.pal');
    check('an overworld sprite gets the overworld palette, not the battle one',
        paths('graphics/pokemon/bulbasaur/overworld.png')[0] ===
        'graphics/pokemon/bulbasaur/overworld_normal.pal');
    check('an icon is offered the shared icon palettes',
        paths('graphics/pokemon/bulbasaur/icon.png')[0] === 'graphics/pokemon/icon_palettes/pal0.pal');
    check('a footprint is offered nothing, because it has no palette',
        paths('graphics/pokemon/bulbasaur/footprint.png').length === 0);
    check('a form folder falls back to the base species',
        paths('graphics/pokemon/lapras/gmax/front.png')[0] === 'graphics/pokemon/lapras/normal.pal');
    check('a tileset gets its numbered palettes',
        paths('data/tilesets/primary/general/tiles.png')[0] ===
        'data/tilesets/primary/general/palettes/00.pal');
    check('a battle backdrop gets the one beside it',
        paths('graphics/battle_environment/cave/tiles.png')[0] ===
        'graphics/battle_environment/cave/palette.pal');
    check('a trainer gets the sibling palettes folder',
        paths('graphics/trainers/front_pics/brendan.png')[0] === 'graphics/trainers/palettes/brendan.pal');
    check('candidates that do not exist are not offered',
        !paths('graphics/pokemon/bulbasaur/anim_front.png').includes('graphics/pokemon/bulbasaur/shiny_gba.pal'));
    check('every candidate carries a reason',
        PM.palettesFor('graphics/pokemon/bulbasaur/anim_front.png', { exists })
            .every(c => typeof c.why === 'string' && c.why.length > 0));
}

console.log('\npalette resolution by declaration');
{
    const sources = [{
        path: 'src/data.h',
        text: `
const u32 gObjectEventPic_BrendanNormal[] = INCGFX_U32("graphics/object_events/pics/people/brendan/walking.png", ".4bpp");
const u32 gObjectEventPic_BrendanRunning[] = INCGFX_U32("graphics/object_events/pics/people/brendan/running.png", ".4bpp");
const u16 gObjectEventPal_Brendan[] = INCGFX_U16("graphics/object_events/palettes/brendan.pal", ".gbapal");
static const struct SpriteFrameImage sPicTable_BrendanNormal[] = {
    overworld_frame(gObjectEventPic_BrendanNormal, 2, 4, 0),
    overworld_frame(gObjectEventPic_BrendanRunning, 2, 4, 1),
};
const struct ObjectEventGraphicsInfo gObjectEventGraphicsInfo_BrendanNormal = {
    .tileTag = TAG_NONE,
    .paletteTag = OBJ_EVENT_PAL_TAG_BRENDAN,
    .images = sPicTable_BrendanNormal,
};
const struct SpritePalette sObjectEventSpritePalettes[] = {
    {gObjectEventPal_Brendan,  OBJ_EVENT_PAL_TAG_BRENDAN},
};
`}];
    const idx = PM.buildIndex(sources);
    const got = PM.palettesFor('graphics/object_events/pics/people/brendan/running.png', { index: idx });
    check('the object-event chain resolves a picture that shares a palette',
        got[0] && got[0].path === 'graphics/object_events/palettes/brendan.pal',
        JSON.stringify(got.map(g => g.path)));
    check('and says the project declared it',
        got[0] && /declared/.test(got[0].why), got[0] && got[0].why);
    check('both pictures in the frame table resolve to the one palette',
        PM.palettesFor('graphics/object_events/pics/people/brendan/walking.png', { index: idx })[0].path
        === 'graphics/object_events/palettes/brendan.pal');
    check('a broken chain resolves to nothing rather than to something wrong',
        PM.palettesFor('graphics/object_events/pics/nobody.png', { index: idx })
            .every(c => !/declared/.test(c.why)));
}

console.log('\nasset records');
{
    const idx = PM.buildIndex([{
        path: 'src/graphics.c',
        text: `const u32 gMonIcon_Bulbasaur[] = INCGFX_U32("graphics/pokemon/bulbasaur/icon.png", ".4bpp");
#define P_GBA_STYLE_SPECIES_GFX FALSE`
    }]);
    const rec = PM.describeAsset('graphics/pokemon/bulbasaur/icon.png', { index: idx });
    check('an asset record carries the declared depth, not the file’s',
        rec.targetDepth === 4, String(rec.targetDepth));
    check('and the symbol that names it',
        rec.symbols.includes('gMonIcon_Bulbasaur'), JSON.stringify(rec.symbols));
    check('and whether the game actually loads it', rec.live === true);
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

    const srcFiles = [
        ...walk(join(decomp, 'src'), n => /\.(c|h|inc)$/.test(n)),
        ...walk(join(decomp, 'include'), n => /\.(c|h|inc)$/.test(n))
    ];
    const sources = srcFiles.map(f => ({
        path: relative(decomp, f).replace(/\\/g, '/'),
        text: readFileSync(f, 'utf8')
    }));

    const t0 = Date.now();
    const idx = PM.buildIndex(sources);
    const ms = Date.now() - t0;

    const assets = walk(join(decomp, 'graphics'), n => n.toLowerCase().endsWith('.png'))
        .concat(walk(join(decomp, 'data'), n => n.toLowerCase().endsWith('.png')))
        .map(f => relative(decomp, f).replace(/\\/g, '/'));
    /* A palette is not always a .pal — `INCGFX_U16("…/water_splash.png",
       ".gbapal")` builds one out of the artwork's own table — so what exists()
       answers for is "did the scan find this file", not "is this a .pal". */
    const palSet = new Set(
        walk(join(decomp, 'graphics'), n => /\.(pal|png)$/i.test(n))
            .concat(walk(join(decomp, 'data'), n => /\.(pal|png)$/i.test(n)))
            .map(f => relative(decomp, f).replace(/\\/g, '/')));
    const exists = (p) => palSet.has(p);

    const withDepth = assets.filter(a => PM.targetDepthFor(a, idx));
    const withPal = assets.filter(a => PM.palettesFor(a, { index: idx, exists }).length);
    const objectEvents = assets.filter(a => a.startsWith('graphics/object_events/pics/'));
    const oeDeclared = objectEvents.filter(a =>
        PM.palettesFor(a, { index: idx, exists }).some(c => /declared/.test(c.why)));
    /* graphics/pokemon/ghost/ holds a front.png and nothing else — the
       unidentifiable ghost draws with a palette the game supplies, not one in
       the folder. So the claim is about sprites that *have* a palette to find,
       which is the only claim the resolver can be held to. */
    const species = assets.filter(a =>
        /^graphics\/pokemon\/[^/]+\/(anim_)?(front|back)(_gba)?\.png$/.test(a)
        && palSet.has(a.replace(/\/[^/]+$/, '/normal.pal')));
    const speciesPal = species.filter(a => PM.palettesFor(a, { index: idx, exists }).length >= 1);

    const pct = (n, d) => `${n}/${d} (${(n / d * 100).toFixed(0)}%)`;
    console.log(`  read ${sources.length} source files in ${ms}ms`);
    console.log(`  ${idx.stats.symbols} symbols · ${idx.stats.depths} declared depths · ` +
        `${idx.stats.pairs} declared pairings · ${idx.stats.configFlags} config flags`);
    console.log(`  depth known for ${pct(withDepth.length, assets.length)} of assets`);
    console.log(`  a palette for  ${pct(withPal.length, assets.length)} of assets`);
    console.log(`  object events declared: ${pct(oeDeclared.length, objectEvents.length)}`);

    check('the config flag that picks the artwork set is found',
        typeof idx.config.P_GBA_STYLE_SPECIES_GFX === 'boolean',
        JSON.stringify(idx.config.P_GBA_STYLE_SPECIES_GFX));
    check('most of the project declares its own depths',
        withDepth.length / assets.length > 0.8, pct(withDepth.length, assets.length));
    check('every species battle sprite resolves to a palette',
        speciesPal.length === species.length, pct(speciesPal.length, species.length));
    /* Not 100%, and it cannot be. Some object events choose their palette at
       run time rather than binding one: berry trees index a growth-stage slot
       table, and the old overworld Pokémon sprites take the species' palette
       through the OVERWORLD() macro rather than through the object-event
       tables. Those are different rules, not missing ones, and inventing an
       answer for them would be the F4 mistake again in a new place. What this
       guards is that the chain keeps resolving the ones that *are* bound. */
    check('object-event palettes come from the chain, not from luck',
        oeDeclared.length / Math.max(1, objectEvents.length) > 0.7,
        pct(oeDeclared.length, objectEvents.length));
    check('trainers resolve almost completely',
        (() => {
            const t = assets.filter(a => a.startsWith('graphics/trainers/'));
            const r = t.filter(a => PM.palettesFor(a, { index: idx, exists }).length);
            return r.length / Math.max(1, t.length) > 0.9;
        })());
    check('nothing is offered a palette file that is not there', (() => {
        for (const a of assets.slice(0, 2000)) {
            for (const c of PM.palettesFor(a, { index: idx, exists })) {
                if (!exists(c.path)) return false;
            }
        }
        return true;
    })());
    check('a known species reads back correctly', (() => {
        const r = PM.describeAsset('graphics/pokemon/bulbasaur/anim_front.png', { index: idx, exists });
        return r.targetDepth === 4 && r.palettes.length >= 2 &&
            r.palettes[0].path === 'graphics/pokemon/bulbasaur/normal.pal';
    })());
    check('the index builds fast enough to do at hook time', ms < 8000, `${ms}ms`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
