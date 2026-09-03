/* Getting outside art into a project slot.
 *
 * The on-ramp, and the thing the whole tool is for: art drawn anywhere else has
 * to land in a decomp slot correctly sized, indexed, and with its background on
 * slot 0. Three things make it different from opening a file, and each is a way
 * it can silently go wrong:
 *
 *   - the destination must survive. `state.projectFile` is what every decomp
 *     rule keys on — the size the slot allows, its colour budget, whether it
 *     wants transparency — and opening the dropped picture as its own document
 *     is exactly what throws that away.
 *   - slot 0 is transparency because the hardware says so, not because the
 *     incoming PNG has a tRNS. Most art from outside has an alpha channel and
 *     no palette at all.
 *   - the palette is the picture's own colours, not a re-quantisation of them.
 *     Art drawn for a 16-colour slot arrives already fitting; generating a new
 *     palette for it would lose fidelity for nothing.
 *
 * The incoming pictures are drawn on a canvas in the page and handed over as a
 * real File, so `createImageBitmap` and the drop routing are the real ones.
 *
 *   node test/browser/project-import.mjs
 */
import { withPage } from '../browser.mjs';
import { makePng } from '../png-fixture.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

/* The destination: a 64×64 4bpp sprite slot, the shape a species front sprite
   has to be. Its own palette is a distinct ramp, so that whether the imported
   colours actually replaced it is visible rather than assumed. */
const destPal = [];
for (let i = 0; i < 16; i++) destPal.push([i * 16, 255 - i * 16, 128]);
const dest = makePng({
    w: 64, h: 64, depth: 4, palette: destPal, trns: [0],
    indices: Uint8Array.from({ length: 64 * 64 }, (_, i) => ((i % 64) < 8 ? 0 : 7)),
    filter: 0
}).toString('base64');

/* Drawn in the page: a transparent margin round a body of many colours, one of
   which covers most of it. Deliberately 40×48 and 26 colours, so both the size
   fix and the colour fix have something to do. */
const HELPERS = `
    const mkFile = async (w, h, draw, name) => {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        draw(c.getContext('2d'), w, h);
        const blob = await new Promise(r => c.toBlob(r, 'image/png'));
        return new File([blob], name || 'incoming.png', { type: 'image/png' });
    };
    const DOMINANT = [10, 20, 30];
    const sprite = (ctx, w, h) => {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgb(' + DOMINANT.join(',') + ')';
        ctx.fillRect(4, 4, w - 8, h - 8);
        // 25 more colours, a few pixels each, well inside the body.
        for (let i = 0; i < 25; i++) {
            ctx.fillStyle = 'rgb(' + (200 + i) + ',' + (5 + i * 2) + ',' + (100 + i) + ')';
            ctx.fillRect(6 + (i % 5) * 2, 6 + ((i / 5) | 0) * 2, 2, 1);
        }
    };
    const openDest = async () => {
        const bin = atob("${dest}");
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await PaintApp.applyProjectImageBytes(bytes, 'front.png',
            'graphics/pokemon/testmon/front.png', []);
    };
    const overlay = () => document.getElementById('fit-overlay');
    const stepIds = () => [...document.querySelectorAll('#fit-box .fit-steps li .fit-label')]
        .map(l => l.firstChild.textContent.trim());
`;

await withPage(async (page) => {
    console.log('reading outside art');

    const doc = await page.eval(`(async () => {
        ${HELPERS}
        const f = await mkFile(40, 48, sprite);
        const bmp = await createImageBitmap(f);
        const c = document.createElement('canvas');
        c.width = 40; c.height = 48;
        const x = c.getContext('2d');
        x.drawImage(bmp, 0, 0);
        const d = PaintApp.docFromImageData(x.getImageData(0, 0, 40, 48).data, 40, 48);

        let onSlot0 = 0, cornerSlot = d.map[0];
        for (let q = 0; q < d.map.length; q++) if (d.map[q] === 0) onSlot0++;
        return {
            w: d.w, h: d.h, transparentIdx: d.transparentIdx,
            colors: d.colors.length,
            slot0Colour: d.colors[0],
            slot1: d.colors[1],
            onSlot0, cornerSlot,
            inRange: Array.from(d.map).every(v => v < d.colors.length)
        };
    })()`);

    check('an outside picture becomes a document value at its own size',
        doc.w === 40 && doc.h === 48, `${doc.w}×${doc.h}`);
    check('transparency lands on slot 0, whatever the file said',
        doc.transparentIdx === 0 && doc.slot0Colour.a === 0, JSON.stringify(doc.slot0Colour));
    check('and the transparent margin is what is standing on it',
        doc.cornerSlot === 0 && doc.onSlot0 === 40 * 48 - 32 * 40,
        `corner ${doc.cornerSlot}, count ${doc.onSlot0}`);
    check('the palette is the picture\'s own colours, not a re-quantisation',
        doc.colors === 27, String(doc.colors));
    check('most-used first, so slot 1 is the colour the sprite is mostly made of',
        doc.slot1.r === 10 && doc.slot1.g === 20 && doc.slot1.b === 30, JSON.stringify(doc.slot1));
    check('every pixel indexes a colour that exists', doc.inRange === true);

    console.log('\ndropping it on a slot');

    const dropped = await page.eval(`(async () => {
        ${HELPERS}
        await openDest();
        const before = {
            file: PaintApp.state.projectFile,
            indices: Array.from(PaintApp.state.projectIndices.slice(0, 16)),
            steps: PaintApp.state.history.length
        };
        const f = await mkFile(40, 48, sprite);

        // The real gesture: a drop on the stage, carrying a real File.
        const dt = new DataTransfer();
        dt.items.add(f);
        const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
        PaintApp.ui.stage.dispatchEvent(ev);
        for (let i = 0; i < 100 && !overlay(); i++) await new Promise(r => setTimeout(r, 20));

        return {
            before,
            offered: !!overlay(),
            heading: (document.querySelector('#fit-box h3') || {}).textContent,
            sub: (document.querySelector('#fit-box .fit-sub') || {}).textContent,
            steps: stepIds(),
            // Nothing has been committed yet — the dialog is a preview.
            stillDest: PaintApp.state.projectFile,
            untouched: PaintApp.config.width === 64 && PaintApp.config.height === 64
                && PaintApp.state.history.length === before.steps
        };
    })()`);

    check('a dropped picture is offered to the open slot, not opened as its own file',
        dropped.offered === true);
    check('the dialog says what is being imported',
        /^Import /.test(dropped.heading || ''), dropped.heading);
    check('and names the slot it is going into',
        /front\.png/.test(dropped.sub || ''), dropped.sub);
    check('it has to be resized and reduced to fit a 64×64 16-colour slot',
        dropped.steps.some(s => /Resize to 64×64/.test(s))
        && dropped.steps.some(s => /Reduce to 16 colours/.test(s)),
        JSON.stringify(dropped.steps));
    check('the background already covers slot 0, so no slot-0 fix is offered',
        !dropped.steps.some(s => /slot 0/i.test(s)), JSON.stringify(dropped.steps));
    check('nothing is committed while the dialog is open', dropped.untouched === true);
    check('the destination is still the destination',
        dropped.stillDest === 'graphics/pokemon/testmon/front.png', dropped.stillDest);

    console.log('\naccepting it');

    const applied = await page.eval(`(async () => {
        ${HELPERS}
        const stepsBefore = PaintApp.state.history.length;
        const wasColour1 = { ...PaintApp.palette[1] };
        document.querySelector('#fit-box .fit-primary').click();
        for (let i = 0; i < 100 && overlay(); i++) await new Promise(r => setTimeout(r, 20));

        const w = PaintApp.config.width, h = PaintApp.config.height;
        const map = PaintApp.state.projectIndices;
        let clear = 0, lastDrawnRow = -1;
        for (let q = 0; q < map.length; q++) {
            if (map[q] === 0) { clear++; continue; }
            const y = (q / w) | 0;
            if (y > lastDrawnRow) lastDrawnRow = y;
        }

        const conf = PaintApp.projectConformance(PaintApp.palette.length);
        const after = {
            size: [w, h],
            colors: PaintApp.palette.length,
            colour1: { ...PaintApp.palette[1] },
            file: PaintApp.state.projectFile,
            confOk: conf.ok,
            mapFits: map.length === w * h,
            inRange: Array.from(map).every(v => v < PaintApp.palette.length),
            clear, lastDrawnRow,
            oneStep: PaintApp.state.history.length === stepsBefore + 1,
            trns: PaintApp.state.projectTrns ? Array.from(PaintApp.state.projectTrns) : null
        };
        PaintApp.undo();
        after.undoneColour1 = { ...PaintApp.palette[1] };
        after.wasColour1 = wasColour1;
        return after;
    })()`);

    check('applying resizes the art to the slot\'s box',
        applied.size[0] === 64 && applied.size[1] === 64 && applied.mapFits,
        JSON.stringify(applied.size));
    check('and cuts it to the slot\'s colour budget',
        applied.colors === 16, String(applied.colors));
    check('every pixel still indexes a colour that exists', applied.inRange === true);
    check('the padding it added is transparency, not black',
        applied.clear > 0 && applied.trns && applied.trns[0] === 0,
        `${applied.clear} clear, trns ${JSON.stringify(applied.trns)}`);
    check('the imported colours replaced the slot\'s own palette',
        applied.colour1.r === 10 && applied.colour1.g === 20 && applied.colour1.b === 30,
        JSON.stringify(applied.colour1));
    /* A Gen 3 sprite's y_offset is measured up from the bottom edge, so art that
       drifts to the top of the box moves in game even though the file is the
       right size. The incoming picture carries a 4px transparent margin, so its
       last drawn row must sit 4 above the bottom of the box — at 43 it was
       top-anchored and the sprite would stand in mid-air. */
    check('the art is bottom-anchored, so the slot\'s y_offset still means what it did',
        applied.lastDrawnRow === 59, String(applied.lastDrawnRow));
    check('the whole import is insertable', applied.confOk === true);
    check('the destination survived the import',
        applied.file === 'graphics/pokemon/testmon/front.png', applied.file);
    check('it committed as one undo step', applied.oneStep === true);
    check('and one undo puts the old asset back',
        JSON.stringify(applied.undoneColour1) === JSON.stringify(applied.wasColour1),
        `${JSON.stringify(applied.undoneColour1)} vs ${JSON.stringify(applied.wasColour1)}`);

    console.log('\nmore colours than a palette can hold');

    /* Not refused. The extras merge into their nearest neighbour on the way in,
       and the real budget is applied afterwards as a fix that can be seen. */
    const many = await page.eval(`(async () => {
        ${HELPERS}
        const f = await mkFile(64, 64, (ctx, w, h) => {
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const n = y * w + x;
                    ctx.fillStyle = 'rgb(' + (n % 251) + ',' + ((n * 7) % 241) + ',' + ((n * 13) % 239) + ')';
                    ctx.fillRect(x, y, 1, 1);
                }
            }
        });
        const bmp = await createImageBitmap(f);
        const c = document.createElement('canvas');
        c.width = 64; c.height = 64;
        const x = c.getContext('2d');
        x.drawImage(bmp, 0, 0);
        const d = PaintApp.docFromImageData(x.getImageData(0, 0, 64, 64).data, 64, 64);
        return {
            colors: d.colors.length,
            inRange: Array.from(d.map).every(v => v < d.colors.length),
            // Nothing transparent in it, so nothing may claim the transparency slot.
            onSlot0: Array.from(d.map).filter(v => v === 0).length
        };
    })()`);

    check('a picture with thousands of colours caps at what an index can address',
        many.colors === 256, String(many.colors));
    check('and every pixel still lands on one of them', many.inRange === true);
    check('an opaque picture leaves slot 0 empty for the slot-0 fix to fill',
        many.onSlot0 === 0, String(many.onSlot0));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
