/* Reading brush packs made for other programs.
 *
 * Everything here runs against real files from David Revoy's 2023-01 Krita
 * bundle (CC-0), not against something we wrote ourselves — a decoder tested
 * on its own output proves nothing. See test/fixtures/brushes/README.md.
 */
import { withPage, REPO_ROOT } from '../browser.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

const FIX = join(REPO_ROOT, 'test', 'fixtures', 'brushes');
const b64 = (f) => readFileSync(join(FIX, f)).toString('base64');

await withPage(async (page) => {
    /* The fixtures reach the page as base64 rather than over HTTP, so the
     * decoder is what is under test and not the server. */
    await page.run(`
        window.__fx = {};
        const put = (k, s) => {
            const bin = atob(s);
            const u = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
            window.__fx[k] = u;
        };
        put('auto', ${JSON.stringify(b64('eraser-kneaded-soft.kpp'))});
        put('stamp', ${JSON.stringify(b64('thin-brush-pointy.kpp'))});
        put('pack', ${JSON.stringify(b64('mini-pack.bundle'))});
        return 1;
    `);

    console.log('== a single preset ==');
    const one = JSON.parse(await page.eval(`(async () => {
        const p = await BrushPack.read(window.__fx.auto);
        const pr = p.presets[0];
        const bd = BrushPack.brushDefinition(pr);
        return JSON.stringify({
            kind: p.kind, count: p.presets.length,
            name: pr.name, paintop: pr.paintop,
            paramCount: Object.keys(pr.params).length,
            spacing: bd && bd.spacing, type: bd && bd.type,
            diameter: bd && bd.mask && bd.mask.diameter,
            ratio: bd && bd.mask && bd.mask.ratio,
            curve: BrushPack.parseCurve(pr.params.SizeSensor),
            opacity: pr.params.OpacityValue
        });
    })()`));
    console.log('  ' + JSON.stringify(one));

    check('a .kpp is read straight, without a pack around it',
        one.kind === 'kpp' && one.count === 1, `${one.kind}, ${one.count} presets`);
    check('the brush keeps the name its author gave it',
        /Eraser Kneaded Soft/.test(one.name), one.name);
    check('...and says which engine drew it',
        one.paintop === 'paintbrush', one.paintop);
    check('the settings come through in bulk, not a handful',
        one.paramCount > 100, `${one.paramCount} settings`);
    /* A generated tip carries its shape as numbers: how wide, how squashed,
     * how soft. Those are the sliders we already have. */
    check('a generated tip reports its diameter and squash',
        one.type === 'auto_brush' && Number(one.diameter) > 0 && Number(one.ratio) > 0,
        `${one.type} ${one.diameter} x ratio ${one.ratio}`);
    check('spacing comes through as a fraction of the tip',
        Number(one.spacing) > 0 && Number(one.spacing) < 2, String(one.spacing));
    check('a pressure curve arrives as points, the same shape our editor uses',
        Array.isArray(one.curve) && one.curve.length >= 2 &&
        one.curve.every(pt => pt.length === 2 && pt[0] >= 0 && pt[0] <= 1),
        JSON.stringify(one.curve));

    console.log('== a preset that stamps a tip ==');
    const two = JSON.parse(await page.eval(`(async () => {
        const p = await BrushPack.read(window.__fx.stamp);
        const pr = p.presets[0];
        const bd = BrushPack.brushDefinition(pr);
        const keys = Object.keys(pr.resources);
        const first = keys.length ? pr.resources[keys[0]] : null;
        /* The tip has to survive as an image, not just as bytes. */
        let drew = null;
        if (first && /\\.png$/i.test(keys[0])) {
            const bmp = await createImageBitmap(new Blob([first.bytes], { type: 'image/png' }));
            drew = { w: bmp.width, h: bmp.height };
        }
        return JSON.stringify({
            name: pr.name, type: bd && bd.type, tipFile: bd && bd.filename,
            resources: keys, bytes: first ? first.bytes.length : 0, drew
        });
    })()`));
    console.log('  ' + JSON.stringify(two));

    check('a stamped brush names the tip it stamps',
        !!two.tipFile && /gbr_brush|png_brush|gih/.test(two.type),
        `${two.type} / ${two.tipFile}`);
    check('the tip travels inside the preset itself',
        two.resources.length > 0 && two.bytes > 500,
        `${two.resources.length} resources, ${two.bytes} bytes`);
    check('...and what comes out is a real image',
        two.drew === null || (two.drew.w > 0 && two.drew.h > 0),
        JSON.stringify(two.drew));

    console.log('== a whole pack ==');
    const pack = JSON.parse(await page.eval(`(async () => {
        const p = await BrushPack.read(window.__fx.pack);
        return JSON.stringify({
            kind: p.kind,
            names: p.presets.map(x => x.name).sort(),
            thumbs: p.presets.filter(x => x.thumbnail && x.thumbnail.length > 1000).length,
            tips: Object.keys(p.tips),
            warnings: p.warnings
        });
    })()`));
    console.log('  ' + JSON.stringify(pack));

    check('a pack yields every preset inside it',
        pack.kind === 'bundle' && pack.names.length === 2, JSON.stringify(pack.names));
    /* Each preset file IS a thumbnail Krita rendered of that brush, which is
     * what lets us check our own rendering against the original later. */
    check('every preset brings Krita’s own picture of it',
        pack.thumbs === 2, `${pack.thumbs} of 2`);
    check('loose tips in the pack are collected too',
        pack.tips.indexOf('chisel_streaks.png') >= 0, JSON.stringify(pack.tips));
    check('nothing in the pack failed to read',
        pack.warnings.length === 0, JSON.stringify(pack.warnings));

    console.log('== turning a Krita brush into one of ours ==');
    const tr = JSON.parse(await page.eval(`(async () => {
        const out = {};
        const one = async (key) => {
            const p = await BrushPack.read(window.__fx[key]);
            const pr = p.presets[0];
            const bd = BrushPack.brushDefinition(pr);
            /* A stamped tip's real size is its image scaled by the preset's
             * own factor, so the tip has to be decoded before the size means
             * anything. */
            let tipSize = 0, tipUrl = null;
            if (bd && bd.filename && pr.resources[bd.filename]) {
                const blob = new Blob([pr.resources[bd.filename].bytes], { type: 'image/png' });
                const bmp = await createImageBitmap(blob);
                tipSize = Math.max(bmp.width, bmp.height);
                tipUrl = await new Promise(r => {
                    const fr = new FileReader();
                    fr.onload = () => r(fr.result);
                    fr.readAsDataURL(blob);
                });
            }
            const t = BrushPack.toPreset(pr, { tipSize });
            t.tipSize = tipSize; t.tipUrl = tipUrl;
            return t;
        };
        out.eraser = await one('auto');
        out.stamp = await one('stamp');

        /* The real test of a translation is that the engine accepts it. */
        const b = PaintApp.brush, app = PaintApp;
        const paint = async (t) => {
            app.layerMgr.collapseToBase({ fresh: true });
            app.setSize(400, 200); app.config.zoom = 1; app.updateBounds();
            document.getElementById('lsys-add').click();
            app.state.selection = null;
            const L = app.layerMgr.layers[app.layerMgr.activeIdx];
            const ps = Object.assign({}, t.params, { size: 30 });
            if (t.tipUrl) ps._tipUrl = t.tipUrl;
            b.PRESETS.__imported = ps;
            b.loadPreset('__imported');
            await new Promise(r => setTimeout(r, 500));
            b.beginStroke(40, 100, 0.9, '#ff0000');
            for (let x = 60; x <= 360; x += 10) b.moveStroke(x, 100, 0.9, '#ff0000');
            b.endStroke();
            await new Promise(r => setTimeout(r, 250));
            const d = L.ctx.getImageData(0, 0, 400, 200).data;
            let ink = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 20) ink++;
            delete b.PRESETS.__imported;
            return ink;
        };
        out.stampInk = await paint(out.stamp);
        b.loadPreset('Round');
        out.blendKnown = b.BLEND_MODES.indexOf(out.eraser.params.blendMode) >= 0;
        return JSON.stringify(out, (k, v) => k === 'tipUrl' ? (v ? 'data:' : null) : v);
    })()`, { awaitPromise: true }));
    console.log('  eraser ' + JSON.stringify(tr.eraser));
    console.log('  stamp  ' + JSON.stringify(tr.stamp) + '  ink ' + tr.stampInk);

    const E = tr.eraser.params, S = tr.stamp.params;
    check('a generated tip becomes a shape, a size and a squash',
        E.shape === 'circle' && E.size === 250 && E.aspectRatio === 1,
        `${E.shape} ${E.size} aspect ${E.aspectRatio}`);
    /* Krita's spacing is a fraction of the tip; ours is a percentage of it,
     * which is the same number written differently. */
    check('spacing arrives as our percentage of the tip',
        E.spacing === 10 && S.spacing === 4, `${E.spacing}% and ${S.spacing}%`);
    check('opacity and flow come across as percentages',
        E.opacity === 100 && S.opacity === 100 && S.flow === 40,
        `${E.opacity}/${E.flow} and ${S.opacity}/${S.flow}`);
    /* A gaussian tip has no hard edge even with both fade sliders at zero,
     * so reading the sliders literally would import a soft eraser as a disc. */
    /* Krita's fade is the share of the radius that stays SOLID (checked
     * against KisCircleMaskGenerator::valueAt): this eraser is a gauss tip
     * at fade 0, the softest there is. Read backwards it came in at 30. */
    check('a soft generated tip does not arrive hard-edged',
        E.hardness === 0 && /^krita-gauss/.test(E.falloff), `hardness ${E.hardness} ${E.falloff}`);
    {
        const hard = BP => BP.toPreset({ params: { brush_definition:
            '<Brush type="auto_brush" spacing="0.1" useAutoSpacing="1" autoSpacingCoeff="0.8">' +
            '<MaskGenerator id="default" type="circle" hfade="1" vfade="1" diameter="32" ratio="1"/></Brush>' } }).params;
        const H = JSON.parse(await page.eval(`JSON.stringify((${hard})(BrushPack))`));
        check('a fade of 1 is a hard disc, not the softest brush',
            H.hardness === 100 && H.falloff === 'krita', `hardness ${H.hardness}`);
        check('auto spacing keeps its coefficient',
            H.autoSpacing === 0.8, String(H.autoSpacing));
        /* Found by painting against real Krita (test/krita): with no size
         * or flow option switched on, ours fell back to its own defaults and
         * shrank and faded Basic-2 Opacity under a light touch. */
        check('an option Krita has switched off holds its dial still',
            H.sizeSrc === 'none' && H.flowSrc === 'none', `${H.sizeSrc} / ${H.flowSrc}`);
        const sens = BP => {
            const bd = '<Brush type="auto_brush" spacing="0.1"><MaskGenerator id="default" ' +
                'type="circle" hfade="1" vfade="1" diameter="32" ratio="1"/></Brush>';
            const tilt = '<params id="declination"><curve>0,1;1,0.1;</curve></params>';
            return [
                BP.toPreset({ params: { brush_definition: bd, PressureSize: 'true', SizeUseCurve: 'true', SizeSensor: tilt } }).params,
                BP.toPreset({ params: { brush_definition: bd, PressureSize: 'true', SizeUseCurve: 'false', SizeSensor: tilt } }).params
            ].map(p => p.sizeSrc);
        };
        const [tiltSrc, noCurve] = JSON.parse(await page.eval(`JSON.stringify((${sens})(BrushPack))`));
        check("Krita's declination reads the pen Krita's way up",
            tiltSrc === 'elevation', tiltSrc);
        check('an option switched on without "use curve" follows no sensor',
            noCurve === 'none', noCurve);
        /* Found against real Krita: drawing angle writes attributes before
        * its id, the id went unread, and Pencil-4 turned with pressure. */
        const more = BP => {
            const bd = '<Brush type="auto_brush" spacing="0.1"><MaskGenerator id="default" ' +
                'type="circle" hfade="1" vfade="1" diameter="32" ratio="1"/></Brush>';
            return BP.toPreset({ params: { brush_definition: bd,
                PressureRotation: 'true', RotationUseCurve: 'true',
                RotationSensor: '<params fanCornersStep="30" fanCornersEnabled="0" id="drawingangle"/>',
                'Texture/Pattern/Enabled': 'true', 'Texture/Pattern/Name': 'dots.png',
                'Texture/Pattern/TexturingMode': '1', 'Texture/Pattern/Brightness': '0.55',
                'Texture/Pattern/Contrast': '0.6', 'Texture/Pattern/Scale': '0.5',
                'PressureTexture/Strength/': 'true', 'Texture/Strength/UseCurve': 'true',
                'Texture/Strength/Sensor': '<params id="pressure"><curve>0,0.4;1,1;</curve></params>' } }).params;
        };
        const M = JSON.parse(await page.eval(`JSON.stringify((${more})(BrushPack))`));
        check('a sensor named after other attributes is still read',
            M.angleSrc === 'direction', M.angleSrc);
        check("Krita's texture keeps its own maths and pressure response",
            M.textureMode === 'subtract' && M.textureBrightness === 0.55 && M.textureContrast === 0.6 &&
            M.textureScale === 0.5 && M.textureSrc === 'pressure' && Array.isArray(M.textureCurve),
            JSON.stringify([M.textureMode, M.textureBrightness, M.textureContrast, M.textureScale, M.textureSrc]));
        /* Found against real Krita: Airbrush Soft's tip is Krita's "soft"
         * generator, whose falloff IS its curve, and Waterpaint Soft Edges
         * takes a whole second stroke off itself (subtract masking brush). */
        const wp = BP => {
            const soft = '<Brush type="auto_brush" spacing="0.1"><MaskGenerator id="soft" type="circle" ' +
                'diameter="60" ratio="1" hfade="0.5" vfade="0.5" softness_curve="0,0.4;0.43,0.12;1,0;"/></Brush>';
            return {
                corner: BP.parseCurve('<curve>0,0;0.5,0.2,is_corner;1,1;</curve>'),
                soft: BP.toPreset({ params: { brush_definition: soft } }).params,
                mask: BP.toPreset({ params: { brush_definition: soft,
                    'MaskingBrush/Enabled': 'true', 'MaskingBrush/MaskingCompositeOp': 'subtract',
                    'MaskingBrush/MasterSizeCoeff': '1.15', 'MaskingBrush/Preset/brush_definition': soft,
                    'MaskingBrush/Preset/FlowValue': '0.67', 'MaskingBrush/Preset/PressureSize': 'true',
                    'MaskingBrush/Preset/SizeUseCurve': 'true',
                    'MaskingBrush/Preset/SizeSensor': '<params id="pressure"><curve>0,0.2;1,1;</curve></params>' } }).params,
                dodge: BP.toPreset({ params: { brush_definition: soft,
                    'MaskingBrush/Enabled': 'true', 'MaskingBrush/MaskingCompositeOp': 'linear_dodge',
                    'MaskingBrush/MasterSizeCoeff': '0.45',
                    'MaskingBrush/Preset/brush_definition': soft.replace('id="soft"', 'id="default"'),
                    'MaskingBrush/Preset/PressureOpacity': 'true', 'MaskingBrush/Preset/OpacityUseCurve': 'true',
                    'MaskingBrush/Preset/OpacitySensor': '<params id="pressure"><curve>0,0;0.8,0.35;1,0.76;</curve></params>' } }).params
            };
        };
        const W = JSON.parse(await page.eval(`JSON.stringify((${wp})(BrushPack))`));
        check("a Krita curve point marked as a corner keeps the mark",
            JSON.stringify(W.corner[1]) === '[0.5,0.2,1]', JSON.stringify(W.corner));
        check("Krita's soft tip keeps its own falloff curve",
            W.soft.shape === 'circle' && W.soft.tipCurve.length === 3 && W.soft.curveSmooth === true,
            JSON.stringify([W.soft.shape, W.soft.tipCurve, W.soft.curveSmooth]));
        check('a subtract masking brush becomes a second stroke with its own dynamics',
            W.mask.maskOp === 'subtract' && W.mask.maskSize === 115 && W.mask.maskFlow === 67 &&
            W.mask.maskSpacing === 10 && W.mask.maskSizeSrc === 'pressure' && W.mask.maskTipCurve.length === 3 &&
            !W.mask._tip2Url, JSON.stringify([W.mask.maskOp, W.mask.maskSize, W.mask.maskFlow, W.mask.maskSizeSrc]));
        check('a linear-dodge masking brush becomes an added second stroke, soft edge and opacity kept',
            W.dodge.maskOp === 'add' && W.dodge.maskSize === 45 && W.dodge.maskHardness === 50 &&
            W.dodge.maskOpacitySrc === 'pressure' && W.dodge.maskOpacityCurve.length === 3 && !W.dodge._tip2Url,
            JSON.stringify([W.dodge.maskOp, W.dodge.maskSize, W.dodge.maskHardness, W.dodge.maskOpacitySrc]));
        check("a Krita preset reads speed against Krita's 30 px/ms ceiling", W.soft.speedMax === 30, W.soft.speedMax);
        // Krita turns its tip the other way from ctx.rotate; a lone Charcoal Pencil dab leaned wrong.
        const turned = await page.eval(`BrushPack.toPreset({ params: { brush_definition:
            '<Brush type="auto_brush" angle="0.5" spacing="0.1"><MaskGenerator id="default" type="circle" diameter="20" ratio="0.5" hfade="1" vfade="1"/></Brush>' } }).params.angle`);
        check("a Krita tip's fixed angle is turned Krita's way round", turned === 331, 'angle ' + turned);
        // Waterpaint Soft Edges: a 0.19 random rotation, and mirror boxes ticked with the option off.
        const wpRot = JSON.parse(await page.eval(`JSON.stringify(BrushPack.toPreset({ params: {
            brush_definition: '<Brush type="auto_brush" angle="0" spacing="0.1"><MaskGenerator id="default" type="circle" diameter="20" ratio="0.5" hfade="1" vfade="1"/></Brush>',
            PressureRotation: 'true', RotationUseCurve: 'true', RotationValue: '0.19',
            RotationSensor: '<params id="fuzzy"><curve>0,0.20603;1,0.889447;</curve></params>',
            PressureMirror: 'false', VerticalMirrorEnabled: 'true' } }).params)`));
        check("Krita's rotation keeps its strength and curve, and an unticked mirror stays off",
            wpRot.angleSrc === 'random' && wpRot.angleStrength === 0.19 && wpRot.angleCurve.length === 2 && !wpRot.tipMirror,
            JSON.stringify([wpRot.angleSrc, wpRot.angleStrength, wpRot.angleCurve, wpRot.tipMirror]));
        /* Krita's oil_knife.png is dark on opaque white, bar eleven pixels
         * at alpha 192; trusting the alpha stamped the whole white square. */
        const knife = await page.eval(`(async () => {
            const c = document.createElement('canvas'); c.width = c.height = 16;
            const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 16, 16);
            x.fillStyle = '#000'; x.fillRect(6, 6, 4, 4);
            x.clearRect(0, 0, 1, 1);
            const u8 = new Uint8Array(await (await new Promise(r => c.toBlob(r))).arrayBuffer());
            const tip = await BrushPack.tipStrip(u8, 'knife.png', { krita: true });
            const img = new Image(); img.src = tip.url; await img.decode();
            const g = document.createElement('canvas').getContext('2d'); g.drawImage(img, 0, 0);
            return [g.getImageData(3, 3, 1, 1).data[3], g.getImageData(8, 8, 1, 1).data[3]].join(',');
        })()`, { awaitPromise: true });
        check("a grey Krita tip is ink where it is dark, whatever its alpha says",
            knife === '0,255', knife);
    }
    check('an eraser still erases',
        E.blendMode === 'erase' && tr.blendKnown, String(E.blendMode));
    check('the pressure curve carries over point for point',
        Array.isArray(E.sizeCurve) && E.sizeSrc === 'pressure' &&
        E.sizeCurve.length === 2 && Math.abs(E.sizeCurve[0][1] - 0.487437) < 1e-4,
        JSON.stringify(E.sizeCurve));
    check('...and a four-point one keeps all four',
        Array.isArray(S.sizeCurve) && S.sizeCurve.length === 4,
        JSON.stringify(S.sizeCurve));
    /* Krita keeps every widget's last value whether or not the option is
     * switched on, so reading values alone flings unscattered brushes apart. */
    check('a setting the brush had switched off stays off',
        E.scatter === 0 && S.scatter === 0, `${E.scatter} / ${S.scatter}`);
    check('a stamped tip is sized from its image, not from the scale alone',
        S.shape === 'custom' && tr.stamp.tipFile === 'bristle.png' &&
        S.size === Math.round(tr.stamp.tipSize * 0.296296) && S.size > 1,
        `${S.size} from a ${tr.stamp.tipSize}px tip`);
    check('a translated brush is one our engine will actually paint with',
        tr.stampInk > 500, `${tr.stampInk} pixels of ink`);
    check('a brush we can reproduce exactly reports nothing',
        tr.stamp.warnings.length === 0, JSON.stringify(tr.stamp.warnings));
    /* This eraser drives its opacity from pressure as well as its flow.
     * Krita's opacity is the level a stroke's ink stops at (alpha darken),
     * its flow how much each dab adds, so they stay two controls. Folding
     * opacity into flow let dabs stack past it: measured against real Krita
     * (test/krita), Basic-2 Opacity came out 1.6x too dark. */
    check("Krita's opacity response becomes the dab's ceiling, flow keeps its own",
        tr.eraser.warnings.length === 0 && tr.eraser.params.dabOpacitySrc === 'pressure' &&
        tr.eraser.params.flowSrc === 'pressure' && Array.isArray(tr.eraser.params.dabOpacityCurve),
        JSON.stringify(tr.eraser.warnings) + ' ' + tr.eraser.params.dabOpacitySrc + ' ' +
        JSON.stringify(tr.eraser.params.dabOpacityCurve));

    console.log('== found by the brush bank (test/krita/bank.mjs, test/gimp/bank.mjs) ==');
    {
        const bank = BP => {
            const bd = (gen, type, h, v) => '<Brush type="auto_brush" spacing="0.1"><MaskGenerator id="' + gen +
                '" type="' + type + '" hfade="' + h + '" vfade="' + v + '" diameter="30" ratio="1"/></Brush>';
            const round = bd('default', 'circle', 1, 1);
            return {
                // Revoy's Mechanical Pencil: one curve shared by every sensor.
                common: BP.toPreset({ params: { brush_definition: round, PressureSize: 'true', SizeUseCurve: 'true',
                    SizeSensor: '<params id="pressure"><curve>0,0;1,1;</curve></params>',
                    SizecommonCurve: '0,0;1,0.5;' } }).params.sizeCurve,
                own: BP.toPreset({ params: { brush_definition: round, PressureSize: 'true', SizeUseCurve: 'true',
                    SizeUseSameCurve: 'false', SizeSensor: '<params id="pressure"><curve>0,0;1,1;</curve></params>',
                    SizecommonCurve: '0,0;1,0.5;' } }).params.sizeCurve,
                buildUp: BP.toPreset({ params: { brush_definition: round, PaintOpAction: '1', OpacityValue: '0.25', FlowValue: '0.25' } }).params,
                wash: BP.toPreset({ params: { brush_definition: round, PaintOpAction: '2', OpacityValue: '0.25', FlowValue: '0.25' } }).params,
                blocks: BP.toPreset({ params: { brush_definition: bd('gauss', 'rect', 0.43, 0.82) } }).params
            };
        };
        const B = JSON.parse(await page.eval(`JSON.stringify((${bank})(BrushPack))`));
        check("a sensor under Krita's \"same curve for all\" takes the shared curve",
            B.common && B.common[B.common.length - 1][1] === 0.5, JSON.stringify(B.common));
        check('...and one with the box unticked keeps its own',
            B.own && B.own[B.own.length - 1][1] === 1, JSON.stringify(B.own));
        /* Ramon's Airbrush Digital (build up, 25%/25%) peaked at 15% in
         * Krita and 3.5% here: a build-up dab lands at the opacity and flow
         * plays no part. */
        check('a "build up" brush spends its opacity on each dab and ignores flow',
            B.buildUp.flow === 25 && B.buildUp.opacity === 100, `${B.buildUp.flow} / ${B.buildUp.opacity}`);
        check('...and a "wash" brush keeps opacity as the stroke\'s ceiling',
            B.wash.flow === 25 && B.wash.opacity === 25, `${B.wash.flow} / ${B.wash.opacity}`);
        check("Krita's gauss square keeps its side and end fades apart (ZBlocks)",
            B.blocks.falloff === 'krita-gauss' && B.blocks.hardness === 43 && B.blocks.hardnessY === 82,
            JSON.stringify([B.blocks.falloff, B.blocks.hardness, B.blocks.hardnessY]));

        /* GIMP tips. A colour .gbr is a picture GIMP stamps through its
         * alpha (Pepper came out grey at half its ink); a .gih stepped in
         * order paints cell 1 first. The Krita path reads the same colour
         * file as a dark-is-ink mask, so it must stay that way there. */
        const gimp = await page.eval(`(async () => {
            const gbr = (w, h, bpp, px) => {
                const name = new TextEncoder().encode('t\\0'), head = 28 + name.length;
                const b = new Uint8Array(head + px.length), dv = new DataView(b.buffer);
                [head, 2, w, h, bpp, 0x47494D50, 25].forEach((v, i) => dv.setUint32(i * 4, v));
                b.set(name, 28); b.set(px, head); return b;
            };
            // 2x1 RGBA: an opaque pure red pixel and a half-clear white one.
            const col = gbr(2, 1, 4, [255, 0, 0, 255, 255, 255, 255, 128]);
            const readBack = async url => { const i = new Image(); i.src = url; await i.decode();
                const c = new OffscreenCanvas(i.width, i.height), g = c.getContext('2d'); g.drawImage(i, 0, 0);
                return Array.from(g.getImageData(0, 0, i.width, i.height).data); };
            const asGimp = await BrushPack.tipStrip(col, 'c.gbr');
            const asKrita = await BrushPack.tipStrip(col, 'c.gbr', { krita: true });
            // Three 1x1 cells, alpha 10/20/30, stepped in order.
            const head = new TextEncoder().encode('p\\n3 ncells:3 cellwidth:1 cellheight:1 step:100 dim:1 cols:1 rows:1 placement:constant rank0:3 sel0:incremental\\n');
            const cells = [10, 20, 30].map(a => gbr(1, 1, 1, [a]));
            const gih = new Uint8Array(head.length + cells.reduce((s, c) => s + c.length, 0));
            let o = head.length; gih.set(head, 0); for (const c of cells) { gih.set(c, o); o += c.length; }
            const pipe = await BrushPack.tipStrip(gih, 'p.gih');
            const px = await readBack(pipe.url);
            return JSON.stringify({ gimpMode: asGimp.params && asGimp.params.tipMode, kritaMode: asKrita.params && asKrita.params.tipMode,
                gimpPx: await readBack(asGimp.url), kritaPx: await readBack(asKrita.url),
                order: [px[3], px[7], px[11]], pick: pipe.pick });
        })()`, { awaitPromise: true });
        const G = JSON.parse(gimp);
        check('a colour GIMP brush paints its own colours through its own alpha',
            G.gimpMode === 'color' && G.gimpPx[0] === 255 && G.gimpPx[1] === 0 && G.gimpPx[3] === 255 &&
            Math.abs(G.gimpPx[7] - 128) <= 1, JSON.stringify([G.gimpMode, G.gimpPx]));
        check('...while inside a Krita preset it stays a dark-is-ink mask',
            !G.kritaMode && G.kritaPx[7] === 0 && G.kritaPx[3] > 100, JSON.stringify([G.kritaMode, G.kritaPx]));
        check("a GIMP pipe stepped in order starts on its second cell, as GIMP's does",
            G.pick === 'cycle' && G.order.join() === '20,30,10', JSON.stringify(G.order));
    }

    console.log('== junk in, no crash out ==');
    const junk = JSON.parse(await page.eval(`(async () => {
        const out = {};
        const bad = new Uint8Array([1,2,3,4,5,6,7,8,9,10]);
        try { await BrushPack.read(bad); out.raw = 'resolved'; }
        catch (e) { out.raw = e.message; }
        // A ZIP with nothing brush-shaped in it.
        const empty = new Uint8Array([0x50,0x4b,0x05,0x06,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]);
        try { await BrushPack.read(empty); out.empty = 'resolved'; }
        catch (e) { out.empty = e.message; }
        return JSON.stringify(out);
    })()`));
    console.log('  ' + JSON.stringify(junk));
    check('a file that is not a brush pack is refused, not swallowed',
        junk.raw !== 'resolved' && junk.empty !== 'resolved',
        `${junk.raw} / ${junk.empty}`);
    check('...with a message a person can act on',
        /brush|ZIP|preset/i.test(junk.raw) && /brush|preset/i.test(junk.empty),
        `${junk.raw} / ${junk.empty}`);

    const errs = page.errors();
    console.log(`\npage errors: ${errs.length}`);
    for (const e of errs.slice(0, 5)) console.log('  ! ' + e.text.split('\n')[0]);
    console.log(`\n${pass} passed, ${fail} failed`);
});

process.exit(fail ? 1 : 0);
