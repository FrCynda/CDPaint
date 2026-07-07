// Wire brush-grid + relevant-vs-advanced settings + collapsible "Advanced" section
// into src/js/krita-brush-engine.js without breaking existing initUI/loadPreset/syncPanel.
const fs = require('fs');

const FILE = 'src/js/krita-brush-engine.js';
let s = fs.readFileSync(FILE, 'utf8');
let modified = false;

// === A) Replace the 'pb-preset' legacy wiring with grid + Advanced-toggle wiring.
// Match by line patterns instead of fragile string concatenation.
const lines0 = s.split(/\r?\n/);
for (let i = 0; i < lines0.length - 1; i++) {
  if (
    lines0[i].includes("document.getElementById('pb-preset')") &&
    lines0[i + 1].includes("sel.addEventListener('change'")
  ) {
    const replacement = [
      "        // Brush grid replaces the legacy preset dropdown.",
      "        engine.buildBrushGrid();",
      "        // Wire the Advanced toggle (state persists in localStorage).",
      "        var moreWrap2 = document.getElementById('pb-more-settings');",
      "        var moreBtn2 = document.getElementById('pb-more-toggle');",
      "        if (moreWrap2 && moreBtn2) {",
      "            var COLLAPSE_KEY2 = 'pb-more-collapsed';",
      "            var applyCollapse2 = function (collapsed) {",
      "                if (collapsed) moreWrap2.classList.add('pb-more-collapsed');",
      "                else moreWrap2.classList.remove('pb-more-collapsed');",
      "                moreBtn2.setAttribute('aria-expanded', collapsed ? 'false' : 'true');",
      "            };",
      "            try { var stored2 = localStorage.getItem(COLLAPSE_KEY2); applyCollapse2(stored2 === '1'); } catch (e2_) {}",
      "            moreBtn2.addEventListener('click', function () {",
      "                var collapsed2 = !moreWrap2.classList.contains('pb-more-collapsed');",
      "                applyCollapse2(collapsed2);",
      "                try { localStorage.setItem(COLLAPSE_KEY2, collapsed2 ? '1' : '0'); } catch (e3_) {}",
      "            });",
      "        }",
    ];
    lines0.splice(i, 2, ...replacement);
    s = lines0.join('\n');
    modified = true;
    console.log('[ok] replaced pb-preset wiring with brush-grid + Advanced-toggle wiring');
    break;
  }
}
if (!modified) console.warn('[warn] pb-preset legacy block not found (initUI form may differ)');

// === B) Append new engine methods (buildBrushGrid / generatePreview / updateVisibleSettings)
//       immediately before `app.brush = engine;`.
const newMethods = `
    /* ------------------------------------------------------------------ */
    /*  Brush grid + relevant-vs-advanced settings (paintbrush sidebar)   */
    /* ------------------------------------------------------------------ */

    // Per-preset list of "Relevant" data-setting keys (the rest go to Advanced).
    // size + opacity are always kept in the visible (Relevant) section.
    var PB_RELEVANT = {
        'Round':       { size:1, opacity:1, hardness:1, spacing:1 },
        'Calligraphy': { size:1, opacity:1, shape:1, angle:1, aspect:1, spacing:1 },
        'Airbrush':    { size:1, opacity:1, airbrushMode:1, flow:1, hardness:1 },
        'Ink':         { size:1, opacity:1, bristleCount:1, bristleLength:1, bristleWidth:1, flow:1 },
        'Marker':      { size:1, opacity:1, flow:1, hardness:1, spacing:1 },
        'Watercolor':  { size:1, opacity:1, colorRate:1, flow:1, hardness:1 },
        'Charcoal':    { size:1, opacity:1, shape:1, angle:1, bristleCount:1, bristleSpread:1 },
        'Splatter':    { size:1, opacity:1, shape:1, bristleCount:1, bristleSpread:1, spacing:1 },
        'Fan Brush':   { size:1, opacity:1, bristleCount:1, bristleWidth:1, bristleSpread:1, bristleLength:1 },
        'Dry Brush':   { size:1, opacity:1, bristleCount:1, bristleWidth:1, bristleSpread:1, bristleLength:1, flow:1 }
    };

    function _pbAllRows() {
        var sidebar = document.getElementById('paintbrush-sidebar');
        if (!sidebar) return [];
        var seen = {}, out = [], rows = sidebar.querySelectorAll('.pb-row[data-setting]');
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (seen[r.dataset.setting]) continue;
            seen[r.dataset.setting] = 1;
            out.push(r);
        }
        return out;
    }

    // Render a black diagonal-S curve stroke for the given preset on an isolated canvas.
    // Reads params from PRESETS only; does NOT mutate engine._params.
    function _pbRenderPreview(name, size) {
        var preset = engine.PRESETS[name];
        if (!preset) return null;
        size = size || 56;

        var canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, size, size);

        var p = preset;
        var brushSize = Math.max(2, Math.min(28, p.size || 8));
        var shape = p.shape || 'circle';
        var hardness = (p.hardness != null) ? p.hardness : 80;
        var angle = p.angle || 0;
        var aspect = p.aspect || 1;
        var opacity = ((p.opacity != null) ? p.opacity : 100) / 100;
        var spacing = (p.spacing != null) ? p.spacing : 20;
        var bristleCount = p.bristleCount || 1;
        var bristleSpread = p.bristleSpread || (brushSize * 1.4);

        // Diagonal S-curve from top-left to bottom-right.
        var steps = 16;
        var pts = new Array(steps);
        for (var i = 0; i < steps; i++) {
            var t = i / (steps - 1);
            pts[i] = {
                x: 4 + t * (size - 8),
                y: (size / 2) + Math.sin(t * Math.PI * 1.4) * (size * 0.28) - (size * 0.05)
            };
        }

        ctx.fillStyle = 'rgba(0,0,0,' + Math.max(0.35, opacity * 0.95) + ')';
        ctx.globalAlpha = 1;

        for (var s2 = 0; s2 < pts.length - 1; s2++) {
            var a = pts[s2], b = pts[s2 + 1];
            var segLen = Math.hypot(b.x - a.x, b.y - a.y);
            var stamps = Math.max(1, Math.floor(segLen / Math.max(0.5, brushSize * (spacing / 100))));
            for (var k = 0; k <= stamps; k++) {
                var u = k / stamps;
                var cx = a.x + (b.x - a.x) * u;
                var cy = a.y + (b.y - a.y) * u;
                var stampsToDraw = Math.max(1, bristleCount);
                for (var bi = 0; bi < stampsToDraw; bi++) {
                    var ox = 0, oy = 0;
                    if (stampsToDraw > 1) {
                        var ang = (bi / stampsToDraw) * Math.PI * 2;
                        ox = Math.cos(ang) * bristleSpread * 0.4;
                        oy = Math.sin(ang) * bristleSpread * 0.4;
                    }
                    var dab = _dabCache.get(shape, brushSize, hardness, angle + (bi * 11 % 30), aspect);
                    var rr = dab.width / 2;
                    try { ctx.drawImage(dab, cx + ox - rr, cy + oy - rr); } catch (e_) {}
                }
            }
        }
        return canvas;
    }

    engine.generatePreview = function (name) { return _pbRenderPreview(name, 56); };

    engine.buildBrushGrid = function () {
        var grid = document.getElementById('pb-brush-grid');
        var label = document.getElementById('pb-active-name');
        if (!grid) return;
        while (grid.firstChild) grid.removeChild(grid.firstChild);

        var names = engine.presetNames || Object.keys(engine.PRESETS);
        for (var i = 0; i < names.length; i++) {
            (function (name) {
                var tile = document.createElement('div');
                tile.className = 'pb-brush-tile';
                tile.title = name;
                tile.setAttribute('data-preset', name);
                var c = engine.generatePreview(name);
                if (c) tile.appendChild(c);
                tile.addEventListener('click', function () {
                    engine.loadPreset(name);
                    engine.syncPanel();
                    engine.updateVisibleSettings();
                    var tiles = document.querySelectorAll('.pb-brush-tile');
                    for (var t = 0; t < tiles.length; t++) {
                        tiles[t].classList.toggle('active', tiles[t].getAttribute('data-preset') === name);
                    }
                    if (label) label.textContent = name;
                    try { _updateBrushCursor && _updateBrushCursor(); } catch (e_) {}
                });
                grid.appendChild(tile);
            })(names[i]);
        }

        var active = engine._currentPreset || names[0];
        if (label) label.textContent = active;
        var tiles = grid.querySelectorAll('.pb-brush-tile');
        for (var t = 0; t < tiles.length; t++) {
            tiles[t].classList.toggle('active', tiles[t].getAttribute('data-preset') === active);
        }
        engine.updateVisibleSettings();
    };

    engine.updateVisibleSettings = function () {
        var keySettings = document.getElementById('pb-key-settings');
        var moreBody = document.getElementById('pb-more-body');
        if (!keySettings || !moreBody) return;
        var name = engine._currentPreset ||
            (engine.presetNames && engine.presetNames[0]) ||
            Object.keys(engine.PRESETS)[0];
        var rel = PB_RELEVANT[name] || { size:1, opacity:1 };
        rel.size = 1; rel.opacity = 1;
        var all = _pbAllRows();
        for (var i = 0; i < all.length; i++) {
            var row = all[i];
            var k = row.dataset.setting;
            var target = rel[k] ? keySettings : moreBody;
            if (row.parentNode !== target) target.appendChild(row);
        }
    };

`;

if (s.includes('app.brush = engine;')) {
  s = s.replace('app.brush = engine;', newMethods + '\n    app.brush = engine;\n');
  modified = true;
  console.log('[ok] appended buildBrushGrid / generatePreview / updateVisibleSettings');
} else {
  console.warn('[warn] app.brush = engine; not found');
}

if (modified) {
  fs.writeFileSync(FILE, s, 'utf8');
  console.log('[ok] wrote ' + FILE);
} else {
  console.log('[skip] no changes');
}
console.log('done');
