# Changes Pending

Living release-tracking document for all updates since the latest tag.

- Last tag release: `v1.1.3`
- Current head: `c934f05`
- Range: `v1.1.3..HEAD`

## Release Prerequisite

Before creating/publishing any new release tag:

1. Update this file with every relevant change since the last tag.
2. Ensure entries are categorized under `Changes`, `Additions`, and `Bug Fixes`.
3. Confirm this file is complete and use it as the source for release notes.

No release should be considered complete without this document being current.

## Changes

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

## Bug Fixes

- Fixed cross-platform `file://` path handling for launch/open-file flows (Windows/macOS/Linux).
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
- Updated export flow to open folder selection at the start of export (before PNG generation), preventing “click export does nothing” stalls on desktop.
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

## Next Cycle Reset

After the next release tag is published:

1. Update `Last tag release`, `Current head`, and `Range`.
2. Clear categorized sections for the new cycle.
3. Start adding new entries immediately for ongoing tracking.
