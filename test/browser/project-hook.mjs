/* Hooking a folder in the browser, over a fake directory handle.
 *
 * The other suites stub PokeProject and test what happens after; this one
 * drives the real thing — the Hook button, the real scan, the real tree — and
 * exists because two bugs lived exactly there and nowhere else:
 *
 *   - the scan filtered to .png and .pal, so a tiles.png never saw the map.bin
 *     beside it and never got its screen tag. The panel looked fine and the
 *     feature was simply absent.
 *   - the folder is hooked read-only, so writing a screen back has to ask for
 *     the upgrade or fail on the first save.
 *
 * The handle below is the File System Access API's shape over an object of
 * bytes, which is all the panel ever touches.
 *
 *   node test/browser/project-hook.mjs
 */
import { withPage } from '../browser.mjs';
import { makePng } from '../png-fixture.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

const palette = [];
for (let i = 0; i < 48; i++) palette.push([i * 5, 40 + (i % 3) * 60, 200 - i * 3]);
const tilesPng = Array.from(makePng({
    w: 16, h: 8, depth: 8, palette,
    indices: Uint8Array.from({ length: 128 }, (_, i) => ((i % 16) < 8 ? 1 : 2))
}));
const mapBin = [];
for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 32; x++) {
        const e = (x === 3 && y === 1) ? (1 | (14 << 12)) : (0 | (13 << 12));
        mapBin.push(e & 0xff, (e >> 8) & 0xff);
    }
}
const palText = 'JASC-PAL\r\n0100\r\n48\r\n' +
    palette.map(c => `${c[0]} ${c[1]} ${c[2]}`).join('\r\n') + '\r\n';

/* A screen, and a lone PNG in another folder that must NOT be called one. */
const FS = `
    const files = {
        'graphics/map_preview/x/tiles.png': new Uint8Array(${JSON.stringify(tilesPng)}),
        'graphics/map_preview/x/map.bin': new Uint8Array(${JSON.stringify(mapBin)}),
        'graphics/map_preview/x/palette.pal': new TextEncoder().encode(${JSON.stringify(palText)}),
        'graphics/pokemon/testmon/anim_front.png': new Uint8Array(${JSON.stringify(tilesPng)})
    };
    window.__files = files;
    function fileHandle(path) {
        return {
            kind: 'file', name: path.split('/').pop(),
            getFile: async () => new File([files[path] || new Uint8Array()], path.split('/').pop()),
            createWritable: async () => {
                const chunks = [];
                return {
                    write: async (d) => { chunks.push(d); },
                    close: async () => {
                        files[path] = new Uint8Array(await new Blob(chunks).arrayBuffer());
                    }
                };
            }
        };
    }
    function dirHandle(prefix, name) {
        const kids = () => {
            const out = new Map();
            for (const p in files) {
                if (prefix && p.indexOf(prefix) !== 0) continue;
                const rest = p.slice(prefix.length);
                const cut = rest.indexOf('/');
                if (cut < 0) out.set(rest, fileHandle(p));
                else if (!out.has(rest.slice(0, cut))) {
                    out.set(rest.slice(0, cut), dirHandle(prefix + rest.slice(0, cut + 1), rest.slice(0, cut)));
                }
            }
            return out;
        };
        return {
            kind: 'directory', name,
            entries: () => kids().entries(),
            getDirectoryHandle: async (n) => {
                const h = kids().get(n);
                if (!h || h.kind !== 'directory') throw new Error('no dir ' + n);
                return h;
            },
            getFileHandle: async (n, o) => {
                const h = kids().get(n);
                if (h && h.kind === 'file') return h;
                if (o && o.create) return fileHandle(prefix + n);
                throw new Error('no file ' + n);
            },
            requestPermission: async (o) => { window.__asked = o && o.mode; return 'granted'; }
        };
    }
    window.showDirectoryPicker = async () => dirHandle('', 'proj');
    const settle = async () => {
        for (let i = 0; i < 100; i++) {
            if (document.querySelectorAll('#project-tree .proj-row-file').length) return true;
            await new Promise(r => setTimeout(r, 50));
        }
        return false;
    };
`;

await withPage(async (page) => {
    console.log('hooking a folder');

    const hooked = await page.eval(`(async () => {
        ${FS}
        document.getElementById('project-hook').click();
        const ready = await settle();
        const tagged = [...document.querySelectorAll('#project-tree .proj-row-file')]
            .map(r => ({
                name: (r.querySelector('.proj-file-name') || {}).textContent || r.textContent,
                screen: !!r.querySelector('.proj-screen-tag')
            }));
        return { ready, tagged, rows: tagged.length };
    })()`);

    check('the Hook button scans a directory handle', hooked.ready === true);
    check('a tile sheet with a tilemap beside it is tagged as a screen',
        hooked.tagged.some(r => /tiles\.png/.test(r.name) && r.screen),
        JSON.stringify(hooked.tagged));
    check('an ordinary sprite is not',
        hooked.tagged.some(r => /anim_front/.test(r.name)) &&
        !hooked.tagged.some(r => /anim_front/.test(r.name) && r.screen),
        JSON.stringify(hooked.tagged));
    check('and the tilemap itself draws no row',
        !hooked.tagged.some(r => /\.bin/.test(r.name)), JSON.stringify(hooked.tagged));

    /* Clicking the tagged row has to open the assembled picture, and Ctrl+S has
       to put both files back through the handle — read-only hook and all. */
    const round = await page.eval(`(async () => {
        const row = [...document.querySelectorAll('#project-tree .proj-row-file')]
            .find(r => r.querySelector('.proj-screen-tag'));
        row.click();
        for (let i = 0; i < 100; i++) {
            if (window.TiledScreen.isOpen()) break;
            await new Promise(r => setTimeout(r, 50));
        }
        const before = Array.from(window.__files['graphics/map_preview/x/map.bin']);
        const opened = { w: PaintApp.config.width, h: PaintApp.config.height,
                         isOpen: window.TiledScreen.isOpen() };
        PaintApp.spriteIndices[0] = 3;          // a colour from the same bank
        await PaintApp.saveFile();
        const after = Array.from(window.__files['graphics/map_preview/x/map.bin']);
        return {
            opened, asked: window.__asked,
            mapLen: after.length,
            mapChanged: before.join() !== after.join(),
            sheetIsPng: window.__files['graphics/map_preview/x/tiles.png'][1] === 0x50
        };
    })()`);

    check('clicking a screen row opens it assembled',
        round.opened.isOpen && round.opened.w === 256 && round.opened.h === 160,
        `${round.opened.w}×${round.opened.h}`);
    check('saving asks to upgrade the read-only hook', round.asked === 'readwrite', String(round.asked));
    check('the tilemap goes back through the handle at full size',
        round.mapLen === 1280, String(round.mapLen));
    check('an edit reaches the tilemap', round.mapChanged === true);
    check('and the tile sheet is written back as a PNG', round.sheetIsPng === true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
