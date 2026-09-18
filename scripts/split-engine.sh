#!/bin/sh
# Replays the whole PaintEngine split from a clean checkout of paint-engine.js.
#
# Order matters: each pass takes what matches from what is still on the class,
# so an earlier domain claims shared names (tauri-bridge takes
# tauriWriteExportFiles* before the export pass runs).
set -e
cd "$(dirname "$0")/.."

d() { sh scripts/extract-domain.sh "$@" >/dev/null; echo "  $1"; }

# Method names still on the class body.
pool() {
  grep -n '^        \(async \)\?[a-zA-Z_$][a-zA-Z0-9_$]*(' src/js/paint-engine.js \
    | sed 's/.*:  *\(async \)\?\([a-zA-Z_$][a-zA-Z0-9_$]*\)(.*/\2/' \
    | grep -vE '^(if|for|while|switch|catch|return|else|do)$' | sort -u
}

d tauri-bridge   'auri'
d quantize       '^(wu[A-Z]|quantize|_quantize|initQuantize|applyWebGLQuantize)'
d gradient-tool  '[Gg]radient|^_gs'
d adjustments    'ueSat|applyDepth|[Bb]rightness|[Cc]ontrast'
d transform      'esize|[Rr]otate|[Ff]lip|[Ss]kew|[Cc]rop'
d magic-wand     '[Ww]and'
d palette        '[Pp]alette|[Pp]alFile|^loadPal|^savePal|[Ss]watch'
d exporting      '[Ee]xport|generateIndexedPNG|[Dd]ecodePng|encodePng'
d project-assets '[Pp]roject|[Ss]prite|[Bb]attle|[Ff]rame[A-Z]|[Dd]ecomp'
d modals         '[Mm]odal|[Dd]ialog|[Mm]enu'
d brush-engine   '[Bb]rush|[Ff]reehand|[Kk]rita|[Pp]reset'
d tiles          '[Tt]ile|[Gg]apStitch|[Ss]titch'
# History bookkeeping the name pattern misses (_entryBytes, _anchorEntry and
# friends), minus getSidebarUndockIcon — "Undock" matches [Uu]ndo, and it is
# sidebar chrome, not history. test/engine/history-release.mjs reads these
# methods by name, so the domain has to stay whole.
HIST=$(pool | grep -E '[Hh]istory|[Uu]ndo|[Rr]edo|[Ss]napshot|^_(collectOwnedSnapsInUse|closeBitmapEntry|entryBytes|anchorEntry)$' \
  | grep -v '^getSidebarUndockIcon$' | tr '\n' ' ')
node scripts/extract-methods.mjs history $HIST >/dev/null
node --check src/js/history.js
echo "  history"

# ThemeSelect* is the theme dropdown, not canvas selection; the colour-editor
# helpers below only match on "selected". Both belong elsewhere.
NAMES=$(grep -n '^        \(async \)\?[a-zA-Z_$][a-zA-Z0-9_$]*(' src/js/paint-engine.js \
  | sed 's/.*:  *\(async \)\?\([a-zA-Z_$][a-zA-Z0-9_$]*\)(.*/\2/' \
  | grep -vE '^(if|for|while|switch|catch|return|else|do)$' | sort -u \
  | grep -E '[Ss]elect|[Mm]ask|[Mm]arquee|[Ll]asso' | grep -v 'Theme' \
  | grep -vE '^(selectColorCustomizerKey|selectSlot|setSelectedColorToPureRed|applyEditorHslToSelectedColor|applyEditorRgbToSelectedColor)$' \
  | tr '\n' ' ')
node scripts/extract-methods.mjs selection $NAMES >/dev/null
node --check src/js/selection.js
echo "  selection"

d theming        '[Tt]heme|[Rr]ibbon|[Tt]oolbar'
d clipboard      '[Cc]lipboard|[Pp]aste|execCopy|execCut'
d viewport       '[Zz]oom|[Vv]iewport|[Ss]croll|[Rr]uler|[Gg]ridOverlay|[Cc]anvasGrid'

node scripts/extract-methods.mjs file-io handleFile loadImageFromBlob \
  loadImageFromDataUrl loadImageFromSrc loadRecentFiles newFile openFileFromPath \
  openRecentFile saveAsFile saveFile saveFromReminder saveRecentFiles \
  handleLoadedImage evaluateDecodedImageVariants openFitToTarget >/dev/null
node --check src/js/file-io.js
echo "  file-io"

echo
echo "paint-engine.js now $(wc -l < src/js/paint-engine.js) lines"
