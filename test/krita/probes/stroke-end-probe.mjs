// Where a plain round stroke's ink ends against the pen-up point (Clip Studio: at it).
import { withPage } from '../../browser.mjs';
await withPage(async (page) => {
    console.log(await page.eval(`(async () => {
        const b = PaintApp.brush, out = [];
        for (const [sp, n] of [[4, 70], [10, 70], [25, 70], [4, 800], [37, 70]]) {
            b.forgetSaved('Round'); b.loadPreset('Round');
            PaintApp.layerMgr.collapseToBase({ fresh: true }); PaintApp.setSize(1200, 300);
            document.getElementById('lsys-add').click();
            b.setParam('size', 80); b.setParam('hardness', 100); b.setParam('spacing', sp);
            b.setParam('flowSrc', 'none'); b.setParam('sizeSrc', 'none'); b.setParam('smoothingMode', 'none');
            b.beginStroke(100, 150, 1, '#000000');
            for (let i = 1; i <= n; i++) b.moveStroke(100 + 800 * i / n, 150, 1, '#000000');
            b.endStroke();
            await new Promise(r => setTimeout(r, 200));
            const L = PaintApp.layerMgr.layers[PaintApp.layerMgr.activeIdx];
            const d = L.ctx.getImageData(0, 150, 1200, 1).data;
            let lo = -1, hi = -1; for (let x = 0; x < 1200; x++) if (d[x * 4 + 3] > 2) { if (lo < 0) lo = x; hi = x; }
            out.push('spacing ' + sp + ' moves ' + n + ': ink ' + lo + '..' + hi + ' (pen 100..900, radius 40)');
        }
        return out.join(' | ');
    })()`, { awaitPromise: true }));
});
