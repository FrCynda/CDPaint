/*
 * Floating palette panel for pokeemerald project images.
 * Shows every loaded palette (Embedded / Normal / Shiny / custom) with
 * draggable swatches, per-palette Edit + non-destructive Preview toggles,
 * and inline color add/edit. Palettes are previews of the artwork; the
 * canvas RGBA stays canonical and is only read on export.
 */
(function () {
    'use strict';

    function getApp() { return window.PaintApp; }

    var panel = null;
    var listEl = null;
    var dragFrom = null;
    var dragPaletteId = null;

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    }

    function build() {
        panel = el('div');
        panel.id = 'palette-panel';
        panel.className = 'project-collapsed';
        var header = el('div', 'pp-header');
        header.appendChild(el('span', 'pp-title', 'Palettes'));
        var closeBtn = el('button', 'pp-close', '×');
        closeBtn.type = 'button';
        closeBtn.title = 'Hide palette panel';
        closeBtn.onclick = function () { panel.classList.add('project-collapsed'); };
        header.appendChild(closeBtn);
        makeDraggable(header);
        panel.appendChild(header);

        var addBtn = el('button', 'pp-add-palette', '+ Palette');
        addBtn.type = 'button';
        addBtn.onclick = function () {
            var app = getApp();
            if (app && app.addPalette) app.addPalette();
        };
        panel.appendChild(addBtn);

        listEl = el('div', 'pp-list');
        panel.appendChild(listEl);

        document.body.appendChild(panel);
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

    function editColor(paletteId, index) {
        var app = getApp();
        if (!app || !app.getPaletteById) return;
        var input = el('input');
        input.type = 'color';
        input.className = 'pp-color-input';
        var cur = app.getPaletteById(paletteId).colors[index];
        if (cur) input.value = rgbToHexInput(cur);
        input.style.position = 'fixed';
        input.style.left = '-9999px';
        input.style.top = '-9999px';
        document.body.appendChild(input);
        var done = false;
        var cleanup = function () {
            if (done) return;
            done = true;
            if (input.parentNode) input.parentNode.removeChild(input);
        };
        input.onchange = function () {
            if (app.updatePaletteColor) {
                var c = hexToRgb(input.value);
                app.updatePaletteColor(paletteId, index, c);
            }
            cleanup();
        };
        input.onblur = cleanup;
        input.click();
    }

    function renderCard(palette) {
        var app = getApp();
        var card = el('div', 'pp-card');
        if (app.state.activePaletteId === palette.id) card.classList.add('pp-active');
        if (app.state.previewPaletteId === palette.id) card.classList.add('pp-previewing');

        var head = el('div', 'pp-card-head');
        head.appendChild(el('span', 'pp-name', palette.name));

        var editBtn = el('button', 'pp-btn', app.state.activePaletteId === palette.id ? 'Editing' : 'Edit');
        editBtn.type = 'button';
        editBtn.onclick = function () { if (app.setActivePalette) app.setActivePalette(palette.id); };
        head.appendChild(editBtn);

        var previewBtn = el('button', 'pp-btn', app.state.previewPaletteId === palette.id ? 'Exit' : 'Preview');
        previewBtn.type = 'button';
        previewBtn.onclick = function () {
            if (app.state.previewPaletteId === palette.id) { if (app.exitPreview) app.exitPreview(); }
            else { if (app.enterPreview) app.enterPreview(palette.id); }
        };
        head.appendChild(previewBtn);

        if (palette.source === 'custom') {
            var rmBtn = el('button', 'pp-btn pp-btn-danger', '×');
            rmBtn.type = 'button';
            rmBtn.title = 'Remove palette';
            rmBtn.onclick = function () { if (app.removePalette) app.removePalette(palette.id); };
            head.appendChild(rmBtn);
        }
        card.appendChild(head);

        var actions = el('div', 'pp-actions');
        var exportBtn = el('button', 'pp-btn', 'Export');
        exportBtn.type = 'button';
        exportBtn.title = 'Export this palette as a .pal file';
        exportBtn.onclick = function () { if (app.exportSinglePalette) app.exportSinglePalette(palette.id); };
        actions.appendChild(exportBtn);

        var remapBtn = el('button', 'pp-btn', 'Remap');
        remapBtn.type = 'button';
        remapBtn.title = 'Snap off-palette pixels on the canvas to the nearest color in this palette';
        remapBtn.onclick = function () { if (app.remapCanvasToPalette) app.remapCanvasToPalette(palette.id); };
        actions.appendChild(remapBtn);

        if (!/shiny/i.test(palette.name)) {
            var shinyBtn = el('button', 'pp-btn', 'Shiny');
            shinyBtn.type = 'button';
            shinyBtn.title = 'Generate a Shiny variant by hue-shifting this palette';
            shinyBtn.onclick = function () { if (app.generateShinyPalette) app.generateShinyPalette(palette.id); };
            actions.appendChild(shinyBtn);
        }
        card.appendChild(actions);

        var slotCount = Math.max(
            palette.colors.length,
            (app && app.state && app.state.projectBitDepth) ? Math.min(1 << app.state.projectBitDepth, 16) : 16
        );

        function makeDragStart(paletteId, index) {
            return function (e) {
                dragFrom = index;
                dragPaletteId = paletteId;
                try { e.dataTransfer.setData('text/plain', String(index)); } catch (err) { /* ignore */ }
            };
        }
        function makeDrop(paletteId, index) {
            return function (e) {
                e.preventDefault();
                if (dragFrom === null || dragPaletteId === null) { dragFrom = null; dragPaletteId = null; return; }
                if (dragPaletteId === paletteId) {
                    if (dragFrom !== index && app.reorderPaletteColor) app.reorderPaletteColor(paletteId, dragFrom, index);
                } else if (app.moveColorBetweenPalettes) {
                    app.moveColorBetweenPalettes(dragPaletteId, dragFrom, paletteId, index);
                }
                dragFrom = null; dragPaletteId = null;
            };
        }

        var swatchWrap = el('div', 'pp-swatches');
        for (var i = 0; i < slotCount; i++) {
            if (i < palette.colors.length) {
                var color = palette.colors[i];
                var sw = el('div', 'mini-swatch');
                var hex = rgbToHex(color.r, color.g, color.b);
                sw.style.backgroundColor = hex;
                sw.dataset.fixedPaletteColor = hex;
                sw.draggable = true;
                sw.title = hex + '  (drag to move, double-click to edit)';
                sw.addEventListener('dragstart', makeDragStart(palette.id, i));
                sw.addEventListener('dragover', function (e) { e.preventDefault(); });
                sw.addEventListener('drop', makeDrop(palette.id, i));
                (function (idx) {
                    sw.addEventListener('dblclick', function () { editColor(palette.id, idx); });
                })(i);
                swatchWrap.appendChild(sw);
            } else {
                var empty = el('div', 'mini-swatch empty');
                empty.title = 'Unused slot';
                swatchWrap.appendChild(empty);
            }
        }
        swatchWrap.addEventListener('dragover', function (e) { e.preventDefault(); });
        swatchWrap.addEventListener('drop', function (e) {
            e.preventDefault();
            if (dragFrom === null || dragPaletteId === null) { dragFrom = null; dragPaletteId = null; return; }
            if (dragPaletteId !== palette.id && app.moveColorBetweenPalettes) {
                app.moveColorBetweenPalettes(dragPaletteId, dragFrom, palette.id, palette.colors.length);
            }
            dragFrom = null; dragPaletteId = null;
        });
        card.appendChild(swatchWrap);

        return card;
    }

    function render() {
        if (!panel || !listEl) return;
        var app = getApp();
        var palettes = (app && app.state && app.state.palettes) || [];
        listEl.innerHTML = '';
        if (!palettes.length) {
            panel.classList.add('project-collapsed');
            return;
        }
        panel.classList.remove('project-collapsed');
        palettes.forEach(function (p) { listEl.appendChild(renderCard(p)); });
    }

    function rgbToHex(r, g, b) {
        var h = function (v) { return ('0' + v.toString(16)).slice(-2); };
        return '#' + h(r) + h(g) + h(b);
    }
    function rgbToHexInput(c) { return rgbToHex(c.r, c.g, c.b); }
    function hexToRgb(hex) {
        var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
        if (!m) return { r: 0, g: 0, b: 0 };
        return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
    }

    function init() {
        build();
        var app = getApp();
        if (app) app.onPalettesChanged = render;
        render();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.PalettePanel = { render: render, open: function () { if (panel) panel.classList.remove('project-collapsed'); } };
})();
