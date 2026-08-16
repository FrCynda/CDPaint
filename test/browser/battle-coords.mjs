/* The battle preview, and the coordinate verdict it puts under it.
 *
 * Phase 3.3 and 3.4. The claim being checked is narrow and worth stating: for a
 * sprite whose drawn pixels stop N rows above the bottom of its 64×64 frame,
 * the project must declare y_offset = N, and CDPaint must say so out loud when
 * it does not — with the right direction, because "your sprite floats" and
 * "your sprite sinks" send an artist to opposite ends of the canvas.
 *
 * The maths is unit-tested against a real decomp in test/sprite-coords.test.mjs.
 * What is checked here is the wiring: that the panel reads the *live* index map
 * of the open asset, follows the active frame, and offers a correction rather
 * than only a complaint.
 *
 *   node test/browser/battle-coords.mjs
 */
import { withPage } from '../browser.mjs';
import { makePng } from '../png-fixture.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

/* A two-frame 64×128 sheet, the shape every expansion species ships. Frame 0
   holds a block whose bottom row is `bottom0`; frame 1's is `bottom1`, so the
   two frames disagree and following the active one is observable. */
function sheet(bottom0, bottom1) {
    const w = 64, h = 128;
    const px = new Uint8Array(w * h);
    const block = (top, bottom, left, right, colour) => {
        for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) px[y * w + x] = colour;
    };
    block(bottom0 - 19, bottom0, 20, 43, 1);        // 24×20 in frame 0
    block(64 + bottom1 - 19, 64 + bottom1, 20, 43, 2);
    const palette = [[0, 0, 0], [240, 80, 80], [80, 240, 80], [255, 255, 255]];
    const trns = [0, 255, 255, 255];
    return makePng({ w, h, depth: 4, palette, trns, indices: px });
}

const PATH = 'graphics/pokemon/testmon/anim_front.png';

await withPage(async (page) => {
    console.log('battle preview and sprite coordinates');

    // Frame 0's art ends 8 rows above the frame bottom, frame 1's ends 3 above.
    const bytes = Array.from(sheet(55, 60));

    const res = await page.eval(`(async () => {
        const bytes = new Uint8Array(${JSON.stringify(bytes)});
        const ok = await PaintApp.applyProjectImageBytes(bytes, 'anim_front.png', ${JSON.stringify(PATH)}, []);
        if (!ok) return { error: 'applyProjectImageBytes returned false' };

        const out = { ok: true };
        out.frames = PaintApp.projectFrameLayout();
        const SC = window.SpriteCoords;
        out.hasModule = !!SC;
        if (!SC) return out;

        const idx = PaintApp.spriteIndices;
        const w = PaintApp.config.width, h = PaintApp.config.height;
        let ti = PaintApp.state.projectTransparentIndex;
        if (ti < 0) ti = 0;
        out.transparentIndex = ti;
        out.frame0 = SC.coordsFromBounds(SC.boundsOf(idx, w, h, ti, 0));
        out.frame1 = SC.coordsFromBounds(SC.boundsOf(idx, w, h, ti, 1));
        return out;
    })()`);

    check('the asset opened as a project image', res && res.ok && !res.error, res && res.error);

    /* Opening through a directory handle has no disk path to pass, and passing
       nothing left `state.projectFile` holding "anim_front.png" — which matches
       no profile, so the sheet stopped being two frames and became one 64×128
       picture, drawn into the battle scene at twice its proper height. Every
       decomp rule keys on this string; it has to be the project-relative path. */
    const handleOpen = await page.eval(`(async () => {
        const bytes = new Uint8Array(${JSON.stringify(bytes)});
        await PaintApp.applyProjectImageBytes(bytes, 'anim_front.png', '', [], ${JSON.stringify(PATH)});
        return {
            projectFile: PaintApp.state.projectFile,
            filePath: PaintApp.state.filePath,
            frames: PaintApp.projectFrameLayout()
        };
    })()`);
    check('a handle-opened asset keeps its project-relative identity',
        handleOpen.projectFile === PATH, handleOpen.projectFile);
    check('and is still cut into frames rather than read as one tall picture',
        handleOpen.frames && handleOpen.frames.count === 2 && handleOpen.frames.h === 64,
        JSON.stringify(handleOpen.frames));
    check('without inventing a disk path it cannot reopen from',
        handleOpen.filePath === '', JSON.stringify(handleOpen.filePath));
    check('sprite-coords is loaded in the page', res.hasModule);
    check('the sheet is read as two frames', res.frames && res.frames.count === 2,
        JSON.stringify(res.frames));
    check('transparency comes from tRNS slot 0', res.transparentIndex === 0, String(res.transparentIndex));
    check('frame 0 measures its own artwork',
        res.frame0 && res.frame0.yOffset === 8 && res.frame0.width === 24 && res.frame0.height === 24,
        JSON.stringify(res.frame0));
    check('frame 1 measures a different offset, from the same sheet',
        res.frame1 && res.frame1.yOffset === 3, JSON.stringify(res.frame1));

    /* The unhooked case first, and with the real PokeProject rather than a stub:
       most people open a PNG before they ever hook a decomp, and a panel that
       throws there is worse than one that says nothing. */
    const bare = await page.eval(`(async () => {
        window.BattlePreview.open();
        const panel = document.getElementById('battle-preview');
        return {
            coords: window.PokeProject.coordsFor(${JSON.stringify(PATH)}),
            model: window.PokeProject.model(),
            rel: window.PokeProject.rel('C:\\\\x\\\\graphics\\\\a.png'),
            visible: !panel.classList.contains('bp-collapsed'),
            text: panel.querySelector('.bp-readout').textContent
        };
    })()`);
    check('with no decomp hooked there are no declared coordinates',
        Array.isArray(bare.coords) && bare.coords.length === 0 && bare.model === null,
        JSON.stringify(bare.coords));
    check('and the readout says so rather than blaming the asset',
        /No decomp hooked/.test(bare.text), bare.text);
    check('a path with no project root behind it is passed through, slashes normalised',
        bare.rel === 'C:/x/graphics/a.png', bare.rel);
    check('the panel still measures the artwork and says why it cannot compare',
        bare.visible && /8px above the bottom edge/.test(bare.text) && /No decomp hooked/.test(bare.text),
        bare.text);

    /* The panel, against a project that declares the wrong offset. PokeProject
       is stubbed rather than hooked: hooking needs a decomp on disk and the
       thing under test is what the panel does with an answer, not where the
       answer came from. */
    const ui = await page.eval(`(async () => {
        const declared = {
            species: 'SPECIES_TESTMON', kind: 'front', variant: 'any',
            file: 'src/data/pokemon/species_info/test.h',
            size: { w: 24, h: 24 }, yOffset: 2,
            sizeAt: { start: 0, end: 1 }, yAt: { start: 0, end: 1 }
        };
        const written = [];
        window.PokeProject = Object.assign({}, window.PokeProject, {
            model: () => ({ root: '/coord-stub', sourceText: new Map() }),
            coordsFor: () => [declared],
            writeCoord: (rec, field, value) => { written.push([field, value]); return Promise.resolve(true); }
        });
        window.BattlePreview.open();
        const panel = document.getElementById('battle-preview');
        const out = {
            visible: !!panel && !panel.classList.contains('bp-collapsed'),
            text: panel ? panel.querySelector('.bp-readout').textContent : '',
            sceneW: panel ? panel.querySelector('.bp-scene').width : 0,
            sceneH: panel ? panel.querySelector('.bp-scene').height : 0
        };
        const fix = panel && panel.querySelector('.bp-fix');
        out.fixLabel = fix ? fix.textContent : null;
        if (fix) fix.click();
        await new Promise(r => setTimeout(r, 30));
        out.written = written;

        // Agreement must say so quietly rather than raise a fault.
        declared.yOffset = 8;
        window.BattlePreview.render();
        out.agreeText = panel.querySelector('.bp-readout').textContent;
        out.agreeFix = !!panel.querySelector('.bp-fix');

        // Closing has to survive the next repaint.
        window.BattlePreview.close();
        window.BattlePreview.render();
        out.stayedClosed = panel.classList.contains('bp-collapsed');
        return out;
    })()`);

    check('the panel shows for a battle sprite', ui.visible);
    check('the scene is a 240×160 screen at an integer scale',
        ui.sceneW % 240 === 0 && ui.sceneH % 160 === 0 && ui.sceneW / 240 === ui.sceneH / 160,
        `${ui.sceneW}×${ui.sceneH}`);

    /* This file opens with a global `canvas { position: absolute }`. A canvas
       that does not opt out leaves the flow entirely: it paints from the panel's
       top-left over the title bar, the panel collapses to the height of the text
       around it, and the scene spills across the app underneath. It looked like
       a translucent sheet of colour dumped over the toolbar. Cheap to assert,
       and the failure mode is pure confusion. */
    const flow = await page.eval(`(() => {
        window.BattlePreview.open();   // the block above closed it
        const p = document.getElementById('battle-preview');
        const s = p.querySelector('.bp-scene');
        const pr = p.getBoundingClientRect(), sr = s.getBoundingClientRect();
        return {
            position: getComputedStyle(s).position,
            sceneBottom: Math.round(sr.bottom), panelBottom: Math.round(pr.bottom),
            headerTop: Math.round(p.querySelector('.bp-header').getBoundingClientRect().top),
            sceneTop: Math.round(sr.top),
            cssW: Math.round(sr.width), attrW: s.width
        };
    })()`);
    check('the scene stays in the panel flow rather than escaping the global canvas rule',
        flow.position !== 'absolute' && flow.position !== 'fixed', flow.position);
    check('so the panel is tall enough to contain it',
        flow.sceneBottom <= flow.panelBottom,
        `scene ends ${flow.sceneBottom}, panel ends ${flow.panelBottom}`);
    check('and the title bar is above the scene, not under it',
        flow.headerTop < flow.sceneTop, `header ${flow.headerTop}, scene ${flow.sceneTop}`);
    check('the scene is never squashed off its integer scale',
        flow.cssW === flow.attrW, `${flow.cssW} shown for ${flow.attrW} drawn`);

    /* The same rule caught the frame thumbnails, which collapsed to 6px specks
       behind a scrollbar, and the fit-to-target before/after, which drew
       nothing at all. Assert the property for every panel rather than the
       symptom for each one. */
    const panelCanvases = await page.eval(`(() => {
        window.FrameStrip && window.FrameStrip.open && window.FrameStrip.open();
        const out = [];
        document.querySelectorAll(
            '#battle-preview canvas, #sprite-preview canvas, #frame-strip canvas'
        ).forEach(c => {
            const r = c.getBoundingClientRect();
            out.push({ where: c.closest('[id]').id, pos: getComputedStyle(c).position,
                       w: Math.round(r.width), h: Math.round(r.height) });
        });
        return out;
    })()`);
    check('every panel canvas is in flow and has real size',
        panelCanvases.length > 0 && panelCanvases.every(c =>
            c.pos !== 'absolute' && c.pos !== 'fixed' && c.w > 8 && c.h > 8),
        JSON.stringify(panelCanvases));
    check('a declared offset 6 too small is reported as floating',
        /6px too high/.test(ui.text), ui.text);
    check('and the measured value is offered as the fix',
        ui.fixLabel === 'Set 8', ui.fixLabel);
    check('clicking it writes that value, not the declared one',
        ui.written.length === 1 && ui.written[0][0] === 'y' && ui.written[0][1] === '8',
        JSON.stringify(ui.written));
    check('when they agree there is nothing to fix',
        !ui.agreeFix && /agrees/.test(ui.agreeText), ui.agreeText);
    check('closing the panel survives the next repaint', ui.stayedClosed);

    /* Resizing leaves the index map describing the *old* canvas — applyResize
       does not rebuild it. The panel must fall back to the canvas rather than
       go blank, which is what a user sees as "no readout after a resize". */
    const stale = await page.eval(`(async () => {
        PaintApp.spriteIndices = new Uint8Array(4);   // what a resize leaves behind
        window.BattlePreview.open();
        const panel = document.getElementById('battle-preview');
        return { text: panel.querySelector('.bp-readout').textContent };
    })()`);
    check('a stale index map falls back to the canvas instead of blanking',
        /8px above the bottom edge/.test(stale.text), stale.text);

    /* The backdrop, end to end through the panel: a project that declares one
       environment, whose three files the panel fetches and reassembles. The
       tileset is one solid tile of colour 1, so a correct render paints the
       whole screen that colour — anything else (bands, black, transparent) is
       distinguishable at a glance. */
    const tilesPng = Array.from(makePng({
        w: 8, h: 8, depth: 4,
        palette: [[0, 0, 0], [10, 200, 60], [0, 0, 0], [0, 0, 0]],
        trns: [0, 255, 255, 255],
        indices: new Uint8Array(64).fill(1)
    }));
    // 32x32 entries, tile 0, palette bank 2 → colours 0..15 of the file.
    const mapBin = [];
    for (let i = 0; i < 1024; i++) { mapBin.push(0x00, 0x20); }
    const palText = 'JASC-PAL\r\n0100\r\n16\r\n' +
        ['0 0 0', '10 200 60'].concat(Array(14).fill('0 0 0')).join('\r\n') + '\r\n';

    /* The opponent's health box is a 64×32 OAM sprite. A solid one lands
       somewhere specific or it does not; the backdrop behind it is a different
       colour, so both the blit and its placement are one pixel read each. */
    const boxPng = Array.from(makePng({
        w: 64, h: 32, depth: 4,
        palette: [[0, 0, 0], [210, 40, 190], [0, 0, 0], [0, 0, 0]],
        trns: [0, 255, 255, 255],
        indices: new Uint8Array(64 * 32).fill(1)
    }));

    const scene = await page.eval(`(async () => {
        const files = {
            't.png': new Uint8Array(${JSON.stringify(tilesPng)}),
            'm.bin': new Uint8Array(${JSON.stringify(mapBin)}),
            'p.pal': new TextEncoder().encode(${JSON.stringify(palText)}),
            'hb.png': new Uint8Array(${JSON.stringify(boxPng)})
        };
        window.PokeProject = Object.assign({}, window.PokeProject, {
            // A real model carries a root; the panel keys its cache on it.
            model: () => ({
                root: '/env-stub', sourceText: new Map(),
                index: { pathsBySymbol: new Map([['gHealthboxSinglesOpponentGfx', ['hb.png']]]) }
            }),
            coordsFor: () => [],
            environments: () => ([{
                id: 'BATTLE_ENVIRONMENT_CAVE', label: 'Cave',
                tilesPath: 't.png', tilemapPath: 'm.bin', palettePath: 'p.pal'
            }]),
            readBytes: (p) => files[p] ? Promise.resolve(files[p]) : Promise.reject(new Error(p))
        });
        window.BattlePreview.open();
        const panel = document.getElementById('battle-preview');
        const c = panel.querySelector('.bp-scene');
        // Screen pixel → canvas pixel; the panel picks its own scale to fit.
        const at = (x, y) => {
            const s = c.width / 240;
            return Array.from(c.getContext('2d').getImageData(
                Math.floor((x + 0.5) * s), Math.floor((y + 0.5) * s), 1, 1).data);
        };
        // Both fetches are async; the panel repaints itself when the bytes land.
        for (let i = 0; i < 80; i++) {
            await new Promise(r => setTimeout(r, 25));
            if (at(4, 4)[1] > 150 && at(20, 20)[0] > 150) break;
        }
        const env = panel.querySelector('.bp-env');
        return {
            topLeft: at(4, 4),
            inBox: at(20, 20),
            leftOfBox: at(4, 20),
            belowBox: at(20, 60),
            options: env ? Array.from(env.options).map(o => o.textContent) : null,
            envHidden: env ? env.hidden : null
        };
    })()`);

    check('the panel fetches the environment and paints the project’s backdrop',
        scene.topLeft[1] > 150 && scene.topLeft[0] < 80,
        `top-left pixel rgba(${scene.topLeft})`);
    check('and offers it by the name the project gives it',
        scene.envHidden === false && JSON.stringify(scene.options) === '["Cave"]',
        `${scene.envHidden} ${JSON.stringify(scene.options)}`);

    /* The health box is a 64×32 sprite centred on sBattlerHealthboxCoords
       {44,30}, so its art occupies x 12..75, y 14..45 — placing it by its
       top-left instead would put it a box-width off, which these three
       samples separate. */
    check('the project’s own health box is drawn, not a white placeholder',
        scene.inBox[0] > 150 && scene.inBox[2] > 150 && scene.inBox[1] < 100,
        `pixel inside the box rgba(${scene.inBox})`);
    check('and it is centred on the coordinates rather than hung off them',
        scene.leftOfBox[1] > 150 && scene.belowBox[1] > 150,
        `left rgba(${scene.leftOfBox}), below rgba(${scene.belowBox})`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
