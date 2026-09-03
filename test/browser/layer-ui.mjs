/* The eight manual tests, run against a real browser.
 *
 * Setup uses direct state where it saves fighting the drag-and-drop, but every
 * ACTION under test goes through the real controls — the same buttons and
 * context-menu entries a person would click — so the guards are exercised too.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

/* Injected into the page: helpers for driving the layer panel. */
const HELPERS = `
window.__t = {
    mgr: () => PaintApp.layerMgr,
    row: (i) => document.querySelector('.lsi[data-li="' + i + '"]'),
    grp: (i) => document.querySelector('.lsi-group-hdr[data-gi="' + i + '"]'),
    node: (i) => window.__t.row(i) || window.__t.grp(i),
    click: (id) => { const el = document.getElementById(id); if (!el) throw new Error('no #' + id); el.click(); },
    menu: (i) => {
        const el = window.__t.node(i);
        if (!el) throw new Error('no layer row ' + i);
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
    },
    shown: (id) => {
        const el = document.getElementById(id);
        return !!el && el.style.display !== 'none';
    },
    // A compact, comparable picture of the stack.
    tree: () => PaintApp.layerMgr.layers.map(l => ({
        name: l.name, id: l.id, parentId: l.parentId == null ? null : l.parentId,
        isGroup: !!l.isGroup, clipped: !!l.clipped, opacity: l.opacity,
        blendMode: l.blendMode, hasMask: !!(l.mask && l.mask.canvas),
        maskEnabled: l.mask ? l.mask.enabled !== false : null
    })),
    addLayer: (n) => { for (let i = 0; i < (n || 1); i++) window.__t.click('lsys-add'); },
    fill: (i, css) => {
        const l = PaintApp.layerMgr.layers[i];
        l.ctx.fillStyle = css;
        l.ctx.fillRect(0, 0, PaintApp.config.width, PaintApp.config.height);
        l._dirty = true;
    },
    // Read a composited pixel straight off the display surface.
    pixel: (x, y) => {
        PaintApp.layerMgr.render();
        const d = PaintApp.ui.cMain.getContext('2d').getImageData(x, y, 1, 1).data;
        return [d[0], d[1], d[2], d[3]];
    },
    reset: () => {
        PaintApp.layerMgr.collapseToBase({ fresh: true });
        PaintApp.state.history = []; PaintApp.state.step = -1;
        const c = PaintApp.ui.cMain.getContext('2d');
        c.clearRect(0, 0, PaintApp.config.width, PaintApp.config.height);
    }
};
true`;

await withPage(async (page) => {
    await page.run(HELPERS + "; return true;");

    console.log('== 1. duplicate carries the mask and the clipping ==');
    {
        const r = await page.eval(`(() => {
            __t.reset();
            __t.addLayer(1);                       // Background + Layer 2
            const mgr = __t.mgr();
            mgr.activeIdx = 1;
            __t.menu(1); __t.click('lsctx-mask-add');   // add a mask via the menu
            mgr.layers[1].clipped = true;
            mgr.layers[1].opacity = 0.4;
            mgr.layers[1].blendMode = 'multiply';
            __t.menu(1); __t.click('lsctx-dup');        // duplicate via the menu
            return { tree: __t.tree(), active: mgr.activeIdx };
        })()`);
        const copy = r.tree[2];
        check('a copy was inserted above the original', !!copy && /copy/.test(copy.name), JSON.stringify(r.tree.map(t => t.name)));
        check('the mask came with it', copy && copy.hasMask === true);
        check('the clipping came with it', copy && copy.clipped === true);
        check('opacity and blend came with it', copy && copy.opacity === 0.4 && copy.blendMode === 'multiply');
        check('the copy is selected', r.active === 2);
    }

    console.log('\n== 2. duplicating a folder duplicates its contents ==');
    {
        const r = await page.eval(`(() => {
            __t.reset();
            __t.addLayer(2);                       // Background, L2, L3
            const mgr = __t.mgr();
            mgr.activeIdx = 1;
            __t.click('lsys-group');               // folder swallows L2
            const gid = mgr.layers.find(l => l.isGroup).id;
            mgr.layers[3].parentId = gid;          // put L3 in the folder too
            const gi = mgr.layers.findIndex(l => l.isGroup);
            mgr.activeIdx = gi;
            const before = mgr.layers.length;
            __t.menu(gi); __t.click('lsctx-dup');
            return { before, tree: __t.tree(), active: mgr.activeIdx };
        })()`);
        check('three new entries appeared, not one empty folder',
            r.tree.length === r.before + 3, `${r.before} -> ${r.tree.length}`);
        const gCopy = r.tree.find(t => t.isGroup && /copy/.test(t.name));
        check('the folder copy exists', !!gCopy);
        const kids = r.tree.filter(t => gCopy && t.parentId === gCopy.id);
        check('both children were copied into the new folder', kids.length === 2, String(kids.length));
        const orig = r.tree.find(t => t.isGroup && !/copy/.test(t.name));
        check('the original folder kept its own two',
            r.tree.filter(t => t.parentId === orig.id).length === 2);
        check('every id is still unique',
            new Set(r.tree.map(t => t.id)).size === r.tree.length);
    }

    console.log('\n== 3. deleting a folder takes its contents with it ==');
    {
        const r = await page.eval(`(() => {
            __t.reset();
            __t.addLayer(2);
            const mgr = __t.mgr();
            mgr.activeIdx = 1;
            __t.click('lsys-group');
            const gid = mgr.layers.find(l => l.isGroup).id;
            mgr.layers[3].parentId = gid;
            const gi = mgr.layers.findIndex(l => l.isGroup);
            mgr.activeIdx = gi;
            __t.menu(gi); __t.click('lsctx-del');
            return __t.tree();
        })()`);
        check('the folder and its contents are gone',
            r.length === 1 && !r.some(t => t.isGroup), JSON.stringify(r.map(t => t.name)));
        check('nothing was orphaned to the top level', !r.some(t => t.parentId !== null));
    }

    console.log('\n== 4. "New group" puts the selected layer inside ==');
    {
        const r = await page.eval(`(() => {
            __t.reset();
            __t.addLayer(1);
            const mgr = __t.mgr();
            mgr.activeIdx = 1;
            __t.click('lsys-group');
            return { tree: __t.tree(), activeName: mgr.layers[mgr.activeIdx].name };
        })()`);
        const g = r.tree.find(t => t.isGroup);
        check('a folder was created', !!g);
        check('the selected layer went into it',
            r.tree.some(t => !t.isGroup && t.parentId === g.id));
        check('the folder defaults to pass-through', g.blendMode === 'pass-through', g.blendMode);
        check('the background was left alone',
            r.tree[0].parentId === null && !r.tree[0].isGroup);
        check('the layer inside stays selected', !/Group/.test(r.activeName), r.activeName);
    }

    console.log('\n== 5. layer opacity is undoable, in one step ==');
    {
        const r = await page.eval(`(() => {
            __t.reset();
            __t.addLayer(1);
            const mgr = __t.mgr();
            mgr.activeIdx = 1;
            PaintApp.saveState();                       // a committed starting point
            const before = PaintApp.state.history.length;
            const sl = document.getElementById('lsys-op');
            // Drag: many 'input' events, one 'change' on release.
            for (const v of [90, 80, 70, 60, 50]) {
                sl.value = v;
                sl.dispatchEvent(new Event('input', { bubbles: true }));
            }
            const during = PaintApp.state.history.length;
            sl.dispatchEvent(new Event('change', { bubbles: true }));
            const after = PaintApp.state.history.length;
            const set = mgr.layers[1].opacity;
            PaintApp.undo();
            return { before, during, after, set, undone: mgr.layers[1].opacity };
        })()`);
        check('dragging the slider adds no history steps', r.during === r.before,
            `${r.before} -> ${r.during}`);
        check('releasing it adds exactly one', r.after === r.before + 1,
            `${r.during} -> ${r.after}`);
        check('the opacity actually changed', Math.abs(r.set - 0.5) < 0.001, String(r.set));
        check('undo restores the previous opacity', Math.abs(r.undone - 1) < 0.001, String(r.undone));
    }

    console.log('\n== 6. clipping is only offered where it can work ==');
    {
        const r = await page.eval(`(() => {
            __t.reset();
            __t.addLayer(3);                       // BG, L2, L3, L4
            const mgr = __t.mgr();
            mgr.activeIdx = 1;
            __t.click('lsys-group');               // folder at 1, L2 inside at 2
            const gid = mgr.layers.find(l => l.isGroup).id;
            mgr.layers[3].parentId = gid;          // L3 also inside -> second child
            const out = {};
            for (const i of [0, 1, 2, 3, 4]) {
                mgr.activeIdx = i;
                __t.menu(i);
                out[i] = { shown: __t.shown('lsctx-clip'),
                           isGroup: !!mgr.layers[i].isGroup,
                           name: mgr.layers[i].name };
                __t.click('lsctx-clip');           // click regardless; guard should hold
                out[i].clipped = !!mgr.layers[i].clipped;
            }
            return out;
        })()`);
        check('the background cannot clip', r[0].shown === false && r[0].clipped === false);
        check('a folder cannot clip', r[1].shown === false && r[1].clipped === false);
        check('THE BUG: the first layer inside a folder cannot clip',
            r[2].shown === false && r[2].clipped === false,
            'it has no sibling underneath, so it used to vanish silently');
        check('the second layer inside the folder CAN clip',
            r[3].shown === true && r[3].clipped === true);
        check('a top-level layer above the background can clip',
            r[4].shown === true && r[4].clipped === true);
    }

    console.log('\n== 7. pass-through actually changes the picture ==');
    {
        const r = await page.eval(`(() => {
            __t.reset();
            __t.addLayer(2);                       // BG, L2, L3
            const mgr = __t.mgr();
            // Red below, mid-grey multiplying above. The two cases give
            // visibly different colours, which white-under-grey does not:
            //   pass-through -> red x grey  = dark red   (128, 0, 0)
            //   isolated     -> grey covers = grey       (128, 128, 128)
            __t.fill(0, '#ff0000');
            mgr.activeIdx = 1;
            __t.click('lsys-group');               // folder holds L2
            const gi = mgr.layers.findIndex(l => l.isGroup);
            const li = mgr.layers.findIndex(l => l.parentId === mgr.layers[gi].id);
            __t.fill(li, '#808080');
            mgr.layers[li].blendMode = 'multiply';
            const through = __t.pixel(10, 10);
            // Turn pass-through off via the context menu.
            mgr.activeIdx = gi;
            __t.menu(gi); __t.click('lsctx-passthrough');
            const isolated = __t.pixel(10, 10);
            return { through, isolated, mode: mgr.layers[gi].blendMode };
        })()`);
        check('pass-through lets multiply darken the red underneath',
            r.through[0] > 120 && r.through[0] < 136 && r.through[1] < 10 && r.through[2] < 10,
            JSON.stringify(r.through));
        check('turning it off isolates the folder', r.mode === 'source-over');
        check('isolated, the folder covers instead of blending',
            r.isolated[1] > 120 && r.isolated[2] > 120, JSON.stringify(r.isolated));
    }

    console.log('\n== 8. a grouped, masked document survives a .ora round trip ==');
    {
        const r = await page.eval(`(() => {
            __t.reset();
            __t.addLayer(2);
            const mgr = __t.mgr();
            mgr.activeIdx = 1;
            __t.click('lsys-group');
            const gid = mgr.layers.find(l => l.isGroup).id;
            mgr.layers[3].parentId = gid;
            mgr.activeIdx = 3;
            __t.menu(3); __t.click('lsctx-mask-add');
            mgr.layers[3].clipped = true;
            mgr.layers[2].blendMode = 'multiply';
            mgr.layers[mgr.layers.findIndex(l => l.isGroup)].opacity = 0.5;
            return __t.tree();
        })()`);
        check('built a folder with two layers, a mask and a clip',
            r.length === 4 && r.some(t => t.isGroup) && r.some(t => t.hasMask) && r.some(t => t.clipped),
            JSON.stringify(r.map(t => t.name)));

        const round = await page.eval(`(async () => {
            const before = __t.tree();
            // Capture what the save writes instead of opening a file dialog.
            let bytes = null;
            window.showSaveFilePicker = async () => ({
                name: 'roundtrip.ora',
                createWritable: async () => ({
                    write: async (blob) => { bytes = new Uint8Array(await blob.arrayBuffer()); },
                    close: async () => {}
                })
            });
            await PaintApp.saveAsORA();
            if (!bytes) throw new Error('nothing was written');
            // Read it straight back in.
            PaintApp.hasUnsavedChanges = () => false;
            await PaintApp.loadORAFile(new File([bytes], 'roundtrip.ora',
                { type: 'image/openraster' }));
            return { size: bytes.length, before, after: __t.tree() };
        })()`);

        const { before, after } = round;
        check('the .ora file was written', round.size > 0, round.size + ' bytes');
        check('the same number of nodes came back', after.length === before.length,
            `${before.length} -> ${after.length}`);
        check('the folder survived', after.some(t => t.isGroup));
        const g = after.find(t => t.isGroup);
        check('its contents are still inside it',
            after.filter(t => t.parentId === g.id).length === 2,
            JSON.stringify(after.map(t => [t.name, t.parentId])));
        check('the mask survived', after.some(t => t.hasMask));
        check('the clipping survived', after.some(t => t.clipped));
        check('the blend mode survived', after.some(t => t.blendMode === 'multiply'));
        check('the folder opacity survived', Math.abs(g.opacity - 0.5) < 0.01, String(g.opacity));
        check('pass-through survived', g.blendMode === 'pass-through', g.blendMode);
    }

    const errs = page.errors();
    console.log(`\npage errors during the run: ${errs.length}`);
    for (const e of errs.slice(0, 8)) console.log('  ! ' + e.text.split('\n')[0]);

    console.log(`\n${pass} passed, ${fail} failed`);
});

process.exit(fail ? 1 : 0);
