## Changes
- Reworked the paint engine into modular ES modules (paint-engine, layer-system, gradient-engine, smart-shape, freehand-path-engine)
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