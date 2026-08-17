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
        if (!layout) { toast('That file is not shaped like a screen map', 'warning'); return false; }

        /* The pairing is a guess made from two filenames, so prove it before
           acting on it. A map that names tile 800 against a 64-tile sheet is
           not that sheet's map — most often the PNG is a reference picture the
           tilemap was traced from, which is a real thing in these projects. */
        var sheetTiles = ((meta.width / 8) | 0) * ((meta.height / 8) | 0);
        if (layout.tiles > sheetTiles) {
            toast(descriptor.mapPath.replace(/^.*\//, '') + ' asks for ' + layout.tiles +
                ' tiles and this sheet has ' + sheetTiles + ' — they are not a pair', 'warning');
            return false;
        }

        /* Colours, in order of how much they are actually evidence.
         *
         *   1. a .pal named for this screen
         *   2. the sheet's own table — for half these assets that IS the
         *      palette, built straight off the PNG by the build itself
         *      (`INCGFX_U16(".../aurora.png", ".gbapal")`)
         * and nothing else. The unnamed .pal files in the folder are still
         * listed on the descriptor, but they are not evidence and are never
         * chosen: ranking a neighbour above the PNG's own table is how `aurora`
         * opened wearing `aeroblast`'s colours, and picking a differently-named
         * one that happens to be big enough would be the same mistake with an
         * extra step. */
        var candidates = [];
        for (var n = 0; n < descriptor.named; n++) candidates.push(descriptor.palettes[n]);

        var palette = null, best = 0;
        for (var c = 0; c <= candidates.length && !palette; c++) {
            var got;
            if (c < candidates.length) {
                got = window.BattleScene.parseJascPal(
                    new TextDecoder().decode(await p.readBytes(candidates[c])));
            } else if (meta.palette) {
                // Already {r,g,b,a} entries — copied because it gets padded below.
                got = meta.palette.slice();
            }
            if (!got || !got.length) continue;
            /* Round up to a whole bank, as the build does. A palette only has
               to name the colours the art uses — `aurora.png` carries six — and
               gbagfx pads the rest of the bank with black on its way to a
               .gbapal. Without this the screen looks one colour short of a bank
               and gets turned away for a shortfall that does not exist. */
            while (got.length % 16) got.push({ r: 0, g: 0, b: 0 });
            if (got.length > best) best = got.length;
            // Each bank the map spans is 16 more colours the picture indexes
            // into. A palette that cannot cover them all is the wrong one.
            if (layout.banks * 16 <= got.length) palette = got;
        }

        if (!palette) {
            toast(best
                ? 'That screen spans ' + layout.banks + ' palette banks and nothing beside it holds more than ' +
                  best + ' colours'
                : 'No palette for that screen', 'warning');
            return false;
        }

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
            /* The whole file, not the part on screen. A battle background's map
               is 2048 entries: the first screenblock is the picture, the second
               is the intro slide. Saving only what was edited would have written
               1280 bytes over a 4096-byte file and deleted the slide. */
            mapAll: map,
            // Kept so a save can hand every tile back the id it already had.
            sheet: { indices: sheet, width: meta.width, height: meta.height },
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
            sheetWidthTiles: current.sheetWidthTiles,
            seed: current.sheet
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
        // The edited rows back into the file they came from, tail untouched.
        var whole = current.mapAll.slice();
        whole.set(r.map, 0);
        var mapBytes = window.Retile.tilemapBytes(whole);

        var p = project();
        if (!p || typeof p.writeBytes !== 'function') {
            toast('Saving a screen needs a hooked project', 'warning');
            return false;
        }

        /* Sheet first. If the tilemap write is the one that fails, the tiles on
           disk are a superset of what the old map points at, so the screen still
           builds and still renders — the other order leaves a map addressing
           tiles that are not there. */
        await p.writeBytes(current.descriptor.tilesPath, sheetPng);
        await p.writeBytes(current.descriptor.mapPath, mapBytes);
        app.markSaved(current.descriptor.tilesPath.replace(/^.*\//, ''));
        /* Growth is the thing worth knowing. Some assets are built with an
           asserted tile budget, so a save that adds tiles can break the build
           long after the artist has moved on. */
        toast('Wrote ' + r.tileCount + ' tiles' +
            (r.added ? ' (' + r.added + ' new)' : ' (unchanged)') +
            ' and a ' + whole.length + '-cell tilemap', 'success');
        return true;
    }

    window.TiledScreen = {
        match: match, open: open, isOpen: isOpen, save: save,
        current: function () { return current; },
        forget: function () { current = null; }
    };
})();
