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
| F4 | High | Palette pairing assumes "same folder, same name or normal/shiny". Mispairs `icon.png`, `footprint.png`, expansion `overworld.png`; finds nothing for object events or tilesets. |
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

- **1.1** Index-native editing. The palette panel becomes the colour picker: you select slot 7,
  not `#83EEC5`. Brushes write indices. A seventeenth colour has nowhere to go.
- **1.2** Palette editing that repaints live — change slot 9, the canvas updates, nothing
  re-quantises.
- **1.3** Frames as first-class: frame tabs, onion skin, playback at the game's real speed, for
  anim (2), icon (2) and overworld (9-frame, 144×32) sheets.
- **1.4** Frame-aware canvas — draw on frame 1 with frame 2 ghosted; all frames share one palette
  by construction.
- **1.5** 1:1 preview pane while zoomed in.

**Done when:** a spriter can do a full sprite + animation pass without opening GraphicsGale.

## Phase 2 — The conformance strip

*Freedom while drawing, impossible to ship broken.*

- **2.1** Persistent readout for the open asset: size, colours used vs allowed, slot 0 clear,
  8×8 tile alignment, palette match. Green means insertable.
- **2.2** **Fit to target** — one action that closes the gap (resize, quantise, clear slot 0),
  with a before/after diff.
- **2.3** Sketch mode: full RGB and layers while exploring, with the strip showing the distance
  the whole time. Insertion gated on green.
- **2.4** Validate without building: run the checks `gbagfx` runs, in milliseconds.
- **2.5** Project-wide audit — every asset that would fail a build, listed.

**Done when:** an artist can spend an hour experimenting and still cannot produce a file that
breaks the build.

## Phase 3 — Know the game

*The features only a project-aware editor can have.*

- **3.1** Asset model (plumbing): one record per asset — path, kind, dimensions, depth, palette
  size — resolved at scan time.
- **3.2** Palette resolver encoding the four real rules plus expansion variants. Fixes F4.
- **3.3** **Battle-context preview.** Composite the sprite into a real battle scene at its real
  `y_offset`, live while painting. Catches floating, sinking, clipped feet and HP-bar overlap
  without a rebuild.
- **3.4** **Automatic sprite coordinates.** Compute `.size` / `.y_offset` from the artwork's
  bounding box, flag them when stale, allow nudging in the preview, and write the corrected line
  back to `front_pic_coordinates.h` (or the expansion's species file). This is the flagship —
  it fixes the most common "my custom sprite looks wrong in game" problem, and no other tool
  can do it.
- **3.5** Palette as a lens: normal, shiny and `_gba` variants visible at once while painting;
  shiny generator by hue-rotating the normal palette; palette edits propagate to every asset
  that shares them, with a written-files preview.
- **3.6** Family view — evolution line pinned beside the canvas for style consistency.

**Done when:** you can tell a sprite is wrong before you build the ROM.

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
2. **1.1 + 1.3** — index-native editing and frames. This is what makes the app someone's only tool.
   1.1 is now cheap: `spriteIndices` already holds the true map, so brushes writing slots is a
   change of input, not of representation.
3. **2.1 + 2.2** — the conformance strip and Fit to target. Changes how the tool *feels*.
4. **3.3 + 3.4** — battle preview and automatic coordinates. The reason to switch.
5. **5.1** — import-and-fit, the on-ramp that gets outside art into the project at all.

Still open from the audit: **F4** (palette pairing — Phase 3.2), **F7** (`.pal` entry 0 forced
transparent — now harmless for saving, since transparency comes from tRNS, but still wrong for
tileset swatch display), **F9** (eager DOM tree — Phase 4.2), **F10** (read-only handle —
Phase 5.6), **F11** (browser UX — Phase 4.3).
