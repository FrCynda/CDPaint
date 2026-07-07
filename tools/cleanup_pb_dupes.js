// One-shot cleanup: ensure exactly one #pb-key-settings + #pb-more-settings block exists
// in src/index.html, and that the wrapper of the Advanced section has id="pb-more-settings".
const fs = require('fs');

const FILE = 'src/index.html';
let s = fs.readFileSync(FILE, 'utf8');
const LF = s.includes('\r\n') ? '\r\n' : '\n';
const lines = s.split(LF);

// Find all lines marked with our injection
function isKeySettingsHeader(i)    { return /^        <div class="pb-section">\s*$/.test(lines[i].trimEnd()) && lines[i + 1] && lines[i + 1].includes('class="pb-label">Settings</div>'); }
function isAdvHeader(i)            { return lines[i] && /class="pb-section"/.test(lines[i]) && lines[i + 1] && lines[i + 1].includes('class="pb-label">Advanced</div>'); }

// Detect the "Settings" / "Advanced" injection blocks; collapse any duplication.
let firstBlock = null;
let lastBlockEnd = -1;
const i = 0;
const blockStarts = [];
for (let n = 0; n < lines.length; n++) {
  if (lines[n].includes('class="pb-label">Settings</div>')) blockStarts.push(n - 1);
}
console.log('Settings blocks found at lines:', blockStarts.map(n => n + 1));

// Assume the FIRST occurrence is the desired one. Remove every block from
// blocksStarts[1..] (each block is 9 lines).
const BLOCK_LEN = 9;
if (blockStarts.length > 1) {
  // Remove from bottom to preserve line numbers for earlier indices
  for (let b = blockStarts.length - 1; b >= 1; b--) {
    lines.splice(blockStarts[b], BLOCK_LEN);
    console.log(`[ok] removed duplicate block at line ${blockStarts[b] + 1}`);
  }
}

// Now ensure the wrapper for the Advanced section has id="pb-more-settings"
// Find the line with class="pb-label">Advanced</div>; the line BEFORE is the section opener.
for (let n = 0; n < lines.length; n++) {
  if (lines[n].includes('class="pb-label">Advanced</div>')) {
    const opener = n - 1;
    if (lines[opener] && /^        <div class="pb-section">\s*$/.test(lines[opener].trimEnd())) {
      lines[opener] = '        <div class="pb-section" id="pb-more-settings">';
      console.log(`[ok] added id="pb-more-settings" at line ${opener + 1}`);
    }
    break;
  }
}

fs.writeFileSync(FILE, lines.join(LF), 'utf8');
console.log('done');
