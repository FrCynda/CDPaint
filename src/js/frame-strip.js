/*
 * Frame strip for multi-frame pokeemerald assets.
 *
 * A Gen 3 animation is one PNG with the frames laid out side by side — a 64x128
 * front sprite is two 64x64 pictures, a 144x32 walking sheet is nine 16x32 ones.
 * So this panel does not own any pixels: it is a reading of the canvas the engine
 * already has (PaintApp.projectFrameLayout), and every thumbnail is drawn straight
 * off the display surface. Edit a frame and its thumbnail follows; change the
 * palette and they all do.
 *
 * Appears only when the open asset actually has more than one frame, and hides
 * itself again the moment it does not.
 */
(function () {
    'use strict';

    function getApp() { return window.PaintApp; }

    var panel = null, controlsEl = null, readoutEl = null, thumbsEl = null;
    var countEl = null, playBtn = null, onionBtn = null, holdInput = null;
    var thumbs = [];
    var raf = null;
    var playingIndex = null;

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    }

    function makeDraggable(handle) {
        var dragging = false, ox = 0, oy = 0;
        handle.addEventListener('pointerdown', function (e) {
            if (e.target.closest('button') || e.target.closest('input')) return;
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

    function btn(label, title, onClick) {
        var b = el('button', 'fs-btn', label);
        b.type = 'button';
        b.title = title;
        b.onclick = onClick;
        return b;
    }

    function build() {
        panel = el('div');
        panel.id = 'frame-strip';
        panel.className = 'fs-collapsed';

        var header = el('div', 'fs-header');
        header.appendChild(el('span', 'fs-title', 'Frames'));
        var closeBtn = el('button', 'fs-close', '×');
        closeBtn.type = 'button';
        closeBtn.title = 'Hide the frame strip';
        closeBtn.onclick = function () { panel.classList.add('fs-collapsed'); };
        header.appendChild(closeBtn);
        makeDraggable(header);
        panel.appendChild(header);

        controlsEl = el('div', 'fs-controls');
        playBtn = btn('▶', 'Play at the game’s speed', function () {
            var app = getApp();
            if (app) app.toggleFramePlayback();
        });
        controlsEl.appendChild(playBtn);
        controlsEl.appendChild(btn('◀', 'Previous frame', function () {
            var app = getApp(); if (app) app.stepFrame(-1);
        }));
        controlsEl.appendChild(btn('▶|', 'Next frame', function () {
            var app = getApp(); if (app) app.stepFrame(1);
        }));

        onionBtn = btn('Onion', 'Ghost the neighbouring frames over this one', function () {
            var app = getApp(); if (app) app.toggleOnionSkin();
        });
        controlsEl.appendChild(onionBtn);

        var countWrap = el('span', 'fs-field');
        countWrap.appendChild(el('label', 'fs-label', 'frames'));
        countWrap.appendChild(btn('−', 'One frame fewer', function () { nudgeCount(-1); }));
        countEl = el('span', 'fs-count', '-');
        countWrap.appendChild(countEl);
        countWrap.appendChild(btn('+', 'One frame more', function () { nudgeCount(1); }));
        controlsEl.appendChild(countWrap);

        var holdWrap = el('span', 'fs-field');
        holdWrap.appendChild(el('label', 'fs-label', 'hold'));
        holdInput = el('input', 'fs-hold');
        holdInput.type = 'number';
        holdInput.min = '1';
        holdInput.max = '120';
        holdInput.title = 'How long each frame is held, in GBA frames (60ths of a second)';
        holdInput.onchange = function () {
            var app = getApp();
            if (app) app.setFrameHold(parseInt(holdInput.value, 10));
        };
        holdWrap.appendChild(holdInput);
        controlsEl.appendChild(holdWrap);
        panel.appendChild(controlsEl);

        readoutEl = el('div', 'fs-readout', '');
        panel.appendChild(readoutEl);

        thumbsEl = el('div', 'fs-thumbs');
        panel.appendChild(thumbsEl);

        document.body.appendChild(panel);
    }

    /* The frame count is a guess for overworld sheets — the real width lives in
       the project's C, which nothing reads yet. Nudging it re-cuts the same sheet;
       counts that do not divide it evenly are skipped rather than rejected, so the
       buttons always land somewhere valid. */
    function nudgeCount(dir) {
        var app = getApp();
        if (!app) return;
        var layout = app.projectFrameLayout();
        if (!layout) return;
        var along = layout.axis === 'x' ? app.config.width : app.config.height;
        for (var c = layout.count + dir; c >= 2 && c <= along; c += dir) {
            if (along % c) continue;
            app.setFrameCountOverride(c);
            return;
        }
    }

    /* Rebuild the thumbnail row. Only when the shape changed — repainting the
       existing canvases is cheap, tearing down and recreating N of them on every
       brush stroke is not. */
    function syncThumbs(layout) {
        if (thumbs.length !== layout.count || thumbs._w !== layout.w || thumbs._h !== layout.h) {
            thumbsEl.innerHTML = '';
            thumbs = [];
            thumbs._w = layout.w;
            thumbs._h = layout.h;
            for (var i = 0; i < layout.count; i++) {
                (function (index) {
                    var item = el('div', 'fs-thumb');
                    item.title = 'Frame ' + (index + 1);
                    var canvas = el('canvas');
                    item.appendChild(canvas);
                    item.appendChild(el('span', 'fs-thumb-n', String(index + 1)));
                    item.onclick = function () {
                        var app = getApp();
                        if (app) app.setActiveFrame(index);
                    };
                    thumbsEl.appendChild(item);
                    thumbs.push({ item: item, canvas: canvas });
                })(i);
            }
        }
        // Integer zoom only: a half-pixel thumbnail of pixel art is a lie about
        // what the artist drew.
        var zoom = Math.max(1, Math.min(4, Math.floor(56 / Math.max(layout.w, layout.h)) || 1));
        var app = getApp();
        var active = app.activeFrameIndex();
        var lit = playingIndex === null ? active : playingIndex;
        for (var i = 0; i < thumbs.length; i++) {
            app.renderProjectFrameInto(thumbs[i].canvas, i, zoom);
            thumbs[i].item.classList.toggle('fs-active', i === active);
            thumbs[i].item.classList.toggle('fs-playing', i === lit && playingIndex !== null);
        }
    }

    function render() {
        if (!panel) return;
        var app = getApp();
        var layout = app && app.projectFrameLayout ? app.projectFrameLayout() : null;
        if (!layout) {
            panel.classList.add('fs-collapsed');
            thumbs = [];
            if (thumbsEl) thumbsEl.innerHTML = '';
            return;
        }
        panel.classList.remove('fs-collapsed');

        var playing = app.isFramePlaying();
        playBtn.textContent = playing ? '■' : '▶';
        playBtn.title = playing ? 'Stop' : 'Play at the game’s speed';
        playBtn.classList.toggle('fs-on', playing);
        onionBtn.classList.toggle('fs-on', !!app.state.onionSkin);
        countEl.textContent = String(layout.count);
        if (document.activeElement !== holdInput) holdInput.value = String(layout.hold);
        readoutEl.textContent =
            layout.w + '×' + layout.h + ' · ' +
            (1000 / layout.ms).toFixed(1) + ' fps · ' +
            Math.round(layout.ms) + 'ms/frame';

        syncThumbs(layout);
    }

    function requestRender() {
        if (raf) return;
        raf = requestAnimationFrame(function () { raf = null; render(); });
    }

    function init() {
        build();
        var app = getApp();
        if (app) {
            // Chain, never replace: the sprite preview listens to the same three
            // hooks and loads before this file, so overwriting them would silently
            // stop it updating.
            var prevFrames = app.onFramesChanged;
            app.onFramesChanged = function () { if (prevFrames) prevFrames(); requestRender(); };
            var prevPlay = app.onFramePlayback;
            app.onFramePlayback = function (index) {
                if (prevPlay) prevPlay(index);
                playingIndex = index;
                requestRender();
            };
            var prevPalettes = app.onPalettesChanged;
            app.onPalettesChanged = function () { if (prevPalettes) prevPalettes(); requestRender(); };
        }
        render();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.FrameStrip = {
        render: render,
        open: function () { if (panel) panel.classList.remove('fs-collapsed'); },
        close: function () { if (panel) panel.classList.add('fs-collapsed'); }
    };
})();
