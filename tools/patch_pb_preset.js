// Surgical patch: replace the two legacy pb-preset initUI wiring blocks
// with modern grid + Advanced-toggle wiring + active-name label update.
const fs = require('fs');

const FILE = 'src/js/krita-brush-engine.js';
let s = fs.readFileSync(FILE, 'utf8');
let modified = false;
const lines = s.split(/\r?\n/);

// === Block 1: simple `presetEl.value = currentPreset` (1 statement on lines 899-900) ===
for (let i = 0; i < lines.length - 1; i++) {
  if (
    lines[i].includes("document.getElementById('pb-preset')") &&
    lines[i + 1].trim() === "if (presetEl) presetEl.value = engine._currentPreset;"
  ) {
    lines[i] = "        // Active brush label lives next to the grid now (replaces legacy pb-preset dropdown).";
    lines[i + 1] = "        var pbNameEl = document.getElementById('pb-active-name');";
    lines.splice(i + 2, 0,
      "        if (pbNameEl) pbNameEl.textContent = engine._currentPreset || "
        + "((engine.presetNames && engine.presetNames[0]) || '');"
    );
    modified = true;
    console.log('[ok] replaced block 1 (presetEl.value = engine._currentPreset) with #pb-active-name text');
    break;
  }
}

// === Block 2: the change-listener wiring (lines 914-920 originally) ===
// Replace `var presetEl = document.getElementById('pb-preset');\n        if (presetEl) { ... }`
// with the new buildBrushGrid + Advanced toggle wiring.
let block2Start = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("document.getElementById('pb-preset')") &&
      lines[i + 1] && lines[i + 1].trim() === "if (presetEl) {") {
    block2Start = i;
    break;
  }
}
if (block2Start >= 0) {
  // Find matching close brace (`}` followed by blank/syncPanel) — walk forward to first `}`.
  let block2End = block2Start;
  for (let j = block2Start + 1; j < lines.length; j++) {
    if (lines[j].trim() === "}") { block2End = j; break; }
  }
  if (block2End > block2Start) {
    const insert = [
      "        // Build the brush grid (replaces legacy pb-preset dropdown).",
      "        try { engine.buildBrushGrid(); } catch (eBuild_) {}",
      "",
      "        // Wire the Advanced-section toggle (state persists in localStorage).",
      "        var moreWrap2 = document.getElementById('pb-more-settings');",
      "        var moreBtn2  = document.getElementById('pb-more-toggle');",
      "        if (moreWrap2 && moreBtn2) {",
      "            var COLLAPSE_KEY2 = 'pb-more-collapsed';",
      "            var applyCollapse2 = function (collapsed2) {",
      "                if (collapsed2) moreWrap2.classList.add('pb-more-collapsed');",
      "                else             moreWrap2.classList.remove('pb-more-collapsed');",
      "                moreBtn2.setAttribute('aria-expanded', collapsed2 ? 'false' : 'true');",
      "            };",
      "            try {",
      "                applyCollapse2(localStorage.getItem(COLLAPSE_KEY2) === '1');",
      "            } catch (eStore_) {}",
      "            moreBtn2.addEventListener('click', function () {",
      "                var wasCollapsed2 = moreWrap2.classList.contains('pb-more-collapsed');",
      "                applyCollapse2(!wasCollapsed2);",
      "                try {",
      "                    localStorage.setItem(COLLAPSE_KEY2, !wasCollapsed2 ? '1' : '0');",
      "                } catch (eWrite_) {}",
      "            });",
      "        }",
    ];
    lines.splice(block2Start, block2End - block2Start + 1, ...insert);
    modified = true;
    console.log('[ok] replaced block 2 (change-listener wiring) with grid build + Advanced toggle');
  } else {
    console.warn('[warn] block 2 start found but could not detect end brace');
  }
} else {
  console.warn('[warn] block 2 not found (already patched?)');
}

if (modified) {
  s = lines.join('\n');
  fs.writeFileSync(FILE, s, 'utf8');
  console.log('[ok] wrote ' + FILE);
} else {
  console.log('[skip] no changes');
}
console.log('done');
