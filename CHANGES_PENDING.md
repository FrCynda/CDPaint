# Changes Pending

Living release-tracking document for all updates since the latest tag.

- Last tag release: `v1.1.3`
- Current head: `1bc588c`
- Range: `v1.1.3..HEAD` (+ uncommitted paintbrush engine changes)

## Release Prerequisite

Before creating/publishing any new release tag:

1. Update this file with every relevant change since the last tag.
2. Ensure entries are categorized under `Changes`, `Additions`, and `Bug Fixes`.
3. Confirm this file is complete and use it as the source for release notes.

No release should be considered complete without this document being current.

## Changes

- Dramatically improved startup performance:
  - Window now appears immediately from Rust `setup()` hook (no longer waits for JS initialization)
  - Added animated loading bar (thin blue gradient bar at window top) for immediate visual feedback
  - Loading bar auto-fades when PaintEngine constructor completes (`body.app-ready` class)
  - Moved `revealStartupWindow()` earlier in constructor so async file loading doesn't block window show
  - Changed all `<script>` tags to `defer` so HTML/CSS renders before JS downloads/executes
  - Added JS minification to the build step via esbuild (reduces JS payload from ~1.5 MB to ~700 KB)
  - Added Rust release profile optimizations (LTO, strip, codegen-units=1, panic=abort, opt-level=z)
- Updated `Agents.md` with project architecture, test workflow, minimum-viable-code guidelines, script load order, and CHANGES_PENDING.md discipline.
- BristleCount default changed from 10 to 1 so non-bristle presets don't render in bristle mode.
- Rebuilt freehand tool with perfect-freehand path engine â€” preserves prior strokes, adds width ribbon, hides sidebar for other tools, correct options structure with taper/easing, outline rendering, smoothing clamp.
- Updated info modal content.
- Removed brush stroke point cap (freehand tool).
- Added freehand-specific CSS.
- Reworked and simplified README build/install guidance.
- Improved README structure and wording for web demo and browser performance expectations.
- Added automated release asset renaming per version tag.
- Optimized CI triggers to skip full desktop builds on docs-only updates.
- Added workflow concurrency controls to reduce duplicate in-progress builds.
- Added fast `Quick Check` validation job for faster PR feedback.
- Added Phase 1 runtime performance pass in the frontend:
  - coalesced high-frequency overlay refreshes with `requestAnimationFrame`
  - reduced hot-path status DOM churn (coords/zoom/dim/color labels)
  - throttled repeated color-count recomputation bursts
- Added Phase 2 runtime performance pass in the frontend:
  - switched drag-time selection redraw to a frame-coalesced fast path
  - cached selection UI/status writes to skip no-op DOM updates
  - avoided redundant grid/tile SVG rebuilds when overlay geometry is unchanged
- Added Phase 3 runtime performance pass in the frontend:
  - moved color-count status computation to a dedicated worker with safe fallback
  - kept exact color counts while reducing main-thread stalls on larger canvases
- Optimized magic-wand selection ants overlay performance at high zoom:
  - simplified mask outline paths by collapsing collinear segments without changing geometry
  - cached ants SVG path/transform updates to avoid redundant DOM churn while selection state is unchanged
  - clipped ants SVG drawing to the visible stage viewport so off-screen mask edges are not rasterized
  - restored original ants visual animation mode after canvas-rendered ants and stepped timing changed appearance

## Additions

- Added GitHub Pages deployment workflow for browser demo hosting.
- Added desktop window-state persistence:
  - remembers position
  - remembers size
  - restores maximized state on next launch
- Added release gating in CI to require a valid `CHANGES_PENDING.md` before draft release.
- Added freehand path engine (`freehand-path-engine.js`) using perfect-freehand for smooth variable-width strokes with pressure-sensitive taper, easing, and outline rendering.
- Added gradient engine (`src/js/gradient-engine.js`) for gradient fill support.
- Added layer system (`src/js/layer-system.js`) â€” multi-layer canvas compositing with blend modes, opacity, visibility toggles, alpha lock, and layer reordering.
- Added smart shape module (`src/js/smart-shape.js`) for shape recognition and stroke straightening.
- Added opencode configuration (`opencode.json`) with commit-after-changes instructions.
- Added new toolbar icons, ribbon icons, mode icons, and fluent-emoji SVGs.
- Added Krita-compatible dab-based paint brush engine (`krita-brush-engine.js`) with:
  - 10 presets: Round, Calligraphy, Airbrush, Ink, Marker, Watercolor, Charcoal, Splatter, Fan Brush, Dry Brush
  - Airbrush mode with configurable rate
  - Bristle rendering (fan, dry brush)
  - Scatter, texture noise, smudge/color mixing
  - Taper at stroke ends
  - Aspect ratio and rotation for ellipse/calligraphy brushes
  - Dab mask cache with LRU eviction
  - OffscreenCanvas flow buffer with dirty-rect tracking
- Added paintbrush sidebar UI: size, opacity, flow, spacing, hardness, shape, angle, aspect ratio, bristle controls, airbrush toggle, texture, color rate sliders.
- Added paintbrush tool button in toolbar wired to the new engine.

## opencode mode-switch patch

- Patched opencode v1.17.7 source to add `mode` field to custom commands
- Modified files in opencode source (repo cloned to `%TEMP%\opencode\opencode`):
  - `packages/core/src/config/command.ts` â€” added `mode` field to ConfigCommand.Info schema
  - `packages/opencode/src/command/index.ts` â€” added `mode` field to runtime Command.Info and pass-through from config
  - `packages/opencode/src/acp/service.ts` â€” mode-switching commands now call `session.setMode()` instead of sending to server
  - `packages/sdk/js/src/v2/gen/types.gen.ts` â€” added `mode` to SDK Command type
- Built binary replaces installed `opencode.exe`
- Configured `/p` and `/b` commands in `opencode.json` with `mode: true` + `agent: "plan"` / `agent: "build"` â€” these now actually switch the primary agent instead of just sending a chat message
- Install script placed on desktop: `install-opencode-mode-switch.ps1` (run this after any opencode upgrade to re-patch)

## Bug Fixes

- Fixed undo crash in `restoreHistoryEntry` â€” was passing bare `tiles` array to `applyTiledSnapshot` instead of the full entry object (4 call sites). Delta-undo walked back to anchor entries and passed only the tiles array, causing `tiles.filter(...)` to crash on `undefined`.
- Fixed double-rendering artifacts on stroke end â€” final `_flushPending(true)` re-render now clears the destination area (`_dirtyRect`) on the main canvas via `_flushFlowBuffer(ctx, true)` before flushing, preventing old non-tapered dabs from bleeding through the new tapered ones.
- Fixed quarter-circle dab clipping â€” added `ctx.translate(rx, ry)` for non-rotated mask generation path. Circle/ellipse masks were centered at the top-left corner of the mask canvas instead of its center â€” only the +x,+y quadrant was visible.
- Fixed scratch canvas contamination â€” `_colorizeMask` now clears the full scratch canvas (`_scratchCanvas.width Ã— height`) instead of just the current mask dimensions, preventing old pixel data from previous larger dabs bleeding into smaller subsequent dabs.
- Fixed `app.brush` â†’ `this.brush` references in `paint-engine.js` class methods (6 locations across `onMouseDown`, `onMouseMove`, `onMouseUp`, `setTool`, `updateCursorForTool`) to fix `ReferenceError: app is not defined` when the paintbrush tool is active.
- Fixed `_sampleCanvasColor` to accept `CanvasRenderingContext2D` directly instead of a canvas element â€” smudge/color-mixing now works.
- Fixed `_drawCircle` to use `ctx.ellipse()` and `_drawDiamond` with separate sx/sy â€” circle/diamond masks now respect aspect ratio (Calligraphy, Charcoal presets produce ellipses).
- Fixed airbrush timer to call `_renderDab()` instead of `_paintDab()` directly â€” now gets scatter, taper, bristle support and smudge fixes.
- Fixed taper to apply only at stroke finalization (`_flushPending(true)` in `endStroke`). Mid-stroke RAF renders without taper â€” no more visible kinks from changing point count mid-stroke.
- Fixed bristle smudge to sample `app.ctx` (main canvas) instead of `_flowCanvas` flow buffer.
- Fixed force-dab at segment endpoint (`soFar > 0` check) to prevent cut-off stroke tips without double-dabbing.
- Fixed dead params (`smoothing`, `stabilize`, `scatterRadius`, `smudgeLength`, `wetness`) removed from DEFAULTS and from Airbrush/Watercolor/Splatter presets.
- Fixed `_state.isDrawing = false` set before `_stopAirbrush()` â€” prevents extra airbrush dab firing after stroke end.
- Fixed cursor update to cache by brush size (only calls `toDataURL()` when size changes). Added `devicePixelRatio` scaling for Retina displays.
- Fixed hex color cache to LRU (reorders key on access instead of FIFO eviction).
- Fixed dirty rect expansion by 1px on all sides for antialiasing bleed margin.
- Fixed flow buffer and scratch buffers to shrink when requested size is less than half current size.
- Fixed `endStroke` AABB restore â€” clamps source rectangle to canvas bounds to prevent `IndexSizeError` from negative `drawImage` source coordinates. Strokes near the canvas edge were silently skipping the final tapered re-render, leaving the stroke nearly invisible.
- Fixed single-click strokes â€” `_flushPending(true)` now renders a single point directly instead of relying on `_processSegment`, which returns early when `endIdx <= startIdx`.
- Fixed final pass dropping dabs with closely-spaced points â€” `_flushPending(true)` now iterates each consecutive point pair individually instead of processing the full array in a single `_processSegment` call. The old approach let `soFar` accumulate to exactly 0 by the loop exit, suppressing the endpoint force-dab and losing intermediate dabs for slow strokes.
- Fixed cross-platform `file://` path handling for launch/open-file flows (Windows/macOS/Linux).
- Fixed freehand tool to preserve prior strokes after tool switch, wire width ribbon slider, hide sidebar for non-freehand tools.
- Fixed freehand tool options structure, taper/easing interpolation, outline rendering, and smoothing clamp.
- Fixed `willReadFrequently` canvas context warning by adding context attribute.
- Removed startup file-open delay and improved startup file handoff timing.
- Reduced visible startup race where users could draw before incoming file load completed.
- Deferred blank-canvas initialization until startup pending-file hydration resolves, eliminating the brief blank flash when opening images by double-click/file association.
- Fixed startup white/black window flash by keeping windows hidden until frontend theme + initial document hydration complete, then revealing once ready.
- Fixed startup double-open race for launch files by relying on pending-file handoff instead of emitting duplicate startup `open-file` events.
- Fixed startup visibility regression by adding a native `show_current_window` Tauri command and using `invoke` for reliable reveal when JS window APIs are unavailable.
- Fixed flipped selection preview during handle-resize (crossing opposite edge) by correcting preview transform logic and enabling frame-coalesced live redraw while resizing.
- Fixed startup window resize spasm by restoring window state while hidden and showing once at final size/state.
- Fixed ants viewport-culling alignment across zoom levels by using fresh stage bounds and zoom-correct clip-space mapping.
- Fixed ants culling coordinate-space mismatch by inverting path transform when mapping viewport bounds into clipPath coordinates.
- Reworked ants culling to use a dedicated clipped ants group plus `getScreenCTM()` inverse mapping, so viewport culling stays aligned under zoom/pan without changing ants visuals.
- Added spatially indexed visible-path ants rendering: instead of animating the entire mask outline, build and render only clipped outline segments within the current viewport.
- Fixed visible-path drift while panning/zooming by converting clip rect from ants-group space into path-local space before segment culling.
- Updated close-save confirmation dialog to remove full-screen dimming backdrop and keep only the dialog window shadow.
- Fixed desktop export folder picker fallback: when `__TAURI__.dialog.open` is unavailable, export now calls the dialog plugin via `core.invoke` so folder selection still opens.
- Updated export flow to open folder selection at the start of export (before PNG generation), preventing â€œclick export does nothingâ€ stalls on desktop.
- Added a native `pick_export_folder` Tauri command and wired export to use it first, so folder selection does not depend on frontend dialog bridge behavior.
- Added native `write_export_files` command and switched export saves to a single Rust-side batch write, fixing folder-selected-but-no-files-written behavior.
- Hardened export folder resolution across Windows/macOS/Linux by removing frontend path rewriting and resolving dialog-selected folder paths to absolute filesystem paths in Rust before write.
- Added export save retry path on desktop: if writing to a preselected folder fails, prompt for folder selection again and retry the native batch write.
- Added a native `write_export_files_with_dialog` fallback that opens folder-picker and writes exports entirely in Rust, removing JS path-serialization as a failure point.
- Added a native `write_export_files_with_save_dialog` export path: user picks a single save location, then all export files are written into that chosen folder, avoiding folder-picker-only failures.
- Updated desktop export order to use Save-As-first flow (single-file path selection) before folder-based fallbacks.
- Hardened desktop Export Studio reliability:
  - fixed Save-As invoke argument compatibility by trying both `suggestedName` and `suggested_name`
  - changed export flow to prompt folder selection immediately on Export click before PNG generation
  - added post-save Explorer open for the selected export directory and kept multi-path save fallbacks non-fatal
- Added aggressive desktop export write fallback:
  - if batch `write_export_files` fails, export now retries per-file writes using existing `write_allowed_file`
  - export now surfaces explicit desktop write failures instead of silently falling through with no files written
- Simplified desktop Export Studio write path for reliability:
  - after folder selection, export now writes files directly per-file via `write_allowed_file` (same primitive used by Save)
  - disabled automatic post-export Explorer opening to avoid shell/taskbar focus instability on Windows
  - switched folder picking to prefer non-blocking dialog plugin path before native blocking fallback
- Added sequential desktop export dialogs:
  - Export Studio now opens one native Save dialog per selected export file (in order) instead of one combined save flow
  - remembers last chosen export directory as the next dialog start directory for quick same-folder saves
- Added plugin-dialog sequential export fallback for compatibility:
  - if the new Rust single-file save command is unavailable, export now opens one native save dialog per file via `plugin:dialog|save`
  - writes each selected output path with `write_allowed_file` to avoid batch-write and folder-picker path issues
- Fixed desktop Tauri invoke compatibility for export/save flows by accepting `core.invoke`, legacy `invoke`, or `__TAURI_INTERNALS__.invoke` instead of requiring only `__TAURI__.core.invoke`.
- Restored desktop global Tauri injection (`withGlobalTauri: true`) to match the stable release baseline and avoid runtime API-surface mismatches.
- Hardened Export Studio PNG compression path:
  - uses `CompressionStream` with timeout instead of waiting indefinitely
  - falls back to a built-in stored-deflate zlib encoder when stream compression is unavailable/fails
- Simplified desktop Export Studio execution order to a proven flow:
  - pick export folder first (or reuse remembered folder)
  - write all selected files to that folder before save-dialog fallbacks
- Hardened `tauri-shim.js` dialog bridge compatibility by trying both dialog payload shapes and exposing `dialog.save` alongside `dialog.open`.
- Fixed repeated Export Studio behavior on desktop: each Export click now reopens folder picker (Explorer dialog) instead of silently reusing the previous folder and closing the modal immediately.
- Improved Export Studio responsiveness on desktop: folder picker now opens immediately on Export click (before PNG generation), removing the multi-second wait before Explorer dialog appears.
- Fixed GitHub Pages setup workflow enablement.
- Fixed GitHub Pages deployment source to publish built `dist/` output instead of raw `src/`.
- Fixed release asset rename race by adding release-availability retry logic before rename API calls.

## Commit Reference (Since `v1.1.3`)

- `20e9fc6` (2026-02-24): Auto-rename release assets per tag version
- `a35036c` (2026-02-24): Add macOS and Linux build instructions to README
- `768644d` (2026-02-24): Improve README table of contents
- `4b2afba` (2026-02-24): Refine README build/run guide and improve TOC
- `7ea8e2b` (2026-02-24): Rewrite README build guide and complete troubleshooting
- `7f35d4d` (2026-02-24): Add GitHub Pages demo deployment workflow
- `ba315bd` (2026-02-24): Fix Pages workflow by enabling GitHub Pages setup
- `a0ceca5` (2026-02-24): Add web demo link and browser performance note to README
- `e0007cd` (2026-02-24): Improve file-open startup flow, persist window state, and update README demo notes
- `c934f05` (2026-02-24): Update README wording
- `d5ebe4d` (2026-03-01): Improve CI workflows and add release gating via CHANGES_PENDING
- `1424f5d` (2026-03-01): Fix draft-release asset rename race with release polling
- `d0fe71c` (2026-04-05): Fix Export Studio desktop export flow and dialog timing
- `e8f7511` (2026-06-09): Fix freehand: preserve prior strokes, wire ribbon width, hide sidebar for other tools â€” massive restructure adding freehand-path-engine, gradient-engine, layer-system, smart-shape, new assets, CSS overhaul
- `c5620c1` (2026-06-09): Add opencode config with commit-after-changes instructions
- `2260059` (2026-06-12): Fix freehand: correct options structure, taper/easing, outline rendering, smoothing clamp
- `1bc588c` (2026-06-16): Update info modal, fix willReadFrequently warning, remove point cap, add freehand CSS

## Next Cycle Reset

After the next release tag is published:

1. Update `Last tag release`, `Current head`, and `Range`.
2. Clear categorized sections for the new cycle.
3. Start adding new entries immediately for ongoing tracking.

## Customizable Tool Grid

- **Fixed 3×20 grid** — Both Tools and Shapes sections use a fixed 3 rows × 20 columns layout. Every row is exactly 20 cells. `null` entries create visible gaps.
- **Ribbon trimming** — Ribbon renders columns 0 through the furthest occupied column across all 3 rows. Gaps between tools are preserved as visible empty space. Entirely empty rows are skipped. If no tools in a section, the section is hidden.
- **Default layout** — Tools: row 0 [pencil, fill, wand, 17×null], row 1 [eraser, picker, zoom, 17×null], row 2 [gradient, anchor-toggle, freehand, 17×null]. Shapes: row 0 [line, curve, poly, rect, 16×null], row 1 [circle, tri, path, null, 16×null], row 2 [20×null].
- **Customizer** — Always shows all 20 columns × 3 rows. Each cell is 28px. Empty cells show dashed border. Dragging works the same — drawer→grid inserts, grid→grid swaps, right-click/dblclick clears to null.
- **Apply-based save** — Modal edits are working copy. Apply commits to localStorage and re-renders ribbon. Cancel discards.
- **Cleaner modal UI** — Wider window (720px), no +/- Row buttons, uses CSS classes instead of inline styles, matches existing app modal patterns.
- **Auto-migration** — Old flat-array format fails validation and gets replaced with defaults on first load.
- **Per-tool icon CSS fix** — Added `[data-tool-id]` selectors alongside existing `[data-tool]` / `#id` selectors so per-tool sizing/nudges apply to dynamic grid buttons.
- **Modified files:**
  - `src/index.html` — 720px modal, removed +/- Row buttons, cleaner markup with CSS classes
  - `src/js/paint-engine.js` — fixed 3×20 layout, ribbon maxCol trimming with gap preservation, customizer renders 20×3, removed addRow/removeRow methods
  - `src/css/styles.css` — dynamic ribbon grid column counts, 20-col customizer preview at 28px, customizer modal layout classes
