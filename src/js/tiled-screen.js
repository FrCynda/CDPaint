/* Opening a tiled screen as the picture it is, and saving it back as tiles.
 *
 * Everything hard is elsewhere and tested there: battle-scene.js assembles,
 * retile.js takes apart, tiled-asset.js works out the shape. This is the wiring
 * — read three files, hand the editor an ordinary indexed picture, and on save
 * turn the canvas back into three files.
 *
 * Handing the editor a *synthesised PNG* rather than teaching it about tilemaps
 * is deliberate. Every existing path — palette handling, undo, the dirty flag,
 * the export checks — already works on an indexed PNG, and none of it needs to
 * know this one was assembled a moment ago out of a tile sheet.
 */
(function () {
    'use strict';

    var current = null;   // the screen the canvas is currently showing

    function getApp() { return window.PaintApp; }
    function project() { return window.PokeProject; }
    function toast(msg, kind) {
        if (typeof window.showToast === 'function') window.showToast(msg, kind || 'info');
    }

    /* Colour 0 of every bank is transparent on a GBA background. Flattened into
       one palette that is index 0, 16, 32… and marking all of them keeps the
       transparency the artist sees identical to the transparency the hardware
       applies. */
    function trnsFor(count) {
        var t = new Uint8Array(count);
        for (var i = 0; i < count; i++) t[i] = (i % 16) === 0 ? 0 : 255;
        return t;
    }

    /* Is this file a screen? Answers from the folder listing the browser
       already has, so nothing extra is read to find out. */
    function match(relPath, siblingNames) {
        if (!window.TiledAsset) return null;
        return window.TiledAsset.describe(relPath, siblingNames || []);
    }

    async function open(descriptor, node) {
        var app = getApp(), p = project();
        if (!app || !p || typeof p.readBytes !== 'function') return false;
        if (!window.BattleScene || !window.TiledAsset) return false;

        var tilesBytes = await p.readBytes(descriptor.tilesPath);
        var meta = app.parsePngPalette(tilesBytes);
        var sheet = await app.decodePngIndices(meta);
        var map = window.BattleScene.parseTilemap(await p.readBytes(descriptor.mapPath));
        var layout = window.TiledAsset.layoutFrom(map);
        if (!layout) { toast('That tilemap is too small to be a screen', 'warning'); return false; }

        /* The palette file when there is one, the sheet's own table when there
           is not — the older previews keep their colours in the PNG. */
        var palette = null;
        if (descriptor.palettes.length) {
            var text = new TextDecoder().decode(await p.readBytes(descriptor.palettes[0]));
            palette = window.BattleScene.parseJascPal(text);
        }
        if (!palette && meta.palette) {
            palette = [];
            for (var i = 0; i < meta.palette.length; i += 3) {
                palette.push({ r: meta.palette[i], g: meta.palette[i + 1], b: meta.palette[i + 2] });
            }
        }
        if (!palette || !palette.length) { toast('No palette for that screen', 'warning'); return false; }

        var picture = window.BattleScene.assembleIndices(
            { indices: sheet, width: meta.width }, map, layout);
        if (!picture) { toast('That screen did not assemble', 'warning'); return false; }

        /* 8bpp because the flattened palette runs past 16 — three banks of a map
           preview is 48 entries, and the index carries the bank in its high
           nibble exactly as the tile sheets on disk do. */
        var png = await app.generateIndexedPNG(
            layout.width, layout.height, picture.indices, palette, 8, trnsFor(palette.length));

        /* Named for the folder, because that is what the screen is called —
           every one of them is `tiles.png` and a tab strip of those is useless. */
        var parts = descriptor.tilesPath.split('/');
        var name = (parts[parts.length - 2] || 'screen') +
            (descriptor.stem ? ' ' + descriptor.stem.replace(/_$/, '') : '') + '.png';
        var ok = await app.applyProjectImageBytes(png, name, '', [], descriptor.tilesPath);
        if (!ok) return false;

        current = {
            descriptor: descriptor,
            layout: layout,
            palette: palette,
            bitDepth: meta.bitDepth || 8,
            sheetWidthTiles: Math.max(1, (meta.width / 8) | 0),
            root: node && node.path ? node.path : null,
            identity: descriptor.tilesPath
        };
        /* The hardware shows 240 of the 256 columns. The rest has to stay in the
           file, but saying so is what stops someone detailing a strip nobody
           will ever see. */
        var off = window.TiledAsset.offscreenColumns(layout);
        toast('Assembled ' + layout.width + '×' + layout.height + ' from tiles + tilemap' +
            (off ? ' — the last ' + off.width + 'px never show in game' : ''), 'success');
        return true;
    }

    /* The canvas is only still this screen while the editor is showing it —
       opening anything else has to hand saving back to the ordinary path. */
    function isOpen() {
        var app = getApp();
        return !!(current && app && app.state && app.state.projectFile === current.identity);
    }

    function absolute(relPath) {
        var p = project(), m = p && p.model && p.model();
        if (!m || !m.root) return null;
        return String(m.root).replace(/[\\/]+$/, '') + '/' + relPath;
    }

    async function save() {
        var app = getApp();
        if (!isOpen() || !window.Retile) return false;

        var w = app.config.width, h = app.config.height;
        var indices = app.spriteIndices;
        if (!indices || indices.length < w * h) {
            toast('The canvas and its palette are out of step; reopen the screen', 'error');
            return false;
        }
        if (w !== current.layout.width || h !== current.layout.height) {
            toast('A screen has to stay ' + current.layout.width + '×' + current.layout.height, 'error');
            return false;
        }

        var r = window.Retile.retile(indices, w, h, {
            paletteBase: current.layout.paletteBase,
            sheetWidthTiles: current.sheetWidthTiles
        });
        if (!r) { toast('Could not cut that picture into tiles', 'error'); return false; }

        /* The one rule a paint program cannot enforce. Refusing is the whole
           point: writing a screen whose cells span two banks produces a file
           that builds and then renders in the wrong colours, which is far worse
           than a message. */
        if (r.conflicts.length) {
            var c = r.conflicts[0];
            toast(r.conflicts.length + ' tile' + (r.conflicts.length > 1 ? 's' : '') +
                ' use more than one palette — first at ' + c.x + ',' + c.y +
                ' (banks ' + c.banks.join(' and ') + '). Nothing written.', 'error');
            if (window.TiledScreen.onConflicts) window.TiledScreen.onConflicts(r.conflicts);
            return false;
        }

        var sheetPng = await app.generateIndexedPNG(
            r.tiles.width, r.tiles.height, r.tiles.indices,
            current.palette, current.bitDepth === 4 ? 4 : 8, trnsFor(current.palette.length));
        var mapBytes = window.Retile.tilemapBytes(r.map);

        var tilesAt = absolute(current.descriptor.tilesPath);
        var mapAt = absolute(current.descriptor.mapPath);
        if (!tilesAt || !mapAt || typeof app.tauriWriteAllowedFile !== 'function') {
            toast('Saving a screen needs the desktop app and a hooked project', 'warning');
            return false;
        }

        await app.tauriWriteAllowedFile(tilesAt, sheetPng);
        await app.tauriWriteAllowedFile(mapAt, mapBytes);
        app.markSaved(current.descriptor.tilesPath.replace(/^.*\//, ''));
        toast('Wrote ' + r.tileCount + ' tiles and a ' + r.map.length + '-cell tilemap', 'success');
        return true;
    }

    window.TiledScreen = {
        match: match, open: open, isOpen: isOpen, save: save,
        current: function () { return current; },
        forget: function () { current = null; }
    };
})();
