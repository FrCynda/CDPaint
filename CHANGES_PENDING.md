## Changes
- Split the paint engine into per-domain scripts: the core plus layer-system, selection, palette, adjustments, project-assets, transform, theming, brush-engine, exporting, magic-wand, modals, hotkeys, history, file-io, tiles, quantize, gradient-tool, tauri-bridge, viewport and clipboard
- Removed five unused modules that duplicated code already in the engine
- Replaced the single-file standalone bundle with a modular src/ layout
- Rewrote the README and clarified the LICENSE with third-party asset notices

## Additions
- Project browser panel for opening and saving sprite assets with exact palette and index preservation
- Sprite editor with palette panel and PAL support
- Krita brush engine integration with David Revoy brush presets
- Seeded RNG for repeatable brush jitter and noise patterns

## Bug Fixes
- Fixed UTF-8 mojibake corruption in source files
- Fixed freehand tool preserving prior strokes and ribbon width behavior

- Last tag release: `v1.1.5`