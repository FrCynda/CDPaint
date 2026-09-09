/* viewport — moved verbatim off the PaintEngine class body.
 *
 * Assigned onto the prototype, so `this` is the same PaintEngine instance
 * these methods have always run against. Loads after paint-engine.js and
 * before boot.js, which is where the instance is finally created.
 */
(function () {
    Object.assign(PaintEngine.prototype, {
            requestGridOverlayUpdate() {
                if (this._gridOverlayRaf) return;
                this._gridOverlayRaf = requestAnimationFrame(() => {
                    this._gridOverlayRaf = null;
                    this.updateGridOverlay();
                });
            },

            updateGridOverlay() {
                if (this._gridOverlayRaf) {
                    cancelAnimationFrame(this._gridOverlayRaf);
                    this._gridOverlayRaf = null;
                }
                this.updateTileOverlay();
                if (!this.ui.gridOverlay) return;
                if (!this.gridlinesEnabled || this.gridlinesSize <= 0) {
                    this.ui.gridOverlay.style.display = 'none';
                    this._gridOverlayCacheKey = '';
                    return;
                }
                this.ui.gridOverlay.style.display = 'block';
                this.ui.gridOverlay.style.width = window.innerWidth + 'px';
                this.ui.gridOverlay.style.height = window.innerHeight + 'px';
                const stageRect = this.ui.stage ? this.ui.stage.getBoundingClientRect() : null;
                if (!stageRect) return;
                const viewW = Math.max(1, Math.round(window.innerWidth));
                const viewH = Math.max(1, Math.round(window.innerHeight));
                this.ui.gridOverlay.setAttribute('width', String(viewW));
                this.ui.gridOverlay.setAttribute('height', String(viewH));
                this.ui.gridOverlay.setAttribute('viewBox', `0 0 ${viewW} ${viewH}`);
                const lines = this.ui.gridLines;
                const clipRect = this.ui.gridClipRect;
                const left = Math.round(stageRect.left);
                const top = Math.round(stageRect.top);
                const right = Math.round(stageRect.right);
                const bottom = Math.round(stageRect.bottom);
                const clipLeft = Math.max(0, left);
                const clipTop = Math.max(0, top);
                const clipRight = Math.min(viewW, right);
                const clipBottom = Math.min(viewH, bottom);
                const clipWidth = Math.max(0, clipRight - clipLeft);
                const clipHeight = Math.max(0, clipBottom - clipTop);
                if (clipRect) {
                    clipRect.setAttribute('x', String(clipLeft));
                    clipRect.setAttribute('y', String(clipTop));
                    clipRect.setAttribute('width', String(clipWidth));
                    clipRect.setAttribute('height', String(clipHeight));
                }
                if (!lines || clipWidth === 0 || clipHeight === 0) {
                    this.ui.gridOverlay.style.display = 'none';
                    this._gridOverlayCacheKey = '';
                    return;
                }
                const step = Math.max(4, this.gridlinesSize * (this.config.zoom || 1));
                const overlayKey = `${viewW}|${viewH}|${left}|${top}|${right}|${bottom}|${step}|${this.gridlinesColor}`;
                if (overlayKey === this._gridOverlayCacheKey) return;
                this._gridOverlayCacheKey = overlayKey;
                lines.style.display = 'block';
                // Build a single <path> instead of individual <line> elements.
                // This drops N DOM node create/destroy operations to one setAttribute call,
                // eliminating the main-thread stall during zoom/pan on dense grids.
                let d = '';
                for (let x = left; x <= right; x += step) {
                    const px = Math.round(x);
                    d += `M${px},${top} L${px},${bottom} `;
                }
                for (let y = top; y <= bottom; y += step) {
                    const py = Math.round(y);
                    d += `M${left},${py} L${right},${py} `;
                }
                // Replace all children with a single <path>
                lines.innerHTML = '';
                if (d) {
                    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    path.setAttribute('d', d.trimEnd());
                    path.setAttribute('stroke', this.gridlinesColor);
                    path.setAttribute('stroke-width', '1');
                    path.setAttribute('fill', 'none');
                    path.setAttribute('stroke-dasharray', '4 4');
                    lines.appendChild(path);
                }
            },
            initTabScrollSwitch() {
                const tabRow = document.querySelector('.tab-row');
                const ribbon = document.getElementById('ribbon');
                const ribbonView = document.getElementById('ribbon-view');
                const ribbonDebug = document.getElementById('ribbon-debug');
                const ribbonThemes = document.getElementById('ribbon-themes');
                const targets = [tabRow, ribbon, ribbonView, ribbonThemes, ribbonDebug].filter(Boolean);
                if (!targets.length) return;
                const order = ['home', 'view', 'themes', 'debug'];
                const handler = (e) => {
                    if (e.ctrlKey) return;
                    if (e.target && e.target.closest('input, textarea, select, .dropdown-menu')) return;
                    const delta = e.deltaY || e.deltaX || 0;
                    if (!delta) return;
                    const now = performance.now();
                    if (now - this._tabWheelAt < 40) {
                        e.preventDefault();
                        return;
                    }
                    this._tabWheelAt = now;
                    const dir = delta > 0 ? 1 : -1;
                    const active = document.querySelector('.tab-row .tab.active');
                    let current = active && active.id ? active.id.replace('tab-', '') : 'home';
                    let idx = order.indexOf(current);
                    if (idx === -1) idx = 0;
                    const next = idx + dir;
                    if (next >= 0 && next < order.length) {
                        this.setActiveTab(order[next]);
                    }
                    e.preventDefault();
                };
                targets.forEach(target => target.addEventListener('wheel', handler, { passive: false }));
            },
            setZoom(d, focusEvent = null){
                const currentZoom = this.config.zoom;
                let focus = null;
                const vpRect = this.ui.viewport ? this.ui.viewport.getBoundingClientRect() : null;
                const prevStageRect = (!this.config.anchorCanvas && this.ui.stage && vpRect)
                    ? this.ui.stage.getBoundingClientRect()
                    : null;
                const stageRect = (this.ui.stage) ? this.ui.stage.getBoundingClientRect() : null;
                const useMouseFocus = focusEvent && this.ui.viewport && stageRect
                    && (!this.config.anchorCanvas || this.config.tool === 'zoom');
                const useTopLeftFocus = focusEvent && this.ui.viewport && stageRect
                    && this.config.anchorCanvas && this.config.tool !== 'zoom';
                if (useMouseFocus) {
                    const cx = (focusEvent.clientX - stageRect.left) / currentZoom;
                    const cy = (focusEvent.clientY - stageRect.top) / currentZoom;
                    focus = {
                        cx,
                        cy,
                        mouseX: focusEvent.clientX,
                        mouseY: focusEvent.clientY,
                        vpRect
                    };
                } else if (useTopLeftFocus) {
                    focus = {
                        cx: 0,
                        cy: 0,
                        mouseX: stageRect.left,
                        mouseY: stageRect.top,
                        vpRect
                    };
                }

                const current = currentZoom * 100;
                let idx = 0;
                let min = Infinity;
                for(let i=0; i<this.zoomLevels.length; i++) {
                    const diff = Math.abs(this.zoomLevels[i] - current);
                    if(diff < min) { min = diff; idx = i; }
                }

                if (d > 0) idx++; else idx--;
                if (idx < 0) idx = 0;
                if (idx >= this.zoomLevels.length) idx = this.zoomLevels.length - 1;

                this.config.zoom = this.zoomLevels[idx] / 100;
                if (this.ui.statusZoom) this.ui.statusZoom.textContent = this.zoomLevels[idx] + '%';
                document.documentElement.style.setProperty('--zoom', this.config.zoom);
                document.documentElement.style.setProperty('--zoom-inv', (1 / (this.config.zoom || 1)).toString());
                this.applyStageTransform();
                if (focus && this.ui.viewport) {
                    const newZoom = this.config.zoom;
                    if (this.config.anchorCanvas) {
                        const relX = focus.mouseX - focus.vpRect.left;
                        const relY = focus.mouseY - focus.vpRect.top;
                        const newScrollLeft = Math.max(0, Math.round((focus.cx * newZoom) - relX));
                        const newScrollTop = Math.max(0, Math.round((focus.cy * newZoom) - relY));
                        this.ui.viewport.scrollLeft = newScrollLeft;
                        this.ui.viewport.scrollTop = newScrollTop;
                    } else {
                        const rect = this.ui.stage.getBoundingClientRect();
                        const desiredLeft = focus.mouseX - (focus.cx * newZoom);
                        const desiredTop = focus.mouseY - (focus.cy * newZoom);
                        const dx = desiredLeft - rect.left;
                        const dy = desiredTop - rect.top;
                        if (dx || dy) {
                            this.state.canvasOffset = {
                                x: (this.state.canvasOffset?.x || 0) + dx,
                                y: (this.state.canvasOffset?.y || 0) + dy
                            };
                            this.applyStageTransform();
                        }
                    }
                }
                this.updateViewportScrollability();
                this.clampViewportScroll();
                if (prevStageRect && vpRect && this.rectsIntersect(prevStageRect, vpRect)) {
                    this.ensureCanvasVisible(vpRect);
                }
                if(this.state.selection) this.renderSelection();
                if(this.state.activeShape) this.renderActiveShape();
                // Redraw gradient handles at new zoom — they must stay fixed screen-pixel size
                if (this.config.tool === 'gradient' && this.config.gradient.active) this._gradientDrawVectorSVG();
                this.requestGlobalOverlayUpdate();
                this.updateBounds();
                this.updateGridOverlay();
            },
            _updateSidebarViewportShift(smoothHandles) {
                const anyOpen = (document.getElementById('unified-sidebar')?.classList.contains('hidden') === false) ||
                    document.getElementById('freehand-sidebar')?.classList.contains('open') ||
                    document.getElementById('paintbrush-sidebar')?.classList.contains('open') ||
                    document.getElementById('gradient-sidebar')?.classList.contains('open') ||
                    document.getElementById('project-panel')?.classList.contains('open');
                const shift = this.config.anchorCanvas && anyOpen ? 290 : 0;
                // Lets the collapsed panels' edge tabs step aside for whichever
                // panel is open — see .left-flyout-open in the stylesheet.
                document.body.classList.toggle('left-flyout-open', !!anyOpen);
                if (!this.ui.viewport) return;
                this.ui.viewport.classList.toggle('sidebar-open', shift !== 0);
                // The panel slides the canvas over a CSS transition, so the canvas is
                // in a new place every frame until it lands. Follow it frame by frame
                // rather than jumping the handles to where the canvas is predicted to
                // end up — a prediction is wrong the instant a second toggle
                // interrupts the first, which is what spamming a tool button does.
                if (smoothHandles && this._startupSettled) {
                    this._followCanvasWhileShifting();
                } else {
                    this.updateBounds();
                    this.requestGlobalOverlayUpdate();
                }
            },
            /* Pin the handles to the canvas for as long as a panel is sliding it.
               Each new toggle pushes the deadline out, so an interrupted slide is
               followed just as closely as one that runs to completion. */
            updateViewportScrollability() {
                if (!this.ui.viewport) return;
                if (!this.config.anchorCanvas) {
                    this.ui.viewport.style.overflowX = 'hidden';
                    this.ui.viewport.style.overflowY = 'hidden';
                    return;
                }
                const zoom = this.config.zoom || 1;
                const stageW = this.config.width * zoom;
                const stageH = this.config.height * zoom;
                const sidebarOff = this.ui.viewport.classList.contains('sidebar-open') ? 290 : 0;
                const vpW = this.ui.viewport.clientWidth - sidebarOff;
                const vpH = this.ui.viewport.clientHeight;
                const needsX = stageW > vpW;
                const needsY = stageH > vpH;
                this.ui.viewport.style.overflowX = needsX ? 'auto' : 'hidden';
                this.ui.viewport.style.overflowY = needsY ? 'auto' : 'hidden';
                this.clampViewportScroll();
            },
            clampViewportScroll() {
                if (!this.ui.viewport || !this.config.anchorCanvas) return;
                const maxX = Math.max(0, Math.round(this.ui.viewport.scrollWidth - this.ui.viewport.clientWidth));
                const maxY = Math.max(0, Math.round(this.ui.viewport.scrollHeight - this.ui.viewport.clientHeight));
                const nextLeft = Math.min(maxX, Math.max(0, this.ui.viewport.scrollLeft));
                const nextTop = Math.min(maxY, Math.max(0, this.ui.viewport.scrollTop));
                if (nextLeft !== this.ui.viewport.scrollLeft) this.ui.viewport.scrollLeft = nextLeft;
                if (nextTop !== this.ui.viewport.scrollTop) this.ui.viewport.scrollTop = nextTop;
            }
    });
})();
