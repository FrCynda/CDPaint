/* magic-wand — moved verbatim off the PaintEngine class body.
 *
 * Assigned onto the prototype, so `this` is the same PaintEngine instance
 * these methods have always run against. Loads after paint-engine.js and
 * before boot.js, which is where the instance is finally created.
 */
(function () {
    Object.assign(PaintEngine.prototype, {
            _wandPerfMark(label) {
                if (!this.config.debugWandPerf) return;
                (this._wandPerfLog ||= []).push({ label, t: performance.now() });
            },
            _wandPerfFlush(tag) {
                if (!this.config.debugWandPerf || !this._wandPerfLog?.length) return;
                const log = this._wandPerfLog;
                const total = log[log.length - 1].t - log[0].t;
                console.debug(`[wand-perf:${tag}] total=${total.toFixed(2)}ms`,
                    log.map((e, i) => i === 0 ? e.label : `${e.label}=+${(e.t - log[i - 1].t).toFixed(2)}ms`));
                this._wandPerfLog = [];
            },

            ensureWandPreviewWorker() {
                if (this._wandPreviewWorkerFailed) return null;
                if (this._wandPreviewWorker) return this._wandPreviewWorker;
                if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
                    this._wandPreviewWorkerFailed = true;
                    return null;
                }
                const code = `
                    ${applyToleranceIncremental.toString()}
                    let gKeyArr = null, gSortedIdx = null, gW = 0, gH = 0, gMaskBuf = null, gPrevCutoff = 0;
                    const gBufs = {};

                    function growI32(bufs, key, minLen) {
                        let buf = bufs[key];
                        if (!buf || buf.length < minLen) {
                            let newLen = buf ? buf.length * 2 : 1024;
                            while (newLen < minLen) newLen *= 2;
                            buf = new Int32Array(newLen);
                            bufs[key] = buf;
                        }
                        return buf;
                    }

                    function ensureTraceBuffers(bufs, w, h) {
                        const stride = w + 1;
                        const vertexCount = stride * (h + 1);
                        if (!bufs.head || bufs.head.length < vertexCount) {
                            bufs.head = new Int32Array(vertexCount).fill(-1);
                            bufs.touchedCount = 0;
                        } else if (bufs.touchedCount) {
                            const head = bufs.head, touched = bufs.touched;
                            for (let i = 0; i < bufs.touchedCount; i++) head[touched[i]] = -1;
                            bufs.touchedCount = 0;
                        }
                        return stride;
                    }

                    function maskToSvgPath(mask, w, h, bufs, clip) {
                        const edges = [];
                        // Only trace what the viewport can actually show. The ants
                        // overlay is clipped to this same rectangle, so every edge
                        // outside it is built, strung into the path, handed to the
                        // DOM and then thrown away by the clip — on a canvas much
                        // larger than the window that is the bulk of the work.
                        let y0 = 0, y1 = h, x0 = 0, x1 = w;
                        if (clip) {
                            if (!clip.visible) return '';
                            x0 = clip.x < 0 ? 0 : (clip.x > w ? w : clip.x | 0);
                            y0 = clip.y < 0 ? 0 : (clip.y > h ? h : clip.y | 0);
                            const cx1 = clip.x + clip.w, cy1 = clip.y + clip.h;
                            x1 = cx1 < 0 ? 0 : (cx1 > w ? w : Math.ceil(cx1));
                            y1 = cy1 < 0 ? 0 : (cy1 > h ? h : Math.ceil(cy1));
                            if (x1 <= x0 || y1 <= y0) return '';
                        }
                        // Neighbour lookups below still read the full mask, so an
                        // edge on the crop border is emitted exactly as it would be
                        // without cropping; contours simply end there instead of
                        // closing, which the tracer already handles.
                        for (let y = y0; y < y1; y++) {
                            const row = y * w, rowP = (y - 1) * w, rowN = (y + 1) * w;
                            for (let x = x0; x < x1; x++) {
                                if (!mask[row + x]) continue;
                                const x1 = x + 1, y1 = y + 1;
                                if (y === 0 || !mask[rowP + x]) { edges.push(x, y, x1, y); }
                                if (x === w - 1 || !mask[row + x + 1]) { edges.push(x1, y, x1, y1); }
                                if (y === h - 1 || !mask[rowN + x]) { edges.push(x1, y1, x, y1); }
                                if (x === 0 || !mask[row + x - 1]) { edges.push(x, y1, x, y); }
                            }
                        }
                        const nEdges = edges.length >> 2;
                        if (!nEdges) return '';
                        const stride = ensureTraceBuffers(bufs, w, h);
                        const vertexCount = stride * (h + 1);
                        const head = bufs.head;
                        const entryCap = nEdges * 2;
                        const entryNext = growI32(bufs, 'entryNext', entryCap);
                        const entryEdge = growI32(bufs, 'entryEdge', entryCap);
                        const entryTail = growI32(bufs, 'entryTail', vertexCount);
                        const touched = growI32(bufs, 'touched', entryCap);
                        let touchedCount = 0, entryCount = 0;
                        for (let i = 0; i < nEdges; i++) {
                            const b = i * 4;
                            const ka = edges[b + 1] * stride + edges[b];
                            const kb = edges[b + 3] * stride + edges[b + 2];
                            entryEdge[entryCount] = i; entryNext[entryCount] = -1;
                            if (head[ka] === -1) head[ka] = entryCount; else entryNext[entryTail[ka]] = entryCount;
                            entryTail[ka] = entryCount;
                            touched[touchedCount++] = ka; entryCount++;
                            entryEdge[entryCount] = i; entryNext[entryCount] = -1;
                            if (head[kb] === -1) head[kb] = entryCount; else entryNext[entryTail[kb]] = entryCount;
                            entryTail[kb] = entryCount;
                            touched[touchedCount++] = kb; entryCount++;
                        }
                        bufs.touchedCount = touchedCount;
                        const used = growI32(bufs, 'used', nEdges);
                        used.fill(0, 0, nEdges);
                        const parts = [];
                        for (let si = 0; si < nEdges; si++) {
                            if (used[si]) continue;
                            used[si] = 1;
                            const b0 = si * 4;
                            const sx = edges[b0], sy = edges[b0 + 1];
                            const startKey = sy * stride + sx;
                            let prevKey = startKey;
                            let cx = edges[b0 + 2], cy = edges[b0 + 3];
                            let currKey = cy * stride + cx;
                            const ptx = [sx, cx], pty = [sy, cy];
                            while (currKey !== startKey) {
                                let entry = head[currKey];
                                if (entry === -1) break;
                                let nextIdx = -1, nxtX = 0, nxtY = 0;
                                let fbIdx = -1, fbX = 0, fbY = 0;
                                while (entry !== -1) {
                                    const ei = entryEdge[entry];
                                    entry = entryNext[entry];
                                    if (used[ei]) continue;
                                    const nb = ei * 4;
                                    const naKey = edges[nb + 1] * stride + edges[nb];
                                    const isA = (naKey === currKey);
                                    const ox = isA ? edges[nb + 2] : edges[nb];
                                    const oy = isA ? edges[nb + 3] : edges[nb + 1];
                                    const ok = oy * stride + ox;
                                    if (ok !== prevKey) { nextIdx = ei; nxtX = ox; nxtY = oy; break; }
                                    if (fbIdx === -1) { fbIdx = ei; fbX = ox; fbY = oy; }
                                }
                                if (nextIdx === -1) {
                                    if (fbIdx === -1) break;
                                    nextIdx = fbIdx; nxtX = fbX; nxtY = fbY;
                                }
                                used[nextIdx] = 1;
                                prevKey = currKey;
                                cx = nxtX; cy = nxtY;
                                currKey = cy * stride + cx;
                                ptx.push(cx); pty.push(cy);
                            }
                            let n = ptx.length;
                            if (n < 2) continue;
                            const isClosed = n > 2 && currKey === startKey;
                            if (isClosed) {
                                // BUGFIX: drop duplicate closing point (== start point)
                                // before the cyclic collinearity check below.
                                ptx.pop();
                                pty.pop();
                                n = ptx.length;
                                if (n < 3) continue;
                            }
                            const keep = new Uint8Array(n);
                            if (!isClosed) {
                                keep[0] = 1; keep[n - 1] = 1;
                                for (let i = 1; i < n - 1; i++) {
                                    const px = ptx[i - 1], py = pty[i - 1];
                                    const qx = ptx[i], qy = pty[i];
                                    const rx = ptx[i + 1], ry = pty[i + 1];
                                    if (!((px === qx && qx === rx) || (py === qy && qy === ry))) keep[i] = 1;
                                }
                            } else {
                                for (let i = 0; i < n; i++) {
                                    const pi = (i - 1 + n) % n, ni = (i + 1) % n;
                                    const px = ptx[pi], py = pty[pi];
                                    const qx = ptx[i], qy = pty[i];
                                    const rx = ptx[ni], ry = pty[ni];
                                    if (!((px === qx && qx === rx) || (py === qy && qy === ry))) keep[i] = 1;
                                }
                            }
                            let first = true;
                            for (let i = 0; i < n; i++) {
                                if (!keep[i]) continue;
                                parts.push(first ? ('M' + ptx[i] + ' ' + pty[i]) : ('L' + ptx[i] + ' ' + pty[i]));
                                first = false;
                            }
                            if (isClosed && !first) parts.push('Z');
                        }
                        return parts.join('');
                    }

                    /* Only the newest tolerance is ever drawn, so only the newest
                     * one is worth computing. Messages that pile up while a job is
                     * running are collapsed: each one just overwrites the pending
                     * request, and the actual work is deferred to a timer task,
                     * which runs after every message already sitting in the queue.
                     * Without this the worker works through the whole backlog of a
                     * drag one tolerance at a time and finishes long after the user
                     * has let go — which is what made it look frozen, and left the
                     * next wand click queued behind the last one's leftovers. */
                    let gPending = null, gScheduled = false;

                    function runPending() {
                        gScheduled = false;
                        const msg = gPending;
                        gPending = null;
                        if (!msg || !gKeyArr) return;
                        const mask = gMaskBuf;
                        const result = applyToleranceIncremental(gKeyArr, gSortedIdx, gPrevCutoff, msg.tolerance, mask, gW);
                        gPrevCutoff = result.cutoff;
                        const pathStr = maskToSvgPath(mask, gW, gH, gBufs, msg.clip);
                        self.postMessage({ jobId: msg.jobId, pathStr: pathStr });
                    }

                    self.onmessage = function (e) {
                        const msg = e.data || {};
                        if (msg.type === 'init') {
                            gKeyArr = new Uint8Array(msg.keyArr);
                            gSortedIdx = new Uint32Array(msg.sortedIdx);
                            gW = msg.w; gH = msg.h;
                            gMaskBuf = new Uint8Array(gW * gH);
                            gPrevCutoff = 0;
                            gPending = null;
                            return;
                        }
                        if (msg.type === 'update') {
                            if (!gKeyArr) return;
                            gPending = msg;
                            if (!gScheduled) { gScheduled = true; setTimeout(runPending, 0); }
                        }
                    };
                `;
                try {
                    const blob = new Blob([code], { type: 'application/javascript' });
                    const url = URL.createObjectURL(blob);
                    const worker = new Worker(url);
                    const revokeUrl = () => {
                        URL.revokeObjectURL(url);
                        worker.removeEventListener('message', revokeUrl);
                        worker.removeEventListener('error', revokeUrl);
                    };
                    worker.addEventListener('error', revokeUrl);
                    worker.addEventListener('message', revokeUrl);
                    worker.onmessage = (event) => {
                        const payload = event && event.data ? event.data : null;
                        if (!payload) return;
                        // Anything that isn't the job we are waiting for belongs to
                        // an abandoned drag — the slot was cleared when that session
                        // ended, so its result is not ours to draw.
                        if (this._wandWorkerInFlight !== payload.jobId) return;
                        this._wandWorkerInFlight = null;
                        // Restart the worker on the newest tolerance first, so it
                        // computes while the main thread does the DOM write.
                        const pending = this._wandWorkerPending;
                        this._wandWorkerPending = null;
                        if (pending) this._postWandWorkerUpdate(pending.tolerance, pending.jobId);
                        if (!this.state.wandActive) return;
                        // Deliberately no "is this still the newest jobId" test. Only
                        // one job runs at a time and it always carries the newest
                        // tolerance known when it started, so its result is the best
                        // outline available — drawing it and letting the next one
                        // replace it is what keeps the ants moving. Testing against
                        // the newest scheduled id instead threw away every result
                        // that took longer than a frame to compute, which on a large
                        // canvas is all of them.
                        const w = this.config.width, h = this.config.height;
                        this.ctxTemp.clearRect(0, 0, w, h);
                        this._applyWandSvgPreview(payload.pathStr);
                    };
                    worker.onerror = () => {
                        this._wandPreviewWorkerFailed = true;
                        this._wandWorkerReady = false;
                        try { worker.terminate(); } catch (e) {}
                        this._wandPreviewWorker = null;
                    };
                    this._wandPreviewWorker = worker;
                    return worker;
                } catch (e) {
                    this._wandPreviewWorkerFailed = true;
                    return null;
                }
            },

            /**
             * Send the (immutable-for-the-drag) diff buffer to the wand preview
             * worker once, at the start of a wand drag/threshold session. Only a
             * cloned copy's buffer is transferred (zero-copy) — the original
             * this.state.wandDiff is left untouched for the main-thread fallback
             * path and for the exact commit-time computation on pointer-up.
             */
            _initWandPreviewWorker(diff, keyArr, sortedIdx, w, h) {
                this._wandWorkerReady = false;
                // A new session: anything still outstanding belongs to the previous
                // one. Its reply carries an old jobId, so it will neither be drawn
                // nor mistaken for this session's in-flight job.
                this._wandWorkerInFlight = null;
                this._wandWorkerPending = null;
                const worker = this.ensureWandPreviewWorker();
                if (!worker || !diff) return;
                try {
                    const diffCopy = new Uint8Array(diff);
                    const keyCopy = new Uint8Array(keyArr);
                    const idxCopy = new Uint32Array(sortedIdx);
                    worker.postMessage({
                        type: 'init',
                        mode: this.config.wandMode === 'global' ? 'global' : 'contig',
                        diff: diffCopy.buffer,
                        keyArr: keyCopy.buffer,
                        sortedIdx: idxCopy.buffer,
                        w, h
                    }, [diffCopy.buffer, keyCopy.buffer, idxCopy.buffer]);
                    this._wandWorkerReady = true;
                } catch (e) {
                    // Leave _wandWorkerReady false — _processWandDrag will use the
                    // synchronous main-thread fallback for this drag session.
                }
            },

            /**
             * Ask the wand preview worker to recompute the mask + boundary path for
             * the given tolerance. Returns true if the request was dispatched (the
             * result will arrive asynchronously via the worker's onmessage above),
             * or false if the worker isn't available/ready — in which case the
             * caller should fall back to the synchronous _lightweightWandUpdate.
             */
            _postWandWorkerUpdate(tolerance, jobId) {
                if (!this._wandWorkerReady) return false;
                const worker = this._wandPreviewWorker;
                if (!worker) return false;
                // At most one job in flight. A drag generates a new tolerance every
                // frame, but only the newest one is ever drawn — queueing the rest
                // just builds a backlog that outlives the drag.
                if (this._wandWorkerInFlight !== null && this._wandWorkerInFlight !== undefined) {
                    this._wandWorkerPending = { tolerance, jobId };
                    return true;
                }
                this._wandWorkerInFlight = jobId;
                // Cull to what the viewport shows; the overlay is clipped to this
                // same rectangle, so nothing visible is lost.
                worker.postMessage({ type: 'update', jobId, tolerance, clip: this._antsClipRectInCanvasPx() });
                return true;
            },

            updateWandThreshold(value, opts = {}) {
                const v = Math.max(0, Math.min(255, Math.round((parseFloat(value) || 0) * 10) / 10));
                const setConfig = opts.setConfig !== false;
                if (setConfig) this.config.wandTolerance = v;
                if (this.ui.wandThreshold) {
                    this.ui.wandThreshold.value = v;
                    const el = this.ui.wandThreshold;
                    const wrap = el.parentNode;
                    const min = parseFloat(el.min) || 0;
                    const max = parseFloat(el.max) || 255;
                    const pct = ((v - min) / (max - min)) * 100;
                    el.style.setProperty('--pct', pct + '%');
                    if (wrap && wrap.classList.contains('pb-slider-wrap')) {
                        wrap.style.setProperty('--pct', pct + '%');
                    }
                }
                if (this.ui.wandThresholdVal) this.ui.wandThresholdVal.textContent = v;
                const applySelection = opts.applySelection !== false;
                if (applySelection && this.state.wandActive && this.state.wandStart && this.state.wandBase) {
                    this.state.wandTol = v;
                    this._scheduleWandFrame();
                }
            },

            openWandMenu(e) {
                const menu = document.getElementById('wand-menu');
                if (!menu) return;
                menu.style.display = 'flex';
                menu.style.left = e.clientX + 'px';
                menu.style.top = e.clientY + 'px';
            },
            syncWandMenu() {
                const contig = document.getElementById('item-wand-contig');
                const global = document.getElementById('item-wand-global');
                if (contig) contig.classList.toggle('checked', this.config.wandMode === 'contiguous');
                if (global) global.classList.toggle('checked', this.config.wandMode === 'global');
                const sampleAll = document.getElementById('item-wand-sample-all');
                if (sampleAll) sampleAll.classList.toggle('checked', !!this.config.sampleAllLayers);
                const wandBtn = document.getElementById('wand-tool-btn');
                if (wandBtn) {
                    const iconContig = wandBtn.querySelector('.wand-icon-contig');
                    const iconGlobal = wandBtn.querySelector('.wand-icon-global');
                    if (iconContig) iconContig.classList.toggle('show', this.config.wandMode === 'contiguous');
                    if (iconGlobal) iconGlobal.classList.toggle('show', this.config.wandMode === 'global');
                }
                document.querySelectorAll('.tool-grid-slot[data-tool-id="wand"]').forEach(slot => {
                    const iconContig = slot.querySelector('.wand-icon-contig');
                    const iconGlobal = slot.querySelector('.wand-icon-global');
                    if (iconContig) iconContig.classList.toggle('show', this.config.wandMode === 'contiguous');
                    if (iconGlobal) iconGlobal.classList.toggle('show', this.config.wandMode === 'global');
                });
            },
            setWandMode(mode) {
                this.config.wandMode = mode === 'global' ? 'global' : 'contiguous';
                this.lsSet('paint.wandMode', this.config.wandMode);
                this.syncWandMenu();
                this.closeMenus();
            },
            /* ── Where the sampling tools read from ──────────────────────
             * The wand and the eyedropper answer "what colour is under the
             * cursor". That question has two reasonable answers when a
             * document has layers, and Krita and CSP both default to the
             * active layer and put the composite behind an explicit toggle.
             *
             * This used to be hardcoded to the composite whenever more than
             * one layer existed, so wanding a uniform background stopped at
             * artwork sitting on a layer above it. The bucket deliberately
             * does NOT route through here: it writes its sample buffer
             * straight back to the layer, so handing it composite pixels
             * would bake the upper layers into the one being filled. */
            getSampleSource() {
                if (this.config.sampleAllLayers && this.layerMgr
                    && this.layerMgr.active && this.layerMgr.layers.length > 1) {
                    const comp = this.layerMgr.getFlattenedCanvas();
                    if (comp) return comp.getContext('2d', { willReadFrequently: true });
                }
                return this.ctx;
            },
            getSampleImageData() {
                return this.getSampleSource()
                    .getImageData(0, 0, this.config.width, this.config.height);
            },
            toggleSampleAllLayers() {
                this.config.sampleAllLayers = !this.config.sampleAllLayers;
                this.lsSet('paint.sampleAllLayers', this.config.sampleAllLayers ? '1' : '0');
                this.syncWandMenu();
                this.closeMenus();
            },
            _clearWandSelectionSilent() {
                if (!this.state.selection) return;
                this._freeSelectionGlTex(this.state.selection);
                this.state.selection = null;
                this.state.selectionOriginalPos = null;
                this.state.isRotatingSel = false;
                this.state.selectionRotateSession = null;
                this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                this.resetSelectionTempDirty();
                this.ui.selControls.style.display = 'none';
                this.clearStatusSelectionSize();
                this.stopOutlineAnimation();
                this.requestGlobalOverlayUpdate();
            },

            // Rebuild a live wand selection from the lightweight snapshot (x/y/w/h +
            // pixel canvas + mask canvas) that saveState() attached to a history entry.
            // Called after restoreHistoryEntry() in both undo() and redo().
            _restoreWandSelSnap(snap) {
                // Clone canvases so the history entry keeps its own independent copies.
                const selC = document.createElement('canvas');
                selC.width = snap.canvas.width; selC.height = snap.canvas.height;
                const selCtx = selC.getContext('2d');
                this.disableSmoothing(selCtx);
                selCtx.drawImage(snap.canvas, 0, 0);

                const maskC = document.createElement('canvas');
                maskC.width = snap.mask.width; maskC.height = snap.mask.height;
                maskC.getContext('2d').drawImage(snap.mask, 0, 0);

                this.state.selection = {
                    x: snap.x, y: snap.y, w: snap.w, h: snap.h,
                    rotation: 0,
                    canvas: selC,
                    originalX: snap.x, originalY: snap.y,
                    palette: null,
                    mask: maskC,
                    source: 'wand',
                    noHandles: true,
                    _maskOutline: null, _maskOutlinePath: null, _maskOutlineData: null,
                    _maskVisiblePathCacheKey: '', _maskVisiblePathCacheValue: '',
                    _maskAnts: null, _maskOutlineScreen: null, _maskAntsScreen: null,
                    _glTex: null, _glTexDirty: true
                };
                this.state.selectionOriginalPos = { x: snap.x, y: snap.y, w: snap.w, h: snap.h, rotation: 0 };
                this.state.selectionJustCreated = false;
                this.state.selectionCutStep = this.state.step;
                this.renderSelection();
                this.requestGlobalOverlayUpdate();
            },

            magicWandSelect(startX, startY, tolerance = 0, op = 'replace', baseImageData = null, commit = true) {
                const width = this.config.width;
                const height = this.config.height;
                if (startX < 0 || startY < 0 || startX >= width || startY >= height) return;
                const imageData = baseImageData || this.ctx.getImageData(0, 0, width, height);
                const data = imageData.data;
                const startIdx = (Math.floor(startY) * width + Math.floor(startX)) * 4;
                const tr = data[startIdx], tg = data[startIdx + 1], tb = data[startIdx + 2], ta = data[startIdx + 3];
                let visited = this.state.wandVisited;
                if (!visited || visited.length !== width * height) {
                    visited = new Uint8Array(width * height);
                    this.state.wandVisited = visited;
                } else {
                    visited.fill(0);
                }
                // Flood-fill frontier, as interleaved x,y. A plain array of {x,y}
                // allocates four objects per visited pixel — tens of millions of
                // them on a large canvas, which is most of the multi-second stall
                // on mouse-up.
                //
                // Depth is bounded by 4 entries per accepted pixel, but a real
                // region never comes close, so the buffer starts modest and doubles
                // if a genuinely awkward shape needs it rather than reserving the
                // worst case (which at 16 MP would be half a gigabyte).
                if (!this._wandCommitStack || this._wandCommitStack.length < 8192) {
                    this._wandCommitStack = new Int32Array(Math.max(8192, (width * height) >> 2));
                }
                let stack = this._wandCommitStack;
                let sp = 0;
                stack[sp++] = Math.floor(startX);
                stack[sp++] = Math.floor(startY);

                const diff = this.state.wandDiff;
                const useDiff = diff && diff.length === width * height;
                const match = (idx, vi) => {
                    if (useDiff) return diff[vi] <= tolerance;
                    if (Math.abs(data[idx] - tr) > tolerance) return false;
                    if (Math.abs(data[idx + 1] - tg) > tolerance) return false;
                    if (Math.abs(data[idx + 2] - tb) > tolerance) return false;
                    if (Math.abs(data[idx + 3] - ta) > tolerance) return false;
                    return true;
                };

                let mask = this.state.wandMaskCanvas;
                let mimg = this.state.wandMaskImageData;
                let mctx = null;
                if (!mask || mask.width !== width || mask.height !== height) {
                    mask = document.createElement('canvas');
                    mask.width = width; mask.height = height;
                    mctx = mask.getContext('2d', { willReadFrequently: true });
                    mimg = mctx.createImageData(width, height);
                    this.state.wandMaskCanvas = mask;
                    this.state.wandMaskImageData = mimg;
                } else {
                    mctx = mask.getContext('2d', { willReadFrequently: true });
                    mimg = this.state.wandMaskImageData;
                }
                const md = mimg.data;
                md.fill(0);

                if (this.config.wandMode === 'global') {
                    for (let y = 0; y < height; y++) {
                        for (let x = 0; x < width; x++) {
                            const idx = (y * width + x) * 4;
                            const vi = y * width + x;
                            if (match(idx, vi)) {
                                md[idx] = 0; md[idx + 1] = 0; md[idx + 2] = 0; md[idx + 3] = 255;
                                visited[vi] = 1;
                            }
                        }
                    }
                } else {
                    while (sp > 0) {
                        const y = stack[--sp], x = stack[--sp];
                        if (x < 0 || y < 0 || x >= width || y >= height) continue;
                        const vi = y * width + x;
                        if (visited[vi]) continue;
                        const idx = vi * 4;
                        if (!match(idx, vi)) continue;
                        visited[vi] = 1;
                        md[idx] = 0; md[idx + 1] = 0; md[idx + 2] = 0; md[idx + 3] = 255;
                        if (sp + 8 > stack.length) {
                            const bigger = new Int32Array(stack.length * 2);
                            bigger.set(stack);
                            stack = bigger;
                            this._wandCommitStack = stack;
                        }
                        stack[sp++] = x + 1; stack[sp++] = y;
                        stack[sp++] = x - 1; stack[sp++] = y;
                        stack[sp++] = x;     stack[sp++] = y + 1;
                        stack[sp++] = x;     stack[sp++] = y - 1;
                    }
                }
                mctx.putImageData(mimg, 0, 0);
                this.applyMaskSelection(mask, op, imageData, commit, { source: 'wand' });
            },
            calculateWandMaskFast(startX, startY, tolerance, w, h) {
                const diff = this.state.wandDiff;
                if (!diff) return null;
                if (!this._wandPreviewBuffer || this._wandPreviewBuffer.length !== w * h) {
                    this._wandPreviewBuffer = new Uint8Array(w * h);
                }
                const mask = this._wandPreviewBuffer;
                mask.fill(0);
                if (this.config.wandMode === 'global') {
                    if (this._wandSortedIdx) {
                        const res = applyToleranceIncremental(diff, this._wandSortedIdx, this._wandSelectedCutoff, tolerance, mask, w);
                        this._wandSelectedCutoff = res.cutoff;
                    } else {
                        for (let i = 0; i < diff.length; i++)
                            if (diff[i] <= tolerance) mask[i] = 1;
                    }
                    return mask;
                }
                if (this._wandEntered && this._wandSortedIdx) {
                    const res = applyToleranceIncremental(this._wandEntered, this._wandSortedIdx, this._wandSelectedCutoff, tolerance, mask, w);
                    this._wandSelectedCutoff = res.cutoff;
                } else {
                    if (!this._wandStack || this._wandStack.length < w * h * 2) {
                        this._wandStack = new Int32Array(w * h * 2);
                    }
                    let sp = 0;
                    const push = (x, y) => {
                        this._wandStack[sp++] = x;
                        this._wandStack[sp++] = y;
                    };
                    push(Math.floor(startX), Math.floor(startY));
                    while (sp > 0) {
                        const y = this._wandStack[--sp];
                        const x = this._wandStack[--sp];
                        if (x < 0 || x >= w || y < 0 || y >= h) continue;
                        const idx = y * w + x;
                        if (mask[idx]) continue;
                        if (diff[idx] > tolerance) continue;
                        mask[idx] = 1;
                        push(x + 1, y);
                        push(x - 1, y);
                        push(x, y + 1);
                        push(x, y - 1);
                    }
                }
                return mask;
            },
            _scheduleWandFrame() {
                if (this._wandSelectRaf) return;
                const jobId = ++this.state.wandJobId;
                this._wandSelectRaf = requestAnimationFrame(() => this._processWandDrag(jobId));
            },
            _processWandDrag(jobId) {
                this._wandSelectRaf = null;
                if (!this.state.wandActive || this.state.wandJobId !== jobId) return;
                const tol = this.state.wandTol;
                const op = this.state.wandOp || 'replace';
                if (op === 'replace') {
                    // Prefer the worker: it never blocks the main thread on mask
                    // compute + boundary tracing, so pointer handling and other UI
                    // stay responsive even on a large/noisy canvas at a high
                    // threshold. Falls back to the synchronous path (unchanged
                    // output) if the worker isn't available/ready.
                    if (!this._postWandWorkerUpdate(tol, jobId)) {
                        this._lightweightWandUpdate(tol, jobId).then();
                    }
                } else {
                    this.magicWandSelectAsync(this.state.wandStart.x, this.state.wandStart.y, tol, op, this.state.wandBase);
                }
            },
            async _lightweightWandUpdate(tolerance, jobId) {
                const w = this.config.width, h = this.config.height;
                const diff = this.state.wandDiff;
                if (!diff) return;
                if (!this._wandPreviewBuffer || this._wandPreviewBuffer.length !== w * h)
                    this._wandPreviewBuffer = new Uint8Array(w * h);
                const mask = this._wandPreviewBuffer;
                mask.fill(0);
                if (this.config.wandMode === 'global') {
                    if (this._wandSortedIdx) {
                        const res = applyToleranceIncremental(diff, this._wandSortedIdx, this._wandSelectedCutoff, tolerance, mask, w);
                        this._wandSelectedCutoff = res.cutoff;
                    } else {
                        for (let i = 0; i < diff.length; i++)
                            if (diff[i] <= tolerance) mask[i] = 1;
                    }
                    // Stale job — leave current ants visible; next job will overwrite.
                    if (this.state.wandJobId !== jobId) return;
                    const pathStr = this._maskToSvgPath(mask, w, h, this._antsClipRectInCanvasPx());
                    if (this.state.wandJobId !== jobId) return;
                    this.ctxTemp.clearRect(0, 0, w, h);
                    this._applyWandSvgPreview(pathStr);
                    return;
                }
                if (this._wandEntered && this._wandSortedIdx) {
                    const res = applyToleranceIncremental(this._wandEntered, this._wandSortedIdx, this._wandSelectedCutoff, tolerance, mask, w);
                    this._wandSelectedCutoff = res.cutoff;
                } else {
                    const stackLen = w * h * 2;
                    if (!this._wandStack || this._wandStack.length < stackLen)
                        this._wandStack = new Int32Array(stackLen);
                    let sp = 0;
                    const push = (x, y) => { this._wandStack[sp++] = x; this._wandStack[sp++] = y; };
                    push(Math.floor(this.state.wandStart.x), Math.floor(this.state.wandStart.y));
                    let steps = 0;
                    while (sp > 0) {
                        if (this.state.wandJobId !== jobId) return;
                        const y = this._wandStack[--sp], x = this._wandStack[--sp];
                        if (x < 0 || x >= w || y < 0 || y >= h) continue;
                        const idx = y * w + x;
                        if (mask[idx]) continue;
                        if (diff[idx] > tolerance) continue;
                        mask[idx] = 1;
                        push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
                        steps++;
                        if (steps % 20000 === 0) await new Promise(requestAnimationFrame);
                    }
                }
                // Stale job — leave current ants visible; next job will overwrite.
                if (this.state.wandJobId !== jobId) return;
                const pathStr = this._maskToSvgPath(mask, w, h, this._antsClipRectInCanvasPx());
                if (this.state.wandJobId !== jobId) return;
                this.ctxTemp.clearRect(0, 0, w, h);
                this._applyWandSvgPreview(pathStr);
            },

            /**
             * Convert a Uint8Array binary mask (1=selected, 0=not) into an SVG path
             * string that is identical in format to what committed selections use.
             *
             * Strategy: paint the mask into a scratch canvas as alpha values, then
             * delegate to buildMaskOutlineData which traces connected boundary loops,
             * simplifies collinear segments, and returns the joined path string.
             * This ensures the preview ants look and animate exactly like committed ants.
             */
            /**
             * Convert a Uint8Array binary mask (1=selected, 0=not) to an SVG path
             * string of connected boundary loops — identical in visual quality to what
             * buildMaskOutlineData produces for committed selections, but operating
             * entirely on the typed array with no canvas, no getImageData, and no
             * putImageData. Uses integer-keyed adjacency (y*(w+1)+x) instead of
             * string keys, and an inline O(n) collinear simplification instead of
             * the O(n┬▓) splice loop in simplifyAxisAlignedPath.
             */
            /**
             * Ensure the reusable typed-array scratch buffers for _maskToSvgPath are
             * sized correctly for the current canvas dimensions, and reset (to -1)
             * only the vertex-bucket slots that were actually touched by the PREVIOUS
             * call — an O(perimeter) reset instead of re-allocating and O(w*h)-filling
             * a fresh (w+1)*(h+1) array every single frame of a wand-threshold drag.
             * Returns the grid stride (w+1) used for vertex keys.
             */
            _ensureWandTraceBuffers(w, h) {
                const stride = w + 1;
                const vertexCount = stride * (h + 1);
                if (!this._wandTraceHead || this._wandTraceHead.length < vertexCount) {
                    // (Re)allocate — only happens the first time, or when the canvas
                    // grows past the previously allocated size. Every other frame
                    // reuses this buffer and only touches the handful of vertex slots
                    // that this frame's boundary actually visits.
                    this._wandTraceHead = new Int32Array(vertexCount).fill(-1);
                    this._wandTraceTouchedCount = 0;
                } else if (this._wandTraceTouchedCount) {
                    const head = this._wandTraceHead;
                    const touched = this._wandTraceTouched;
                    for (let i = 0; i < this._wandTraceTouchedCount; i++) head[touched[i]] = -1;
                    this._wandTraceTouchedCount = 0;
                }
                return stride;
            },
            /** Grow (doubling) an Int32Array scratch buffer stored on `this[key]` to at least `minLen`. */
            _growWandTraceI32(key, minLen) {
                let buf = this[key];
                if (!buf || buf.length < minLen) {
                    let newLen = buf ? buf.length * 2 : 1024;
                    while (newLen < minLen) newLen *= 2;
                    buf = new Int32Array(newLen);
                    this[key] = buf;
                }
                return buf;
            },
            _applyWandSvgPreview(pathStr) {
                if (!this.ui.svgAntsPath) return;
                if (!pathStr) {
                    this._clearWandSvgPreview();
                    return;
                }
                // Mark preview active BEFORE touching the DOM so updateGlobalOverlays
                // never races us into hiding the elements on the same frame.
                this._wandSvgPreviewActive = true;
                const z = this.config.zoom || 1;
                // The mask is always origin-aligned (full canvas), so tx=ty=0.
                // overlayUnscaled=true mode: path in canvas pixels, transform scales by zoom.
                // `d` changes every frame during a drag, but `transform` only changes
                // when the user zooms/pans — skip the redundant attribute write (which
                // is a layout-adjacent op on an SVG element) when zoom hasn't moved.
                const backWasHidden = this.ui.svgAntsPathBack && this.ui.svgAntsPathBack.style.display !== 'block';
                const frontWasHidden = this.ui.svgAntsPath.style.display !== 'block';
                const zoomChanged = this._wandSvgPreviewLastZoom !== z;
                let transform = null;
                if (zoomChanged || backWasHidden || frontWasHidden) {
                    transform = 'matrix(' + z + ' 0 0 ' + z + ' 0 0)';
                    this._wandSvgPreviewLastZoom = z;
                }
                // Apply clip rect for viewport culling.
                const clip = this._computeAntsClipRect();
                const clipRect = this.ui.svgAntsClipRect;
                if (clipRect) {
                    clipRect.setAttribute('x',      String(clip.x));
                    clipRect.setAttribute('y',      String(clip.y));
                    clipRect.setAttribute('width',  String(clip.visible ? clip.w : 0));
                    clipRect.setAttribute('height', String(clip.visible ? clip.h : 0));
                }
                if (this.ui.svgAntsPathBack) {
                    this.ui.svgAntsPathBack.setAttribute('d', pathStr);
                    if (transform !== null) this.ui.svgAntsPathBack.setAttribute('transform', transform);
                    // Only set display:block on first show — avoid restarting the CSS animation.
                    if (backWasHidden)
                        this.ui.svgAntsPathBack.style.display = 'block';
                }
                this.ui.svgAntsPath.setAttribute('d', pathStr);
                if (transform !== null) this.ui.svgAntsPath.setAttribute('transform', transform);
                if (frontWasHidden)
                    this.ui.svgAntsPath.style.display = 'block';
            },

            /**
             * Hide the wand-drag SVG preview ants. Also resets the clip rect to zero
             * so it doesn't occlude the committed selection's ants when they appear.
             * Safe to call even if SVG elements are not yet in the DOM.
             */
            _clearWandSvgPreview() {
                this._wandSvgPreviewActive = false;
                this._wandSvgPreviewLastZoom = null;
                if (this.ui.svgAntsPath)     this.ui.svgAntsPath.style.display     = 'none';
                if (this.ui.svgAntsPathBack) this.ui.svgAntsPathBack.style.display = 'none';
                const clipRect = this.ui.svgAntsClipRect;
                if (clipRect) {
                    clipRect.setAttribute('width',  '0');
                    clipRect.setAttribute('height', '0');
                }
            },
            async magicWandSelectAsync(startX, startY, tolerance = 0, op = 'replace', baseImageData = null) {
                const width = this.config.width;
                const height = this.config.height;
                if (startX < 0 || startY < 0 || startX >= width || startY >= height) return;
                const imageData = baseImageData || this.ctx.getImageData(0, 0, width, height);
                const data = imageData.data;
                const startIdx = (Math.floor(startY) * width + Math.floor(startX)) * 4;
                const tr = data[startIdx], tg = data[startIdx + 1], tb = data[startIdx + 2], ta = data[startIdx + 3];
                const jobId = ++this.state.wandJobId;

                let visited = this.state.wandVisited;
                if (!visited || visited.length !== width * height) {
                    visited = new Uint8Array(width * height);
                    this.state.wandVisited = visited;
                } else {
                    visited.fill(0);
                }

                const diff = this.state.wandDiff;
                const useDiff = diff && diff.length === width * height;
                const match = (idx, vi) => {
                    if (useDiff) return diff[vi] <= tolerance;
                    if (Math.abs(data[idx] - tr) > tolerance) return false;
                    if (Math.abs(data[idx + 1] - tg) > tolerance) return false;
                    if (Math.abs(data[idx + 2] - tb) > tolerance) return false;
                    if (Math.abs(data[idx + 3] - ta) > tolerance) return false;
                    return true;
                };

                let mask = this.state.wandMaskCanvas;
                let mimg = this.state.wandMaskImageData;
                let mctx = null;
                if (!mask || mask.width !== width || mask.height !== height) {
                    mask = document.createElement('canvas');
                    mask.width = width; mask.height = height;
                    mctx = mask.getContext('2d', { willReadFrequently: true });
                    mimg = mctx.createImageData(width, height);
                    this.state.wandMaskCanvas = mask;
                    this.state.wandMaskImageData = mimg;
                } else {
                    mctx = mask.getContext('2d', { willReadFrequently: true });
                    mimg = this.state.wandMaskImageData;
                }
                const md = mimg.data;
                md.fill(0);

                const yieldEvery = 32;
                if (this.config.wandMode === 'global') {
                    for (let y = 0; y < height; y++) {
                        if (this.state.wandJobId !== jobId) return;
                        for (let x = 0; x < width; x++) {
                            const idx = (y * width + x) * 4;
                            const vi = y * width + x;
                            if (match(idx, vi)) {
                                md[idx] = 0; md[idx + 1] = 0; md[idx + 2] = 0; md[idx + 3] = 255;
                                visited[vi] = 1;
                            }
                        }
                        if (y % yieldEvery === 0) {
                            await new Promise(requestAnimationFrame);
                        }
                    }
                } else {
                    const stack = [{ x: Math.floor(startX), y: Math.floor(startY) }];
                    let steps = 0;
                    while (stack.length) {
                        if (this.state.wandJobId !== jobId) return;
                        const { x, y } = stack.pop();
                        if (x < 0 || y < 0 || x >= width || y >= height) continue;
                        const vi = y * width + x;
                        if (visited[vi]) continue;
                        const idx = vi * 4;
                        if (!match(idx, vi)) continue;
                        visited[vi] = 1;
                        md[idx] = 0; md[idx + 1] = 0; md[idx + 2] = 0; md[idx + 3] = 255;
                        stack.push({ x: x + 1, y });
                        stack.push({ x: x - 1, y });
                        stack.push({ x, y: y + 1 });
                        stack.push({ x, y: y - 1 });
                        steps++;
                        if (steps % 20000 === 0) {
                            await new Promise(requestAnimationFrame);
                        }
                    }
                }
                if (this.state.wandJobId !== jobId) return;
                mctx.putImageData(mimg, 0, 0);
                this.applyMaskSelection(mask, op, imageData, false, { source: 'wand' });
            }
    });
})();
