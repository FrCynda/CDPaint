/*
 * Sprite Preview panel for pokeemerald project images.
 *
 * The sprite at a true pixel scale, once per palette, side by side — so the thing
 * you are painting at 800% can be checked at the size it will actually be, and
 * against every palette it will actually be seen under, without leaving the canvas.
 *
 * "True" means integer: one artwork pixel is N screen pixels and never a fraction
 * of one. It follows the active frame of a multi-frame sheet, and the playing frame
 * while the frame strip is playing, and it repaints on every committed edit.
 */
(function () {
    'use strict';

    function getApp() { return window.PaintApp; }

    var panel = null;
    var rowEl = null;
    var zoomEl = null;
    var zoom = 1;
    var raf = null;
    var playingFrame = null;

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    }

    function makeDraggable(handle) {
        var dragging = false, ox = 0, oy = 0;
        handle.addEventListener('pointerdown', function (e) {
            if (e.target.closest('button')) return;
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

    function build() {
        panel = el('div');
        panel.id = 'sprite-preview';
        panel.className = 'sp-collapsed';
        var header = el('div', 'sp-header');
        header.appendChild(el('span', 'sp-title', 'Sprite Preview'));
        // 1× is the size it will be in the game. The rest are for eyes, not for
        // judgement — hence 1× being the default and the label saying so.
        zoomEl = el('select', 'sp-zoom');
        [1, 2, 3, 4].forEach(function (z) {
            var opt = document.createElement('option');
            opt.value = String(z);
            opt.textContent = z + '×' + (z === 1 ? ' (game size)' : '');
            zoomEl.appendChild(opt);
        });
        zoomEl.value = '1';
        zoomEl.title = 'Pixel scale — 1× is the size it will be in game';
        zoomEl.onchange = function () { zoom = parseInt(zoomEl.value, 10) || 1; render(); };
        header.appendChild(zoomEl);
        var closeBtn = el('button', 'sp-close', '×');
        closeBtn.type = 'button';
        closeBtn.title = 'Hide sprite preview';
        closeBtn.onclick = function () { panel.classList.add('sp-collapsed'); };
        header.appendChild(closeBtn);
        makeDraggable(header);
        panel.appendChild(header);

        rowEl = el('div', 'sp-row');
        panel.appendChild(rowEl);

        document.body.appendChild(panel);
    }

    function render() {
        if (!panel || !rowEl) return;
        var app = getApp();
        var palettes = (app && app.state && app.state.palettes) || [];
        if (!palettes.length) {
            panel.classList.add('sp-collapsed');
            rowEl.innerHTML = '';
            rowEl._ids = null;
            return;
        }
        panel.classList.remove('sp-collapsed');

        // A sheet previews the frame being worked on — or the one playing, so the
        // pane animates alongside the strip. A single-frame asset previews itself.
        var layout = app.projectFrameLayout ? app.projectFrameLayout() : null;
        var frame = null;
        if (layout) frame = playingFrame === null ? app.activeFrameIndex() : playingFrame;

        // Rebuild only when the set of palettes changed; this runs on every stroke,
        // and tearing down N canvases each time would be felt.
        var ids = palettes.map(function (p) { return p.id + ':' + p.name; }).join('|');
        if (rowEl._ids !== ids) {
            rowEl.innerHTML = '';
            rowEl._canvases = [];
            rowEl._ids = ids;
            palettes.forEach(function (p) {
                var item = el('div', 'sp-item');
                item.appendChild(el('span', 'sp-name', p.name));
                var canvas = el('canvas', 'sp-canvas');
                item.appendChild(canvas);
                rowEl.appendChild(item);
                rowEl._canvases.push(canvas);
            });
        }
        palettes.forEach(function (p, i) {
            var canvas = rowEl._canvases[i];
            if (!canvas || !app.renderPalettePreviewInto) return;
            try { app.renderPalettePreviewInto(canvas, p.id, { frame: frame, scale: zoom }); }
            catch (err) { /* canvas not readable yet */ }
        });
    }

    function requestRender() {
        if (raf) return;
        raf = requestAnimationFrame(function () { raf = null; render(); });
    }

    function init() {
        build();
        var app = getApp();
        if (app) {
            var prevPalettes = app.onPalettesChanged;
            app.onPalettesChanged = function () { if (prevPalettes) prevPalettes(); requestRender(); };
            // Fires on every committed edit for a project asset, which is what makes
            // this a live preview rather than a snapshot from whenever the palette
            // last changed.
            var prevFrames = app.onFramesChanged;
            app.onFramesChanged = function () { if (prevFrames) prevFrames(); requestRender(); };
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

    window.SpritePreview = {
        render: render,
        open: function () { if (panel) panel.classList.remove('sp-collapsed'); },
        close: function () { if (panel) panel.classList.add('sp-collapsed'); }
    };
})();
