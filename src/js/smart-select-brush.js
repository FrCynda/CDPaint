// Smart Select Brush — the ONLY tool in CDPaint that discovers an image's
// flat-color palette and grows a selection along it. It's its own tool
// (`config.tool === 'smart-brush'`), entirely separate from the click wand's
// `config.tool === 'wand'`; no other tool calls into this file.
//
// This used to run a SAM (Segment-Anything) model client-side via
// transformers.js. That answered the wrong question: SAM segments whole
// *objects*, but this tool's job is to select a single flat-color paint
// stroke or region — a much finer granularity a general object-segmentation
// model has no notion of, and on a real test case (a thin mid-tone hair
// stripe sandwiched between similar-colored neighbors) it degraded to the
// classical fallback anyway. It has been removed — see git history for
// smart-select-model.js and src/vendor/transformers/ if that path is ever
// wanted again.
//
// Pipeline per stroke (all classical, all in smart-select-analysis.js):
//   rough brush stroke -> seed pixels (intent, positive or negative)
//   -> adaptive seeded region growing in OKLab space (regionGrowAdaptive):
//      grows from the seeds by tracking a RUNNING MEAN color, so a region
//      with real internal drift (an AI pseudo-gradient inside what should
//      read as one flat area) keeps absorbing pixels as the mean tracks the
//      drift, while a hard local edge (buildEdgeMagnitude, from
//      wand-algorithms.js, unmodified) is a hard veto that keeps real paint
//      outlines as walls regardless of color
//   -> subtract strokes run the same growth from their own seeds and carve
//      the result out, so Subtract follows real boundaries instead of just
//      erasing the brush's own stamp
//   -> hole-fill cleanup (the region is already a single connected blob by
//      construction; this only patches pixels the growth's per-pixel
//      accept/reject noise left stranded inside it)
//   -> applyMaskSelection (existing non-destructive selection pipeline)
//
// A k-means-in-OKLab palette (smart-select-analysis.js's kmeansOklab) is
// computed once per image and cached for the session. The growth itself
// doesn't need it — the running-mean approach out-performed a fixed
// per-cluster target in testing (see the git history of this file's
// companion test harness) — but it drives the debug view and the exposed
// cluster-count control, and is what "the flat colors this image actually
// uses" means for this tool.
Object.assign(PaintEngine.prototype, {

    _smartBrushMaxReach() {
        const radius = Math.max(4, (this.config.lineWidth || 8) / 2);
        const mult = this.config.smartBrushReachMult || 6;
        return Math.max(24, Math.min(480, Math.round(radius * mult)));
    },

    _smartBrushResetSession() {
        this.state.smartBrushEdgeMap = null;
        this.state.smartBrushAnalysis = null;
        this.state.smartBrushPosSeeds = new Set();
        this.state.smartBrushNegSeeds = new Set();
    },

    // Paints the visible stroke (ordinary translucent brush feedback) and
    // records every pixel the stroke passed over as a region-growing seed —
    // positive (label 1) or negative (label 0) depending on the modifier
    // held. A pixel painted with one label is removed from the other set,
    // so an Add stroke that crosses a Subtract mistake un-subtracts it.
    _paintSmartBrushSeeds(x, y) {
        if (!this.state.smartBrushPosSeeds) this._smartBrushResetSession();
        const w = this.config.width, h = this.config.height;
        const radius = Math.max(4, (this.config.lineWidth || 8) / 2);
        const label = this.state.smartBrushOp === 'subtract' ? 0 : 1;
        const posSeeds = this.state.smartBrushPosSeeds;
        const negSeeds = this.state.smartBrushNegSeeds;
        const stampSeeds = (cx, cy) => {
            const r2 = radius * radius;
            const minX = Math.max(0, Math.floor(cx - radius));
            const maxX = Math.min(w - 1, Math.ceil(cx + radius));
            const minY = Math.max(0, Math.floor(cy - radius));
            const maxY = Math.min(h - 1, Math.ceil(cy + radius));
            for (let py = minY; py <= maxY; py++) {
                const dy = py + 0.5 - cy;
                for (let px = minX; px <= maxX; px++) {
                    const dx = px + 0.5 - cx;
                    if (dx * dx + dy * dy <= r2) {
                        const idx = py * w + px;
                        if (label === 1) { posSeeds.add(idx); negSeeds.delete(idx); }
                        else { negSeeds.add(idx); posSeeds.delete(idx); }
                    }
                }
            }
        };

        const ctx = this.ctxTemp;
        ctx.beginPath();
        ctx.fillStyle = label ? 'rgba(0, 120, 215, 0.35)' : 'rgba(215, 40, 40, 0.35)';
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = radius * 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        const last = this.state.smartBrushLastPoint;
        if (last) {
            const dist = Math.hypot(x - last.x, y - last.y);
            const steps = Math.max(1, Math.ceil(dist / Math.max(1, radius * 0.5)));
            for (let i = 1; i <= steps; i++) {
                stampSeeds(last.x + (x - last.x) * (i / steps), last.y + (y - last.y) * (i / steps));
            }
            ctx.moveTo(last.x, last.y);
            ctx.lineTo(x, y);
            ctx.stroke();
        } else {
            stampSeeds(x, y);
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fill();
        }
        this.state.smartBrushLastPoint = { x, y };
    },

    // Every knob regionGrowAdaptive takes, with the values calibrated
    // empirically against a real reference selection (a thin mid-tone
    // stripe between near-identical neighboring colors — see the regression
    // harness used to build this file). All are exposed as sliders in the
    // Smart Select Brush sidebar so a case this tuning doesn't fit has
    // somewhere to go without editing code.
    _SMART_BRUSH_DEFAULTS: { tolerance: 8, driftMult: 6, colorScale: 160, reachMult: 6, k: 0, aaTolerance: 1, feather: 0, trimSeeds: false },
    _SMART_BRUSH_SLIDERS: [
        ['sb-tolerance', 'smartBrushTolerance'],
        ['sb-driftMult', 'smartBrushDriftMult'],
        ['sb-colorScale', 'smartBrushColorScale'],
        ['sb-reachMult', 'smartBrushReachMult'],
        ['sb-aaTolerance', 'smartBrushAATolerance'],
        ['sb-feather', 'smartBrushFeather']
    ],

    _loadSmartBrushConfig() {
        const d = this._SMART_BRUSH_DEFAULTS;
        let saved = {};
        try {
            const raw = localStorage.getItem('cdpaint.smartBrushConfig');
            if (raw) saved = JSON.parse(raw) || {};
        } catch (e) {}
        this.config.smartBrushTolerance = saved.tolerance ?? d.tolerance;
        this.config.smartBrushDriftMult = saved.driftMult ?? d.driftMult;
        this.config.smartBrushColorScale = saved.colorScale ?? d.colorScale;
        this.config.smartBrushReachMult = saved.reachMult ?? d.reachMult;
        this.config.smartBrushK = saved.k ?? d.k;
        this.config.smartBrushAATolerance = saved.aaTolerance ?? d.aaTolerance;
        this.config.smartBrushFeather = saved.feather ?? d.feather;
        this.config.smartBrushTrimSeeds = saved.trimSeeds ?? d.trimSeeds;
    },

    _saveSmartBrushConfig() {
        try {
            localStorage.setItem('cdpaint.smartBrushConfig', JSON.stringify({
                tolerance: this.config.smartBrushTolerance,
                driftMult: this.config.smartBrushDriftMult,
                colorScale: this.config.smartBrushColorScale,
                reachMult: this.config.smartBrushReachMult,
                k: this.config.smartBrushK,
                aaTolerance: this.config.smartBrushAATolerance,
                feather: this.config.smartBrushFeather,
                trimSeeds: this.config.smartBrushTrimSeeds
            }));
        } catch (e) {}
    },

    resetSmartBrushSettings() {
        const d = this._SMART_BRUSH_DEFAULTS;
        this.config.smartBrushTolerance = d.tolerance;
        this.config.smartBrushDriftMult = d.driftMult;
        this.config.smartBrushColorScale = d.colorScale;
        this.config.smartBrushReachMult = d.reachMult;
        this.config.smartBrushK = d.k;
        this.config.smartBrushAATolerance = d.aaTolerance;
        this.config.smartBrushFeather = d.feather;
        this.config.smartBrushTrimSeeds = d.trimSeeds;
        this.state.smartBrushAnalysis = null;
        this.updateSmartBrushPanel();
        this._saveSmartBrushConfig();
    },

    // Palette discovery — computed once per "fresh object" session (a
    // full k-means + whole-image labeling pass) and cached. The growth
    // itself only needs smartBrushEdgeMap, but the debug view and the
    // exposed cluster-count control both need this.
    _smartBrushEnsureAnalysis() {
        if (this.state.smartBrushAnalysis) return this.state.smartBrushAnalysis;
        const base = this.state.smartBrushBase;
        if (!base || !window.__smartSelectAnalysis) return null;
        const SA = window.__smartSelectAnalysis;
        const w = this.config.width, h = this.config.height;
        let K = this.config.smartBrushK || 0;
        if (!K) K = SA.chooseClusterCount(base.data, w, h);
        const analysis = SA.kmeansOklab(base.data, w, h, K, { sampleMax: 12000, seed: 1337 });
        this.state.smartBrushAnalysis = analysis;
        return analysis;
    },

    setSmartBrushK(value) {
        const v = Math.max(0, Math.min(20, Math.round(parseFloat(value) || 0)));
        this.config.smartBrushK = v;
        const el = document.getElementById('sb-k');
        if (el) { el.value = v; this._updateSmartBrushSliderVisual(el); }
        const valEl = document.getElementById('sb-k-val');
        if (valEl) valEl.textContent = v === 0 ? 'Auto' : String(v);
        // A changed cluster count invalidates the cached palette for this session.
        this.state.smartBrushAnalysis = null;
        this._saveSmartBrushConfig();
    },

    // Updates one slider's fill (--pct) and its overlaid value label —
    // the same pb-slider-wrap visual contract freehand/paintbrush use.
    _updateSmartBrushSliderVisual(el) {
        const wrap = el.parentElement;
        if (!wrap || !wrap.classList.contains('pb-slider-wrap')) return;
        const min = parseFloat(el.min) || 0, max = parseFloat(el.max) || 100;
        const pct = Math.round(((parseFloat(el.value) - min) / (max - min)) * 100) + '%';
        wrap.style.setProperty('--pct', pct);
        const valEl = wrap.querySelector('.pb-val');
        if (valEl) valEl.textContent = el.value;
    },

    bindSmartBrushSidebar() {
        for (const [id, key] of this._SMART_BRUSH_SLIDERS) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.addEventListener('input', () => {
                this.config[key] = parseFloat(el.value);
                this._updateSmartBrushSliderVisual(el);
                this._saveSmartBrushConfig();
            });
        }
        const kEl = document.getElementById('sb-k');
        if (kEl) kEl.addEventListener('input', e => this.setSmartBrushK(e.target.value));

        const trimCb = document.getElementById('sb-trimSeeds');
        if (trimCb) trimCb.addEventListener('change', () => {
            this.config.smartBrushTrimSeeds = trimCb.checked;
            this._saveSmartBrushConfig();
        });

        const debugCb = document.getElementById('sb-debugView');
        if (debugCb) debugCb.addEventListener('change', () => this.setSmartBrushDebugView(debugCb.checked));
        const modeBtn = document.getElementById('sb-debug-mode-btn');
        if (modeBtn) modeBtn.addEventListener('click', () => this.cycleSmartBrushDebugMode());
        const saveBtn = document.getElementById('sb-debug-save-btn');
        if (saveBtn) saveBtn.addEventListener('click', () => this.saveSmartBrushDebugPng());

        const resetBtn = document.getElementById('sb-reset-btn');
        if (resetBtn) resetBtn.addEventListener('click', () => this.resetSmartBrushSettings());

        const collapseBtn = document.getElementById('smart-brush-collapse-btn');
        if (collapseBtn) {
            collapseBtn.addEventListener('click', () => {
                const sidebar = document.getElementById('smart-brush-sidebar');
                if (sidebar) sidebar.classList.remove('open');
                const reopen = document.getElementById('smart-brush-reopen-btn');
                if (reopen) reopen.classList.add('show');
                this._updateSidebarViewportShift(true);
            });
        }
        const reopenBtn = document.getElementById('smart-brush-reopen-btn');
        if (reopenBtn) {
            reopenBtn.addEventListener('click', () => {
                const sidebar = document.getElementById('smart-brush-sidebar');
                if (sidebar) sidebar.classList.add('open');
                reopenBtn.classList.remove('show');
                this._updateSidebarViewportShift(true);
            });
        }
        const closeBtn = document.getElementById('smart-brush-close-btn');
        if (closeBtn) closeBtn.addEventListener('click', () => this.setTool('pencil'));

        this.updateSmartBrushPanel();
    },

    updateSmartBrushPanel() {
        for (const [id, key] of this._SMART_BRUSH_SLIDERS) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.value = this.config[key];
            this._updateSmartBrushSliderVisual(el);
        }
        const kEl = document.getElementById('sb-k');
        if (kEl) {
            kEl.value = this.config.smartBrushK || 0;
            this._updateSmartBrushSliderVisual(kEl);
            const valEl = document.getElementById('sb-k-val');
            if (valEl) valEl.textContent = (this.config.smartBrushK || 0) === 0 ? 'Auto' : String(this.config.smartBrushK);
        }
        const debugCb = document.getElementById('sb-debugView');
        if (debugCb) debugCb.checked = !!this.state.smartBrushDebugView;
        const trimCb = document.getElementById('sb-trimSeeds');
        if (trimCb) trimCb.checked = !!this.config.smartBrushTrimSeeds;
    },

    // Fills a Uint8Array mask's fully-enclosed background holes (BFS the
    // background in from the border; anything unreached is enclosed, so it
    // belongs to the selection). Never removes pixels based on area or
    // shape — the growth already produces one connected blob by
    // construction, so this only patches the odd stray pixel the adaptive
    // accept/reject test left stranded inside it, which is exactly the
    // "preserve thin features" requirement: nothing here can erode a
    // legitimately thin, correctly-selected band.
    _fillSmartBrushHoles(mask, w, h) {
        const n = w * h;
        const outside = new Uint8Array(n);
        const stack = new Int32Array(n);
        let sp = 0;
        for (let x = 0; x < w; x++) {
            if (!mask[x] && !outside[x]) { outside[x] = 1; stack[sp++] = x; }
            const bi = (h - 1) * w + x;
            if (!mask[bi] && !outside[bi]) { outside[bi] = 1; stack[sp++] = bi; }
        }
        for (let y = 0; y < h; y++) {
            const li = y * w, ri = y * w + (w - 1);
            if (!mask[li] && !outside[li]) { outside[li] = 1; stack[sp++] = li; }
            if (!mask[ri] && !outside[ri]) { outside[ri] = 1; stack[sp++] = ri; }
        }
        while (sp > 0) {
            const idx = stack[--sp];
            const x = idx % w, y = (idx / w) | 0;
            if (x > 0) { const nb = idx - 1; if (!mask[nb] && !outside[nb]) { outside[nb] = 1; stack[sp++] = nb; } }
            if (x < w - 1) { const nb = idx + 1; if (!mask[nb] && !outside[nb]) { outside[nb] = 1; stack[sp++] = nb; } }
            if (y > 0) { const nb = idx - w; if (!mask[nb] && !outside[nb]) { outside[nb] = 1; stack[sp++] = nb; } }
            if (y < h - 1) { const nb = idx + w; if (!mask[nb] && !outside[nb]) { outside[nb] = 1; stack[sp++] = nb; } }
        }
        const out = new Uint8Array(n);
        for (let i = 0; i < n; i++) out[i] = (mask[i] || !outside[i]) ? 1 : 0;
        return out;
    },

    // The one place recognition actually runs — called once per stroke, on
    // mouseup, never during the drag itself.
    _finalizeSmartBrush(jobId) {
        const w = this.config.width, h = this.config.height;
        const base = this.state.smartBrushBase;
        const posSeeds = this.state.smartBrushPosSeeds;
        if (!base || !posSeeds || !posSeeds.size || !window.__smartSelectAnalysis) return;
        const SA = window.__smartSelectAnalysis;

        const aaTolerance = this.config.smartBrushAATolerance || 1;
        // The island-cutoff check (aaTolerance>1) needs the k-means palette
        // to tell "still the seed's cluster" from "a new island" — skip the
        // analysis pass entirely when the feature is off so the common case
        // pays nothing extra beyond the debug view's own call.
        const analysis = (aaTolerance > 1 || this.state.smartBrushDebugView) ? this._smartBrushEnsureAnalysis() : null;

        const stepTol = this.config.smartBrushTolerance || 8;
        const driftMult = this.config.smartBrushDriftMult || 6;
        const opts = {
            stepTol,
            driftCap: stepTol * driftMult,
            colorScale: this.config.smartBrushColorScale || 160,
            maxReach: this._smartBrushMaxReach(),
            trimSeeds: !!this.config.smartBrushTrimSeeds,
            aaTolerance,
            edgeMagnitude: aaTolerance > 1 ? this.state.smartBrushEdgeMap : null,
            clusterLabels: analysis ? analysis.labels : null,
            clusterCentroids: analysis ? analysis.centroids : null
        };

        let mask = SA.regionGrowAdaptive(base.data, w, h, posSeeds, opts);
        const negSeeds = this.state.smartBrushNegSeeds;
        if (negSeeds && negSeeds.size) {
            // Subtract grows its own region from where it was actually
            // brushed (its own local color), then carves that out — this
            // follows the real boundary of the unwanted area instead of
            // just erasing the brush's circular stamp.
            const negMask = SA.regionGrowAdaptive(base.data, w, h, negSeeds, opts);
            for (let i = 0; i < mask.length; i++) if (negMask[i]) mask[i] = 0;
        }
        mask = this._fillSmartBrushHoles(mask, w, h);
        const feather = this.config.smartBrushFeather || 0;
        if (feather > 0) mask = SA.smoothMaskContour(mask, w, h, feather);

        if (this.state.smartBrushJobId !== jobId) return;

        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = w; maskCanvas.height = h;
        const mctx = maskCanvas.getContext('2d', { willReadFrequently: true });
        const mimg = mctx.createImageData(w, h);
        const md = mimg.data;
        for (let i = 0; i < mask.length; i++) {
            if (mask[i]) { const di = i * 4; md[di] = 0; md[di + 1] = 0; md[di + 2] = 0; md[di + 3] = 255; }
        }
        mctx.putImageData(mimg, 0, 0);
        this.applyMaskSelection(maskCanvas, 'replace', base, true, { source: 'smart-brush' });

        this.state.smartBrushLastMask = mask;
        if (this.state.smartBrushDebugView) this._renderSmartBrushDebug();
    },

    // ── Debug view ───────────────────────────────────────────────────────
    // Toggleable so a leaked or fragmented selection can be diagnosed:
    // 'clusters' shows the discovered flat-color palette (each pixel
    // painted with its cluster's centroid color), 'boundary' shows local
    // edge evidence (the buildEdgeMagnitude map this tool's edge wall reads
    // from), 'mask' shows the last committed selection as a pure binary
    // image. Dumpable to PNG via canvas.toBlob — a plain download, not the
    // project save pipeline, since this is a diagnostic dump, not a file.

    setSmartBrushDebugView(on) {
        this.state.smartBrushDebugView = !!on;
        const panel = document.getElementById('smart-brush-debug-panel');
        if (panel) panel.style.display = this.state.smartBrushDebugView ? 'block' : 'none';
        const cb = document.getElementById('sb-debugView');
        if (cb) cb.checked = this.state.smartBrushDebugView;
        if (this.state.smartBrushDebugView) this._renderSmartBrushDebug();
    },

    toggleSmartBrushDebugView() {
        this.setSmartBrushDebugView(!this.state.smartBrushDebugView);
    },

    cycleSmartBrushDebugMode() {
        const modes = ['clusters', 'boundary', 'mask'];
        const i = modes.indexOf(this.state.smartBrushDebugMode);
        this.state.smartBrushDebugMode = modes[(i + 1) % modes.length];
        this._renderSmartBrushDebug();
    },

    _smartBrushDebugImageData() {
        const w = this.config.width, h = this.config.height;
        const mode = this.state.smartBrushDebugMode;
        const out = new Uint8ClampedArray(w * h * 4);
        if (mode === 'mask') {
            const mask = this.state.smartBrushLastMask;
            for (let i = 0; i < w * h; i++) {
                const p = i * 4, v = mask && mask[i] ? 255 : 0;
                out[p] = out[p + 1] = out[p + 2] = v; out[p + 3] = 255;
            }
            return { data: out, title: 'Final Mask (binary)' };
        }
        if (mode === 'boundary') {
            const edge = this.state.smartBrushEdgeMap;
            for (let i = 0; i < w * h; i++) {
                const p = i * 4, v = edge ? edge[i] : 0;
                out[p] = out[p + 1] = out[p + 2] = v; out[p + 3] = 255;
            }
            return { data: out, title: 'Boundary Evidence (edge magnitude)' };
        }
        // 'clusters'
        const SA = window.__smartSelectAnalysis;
        const analysis = this._smartBrushEnsureAnalysis();
        if (analysis && SA) {
            for (let i = 0; i < w * h; i++) {
                const c = analysis.centroids[analysis.labels[i]];
                const rgb = SA.oklabToRgb(c.L, c.a, c.b);
                const p = i * 4;
                out[p] = rgb.r; out[p + 1] = rgb.g; out[p + 2] = rgb.b; out[p + 3] = 255;
            }
        }
        return { data: out, title: `Clusters (K=${analysis ? analysis.centroids.length : 0})` };
    },

    _renderSmartBrushDebug() {
        const canvas = document.getElementById('smart-brush-debug-canvas');
        const title = document.getElementById('smart-brush-debug-title');
        if (!canvas) return;
        const w = this.config.width, h = this.config.height;
        canvas.width = w; canvas.height = h;
        const { data, title: label } = this._smartBrushDebugImageData();
        canvas.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
        if (title) title.textContent = 'Smart Select Debug — ' + label;
    },

    saveSmartBrushDebugPng() {
        const canvas = document.getElementById('smart-brush-debug-canvas');
        if (!canvas || !canvas.width) { this._renderSmartBrushDebug(); }
        const c = document.getElementById('smart-brush-debug-canvas');
        if (!c || !c.width) return;
        c.toBlob(blob => {
            if (!blob) return;
            const link = document.createElement('a');
            link.download = `smart-select-debug-${this.state.smartBrushDebugMode}-${Date.now()}.png`;
            const url = URL.createObjectURL(blob);
            link.href = url;
            link.click();
            URL.revokeObjectURL(url);
        });
    },

});
