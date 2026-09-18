/* Measure what a brush actually deposits, one isolated question at a time.
 *
 *   node scripts/brush-probe.mjs [brush.sut]
 *
 * Every number here is read off the LAYER's own RGBA, on a freshly added
 * transparent layer -- never composited over white. That matters: a fresh
 * CDPaint document paints onto opaque white PIXELS, while an added layer is
 * transparent, and a model fitted on one substrate silently disagrees on the
 * other. Transparent is also what Clip Studio gives you with the Paper layer
 * hidden, so these readings are directly comparable to a CSP export.
 *
 * Six probes, each answering one thing on its own layer so no stage leaks
 * into the next:
 *
 *   1  one dab           -- the tip profile with no accumulation at all
 *   2  stage costs       -- what the paper grain and the watercolour rim each
 *                           take out of a single stroke's alpha
 *   3  opacity algebra   -- is a stroke a per-stroke operator or a density
 *                           accumulator? one pass at 100 should deposit what
 *                           two passes at 50 do
 *   4  commutativity     -- multiply is commutative, most other candidate
 *                           models are not, so stroke order is a free
 *                           discriminator (also gated in brush-hash.mjs)
 *   5  the grey ladder   -- THE probe. Every CSP swatch we have has a channel
 *                           pinned at 255, where a plain multiply and a
 *                           peak-preserving one are the identical function.
 *                           An unsaturated colour is the only thing that
 *                           tells them apart: multiply marches grey to black.
 *   6  a colour ladder   -- the stacking RATE, to compare against CSP
 *
 * This prints numbers for a person to judge; it asserts nothing. The
 * invariants worth freezing live in test/browser/brush-hash.mjs.
 */
import { withPage } from '../test/browser.mjs';
import { readFileSync } from 'fs';

const SUT = process.argv[2] ||
    'C:\\Users\\frenc\\Desktop\\brush-samples\\Flat watercolor brush.sut';
const b64 = readFileSync(SUT).toString('base64');
console.log('brush: ' + SUT);

await withPage(async (page) => {
    const boot = await page.run(`
        const bin = atob(${JSON.stringify(b64)});
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        for (const n of PaintApp.brush.userPresetNames()) PaintApp.brush.deleteUserPreset(n);
        await PaintApp.brush.importSutPack(u, 'probe.sut');
        PaintApp.setTool('paintbrush');
        PaintApp.setSize(600, 500);
        PaintApp.config.zoom = 1;
        PaintApp.updateBounds();
        PaintApp.state.selection = null;
        const rect = PaintApp.ui.stage.getBoundingClientRect();
        return JSON.stringify({ x: rect.x, y: rect.y });
    `);
    const O = JSON.parse(boot);

    const mouse = (t, x, y, b) => page.send('Input.dispatchMouseEvent', {
        type: t, x: O.x + x, y: O.y + y, button: 'left', buttons: b || 0,
        clickCount: t === 'mousePressed' ? 1 : 0 });

    /* A fresh TRANSPARENT layer, preset reloaded, optional param overrides. */
    async function fresh(color, params, white) {
        await page.run(`
            PaintApp.brush.loadPreset(PaintApp.brush.userPresetNames()[0]);
            /* loadPreset does NOT reset opacity (it is a tool setting, not a
             * preset key), so anything a previous probe set leaks into every
             * probe after it -- which silently halved three readings the first
             * time this ran. Pin the whole surface every time, then apply this
             * probe's overrides on top. */
            const base = { opacity: 100, flow: 100, texture: 60, edgeDensity: 10 };
            const ov = Object.assign(base, ${JSON.stringify(params || {})});
            for (const k in ov) PaintApp.brush.setParam(k, ov[k]);
            PaintApp.setColor('${color}', 1);
            document.getElementById('lsys-add').click();
            PaintApp.state.selection = null;
            await new Promise(r => setTimeout(r, 1300));
            if (${!!white}) {
                /* Paper, for the probes that compare against a CSP reading:
                 * CSP's eyedropper sees the stroke composited over the white
                 * Paper layer, so a transparent-layer RGB is not the same
                 * measurement and the two must not be put in one table. */
                const L = PaintApp.layerMgr.layers[PaintApp.layerMgr.activeIdx];
                const c = L.canvas.getContext('2d');
                c.save();
                c.globalCompositeOperation = 'source-over';
                c.fillStyle = '#ffffff';
                c.fillRect(0, 0, L.canvas.width, L.canvas.height);
                c.restore();
            }
        `);
        /* The stage moves when the layer panel grows, so a rect measured at
         * boot goes stale the moment a layer is added -- re-read it here or
         * every synthetic click lands off-canvas and the probe paints nothing. */
        const r = JSON.parse(await page.run(`
            const b = PaintApp.ui.stage.getBoundingClientRect();
            return JSON.stringify({ x: b.x, y: b.y });
        `));
        O.x = r.x; O.y = r.y;
    }
    async function dab(x, y) {
        await mouse('mouseMoved', x, y, 0);
        await new Promise(r => setTimeout(r, 20));
        await mouse('mousePressed', x, y, 1);
        await new Promise(r => setTimeout(r, 40));
        await mouse('mouseReleased', x, y, 0);
        await new Promise(r => setTimeout(r, 260));
    }
    async function stroke(y) {
        y = y || 250;
        await mouse('mouseMoved', 100, y, 0);
        await new Promise(r => setTimeout(r, 20));
        await mouse('mousePressed', 100, y, 1);
        for (let i = 1; i <= 34; i++) {
            await mouse('mouseMoved', 100 + i * 10, y, 1);
            await new Promise(r => setTimeout(r, 16));
        }
        await mouse('mouseReleased', 440, y, 0);
        await new Promise(r => setTimeout(r, 240));
    }
    /* Interior stats of the painted band, ignoring the soft ends. Reports the
     * whole layer's pixel count and bbox when the window is empty, so a probe
     * that misses tells you WHERE it painted instead of just "nothing". */
    const stats = async (x, y, w, h) => JSON.parse(await page.run(`
        const L = PaintApp.layerMgr.layers[PaintApp.layerMgr.activeIdx];
        const ctx = L.canvas.getContext('2d');
        const all = ctx.getImageData(0, 0, L.canvas.width, L.canvas.height).data;
        let tot = 0, bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;
        for (let i = 0; i < all.length; i += 4) if (all[i+3] > 8) {
            tot++; const p = (i/4)|0, px = p % L.canvas.width, py = (p / L.canvas.width)|0;
            if (px<bx0) bx0=px; if (px>bx1) bx1=px;
            if (py<by0) by0=py; if (py>by1) by1=py;
        }
        const d = ctx.getImageData(${x}, ${y}, ${w}, ${h}).data;
        const A = [], C = [];
        for (let i = 0; i < d.length; i += 4) {
            if (d[i+3] < 8) continue;
            A.push(d[i+3]); C.push([d[i], d[i+1], d[i+2]]);
        }
        if (!A.length) return JSON.stringify({ n: 0, tot: tot, bbox: [bx0,by0,bx1,by1],
            layers: PaintApp.layerMgr.layers.length, active: PaintApp.layerMgr.activeIdx });
        A.sort((p,q)=>p-q);
        C.sort((p,q)=>(p[0]+p[1]+p[2])-(q[0]+q[1]+q[2]));
        const at = (a,q) => a[Math.min(a.length-1, Math.floor(a.length*q))];
        return JSON.stringify({ n: A.length, aMax: A[A.length-1],
            a25: at(A,0.25), a50: at(A,0.5), a75: at(A,0.75), rgb50: at(C,0.5) });
    `));
    const say = (label, s) => console.log('  ' + label.padEnd(28) +
        (s.n ? `a=${s.a25}/${s.a50}/${s.a75} (max ${s.aMax})  rgb=${JSON.stringify(s.rgb50)}  n=${s.n}`
             : 'NOTHING in window; layer has ' + s.tot + ' px, bbox ' + JSON.stringify(s.bbox) +
               ', layers=' + s.layers + ' active=' + s.active));
    const BAND = [150, 230, 250, 40];

    console.log('\n=== 1. one dab, transparent layer (tip profile, no accumulation) ===');
    await fresh('#00B4FF');
    await dab(270, 250);
    say('single dab', await stats(220, 200, 100, 100));

    console.log('\n=== 2. stroke-1 coverage, and what each stage costs ===');
    for (const [name, ov] of [
        ['everything on', {}],
        ['grain off', { texture: 0 }],
        ['rim off', { edgeDensity: 0 }],
        ['grain + rim off', { texture: 0, edgeDensity: 0 }],
    ]) {
        await fresh('#00B4FF', ov);
        await stroke();
        say(name, await stats(...BAND));
    }

    console.log('\n=== 3. per-stroke operator, or density accumulator? (should match) ===');
    await fresh('#00B4FF', { opacity: 100 });
    await stroke();
    say('1 stroke @ opacity 100', await stats(...BAND));
    await fresh('#00B4FF', { opacity: 50 });
    await stroke(); await stroke();
    say('2 strokes @ opacity 50', await stats(...BAND));

    console.log('\n=== 4. commutativity: multiply is commutative, most else is not ===');
    await fresh('#FF3030');
    await stroke();
    await page.run(`PaintApp.setColor('#3030FF', 1);`);
    await stroke();
    say('red then blue', await stats(...BAND));
    await fresh('#3030FF');
    await stroke();
    await page.run(`PaintApp.setColor('#FF3030', 1);`);
    await stroke();
    say('blue then red', await stats(...BAND));

    console.log('\n=== 5. THE grey probe: a plain multiply must march #808080 to black ===');
    await fresh('#808080');
    for (let i = 1; i <= 8; i++) {
        await stroke();
        if ([1, 2, 3, 5, 8].includes(i)) say('grey x' + i, await stats(...BAND));
    }

    console.log('\n=== 6. #00B4FF stack, transparent layer (the rate, vs CSP) ===');
    await fresh('#00B4FF');
    for (let i = 1; i <= 8; i++) {
        await stroke();
        if ([1, 2, 3, 5, 8].includes(i)) say('#00B4FF x' + i, await stats(...BAND));
    }

    /* The only table that can be compared to a Clip Studio reading directly:
     * over white paper, at the same pass counts the user measured. Targets
     * below are real CSP readings of the Flat watercolor brush (2026-09-17),
     * one stroke per pass, pen lifted between passes.
     *
     * Both fit a per-channel multiply at coverage ~0.48: grey's ladder gives
     * 0.52/0.49/0.50 at n=1/3/8, and the red-under-blue overlap #854688 gives
     * 0.484/0.476/0.474 from its three channels independently. That overlap is
     * the measurement that finally pinned the model down -- every earlier CSP
     * swatch had a channel at 255, where a plain multiply and a
     * peak-preserving one are the identical function and neither can be
     * ruled out. Do not re-fit against a colour whose max is 255. */
    console.log('\n=== 7. over white, vs real CSP (the comparable table) ===');
    const LADDERS = [
        ['#808080', { 1: 189, 3: 111, 8: 26, 20: 2 }],
        ['#00B4FF', { 20: 4 }],   // CSP converges to ~#0104FF; green is the live channel
    ];
    for (const [color, target] of LADDERS) {
        await fresh(color, {}, true);
        for (let i = 1; i <= 20; i++) {
            await stroke();
            if (!(i in target)) continue;
            const s = await stats(...BAND);
            const g = s.rgb50[1];
            console.log('  ' + (color + ' x' + i).padEnd(28) +
                'rgb=' + JSON.stringify(s.rgb50) +
                '   CSP wants ' + target[i] + ' on this channel, we have ' + g +
                '  (' + (g > target[i] ? 'too light' : g < target[i] ? 'TOO DARK' : 'on') + ')');
        }
    }
});
