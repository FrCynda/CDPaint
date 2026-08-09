/*
 * Sprite Preview panel for pokeemerald project images.
 * Renders the current sprite once per palette, side by side, at native 1:1
 * pixel size, with a draggable header and a close button. Auto-shows whenever
 * palettes exist and live-refreshes on canvas edits and palette changes.
 */
(function () {
    'use strict';

    function getApp() { return window.PaintApp; }

    var panel = null;
    var rowEl = null;

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
            return;
        }
        panel.classList.remove('sp-collapsed');
        rowEl.innerHTML = '';
        palettes.forEach(function (p) {
            var item = el('div', 'sp-item');
            item.appendChild(el('span', 'sp-name', p.name));
            var canvas = el('canvas', 'sp-canvas');
            item.appendChild(canvas);
            if (app && app.renderPalettePreviewInto) {
                try { app.renderPalettePreviewInto(canvas, p.id); } catch (err) { /* ignore */ }
            }
            rowEl.appendChild(item);
        });
    }

    function init() {
        build();
        var app = getApp();
        if (app) {
            var prev = app.onPalettesChanged;
            app.onPalettesChanged = function () { if (prev) prev(); render(); };
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
