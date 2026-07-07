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

        /* ──────────────────────────────────────────────────────────────────
         * 2.  ctx REDIRECT
         *     Converts app.ctx into a getter/setter.
         *     When single-layer mode (mgr.active===false), returns the original
         *     context — zero runtime overhead, zero behaviour change.
         * ────────────────────────────────────────────────────────────────── */
        try {
            Object.defineProperty(app, 'ctx', {
                get() {
                    if (!mgr.active || !mgr.layers.length) return _holder.ctx;
                    const l = mgr.layers[mgr.activeIdx];
                    // Return a no-op proxy context for locked layers to prevent drawing.
                    // The proxy is cached on the layer object to avoid per-frame allocation.
                    if (l && l.locked) return _lockedCtxProxy(l);
                    return l ? l.ctx : _holder.ctx;
                },
                set(v) { _holder.ctx = v; },
                configurable: true,
                enumerable:   true
            });
        } catch (e) {
            console.warn('[LayerSystem] ctx redirect unavailable:', e);
        }

        // Minimal proxy that swallows draw calls on locked layers.
        // _WRITE_METHODS is hoisted outside the handler so it is only allocated once,
        // not on every property access during drawing.
        const _WRITE_METHODS = new Set([
            'fillRect','clearRect','strokeRect','fillText','strokeText',
            'drawImage','putImageData','fill','stroke','beginPath',
            'moveTo','lineTo','arc','arcTo','rect','save','restore',
            'scale','rotate','translate','transform','setTransform',
            'resetTransform','clip','drawFocusIfNeeded','scrollPathIntoView',
            'createLinearGradient','createRadialGradient','createPattern',
        ]);
        const _noopHandler = {
            get(target, prop) {
                const val = target[prop];
                if (typeof val === 'function') {
                    // Pass through reads (getImageData, etc.) but silence writes
                    if (_WRITE_METHODS.has(prop)) return () => {};
                    return val.bind(target);
                }
                return val;
            },
            set(target, prop, value) { target[prop] = value; return true; }
        };
        // Cache the proxy on the layer object so a new Proxy is not allocated on
        // every app.ctx access during a drawing stroke.
        function _lockedCtxProxy(layer) {
            if (!layer.ctx) return layer.ctx;
            if (!layer._lockedProxy) layer._lockedProxy = new Proxy(layer.ctx, _noopHandler);
            return layer._lockedProxy;
        }

        /* ──────────────────────────────────────────────────────────────────
         * 3.  CSS  (injected once, uses existing CSS tokens)
         * ────────────────────────────────────────────────────────────────── */
        const _css = document.createElement('style');
        _css.textContent = `
/* ── LAYER SYSTEM ──────────────────────────────────────── */
#canvas-stage.layers-active {
    background: repeating-conic-gradient(#b0b0b0 0% 25%, #e8e8e8 0% 50%) 0 0 / 16px 16px;
}
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
            '<div class="lsctx-item" id="lsctx-dup">Duplicate</div>' +
            '<div class="lsctx-item" id="lsctx-del">Delete</div>';
        document.body.appendChild(_ctxMenu);
        let _ctxTargetIdx = -1;

        function _openCtx(e, idx) {
            e.preventDefault();
            _ctxTargetIdx = idx;
            const l = mgr.layers[idx];
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
            _ctxMenu.style.left = Math.min(e.clientX, window.innerWidth - 190) + 'px';
            _ctxMenu.style.top  = Math.min(e.clientY, window.innerHeight - 160) + 'px';
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
            // Invalidate cached proxy so unlocking takes effect immediately.
            if (!l.locked) l._lockedProxy = null;
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
        // _hexToRgb removed — use app.hexToRgb (they are identical; no need to duplicate).

        function _newCanvas(w, h) {
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            c.style.cssText =
                'position:absolute;left:0;top:0;pointer-events:none;';
            return c;
        }

        function _insertBeforeTemp(c) {
            const stage = app.ui && app.ui.stage;
            const ctemp = app.ui && app.ui.cTemp;
            if (stage && ctemp && ctemp.parentNode === stage) stage.insertBefore(c, ctemp);
            else if (stage) stage.appendChild(c);
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
            ctx.clearRect(0, 0, w, h);
            for (const l of mgr.layers) {
                if (!l.visible) continue;
                ctx.save();
                ctx.globalAlpha = l.opacity;
                ctx.globalCompositeOperation = l.blendMode || 'source-over';
                ctx.drawImage(l.canvas, 0, 0);
                ctx.restore();
            }
            return mgr._compositeCanvas;
        }
        mgr.getCompositeCanvas = function() { return _composite(); };

        /* Strip C2 (background colour) pixels from a canvas — makes them transparent.
         * Used when stamping a floating selection onto a transparent layer so we don't
         * paint solid background squares onto layers that support true alpha. */
        function _stripC2(srcCanvas, c2hex) {
            const c2 = app.hexToRgb(c2hex);
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
            mgr.active = true;
            mgr.layers.push({
                id:      1,
                name:    'Background',
                canvas:  app.ui.cMain,
                ctx:     _holder.ctx,
                visible: true,
                opacity: 1.0,
                isBase:  true,
                locked:  false,
                alpha:   false,
            });
            // cTemp must remain visually on top of any layer canvases we insert.
            if (app.ui.cTemp) app.ui.cTemp.style.zIndex = '200';
            // Switch stage to checkered pattern so transparent areas are visible.
            if (app.ui.stage) app.ui.stage.classList.add('layers-active');
            _refreshList();
            _syncBtns();
        }

        function _addLayer() {
            if (!mgr.active) _activate();
            const w = app.config.width, h = app.config.height;
            const id = mgr.nextId++;
            const c = _newCanvas(w, h);
            c.style.zIndex = String(10 + mgr.layers.length);
            const ctx = c.getContext('2d', { willReadFrequently: true });
            app.disableSmoothing(ctx);
            // Canvas is transparent by default — no fill needed (rgba 0,0,0,0)
            _insertBeforeTemp(c);
            mgr.layers.push({
                id, name: 'Layer ' + id, canvas: c, ctx,
                visible: true, opacity: 1.0, isBase: false,
                locked: false, alpha: true,
            });
            _setActive(mgr.layers.length - 1);
            _refreshList();
        }

        function _dupLayer() {
            if (!mgr.active || !mgr.layers.length) return;
            const src = mgr.layers[mgr.activeIdx];
            const w = app.config.width, h = app.config.height;
            const id = mgr.nextId++;
            const c = _newCanvas(w, h);
            c.style.zIndex = String(10 + mgr.layers.length);
            const ctx = c.getContext('2d', { willReadFrequently: true });
            app.disableSmoothing(ctx);
            ctx.drawImage(src.canvas, 0, 0);
            _insertBeforeTemp(c);
            const layer = {
                id, name: src.name + ' copy', canvas: c, ctx,
                visible: true, opacity: src.opacity, isBase: false,
                locked: false, alpha: src.alpha !== false,
            };
            mgr.layers.splice(mgr.activeIdx + 1, 0, layer);
            _setActive(mgr.activeIdx + 1);
            _refreshList();
        }

        function _delLayer() {
            if (!mgr.active || mgr.layers.length <= 1) return;
            const l = mgr.layers[mgr.activeIdx];
            if (l.isBase) {
                // Clear the base canvas so it becomes transparent and the checkerboard shows through.
                l.ctx.clearRect(0, 0, app.config.width, app.config.height);
            } else if (l.canvas.parentNode) {
                l.canvas.parentNode.removeChild(l.canvas);
            }
            mgr.layers.splice(mgr.activeIdx, 1);
            _setActive(Math.min(mgr.activeIdx, mgr.layers.length - 1));
            _refreshList();
            app.saveState();
        }

        function _mergeDown() {
            if (!mgr.active || mgr.activeIdx <= 0) return;
            const above = mgr.layers[mgr.activeIdx];
            const below = mgr.layers[mgr.activeIdx - 1];
            below.ctx.save();
            below.ctx.globalAlpha = above.opacity;
            // Apply the upper layer's blend mode so Multiply/Screen/etc. merge correctly.
            below.ctx.globalCompositeOperation = above.blendMode || 'source-over';
            below.ctx.drawImage(above.canvas, 0, 0);
            below.ctx.restore();
            if (!above.isBase && above.canvas.parentNode)
                above.canvas.parentNode.removeChild(above.canvas);
            mgr.layers.splice(mgr.activeIdx, 1);
            _setActive(mgr.activeIdx - 1);
            _refreshList();
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
                canvas: null, // groups have no real canvas; null avoids a leaked allocation
                ctx: null,
            };
            mgr.layers.splice(idx, 0, grpLayer);
            _setActive(idx + 1);
            _refreshList();
            app.saveState();
        }

        // Eye SVG paths reused for targeted DOM updates without a full list rebuild.
        const _eyeOpenSVG =
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none">' +
            '<ellipse cx="12" cy="12" rx="9" ry="6" stroke="currentColor" stroke-width="1.8"/>' +
            '<circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg>';
        const _eyeClosedSVG =
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none">' +
            '<path d="M3 3l18 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
            '<path d="M10.5 10.6A3 3 0 0 0 13.4 13.5M6.3 6.4C4.5 7.7 3 9.7 3 12c0 1.5 2 4 5 5.5' +
            'M17.7 17.7C19.5 16.3 21 14.3 21 12c0-1.5-2-4-5-5.5" stroke="currentColor" ' +
            'stroke-width="1.8" stroke-linecap="round"/></svg>';

        function _toggleVis(idx) {
            if (idx < 0 || idx >= mgr.layers.length) return;
            const l = mgr.layers[idx];
            l.visible = !l.visible;
            if (l.canvas) l.canvas.style.display = l.visible ? '' : 'none';

            // Targeted update: swap just the eye icon, avoiding a full DOM rebuild.
            const list = document.getElementById('lsys-list');
            if (list) {
                const visEl = list.querySelector(`.lsi-vis[data-vi="${idx}"]`);
                if (visEl) {
                    visEl.classList.toggle('vis-off', !l.visible);
                    visEl.title = l.visible ? 'Hide layer' : 'Show layer';
                    visEl.innerHTML = l.visible ? _eyeOpenSVG : _eyeClosedSVG;
                }
            }
        }

        function _setOpacity(pct) {
            if (!mgr.active || !mgr.layers.length) return;
            const l = mgr.layers[mgr.activeIdx];
            l.opacity = Math.max(0, Math.min(1, pct / 100));
            l.canvas.style.opacity = l.opacity;
            _syncOpacity();
        }

        /* Called by setSize patch — resize non-base layer canvases.
         * Note: canvas resize CLEARS content.  This matches the existing behaviour
         * of setSize() on cMain (the base layer). */
        function _resizeLayers(w, h) {
            if (!mgr.active) return;
            for (const l of mgr.layers) {
                if (l.isBase || l.isGroup || !l.canvas) continue;
                l.canvas.width  = w;
                l.canvas.height = h;
                app.disableSmoothing(l.ctx);
            }
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

            // Render top-layer-first
            for (let i = mgr.layers.length - 1; i >= 0; i--) {
                const l = mgr.layers[i];

                if (l.isGroup) {
                    // ── Group header ────────────────────────────────────────
                    const grp = document.createElement('div');
                    grp.className = 'lsi-group';
                    grp.dataset.gi = i;
                    const sel = i === mgr.activeIdx ? ' sel' : '';
                    grp.innerHTML =
                        '<div class="lsi-group-hdr' + sel + '" data-gi="' + i + '">' +
                        '<span class="lsi-vis" data-vi="' + i + '" title="' + (l.visible ? 'Hide' : 'Show') + '">' +
                        '<svg width="15" height="15" viewBox="0 0 16 16" fill="none">' + (l.visible ? eyeOpenPath : eyeClosedPath) + '</svg></span>' +
                        '<span class="lsi-group-arrow' + (l._open !== false ? ' open' : '') + '">▶</span>' +
                        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="flex-shrink:0"><rect x="1" y="4" width="14" height="9" rx="1.5" stroke="#0078d7" stroke-width="1.5" fill="none"/><rect x="3" y="2" width="5" height="3" rx="1" fill="#0078d7" opacity=".6"/></svg>' +
                        '<span style="flex:1;font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + app.escapeHtml(l.name) + '</span>' +
                        '</div>' +
                        '<div class="lsi-group-children"' + (l._open === false ? ' style="display:none"' : '') + '></div>';
                    list.appendChild(grp);
                    const hdr = grp.querySelector('.lsi-group-hdr');
                    hdr.addEventListener('click', e => {
                        if (e.target.closest('.lsi-vis') || e.target.closest('.lsi-group-arrow')) return;
                        _setActive(parseInt(hdr.dataset.gi, 10));
                    });
                    grp.querySelector('.lsi-vis').addEventListener('click', e => { e.stopPropagation(); _toggleVis(i); });
                    grp.querySelector('.lsi-group-arrow').addEventListener('click', e => {
                        e.stopPropagation();
                        // Bug fix: was `l._open === false` which could never set _open back to true.
                        l._open = !l._open;
                        _refreshList();
                    });
                    hdr.addEventListener('contextmenu', e => { _setActive(i); _openCtx(e, i); });
                    continue;
                }

                // ── Regular layer row ─────────────────────────────────────
                const item = document.createElement('div');
                item.className = 'lsi' + (i === mgr.activeIdx ? ' lssel' : '');
                item.dataset.li = i;
                item.draggable = true;

                const visClass = l.visible ? '' : ' vis-off';
                const lockClass = l.locked ? ' locked' : '';
                const alphaBadge = (!l.isBase && l.alpha !== false)
                    ? '<span class="lsi-alpha-badge" title="Alpha channel">α</span>' : '';

                item.innerHTML =
                    // Left icon column: eye + lock side by side
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
                    // Thumbnail
                    '<div class="lsi-thumb-wrap"><canvas class="lsi-thumb" id="lsit-' + l.id + '" width="42" height="40"></canvas></div>' +
                    // Name + blend mode row (right side)
                    '<div style="flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:2px;padding-right:4px;">' +
                      '<span class="lsi-name" title="' + app.escapeHtml(l.name) + '">' + app.escapeHtml(l.name) + alphaBadge + (l.alphaLock ? ' <span style="font-size:9px;color:#0078d7;background:rgba(0,120,215,.1);padding:0 3px;border-radius:2px;font-weight:600;">αðŸ”’</span>' : '') + '</span>' +
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

                list.appendChild(item);

                item.addEventListener('click', e => {
                    if (e.target.closest('.lsi-icons')) return;
                    if (e.target.classList.contains('lsi-rename-input')) return;
                    if (e.target.closest('.lsi-name')) return; // let dblclick handle name clicks
                    _setActive(parseInt(item.dataset.li, 10));
                });
                item.addEventListener('contextmenu', e => {
                    _setActive(parseInt(item.dataset.li, 10));
                    _openCtx(e, parseInt(item.dataset.li, 10));
                });
                // Double-click name to rename
                const nameSpan = item.querySelector('.lsi-name');
                if (nameSpan) {
                    nameSpan.addEventListener('click', e => {
                        // single click on name still selects the layer
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
                    const tgt = mgr.layers[idx];
                    tgt.locked = !tgt.locked;
                    // Invalidate cached proxy so unlocking takes effect immediately.
                    if (!tgt.locked) tgt._lockedProxy = null;
                    _refreshList(); _syncBtns();
                });

                // Blend mode
                item.querySelector('.lsi-blend').addEventListener('change', e => {
                    e.stopPropagation();
                    const idx = parseInt(e.currentTarget.dataset.bi, 10);
                    mgr.layers[idx].blendMode = e.currentTarget.value;
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
                    e.preventDefault();
                    item.classList.remove('lsi-dragover');
                    const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
                    const toIdx   = parseInt(item.dataset.li, 10);
                    if (fromIdx === toIdx || isNaN(fromIdx) || isNaN(toIdx)) return;
                    const moved = mgr.layers.splice(fromIdx, 1)[0];
                    const dest  = fromIdx < toIdx ? toIdx - 1 : toIdx;
                    mgr.layers.splice(dest, 0, moved);
                    _rebuildZOrder();
                    _setActive(dest);
                    _refreshList(); // Bug fix: panel was not updated after drag-and-drop
                    app.saveState();
                });
            }
            _schedThumb();
        }

        function _rebuildZOrder() {
            for (let i = 0; i < mgr.layers.length; i++) {
                const l = mgr.layers[i];
                if (!l.isBase && l.canvas) l.canvas.style.zIndex = String(10 + i);
            }
        }

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
            // Truncate forward history, releasing bitmaps.
            if (this.state.step < this.state.history.length - 1) {
                const dropped = this.state.history.splice(this.state.step + 1);
                for (const e of dropped) this._closeBitmapEntry(e);
            }

            // Mark the active layer dirty — it was just drawn on.
            if (mgr.layers[mgr.activeIdx]) mgr.layers[mgr.activeIdx]._dirty = true;

            // Find the previous _lsys entry to reference unchanged layers from.
            const prevEntry = (this.state.step >= 0)
                ? this.state.history[this.state.step]
                : null;
            const prevSnaps = (prevEntry && prevEntry._lsys) ? prevEntry.snaps : null;
            // Index previous snaps by layer ID rather than array position so that
            // layer reorders (drag-and-drop, move up/down) don't corrupt references.
            const prevSnapById = prevSnaps
                ? Object.fromEntries(prevSnaps.map(s => [s.id, s]))
                : null;

            // Snapshot only dirty layers; reference the previous snap for clean ones.
            const snaps = mgr.layers.map((l) => {
                const prevSnap = prevSnapById && prevSnapById[l.id];
                if (!l._dirty && prevSnap) {
                    // Layer unchanged — share the previous entry's snap by reference.
                    return { id: l.id, name: l.name, visible: l.visible, opacity: l.opacity,
                             isBase: l.isBase, snap: null, bitmap: null, ref: prevSnap };
                }
                // Dirty — clone the canvas now (always safe / synchronous fallback).
                const snap = document.createElement('canvas');
                snap.width  = l.canvas.width;
                snap.height = l.canvas.height;
                snap.getContext('2d').drawImage(l.canvas, 0, 0);
                return { id: l.id, name: l.name, visible: l.visible, opacity: l.opacity,
                         isBase: l.isBase, snap, bitmap: null, ref: null };
            });

            // Clear dirty flags now that we've snapshotted.
            for (const l of mgr.layers) l._dirty = false;

            const entry = {
                _lsys: true, snaps,
                // activeIdx intentionally omitted — layer selection is a
                // navigation action, not a document edit. Krita, CSP and
                // modern Photoshop all keep it outside the undo/redo stack.
                width:  this.config.width,
                height: this.config.height
            };
            this.state.history.push(entry);
            this.state.step++;
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
                            snaps[r.i].snap   = null;
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
        const _origRestoreEntry = app.restoreHistoryEntry.bind(app);
        app.restoreHistoryEntry = function (entry) {
            if (!entry._lsys) {
                // Undo/redo crossed the layer-activation boundary — collapse.
                if (mgr.active && mgr.layers.length > 1) {
                    for (let i = mgr.layers.length - 1; i >= 1; i--) {
                        const l = mgr.layers[i];
                        if (l.canvas.parentNode) l.canvas.parentNode.removeChild(l.canvas);
                    }
                    mgr.layers.length = 1;
                    mgr.activeIdx = 0;
                    mgr.active = false;
                    if (app.ui.cTemp) app.ui.cTemp.style.zIndex = '';
                    if (app.ui.stage) app.ui.stage.classList.remove('layers-active');
                    _refreshList();
                    _syncBtns();
                }
                _origRestoreEntry(entry);
                // Re-sync the holder after setSize may have re-created the context.
                _holder.ctx = app.ui.cMain.getContext('2d', { willReadFrequently: true });
                app.disableSmoothing(_holder.ctx);
                return;
            }
            // ── Multi-layer restore ─────────────────────────────────────
            const { snaps, width, height } = entry;
            // Remove surplus layers.
            while (mgr.layers.length > snaps.length) {
                const l = mgr.layers.pop();
                if (!l.isBase && l.canvas.parentNode)
                    l.canvas.parentNode.removeChild(l.canvas);
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
                if (i === 0) this.setSize(width, height); // resizes cMain + cTemp
                if (i < mgr.layers.length) {
                    const l = mgr.layers[i];
                    if (!l.isBase) { l.canvas.width = width; l.canvas.height = height; }
                    app.disableSmoothing(l.ctx);
                    l.ctx.clearRect(0, 0, width, height);
                    l.ctx.drawImage(src, 0, 0);
                    l.name = sv.name; l.visible = sv.visible; l.opacity = sv.opacity;
                    l.canvas.style.display = l.visible ? '' : 'none';
                    if (!l.isBase) l.canvas.style.opacity = l.opacity;
                    // Layer restored — clear dirty flag so next save can ref it.
                    l._dirty = false;
                } else {
                    const c = _newCanvas(width, height);
                    c.style.zIndex   = String(10 + i);
                    c.style.display  = sv.visible ? '' : 'none';
                    c.style.opacity  = sv.opacity;
                    const ctx = c.getContext('2d', { willReadFrequently: true });
                    app.disableSmoothing(ctx);
                    ctx.drawImage(src, 0, 0);
                    _insertBeforeTemp(c);
                    mgr.layers.push({
                        id: sv.id, name: sv.name,
                        canvas: c, ctx,
                        visible: sv.visible, opacity: sv.opacity,
                        isBase: false, _dirty: false
                    });
                }
            }
            mgr.active    = true;
            // Do NOT restore activeIdx — layer selection is a navigation
            // action, not a content edit.  Clamp it against the current
            // array size so undo/redo can never push it out of bounds.
            mgr.activeIdx = Math.min(mgr.activeIdx, Math.max(0, mgr.layers.length - 1));
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
                const ctx = mgr.layers[layerIdx].ctx;
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
            if (!isPreview && activeLayer && activeLayer.alphaLock) {
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
            if (!onTransLayer && !onBaseLayerActive) { _origFlushStrokes(); _schedThumb(); return; }
            if (onBaseLayerActive) {
                // Base layer: route eraser strokes through destination-out, normals unchanged
                const q = this.strokeQueue;
                this.strokeQueue = [];
                this.strokeRaf   = null;
                const erasers = q.filter(s =>  s.isEraser);
                const normals = q.filter(s => !s.isEraser);
                if (normals.length) { this.strokeQueue = normals; _origFlushStrokes(); }
                for (const s of erasers) {
                    this.drawBinaryLine(s.x0, s.y0, s.x1, s.y1, s.color, false, s.width, true);
                }
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
                // isEraserOverride = true forces destination-out branch in drawBinaryLine.
                this.drawBinaryLine(s.x0, s.y0, s.x1, s.y1, s.color, false, s.width, true);
            }
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
        const _origSaveFile = app.saveFile.bind(app);
        app.saveFile = async function (options) {
            /* When layers are active, always save as ORA to preserve layer data */
            if (mgr.active && mgr.layers.length > 1) return this.saveAsORA();
            return _origSaveFile(options);
        };

        /* ──────────────────────────────────────────────────────────────────
         * 15. PATCH: updateHoverPreview — disabled, leave canvas blank
         * ────────────────────────────────────────────────────────────────── */
        app.updateHoverPreview = function (x, y) { /* disabled */ };

        /* ──────────────────────────────────────────────────────────────────
         * 15b. PATCH: onMouseDown — wand samples composite, not active layer
         * ────────────────────────────────────────────────────────────────── */
        const _origOnMouseDown = app.onMouseDown.bind(app);
        app.onMouseDown = function (e) {
            _origOnMouseDown(e);
            if (this.config.tool === 'wand' && this.state.wandActive && mgr.active && mgr.layers.length > 1) {
                const composite = _composite();
                if (composite) {
                    const w = this.config.width, h = this.config.height;
                    const compCtx = composite.getContext('2d');
                    const compData = compCtx.getImageData(0, 0, w, h);
                    this.state.wandBase = compData;
                    const data = compData.data;
                    const px = Math.floor(this.state.wandStart.x);
                    const py = Math.floor(this.state.wandStart.y);
                    const startIdx = (py * w + px) * 4;
                    const tr = data[startIdx], tg = data[startIdx+1], tb = data[startIdx+2], ta = data[startIdx+3];
                    const diff = new Uint8Array(w * h);
                    for (let i = 0, j = 0; i < diff.length; i++, j += 4) {
                        const dr = Math.abs(data[j]   - tr);
                        const dg = Math.abs(data[j+1] - tg);
                        const db = Math.abs(data[j+2] - tb);
                        const da = Math.abs(data[j+3] - ta);
                        let m = dr > dg ? dr : dg;
                        m = db > m ? db : m;
                        m = da > m ? da : m;
                        diff[i] = m;
                    }
                    this.state.wandDiff = diff;
                    this.magicWandSelectAsync(
                        this.state.wandStart.x, this.state.wandStart.y,
                        this.state.wandTol, this.getSelectionOp(e), compData
                    );
                }
            }
        };

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
                        const writer = cs.writable.getWriter();
                        writer.write(data);
                        writer.close();
                        return new Uint8Array(await new Response(cs.readable).arrayBuffer());
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
        app.saveAsORA = async function () {
            const w = this.config.width, h = this.config.height;
            const layers = mgr.active && mgr.layers.length ? mgr.layers : null;
            const enc    = new TextEncoder();

            /* If no layer system or single layer, treat base canvas as sole layer */
            const layerList = layers
                ? [...mgr.layers]           /* bottom-first already */
                : [{ name: 'Background', canvas: this.ui.cMain, visible: true,
                     opacity: 1.0, blendMode: 'source-over', locked: false,
                     alphaLock: false, isBase: true, alpha: false }];

            const entries = [];

            /* 1. mimetype — MUST be first, MUST be stored (no compression) */
            entries.push({ name: 'mimetype', data: enc.encode('image/openraster'), store: true });

            /* 2. Layer PNGs */
            const layerElems = [];
            for (let i = 0; i < layerList.length; i++) {
                const l   = layerList[i];
                const fname = `data/layer_${i}.png`;
                const png  = await _canvasToPngBytes(l.canvas);
                entries.push({ name: fname, data: png, store: false });

                const blend   = _blendToOra[l.blendMode || 'source-over'] || 'svg:src-over';
                const visible = l.visible !== false ? 'visible' : 'hidden';
                const opacity = typeof l.opacity === 'number' ? l.opacity.toFixed(4) : '1.0000';
                const extras  = [
                    l.locked    ? ' paint:locked="true"'    : '',
                    l.alphaLock ? ' paint:alphaLock="true"' : '',
                    l.isBase    ? ' paint:isBase="true"'    : '',
                ].join('');
                layerElems.push(
                    `        <layer name="${(l.name||'Layer').replace(/&/g,'&amp;').replace(/"/g,'&quot;')}" ` +
                    `src="${fname}" x="0" y="0" ` +
                    `opacity="${opacity}" visibility="${visible}" composite-op="${blend}"${extras}/>`
                );
            }

            /* 3. stack.xml */
            const activeIdx = mgr.active ? mgr.activeIdx : 0;
            const xml = [
                '<?xml version="1.0" encoding="UTF-8"?>',
                `<image version="0.0.3" w="${w}" h="${h}" xres="96" yres="96" paint:activeLayer="${activeIdx}">`,
                '    <stack>',
                /* ORA stack is top-to-bottom in XML, bottom-to-top visually */
                ...layerElems.slice().reverse(),
                '    </stack>',
                '</image>',
            ].join('\n');
            entries.push({ name: 'stack.xml', data: enc.encode(xml), store: false });

            /* 4. mergedimage.png (full-res composite, required by spec) */
            const mergeCanvas = document.createElement('canvas');
            mergeCanvas.width = w; mergeCanvas.height = h;
            const mctx = mergeCanvas.getContext('2d');
            for (const l of layerList) {
                if (!l.visible) continue;
                mctx.save();
                mctx.globalAlpha = typeof l.opacity === 'number' ? l.opacity : 1;
                mctx.globalCompositeOperation = l.blendMode || 'source-over';
                mctx.drawImage(l.canvas, 0, 0);
                mctx.restore();
            }
            entries.push({ name: 'mergedimage.png', data: await _canvasToPngBytes(mergeCanvas), store: false });

            /* 5. Thumbnails/thumbnail.png (≤256 px, required by spec) */
            const scale  = Math.min(1, 256 / Math.max(w, h));
            const tw = Math.max(1, Math.round(w * scale));
            const th = Math.max(1, Math.round(h * scale));
            const tCanvas = document.createElement('canvas');
            tCanvas.width = tw; tCanvas.height = th;
            tCanvas.getContext('2d').drawImage(mergeCanvas, 0, 0, tw, th);
            entries.push({ name: 'Thumbnails/thumbnail.png', data: await _canvasToPngBytes(tCanvas), store: false });

            /* Build ZIP and download */
            const zipBytes = await _oraZip.build(entries);
            const blob = new Blob([zipBytes], { type: 'image/openraster' });
            const baseName = (this.state.fileName || 'untitled').replace(/\.[^/.]+$/, '');
            const fname = baseName + '.ora';
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = fname; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
            this.markSaved(fname);
            this.resetSaveReminderTimer();
        };

        /* ── LOAD ORA ────────────────────────────────────────────────────── */
        app.loadORAFile = async function (file) {
            try {
                const zipBytes = new Uint8Array(await file.arrayBuffer());
                const files    = _parseZip(zipBytes);

                /* Parse stack.xml */
                const xmlBytes = files['stack.xml'];
                if (!xmlBytes) throw new Error('stack.xml missing from ORA');
                const xmlStr  = new TextDecoder().decode(xmlBytes);
                const parser  = new DOMParser();
                const doc     = parser.parseFromString(xmlStr, 'text/xml');
                const imageEl = doc.querySelector('image');
                if (!imageEl) throw new Error('Invalid stack.xml: no <image> element');

                const fileW = parseInt(imageEl.getAttribute('w') || '0', 10);
                const fileH = parseInt(imageEl.getAttribute('h') || '0', 10);
                if (!fileW || !fileH) throw new Error('ORA has invalid canvas dimensions');

                /* Layer elements — XML order is top→bottom; we want bottom→top */
                const stack     = imageEl.querySelector('stack');
                const layerEls  = stack ? Array.from(stack.querySelectorAll(':scope > layer')).reverse() : [];
                if (!layerEls.length) throw new Error('ORA contains no layers');

                const activeIdxAttr = parseInt(imageEl.getAttribute('paint:activeLayer') || '0', 10);

                /* Load all layer PNGs */
                const layerDefs = [];
                for (const el of layerEls) {
                    const src  = el.getAttribute('src') || '';
                    let pngBytes = files[src] || files[src.replace(/^\//, '')];
                    /* If deflated and no pako, inflate via DecompressionStream */
                    if (!pngBytes) {
                        const deflated = files['__deflated__' + (src || src.replace(/^\//, ''))];
                        if (deflated && typeof DecompressionStream !== 'undefined') {
                            const ds = new DecompressionStream('deflate-raw');
                            const writer = ds.writable.getWriter();
                            writer.write(deflated); writer.close();
                            pngBytes = new Uint8Array(await new Response(ds.readable).arrayBuffer());
                        }
                    }
                    if (!pngBytes) { console.warn('[ORA] missing layer data:', src); continue; }
                    const blob = new Blob([pngBytes], { type: 'image/png' });
                    const img  = await createImageBitmap(blob);
                    const lc   = document.createElement('canvas');
                    lc.width = fileW; lc.height = fileH;
                    lc.getContext('2d').drawImage(img, 0, 0);
                    layerDefs.push({
                        canvas:    lc,
                        name:      el.getAttribute('name') || 'Layer',
                        opacity:   parseFloat(el.getAttribute('opacity') || '1'),
                        visible:   (el.getAttribute('visibility') || 'visible') !== 'hidden',
                        blendMode: _oraToBlend[el.getAttribute('composite-op') || 'svg:src-over'] || 'source-over',
                        locked:    el.getAttribute('paint:locked') === 'true',
                        alphaLock: el.getAttribute('paint:alphaLock') === 'true',
                        isBase:    el.getAttribute('paint:isBase') === 'true',
                    });
                }
                if (!layerDefs.length) throw new Error('No usable layers found in ORA');

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

                /* Stamp base layer (index 0) onto the main canvas */
                const baseLayer = layerDefs.find(l => l.isBase) || layerDefs[0];
                _holder.ctx.clearRect(0, 0, fileW, fileH);
                _holder.ctx.drawImage(baseLayer.canvas, 0, 0);

                /* Activate layer system if needed */
                if (!mgr.active) _activate();

                /* Tear down existing non-base layers */
                while (mgr.layers.length > 1) {
                    const l = mgr.layers.pop();
                    if (l.canvas && l.canvas.parentNode) l.canvas.parentNode.removeChild(l.canvas);
                }
                /* Sync base layer object */
                mgr.layers[0].name      = baseLayer.name;
                mgr.layers[0].visible   = baseLayer.visible;
                mgr.layers[0].opacity   = baseLayer.opacity;
                mgr.layers[0].blendMode = baseLayer.blendMode;
                mgr.layers[0].locked    = baseLayer.locked;
                mgr.layers[0].alphaLock = baseLayer.alphaLock;

                /* Create upper layers */
                for (let i = 0; i < layerDefs.length; i++) {
                    const ld = layerDefs[i];
                    if (ld === baseLayer && i === 0) continue; /* already handled */
                    const id  = mgr.nextId++;
                    const c   = _newCanvas(fileW, fileH);
                    c.style.zIndex = String(10 + mgr.layers.length);
                    const ctx = c.getContext('2d', { willReadFrequently: true });
                    app.disableSmoothing(ctx);
                    ctx.drawImage(ld.canvas, 0, 0);
                    _insertBeforeTemp(c);
                    mgr.layers.push({
                        id, name: ld.name, canvas: c, ctx,
                        visible: ld.visible, opacity: ld.opacity,
                        blendMode: ld.blendMode, locked: ld.locked,
                        alphaLock: ld.alphaLock, isBase: false, alpha: true,
                    });
                }

                /* Set active layer */
                const safeActive = Math.min(Math.max(0, activeIdxAttr), mgr.layers.length - 1);
                _setActive(safeActive);

                this.state.hasDocument = true;
                this.saveState();
                this.markSaved(file.name);
                this.updateTitleFilename();
                _refreshList();
                _syncBtns();
                _schedThumb();
                this.requestGlobalOverlayUpdate();

            } catch (err) {
                showToast('Failed to open ORA file: ' + err.message, 'error');
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
        document.getElementById('lsys-xbtn')
            .addEventListener('click', () => _openPanel(false));
        document.getElementById('lsys-add')
            .addEventListener('click', () => { _addLayer(); app.saveState(); _schedThumb(); });
        document.getElementById('lsys-up')
            .addEventListener('click', () => _moveLayerUp());
        document.getElementById('lsys-down')
            .addEventListener('click', () => _moveLayerDown());
        document.getElementById('lsys-del')
            .addEventListener('click', () => _delLayer());
        document.getElementById('lsys-merge')
            .addEventListener('click', () => _mergeDown());
        document.getElementById('lsys-group')
            .addEventListener('click', () => _makeGroup());

        const _opSl = document.getElementById('lsys-op');
        if (_opSl) {
            _opSl.addEventListener('input',  () => _setOpacity(parseInt(_opSl.value, 10)));
            _opSl.addEventListener('change', () => app.saveState());
        }

        _syncBtns();
        // Ready — panel stays fully hidden until the hover zone is touched.

    })(PaintApp);