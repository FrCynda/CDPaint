/* history — moved verbatim off the PaintEngine class body.
 *
 * Assigned onto the prototype, so `this` is the same PaintEngine instance
 * these methods have always run against. Loads after paint-engine.js and
 * before boot.js, which is where the instance is finally created.
 */
(function () {
    Object.assign(PaintEngine.prototype, {
            initHistoryLimitControls() {
                const savedEnabled = this.lsGet('paint.history.limit.enabled');
                const savedLimit = parseInt(this.lsGet('paint.history.limit.value') || '', 10);
                if (savedEnabled !== null) this.historyLimitEnabled = savedEnabled === 'true';
                if (Number.isFinite(savedLimit) && savedLimit >= 1) this.historyLimit = savedLimit;
                // The old "Adaptive" checkbox guessed a step count from canvas size.
                // Memory is measured directly now, so it reported a number that no
                // longer moved. Retired, and anyone who had it on gets their own
                // limit back rather than a value it had overwritten.
                this._historyAdaptive = false;

                const toggle = document.getElementById('history-limit-toggle');
                const input = document.getElementById('history-limit-input');

                if (toggle) {
                    toggle.checked = this.historyLimitEnabled;
                    toggle.addEventListener('change', () => this.setHistoryLimitEnabled(toggle.checked));
                }
                if (input) {
                    input.value = this.historyLimit;
                    input.addEventListener('change', () => this.setHistoryLimit(input.value, true, true));
                }

                this.setHistoryLimitEnabled(this.historyLimitEnabled, false);
                this.updateHistoryUsage();
            },

            // Show what history is actually holding. This is the quantity that
            // governs — the step count is only a ceiling — and nothing in the UI
            // reported it before.
            updateHistoryUsage() {
                const el = document.getElementById('history-usage');
                if (!el) return;
                const steps  = Array.isArray(this.state.history) ? this.state.history.length : 0;
                const bytes  = this.historyBytes();
                const budget = this.historyByteBudget();
                const fmt = (b) => b >= 1024 * 1024 * 1024
                    ? (b / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
                    : (b >= 1024 * 1024 ? Math.round(b / (1024 * 1024)) + ' MB'
                                        : Math.max(1, Math.round(b / 1024)) + ' KB');
                el.textContent = `${steps.toLocaleString()} held · ${fmt(bytes)} of ${fmt(budget)}`;
                const ratio = budget > 0 ? bytes / budget : 0;
                el.classList.toggle('is-high', ratio >= 0.6 && ratio < 0.9);
                el.classList.toggle('is-full', ratio >= 0.9);
            },

            // Called from the paths that change history; coalesced so a fast stroke
            // sequence does not walk the whole history list per step.
            scheduleHistoryUsage() {
                if (this._historyUsageRaf) return;
                this._historyUsageRaf = requestAnimationFrame(() => {
                    this._historyUsageRaf = null;
                    try { this.updateHistoryUsage(); } catch (_) {}
                });
            },
            setHistoryLimitEnabled(enabled, trimNow = true) {
                this.historyLimitEnabled = !!enabled;
                this.lsSet('paint.history.limit.enabled', this.historyLimitEnabled ? 'true' : 'false');
                const toggle = document.getElementById('history-limit-toggle');
                if (toggle) toggle.checked = this.historyLimitEnabled;
                this._syncHistoryLimitInput();
                if (trimNow) this.enforceHistoryLimit();
            },
            setHistoryLimit(value, trimNow = true, fromUser = false) {
                let limit = parseInt(value, 10);
                if (!Number.isFinite(limit) || limit < 1) limit = this.historyLimit;
                this.historyLimit = limit;
                if (fromUser) this.lsSet('paint.history.limit.value', String(limit));
                const input = document.getElementById('history-limit-input');
                if (input && !input.disabled) input.value = limit;
                if (trimNow) this.enforceHistoryLimit();
            },
            _syncHistoryLimitInput() {
                const input = document.getElementById('history-limit-input');
                if (input) {
                    input.disabled = !this.historyLimitEnabled;
                    input.value = this.historyLimit;
                }
            },
            // Retained so anything still calling it is harmless. The setting is gone:
            // history is bounded by measured bytes, not by a count guessed from
            // canvas size. See updateHistoryUsage().
            setHistoryAdaptive(on) {
                this._historyAdaptive = false;
            },
            // Count ceiling only, and a loose one: memory is governed by the byte
            // budget below, which measures what history is actually holding. This
            // used to model every entry as a full-canvas snapshot (W*H*4) and so
            // allowed 8 steps on an 8000² document, where a real step costs
            // kilobytes. A ceiling still exists so the array cannot grow without
            // bound in a long session, but it should not be what you hit first.
            historyHardCap(width, height) {
                return 10000;
            },

            // Entries to keep for a document of the given size, honouring the user's
            // limit setting and the count ceiling.
            historyBudgetFor(width, height) {
                return this.historyLimitEnabled
                    ? Math.max(1, this.historyLimit || 1)
                    : this.historyHardCap(width, height);
            },

            // How much memory history may hold. deviceMemory is coarse and most
            // browsers cap it at 8, so treat it as a hint rather than a measurement.
            historyByteBudget() {
                const gb = navigator.deviceMemory || 8;
                const quarter = gb * 0.25 * 1024 * 1024 * 1024;
                return Math.max(256 * 1024 * 1024, Math.min(2 * 1024 * 1024 * 1024, quarter));
            },

            // Bytes an entry newly owns. Anything shared with an earlier entry —
            // an unchanged tile, a layer snapshot reached through a ref — belongs to
            // whoever owns it, and counting it twice would evict far too eagerly.
            _entryBytes(entry) {
                if (!entry) return 0;
                if (typeof entry._bytes === 'number') return entry._bytes;
                let bytes = 0;
                if (entry.tiles) {
                    // Every step holds one array slot per tile whether or not that
                    // tile changed, and a big canvas has thousands of them. Counting
                    // only the pixel data made a 13000px document look almost free
                    // when each step really costs ~80 KB of bookkeeping.
                    // Only the tiles this entry actually holds — a delta holds just
                    // what changed. This is the fallback for an entry captured
                    // without a recorded cost; it treats every tile it holds as
                    // owned, so it over-counts a shared one and errs towards
                    // trimming early rather than late.
                    bytes += entry.tiles.length * 8 + 64;
                    for (const t of entry.tiles) bytes += 48 + (t.rle ? t.rle.length : 0);
                } else if (entry.snaps) {
                    for (const sv of entry.snaps) {
                        if (sv.ref) continue;
                        const c = sv.snap || sv.bitmap;
                        if (c) bytes += (c.width || 0) * (c.height || 0) * 4;
                        if (sv.mask && sv.mask.canvas) {
                            bytes += sv.mask.canvas.width * sv.mask.canvas.height * 4;
                        }
                    }
                } else {
                    bytes = (entry.width || 0) * (entry.height || 0) * 4;
                }
                // A project asset's step also carries its index map. Shared arrays
                // belong to the step that first held them; see attachProjectStep.
                if (entry.projectIndices && !entry._sharesIndices) bytes += entry.projectIndices.length;
                entry._bytes = bytes;
                return bytes;
            },

            historyBytes(target) {
                const h = (target || this.state).history;
                if (!Array.isArray(h)) return 0;
                let total = 0;
                for (const e of h) total += this._entryBytes(e);
                return total;
            },

            // Drop the oldest entries of `target` ({history, step}) until it is
            // within both the count limit and the byte budget. Works on the live
            // state or on a background tab's stored document. Returns how many
            // entries were evicted.
            _trimHistoryTarget(target, maxEntries, byteBudget) {
                if (!target || !Array.isArray(target.history)) return 0;
                // Always keep some undo, however large the document: a byte
                // budget that leaves you with one step is not an undo system.
                const minSteps = this.HISTORY_MIN_STEPS || 8;
                let overflow = Math.max(0, target.history.length - maxEntries);

                if (byteBudget > 0) {
                    let bytes = 0;
                    for (let i = overflow; i < target.history.length; i++) {
                        bytes += this._entryBytes(target.history[i]);
                    }
                    while (bytes > byteBudget &&
                           target.history.length - overflow > minSteps) {
                        bytes -= this._entryBytes(target.history[overflow]);
                        overflow++;
                    }
                }
                if (overflow <= 0) return 0;

                const evicted = target.history.splice(0, overflow);
                // The oldest survivor may be a delta on an entry we just dropped.
                // Flatten it while the dropped entries are still reachable, or its
                // tiles resolve to nothing and undo restores a blank canvas.
                if (target.history.length) this._anchorEntry(target.history[0]);
                // Survivors first: eviction must not close pixels they still ref.
                this._releaseHistoryEntries(evicted, target.history);
                target.step = Math.max(-1, (target.step || 0) - overflow);
                return overflow;
            },

            enforceHistoryLimit() {
                const overflow = this._trimHistoryTarget(
                    this.state,
                    this.historyBudgetFor(this.config.width, this.config.height),
                    this.historyByteBudget()
                );
                if (!overflow) return;
                if (typeof this.state.selectionCutStep === 'number') {
                    this.state.selectionCutStep -= overflow;
                    if (this.state.selectionCutStep < 0) this.state.selectionCutStep = null;
                }
                this.updateTitleBarActions();
            },

            // Trim a document that isn't currently on screen (a background tab).
            // Same ceiling as the live document, sized to *that* document's canvas.
            trimBackgroundHistory(docState, width, height) {
                return this._trimHistoryTarget(
                    docState,
                    this.historyBudgetFor(width, height),
                    this.historyByteBudget()
                );
            },
            canUndo() {
                return this.state.curvePhase > 0 || !!this.state.activeShape || this.state.step > 0 || (typeof FreehandPathEngine !== 'undefined' && FreehandPathEngine.isActive());
            },
            canRedo() {
                return !!this.state.curveUndo || !!this.state.activeShapeUndo || this.state.step < this.state.history.length - 1;
            },
            getColorCustomizerSnapshot() {
                return {
                    overrides: Object.assign({}, this.colorOverrides || {}),
                    fileTabPresetColor: this.fileTabPresetColor || null
                };
            },
            pushColorCustomizerHistory(entry) {
                if (!entry) return;
                const maxEntries = 300;
                this.colorCustomizerHistory.push(entry);
                if (this.colorCustomizerHistory.length > maxEntries) {
                    this.colorCustomizerHistory.splice(0, this.colorCustomizerHistory.length - maxEntries);
                }
                this.updateColorCustomizerUndoUi();
            },
            restoreColorCustomizerSnapshot(snapshot) {
                if (!snapshot || typeof snapshot !== 'object') return;
                this.colorOverrides = Object.assign({}, snapshot.overrides || {});
                this.fileTabPresetColor = snapshot.fileTabPresetColor || null;
                this.saveColorOverrides();
                this.applyColorOverrides();
                this.refreshColorCustomizerUI();
                this.applyColorSearchFilter((document.getElementById('color-customizer-search') || {}).value || '');
                this.updateColorCustomizerEditor();
            },
            undoLastColorCustomizerChange() {
                const entry = this.colorCustomizerHistory && this.colorCustomizerHistory.length
                    ? this.colorCustomizerHistory.pop()
                    : null;
                if (!entry) {
                    this.updateColorCustomizerUndoUi();
                    return;
                }
                if (entry.type === 'snapshot') {
                    this.restoreColorCustomizerSnapshot(entry.prevSnapshot);
                    this.updateColorCustomizerUndoUi();
                    return;
                }
                if (entry.type === 'token') {
                    if (entry.prev === null || entry.prev === undefined) delete this.colorOverrides[entry.key];
                    else this.colorOverrides[entry.key] = entry.prev;
                    this.saveColorOverrides();
                    this.applyColorOverrides();
                    this.refreshColorCustomizerUI();
                    this.applyColorSearchFilter((document.getElementById('color-customizer-search') || {}).value || '');
                    this.selectColorCustomizerKey(entry.key, { keepScroll: true });
                }
                this.updateColorCustomizerUndoUi();
            },
            updateColorCustomizerUndoUi() {
                const btn = document.getElementById('color-customizer-undo-btn');
                if (!btn) return;
                btn.disabled = !(this.colorCustomizerHistory && this.colorCustomizerHistory.length);
            },
            debugDumpHistory() {
                console.log('PaintApp history', {
                    size: this.state.history ? this.state.history.length : 0,
                    step: this.state.step,
                    limitEnabled: this.historyLimitEnabled,
                    limit: this.historyLimit
                });
            },
            _anchorEntry(entry) {
                if (!entry || !entry.tiles || !entry.base) return;
                entry.tiles = Array.from(this._resolveTiles(entry).values());
                entry.base = null;
                entry._chain = 0;
                // It now owns everything it holds, so the cached cost is stale.
                entry._bytes = undefined;
                this._entryBytes(entry);
            },

            restoreHistoryEntry(entry, stepIdx) {
                this.flushDeferredSave();
                // The canvas is about to be replaced from history, so nothing known
                // about what changed since the last step still applies.
                this.markAllDirty();
                this.setSize(entry.width, entry.height);
                this.disableSmoothing(this.ctx);
                if (entry.tiles) {
                    this.ctx.clearRect(0, 0, entry.width, entry.height);
                    this.applyTiledSnapshot(entry);
                } else if (entry.bitmap) {
                    this.ctx.clearRect(0, 0, entry.width, entry.height);
                    this.ctx.drawImage(entry.bitmap, 0, 0);
                } else if (entry.canvas) {
                    this.ctx.drawImage(entry.canvas, 0, 0);
                }
                this.restoreProjectStep(entry);
            },
            // Layered history entries reference unchanged layers from an *earlier*
            // entry instead of re-cloning them (the saveState installed by
            // installLayerSystem, at the foot of this file, builds { ref: prevSnap }
            // snaps). Walk every surviving entry's ref chains and
            // collect the owned snaps they terminate at, so eviction can tell
            // "nothing points here any more" from "an older entry owns the pixels a
            // newer entry still displays".
            _collectOwnedSnapsInUse(entries) {
                const inUse = new Set();
                if (!entries) return inUse;
                for (const e of entries) {
                    if (!e || !e.snaps) continue;
                    for (const sv of e.snaps) {
                        let s = sv;
                        while (s.ref) s = s.ref;
                        // s === sv means this entry owns its own snap; only a chain
                        // that walked somewhere else pins a foreign entry's pixels.
                        if (s !== sv) inUse.add(s);
                    }
                }
                return inUse;
            },

            // Release entries being dropped from the history, without closing image
            // data that any surviving entry still resolves to. Closing a shared
            // ImageBitmap leaves later undo steps drawing from a detached bitmap,
            // which throws and strands the document mid-undo.
            _releaseHistoryEntries(evicted, survivors) {
                if (!evicted || !evicted.length) return;
                const inUse = this._collectOwnedSnapsInUse(survivors);
                // Masks are shared directly rather than through a ref chain, so a
                // survivor can point at an evicted entry's mask object. Collect
                // those separately or freeing one blanks a mask still in use.
                const masksInUse = new Set();
                for (const e of (survivors || [])) {
                    if (!e || !e.snaps) continue;
                    for (const sv of e.snaps) if (sv.mask) masksInUse.add(sv.mask);
                }
                const drop = (canvas) => {
                    // Zeroing frees the pixel buffer immediately; dropping the
                    // reference alone leaves it to the collector.
                    if (canvas) { try { canvas.width = 0; canvas.height = 0; } catch (_) {} }
                };
                for (const entry of evicted) {
                    if (!entry) continue;
                    if (entry.bitmap) {
                        try { entry.bitmap.close(); } catch (_) {}
                        entry.bitmap = null;
                    }
                    drop(entry.canvas);
                    entry.canvas = null;
                    if (!entry.snaps) continue;
                    for (const sv of entry.snaps) {
                        if (sv.mask && !masksInUse.has(sv.mask)) {
                            drop(sv.mask.canvas);
                            sv.mask = null;
                        }
                        if (sv.ref) continue;        // this entry is not the owner
                        if (inUse.has(sv)) continue; // a survivor still resolves here
                        if (sv.bitmap) {
                            try { sv.bitmap.close(); } catch (_) {}
                            sv.bitmap = null;
                        }
                        drop(sv.snap);
                        sv.snap = null;
                    }
                }
            },

            // Release GPU-side ImageBitmap objects stored in a history entry.
            // Ref snaps don't own their bitmap — skip them.
            // Only safe when the whole history is going away; use
            // _releaseHistoryEntries() when other entries survive.
            _closeBitmapEntry(entry) {
                if (!entry) return;
                if (entry.bitmap) { try { entry.bitmap.close(); } catch (_) {} }
                if (entry.snaps) {
                    for (const sv of entry.snaps) {
                        if (!sv.ref && sv.bitmap) { try { sv.bitmap.close(); } catch (_) {} sv.bitmap = null; }
                    }
                }
            },
            resetHistoryBaseline() {
                // Detach without releasing: this array may already be owned by a tab
                // record (the tab system calls this precisely when a document path
                // reused the previous history array). Closing its bitmaps would
                // strand that tab. The tab system frees entries when a tab closes.
                this.state.history = [];
                this.state.step = -1;
                this.saveState();
                this.markClean();
                this.updateTitleBarActions();
            },
            undo() {
                this.flushDeferredSave();
                if (this.state.isDrawing && this.config.tool === 'paintbrush') return;
                // For an active Magic Wand selection, cancel it silently (do NOT commit
                // pixels to the canvas) so the canvas snapshot in history remains the
                // authoritative source.  This enables step-by-step wand undo: each Ctrl+Z
                // peels back one wand click and the wandSelSnap stored in the history entry
                // restores the previous accumulated selection state.
                if (this.state.selection) {
                    if (this.state.selection.source === 'wand' || this.state.selection.source === 'wand-palette' || this.state.selection.source === 'smart-brush') {
                        this._clearWandSelectionSilent();
                    } else {
                        this.commitSelection();
                    }
                }
                this.cancelPendingStrokes();
                this.state.curveUndo = null;
                this.state.activeShapeUndo = null;
                if (FreehandPathEngine.isActive()) {
                    FreehandPathEngine.cancel();
                    this.state.freehandPathActive = false;
                    this.state.isDirty = true;
                    this.updateTitleBarActions();
                    return;
                }
                if (this.state.curvePhase > 0) {
                    this.state.curveUndo = {
                        curvePhase: this.state.curvePhase,
                        curvePts: this.state.curvePts.map(p => ({ x: p.x, y: p.y })),
                        startPos: this.state.startPos ? { x: this.state.startPos.x, y: this.state.startPos.y } : null,
                        isDrawing: this.state.isDrawing
                    };
                    this.state.curvePhase = 0;
                    this.state.curvePts = [];
                    this.state.isDrawing = false;
                    this.ctxTemp.clearRect(0,0,this.config.width, this.config.height);
                    this.state.isDirty = true;
                    this.updateTitleBarActions();
                    return;
                }
                if(this.state.activeShape) {
                    this.ctxTemp.clearRect(0,0,this.config.width, this.config.height);
                    this.state.activeShapeUndo = this.state.activeShape;
                    this.state.activeShape = null;
                    this.state.shapeEditMode = false;
                    this.ui.selControls.style.display = 'none';
                    this.clearStatusSelectionSize();
                    this.requestGlobalOverlayUpdate();
                    this.state.isDirty = true;
                    this.updateTitleBarActions();
                    return;
                }
                if(this.state.step>0) {
                    this.state.step--;
                    const d=this.state.history[this.state.step];
                    this.beginOperation();
                    this.restoreHistoryEntry(d, this.state.step);
                    this.endOperation();
                    // Restore a wand selection that was active at this history step, allowing
                    // the user to see the marching ants come back one click at a time.
                    if (d.wandSelSnap) {
                        this._restoreWandSelSnap(d.wandSelSnap);
                    }
                    this.requestGlobalOverlayUpdate();
                    this.deferColorCounts();
                    this.state.isDirty = true;
                }
                this.updateTitleBarActions();
            },
            redo() {
                this.flushDeferredSave();
                if (this.state.isDrawing && this.config.tool === 'paintbrush') return;
                this.cancelPendingStrokes();
                if (this.state.activeShapeUndo) {
                    const shape = this.state.activeShapeUndo;
                    this.state.activeShapeUndo = null;
                    this.state.activeShape = shape;
                    this.state.shapeEditMode = true;
                    this.renderActiveShape();
                    this.state.isDirty = true;
                    this.updateTitleBarActions();
                    return;
                }
                if (this.state.curveUndo) {
                    const draft = this.state.curveUndo;
                    this.state.curveUndo = null;
                    if (this.config.tool !== 'curve') this.setTool('curve');
                    this.state.curvePhase = draft.curvePhase;
                    this.state.curvePts = draft.curvePts.map(p => ({ x: p.x, y: p.y }));
                    if (draft.startPos) this.state.startPos = { x: draft.startPos.x, y: draft.startPos.y };
                    this.state.isDrawing = draft.isDrawing;
                    this.ctxTemp.clearRect(0,0,this.config.width, this.config.height);
                    this.state.isDirty = true;
                    this.updateTitleBarActions();
                    return;
                }
                if(this.state.step<this.state.history.length-1) {
                    if (this.state.selection) {
                        this._freeSelectionGlTex(this.state.selection); this.state.selection = null;
                        this.ui.selControls.style.display = 'none';
                        this.clearStatusSelectionSize();
                        this.ctxTemp.clearRect(0,0,this.config.width, this.config.height);
                        this.requestGlobalOverlayUpdate();
                        this.state.selectionCutStep = null;
                    }
                    this.state.step = Math.min(this.state.history.length-1, this.state.step + 1);
                    const d=this.state.history[this.state.step];
                    this.beginOperation();
                    this.restoreHistoryEntry(d, this.state.step);
                    this.endOperation();
                    // Re-apply the wand selection that was alive at this history step so that
                    // Ctrl+Y re-adds selections one click at a time (mirror of step-by-step undo).
                    if (d.wandSelSnap) {
                        this._restoreWandSelSnap(d.wandSelSnap);
                    }
                    this.requestGlobalOverlayUpdate();
                    this.deferColorCounts();
                    this.state.isDirty = true;
                }
                this.updateTitleBarActions();
            }
    });
})();
