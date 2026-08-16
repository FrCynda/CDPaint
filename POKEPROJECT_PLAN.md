# PokéProject — audit findings and roadmap

Audited 15 Aug 2026 against `pret/pokeemerald` and `rh-hideout/pokeemerald-expansion` at master.
Full audit write-up with evidence: https://claude.ai/code/artifact/2e853e0c-a208-4f08-800d-6d0351033436

## The thesis

CDPaint is the only paint program that lives inside the project. Aseprite and GraphicsGale don't
know what a Bulbasaur is, where its palette lives, how tall its sprite is allowed to be, or what
it looks like on a battle platform. That knowledge is the product.

Two corollaries drive the ordering below:

- **The index is the document.** CDPaint treats the RGB bitmap as truth and re-derives palette
  indices on demand. Gen 3 art is index data with a palette attached. Every critical finding
  below is a symptom of that inversion.
- **The canvas is not the asset.** Draw freely — any size, any colours, layers. A permanent
  conformance readout shows the distance to what the slot needs, and one action closes it.
  Constraints become a readout, not a cage.

## Competitive reality (checked, not assumed)

CDPaint already beats GraphicsGale on 14 blend modes, layer masks and clipping, groups, a
bristle/dab brush engine, Perfect Freehand stroke smoothing, a vector gradient engine, and
wand/selection tooling. GraphicsGale wins on exactly two things: **native indexed editing** and
**an animation timeline with onion skin**. Those are the two dialects CDPaint doesn't speak, and
they are why people still use a 2017 freeware app for GBA work.

That is a domain gap, not a painting gap — and closing it makes CDPaint viable as someone's
*only* tool. It is why Phase 1 below is what it is. Aseprite is ahead on pixel-art workflow
(timeline, tilemap mode, pixel-perfect stroke correction), not painting power.

## Ground truth (verified from the decomp, not from tutorials)

| File | Size | Depth | Palette |
|---|---|---|---|
| `pokemon/<species>/front.png` / `back.png` | 64×64 | 4bpp | 16 + tRNS |
| `pokemon/<species>/anim_front.png` | 64×128 | 4bpp | 16 + tRNS |
| `pokemon/<species>/icon.png` | 32×64 | 4bpp | 16 + tRNS |
| `pokemon/<species>/footprint.png` | 16×16 | 1bpp | 2 |
| `object_events/pics/**/walking.png` | 144×32 | 4bpp | 16 |
| `trainers/front_pics/*.png` | 64×64 | 4bpp | 16 + tRNS |
| `items/icons/*.png` | 24×24 | 4bpp | 16 + tRNS |
| `battle_interface/hpbar_anim.png` | 144×8 | **8bpp** | 16 |
| `title_screen/pokemon_logo.png` | 256×64 | **8bpp** | **256** |
| `data/tilesets/**/tiles.png` | 128×N | 4bpp | 16 |

Palette location is **not** one rule but four:

- species → sibling `normal.pal` / `shiny.pal`
- icons → shared `graphics/pokemon/icon_palettes/icon_palette_{0,1,2}.pal`
- overworld → `graphics/object_events/palettes/<name>.pal` (sibling *folder*)
- tilesets → `palettes/00.pal` … `15.pal`, and they live under `data/`, not `graphics/`

Expansion adds `overworld_normal.pal`, `overworld_shiny.pal` and `_gba` variants.

`.pal` files are JASC-PAL with **0–255** channel values (multiples of 8). Slot 0 is transparency.

Other project data worth reading:

- `src/data/pokemon_graphics/front_pic_coordinates.h` / `back_pic_coordinates.h` —
  `.size` (drawn pixel area) and `.y_offset` (pixels from drawn area to bottom edge). Expansion
  keeps the same values as `.frontPicSize` / `.frontPicYOffset` in `species_info/*.h`.
  **Both are computable from the artwork's bounding box.**
- `include/fieldmap.h` — `NUM_TILES_IN_PRIMARY 512`, `NUM_TILES_TOTAL 1024`,
  `NUM_PALS_IN_PRIMARY 6`, `NUM_PALS_TOTAL 13`. Hard budgets for tileset work.
- `graphics/battle_environment/*` — backdrops for in-context preview.

## Findings

| # | Severity | Finding |
|---|---|---|
| F1 | **Critical** | Save fills transparent background with a solid colour. Bulbasaur `front.png`: 3364/4096 px changed (82.1%), all `index 0 → index 10`. `saveProjectFile` matches by RGB only and never reads alpha; no tRNS is written. |
| F2 | **Critical** | `serializeJascPal` writes 0–31 where the decomp uses 0–255. `205 205 172` → `25 25 21`. `parseGbaPaletteText` re-inflates its own output, so the damage is invisible inside CDPaint and lands in the ROM. |
| F3 | High | `parsePngPalette` never decodes IDAT; indices are re-derived by nearest colour. 26% of sampled species palettes have duplicate RGB slots. Magikarp `normal.pal` slots 11 and 14 are both `222 24 0`; in `shiny.pal` they are `246 189 82` and `230 164 41` — saving the normal sprite silently alters the shiny. |
| F4 | ~~High~~ **closed** | Palette pairing assumes "same folder, same name or normal/shiny". Mispairs `icon.png`, `footprint.png`, expansion `overworld.png`; finds nothing for object events or tilesets. *Closed by 3.2: the panel resolves through the project's declarations, then the four conventions.* |
| F5 | High | `getTargetProfiles` rejects stock assets. `anim_front.png` (64×128) → hard ERROR; icon profile allows 32×32/64×64 but the real file is 32×64. Allowed sizes include 80×80 and 96×96, which are not Gen 3. |
| F6 | Medium | Scale is guessed from the max channel value, so a legitimate 0–255 dark ramp is multiplied by ~8. |
| F7 | Medium | `a: i === 3 ? 0 : 255` forces slot 0 transparent for every palette, including tileset palettes 01–15 and 8bpp UI art. |
| F8 | Medium | `doAdvancedExport` hardcodes 4bpp / 16 entries; real projects contain 8bpp / 256-entry assets. |
| F9 | Medium | `dirRow` → `renderChildren` is eager and recursive: hooking a decomp builds a row and an `<img>` for every PNG in the repo before the search box responds. |
| F10 | Medium | `showDirectoryPicker({ mode: 'read' })` means browser mode can never save in place, and Refresh needs the folder re-picked. |
| F11 | Low | File tree, not asset browser: leaf-name-only search, no species grouping, no shiny toggle, no active-palette indicator, no open-folder memory. `unhook()` leaves `currentRoot` cached. |

## Verdict

Keep the panel chrome, the Rust scanner, the thumbnail loader, the dual desktop/browser file
access and the Sprite Preview panel. Rebuild three things underneath: index recovery, palette
resolution, and validation — then build outward from what the project can tell us.

---

# Roadmap

Reordered after the ideation pass: the two dialects (indexed colour, frames) come before the
browser rework, because they are what make CDPaint viable as someone's only tool, and the
project-awareness features are worth far more once people are living in it.

## Phase 0 — Stop the data loss ✅ DONE (15 Aug 2026)

- **0.1 ✅** `CompressionCompat.inflate` + `decodePngIndices()`: inflates IDAT, unfilters all five
  PNG row filters, unpacks 1/2/4/8bpp to a `Uint8Array` of indices. Returns null rather than a
  guess for interlaced or otherwise unreadable files, and the caller falls back as before.
- **0.2 ✅** `buildProjectIndices()`: a pixel still matching the baseline captured at load keeps
  the index the file gave it; only painted pixels are re-matched to the palette.
- **0.3 ✅** Alpha-0 → the slot named by the file's own tRNS (not by palette alpha, which a
  loaded `.pal` always sets on entry 0). The original tRNS is written back, including its
  absence — tilesets don't gain a transparency chunk they never had.
- **0.4 ✅** `serializeJascPal` → 0–255 via `toGbaChannel()`, mirroring gbagfx exactly
  (`>> 3` down, `floor(v * 255 / 31)` up). Bulbasaur's `205 205 172` round-trips unchanged.
- **0.5 ✅** The 0–31 scale guess is gone; decomp palettes are always 0–255.
- **0.6 ✅** Profiles rebuilt from the table above, including anim/footprint/overworld/trainer/
  item/tileset kinds, `_gba` variants, a required-width and tile-alignment rule for tilesets, and
  a colour budget taken from the file's real bit depth instead of a hardcoded 16.
- **0.7 ✅** `test/browser/project-roundtrip.mjs` — 48 assertions over six asset shapes, three
  row filters, palette serialisation and profile acceptance.
- **0.8 ✅** *(found during the work)* `remapCanvasToPalette` re-derived indices from RGB on every
  palette swap, so switching to shiny renumbered the artwork. Project assets now repaint from the
  index map: the colours change, the indices never do.

**Verified against the real files:** `bulbasaur/front.png`, `bulbasaur/icon.png` and
`magikarp/front.png` now change **0 pixels** on a no-op save (previously 3364, 1577 and 3364).
Magikarp's 113 slot-14 pixels survive, so the shiny render is bit-identical afterwards.

Full suite: 23 suites · 14,203 assertions · 0 failed.

> **Note for whoever works here next:** `src/js/compression-compat.js` is dead — nothing loads it.
> The live copy of that class is inlined near the top of `paint-engine.js`. Editing the standalone
> file has no effect on the app.

## Phase 1 — Speak indexed colour and frames

*The two things people currently leave CDPaint for.*

- **1.1 ✅ DONE (15 Aug 2026)** — index-native editing.
  - The palette strip picks a *slot*, not a colour. Clicking a swatch in the palette panel (or
    the quantise dialog) records the slot; painted pixels resolve to it, so painting with
    Magikarp's slot 14 writes 14 rather than 11. Setting the colour any other way drops the link
    and the first-match fallback applies. The slot in hand is ringed in the palette that's
    driving the canvas.
  - **The index map is now the document.** `state.projectIndices` is live: every committed step
    folds the canvas back into it (`commitProjectIndices`, called at the top of both `saveState`
    paths) and pins the result to the history entry, so undo and redo restore the slots along
    with the pixels. The map moved onto `state` and into `DOCUMENT_STATE_KEYS`, so it survives a
    tab switch; `spriteIndices` is now an accessor onto it.
  - **The RGB baseline is gone.** `state.projectBaseline` — the full-canvas bitmap captured at
    load that saving used to diff against — no longer exists. The map *is* the baseline: a pixel
    still showing the colour of the slot it holds was not painted. Saving writes the map.
  - **The colour ceiling is structural.** `paintProjectIndicesOnto` repaints the surface from the
    map at the end of each step, so a blended or antialiased pixel does not survive the step it
    was made in — it lands on the slot it resolved to, and what is on screen is what the file
    will contain. Only the box that moved is written back, so tiled history keeps its deltas.
  - Every document-replacing path now calls `clearProjectAssetState()`. Without it a plain PNG
    opened after an asset would inherit its palette and get snapped onto its slots.
  - **Known limit, deliberate:** painting slot 14 over a pixel that already holds slot 11 of the
    *same* colour is indistinguishable from not painting at all, and the conservative reading
    wins — renumbering on a guess is how the shiny palette gets silently rewritten (F3). Telling
    the two apart needs per-pixel stroke coverage, not a colour comparison. An explicit
    "assign slot to selection" action would close it without the guesswork.
  - With layers active the map is read from the composite and the canvas is *not* snapped: the
    layers underneath still hold the unsnapped pixels and would paint them back. Free RGB work
    on an asset is Sketch mode's job (2.3).
  - Tests: 9 new assertions in `project-roundtrip.mjs` (64 total) covering the live map, the
    snap, undo/redo of the map, and the absence of the baseline.
- **1.2 ✅ DONE (15 Aug 2026)** — palette editing that repaints live. Editing the palette of a
  project asset is now a document edit, not a view setting, because the canvas *is* that palette
  rendered through the index map.
  - **Slot edit** (`updatePaletteColor`) → `repaintProjectFromPalette()` repaints every pixel
    holding that slot and nothing else. No re-quantise, no index moves. Records a step.
  - **Reorder / move between palettes** → `renumberProjectIndices(table)` moves the artwork with
    the colour, by slot table rather than by RGB so duplicate slots don't merge. The picture is
    byte-identical afterwards; only the numbers under it change.
  - Dragging a slot *out* of the palette driving the canvas is refused while any pixel stands on
    it — there is no honest place to send those pixels. An unused slot goes through, and
    everything above it shifts down with the artwork.
  - **The palette travels with history**, alongside the index map (`attachProjectStep` /
    `restoreProjectStep`). This closes a corruption that predates 1.1: swapping normal→shiny has
    always been a history step, but undo restored only the pixels — leaving the canvas showing
    one palette while `activePaletteId` named another, so the next edit renumbered the whole
    asset against colours it never used.
  - `setActivePalette` on a project asset now routes through `remapCanvasToPalette`. Choosing
    which palette drives the canvas *is* the normal/shiny toggle; it cannot be a silent switch.
    `removePalette` repaints the same way when the palette that went away was the active one.
  - With layers active the canvas does not follow a palette edit (the layers hold RGB the map
    does not describe). The palette still changes. Sketch mode (2.3) is where that belongs.
  - Tests: 15 more assertions in `project-roundtrip.mjs` (79 total).
- **1.3 ✅ DONE (16 Aug 2026)** — frames as first-class.
  **The insight that shaped it:** Gen 3 animation is not a file format. A two-frame front sprite
  is one 64×128 PNG holding two 64×64 pictures; a walking sheet is one 144×32 PNG holding nine
  16×32 ones. So a frame is a *rectangle of the canvas*, not a second document — which means
  every frame shares one palette and one index map by construction, and all of 1.1/1.2 applies to
  frames unchanged with nothing new underneath.
  - `projectFrameLayout()` reads the sheet off the profile: `anim_front` → 2×(64×64) stacked,
    `icon` → 2×(32×32) stacked, overworld/object-event → horizontal. A still 64×64 front sprite
    reports *no* frames rather than inventing one.
  - **Playback at the game's real speed** — 8 game frames held at the GBA's actual 59.7275 Hz
    (7.47 fps, 134 ms), not a rounded 60. It walks the strip, never the canvas: the frame being
    edited does not move while it plays.
  - **Onion skin** ghosts the previous frame (40%) and the next (22%) over the frame being
    worked on, on its own canvas above the artwork and below the tool preview — so it can never
    be painted on or saved. This is **1.4**, and it fell out of 1.3 as predicted.
  - Frame strip (`src/js/frame-strip.js`, same chrome as the palette/preview panels): thumbnails
    off the display surface at integer zoom, play/stop, onion toggle, frame count, hold, and a
    live `16×32 · 7.5 fps · 134ms/frame` readout. It appears only for a sheet with more than one
    frame and hides itself again otherwise.
  - Choosing a frame is navigation, not an edit — it never enters the undo stack, matching how
    the layer system treats layer selection.
  - **Known limit:** the frame count for overworld sheets is a *guess* (largest division landing
    on an 8×8 tile boundary). The real width lives in `ObjectEventGraphicsInfo` in the project's
    C, which nothing reads yet — that is Phase 3 work. Until then the count is adjustable in the
    strip, which rescues any sheet the guess gets wrong.
  - Tests: 29 new assertions (108 total in `project-roundtrip.mjs`) over layout, geometry,
    playback timing, onion containment, and the strip's own DOM.
- **1.4 ✅ DONE (16 Aug 2026)** — delivered by 1.3's onion skin. Draw on one frame with its
  neighbours ghosted; all frames share one palette because they share one image.
- **1.5 ✅ DONE (16 Aug 2026)** — the 1:1 preview pane. The Sprite Preview panel already existed
  but was neither 1:1 (it CSS-upscaled cropped thumbnails to ~128px) nor live (it only redrew on
  palette changes, despite its docstring claiming otherwise). Now: true integer pixel scale with
  1× labelled *game size*, one pane per palette so normal and shiny are both checkable at once,
  following the active frame of a sheet — and the playing frame while the strip plays — and
  repainting on every committed edit. The bounding-box crop is gone: once it updates live, a crop
  resizes the pane under the cursor every time a pixel near an edge changes.

**Done when:** a spriter can do a full sprite + animation pass without opening GraphicsGale.
**Status:** met, bar the 1:1 preview pane (1.5). Both dialects GraphicsGale had and CDPaint
didn't — native indexed editing and an animation timeline with onion skin — are now spoken.

## Phase 2 — The conformance strip

*Freedom while drawing, impossible to ship broken.*

- **2.1 ✅ DONE (16 Aug 2026)** — the conformance readout lives in the status bar for project
  assets: size, colours against the budget the file's real bit depth allows, 8×8 tile alignment,
  and the slot in hand. Green means insertable.
  - **Slot 0 check** — a file carrying a tRNS is expected to keep its background on that slot.
    Nothing standing on it means the background is opaque, which is finding F1 waiting to happen
    and is *invisible in the editor*, because there is no battle scene behind the canvas.
  - **Red gets a banner.** A bar above the status bar names what will not build and carries the
    Fit to target button. Dismissing it is remembered against that exact set of problems, so
    hiding one does not hide the next, different one.
- **2.2 ✅ DONE (16 Aug 2026)** — **Fit to target**.
  - Four fixes: resize to the profile's box, pad to 8×8 for tilesets, reduce to the colour
    budget, clear slot 0. Each is offered only when it applies, each is individually switchable.
  - **They are pure functions over a document value** (`{w, h, map, colors, transparentIdx}`),
    not operations on the live canvas. That is what makes the dialog's "after" a real render of
    the real result rather than a description of one — and it means the operations that can
    destroy someone's work are each testable in isolation.
  - `Clear slot 0` flood-fills inward from the edges through whichever slot the border is mostly
    made of, so a colour that also appears *inside* the sprite is not hollowed out with it.
  - `Reduce colours` merges the least-used slots into their nearest surviving neighbour — the
    smallest number of pixels that have to change — and never merges away the transparency slot.
  - `Resize` pads or crops **bottom-anchored and horizontally centred**, because a Gen 3 sprite's
    `y_offset` is measured up from the bottom edge: top-anchoring would move the sprite in game
    even though the file came out the right size.
  - Ordered slot 0 → colours → size when several run, so clearing the background drops a colour
    before anything is merged, and padding lands on the final transparency slot. One history
    step, so one undo.
  - *Found while building it:* `addPaletteColorTo` changed the palette — half of a project
    asset's document since 1.2 — without recording a step, so undo dropped back to a palette the
    canvas no longer matched. Fixed.
- **2.3** Sketch mode: full RGB and layers while exploring, with the strip showing the distance
  the whole time. Insertion gated on green.
- **2.4 ✅ DONE (16 Aug 2026)** — `validateProjectAsset(bytes, path)` runs off a file's bytes,
  needing neither the document nor a compiler.
  **It reports two kinds of problem, kept apart on purpose**, because they are routinely
  confused and only one of them stops anything:
  - **won't build** — `gbagfx` refuses it and `make` halts: not indexed, a dimension that is not
    a whole number of 8×8 tiles, a tileset that is not 128px wide, more palette entries than the
    target depth holds, or an *index* the target depth cannot express (an 8bpp PNG converts to a
    4bpp asset happily right up until one pixel uses index 16).
  - **wrong in game** — it builds perfectly and then looks wrong: the wrong size for the slot, an
    opaque background where the sprite wanted transparency. Nothing in the toolchain ever says a
    word about these.
- **2.5 ✅ DONE (16 Aug 2026)** — **Audit** button in the project panel. Walks every PNG in the
  hooked folder through 2.4 and reports `N assets · N clean · N won't build · N wrong in game`,
  grouped by kind, each row naming the file's real shape and clicking through to open it. Reads
  are sequential with the panel updated as it goes — a decomp holds thousands of PNGs and firing
  them all at once buries the main thread.
  *Found while building it:* `decodePngIndices` is async, and two of the new checks called it
  without awaiting — so they silently never ran. The tests caught it; a `Promise` is truthy and
  has no `.length`, so the loops just did nothing.

**Done when:** an artist can spend an hour experimenting and still cannot produce a file that
breaks the build.

## Phase 3 — Know the game

*The features only a project-aware editor can have.*

- **3.1 ✅ DONE (16 Aug 2026)** — asset model. `src/js/project-model.js`: one record per asset,
  read out of the project's own C rather than guessed from the path. 16,241 symbols, 9,652
  declared depths (85% of assets), 3,956 declared pairings on expansion 1.16.4, in 860ms.
- **3.2 ✅ DONE (16 Aug 2026)** — palette resolver, declarations first and conventions second,
  every candidate carrying the reason it was offered. **Closes F4**: the panel now asks the
  resolver instead of matching sibling filenames, and the sibling-`palettes/` folder rule the
  old code lacked is in. Every species battle sprite resolves; trainers 184/191; object events
  357/449, the rest binding at run time rather than in a declaration.
- **3.3 ✅ DONE (16 Aug 2026)** — battle-context preview. `src/js/battle-preview.js` draws the
  240×160 screen with the sprite where `sBattlerCoords` + `y_offset` will actually put it, the
  foot line it is supposed to reach, and the healthbox it must not run into. Follows the active
  frame and repaints on every committed edit.

  **The backdrop and healthbox are the project's own graphics** (16 Aug 2026, `battle-scene.js`).
  A GBA background is a 256-tile sheet, a tilemap and a palette, and all three are *uncompressed
  on disk* — the `.smol` in their declarations is applied by the build — so the scene reassembles
  with no decompressor. Two facts had to be read rather than guessed, and both are recorded in
  the file: `battle_bg.c:872` loads the palette at `BG_PLTT_ID(2)`, so a map entry naming bank 3
  wants colours 16–31 of the 48-colour file; and `map.bin` is two 32×32 screenblocks, not one
  64-wide map. All **23 declared environments resolve and render**, offered by the name the
  project gives them. The healthbox sheets need no tilemap — their `-mwidth/-mheight` flags
  reorder tiles for OAM, not for the eye.
  *Remaining ceiling:* the sprite stands still. `pokemon_animation.c` holds 154 animations, 95 in
  use across 1,233 species; the top 20 cover 79% of them. Porting those is 3.7.
- **3.4 ✅ DONE (16 Aug 2026)** — automatic sprite coordinates. `src/js/sprite-coords.js` reads
  both layouts (expansion `species_info/*.h`, vanilla `*_pic_coordinates.h`), measures the
  artwork, and writes a corrected value back through one narrow Rust command that refuses if the
  file moved since it was read.

  Measured against 3,456 declared entries and their real artwork:
  **`y_offset` === `63 - bottomRow` for 99.0%** — so it is treated as a fact and a mismatch is
  reported as floating or sinking, with the measured value on a button. **`size` matches exactly
  for only 72%, but is ≥ the artwork for 98.8%** — the decomp's own values are a generous upper
  bound inherited from the ROM tables, so a loose size is reported as fine and only a size
  *smaller* than the artwork is a fault. Claiming the other 949 were wrong would have been F4
  again in a new place.
- **3.5** Palette as a lens: normal, shiny and `_gba` variants visible at once while painting;
  shiny generator by hue-rotating the normal palette; palette edits propagate to every asset
  that shares them, with a written-files preview.
- **3.6** Family view — evolution line pinned beside the canvas for style consistency.
- **3.7** Species battle animations in the preview. Each species declares a `.frontAnimId`, and
  each animation is a per-frame callback moving `sprite->x2/y2` and setting an affine matrix in
  1/256 fixed point — portable to canvas transforms one at a time. A species whose animation is
  not ported stands still and says which one it should be playing, rather than pretending.

**Done when:** you can tell a sprite is wrong before you build the ROM.

**Status:** met for battle sprites, which is where the question is usually asked. 3.5 and 3.6 are
comfort, not correctness.

**Plumbing that landed with it**, and that 4.x builds on:
`read_project_sources` (one call, marker-filtered: 173 files of 996, 16MB of 39MB),
repo-root detection from a hooked `graphics/` folder, and `patch_source_file` — the only path by
which CDPaint writes C, taking a byte range and the text expected to be in it.

## Phase 4 — The browser becomes a workspace

*It stops being a file tree with folders in it.*

- **4.1** Detect project shape (emerald / firered / ruby / expansion); hook the repo *root* so
  `data/tilesets/` comes along.
- **4.2** Virtualised rows off the asset model. Fixes F9.
- **4.3** Species-first: one row per species, asset chips, normal/shiny toggle, species-name
  search. When a species is open, the panel *is* that species — assets, palettes, coordinates,
  preview.
- **4.4** Tileset section, grouped primary/secondary with their 16 palettes.
- **4.5** **Tile budget for map artists**: live unique-8×8-tile counter against the real limits
  (512 primary / 1024 total), duplicate-tile highlighting, and flip-aware dedup — the GBA flips
  tiles for free, so a mirrored tile costs nothing and no general paint program knows that.

**Done when:** typing "magikarp" in a fresh expansion repo gives one row with every Magikarp
asset, each offering only its own palettes.

## Phase 5 — On-ramps and safety

- **5.1** **Import-and-fit**: drop any PNG on a species slot → correctly sized, indexed,
  slot-0-clear asset with a generated palette and computed coordinates. The most common real
  task; currently half an hour across three programs.
- **5.2** New-species scaffold at correct dimensions with stub palettes.
- **5.3** Git awareness: modified/untracked badges, one-click revert an asset to HEAD, drafts
  stored outside the repo so experimenting never dirties it.
- **5.4** Variant sandbox: try three palette ideas side by side, keep one; hold a key to A/B
  against the original.
- **5.5** Hex Maniac Advance export + "copy palette as GBA hex", for binary hackers. No ROM
  writing.
- **5.6** Fix F10 — request `readwrite` on the directory handle so browser mode can save in place.

## Phase 6 — Living in the project

Folder watching, recent/pinned assets, per-species notes, session restore.

---

## Deliberately out of scope

- Writing general C. The sprite coordinate fields are graphics data; move tables and species
  stats are not.
- Writing ROMs. Hand Hex Maniac Advance a perfect PNG instead.
- Competing with Aseprite on brush engines — that fight is already won or irrelevant.

## Next up

1. ~~**Phase 0**~~ — done. F1, F2, F3, F5, F6 closed; F8's hardcoded 16-colour assumption is
   closed on the validation side (the Advanced Export Studio still hardcodes 4bpp/16 — that is
   the remaining half of F8).
2. ~~**Phase 1**~~ — done, 1.1 through 1.5. Both GraphicsGale dialects are spoken.
3. ~~**2.1, 2.2, 2.4, 2.5**~~ — done. **2.3** (sketch mode) is what is left of Phase 2, and it is
   now more a decision than a build: layered/off-palette work already behaves as a sketch —
   1.1 deliberately does not snap the canvas while layers are active, and 1.2 does not repaint
   through them. What is missing is saying so in the interface and gating insertion on green.
4. ~~**3.1 – 3.4**~~ — done. The asset model, the palette resolver, the battle preview and
   automatic coordinates, the latter two now drawing the project's real backdrops and healthbox.
   **3.5** (palette as a lens), **3.6** (family view) and **3.7** (battle animations) are what is
   left of Phase 3, and all three are comfort rather than correctness.
5. **5.1** — import-and-fit, the on-ramp that gets outside art into the project at all. Now
   largely a matter of pointing 2.2's fixes at an incoming PNG instead of an open one, and 3.4's
   measurement at its coordinates.
6. **4.1 / 4.2** — the browser rework. 4.1 is nearly free now: `read_project_sources` already
   walks up to the repo root, so hooking it is a matter of scanning from there too.

Still open from the audit: **F7** (`.pal` entry 0 forced transparent — now harmless for saving,
since transparency comes from tRNS, but still wrong for tileset swatch display), **F9** (eager
DOM tree — Phase 4.2), **F10** (read-only handle — Phase 5.6, and the reason browser mode can
read coordinates but not write them), **F11** (browser UX — Phase 4.3).
**F4 is closed** by 3.2 landing in the panel.
