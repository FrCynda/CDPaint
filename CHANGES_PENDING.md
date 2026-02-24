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
