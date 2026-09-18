// Optional layer system — extracted verbatim from the foot of paint-engine.js.
// Loads immediately after paint-engine.js, which creates the global PaintApp.

// Wrapped in an IIFE: paint-engine.js declares the same wand consts at top level,
// and classic scripts share one global lexical scope.
(function () {
    // Wand helpers: paint-engine.js derives these at its own file scope, which this
    // file no longer shares. Same source, same values.
    const _wandMod = (typeof window !== 'undefined' && window.__wandAlgorithms) || {};
    const buildSortedDiffIndex = _wandMod.buildSortedDiffIndex;
    const buildPriorityFlood = _wandMod.buildPriorityFlood;

    // ══════════════════════════════════════════════════════════════════════════
    // OPTIONAL LAYER SYSTEM  —  completely hidden by default.
    // Nothing below runs until the user explicitly adds a second layer.
    // The core drawing loop, C2 logic, and single-canvas architecture are
    // 100 % unchanged when only one layer exists.
    // ══════════════════════════════════════════════════════════════════════════
    ;(function installLayerSystem(app) {
        'use strict';

        /* ──────────────────────────────────────────────────────────────────
         * 1.  INTERNAL STATE
         * ────────────────────────────────────────────────────────────────── */
        const mgr = {
            active:           false,   // stays false until user adds layer 2+
            layers:           [],      // [{id,name,canvas,ctx,visible,opacity,isBase}]
            activeIdx:        0,
            nextId:           2,
            _thumbRaf:        null,
            _compositeCanvas: null,
            _compositeCtx:    null,
        };
        app.layerMgr = mgr;

        // Public panel toggle — called from ribbon tool click.
        mgr.openPanel = function(v) { _openPanel(v); };

        // Preserve original context reference so the engine can still reassign ctx freely.
        const _holder = { ctx: app.ctx };
        const _tempHolder = { ctxTemp: app.ctxTemp };

        /* ──────────────────────────────────────────────────────────────────
         * 2.  ctx REDIRECT
         *     Converts app.ctx into a getter/setter.
         *     When single-layer mode (mgr.active===false), returns the original
         *     context — zero runtime overhead, zero behaviour change.
         * ────────────────────────────────────────────────────────────────── */
        try {
            Object.defineProperty(app, 'ctx', {
                get() {
                    // Every drawing path reaches the canvas through here, so it
                    // is the one place that can guarantee an outstanding undo
                    // record is written BEFORE anything changes the pixels it
                    // was meant to describe.
                    if (app._deferredSave) app.flushDeferredSave();
                    if (!mgr.active || !mgr.layers.length) return _holder.ctx;
                    const l = mgr.layers[mgr.activeIdx];
                    // Return a no-op proxy context for locked layers to prevent drawing
                    if (l && l.locked) return _lockedCtxProxy(l.ctx);
                    // Every drawing path in the app reaches the canvas through
                    // this accessor, so it is the one reliable place to notice
                    // "something is about to change" and schedule a repaint.
                    // Layers are off-screen now — without this, strokes would
                    // land correctly but never appear.
                    _invalidate();
                    // Editing a mask redirects every tool onto the mask canvas,
                    // so painting reveals and erasing hides, without ever
                    // touching the artwork underneath.
                    if (_isMaskEditing(l)) {
                        // Note it separately from the layer's own pixels, so a
                        // stroke on the artwork does not force history to clone
                        // a mask that has not changed.
                        l._maskDirty = true;
                        return l.mask.ctx;
                    }
                    return (l && l.ctx) || _holder.ctx;
                },
                set(v) { _holder.ctx = v; },
                configurable: true,
                enumerable:   true
            });
        } catch (e) {
            console.warn('[LayerSystem] ctx redirect unavailable:', e);
        }

        /* The temp canvas is composited into the stack now (see _render), not
         * stacked above it in the DOM, so the compositor has to know when
         * something draws on it. Over a hundred call sites reach it through
         * app.ctxTemp, so the accessor is the one place that catches them all —
         * exactly the trick the ctx redirect above uses. */
        try {
            Object.defineProperty(app, 'ctxTemp', {
                get() { _invalidate(); return _tempHolder.ctxTemp; },
                set(v) { _tempHolder.ctxTemp = v; },
                configurable: true,
                enumerable:   true
            });
        } catch (e) {
            console.warn('[LayerSystem] ctxTemp redirect unavailable:', e);
        }

        // Minimal proxy that swallows draw calls on locked layers
        const _noopHandler = {
            get(target, prop) {
                const val = target[prop];
                if (typeof val === 'function') {
                    // Pass through reads (getImageData, etc.) but silence writes
                    const writeMethods = new Set([
                        'fillRect','clearRect','strokeRect','fillText','strokeText',
                        'drawImage','putImageData','fill','stroke','beginPath',
                        'moveTo','lineTo','arc','arcTo','rect','save','restore',
                        'scale','rotate','translate','transform','setTransform',
                        'resetTransform','clip','drawFocusIfNeeded','scrollPathIntoView',
                        'createLinearGradient','createRadialGradient','createPattern',
                    ]);
                    if (writeMethods.has(prop)) return () => {};
                    return val.bind(target);
                }
                return val;
            },
            set(target, prop, value) { target[prop] = value; return true; }
        };
        function _lockedCtxProxy(ctx) {
            if (!ctx) return ctx;
            return new Proxy(ctx, _noopHandler);
        }

        /* ──────────────────────────────────────────────────────────────────
         * 3.  CSS  (injected once, uses existing CSS tokens)
         * ────────────────────────────────────────────────────────────────── */
        const _css = document.createElement('style');
        _css.textContent = `
/* ── LAYER SYSTEM ──────────────────────────────────────── */
#canvas-stage.layers-active {
    background: repeating-conic-gradient(#b0b0b0 0% 25%, #e8e8e8 0% 50%) 0 0 / 16px 16px;
    /* Layer canvases use mix-blend-mode, which blends with whatever is painted
       behind them. Isolate the stage so a Multiply layer blends with the layers
       below it and not with the app's UI. */
    isolation: isolate;
}
/* The compositor draws the temp canvas into the stack at the active layer's
   depth, so the DOM copy would be a second, wrongly-stacked draw on top.
   visibility rather than display keeps its layout box, which the pointer
   geometry still measures. */
#canvas-stage.layers-active #layer-temp { visibility: hidden; }
#lsys-panel{
    position:fixed;top:145px;bottom:24px;right:-336px;width:320px;
    background:var(--bg-ribbon,#f5f6f7);
    border-left:1px solid var(--border-ribbon,#dadbdc);
    z-index:9989;display:flex;flex-direction:column;
    transition:right .22s cubic-bezier(.4,0,.2,1);
    font-family:'Segoe UI',sans-serif;font-size:12px;overflow:hidden;
}
#lsys-panel.open{right:0;}
#lsys-phdr{
    height:30px;display:flex;align-items:center;padding:0 10px;
    border-bottom:1px solid var(--border-ribbon,#dadbdc);
    font-weight:600;font-size:12px;gap:6px;flex-shrink:0;
    background:var(--bg-ribbon,#f5f6f7);
}
#lsys-xbtn{
    margin-left:auto;cursor:pointer;opacity:.55;
    font-size:14px;padding:2px 5px;border-radius:2px;
}
#lsys-xbtn:hover{opacity:1;background:rgba(0,0,0,.07);}

#lsys-list{flex:1;overflow-y:auto;padding:3px 0;min-height:0;}

/* ── GIMP-style compact layer row ──────────────────────── */
/* Layout: [eye+lock column] [thumbnail] [name] */
.lsi{
    display:flex;align-items:center;
    height:50px;padding:0 6px 0 0;gap:0;
    cursor:pointer;
    border-top:1px solid transparent;
    border-bottom:1px solid var(--border-ribbon,#e0e0e0);
    position:relative;box-sizing:border-box;
    width:100%;overflow:visible;
}
.lsi:last-child{border-bottom-color:transparent;}
.lsi:hover{background:var(--btn-hover-bg,#eaf4ff);border-color:transparent;}
.lsi.lssel{
    background:#e8e8e8;
    border-top-color:transparent;
    border-bottom-color:var(--border-ribbon,#e0e0e0);
}
/* Alias for programmatic use */
.lsi.active-layer{
    background:#e8e8e8;
    border-top-color:transparent;
    border-bottom-color:var(--border-ribbon,#e0e0e0);
}
.lsi.lsi-dragging{opacity:.35;}
.lsi.lsi-dragover{box-shadow:inset 0 2px 0 #0078d7;}
.lsi.lsi-child{padding-left:24px;}

/* Left icon column: eye + lock side by side */
.lsi-icons{
    display:flex;flex-direction:row;align-items:center;justify-content:center;
    width:52px;flex-shrink:0;height:100%;gap:2px;padding-left:4px;
}
.lsi-vis{
    width:24px;height:24px;cursor:pointer;flex-shrink:0;
    display:flex;align-items:center;justify-content:center;
    color:#666;border-radius:3px;
}
.lsi-vis:hover{color:#111;background:rgba(0,0,0,.07);}
.lsi-vis.vis-off{color:#bbb;}
.lsi-lock{
    width:24px;height:24px;cursor:pointer;flex-shrink:0;
    display:flex;align-items:center;justify-content:center;
    color:#888;border-radius:3px;
}
.lsi-lock:hover{color:#111;background:rgba(0,0,0,.07);}
.lsi-lock.locked{color:#0078d7;}

/* Thumbnail */
.lsi-thumb-wrap{
    width:42px;height:40px;flex-shrink:0;margin:0 6px;
    border:1px solid rgba(0,0,0,.18);border-radius:1px;
    overflow:hidden;background:#c8c8c8;
    box-sizing:border-box;
    position:relative;
    flex-shrink:0;
}
.lsi.lssel .lsi-thumb-wrap,
.lsi.active-layer .lsi-thumb-wrap{
    border:1px solid #0078d7;
    border-radius:1px;
    box-shadow:0 0 0 1px #0078d7;
}
.lsi-thumb{
    display:block;image-rendering:pixelated;
    position:absolute;top:0;left:0;
    width:100%;height:100%;
}

/* Name column */
.lsi-name{
    flex:1;min-width:0;font-size:11px;font-weight:600;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    color:var(--app-text-color,#111);line-height:1.3;
    cursor:text;
}
.lsi-rename-input{
    flex:1;min-width:0;font-size:11px;font-weight:600;
    font-family:'Segoe UI',sans-serif;
    border:1px solid #0078d7;border-radius:2px;
    padding:0 3px;height:18px;
    outline:none;background:#fff;color:#111;
    box-sizing:border-box;
}
.lsi-alpha-badge{
    font-size:9px;background:rgba(0,0,0,.09);color:#666;
    padding:0 3px;border-radius:2px;letter-spacing:.3px;
    font-weight:600;margin-left:4px;vertical-align:middle;
}

/* Group items */
.lsi-group{
    display:flex;flex-direction:column;
    margin:2px 5px;border-radius:2px;
    border:1px solid var(--border-ribbon,#dadbdc);
    overflow:hidden;
}
.lsi-group-hdr{
    display:flex;align-items:center;gap:5px;padding:4px 7px;
    cursor:pointer;background:rgba(0,0,0,.04);
    border-bottom:1px solid transparent;
    font-size:11px;font-weight:600;
}
.lsi-group-hdr:hover{background:var(--btn-hover-bg,#eaf4ff);}
.lsi-group-hdr.sel{background:var(--btn-active-bg,#cce8ff);}
.lsi-group-children{padding:3px 0 3px 10px;}
.lsi-group-arrow{font-size:9px;transition:transform .15s;flex-shrink:0;opacity:.6;}
.lsi-group-arrow.open{transform:rotate(90deg);}

/* Clipping / mask indicators */
.lsi-clip-badge{
    font-size:10px;margin-left:4px;color:var(--win-blue,#0078d7);
    opacity:.85;font-weight:700;
}
.lsi-mask-badge{
    font-size:10px;margin-left:4px;color:var(--win-blue,#0078d7);opacity:.8;
}
.lsi-mask-badge.editing{
    background:var(--win-blue,#0078d7);color:#fff;opacity:1;
    padding:0 3px;border-radius:2px;
}
.lsi-mask-badge.off{opacity:.35;text-decoration:line-through;}
/* Toolbar buttons that represent an ON state */
.lstb.lstb-on{background:var(--btn-active-bg,#cce8ff);}

/* Opacity row */
#lsys-oprow{
    padding:5px 9px 6px;border-top:1px solid var(--border-ribbon,#dadbdc);
    display:flex;align-items:center;gap:6px;flex-shrink:0;font-size:11px;
    background:var(--bg-ribbon,#f5f6f7);
}
#lsys-oprow input[type=range]{flex:1;}
#lsys-opval{min-width:30px;text-align:right;font-size:11px;}

/* Bottom toolbar — clean ribbon-style button bar */
#lsys-toolbar{
    display:flex;align-items:center;gap:0;flex-shrink:0;
    border-top:1px solid var(--border-ribbon,#dadbdc);
    background:var(--bg-ribbon,#f5f6f7);
    padding:3px 4px;
}
.lstb{
    flex:1;height:26px;font-family:inherit;font-size:10px;cursor:pointer;
    border:1px solid transparent;border-radius:2px;
    background:transparent;
    display:flex;align-items:center;justify-content:center;
    transition:background .08s;padding:0 2px;
    color:var(--app-text-color,#111);
    gap:2px;
}
.lstb:hover{background:var(--btn-hover-bg,#eaf4ff);border-color:var(--btn-hover-border,#9fc4ea);}
.lstb:active{background:var(--btn-active-bg,#cce8ff);}
.lstb:disabled{opacity:.35;cursor:default;pointer-events:none;}
.lstb svg{flex-shrink:0;}
.lstb-sep{width:1px;height:18px;background:var(--border-ribbon,#dadbdc);margin:0 2px;flex-shrink:0;}

/* Context menu for layers */
#lsys-ctx{
    position:fixed;z-index:99999;
    background:var(--dropdown-bg,#fff);
    border:1px solid var(--dropdown-border,#a0a0a0);
    border-radius:3px;
    box-shadow:2px 3px 8px rgba(0,0,0,.18);
    padding:3px 0;min-width:180px;
    font-family:'Segoe UI',sans-serif;font-size:12px;
    display:none;
}
#lsys-ctx.open{display:block;}
.lsctx-item{
    padding:5px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;
    position:relative;
}
.lsctx-item:hover{background:var(--dropdown-item-hover-bg,#e8e8e8);}
.lsctx-item.checked::before{content:'✓';width:12px;flex-shrink:0;color:var(--win-blue,#0078d7);}
.lsctx-item:not(.checked)::before{content:'';width:12px;flex-shrink:0;}
.lsctx-item.lsctx-checked{background:rgba(0,120,215,.08);font-weight:600;}
.lsctx-item.lsctx-checked::before{content:'✓';width:12px;flex-shrink:0;color:var(--win-blue,#0078d7);}
.lsctx-arrow{margin-left:auto;font-size:10px;color:#888;}
.lsctx-has-sub{position:relative;}
.lsctx-sub{
    position:absolute;left:100%;top:-3px;
    background:var(--dropdown-bg,#fff);
    border:1px solid var(--dropdown-border,#a0a0a0);
    border-radius:3px;
    box-shadow:2px 3px 8px rgba(0,0,0,.18);
    padding:3px 0;min-width:160px;
    display:none;z-index:100000;
}
.lsctx-has-sub:hover .lsctx-sub{display:block;}
.lsctx-sep{height:1px;background:var(--dropdown-separator,#e0e0e0);margin:3px 0;}
/* ─────────────────────────────────────────────────────── */
`;
        document.head.appendChild(_css);

        /* ──────────────────────────────────────────────────────────────────
         * 4.  HTML  — slide-out panel
         * ────────────────────────────────────────────────────────────────── */
        const _panelEl = document.createElement('div');
        _panelEl.id = 'lsys-panel';
        _panelEl.setAttribute('aria-label', 'Layers panel');
        _panelEl.innerHTML =
            '<div id="lsys-phdr">' +
            '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
            '<rect x="1" y="3" width="14" height="3" rx="1" fill="'+getComputedStyle(document.body).getPropertyValue('--win-blue').trim()+'" opacity=".9"/>' +
            '<rect x="1" y="7" width="14" height="3" rx="1" fill="'+getComputedStyle(document.body).getPropertyValue('--win-blue').trim()+'" opacity=".55"/>' +
            '<rect x="1" y="11" width="14" height="3" rx="1" fill="'+getComputedStyle(document.body).getPropertyValue('--win-blue').trim()+'" opacity=".28"/>' +
            '</svg>Layers<span id="lsys-xbtn" title="Close">✕</span></div>' +
            '<div id="lsys-list">' +
            '<div style="padding:10px 12px;color:#888;font-size:11px;">' +
            'Click <b>+ Layer</b> to begin.<br><br>' +
            'The app works exactly as normal until you add a second layer.' +
            '</div></div>' +
            '<div id="lsys-oprow">' +
            '<label for="lsys-op" style="white-space:nowrap">Opacity</label>' +
            '<input type="range" id="lsys-op" min="0" max="100" value="100">' +
            '<span id="lsys-opval">100%</span></div>' +
            '<div id="lsys-toolbar">' +
            /* Add layer */
            '<button class="lstb" id="lsys-add" title="Add new transparent layer above active">' +
            '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="1" y="3" width="10" height="2" rx=".5" fill="currentColor" opacity=".6"/><rect x="1" y="7" width="10" height="2" rx=".5" fill="currentColor" opacity=".4"/><rect x="1" y="11" width="10" height="2" rx=".5" fill="currentColor" opacity=".25"/><line x1="12" y1="3" x2="12" y2="13" stroke="#0078d7" stroke-width="1.8" stroke-linecap="round"/><line x1="7" y1="8" x2="17" y2="8" stroke="#0078d7" stroke-width="1.8" stroke-linecap="round"/></svg>' +
            '</button>' +
            '<div class="lstb-sep"></div>' +
            /* Move up */
            '<button class="lstb" id="lsys-up" title="Move layer up" disabled>' +
            '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 12V4M4 7l4-4 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '</button>' +
            /* Move down */
            '<button class="lstb" id="lsys-down" title="Move layer down" disabled>' +
            '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 4v8M4 9l4 4 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '</button>' +
            '<div class="lstb-sep"></div>' +
            /* Merge down */
            '<button class="lstb" id="lsys-merge" title="Merge active layer down" disabled>' +
            '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="5" rx="1" fill="currentColor" opacity=".35"/><path d="M8 7v5M5 10l3 3 3-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '</button>' +
            /* Group */
            '<button class="lstb" id="lsys-group" title="Group selected layer" disabled>' +
            '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="1" y="4" width="14" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="3" y="2" width="5" height="3" rx="1" fill="currentColor" opacity=".6"/></svg>' +
            '</button>' +
            '<div class="lstb-sep"></div>' +
            /* Clip to layer below */
            '<button class="lstb" id="lsys-clip" title="Clip to layer below — confine this layer to the shape underneath" disabled>' +
            '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2" y="8" width="9" height="6" rx="1" fill="currentColor" opacity=".35"/><rect x="5" y="2" width="9" height="6" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M4 12l3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
            '</button>' +
            /* Add / edit layer mask */
            '<button class="lstb" id="lsys-mask" title="Add a layer mask — hide parts without erasing them" disabled>' +
            '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M8 3v10" stroke="currentColor" stroke-width="1.5"/><rect x="8" y="3" width="6" height="10" fill="currentColor" opacity=".35"/></svg>' +
            '</button>' +
            '<div class="lstb-sep"></div>' +
            /* Flatten */
            '<button class="lstb" id="lsys-flatten" title="Flatten image — merge every layer into one" disabled>' +
            '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="3" rx="1" fill="currentColor" opacity=".3"/><rect x="2" y="7" width="12" height="3" rx="1" fill="currentColor" opacity=".5"/><rect x="2" y="11" width="12" height="3" rx="1" fill="currentColor"/></svg>' +
            '</button>' +
            /* Export flattened PNG */
            '<button class="lstb" id="lsys-export" title="Export a flattened PNG (keeps your layered file)" disabled>' +
            '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M5 7l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 12v2h10v-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
            '</button>' +
            '<div class="lstb-sep"></div>' +
            /* Delete */
            '<button class="lstb" id="lsys-del" title="Delete active layer" disabled>' +
            '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 5h10M6 5V3h4v2M7 8v4M9 8v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M4 5l.7 8h6.6L12 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>' +
            '</button>' +
            '</div>';
        document.body.appendChild(_panelEl);

        /* Context menu */
        const _ctxMenu = document.createElement('div');
        _ctxMenu.id = 'lsys-ctx';
        _ctxMenu.innerHTML =
            // Layer type submenu
            '<div class="lsctx-item lsctx-has-sub" id="lsctx-type">' +
              '<span style="flex:1">Layer type</span>' +
              '<span class="lsctx-arrow">▶</span>' +
              '<div class="lsctx-sub" id="lsctx-type-sub">' +
                '<div class="lsctx-item lsctx-type-opt" data-type="normal">Normal (opaque)</div>' +
                '<div class="lsctx-item lsctx-type-opt" data-type="transparent">Transparent</div>' +
              '</div>' +
            '</div>' +
            '<div class="lsctx-sep"></div>' +
            '<div class="lsctx-item" id="lsctx-alphalock">Alpha lock</div>' +
            '<div class="lsctx-item" id="lsctx-alpha">Alpha channel</div>' +
            '<div class="lsctx-sep"></div>' +
            '<div class="lsctx-item" id="lsctx-lock">Lock layer</div>' +
            '<div class="lsctx-sep"></div>' +
            '<div class="lsctx-item" id="lsctx-clip">Clip to layer below</div>' +
            '<div class="lsctx-item" id="lsctx-passthrough">Pass through</div>' +
            '<div class="lsctx-sep"></div>' +
            '<div class="lsctx-item" id="lsctx-mask-add">Add layer mask</div>' +
            '<div class="lsctx-item" id="lsctx-mask-edit">Edit mask</div>' +
            '<div class="lsctx-item" id="lsctx-mask-toggle">Enable mask</div>' +
            '<div class="lsctx-item" id="lsctx-mask-apply">Apply mask</div>' +
            '<div class="lsctx-item" id="lsctx-mask-del">Delete mask</div>' +
            '<div class="lsctx-sep"></div>' +
            '<div class="lsctx-item" id="lsctx-dup">Duplicate</div>' +
            '<div class="lsctx-item" id="lsctx-del">Delete</div>';
        document.body.appendChild(_ctxMenu);
        let _ctxTargetIdx = -1;

        function _openCtx(e, idx) {
            e.preventDefault();
            _ctxTargetIdx = idx;
            const l = mgr.layers[idx];
            if (!l) { _closeCtx(); return; }
            const alphaItem     = document.getElementById('lsctx-alpha');
            const alphaLockItem = document.getElementById('lsctx-alphalock');
            const lockItem      = document.getElementById('lsctx-lock');
            // Determine current type
            const typeOpts = document.querySelectorAll('.lsctx-type-opt');
            const isTransparent = (l.alpha !== false);
            typeOpts.forEach(opt => {
                const t = opt.dataset.type;
                opt.className = 'lsctx-item lsctx-type-opt' + ((t === 'transparent' && isTransparent) || (t === 'normal' && !isTransparent) ? ' lsctx-checked' : '');
            });
            alphaItem.className     = 'lsctx-item' + (l.alpha !== false ? ' checked' : '');
            alphaLockItem.className = 'lsctx-item' + (l.alphaLock ? ' checked' : '');
            lockItem.className      = 'lsctx-item' + (l.locked ? ' checked' : '');

            // Clipping: only meaningful when there is a layer underneath to
            // clip to, and never for the bottom layer.
            const clipItem = document.getElementById('lsctx-clip');
            clipItem.className = 'lsctx-item' + (l.clipped ? ' checked' : '');
            clipItem.style.display = _canClip(idx) ? '' : 'none';

            // Pass-through belongs to folders only.
            const ptItem = document.getElementById('lsctx-passthrough');
            if (ptItem) {
                ptItem.className = 'lsctx-item' + (l.blendMode === 'pass-through' ? ' checked' : '');
                ptItem.style.display = l.isGroup ? '' : 'none';
            }

            // Mask items: show "Add" when there is none, the rest when there is.
            const hasMask = !!l.mask;
            const show = (id, on) => {
                const el = document.getElementById(id);
                if (el) el.style.display = on ? '' : 'none';
            };
            show('lsctx-mask-add', !hasMask && !l.isGroup);
            show('lsctx-mask-edit', hasMask);
            show('lsctx-mask-toggle', hasMask);
            show('lsctx-mask-apply', hasMask);
            show('lsctx-mask-del', hasMask);
            if (hasMask) {
                document.getElementById('lsctx-mask-edit').className =
                    'lsctx-item' + (_isMaskEditing(l) ? ' checked' : '');
                document.getElementById('lsctx-mask-toggle').className =
                    'lsctx-item' + (l.mask.enabled !== false ? ' checked' : '');
            }

            _ctxMenu.style.left = Math.min(e.clientX, window.innerWidth - 190) + 'px';
            _ctxMenu.style.top  = Math.min(e.clientY, window.innerHeight - 230) + 'px';
            _ctxMenu.classList.add('open');
        }
        function _closeCtx() { _ctxMenu.classList.remove('open'); }
        document.addEventListener('click', e => {
            if (!_ctxMenu.classList.contains('open')) return;
            if (_ctxMenu.contains(e.target)) return;
            // Native <select> dropdown clicks land outside the DOM — don't close for those
            if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
            _closeCtx();
        });
        /* ── Clipping + mask menu actions ─────────────────────────────────── */

        document.getElementById('lsctx-clip').addEventListener('click', () => {
            if (!_canClip(_ctxTargetIdx)) return;
            const l = mgr.layers[_ctxTargetIdx];
            l.clipped = !l.clipped;
            _closeCtx(); _refreshList(); _invalidate();
            app.saveState();
        });
        document.getElementById('lsctx-passthrough').addEventListener('click', () => {
            const l = mgr.layers[_ctxTargetIdx];
            if (!l || !l.isGroup) return;
            l.blendMode = (l.blendMode === 'pass-through') ? 'source-over' : 'pass-through';
            _closeCtx(); _refreshList(); _invalidate();
            app.saveState();
        });
        document.getElementById('lsctx-mask-add').addEventListener('click', () => {
            if (_ctxTargetIdx < 0) return;
            const l = mgr.layers[_ctxTargetIdx];
            _addMask(l);
            _setMaskEditing(l, true);       // painting goes to the mask right away
            _closeCtx(); _refreshList(); _invalidate();
            app.saveState();
        });
        document.getElementById('lsctx-mask-edit').addEventListener('click', () => {
            if (_ctxTargetIdx < 0) return;
            const l = mgr.layers[_ctxTargetIdx];
            _setMaskEditing(l, !_isMaskEditing(l));
            _closeCtx(); _refreshList();
        });
        document.getElementById('lsctx-mask-toggle').addEventListener('click', () => {
            if (_ctxTargetIdx < 0) return;
            const l = mgr.layers[_ctxTargetIdx];
            if (!l.mask) return;
            l.mask.enabled = l.mask.enabled === false;
            l._dirty = true;
            _closeCtx(); _refreshList(); _invalidate();
            app.saveState();
        });
        document.getElementById('lsctx-mask-apply').addEventListener('click', () => {
            if (_ctxTargetIdx < 0) return;
            const l = mgr.layers[_ctxTargetIdx];
            _setMaskEditing(l, false);
            _removeMask(l, true);           // bake what it hid into the pixels
            _closeCtx(); _refreshList(); _invalidate();
            app.saveState();
        });
        document.getElementById('lsctx-mask-del').addEventListener('click', () => {
            if (_ctxTargetIdx < 0) return;
            const l = mgr.layers[_ctxTargetIdx];
            _setMaskEditing(l, false);
            _removeMask(l, false);          // discard it, layer pixels untouched
            _closeCtx(); _refreshList(); _invalidate();
            app.saveState();
        });

        document.getElementById('lsctx-alphalock').addEventListener('click', () => {
            if (_ctxTargetIdx < 0) return;
            const l = mgr.layers[_ctxTargetIdx];
            l.alphaLock = !l.alphaLock;
            _closeCtx(); _refreshList();
        });
        document.querySelectorAll('.lsctx-type-opt').forEach(opt => {
            opt.addEventListener('click', () => {
                if (_ctxTargetIdx < 0) return;
                const l = mgr.layers[_ctxTargetIdx];
                const t = opt.dataset.type;
                if (t === 'normal') { l.alpha = false; l.alphaLock = false; }
                else { l.alpha = true; }
                _closeCtx(); _refreshList(); _syncBtns();
                app.saveState();
            });
        });
        document.getElementById('lsctx-alpha').addEventListener('click', () => {
            if (_ctxTargetIdx < 0) return;
            const l = mgr.layers[_ctxTargetIdx];
            const wasAlpha = (l.alpha !== false);
            l.alpha = wasAlpha ? false : true;
            // When removing the alpha channel, fill transparent pixels with C2
            // so nothing is silently lost.
            if (wasAlpha && !l.isBase) {
                const c2 = app.config.c2;
                const rgb = app.hexToRgb(c2);
                if (rgb) {
                    const w = l.canvas.width, h = l.canvas.height;
                    const img = l.ctx.getImageData(0, 0, w, h);
                    const d = img.data;
                    for (let i = 0; i < d.length; i += 4) {
                        if (d[i + 3] < 255) {
                            // Composite C2 under the existing pixel
                            const a = d[i + 3] / 255;
                            d[i]     = Math.round(d[i]     * a + rgb.r * (1 - a));
                            d[i + 1] = Math.round(d[i + 1] * a + rgb.g * (1 - a));
                            d[i + 2] = Math.round(d[i + 2] * a + rgb.b * (1 - a));
                            d[i + 3] = 255;
                        }
                    }
                    l.ctx.putImageData(img, 0, 0);
                }
            }
            _closeCtx(); _refreshList(); app.saveState();
        });
        document.getElementById('lsctx-lock').addEventListener('click', () => {
            if (_ctxTargetIdx < 0) return;
            const l = mgr.layers[_ctxTargetIdx];
            l.locked = !l.locked;
            _closeCtx(); _refreshList(); _syncBtns();
        });
        document.getElementById('lsctx-dup').addEventListener('click', () => {
            if (_ctxTargetIdx < 0) return;
            _setActive(_ctxTargetIdx); _dupLayer(); app.saveState(); _schedThumb();
            _closeCtx();
        });
        document.getElementById('lsctx-del').addEventListener('click', () => {
            if (_ctxTargetIdx < 0) return;
            _setActive(_ctxTargetIdx); _delLayer();
            _closeCtx();
        });

        /* ──────────────────────────────────────────────────────────────────
         * 5.  UTILITY HELPERS
         * ────────────────────────────────────────────────────────────────── */
        function _hexToRgb(hex) {
            const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
            return m
                ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
                : null;
        }

        /* Layer pixels live OFF-SCREEN. Nothing is stacked in the page any
         * more — cMain is the display canvas and shows the composited result.
         * That is what makes real groups, clipping masks and layer masks
         * possible, and it guarantees the screen matches the saved file. */
        function _newCanvas(w, h) {
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            return c;
        }

        /* Layer canvases used to be inserted into the stage. They are off-screen
         * now; kept as a no-op so older call sites stay harmless. */
        function _insertBeforeTemp() { /* layers are no longer in the DOM */ }

        /* ── Compositor ───────────────────────────────────────────────────── */

        const _scratchPool = [];
        function _getScratch(w, h) {
            const c = _scratchPool.pop() || document.createElement('canvas');
            if (c.width !== w) c.width = w;
            if (c.height !== h) c.height = h;
            const ctx = c.getContext('2d');
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
            ctx.clearRect(0, 0, w, h);
            app.disableSmoothing(ctx);
            return c;
        }
        function _releaseScratch(c) { if (_scratchPool.length < 12) _scratchPool.push(c); }

        function _blendOf(l) {
            const b = l.blendMode;
            // 'pass-through' is a folder flag, not a canvas operation. A folder
            // that lets the layers underneath show through is drawn by putting
            // its children straight onto the parent, so by the time anything
            // reaches this function it is plain Normal.
            if (!b || b === 'source-over' || b === 'pass-through') return 'source-over';
            return b;
        }

        /* A pass-through folder is not composited as a single object: its
         * children blend with everything already on the canvas, which is how
         * Photoshop groups behave by default. Isolation comes back the moment
         * the folder has to be treated as one object — its own mask, or a
         * partial opacity, both need the finished group before they apply. */
        function _isPassThrough(l) {
            return !!(l.isGroup && l.blendMode === 'pass-through' &&
                      (l.opacity == null || l.opacity >= 1) &&
                      !(l.mask && l.mask.enabled !== false && l.mask.canvas));
        }

        /* Flat array + parentId -> sibling lists, bottom-to-top. */
        function _buildTree() {
            const known = new Set(mgr.layers.map(l => l.id));
            const roots = [];
            const kids = new Map();
            for (const l of mgr.layers) {
                if (l.parentId && known.has(l.parentId)) {
                    if (!kids.has(l.parentId)) kids.set(l.parentId, []);
                    kids.get(l.parentId).push(l);
                } else {
                    roots.push(l);
                }
            }
            return { roots, kids };
        }

        /* The pixels a node contributes, with its own mask applied. Groups are
         * rendered into an isolated scratch so their opacity and blend mode
         * apply to the folder as a whole. Returns {canvas, temp} or null. */
        function _nodeContent(l, kids, w, h) {
            let base = null, temp = false;
            if (l.isGroup) {
                const children = kids.get(l.id) || [];
                if (!children.length) return null;
                const s = _getScratch(w, h);
                _renderList(children, kids, s.getContext('2d'), w, h);
                base = s; temp = true;
            } else {
                if (!l.canvas) return null;
                base = l.canvas;
            }
            const mask = l.mask;
            if (mask && mask.enabled !== false && mask.canvas) {
                const s = _getScratch(w, h);
                const sctx = s.getContext('2d');
                sctx.drawImage(base, 0, 0);
                // Mask alpha decides what survives: painted = visible.
                sctx.globalCompositeOperation = 'destination-in';
                sctx.drawImage(mask.canvas, 0, 0);
                sctx.globalCompositeOperation = 'source-over';
                if (temp) _releaseScratch(base);
                return { canvas: s, temp: true };
            }
            return { canvas: base, temp: temp };
        }

        /* Draw one list of siblings (bottom-to-top) into ctx. A run of clipped
         * layers is confined to the shape of the first unclipped layer beneath
         * it, exactly like a Photoshop/Krita clipping group. */
        /* The floating selection and the live tool previews live on the temp
         * canvas. They belong to the layer being edited, so layers above it
         * must cover them — the temp canvas used to sit above the whole stack
         * in the DOM, which drew a selection lifted off the Background over
         * every layer above it. Krita, CSP and Photoshop all place a floating
         * selection at its own layer's depth.
         *
         * _tempDrawn guards the fallback in _render: if the active layer never
         * came up during the walk (it is hidden, or inside a clipped run drawn
         * as part of its base), the temp canvas is still drawn on top at the
         * end rather than vanishing. */
        let _tempDrawn = false;
        function _drawTemp(ctx) {
            const t = app.ui && app.ui.cTemp;
            if (!t) return;
            _tempDrawn = true;
            ctx.save();
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
            ctx.drawImage(t, 0, 0);
            ctx.restore();
        }
        function _isActiveLayer(l) {
            const a = mgr.layers[mgr.activeIdx];
            return !!(a && l && a.id === l.id);
        }

        function _renderList(list, kids, ctx, w, h) {
            for (let i = 0; i < list.length; i++) {
                const l = list[i];
                // A clipped layer is drawn as part of the run above its base.
                // At the very bottom of a list there is nothing to clip to, so
                // draw it as an ordinary layer rather than dropping it — it used
                // to vanish with no explanation when it was first inside a group.
                if (l.clipped && i > 0) continue;
                if (!l.visible) {
                    // An invisible clip base still swallows its clipped run.
                    continue;
                }

                // A clipped run above needs this node's shape as one canvas, so
                // a folder that would otherwise pass through has to isolate.
                const hasRun = (i + 1 < list.length) && list[i + 1].clipped;
                if (!hasRun && _isPassThrough(l)) {
                    _renderList(kids.get(l.id) || [], kids, ctx, w, h);
                    continue;
                }

                const content = _nodeContent(l, kids, w, h);
                if (!content) continue;

                // Collect the clipped run sitting directly on top of this layer.
                const run = [];
                for (let j = i + 1; j < list.length; j++) {
                    if (!list[j].clipped) break;
                    if (list[j].visible) run.push(list[j]);
                }

                let src = content.canvas, srcTemp = content.temp;
                if (run.length) {
                    const s = _getScratch(w, h);
                    const sctx = s.getContext('2d');
                    sctx.drawImage(content.canvas, 0, 0);
                    for (const c of run) {
                        const cc = _nodeContent(c, kids, w, h);
                        if (!cc) continue;
                        sctx.save();
                        sctx.globalAlpha = c.opacity == null ? 1 : c.opacity;
                        sctx.globalCompositeOperation = _blendOf(c);
                        sctx.drawImage(cc.canvas, 0, 0);
                        sctx.restore();
                        if (cc.temp) _releaseScratch(cc.canvas);
                    }
                    // Confine the result to the base layer's own shape.
                    sctx.save();
                    sctx.globalCompositeOperation = 'destination-in';
                    sctx.drawImage(content.canvas, 0, 0);
                    sctx.restore();
                    if (content.temp) _releaseScratch(content.canvas);
                    src = s; srcTemp = true;
                }

                ctx.save();
                ctx.globalAlpha = l.opacity == null ? 1 : l.opacity;
                ctx.globalCompositeOperation = _blendOf(l);
                ctx.drawImage(src, 0, 0);
                ctx.restore();
                if (srcTemp) _releaseScratch(src);
                if (!_tempDrawn && _isActiveLayer(l)) _drawTemp(ctx);
            }
        }

        /* Composite the whole tree into the display canvas (cMain). */
        let _renderRaf = null, _renderDirty = false;
        function _render() {
            _renderDirty = false;
            if (!mgr.active || !mgr.layers.length) return;
            const w = app.config.width, h = app.config.height;
            const ctx = _holder.ctx;
            if (!ctx) return;
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
            ctx.clearRect(0, 0, w, h);
            app.disableSmoothing(ctx);
            const { roots, kids } = _buildTree();
            _tempDrawn = false;
            _renderList(roots, kids, ctx, w, h);
            if (!_tempDrawn) _drawTemp(ctx);
            ctx.restore();
        }
        mgr.render = _render;

        /* Coalesce repaints to one per animation frame. */
        function _invalidate() {
            if (!mgr.active) return;
            _renderDirty = true;
            if (_renderRaf == null) {
                _renderRaf = requestAnimationFrame(() => {
                    _renderRaf = null;
                    if (_renderDirty) _render();
                });
            }
        }
        mgr.invalidate = _invalidate;

        /* The live view is a stack of DOM canvases, so visibility / opacity /
         * blend mode are CSS on each canvas — nothing composites them in JS
         * while you draw. This is the single place that pushes a layer's
         * appearance onto its canvas; call it whenever any of those change.
         *
         * Canvas and CSS spell the default blend differently ('source-over' vs
         * 'normal'); every other mode shares the same name. */
        /* Appearance used to be CSS on stacked canvases. The compositor owns it
         * now, so "apply style" just means "repaint". Kept as a named call so
         * every place that changes how a layer looks stays obvious. */
        function _applyLayerStyle() { _invalidate(); }
        function _applyAllLayerStyles() { _invalidate(); }

        /* ── Layer masks ──────────────────────────────────────────────────────
         * A mask is a same-size canvas whose ALPHA decides what shows: painted
         * = visible, erased = hidden. Nothing is destroyed, so hiding can be
         * painted back at any time. */
        function _makeMask(w, h, opaque) {
            const c = _newCanvas(w, h);
            const ctx = c.getContext('2d', { willReadFrequently: true });
            app.disableSmoothing(ctx);
            if (opaque) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
            return { canvas: c, ctx, enabled: true };
        }
        function _addMask(l, opts) {
            if (!l || l.mask) return;
            // Start fully revealed — the mask should change nothing until painted.
            l.mask = _makeMask(app.config.width, app.config.height, !(opts && opts.hidden));
            l._dirty = true;
            l._maskDirty = true;
        }
        function _removeMask(l, apply) {
            if (!l || !l.mask) return;
            if (apply && l.canvas && l.ctx) {
                // Bake it in: what the mask hid becomes actually erased.
                l.ctx.save();
                l.ctx.globalCompositeOperation = 'destination-in';
                l.ctx.drawImage(l.mask.canvas, 0, 0);
                l.ctx.restore();
            }
            l.mask = null;
            l._dirty = true;
            l._maskDirty = true;
        }
        /* While a mask is being edited, drawing tools paint the MASK rather than
         * the layer's pixels — paint to reveal, erase to hide. Only one mask can
         * be in edit mode at a time, so the target of a brush stroke is never
         * ambiguous. */
        function _isMaskEditing(l) { return !!(l && l.mask && l._maskEdit); }
        /* Where a drawing operation on this layer should actually land. */
        function _targetCtx(l) { return _isMaskEditing(l) ? l.mask.ctx : (l && l.ctx); }
        function _setMaskEditing(l, on) {
            for (const other of mgr.layers) if (other !== l) other._maskEdit = false;
            if (!l) return;
            l._maskEdit = !!(on && l.mask);
        }
        mgr.isMaskEditing = () => {
            const l = mgr.layers[mgr.activeIdx];
            return _isMaskEditing(l);
        };

        function _snapshotMask(l) {
            if (!l.mask || !l.mask.canvas) return null;
            const c = _newCanvas(l.mask.canvas.width, l.mask.canvas.height);
            c.getContext('2d').drawImage(l.mask.canvas, 0, 0);
            return { canvas: c, enabled: l.mask.enabled !== false };
        }
        function _restoreMask(l, sv, w, h) {
            if (!sv.mask || !sv.mask.canvas) { l.mask = null; return; }
            if (!l.mask) l.mask = _makeMask(w, h, false);
            if (l.mask.canvas.width !== w || l.mask.canvas.height !== h) {
                l.mask.canvas.width = w; l.mask.canvas.height = h;
            }
            l.mask.ctx.clearRect(0, 0, w, h);
            l.mask.ctx.drawImage(sv.mask.canvas, 0, 0);
            l.mask.enabled = sv.mask.enabled !== false;
        }

        /* Flatten all visible layers into a single canvas.  Used for save/preview. */
        function _composite() {
            if (!mgr.active || mgr.layers.length <= 1) return null;
            const w = app.config.width, h = app.config.height;
            if (!mgr._compositeCanvas ||
                mgr._compositeCanvas.width  !== w ||
                mgr._compositeCanvas.height !== h) {
                mgr._compositeCanvas = document.createElement('canvas');
                mgr._compositeCanvas.width  = w;
                mgr._compositeCanvas.height = h;
                mgr._compositeCtx = mgr._compositeCanvas.getContext('2d');
                app.disableSmoothing(mgr._compositeCtx);
            }
            const ctx = mgr._compositeCtx;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
            ctx.clearRect(0, 0, w, h);
            // Same path the screen uses, so an exported/flattened image and the
            // canvas you were looking at can never disagree.
            const { roots, kids } = _buildTree();
            _renderList(roots, kids, ctx, w, h);
            return mgr._compositeCanvas;
        }
        mgr.getCompositeCanvas = function() { return _composite(); };

        /* Strip C2 (background colour) pixels from a canvas — makes them transparent.
         * Used when stamping a floating selection onto a transparent layer so we don't
         * paint solid background squares onto layers that support true alpha. */
        function _stripC2(srcCanvas, c2hex) {
            const c2 = _hexToRgb(c2hex);
            if (!c2) return srcCanvas;
            const w = srcCanvas.width, h = srcCanvas.height;
            const out = document.createElement('canvas');
            out.width = w; out.height = h;
            const ctx = out.getContext('2d');
            ctx.drawImage(srcCanvas, 0, 0);
            const img = ctx.getImageData(0, 0, w, h);
            const d = img.data;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i] === c2.r && d[i+1] === c2.g && d[i+2] === c2.b) d[i+3] = 0;
            }
            ctx.putImageData(img, 0, 0);
            return out;
        }

        /* ──────────────────────────────────────────────────────────────────
         * 6.  LAYER OPERATIONS
         * ────────────────────────────────────────────────────────────────── */

        /* First-time activation: wraps cMain as "Background" layer.
         * Called lazily the first time the user adds a layer. */
        function _activate() {
            if (mgr.active) return;
            app.markAllDirty();
            mgr.active = true;
            mgr.activeIdx = 0;
            if (!mgr.layers.length) {
                // Move the picture that was being drawn straight onto cMain into
                // an off-screen Background layer. From here on cMain is the
                // display surface and shows the composite, not the artwork.
                const w = app.config.width, h = app.config.height;
                const c = _newCanvas(w, h);
                const cctx = c.getContext('2d', { willReadFrequently: true });
                app.disableSmoothing(cctx);
                cctx.drawImage(app.ui.cMain, 0, 0);
                mgr.layers.push({
                    id:       1,
                    name:     'Background',
                    canvas:   c,
                    ctx:      cctx,
                    visible:  true,
                    opacity:  1.0,
                    isBase:   true,
                    locked:   false,
                    alpha:    false,
                    alphaLock: false,
                    blendMode: 'source-over',
                    clipped:  false,
                    mask:     null,
                    parentId: null,
                    _dirty:   false,
                });
                if (mgr.nextId < 2) mgr.nextId = 2;
            }
            _invalidate();
            // Switch stage to checkered pattern so transparent areas are visible.
            // (cTemp no longer needs a z-index bump — there are no layer
            // canvases in the DOM to sit above.)
            if (app.ui.stage) app.ui.stage.classList.add('layers-active');
            _refreshList();
            _syncBtns();
        }

        function _addLayer() {
            if (!mgr.active) _activate();
            const w = app.config.width, h = app.config.height;
            const id = mgr.nextId++;
            const c = _newCanvas(w, h);
            const ctx = c.getContext('2d', { willReadFrequently: true });
            app.disableSmoothing(ctx);
            // Canvas is transparent by default — no fill needed (rgba 0,0,0,0)
            mgr.layers.push({
                id, name: 'Layer ' + id, canvas: c, ctx,
                visible: true, opacity: 1.0, isBase: false,
                locked: false, alpha: true,
                blendMode: 'source-over', alphaLock: false, _dirty: false,
                parentId: null,
            });
            _setActive(mgr.layers.length - 1);
            _refreshList();
            _invalidate();
        }

        /* Copy one layer's own pixels and settings. Children are NOT handled
         * here — the caller walks the subtree and re-points parentId. */
        function _cloneLayer(src, rename) {
            const w = app.config.width, h = app.config.height;
            const isGroup = !!src.isGroup;
            let c, ctx = null;
            if (isGroup) {
                c = document.createElement('canvas');   // placeholder, never drawn
            } else {
                c = _newCanvas(w, h);
                ctx = c.getContext('2d', { willReadFrequently: true });
                app.disableSmoothing(ctx);
                if (src.canvas) ctx.drawImage(src.canvas, 0, 0);
            }
            const copy = {
                id: mgr.nextId++, name: rename ? src.name + ' copy' : src.name,
                canvas: c, ctx,
                visible: src.visible !== false, opacity: src.opacity,
                isBase: false, locked: false, alpha: src.alpha !== false,
                blendMode: src.blendMode, alphaLock: src.alphaLock,
                isGroup, _open: src._open !== false,
                // A copy that quietly dropped the mask or the clipping was not
                // a copy — both used to be left behind here.
                clipped: !!src.clipped, mask: null,
                _dirty: true, parentId: src.parentId,
            };
            if (src.mask && src.mask.canvas) {
                copy.mask = _makeMask(w, h, false);
                copy.mask.ctx.drawImage(src.mask.canvas, 0, 0);
                copy.mask.enabled = src.mask.enabled !== false;
            }
            return copy;
        }

        function _dupLayer() {
            if (!mgr.active || !mgr.layers.length) return;
            const src = mgr.layers[mgr.activeIdx];

            if (src.isGroup) {
                // Duplicating a folder used to hand back an empty folder: only
                // the placeholder canvas was copied, never the contents.
                const ids   = _subtreeIds(src.id);
                const block = mgr.layers.filter(l => ids.has(l.id));
                const idMap = new Map();
                const copies = block.map(l => {
                    const cp = _cloneLayer(l, l === src);
                    idMap.set(l.id, cp.id);
                    return cp;
                });
                // Re-point each copied child at its copied parent, so the new
                // folder holds the new layers and the original keeps its own.
                for (const cp of copies) {
                    if (cp.parentId != null && idMap.has(cp.parentId)) {
                        cp.parentId = idMap.get(cp.parentId);
                    }
                }
                const groupCopy = copies[block.indexOf(src)];
                const insertAt  = mgr.layers.indexOf(block[block.length - 1]) + 1;
                mgr.layers.splice(insertAt, 0, ...copies);
                _applyLayerStyle(groupCopy);
                _setActive(insertAt + copies.indexOf(groupCopy));
                _refreshList();
                return;
            }

            const copy = _cloneLayer(src, true);
            mgr.layers.splice(mgr.activeIdx + 1, 0, copy);
            _applyLayerStyle(copy);   // carry the copied opacity/blend to screen
            _setActive(mgr.activeIdx + 1);
            _refreshList();
        }

        function _delLayer() {
            if (!mgr.active || mgr.layers.length <= 1) return;
            const l = mgr.layers[mgr.activeIdx];
            if (l.isGroup) {
                // A folder owns what is inside it. Deleting one used to leave
                // its contents behind, scattered out to the top level.
                const ids = _subtreeIds(l.id);
                if (ids.size >= mgr.layers.length) return;   // would empty the document
                for (let i = mgr.layers.length - 1; i >= 0; i--) {
                    if (ids.has(mgr.layers[i].id)) mgr.layers.splice(i, 1);
                }
            } else {
                // Every layer is an off-screen canvas now, so the bottom one is
                // not special: dropping the reference is the whole job.
                mgr.layers.splice(mgr.activeIdx, 1);
            }
            if (mgr.layers.length && !mgr.layers.some(x => x.isBase)) mgr.layers[0].isBase = true;
            _setActive(Math.min(mgr.activeIdx, mgr.layers.length - 1));
            _refreshList();
            _invalidate();
            app.saveState();
        }

        function _mergeDown() {
            if (!mgr.active || mgr.activeIdx <= 0) return;
            const above = mgr.layers[mgr.activeIdx];
            const below = mgr.layers[mgr.activeIdx - 1];
            // Groups are placeholders with no drawing context.
            if (above.isGroup || below.isGroup || !below.ctx) return;
            below.ctx.save();
            below.ctx.globalAlpha = above.opacity;
            // Merging must reproduce what the layer looked like — flattening a
            // Multiply layer as Normal changed the picture.
            below.ctx.globalCompositeOperation = above.blendMode || 'source-over';
            below.ctx.drawImage(above.canvas, 0, 0);
            below.ctx.restore();
            below._dirty = true;
            mgr.layers.splice(mgr.activeIdx, 1);
            _setActive(mgr.activeIdx - 1);
            _refreshList();
            _invalidate();
            app.saveState();
        }

        function _setActive(idx) {
            mgr.activeIdx = Math.max(0, Math.min(idx, mgr.layers.length - 1));
            _syncOpacity();
            _syncBtns();
            // Update selection highlight in-place without rebuilding the DOM
            const list = document.getElementById('lsys-list');
            if (list) {
                list.querySelectorAll('.lsi').forEach(el => {
                    const elIdx = parseInt(el.dataset.li, 10);
                    const isSel = elIdx === mgr.activeIdx;
                    el.classList.toggle('lssel', isSel);
                    el.classList.toggle('active-layer', isSel);
                });
            }
        }

        /* Collapse the whole stack into a single Background layer holding the
         * composited picture. Unlike merging pairwise, this is exactly what you
         * see, including groups, clipping and masks. */
        function _flattenImage() {
            if (!mgr.active || mgr.layers.length < 1) return;
            const w = app.config.width, h = app.config.height;
            const flat = _composite();
            const c = _newCanvas(w, h);
            const cctx = c.getContext('2d', { willReadFrequently: true });
            app.disableSmoothing(cctx);
            if (flat) cctx.drawImage(flat, 0, 0);
            mgr.layers.length = 0;
            mgr.layers.push({
                id: 1, name: 'Background', canvas: c, ctx: cctx,
                visible: true, opacity: 1.0, isBase: true, locked: false,
                alpha: false, alphaLock: false, blendMode: 'source-over',
                clipped: false, mask: null, parentId: null, _dirty: true,
            });
            mgr.nextId = 2;
            mgr.activeIdx = 0;
            _refreshList(); _syncBtns(); _syncOpacity(); _invalidate();
            app.saveState();
        }
        mgr.flatten = _flattenImage;

        /* The composited picture as a plain canvas — what a PNG export should
         * contain when the document has layers. */
        mgr.getFlattenedCanvas = function () {
            if (!mgr.active || !mgr.layers.length) return app.ui.cMain;
            return _composite() || app.ui.cMain;
        };

        function _moveLayerUp() {
            // "Up" in the visual list = higher index in the array (drawn later = on top)
            if (!mgr.active || mgr.activeIdx >= mgr.layers.length - 1) return;
            const i = mgr.activeIdx;
            [mgr.layers[i], mgr.layers[i + 1]] = [mgr.layers[i + 1], mgr.layers[i]];
            _rebuildZOrder();
            _setActive(i + 1);
            _refreshList();
            app.saveState();
        }

        function _moveLayerDown() {
            if (!mgr.active || mgr.activeIdx <= 0) return;
            const i = mgr.activeIdx;
            [mgr.layers[i], mgr.layers[i - 1]] = [mgr.layers[i - 1], mgr.layers[i]];
            _rebuildZOrder();
            _setActive(i - 1);
            _refreshList();
            app.saveState();
        }

        function _makeGroup() {
            if (!mgr.active || !mgr.layers.length) return;
            const idx = mgr.activeIdx;
            const id  = mgr.nextId++;
            const grpLayer = {
                id, name: 'Group ' + id,
                isGroup: true, _open: true,
                visible: true, opacity: 1.0,
                locked: false, alpha: false,
                canvas: document.createElement('canvas'), // placeholder
                ctx: null,
                // Pass-through is what a folder does in Photoshop by default:
                // the layers inside still blend with everything below it.
                blendMode: 'pass-through', alphaLock: false, _dirty: false,
                clipped: false, mask: null,
                parentId: null,
            };
            mgr.layers.splice(idx, 0, grpLayer);
            // Put the layer you had selected inside the new folder. Handing back
            // an empty folder to drag things into is not what "group" means.
            const inner = mgr.layers[idx + 1];
            if (inner && !inner.isBase) inner.parentId = id;
            _setActive(idx + 1);
            _refreshList();
            _invalidate();
            app.saveState();
        }

        function _toggleVis(idx) {
            if (idx < 0 || idx >= mgr.layers.length) return;
            const l = mgr.layers[idx];
            l.visible = !l.visible;
            // Hiding a group used to overwrite every child's own visibility, so
            // re-showing the folder revealed layers you had hidden individually.
            // The compositor skips a hidden group wholesale, so the children
            // keep their own state and come back exactly as you left them.
            _invalidate();
            _refreshList();
        }

        function _setOpacity(pct) {
            if (!mgr.active || !mgr.layers.length) return;
            const l = mgr.layers[mgr.activeIdx];
            l.opacity = Math.max(0, Math.min(1, pct / 100));
            _applyLayerStyle(l);
            _syncOpacity();
        }

        /* Called by setSize patch — resize non-base layer canvases.
         * Note: canvas resize CLEARS content.  This matches the existing behaviour
         * of setSize() on cMain (the base layer). */
        function _resizeLayers(w, h) {
            if (!mgr.active) return;
            for (const l of mgr.layers) {
                if (l.isGroup) continue;
                // The bottom layer is off-screen like every other one now, so it
                // resizes here too rather than riding along with cMain.
                if (l.canvas && (l.canvas.width !== w || l.canvas.height !== h)) {
                    l.canvas.width  = w;
                    l.canvas.height = h;
                    app.disableSmoothing(l.ctx);
                }
                if (l.mask && l.mask.canvas &&
                    (l.mask.canvas.width !== w || l.mask.canvas.height !== h)) {
                    l.mask.canvas.width  = w;
                    l.mask.canvas.height = h;
                    app.disableSmoothing(l.mask.ctx);
                }
            }
            _invalidate();
        }

        /* ──────────────────────────────────────────────────────────────────
         * 7.  PANEL UI
         * ────────────────────────────────────────────────────────────────── */
        let _panelOpen = false;

        function _openPanel(v) {
            _panelOpen = (v !== undefined) ? !!v : !_panelOpen;
            _panelEl.classList.toggle('open', _panelOpen);
            if (_panelOpen) { _refreshList(); _schedThumb(); }
        }

        // ── Recursive helpers for group trees ────────────────────────
        function _isDescendant(childId, ancestorId) {
            while (childId) {
                if (childId === ancestorId) return true;
                const layer = mgr.layers.find(l => l.id === childId);
                childId = layer ? layer.parentId : null;
            }
            return false;
        }
        /* Deliberately no longer cascades visibility onto children: the
         * compositor skips a hidden group as a whole, so each child keeps its
         * own visible flag and survives the folder being toggled. */
        /* Every layer inside this folder, at any depth, plus the folder itself.
         * Built by repeated sweeps rather than recursion so it cannot be fooled
         * by a child that sits before its parent in the array. */
        function _subtreeIds(groupId) {
            const ids = new Set([groupId]);
            let grew = true;
            while (grew) {
                grew = false;
                for (const l of mgr.layers) {
                    if (l.parentId != null && ids.has(l.parentId) && !ids.has(l.id)) {
                        ids.add(l.id);
                        grew = true;
                    }
                }
            }
            return ids;
        }

        /* Clipping needs a sibling underneath to clip to. The bottom of the
         * document is covered by idx > 0, but the bottom of a FOLDER is not:
         * clipping there produced a layer that silently disappeared. */
        function _canClip(idx) {
            const l = mgr.layers[idx];
            if (!l || idx <= 0 || l.isGroup) return false;
            const parent = l.parentId || null;
            for (let i = idx - 1; i >= 0; i--) {
                if ((mgr.layers[i].parentId || null) === parent) return true;
            }
            return false;
        }

        function _setVisRecursive(groupId, visible) { _invalidate(); }
        function _unparentDescendants(groupId) {
            for (let i = 0; i < mgr.layers.length; i++) {
                if (mgr.layers[i].parentId === groupId) {
                    mgr.layers[i].parentId = null;
                    if (mgr.layers[i].isGroup) _unparentDescendants(mgr.layers[i].id);
                }
            }
        }

        function _refreshList() {
            const list = document.getElementById('lsys-list');
            if (!list) return;
            if (!mgr.active || !mgr.layers.length) {
                list.innerHTML =
                    '<div style="padding:10px 12px;color:#888;font-size:11px;">' +
                    'Click <b>+ Layer</b> to begin.<br><br>' +
                    'The app works exactly as normal until you add a second layer.' +
                    '</div>';
                return;
            }
            list.innerHTML = '';

            const eyeOpenPath =
                '<path d="M1 8C3 4 13 4 15 8C13 12 3 12 1 8Z" stroke="currentColor" stroke-width="1.5" fill="none"/>' +
                '<circle cx="8" cy="8" r="2.5" fill="currentColor"/>';
            const eyeClosedPath =
                '<line x1="2" y1="2" x2="14" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
                '<path d="M6.5 5.2A5.5 5.5 0 0 1 14.5 9.5M9.5 11A5.5 5.5 0 0 1 1.5 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>';

            const lockPath = (on) => on
                ? '<rect x="3" y="7" width="10" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/>' +
                  '<path d="M5 7V5a3 3 0 0 1 6 0v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>'
                : '<rect x="3" y="7" width="10" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/>' +
                  '<path d="M5 7V5a3 3 0 0 1 6 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>';

            // ── Helper: render a single layer row into parentEl ──────────
            function _renderLayerRow(i, parentEl, isChild) {
                const l = mgr.layers[i];
                const item = document.createElement('div');
                item.className = 'lsi' + (i === mgr.activeIdx ? ' lssel' : '') + (isChild ? ' lsi-child' : '');
                item.dataset.li = i;
                item.draggable = true;

                const visClass = l.visible ? '' : ' vis-off';
                const lockClass = l.locked ? ' locked' : '';
                const alphaBadge = (!l.isBase && l.alpha !== false)
                    ? '<span class="lsi-alpha-badge" title="Alpha channel">α</span>' : '';
                // A clipped layer is confined to the one below — show it the way
                // Photoshop does, with a turned corner arrow.
                const clipBadge = l.clipped
                    ? '<span class="lsi-clip-badge" title="Clipped to the layer below">⤷</span>' : '';
                const maskBadge = l.mask
                    ? '<span class="lsi-mask-badge' + (_isMaskEditing(l) ? ' editing' : '') +
                      (l.mask.enabled === false ? ' off' : '') +
                      '" title="' + (_isMaskEditing(l)
                          ? 'Editing the mask — paint reveals, erase hides'
                          : (l.mask.enabled === false ? 'Mask disabled' : 'Has a layer mask')) +
                      '">◑</span>' : '';

                item.innerHTML =
                    '<div class="lsi-icons">' +
                      '<span class="lsi-vis' + visClass + '" data-vi="' + i + '" title="' + (l.visible ? 'Hide layer' : 'Show layer') + '">' +
                        (l.visible
                          ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><ellipse cx="12" cy="12" rx="9" ry="6" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg>'
                          : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 3l18 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M10.5 10.6A3 3 0 0 0 13.4 13.5M6.3 6.4C4.5 7.7 3 9.7 3 12c0 1.5 2 4 5 5.5M17.7 17.7C19.5 16.3 21 14.3 21 12c0-1.5-2-4-5-5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>') +
                      '</span>' +
                      '<span class="lsi-lock' + lockClass + '" data-li="' + i + '" title="' + (l.locked ? 'Unlock layer' : 'Lock layer') + '">' +
                        (l.locked
                          ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="16" r="1.5" fill="currentColor"/></svg>'
                          : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M8 11V7a4 4 0 0 1 8 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>') +
                      '</span>' +
                    '</div>' +
                    '<div class="lsi-thumb-wrap"><canvas class="lsi-thumb" id="lsit-' + l.id + '" width="42" height="40"></canvas></div>' +
                    '<div style="flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:2px;padding-right:4px;">' +
                      '<span class="lsi-name" title="' + app.escapeHtml(l.name) + '">' + app.escapeHtml(l.name) + clipBadge + maskBadge + alphaBadge + (l.alphaLock ? ' <span style="font-size:9px;color:#0078d7;background:rgba(0,120,215,.1);padding:0 3px;border-radius:2px;font-weight:600;">\u{1F512}</span>' : '') + '</span>' +
                      '<select class="lsi-blend" data-bi="' + i + '" title="Blend mode" style="font-size:10px;border:1px solid #ccc;border-radius:2px;background:#fff;padding:0 2px;height:16px;width:100%;cursor:pointer;">' +
                        '<option value="source-over"'  + ((!l.blendMode || l.blendMode==='source-over')  ? ' selected' : '') + '>Normal</option>' +
                        '<option value="multiply"'     + (l.blendMode==='multiply'     ? ' selected' : '') + '>Multiply</option>' +
                        '<option value="screen"'       + (l.blendMode==='screen'       ? ' selected' : '') + '>Screen</option>' +
                        '<option value="overlay"'      + (l.blendMode==='overlay'      ? ' selected' : '') + '>Overlay</option>' +
                        '<option value="darken"'       + (l.blendMode==='darken'       ? ' selected' : '') + '>Darken</option>' +
                        '<option value="lighten"'      + (l.blendMode==='lighten'      ? ' selected' : '') + '>Lighten</option>' +
                        '<option value="color-dodge"'  + (l.blendMode==='color-dodge'  ? ' selected' : '') + '>Color Dodge</option>' +
                        '<option value="color-burn"'   + (l.blendMode==='color-burn'   ? ' selected' : '') + '>Color Burn</option>' +
                        '<option value="hard-light"'   + (l.blendMode==='hard-light'   ? ' selected' : '') + '>Hard Light</option>' +
                        '<option value="soft-light"'   + (l.blendMode==='soft-light'   ? ' selected' : '') + '>Soft Light</option>' +
                        '<option value="difference"'   + (l.blendMode==='difference'   ? ' selected' : '') + '>Difference</option>' +
                        '<option value="exclusion"'    + (l.blendMode==='exclusion'    ? ' selected' : '') + '>Exclusion</option>' +
                      '</select>' +
                    '</div>';

                parentEl.appendChild(item);

                item.addEventListener('click', e => {
                    if (e.target.closest('.lsi-icons')) return;
                    if (e.target.classList.contains('lsi-rename-input')) return;
                    if (e.target.closest('.lsi-name')) return;
                    _setActive(parseInt(item.dataset.li, 10));
                });
                item.addEventListener('contextmenu', e => {
                    _setActive(parseInt(item.dataset.li, 10));
                    _openCtx(e, parseInt(item.dataset.li, 10));
                });
                const nameSpan = item.querySelector('.lsi-name');
                if (nameSpan) {
                    nameSpan.addEventListener('click', e => {
                        e.stopPropagation();
                        _setActive(parseInt(item.dataset.li, 10));
                    });
                    nameSpan.addEventListener('dblclick', e => {
                        e.stopPropagation();
                        const layerIdx = parseInt(item.dataset.li, 10);
                        const currentName = mgr.layers[layerIdx].name;
                        const input = document.createElement('input');
                        input.type = 'text';
                        input.className = 'lsi-rename-input';
                        input.value = currentName;
                        nameSpan.replaceWith(input);
                        input.focus();
                        input.select();
                        let committed = false;
                        const commit = () => {
                            if (committed) return;
                            committed = true;
                            const newName = input.value.trim() || currentName;
                            mgr.layers[layerIdx].name = newName;
                            _refreshList();
                        };
                        input.addEventListener('blur', commit);
                        input.addEventListener('keydown', e2 => {
                            if (e2.key === 'Enter') { input.blur(); }
                            if (e2.key === 'Escape') { input.value = currentName; input.blur(); }
                            e2.stopPropagation();
                        });
                        input.addEventListener('click', e2 => e2.stopPropagation());
                        input.addEventListener('mousedown', e2 => e2.stopPropagation());
                    });
                }
                item.querySelector('.lsi-vis').addEventListener('click', e => {
                    e.stopPropagation();
                    _toggleVis(parseInt(e.currentTarget.dataset.vi, 10));
                });
                item.querySelector('.lsi-lock').addEventListener('click', e => {
                    e.stopPropagation();
                    const idx = parseInt(e.currentTarget.dataset.li, 10);
                    mgr.layers[idx].locked = !mgr.layers[idx].locked;
                    _refreshList(); _syncBtns();
                });
                item.querySelector('.lsi-blend').addEventListener('change', e => {
                    e.stopPropagation();
                    const idx = parseInt(e.currentTarget.dataset.bi, 10);
                    mgr.layers[idx].blendMode = e.currentTarget.value;
                    _applyLayerStyle(mgr.layers[idx]);   // make it visible on screen
                    app.saveState();
                });

                // Drag-and-drop
                item.addEventListener('dragstart', e => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', item.dataset.li);
                    setTimeout(() => item.classList.add('lsi-dragging'), 0);
                });
                item.addEventListener('dragend', () => {
                    item.classList.remove('lsi-dragging');
                    list.querySelectorAll('.lsi-dragover').forEach(el => el.classList.remove('lsi-dragover'));
                });
                item.addEventListener('dragover', e => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    list.querySelectorAll('.lsi-dragover').forEach(el => el.classList.remove('lsi-dragover'));
                    item.classList.add('lsi-dragover');
                });
                item.addEventListener('dragleave', () => item.classList.remove('lsi-dragover'));
                item.addEventListener('drop', e => {
                    _handleDrop(e, parseInt(item.dataset.li, 10));
                });
            }

            // ── Drop logic ──────────────────────────────────────────────
            function _handleDrop(e, toIdx) {
                e.preventDefault();
                list.querySelectorAll('.lsi-dragover').forEach(el => el.classList.remove('lsi-dragover'));
                const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
                if (fromIdx === toIdx || isNaN(fromIdx) || isNaN(toIdx) ||
                    fromIdx < 0 || fromIdx >= mgr.layers.length ||
                    toIdx < 0 || toIdx >= mgr.layers.length) return;
                const moved = mgr.layers.splice(fromIdx, 1)[0];
                if (!moved) return;
                const dest = fromIdx < toIdx ? toIdx - 1 : toIdx;
                const targetLayer = mgr.layers[dest];
                if (targetLayer && !targetLayer.isGroup) {
                    moved.parentId = targetLayer.parentId || null;
                }
                mgr.layers.splice(dest, 0, moved);
                _rebuildZOrder();
                _setActive(dest);
                app.saveState();
            }

            // ── Helper: recursively render a group and its children ─────
            function _renderGroup(i, parentEl, depth) {
                const l = mgr.layers[i];
                const grp = document.createElement('div');
                grp.className = 'lsi-group' + (depth > 0 ? ' lsi-nested' : '');
                grp.dataset.gi = i;
                const sel = i === mgr.activeIdx ? ' sel' : '';
                const hideChildren = l._open === false ? ' style="display:none"' : '';
                grp.innerHTML =
                    '<div class="lsi-group-hdr' + sel + '" data-gi="' + i + '">' +
                    '<span class="lsi-vis" data-vi="' + i + '" title="' + (l.visible ? 'Hide' : 'Show') + '">' +
                    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none">' + (l.visible ? eyeOpenPath : eyeClosedPath) + '</svg></span>' +
                    '<span class="lsi-group-arrow' + (l._open !== false ? ' open' : '') + '">▶</span>' +
                    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="flex-shrink:0"><rect x="1" y="4" width="14" height="9" rx="1.5" stroke="#0078d7" stroke-width="1.5" fill="none"/><rect x="3" y="2" width="5" height="3" rx="1" fill="#0078d7" opacity=".6"/></svg>' +
                    '<span style="flex:1;font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + app.escapeHtml(l.name) + '</span>' +
                    '</div>' +
                    '<div class="lsi-group-children"' + hideChildren + '></div>';
                parentEl.appendChild(grp);

                const hdr = grp.querySelector('.lsi-group-hdr');
                hdr.addEventListener('click', e => {
                    if (e.target.closest('.lsi-vis') || e.target.closest('.lsi-group-arrow')) return;
                    _setActive(parseInt(hdr.dataset.gi, 10));
                });
                hdr.addEventListener('contextmenu', e => { _setActive(i); _openCtx(e, i); });
                hdr.draggable = true;
                hdr.addEventListener('dragstart', e => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(i));
                    setTimeout(() => hdr.classList.add('lsi-dragging'), 0);
                });
                hdr.addEventListener('dragend', () => {
                    hdr.classList.remove('lsi-dragging');
                    list.querySelectorAll('.lsi-dragover').forEach(el => el.classList.remove('lsi-dragover'));
                });
                hdr.addEventListener('dragover', e => { e.preventDefault(); });

                // Visibility toggle on the eye icon
                grp.querySelector('.lsi-vis').addEventListener('click', e => { e.stopPropagation(); _toggleVis(i); });

                // Collapse/expand arrow — also hide/show children canvases
                grp.querySelector('.lsi-group-arrow').addEventListener('click', e => {
                    e.stopPropagation();
                    l._open = l._open === false;
                    _setVisRecursive(l.id, l._open && l.visible);
                    _refreshList();
                });

                // ── Drop handler for group header and children container ──
                const groupDropHandler = (e) => {
                    e.preventDefault();
                    const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
                    if (isNaN(fromIdx) || fromIdx < 0 || fromIdx >= mgr.layers.length) return;
                    const layer = mgr.layers[fromIdx];
                    if (layer.id === l.id || _isDescendant(l.id, layer.id)) return;
                    layer.parentId = l.id;
                    mgr.layers.splice(fromIdx, 1);
                    const grpIdx = mgr.layers.indexOf(l);
                    let insertAt = grpIdx + 1;
                    for (let ci = insertAt; ci < mgr.layers.length; ci++) {
                        if (mgr.layers[ci].parentId === l.id) insertAt = ci + 1;
                        else break;
                    }
                    mgr.layers.splice(insertAt, 0, layer);
                    _rebuildZOrder();
                    _setActive(mgr.layers.indexOf(layer));
                    app.saveState();
                    _refreshList();
                };

                hdr.addEventListener('drop', groupDropHandler);

                // ── Render children ──────────────────────────────────────
                const childrenContainer = grp.querySelector('.lsi-group-children');
                const childIndices = childrenOf[l.id] || [];
                for (let ci = childIndices.length - 1; ci >= 0; ci--) {
                    if (mgr.layers[childIndices[ci]].isGroup) {
                        _renderGroup(childIndices[ci], childrenContainer, depth + 1);
                    } else {
                        _renderLayerRow(childIndices[ci], childrenContainer, true);
                    }
                }

                childrenContainer.addEventListener('dragover', e => { e.preventDefault(); });
                childrenContainer.addEventListener('drop', groupDropHandler);
            }

            // ── Render all layers ───────────────────────────────────────
            const childrenOf = {};
            for (let j = 0; j < mgr.layers.length; j++) {
                const l2 = mgr.layers[j];
                if (l2.parentId && l2.parentId !== null) {
                    (childrenOf[l2.parentId] = childrenOf[l2.parentId] || []).push(j);
                }
            }

            for (let i = mgr.layers.length - 1; i >= 0; i--) {
                const l = mgr.layers[i];
                if (l.parentId) continue;
                if (l.isGroup) {
                    _renderGroup(i, list, 0);
                } else {
                    _renderLayerRow(i, list, false);
                }
            }
            _schedThumb();
        }

        /* Stacking order used to be CSS z-index on DOM canvases. The compositor
         * draws mgr.layers bottom-to-top, so array order IS the z-order and
         * reordering just needs a repaint. */
        function _rebuildZOrder() { _invalidate(); }

        function _schedThumb() {
            if (mgr._thumbRaf) return;
            mgr._thumbRaf = requestAnimationFrame(() => {
                mgr._thumbRaf = null;
                if (!mgr.active) return;
                for (const l of mgr.layers) {
                    if (l.isGroup) continue;
                    const th = document.getElementById('lsit-' + l.id);
                    if (!th) continue;
                    try {
                        const tc = th.getContext('2d');
                        const tw = th.width, th2 = th.height; // 38 x 36
                        const cw = l.canvas.width, ch = l.canvas.height;
                        tc.clearRect(0, 0, tw, th2);
                        if (cw > 0 && ch > 0) {
                            // Stretch to fill the full thumbnail — no letterbox, no offsets,
                            // so the wrap's checkerboard background never peeks through.
                            tc.imageSmoothingEnabled = true;
                            tc.imageSmoothingQuality = 'medium';
                            tc.drawImage(l.canvas, 0, 0, tw, th2);
                        }
                    } catch(_) {}
                }
            });
        }

        function _syncBtns() {
            const has     = mgr.active && mgr.layers.length > 0;
            const active  = has ? mgr.layers[mgr.activeIdx] : null;
            const locked  = active && active.locked;
            const canDel  = has && mgr.layers.length > 1 && !locked;
            const canUp   = has && mgr.activeIdx < mgr.layers.length - 1 && !locked;
            const canDown = has && mgr.activeIdx > 0 && !locked;
            const canMrg  = has && mgr.activeIdx > 0 && !locked;
            const upBtn   = document.getElementById('lsys-up');
            const downBtn = document.getElementById('lsys-down');
            const del     = document.getElementById('lsys-del');
            const merge   = document.getElementById('lsys-merge');
            const grp     = document.getElementById('lsys-group');
            if (upBtn)  upBtn.disabled   = !canUp;
            if (downBtn) downBtn.disabled = !canDown;
            if (del)   del.disabled   = !canDel;
            if (merge) merge.disabled = !canMrg;
            if (grp)   grp.disabled   = !has;

            const clipBtn   = document.getElementById('lsys-clip');
            const maskBtn   = document.getElementById('lsys-mask');
            const flatBtn   = document.getElementById('lsys-flatten');
            const exportBtn = document.getElementById('lsys-export');
            // Clipping needs something underneath to clip to.
            if (clipBtn) {
                clipBtn.disabled = !(has && mgr.activeIdx > 0 && active && !active.isGroup);
                clipBtn.classList.toggle('lstb-on', !!(active && active.clipped));
            }
            if (maskBtn) {
                maskBtn.disabled = !(has && active && !active.isGroup);
                maskBtn.classList.toggle('lstb-on', !!(active && active.mask));
                maskBtn.title = active && active.mask
                    ? (_isMaskEditing(active)
                        ? 'Editing the mask — paint to reveal, erase to hide. Click to go back to the layer.'
                        : 'Edit this layer’s mask')
                    : 'Add a layer mask — hide parts without erasing them';
            }
            if (flatBtn)   flatBtn.disabled   = !(has && mgr.layers.length > 1);
            if (exportBtn) exportBtn.disabled = !(has && mgr.layers.length > 1);
        }

        function _syncOpacity() {
            const sl = document.getElementById('lsys-op');
            const vl = document.getElementById('lsys-opval');
            if (!sl || !vl) return;
            const pct = (mgr.active && mgr.layers.length)
                ? Math.round(mgr.layers[mgr.activeIdx].opacity * 100) : 100;
            sl.value = pct;
            vl.textContent = pct + '%';
        }

        /* Keep panel top aligned below the ribbon (the ribbon can be
         * on/off and its height varies). */
        /* Position is now handled entirely by CSS (top:145px; bottom:24px;).
         * The layer-ribbon visibility toggle is already handled by setTool(). */

        /* ──────────────────────────────────────────────────────────────────
         * 8.  PATCH: saveState
         *     — when single-layer, delegates to original unchanged.
         *     — when multi-layer, snapshots every layer canvas.
         * ────────────────────────────────────────────────────────────────── */
        const _origSaveState = app.saveState.bind(app);
        app.saveState = function () {
            if (!mgr.active || mgr.layers.length <= 1) {
                _origSaveState();
                _schedThumb();
                return;
            }
            // Same contract as the single-layer path: the index map is folded in
            // before the snapshot. Layered artwork is read from the composite and
            // not snapped — see projectIndexSurface().
            this.commitProjectIndices();
            // Truncate forward history, releasing the discarded entries without
            // closing pixels the surviving entries still reference.
            if (this.state.step < this.state.history.length - 1) {
                const dropped = this.state.history.splice(this.state.step + 1);
                this._releaseHistoryEntries(dropped, this.state.history);
            }

            // Mark the active layer dirty — it was just drawn on.
            if (mgr.layers[mgr.activeIdx]) mgr.layers[mgr.activeIdx]._dirty = true;

            // Find the previous _lsys entry to reference unchanged layers from.
            const prevEntry = (this.state.step >= 0)
                ? this.state.history[this.state.step]
                : null;
            const prevSnaps = (prevEntry && prevEntry._lsys) ? prevEntry.snaps : null;

            // Snapshot only dirty layers; reference the previous snap for clean ones.
            let ownedBytes = 0;
            const snaps = mgr.layers.map((l, i) => {
                const prev = (prevSnaps && prevSnaps[i] && prevSnaps[i].id === l.id)
                    ? prevSnaps[i] : null;
                // A mask is only re-copied when the mask itself was painted on.
                // Drawing on the artwork used to clone the mask as well, which
                // doubled the cost of every stroke on a masked layer.
                let mask;
                if (prev && prev.mask && !l._maskDirty) {
                    mask = prev.mask;
                } else {
                    mask = _snapshotMask(l);
                    if (mask && mask.canvas) {
                        ownedBytes += mask.canvas.width * mask.canvas.height * 4;
                    }
                }

                if (!l._dirty && prev) {
                    // Layer unchanged — share the previous entry's snap by reference.
                    return { id: l.id, name: l.name, visible: l.visible, opacity: l.opacity,
                             blendMode: l.blendMode, alpha: l.alpha, alphaLock: l.alphaLock, locked: l.locked,
                             parentId: l.parentId, isGroup: !!l.isGroup, clipped: !!l.clipped,
                             mask,
                             isBase: l.isBase, snap: null, bitmap: null, ref: prev };
                }
                // Dirty — clone the canvas now (always safe / synchronous fallback).
                const snap = document.createElement('canvas');
                snap.width  = l.canvas.width;
                snap.height = l.canvas.height;
                snap.getContext('2d').drawImage(l.canvas, 0, 0);
                ownedBytes += snap.width * snap.height * 4;
                return { id: l.id, name: l.name, visible: l.visible, opacity: l.opacity,
                         blendMode: l.blendMode, alpha: l.alpha, alphaLock: l.alphaLock, locked: l.locked,
                         parentId: l.parentId, isGroup: !!l.isGroup, clipped: !!l.clipped,
                         mask,
                         isBase: l.isBase, snap, bitmap: null, ref: null };
            });

            // Clear dirty flags now that we've snapshotted.
            for (const l of mgr.layers) { l._dirty = false; l._maskDirty = false; }

            const entry = {
                _lsys: true, snaps,
                // activeIdx intentionally omitted - layer selection is navigation, not a document edit
                width:  this.config.width,
                height: this.config.height,
                _bytes: ownedBytes
            };
            this.state.history.push(entry);
            this.state.step++;
            this.attachProjectStep(entry);
            this.enforceHistoryLimit();
            this.state.isDirty = true;
            this.deferColorCounts();
            this.updateTitleBarActions();
            _schedThumb();

            // Upgrade only the freshly-cloned (owned) snaps to ImageBitmaps.
            if (window.createImageBitmap) {
                const owned = snaps
                    .map((sv, i) => sv.snap ? { i, sv } : null)
                    .filter(Boolean);
                if (owned.length) {
                    Promise.all(owned.map(({ i, sv }) =>
                        createImageBitmap(sv.snap).then(bmp => ({ i, bmp })).catch(() => null)
                    )).then(results => {
                        if (!this.state.history.includes(entry)) {
                            for (const r of results) if (r) r.bmp.close();
                            return;
                        }
                        for (const r of results) {
                            if (!r) continue;
                            snaps[r.i].bitmap = r.bmp;
                            // Zero the canvas before dropping it: that releases
                            // the pixel buffer now rather than at the next
                            // collection, which is the difference between a
                            // steady footprint and a sawtooth one.
                            const old = snaps[r.i].snap;
                            if (old) { old.width = 0; old.height = 0; }
                            snaps[r.i].snap = null;
                        }
                    });
                }
            }
        };

        /* ──────────────────────────────────────────────────────────────────
         * 9.  PATCH: restoreHistoryEntry
         *     — flat entries: collapses multi-layer back to base layer.
         *     — _lsys entries: restores all layer canvases.
         * ────────────────────────────────────────────────────────────────── */
        /* Tear the stack back down to the single base layer. The layer stack is
         * global (one set of canvases in the DOM), so any operation that starts
         * a genuinely new document has to collapse it — otherwise the new
         * document inherits the previous one's layers. */
        function _collapseToBase(opts) {
            // cMain is about to change role between composite and artwork; whatever
            // was known about the untouched area no longer holds.
            app.markAllDirty();
            const fresh = !!(opts && opts.fresh);
            // Bake the composite into cMain first: single-canvas mode draws
            // straight onto it, so it has to hold the finished picture before we
            // drop the layers. (Callers that immediately overwrite cMain — undo
            // across the layer boundary, or a brand-new document — are
            // unaffected.)
            if (mgr.active && mgr.layers.length) {
                try { _render(); } catch (e) { console.warn('[Layers] flatten on collapse failed', e); }
            }
            // Layers are off-screen; dropping the references is all that is
            // needed. Emptying the array also restores the pristine state
            // _activate() expects, so it can never build a second Background.
            mgr.layers.length = 0;
            // A brand-new document restarts layer numbering; undo must not, or
            // it could hand out an id an existing history entry already uses.
            if (fresh) mgr.nextId = 2;
            mgr.activeIdx = 0;
            mgr.active = false;
            if (app.ui.cTemp) app.ui.cTemp.style.zIndex = '';
            if (app.ui.stage) app.ui.stage.classList.remove('layers-active');
            _refreshList();
            _syncBtns();
        }
        mgr.collapseToBase = _collapseToBase;

        const _origRestoreEntry = app.restoreHistoryEntry.bind(app);
        app.restoreHistoryEntry = function (entry, stepIdx) {
            if (!entry._lsys) {
                // Undo/redo crossed the layer-activation boundary — collapse.
                if (mgr.active && mgr.layers.length > 1) _collapseToBase();
                _origRestoreEntry(entry, stepIdx);
                // Re-sync the holder after setSize may have re-created the context.
                _holder.ctx = app.trackCtx(app.ui.cMain.getContext('2d', { willReadFrequently: true }));
                app.disableSmoothing(_holder.ctx);
                return;
            }
            // ── Multi-layer restore ─────────────────────────────────────
            const { snaps, width, height } = entry;
            // Remove surplus layers.
            while (mgr.layers.length > snaps.length) {
                const l = mgr.layers.pop();
            }
            // Restore existing layers and create missing ones.
            for (let i = 0; i < snaps.length; i++) {
                const sv = snaps[i];
                // Resolve ref snaps — walk the ref chain to the owned snap/bitmap.
                const src = (() => {
                    let s = sv;
                    while (s.ref) s = s.ref;
                    return s.bitmap || s.snap;
                })();
                if (i === 0) this.setSize(width, height); // resizes the display canvas + cTemp
                // A released entry has neither a bitmap nor a canvas — something
                // freed pixels that were still in use. Leave that one layer
                // blank rather than throwing, so the rest of the stack still
                // rebuilds (and stays correctly aligned) instead of stranding
                // the document half-restored.
                if (!src) {
                    console.warn('[Layers] history entry has no pixels for layer', sv.id, sv.name);
                }
                if (i < mgr.layers.length) {
                    const l = mgr.layers[i];
                    // Every layer is off-screen now, including the bottom one,
                    // so they all resize the same way.
                    if (l.canvas.width !== width || l.canvas.height !== height) {
                        l.canvas.width = width; l.canvas.height = height;
                    }
                    app.disableSmoothing(l.ctx);
                    l.ctx.clearRect(0, 0, width, height);
                    if (src) l.ctx.drawImage(src, 0, 0);
                    l.name = sv.name; l.visible = sv.visible; l.opacity = sv.opacity;
                    l.blendMode = sv.blendMode; l.alpha = sv.alpha; l.alphaLock = sv.alphaLock; l.locked = sv.locked; l.parentId = sv.parentId;
                    l.isGroup = !!sv.isGroup;
                    l.clipped = !!sv.clipped;
                    _restoreMask(l, sv, width, height);
                    // Layer restored — clear dirty flag so next save can ref it.
                    l._dirty = false;
                } else {
                    const c = _newCanvas(width, height);
                    const ctx = c.getContext('2d', { willReadFrequently: true });
                    app.disableSmoothing(ctx);
                    if (src) ctx.drawImage(src, 0, 0);
                    if (sv.id >= mgr.nextId) mgr.nextId = sv.id + 1;
                    const nl = {
                        id: sv.id, name: sv.name,
                        canvas: c, ctx,
                        visible: sv.visible, opacity: sv.opacity,
                        blendMode: sv.blendMode, alpha: sv.alpha, alphaLock: sv.alphaLock, locked: sv.locked,
                        isBase: i === 0, _dirty: false,
                        isGroup: !!sv.isGroup, clipped: !!sv.clipped, mask: null,
                        parentId: sv.parentId,
                    };
                    mgr.layers.push(nl);
                    _restoreMask(nl, sv, width, height);
                }
            }
            // Do NOT restore activeIdx -- layer selection is a navigation
            // action, not a content edit. Krita, CSP, and modern Photoshop
            // all keep layer selection outside the undo/redo stack.  Clamp
            // it against the current array size so undo/redo can never push
            // it out of bounds.
            mgr.active    = true;
            mgr.activeIdx = Math.min(mgr.activeIdx, Math.max(0, mgr.layers.length - 1));
            // Re-assert the multi-layer display state. Reaching here from a
            // collapsed stack (undo across the layer boundary, or switching to a
            // layered tab from a flat one) means _collapseToBase() cleared these.
            if (app.ui.cTemp) app.ui.cTemp.style.zIndex = '200';
            if (app.ui.stage) app.ui.stage.classList.add('layers-active');
            _invalidate();
            this.restoreProjectStep(entry);
            this.requestGlobalOverlayUpdate();
            this.deferColorCounts();
            _refreshList(); _syncBtns(); _syncOpacity();
        };

        /* ──────────────────────────────────────────────────────────────────
         * 10. PATCH: setSize — resize non-base layer canvases too
         * ────────────────────────────────────────────────────────────────── */
        const _origSetSize = app.setSize.bind(app);
        app.setSize = function (w, h) {
            _origSetSize(w, h);
            _resizeLayers(w, h);
        };

        /* ──────────────────────────────────────────────────────────────────
         * 11. PATCH: drawBinaryLine — destination-out eraser on transparent layers
         *     Background (layer 0) keeps the classic C2-colour fill eraser.
         * ────────────────────────────────────────────────────────────────── */
        const _origDrawBinaryLine = app.drawBinaryLine.bind(app);
        app.drawBinaryLine = function (x0, y0, x1, y1, color, isPreview, widthOverride, isEraserOverride) {
            // Locked layer: silently skip all drawing
            if (mgr.active && mgr.layers.length && mgr.layers[mgr.activeIdx].locked && !isPreview) return;
            // Layers are off-screen; anything drawn has to trigger a repaint.
            if (!isPreview) _invalidate();
            const isEraser = (isEraserOverride !== null && isEraserOverride !== undefined)
                ? !!isEraserOverride
                : (this.config.tool === 'eraser');
            const onTransLayer = mgr.active && mgr.activeIdx > 0 && !isPreview;
            const onBaseLayerActive = mgr.active && mgr.activeIdx === 0 && !isPreview;
            if (isEraser && (onTransLayer || onBaseLayerActive)) {
                // True pixel-deletion via destination-out for transparent layers,
                // and also for the base layer when the layer system is active
                // (so erasing the base layer reveals the checkerboard).
                const layerIdx = onBaseLayerActive ? 0 : mgr.activeIdx;
                const ctx = _targetCtx(mgr.layers[layerIdx]);
                const w = (widthOverride !== null && widthOverride !== undefined)
                    ? widthOverride : this.config.eraserWidth;
                const half = Math.floor(w / 2);
                const sz   = Math.max(1, Math.ceil(w));
                let ix0 = Math.floor(x0), iy0 = Math.floor(y0);
                let ix1 = Math.floor(x1), iy1 = Math.floor(y1);
                const dx = Math.abs(ix1-ix0), dy = Math.abs(iy1-iy0);
                const sx = ix0 < ix1 ? 1 : -1, sy = iy0 < iy1 ? 1 : -1;
                let err = dx - dy;
                ctx.save();
                ctx.globalCompositeOperation = 'destination-out';
                ctx.fillStyle = 'rgba(0,0,0,1)';
                for (;;) {
                    ctx.fillRect(ix0 - half, iy0 - half, sz, sz);
                    if (ix0 === ix1 && iy0 === iy1) break;
                    const e2 = 2 * err;
                    if (e2 > -dy) { err -= dy; ix0 += sx; }
                    if (e2 <  dx) { err += dx; iy0 += sy; }
                }
                ctx.restore();
                return;
            }
            // Alpha lock: constrain drawing to existing opaque pixels
            const activeLayer = mgr.active && mgr.layers.length ? mgr.layers[mgr.activeIdx] : null;
            if (!isPreview && activeLayer && activeLayer.alphaLock && !_isMaskEditing(activeLayer)) {
                const ctx = activeLayer.ctx;
                ctx.save();
                ctx.globalCompositeOperation = 'source-atop';
                _origDrawBinaryLine(x0, y0, x1, y1, color, isPreview, widthOverride, isEraserOverride);
                ctx.restore();
                return;
            }
            return _origDrawBinaryLine(x0, y0, x1, y1, color, isPreview, widthOverride, isEraserOverride);
        };

        /* ──────────────────────────────────────────────────────────────────
         * 12. PATCH: flushStrokes
         *     On a transparent layer, eraser strokes are intercepted and
         *     handled via drawBinaryLine (which uses destination-out).
         *     Normal strokes and the base-layer case are unchanged.
         *     Also schedules a thumbnail refresh after every flush.
         * ────────────────────────────────────────────────────────────────── */
        const _origFlushStrokes = app.flushStrokes.bind(app);
        app.flushStrokes = function () {
            const onTransLayer = mgr.active && mgr.activeIdx > 0;
            const onBaseLayerActive = mgr.active && mgr.activeIdx === 0;
            if (!onTransLayer && !onBaseLayerActive) { _origFlushStrokes(); _invalidate(); _schedThumb(); return; }
            if (onBaseLayerActive) {
                // Base layer: route eraser strokes through destination-out, normals unchanged
                const q = this.strokeQueue;
                this.strokeQueue = [];
                this.strokeRaf   = null;
                const erasers = q.filter(s =>  s.isEraser);
                const normals = q.filter(s => !s.isEraser);
                if (normals.length) { this.strokeQueue = normals; _origFlushStrokes(); }
                for (const s of erasers) {
                    const hw = Math.ceil((s.width || 1) / 2) + 1;
                    const bx0 = Math.min(s.x0, s.x1) - hw;
                    const bx1 = Math.max(s.x0, s.x1) + hw;
                    const by0 = Math.min(s.y0, s.y1) - hw;
                    const by1 = Math.max(s.y0, s.y1) + hw;
                    const dx = Math.max(0, Math.floor(bx0));
                    const dy = Math.max(0, Math.floor(by0));
                    const dw = Math.min(this.config.width, Math.ceil(bx1)) - dx;
                    const dh = Math.min(this.config.height, Math.ceil(by1)) - dy;
                    this.drawBinaryLine(s.x0, s.y0, s.x1, s.y1, s.color, false, s.width, true);
                }
                _invalidate();
                _schedThumb();
                return;
            }
            const q = this.strokeQueue;
            this.strokeQueue = [];
            this.strokeRaf   = null;
            const erasers = q.filter(s =>  s.isEraser);
            const normals = q.filter(s => !s.isEraser);
            if (normals.length) { this.strokeQueue = normals; _origFlushStrokes(); }
            for (const s of erasers) {
                this.drawBinaryLine(s.x0, s.y0, s.x1, s.y1, s.color, false, s.width, true);
            }
            _invalidate();
            _schedThumb();
        };

        /* ──────────────────────────────────────────────────────────────────
         * 13. PATCH: stampSelection — strip C2 when on a transparent layer
         *     The floating-selection pipeline is preserved intact; only the
         *     final stamp onto the layer canvas differs.  C2 pixels (which
         *     are the classic "transparent colour" in the clipboard buffer)
         *     are made truly transparent before writing to the layer.
         * ────────────────────────────────────────────────────────────────── */
        const _origStampSel = app.stampSelection.bind(app);
        app.stampSelection = function () {
            _invalidate();
            const onTransLayer = mgr.active && mgr.activeIdx > 0;
            if (!onTransLayer) { _origStampSel(); return; }
            const s = this.state.selection;
            if (!s) { _origStampSel(); return; }
            const renderC  = this.getRenderedSelectionCanvas();
            if (!renderC)  { _origStampSel(); return; }
            const metrics = this.getSelectionDrawMetrics(s, renderC, true);
            if (!metrics)  { _origStampSel(); return; }
            const stripped = _stripC2(renderC, this.config.c2);
            const ctx = mgr.layers[mgr.activeIdx].ctx;
            this.disableSmoothing(ctx);
            ctx.drawImage(stripped, metrics.destX, metrics.destY);
            // Note: does NOT call _origStampSel — we've handled the stamp ourselves.
        };

        /* ──────────────────────────────────────────────────────────────────
         * 14. PATCH: saveFile — composite all layers onto the base canvas
         *     momentarily, then restore the base layer after the save.
         * ────────────────────────────────────────────────────────────────── */
        /* NOTE: saveFile() already begins with its own "layers active -> save as
         * ORA" check (see the class method), so no policy wrapper is needed
         * here. A second one used to exist and only added a way for the two
         * checks to disagree. Flattened export deliberately bypasses saveFile
         * entirely — see app.exportFlattenedPng below.
         *
         * These wrappers add REPORTING only. Save is triggered from inline
         * onclick handlers that neither await nor catch, so a thrown error
         * became an unhandled rejection and the user saw nothing happen at all.
         * A save that fails must say so. */
        for (const _fn of ['saveFile', 'saveAsFile']) {
            if (typeof app[_fn] !== 'function') continue;
            const _orig = app[_fn].bind(app);
            app[_fn] = async function (...args) {
                try {
                    return await _orig(...args);
                } catch (e) {
                    console.error('[Save] ' + _fn + ' failed', e);
                    if (window.showToast) {
                        showToast('Save failed: ' + ((e && e.message) || 'unknown error'), 'error');
                    }
                    throw e;
                }
            };
        }

        /* Export the composited picture as a PNG without disturbing the layered
         * document.
         *
         * This deliberately does NOT go through saveFile(): that method starts
         * with its own "if layers are active, save as ORA" check, so routing an
         * export through it just produced another .ora. Build the blob and write
         * it directly instead. */
        app.exportFlattenedPng = async function () {
            const canvas = mgr.getFlattenedCanvas();
            if (!canvas) return null;
            const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
            if (!blob) throw new Error('Could not read the canvas');
            const baseName = (this.state.fileName || 'untitled').replace(/\.[^/.]+$/, '');
            const saved = await _saveBlobAs(
                blob, baseName + '.png', 'PNG Image', { 'image/png': ['.png'] }
            );
            // An export is not a save of the document — the .ora is still the
            // file of record, so the unsaved-changes state is left alone.
            if (saved && window.showToast) showToast('Exported ' + baseName + '.png', 'success');
            return saved;
        };

        /* ──────────────────────────────────────────────────────────────────
         * 15. PATCH: updateHoverPreview — disabled, leave canvas blank
         * ────────────────────────────────────────────────────────────────── */
        app.updateHoverPreview = function (x, y) { /* disabled */ };

        /* ──────────────────────────────────────────────────────────────────
         * 15b. (removed) PATCH: onMouseDown — wand samples composite
         *
         * This used to re-run the whole wand setup block from onMouseDown with
         * composite pixels swapped in, whenever the document had more than one
         * layer. Two problems: it ran the full diff/sort/worker setup a second
         * time on every wand click, and the composite ImageData it installed as
         * state.wandBase was then used by applyMaskSelection as the *source*
         * for the layer's new contents — so wanding a lower layer baked the
         * upper layers' art into it.
         *
         * The engine now asks getSampleSource() what to read, honouring the
         * "sample all layers" setting, so there is nothing to patch here.
         * ────────────────────────────────────────────────────────────────── */

        /* ══════════════════════════════════════════════════════════════════
         * ORA  (OpenRaster)  SAVE / LOAD
         * Spec: https://www.openraster.org/
         *
         * File layout inside the ZIP:
         *   mimetype                    (stored, no compression)
         *   stack.xml                   (layer manifest)
         *   data/layer_0.png … N.png   (bottom→top, DEFLATE)
         *   Thumbnails/thumbnail.png    (composite preview, ≤256 px)
         *   mergedimage.png             (full-res composite)
         *
         * Extra attributes (non-standard, ignored by other apps):
         *   paint:locked, paint:alphaLock, paint:isBase
         * ══════════════════════════════════════════════════════════════════ */

        /* ── Minimal ZIP builder ─────────────────────────────────────────── */
        const _oraZip = (() => {
            const enc = new TextEncoder();

            function crc32(buf) {
                let c = 0xFFFFFFFF;
                for (let i = 0; i < buf.length; i++) {
                    c ^= buf[i];
                    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                }
                return (c ^ 0xFFFFFFFF) >>> 0;
            }

            function u16le(n) { return [(n & 0xff), (n >> 8) & 0xff]; }
            function u32le(n) { return [(n & 0xff), (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]; }

            function concat(...arrs) {
                const len = arrs.reduce((s, a) => s + a.length, 0);
                const out = new Uint8Array(len);
                let off = 0;
                for (const a of arrs) { out.set(a, off); off += a.length; }
                return out;
            }

            /* deflate via CompressionStream (zlib-wrapped) or fallback stored */
            async function deflateRaw(data) {
                if (typeof CompressionStream !== 'undefined') {
                    try {
                        const cs = new CompressionStream('deflate-raw');
                        // Start draining the output BEFORE pushing input.
                        //
                        // `await writer.write(data)` only settles once the chunk
                        // has been accepted downstream. With nothing reading
                        // cs.readable yet, anything larger than the stream's
                        // internal queue blocks on backpressure that can never
                        // clear — the promise simply never resolves and the save
                        // hangs forever with no error. Small layers fit in the
                        // queue and appeared to work, which is what made this
                        // look intermittent.
                        //
                        // (The ORA *loader* already does it in this order.)
                        const done = new Response(cs.readable).arrayBuffer();
                        const writer = cs.writable.getWriter();
                        await writer.write(data);
                        await writer.close();
                        return new Uint8Array(await done);
                    } catch (_) { /* fall through */ }
                }
                /* stored (method 0) — always works */
                return null; /* signals caller to use STORED */
            }

            return {
                async build(entries) {
                    /* entries: [{name:string, data:Uint8Array, store:bool}] */
                    const localHeaders = [];
                    const centralDirs  = [];
                    let offset = 0;

                    for (const entry of entries) {
                        const nameBytes = enc.encode(entry.name);
                        const raw  = entry.data;
                        const crc  = crc32(raw);
                        let method = 0, compressed = raw;

                        if (!entry.store) {
                            const def = await deflateRaw(raw);
                            if (def && def.length < raw.length) {
                                method = 8; compressed = def;
                            }
                        }

                        const local = new Uint8Array([
                            0x50,0x4B,0x03,0x04,      // local file sig
                            0x14,0x00,                 // version needed
                            0x00,0x00,                 // flags
                            ...u16le(method),          // compression
                            0x00,0x00,0x00,0x00,       // mod time / date (zero)
                            ...u32le(crc),
                            ...u32le(compressed.length),
                            ...u32le(raw.length),
                            ...u16le(nameBytes.length),
                            0x00,0x00,                 // extra len
                            ...nameBytes,
                            ...compressed,
                        ]);

                        const central = new Uint8Array([
                            0x50,0x4B,0x01,0x02,       // central dir sig
                            0x1E,0x03,                 // version made by
                            0x14,0x00,                 // version needed
                            0x00,0x00,                 // flags
                            ...u16le(method),
                            0x00,0x00,0x00,0x00,       // mod time / date
                            ...u32le(crc),
                            ...u32le(compressed.length),
                            ...u32le(raw.length),
                            ...u16le(nameBytes.length),
                            0x00,0x00,                 // extra len
                            0x00,0x00,                 // comment len
                            0x00,0x00,                 // disk start
                            0x00,0x00,                 // int attribs
                            0x00,0x00,0x00,0x00,       // ext attribs
                            ...u32le(offset),
                            ...nameBytes,
                        ]);

                        localHeaders.push(local);
                        centralDirs.push(central);
                        offset += local.length;
                    }

                    const cdOffset = offset;
                    const cdSize   = centralDirs.reduce((s, a) => s + a.length, 0);
                    const eocd = new Uint8Array([
                        0x50,0x4B,0x05,0x06,           // EOCD sig
                        0x00,0x00,                     // disk number
                        0x00,0x00,                     // disk with CD
                        ...u16le(entries.length),      // total entries on disk
                        ...u16le(entries.length),      // total entries
                        ...u32le(cdSize),
                        ...u32le(cdOffset),
                        0x00,0x00,                     // comment len
                    ]);

                    /* local file records must be contiguous first, then the
                       central directory, then EOCD — cdOffset is the byte
                       position where CD starts (= sum of all local records). */
                    const localBlob   = concat(...localHeaders);
                    const centralBlob = concat(...centralDirs);
                    return concat(localBlob, centralBlob, eocd);
                }
            };
        })();

        /* Write a blob to disk the same way the PNG save path does: a real file
         * picker where one is available, the Tauri writer in the desktop app,
         * and a download link only as a last resort. ORA saving used to always
         * take the last branch, which silently dropped a file in the downloads
         * folder — so "Save" looked like it did nothing at all. */
        async function _saveBlobAs(blob, suggestedName, typeDesc, accept) {
            const ext = (suggestedName.split('.').pop() || '').toLowerCase();

            /* 1. Desktop app: the native OS save dialog.
             *
             * The subtlety that made "Save" look dead: tauriSaveFileDialog()
             * returns undefined when the dialog plugin isn't reachable, and null
             * when the user cancelled. Treating both as "cancelled" meant an
             * unavailable dialog silently aborted the save with no error and no
             * window. Only an explicit null counts as a cancel; undefined means
             * "this mechanism isn't available" and we move on to the next one. */
            if (window.__TAURI__ && app.tauriSaveFileDialog) {
                let picked;
                let dialogWorked = true;
                try {
                    picked = await app.tauriSaveFileDialog({
                        defaultPath: suggestedName,
                        filters: [{ name: typeDesc, extensions: [ext] }]
                    });
                } catch (e) {
                    console.warn('[Save] native save dialog unavailable, trying the next option', e);
                    dialogWorked = false;
                }
                if (dialogWorked && picked === null) return null;      // cancelled
                if (dialogWorked && picked) {
                    const bytes = new Uint8Array(await blob.arrayBuffer());
                    await app.tauriWriteAllowedFile(picked, bytes);
                    return picked;
                }
                // undefined => no dialog available; fall through.
            }

            /* 2. Browser with the File System Access API. */
            if (window.showSaveFilePicker) {
                let handle;
                try {
                    handle = await window.showSaveFilePicker({
                        suggestedName,
                        types: [{ description: typeDesc, accept }]
                    });
                } catch (e) {
                    if (e && e.name === 'AbortError') return null;   // user cancelled
                    console.warn('[Save] file picker unavailable, falling back to download', e);
                    handle = null;
                }
                if (handle) {
                    const writable = await handle.createWritable();
                    await writable.write(blob);
                    await writable.close();
                    return handle.name || suggestedName;
                }
            }

            /* 3. Last resort: a plain download. No dialog, so say so rather than
             * leaving the user wondering whether anything happened. */
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = suggestedName; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
            if (window.showToast) {
                showToast('Saved to your Downloads folder as ' + suggestedName +
                          ' — this build could not open a file dialog.', 'warning');
            }
            return suggestedName;
        }

        /* ── Canvas → PNG bytes ──────────────────────────────────────────── */
        async function _canvasToPngBytes(canvas) {
            return new Promise((res, rej) => {
                canvas.toBlob(async b => {
                    if (!b) { rej(new Error('toBlob failed')); return; }
                    res(new Uint8Array(await b.arrayBuffer()));
                }, 'image/png');
            });
        }

        /* ── Blend mode: canvas → ORA composite-op name ─────────────────── */
        const _blendToOra = {
            'source-over': 'svg:src-over',
            'multiply':    'svg:multiply',
            'screen':      'svg:screen',
            'overlay':     'svg:overlay',
            'darken':      'svg:darken',
            'lighten':     'svg:lighten',
            'color-dodge': 'svg:color-dodge',
            'color-burn':  'svg:color-burn',
            'hard-light':  'svg:hard-light',
            'soft-light':  'svg:soft-light',
            'difference':  'svg:difference',
            'exclusion':   'svg:exclusion',
            'hue':         'svg:hue',
            'saturation':  'svg:saturation',
            'color':       'svg:color',
            'luminosity':  'svg:luminosity',
        };
        const _oraToBlend = Object.fromEntries(Object.entries(_blendToOra).map(([k,v])=>[v,k]));

        /* ── SAVE ORA ────────────────────────────────────────────────────── */
        /* Save is invoked from inline onclick handlers that neither await nor
         * catch the promise, so anything thrown in here used to vanish into an
         * unhandled rejection — the user just saw nothing happen. Wrap the whole
         * thing so a failure is always reported. */
        app.saveAsORA = async function () {
            try {
                return await _saveAsORAInner.call(this);
            } catch (e) {
                console.error('[ORA] save failed', e);
                if (window.showToast) {
                    showToast('Could not save the .ora file: ' +
                        ((e && e.message) || 'unknown error'), 'error');
                }
                throw e;
            }
        };

        async function _saveAsORAInner() {
            const w = this.config.width, h = this.config.height;
            const layers = mgr.active && mgr.layers.length ? mgr.layers : null;
            const enc    = new TextEncoder();

            /* If no layer system or single layer, treat base canvas as sole layer */
            const allLayers = (layers
                ? [...mgr.layers]           /* bottom-first already */
                : [{ id: 1, name: 'Background', canvas: this.ui.cMain, visible: true,
                     opacity: 1.0, blendMode: 'source-over', locked: false,
                     alphaLock: false, isBase: true, alpha: false }])
                .filter(Boolean);
            // A folder has no pixels of its own, but it still has to be written
            // out — as a <stack> — or the structure is lost.
            if (!allLayers.some(l => l.canvas && !l.isGroup)) throw new Error('nothing to save');

            /* Folders become nested <stack> elements, which is exactly what
             * OpenRaster is for. Everything used to be flattened into one list,
             * so every group you made was silently dropped on save. */
            const oraKids = new Map();
            const oraRoots = [];
            {
                const known = new Set(allLayers.map(l => l.id));
                for (const l of allLayers) {
                    if (l.parentId != null && known.has(l.parentId)) {
                        if (!oraKids.has(l.parentId)) oraKids.set(l.parentId, []);
                        oraKids.get(l.parentId).push(l);
                    } else oraRoots.push(l);
                }
            }
            /* The order the loader will rebuild the flat array in: bottom-first,
             * each folder immediately followed by its contents. Saving the
             * active layer as an index into this keeps the selection correct. */
            const _oraFlatten = (list) => {
                const out = [];
                for (const l of list) {
                    out.push(l);
                    if (l.isGroup) out.push(..._oraFlatten(oraKids.get(l.id) || []));
                }
                return out;
            };
            const flatOrder = _oraFlatten(oraRoots);

            const entries = [];

            /* 1. mimetype — MUST be first, MUST be stored (no compression) */
            entries.push({ name: 'mimetype', data: enc.encode('image/openraster'), store: true });

            /* 2. Layer PNGs + stack elements */
            const esc = s => String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;')
                .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            let layerIdx = 0, maskIdx = 0;

            /* Attributes every node carries, folders included. Writing the mask
             * PNG is folded in here so a folder's mask travels too. */
            const _oraAttrs = async (l) => {
                const blend   = _blendToOra[l.blendMode || 'source-over'] || 'svg:src-over';
                const visible = l.visible !== false ? 'visible' : 'hidden';
                const opacity = typeof l.opacity === 'number' ? l.opacity.toFixed(4) : '1.0000';
                let mask = '';
                if (l.mask && l.mask.canvas) {
                    // A layer mask rides along as its own PNG. Readers that
                    // don't know about paint:mask simply ignore the extra file.
                    const mname = `data/mask_${maskIdx++}.png`;
                    entries.push({
                        name: mname,
                        data: await _canvasToPngBytes(l.mask.canvas),
                        store: false
                    });
                    mask = ` paint:mask="${mname}"` +
                           (l.mask.enabled === false ? ' paint:maskDisabled="true"' : '');
                }
                return `opacity="${opacity}" visibility="${visible}" composite-op="${blend}"` +
                       (l.locked    ? ' paint:locked="true"'    : '') +
                       (l.alphaLock ? ' paint:alphaLock="true"' : '') +
                       (l.isBase    ? ' paint:isBase="true"'    : '') +
                       (l.clipped   ? ' paint:clipped="true"'   : '') +
                       (l.alpha === false ? ' paint:opaque="true"' : '') +
                       mask;
            };

            /* ORA lists siblings top-to-bottom; our arrays are bottom-to-top. */
            const _oraEmit = async (list, indent) => {
                const out = [];
                for (const l of list.slice().reverse()) {
                    const attrs = await _oraAttrs(l);
                    if (l.isGroup) {
                        const inner = await _oraEmit(oraKids.get(l.id) || [], indent + '    ');
                        const pass  = l.blendMode === 'pass-through';
                        out.push(
                            `${indent}<stack name="${esc(l.name || 'Group')}" x="0" y="0" ${attrs}` +
                            ` isolation="${pass ? 'auto' : 'isolate'}"` +
                            (pass ? ' paint:passThrough="true"' : '') + '>',
                            ...inner,
                            `${indent}</stack>`
                        );
                    } else {
                        if (!l.canvas) continue;
                        const fname = `data/layer_${layerIdx++}.png`;
                        entries.push({
                            name: fname,
                            data: await _canvasToPngBytes(l.canvas),
                            store: false
                        });
                        out.push(
                            `${indent}<layer name="${esc(l.name || 'Layer')}" ` +
                            `src="${fname}" x="0" y="0" ${attrs}/>`
                        );
                    }
                }
                return out;
            };
            const stackLines = await _oraEmit(oraRoots, '        ');

            /* 3. stack.xml */
            const activeLayer = mgr.active
                ? Math.max(0, flatOrder.indexOf(mgr.layers[mgr.activeIdx]))
                : 0;
            const xml = [
                '<?xml version="1.0" encoding="UTF-8"?>',
                `<image version="0.0.3" w="${w}" h="${h}" xres="96" yres="96" paint:activeLayer="${activeLayer}">`,
                '    <stack>',
                ...stackLines,
                '    </stack>',
                '</image>',
            ].join('\n');
            entries.push({ name: 'stack.xml', data: enc.encode(xml), store: false });

            /* 4. mergedimage.png (full-res composite, required by spec) */
            const mergeCanvas = document.createElement('canvas');
            mergeCanvas.width = w; mergeCanvas.height = h;
            const mctx = mergeCanvas.getContext('2d');
            // Go through the real compositor rather than re-adding the layers by
            // hand: the hand-rolled loop here ignored masks, clipping and groups,
            // so the preview stored in the file disagreed with the picture.
            const mergedSrc = (layers && _composite()) || this.ui.cMain;
            mctx.drawImage(mergedSrc, 0, 0);
            entries.push({ name: 'mergedimage.png', data: await _canvasToPngBytes(mergeCanvas), store: false });

            /* 5. Thumbnails/thumbnail.png (≤256 px, required by spec) */
            const scale  = Math.min(1, 256 / Math.max(w, h));
            const tw = Math.max(1, Math.round(w * scale));
            const th = Math.max(1, Math.round(h * scale));
            const tCanvas = document.createElement('canvas');
            tCanvas.width = tw; tCanvas.height = th;
            tCanvas.getContext('2d').drawImage(mergeCanvas, 0, 0, tw, th);
            entries.push({ name: 'Thumbnails/thumbnail.png', data: await _canvasToPngBytes(tCanvas), store: false });

            /* Build the ZIP and write it through the normal save dialog. */
            const zipBytes = await _oraZip.build(entries);
            const blob = new Blob([zipBytes], { type: 'image/openraster' });
            const baseName = (this.state.fileName || 'untitled').replace(/\.[^/.]+$/, '');
            const fname = baseName + '.ora';
            const saved = await _saveBlobAs(
                blob, fname, 'OpenRaster Image', { 'image/openraster': ['.ora'] }
            );
            if (!saved) return;                       // cancelled — leave it dirty
            this.markSaved(typeof saved === 'string' ? saved.split(/[\\/]/).pop() : fname);
            this.resetSaveReminderTimer();
            if (window.showToast) showToast('Saved ' + fname, 'success');
        };

        /* ── LOAD ORA ────────────────────────────────────────────────────── */
        app.loadORAFile = async function (file) {
            if (app.hasUnsavedChanges()) {
                const f = file;
                app.showOpenConfirm(() => app.loadORAFile(f), 'Opening a new file');
                return;
            }
            try {
                const zipBytes = new Uint8Array(await file.arrayBuffer());
                const files    = _parseZip(zipBytes);

                /* Parse stack.xml (handle deferred deflation when pako absent) */
                let xmlBytes = files['stack.xml'];
                if (!xmlBytes && files['__deflated__stack.xml'] && typeof DecompressionStream !== 'undefined') {
                    for (const fmt of ['deflate-raw', 'deflate']) {
                        try {
                            const raw = files['__deflated__stack.xml'].slice();
                            const ds = new DecompressionStream(fmt);
                            const readDone = new Response(ds.readable).arrayBuffer();
                            const writer = ds.writable.getWriter();
                            await writer.write(raw);
                            await writer.close();
                            xmlBytes = new Uint8Array(await readDone);
                            break;
                        } catch (e) {
                            console.warn('[ORA] deflate format', fmt, 'failed:', e.message);
                        }
                    }
                }
                if (!xmlBytes) throw new Error('stack.xml missing from ORA');
                const xmlStr  = new TextDecoder().decode(xmlBytes);
                const parser  = new DOMParser();
                const cleanXml = xmlStr.replace(/paint:/g, '');
                const doc     = parser.parseFromString(cleanXml, 'text/xml');
                const imageEl = doc.querySelector('image');
                if (!imageEl) throw new Error('Invalid stack.xml: no <image> element');

                const fileW = parseInt(imageEl.getAttribute('w') || '0', 10);
                const fileH = parseInt(imageEl.getAttribute('h') || '0', 10);
                if (!fileW || !fileH) throw new Error('ORA has invalid canvas dimensions');

                const stack = imageEl.querySelector('stack');
                if (!stack) throw new Error('ORA contains no layers');

                const activeIdxAttr = parseInt(imageEl.getAttribute('activeLayer') || '0', 10);

                /* Load all layer PNGs */
                /* Decode one PNG entry out of the archive into a canvas.
                 * Shared by layer images and their masks. */
                const _decodeEntry = async (src) => {
                    if (!src) return null;
                    let pngBytes = files[src] || files[src.replace(/^\//, '')];
                    /* If deflated and no pako, inflate via DecompressionStream */
                    if (!pngBytes) {
                        const deflated = files['__deflated__' + (src || src.replace(/^\//, ''))];
                        if (deflated && typeof DecompressionStream !== 'undefined') {
                            for (const fmt of ['deflate-raw', 'deflate']) {
                                try {
                                    const raw = deflated.slice();
                                    const ds = new DecompressionStream(fmt);
                                    const readDone = new Response(ds.readable).arrayBuffer();
                                    const writer = ds.writable.getWriter();
                                    await writer.write(raw);
                                    await writer.close();
                                    pngBytes = new Uint8Array(await readDone);
                                    break;
                                } catch (e) {
                                    /* try next format */
                                }
                            }
                        }
                    }
                    if (!pngBytes) { console.warn('[ORA] missing entry:', src); return null; }
                    const blob = new Blob([pngBytes], { type: 'image/png' });
                    const img  = window.createImageBitmap
                        ? await createImageBitmap(blob)
                        : await new Promise(resolve => {
                            const url = URL.createObjectURL(blob);
                            const i = new Image();
                            i.onload = () => { URL.revokeObjectURL(url); resolve(i); };
                            i.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
                            i.src = url;
                          });
                    if (!img) { console.warn('[ORA] failed to decode', src); return null; }
                    const lc = document.createElement('canvas');
                    lc.width = fileW; lc.height = fileH;
                    lc.getContext('2d').drawImage(img, 0, 0);
                    return lc;
                };

                /* Walk the stack depth-first: bottom-first, each folder followed
                 * by its contents, which is the order the layer array uses. A
                 * nested <stack> is a folder — only top-level <layer> tags used
                 * to be read, so anything inside a group was lost on open. */
                const layerDefs = [];
                const _walkStack = async (stackEl, parentIdx) => {
                    const children = Array.from(stackEl.children)
                        .filter(el => el.tagName === 'layer' || el.tagName === 'stack')
                        .reverse();                       /* XML lists top-first */
                    for (const el of children) {
                        const isGroup = el.tagName === 'stack';
                        const lc = isGroup ? null : await _decodeEntry(el.getAttribute('src') || '');
                        if (!isGroup && !lc) continue;
                        const maskCanvas = await _decodeEntry(el.getAttribute('mask') || null);
                        // A folder that does not isolate is our pass-through.
                        const passThrough = isGroup &&
                            (el.getAttribute('passThrough') === 'true' ||
                             el.getAttribute('isolation') === 'auto');
                        layerDefs.push({
                            isGroup,
                            parentIdx,
                            canvas:     lc,
                            maskCanvas: maskCanvas,
                            name:      el.getAttribute('name') || (isGroup ? 'Group' : 'Layer'),
                            opacity:   parseFloat(el.getAttribute('opacity') || '1'),
                            visible:   (el.getAttribute('visibility') || 'visible') !== 'hidden',
                            blendMode: passThrough ? 'pass-through'
                                : (_oraToBlend[el.getAttribute('composite-op') || 'svg:src-over'] || 'source-over'),
                            locked:    el.getAttribute('locked') === 'true',
                            alphaLock: el.getAttribute('alphaLock') === 'true',
                            clipped: el.getAttribute('clipped') === 'true',
                            maskSrc: el.getAttribute('mask') || null,
                            maskDisabled: el.getAttribute('maskDisabled') === 'true',
                            isBase:    el.getAttribute('isBase') === 'true',
                            opaque:    el.getAttribute('opaque') === 'true',
                        });
                        if (isGroup) await _walkStack(el, layerDefs.length - 1);
                    }
                };
                await _walkStack(stack, -1);
                if (!layerDefs.some(d => !d.isGroup)) throw new Error('No usable layers found in ORA');

                /* ── Apply to app ── */
                /* Reset app state */
                this.state.history   = [];
                this.state.step      = -1;
                this.state.fileHandle = null;
                this.state.filePath   = null;
                this.state.fileName   = file.name;
                if (this.state.selection) this.cancelSelection();

                /* Resize canvas */
                this.setSize(fileW, fileH);

                /* Rebuild the stack from scratch. Every layer is an off-screen
                 * canvas now, so the bottom one needs no special handling — it
                 * is built by the same loop as the rest. */
                _collapseToBase({ fresh: true });
                mgr.active = true;
                mgr.activeIdx = 0;
                mgr.layers.length = 0;
                const createdIds = [];
                let baseAssigned = false;
                for (let i = 0; i < layerDefs.length; i++) {
                    const ld  = layerDefs[i];
                    let c, ctx = null;
                    if (ld.isGroup) {
                        c = document.createElement('canvas');   // folders hold no pixels
                    } else {
                        c   = _newCanvas(fileW, fileH);
                        ctx = c.getContext('2d', { willReadFrequently: true });
                        app.disableSmoothing(ctx);
                        ctx.drawImage(ld.canvas, 0, 0);
                    }
                    // The bottom-most real layer is the base; a folder never is,
                    // even when one happens to sit at the bottom of the stack.
                    const isBase = !ld.isGroup && !baseAssigned;
                    if (isBase) baseAssigned = true;
                    const layer = {
                        id: mgr.nextId++, name: ld.name, canvas: c, ctx,
                        visible: ld.visible, opacity: ld.opacity,
                        blendMode: ld.blendMode, locked: ld.locked,
                        alphaLock: ld.alphaLock,
                        isGroup: ld.isGroup, _open: true,
                        isBase, alpha: ld.opaque ? false : (!ld.isGroup && !isBase),
                        clipped: !!ld.clipped, mask: null,
                        // Parents are always written before their contents, so
                        // the real id is known by the time a child needs it.
                        parentId: ld.parentIdx >= 0 ? createdIds[ld.parentIdx] : null,
                        _dirty: true,
                    };
                    createdIds.push(layer.id);
                    if (ld.maskCanvas) {
                        layer.mask = _makeMask(fileW, fileH, false);
                        layer.mask.ctx.drawImage(ld.maskCanvas, 0, 0);
                        layer.mask.enabled = !ld.maskDisabled;
                    }
                    mgr.layers.push(layer);
                }
                if (app.ui.stage) app.ui.stage.classList.add('layers-active');
                _invalidate();

                /* Set active layer */
                const safeActive = Math.min(Math.max(0, activeIdxAttr), mgr.layers.length - 1);
                _setActive(safeActive);

                this.state.hasDocument = true;
                this.saveState();
                this.markSaved(file.name);
                this.updateTitleFilename();
                _refreshList();
                _syncBtns();
                _openPanel(true);
                _schedThumb();
                this.requestGlobalOverlayUpdate();

            } catch (err) {
                showToast('Failed to open ORA file: ' + err.message, 'error');
                console.error('[ORA] load failed, about to show toast:', err);
                console.error('[ORA load]', err);
            }
        };

        /* ── ZIP parser (central-directory walk) ─────────────────────────── */
        function _parseZip(bytes) {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const dec  = new TextDecoder();
            const files = {};

            /* Find EOCD */
            let eocdOff = -1;
            for (let i = bytes.length - 22; i >= 0; i--) {
                if (view.getUint32(i, false) === 0x504B0506) { eocdOff = i; break; }
            }
            if (eocdOff < 0) throw new Error('Not a valid ZIP file');

            const cdOffset = view.getUint32(eocdOff + 16, true);
            const cdCount  = view.getUint16(eocdOff + 8,  true);

            let cdPos = cdOffset;
            for (let n = 0; n < cdCount; n++) {
                if (view.getUint32(cdPos, false) !== 0x504B0102) break;
                const method    = view.getUint16(cdPos + 10, true);
                const compSize  = view.getUint32(cdPos + 20, true);
                const uncompSize= view.getUint32(cdPos + 24, true);
                const nameLen   = view.getUint16(cdPos + 28, true);
                const extraLen  = view.getUint16(cdPos + 30, true);
                const commentLen= view.getUint16(cdPos + 32, true);
                const localHdrOff = view.getUint32(cdPos + 42, true);
                const name = dec.decode(bytes.subarray(cdPos + 46, cdPos + 46 + nameLen));

                /* Locate actual data via local header */
                const lhNameLen  = view.getUint16(localHdrOff + 26, true);
                const lhExtraLen = view.getUint16(localHdrOff + 28, true);
                const dataStart  = localHdrOff + 30 + lhNameLen + lhExtraLen;
                const compData   = bytes.subarray(dataStart, dataStart + compSize);

                if (method === 0) {
                    files[name] = compData.slice();
                } else if (method === 8) {
                    /* inflate via DecompressionStream */
                    files[name] = compData; /* resolved async below */
                    files['__method__' + name] = 8;
                    files['__uncomp__' + name] = uncompSize;
                }

                cdPos += 46 + nameLen + extraLen + commentLen;
            }

            /* Inflate deflated entries synchronously via pako if available,
               otherwise queue them — caller uses async createImageBitmap anyway */
            for (const name of Object.keys(files)) {
                if (name.startsWith('__')) continue;
                if (files['__method__' + name] === 8) {
                    const raw = files[name];
                    if (window.pako && pako.inflateRaw) {
                        try { files[name] = pako.inflateRaw(raw); continue; } catch (_) {}
                    }
                    /* Mark for async inflate — loadORAFile handles via DecompressionStream */
                    files['__deflated__' + name] = raw;
                    delete files[name];
                }
            }
            return files;
        }

        /* ──────────────────────────────────────────────────────────────────
         * 16. EVENT WIRING
         * ────────────────────────────────────────────────────────────────── */
        const lsysXbtn = document.getElementById('lsys-xbtn');
        if (lsysXbtn) lsysXbtn.addEventListener('click', () => _openPanel(false));
        const lsysAdd = document.getElementById('lsys-add');
        if (lsysAdd) lsysAdd.addEventListener('click', () => { _addLayer(); app.saveState(); _schedThumb(); });
        const lsysUp = document.getElementById('lsys-up');
        if (lsysUp) lsysUp.addEventListener('click', () => _moveLayerUp());
        const lsysDown = document.getElementById('lsys-down');
        if (lsysDown) lsysDown.addEventListener('click', () => _moveLayerDown());
        const lsysDel = document.getElementById('lsys-del');
        if (lsysDel) lsysDel.addEventListener('click', () => _delLayer());
        const lsysMerge = document.getElementById('lsys-merge');
        if (lsysMerge) lsysMerge.addEventListener('click', () => _mergeDown());
        const lsysGroup = document.getElementById('lsys-group');
        if (lsysGroup) lsysGroup.addEventListener('click', () => _makeGroup());

        const lsysClip = document.getElementById('lsys-clip');
        if (lsysClip) lsysClip.addEventListener('click', () => {
            const l = mgr.layers[mgr.activeIdx];
            if (!l || !_canClip(mgr.activeIdx)) return;
            l.clipped = !l.clipped;
            _refreshList(); _syncBtns(); _invalidate();
            app.saveState();
        });

        const lsysMask = document.getElementById('lsys-mask');
        if (lsysMask) lsysMask.addEventListener('click', () => {
            const l = mgr.layers[mgr.activeIdx];
            if (!l || l.isGroup) return;
            if (!l.mask) {
                _addMask(l);
                _setMaskEditing(l, true);
                app.saveState();
            } else {
                // Second click toggles between painting the mask and the layer.
                _setMaskEditing(l, !_isMaskEditing(l));
            }
            _refreshList(); _syncBtns(); _invalidate();
        });

        const lsysFlatten = document.getElementById('lsys-flatten');
        if (lsysFlatten) lsysFlatten.addEventListener('click', () => _flattenImage());

        const lsysExport = document.getElementById('lsys-export');
        if (lsysExport) lsysExport.addEventListener('click', () => {
            Promise.resolve(app.exportFlattenedPng()).catch(err => {
                console.warn('[Layers] flattened export failed', err);
                if (window.showToast) showToast('Could not export the flattened PNG.', 'error');
            });
        });

        const _opSl = document.getElementById('lsys-op');
        if (_opSl) {
            _opSl.addEventListener('input',  () => _setOpacity(parseInt(_opSl.value, 10)));
            // One history step per slider release. 'input' fires continuously
            // while dragging, so recording there would bury the history; 'change'
            // fires once, when the slider is let go. There must be exactly ONE
            // of these — a second listener pushes two entries per release, and
            // then a single undo only takes the opacity half way back.
            _opSl.addEventListener('change', () => { if (mgr.active) app.saveState(); });
        }

        _syncBtns();
        // Ready — panel stays fully hidden until the hover zone is touched.

    })(PaintApp);
})();
