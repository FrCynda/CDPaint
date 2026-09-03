@AGENTS.md

## Layout

- `src/js/` — vanilla JS modules, loaded as globals via `src/index.html`. No bundler at dev time.
- `src/js/paint-engine.js` — **30k lines**, one `class PaintEngine` (starts line 881). Also holds `SeededRNG` (10), `PngMetadata` (22), `CompressionCompat` (79, dead code), and a worker `self.onmessage` block (8386).
- `src-tauri/` — Rust, OS integration only.
- `dist/` — build output. Never edit.
- `test/engine/` + `test/browser/` — driven by `test/run-all.mjs`.

## Finding code

`paint-engine.js` is too large to read whole — a full read costs ~400k tokens and will not fit. Always `Grep` for a method or property name and read the surrounding lines with `offset`/`limit`. Never `Read` it without a range.

Everything is a method on `PaintEngine`, so grep `methodName(` rather than `function methodName`.

## Commands

- `npm test` — everything. `npm run test:engine` / `test:browser` / `test:wand` while iterating.
- `npm run test:syntax` — fast syntax smoke check after edits to `src/js/`.
- `npm run build` — esbuild to `dist/`.

Run the targeted suite while iterating and the full suite once at the end.

## Plans

Active work is tracked in `POKEPROJECT_PLAN.md`; pending edits in `CHANGES_PENDING.md`. Read them before starting related work rather than re-deriving state.

## Compact instructions

When compacting, keep the current file paths, line numbers, and test output. Drop resolved discussion and superseded approaches.
