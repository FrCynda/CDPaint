/*
 * Battle-context preview, and the sprite coordinates that place it.
 *
 * Phase 3.3 and 3.4. A battle sprite is never seen the way it is painted: the
 * game drops it into a 240×160 screen at a fixed coordinate, then pushes it
 * down by the species' y_offset so that every Pokémon's feet land on the same
 * line whatever its height. Get that number wrong and the sprite floats or
 * sinks — the commonest "my custom sprite looks wrong in game" bug, and one
 * that no general paint program can even see, because the number is not in the
 * PNG. It is in the project's C, and it is computable from the artwork.
 *
 * So this shows the sprite where the game will actually put it, against the
 * line its feet are supposed to reach, and says whether the project agrees.
 *
 * Ground truth, read out of the decomp rather than out of a tutorial:
 *
 *   sBattlerCoords[SINGLES]      opponent (176, 40)   player (72, 80)
 *   sBattlerHealthboxCoords      opponent (44,  30)   player (158, 88)
 *   GetBattlerSpriteFinal_Y      y = coords.y + yOffset   (sprite y is centre)
 *   BATTLER_COORD_ATTR_*         the 64×64 box spans y-32 … y+31
 *
 * which puts the drawn artwork's bottom row at coords.y + 31 for every
 * species, exactly when y_offset matches the artwork. That line is the whole
 * check, and it is drawn.
 *
 * ponytail: the scene is schematic — bands and a ground line, not the real
 * backdrop tiles. Compositing a real battle_environment backdrop means
 * decoding its tileset and tilemap, which is a lot of code for a judgement the
 * ground line already supports. Upgrade path: render the backdrop into an
 * offscreen canvas and use it in place of the bands; nothing else moves.
 */
(function () {
    'use strict';

    var SCREEN_W = 240, SCREEN_H = 160, BOX = 64;

    /* From sBattlerCoords / sBattlerHealthboxCoords, BATTLE_COORDS_SINGLES. */
    var SIDES = {
        front: { label: 'Opponent', x: 176, y: 40, box: [44, 30], boxW: 64, boxH: 32 },
        back: { label: 'Player', x: 72, y: 80, box: [158, 88], boxW: 64, boxH: 40 }
    };

    function getApp() { return window.PaintApp; }
    function project() { return window.PokeProject; }

    var panel = null, sceneEl = null, readoutEl = null, sideEl = null, zoomEl = null, legendEl = null;
    var zoom = 2, raf = null, playingFrame = null, sideOverride = null;
    var frameCanvas = null;
    /* Closing has to mean closed. Every committed edit re-renders, so a plain
       class toggle would reopen the panel on the next stroke; this remembers
       which asset it was dismissed for, and the next one shows it again. */
    var hiddenFor = null;
    var zoomChosen = false;

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    }

    function makeDraggable(handle) {
        var dragging = false, ox = 0, oy = 0;
        handle.addEventListener('pointerdown', function (e) {
            if (e.target.closest('button, select')) return;
            dragging = true;
            var rect = panel.getBoundingClientRect();
            ox = e.clientX - rect.left;
            oy = e.clientY - rect.top;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            panel.style.transform = 'none';
            handle.setPointerCapture(e.pointerId);
        });
        handle.addEventListener('pointermove', function (e) {
            if (!dragging) return;
            panel.style.left = (e.clientX - ox) + 'px';
            panel.style.top = (e.clientY - oy) + 'px';
        });
        handle.addEventListener('pointerup', function (e) {
            dragging = false;
            try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        });
    }

    /* Which half of the battle this asset is. The path says so — `anim_front`,
       `front`, `back` — and the artist can override it, because a fork may name
       its files anything and being wrong here moves the ground line. */
    function sideFor(path) {
        if (sideOverride) return sideOverride;
        return /back/i.test(String(path || '').replace(/^.*[\\/]/, '')) ? 'back' : 'front';
    }

    function isBattleSprite(path) {
        var name = String(path || '').replace(/^.*[\\/]/, '').toLowerCase();
        return /^(anim_)?(front|back)(_gba)?\.png$/.test(name);
    }

    /* The artwork's own measurements, for the frame being worked on.
     *
     * The index map is the better source — it is what the file will contain —
     * but it goes out of step with the canvas whenever something changes the
     * document's size, and a preview that goes blank after a resize is worse
     * than one that is a frame behind. So: indices when they still describe
     * this canvas, the canvas's own alpha otherwise. Both answer the only
     * question the bounding box asks, which is whether a pixel is drawn. */
    function measure() {
        var app = getApp();
        if (!app || !app.state || !app.state.projectImage || !window.SpriteCoords) return null;
        var w = app.config.width, h = app.config.height;
        if (!w || !h) return null;
        var frame = playingFrame === null ? app.activeFrameIndex() : playingFrame;

        var idx = app.spriteIndices;
        var source = null, ti = 0;
        if (idx && idx.length === w * h) {
            /* -1 means the file carried no tRNS, not that nothing is
               transparent. Index 0 is the decomp's convention and gbagfx's
               default; treating -1 as "everything is drawn" would measure every
               such sprite as filling its frame. */
            source = idx;
            ti = app.state.projectTransparentIndex;
            if (ti < 0) ti = 0;
        } else {
            var data;
            try { data = app.ctx.getImageData(0, 0, w, h).data; }
            catch (e) { return null; }
            // 0 = not drawn, 1 = drawn; the bounding box needs nothing else.
            source = new Uint8Array(w * h);
            for (var q = 0; q < w * h; q++) source[q] = data[q * 4 + 3] ? 1 : 0;
            ti = 0;
        }
        return window.SpriteCoords.coordsFromBounds(
            window.SpriteCoords.boundsOf(source, w, h, ti, frame));
    }

    /* The declared record for this asset, if the project declares one. */
    function declaration() {
        var app = getApp(), p = project();
        if (!app || !p || !p.coordsFor) return null;
        var recs = p.coordsFor(app.state && app.state.projectFile);
        if (!recs || !recs.length) return null;
        var want = sideFor(app.state.projectFile);
        return recs.find(function (r) { return r.kind === want; }) || recs[0];
    }

    function drawScene(computed, declared) {
        var app = getApp();
        var ctx = sceneEl.getContext('2d');
        sceneEl.width = SCREEN_W * zoom;
        sceneEl.height = SCREEN_H * zoom;
        sceneEl.style.width = sceneEl.width + 'px';
        sceneEl.style.height = sceneEl.height + 'px';
        ctx.imageSmoothingEnabled = false;
        ctx.save();
        ctx.scale(zoom, zoom);

        var side = SIDES[sideFor(app.state.projectFile)];
        // The line the artwork's bottom row is supposed to land on.
        var footLine = side.y + 31;

        ctx.fillStyle = '#8ec7e8';
        ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
        ctx.fillStyle = '#c8b98a';
        ctx.fillRect(0, footLine, SCREEN_W, SCREEN_H - footLine);

        /* The sprite where the game puts it: box centred on (x, y + yOffset),
           drawn with the *declared* offset when there is one, because the point
           is to show what will happen, not what should. */
        var used = declared && typeof declared.yOffset === 'number'
            ? declared.yOffset : (computed ? computed.yOffset : 0);
        var boxX = side.x - BOX / 2;
        var boxY = side.y + used - BOX / 2;

        if (frameCanvas && frameCanvas.width) {
            ctx.drawImage(frameCanvas, boxX, boxY);
        }

        // The frame's own edge, so a sprite drawn outside it is obvious.
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 1;
        ctx.strokeRect(boxX + 0.5, boxY + 0.5, BOX - 1, BOX - 1);

        // The foot line. Solid where the artwork meets it, dashed where it does not.
        var lands = computed && used === computed.yOffset;
        ctx.strokeStyle = lands ? 'rgba(20,90,20,0.9)' : 'rgba(190,30,30,0.95)';
        ctx.setLineDash(lands ? [] : [3, 2]);
        ctx.beginPath();
        ctx.moveTo(0, footLine + 0.5);
        ctx.lineTo(SCREEN_W, footLine + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);

        // Where the artwork's bottom actually lands, when that is somewhere else.
        if (computed && !lands) {
            var actual = side.y + used + 31 - computed.yOffset;
            ctx.strokeStyle = 'rgba(190,30,30,0.6)';
            ctx.beginPath();
            ctx.moveTo(boxX, actual + 0.5);
            ctx.lineTo(boxX + BOX, actual + 0.5);
            ctx.stroke();
        }

        // The healthbox, so a tall sprite that runs into it can be seen doing so.
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        var hx = side.box[0] - side.boxW / 2, hy = side.box[1] - side.boxH / 2;
        ctx.fillRect(hx, hy, side.boxW, side.boxH);
        ctx.strokeRect(hx + 0.5, hy + 0.5, side.boxW - 1, side.boxH - 1);

        ctx.restore();
    }

    function fixButton(record, field, value, label) {
        var b = el('button', 'bp-fix', label);
        b.type = 'button';
        b.title = 'Write ' + value + ' into ' + record.file;
        b.onclick = function () {
            b.disabled = true;
            project().writeCoord(record, field, value).then(function () {
                showToast('Wrote ' + value + ' to ' + record.file.replace(/^.*\//, ''), 'success');
                render();
            }).catch(function (e) {
                b.disabled = false;
                showToast(e && e.message ? e.message : String(e), 'error');
            });
        };
        return b;
    }

    function drawReadout(computed, declared) {
        readoutEl.textContent = '';
        if (!computed) {
            readoutEl.appendChild(el('div', 'bp-note', 'Nothing drawn in this frame.'));
            return;
        }
        var line = el('div', 'bp-measured',
            'Artwork: ' + computed.width + '×' + computed.height +
            ' drawn, ' + computed.yOffset + 'px above the bottom edge');
        readoutEl.appendChild(line);

        if (!declared) {
            /* Say what was looked up and what was there to look in. "No
               coordinates for this asset" on its own is unactionable — it
               cannot distinguish an unhooked project from a species the fork
               never declares from a path that failed to resolve, and those
               want three different things done about them. */
            var p = project();
            var m = p && p.model && p.model();
            if (!m) {
                readoutEl.appendChild(el('div', 'bp-note',
                    'No decomp hooked, so nothing to compare against. The preview uses the measured coordinates.'));
            } else {
                var app = getApp();
                var looked = p.rel ? p.rel(app.state.projectFile) : app.state.projectFile;
                readoutEl.appendChild(el('div', 'bp-note',
                    'The project declares no coordinates for this asset. The preview uses the measured ones.'));
                readoutEl.appendChild(el('div', 'bp-where',
                    'looked up “' + looked + '” · the project declares ' +
                    (m.coords ? m.coords.length : 0) + ' coordinates'));
            }
            return;
        }

        var problems = window.SpriteCoords.compareCoords(computed, declared);
        if (!problems.length) {
            readoutEl.appendChild(el('div', 'bp-ok',
                declared.species + ' agrees: size ' + declared.size.w + '×' + declared.size.h +
                ', y_offset ' + declared.yOffset));
            return;
        }
        problems.forEach(function (pr) {
            var row = el('div', 'bp-problem bp-' + pr.severity);
            row.appendChild(el('span', 'bp-problem-text', pr.text));
            if (pr.severity === 'wrong' && project().writeCoord) {
                row.appendChild(pr.field === 'yOffset'
                    ? fixButton(declared, 'y', String(computed.yOffset), 'Set ' + computed.yOffset)
                    : fixButton(declared, 'size',
                        window.SpriteCoords.formatSize(computed.width, computed.height),
                        'Set ' + computed.width + '×' + computed.height));
            }
            readoutEl.appendChild(row);
        });
        readoutEl.appendChild(el('div', 'bp-where', declared.species + ' · ' + declared.file));
    }

    function render() {
        if (!panel) return;
        var app = getApp();
        var path = app && app.state && app.state.projectFile;
        if (!app || !app.state.projectImage || !isBattleSprite(path) || hiddenFor === path) {
            panel.classList.add('bp-collapsed');
            return;
        }
        panel.classList.remove('bp-collapsed');

        /* Pick a scale the window can actually show, until the artist picks one
           themselves. 2× of a 240×160 screen plus the header and the readout
           wants ~420px; on a shorter window that pushes the readout — the part
           with the answer in it — off the bottom of the panel. */
        if (!zoomChosen) {
            var fits = Math.max(1, Math.min(3, Math.floor((window.innerHeight - 260) / SCREEN_H)));
            if (zoom !== Math.min(2, fits)) {
                zoom = Math.min(2, fits);
                if (zoomEl) zoomEl.value = String(zoom);
            }
        }

        // The frame, through the active palette, at 1:1 — the scene is a GBA
        // screen and an artwork pixel is one screen pixel in it.
        if (!frameCanvas) frameCanvas = document.createElement('canvas');
        var frame = playingFrame === null ? app.activeFrameIndex() : playingFrame;
        try {
            app.renderPalettePreviewInto(frameCanvas, app.state.activePaletteId, { frame: frame, scale: 1 });
        } catch (e) { /* canvas not readable yet */ }

        var computed = measure();
        var declared = declaration();
        if (sideEl) sideEl.value = sideFor(path);
        drawScene(computed, declared);
        drawReadout(computed, declared);
    }

    function requestRender() {
        if (raf) return;
        raf = requestAnimationFrame(function () { raf = null; render(); });
    }

    function build() {
        panel = el('div');
        panel.id = 'battle-preview';
        panel.className = 'bp-collapsed';

        var header = el('div', 'bp-header');
        header.appendChild(el('span', 'bp-title', 'Battle Preview'));

        sideEl = el('select', 'bp-side');
        Object.keys(SIDES).forEach(function (k) {
            var opt = document.createElement('option');
            opt.value = k;
            opt.textContent = SIDES[k].label;
            sideEl.appendChild(opt);
        });
        sideEl.title = 'Which side of the battle this sprite is drawn on';
        sideEl.onchange = function () { sideOverride = sideEl.value; render(); };
        header.appendChild(sideEl);

        zoomEl = el('select', 'bp-zoom');
        [1, 2, 3].forEach(function (z) {
            var opt = document.createElement('option');
            opt.value = String(z);
            opt.textContent = z + '×';
            zoomEl.appendChild(opt);
        });
        zoomEl.value = '2';
        zoomEl.title = 'Scale of the 240×160 screen';
        zoomEl.onchange = function () {
            zoom = parseInt(zoomEl.value, 10) || 2;
            zoomChosen = true;   // stop fitting it for them once they have said
            render();
        };
        header.appendChild(zoomEl);

        var closeBtn = el('button', 'bp-close', '×');
        closeBtn.type = 'button';
        closeBtn.title = 'Hide battle preview';
        closeBtn.onclick = function () {
            var app = getApp();
            hiddenFor = (app && app.state && app.state.projectFile) || true;
            panel.classList.add('bp-collapsed');
        };
        header.appendChild(closeBtn);
        makeDraggable(header);
        panel.appendChild(header);

        sceneEl = el('canvas', 'bp-scene');
        panel.appendChild(sceneEl);

        /* Without this the scene is three coloured shapes. It was described back
           to me as "a blue section with a white square and a brown section",
           which is exactly what it is if you do not already know what it means. */
        legendEl = el('div', 'bp-legend');
        [['sky', 'battle screen, 240×160'],
         ['ground', 'where the feet should land'],
         ['health', 'health bar']].forEach(function (pair) {
            var item = el('span', 'bp-legend-item');
            item.appendChild(el('i', 'bp-swatch bp-swatch-' + pair[0]));
            item.appendChild(el('span', null, pair[1]));
            legendEl.appendChild(item);
        });
        panel.appendChild(legendEl);

        readoutEl = el('div', 'bp-readout');
        panel.appendChild(readoutEl);

        document.body.appendChild(panel);
    }

    function init() {
        build();
        var app = getApp();
        if (app) {
            var prevFrames = app.onFramesChanged;
            app.onFramesChanged = function () { if (prevFrames) prevFrames(); requestRender(); };
            var prevPalettes = app.onPalettesChanged;
            app.onPalettesChanged = function () {
                if (prevPalettes) prevPalettes();
                // A new asset is a new side and a new set of coordinates.
                sideOverride = null;
                requestRender();
            };
            var prevPlay = app.onFramePlayback;
            app.onFramePlayback = function (i) {
                if (prevPlay) prevPlay(i);
                playingFrame = i;
                requestRender();
            };
        }
        render();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.BattlePreview = {
        render: render,
        open: function () { hiddenFor = null; render(); },
        close: function () {
            var app = getApp();
            hiddenFor = (app && app.state && app.state.projectFile) || true;
            if (panel) panel.classList.add('bp-collapsed');
        }
    };
})();
