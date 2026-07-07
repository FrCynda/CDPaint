// Apply paintbrush-sidebar HTML edits to src/index.html only (pd.html left untouched per user).
// Tag each <div class="pb-row"> with data-setting="X", inferred by scanning forward
// inside the row for an id="pb-<name>" attribute (input, label, or row's own id).
// Inject #pb-key-settings + #pb-more-settings containers after the active-name section.
const fs = require('fs');

const FILE = 'src/index.html';
let s = fs.readFileSync(FILE, 'utf8');
const original = s;
const LF = s.includes('\r\n') ? '\r\n' : '\n';
const lines = s.split(LF);

let taggedRows = 0;
let injectedContainers = false;

// === A) Tag every <div class="pb-row"> with data-setting="X" ===
//
// Scan all `id="pb-<key>"` attribute occurrences with their line numbers first.
// Then for each <div class="pb-row"> opener, look FORWARD (within up to 12 lines,
// until its matching </div>) for the first such id belonging to the row.
const idRe = /\bid=\"pb-([a-zA-Z]+)\"/;
const idsByLine = []; // [{line, key}]
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(idRe);
  if (m) idsByLine.push({ line: i, key: m[1] });
}

const ROW_OPENS = []; // line indexes where <div class="pb-row"> opens
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('<div class="pb-row">')) ROW_OPENS.push(i);
}

const tagRe = new RegExp('<div class="pb-row">');
let next = 0; // pointer into idsByLine
for (const rowLine of ROW_OPENS) {
  // Skip if this line already has data-setting= (idempotent re-run)
  if (lines[rowLine].includes('data-setting=')) continue;

  // Find the first id on a line >= rowLine and within ~6 lines (within the row)
  let key = null;
  while (next < idsByLine.length && idsByLine[next].line < rowLine) next++;
  if (next < idsByLine.length && idsByLine[next].line <= rowLine + 6) {
    key = idsByLine[next].key;
  } else if (next > 0 && idsByLine[next - 1].line <= rowLine + 6) {
    key = idsByLine[next - 1].key;
  }
  if (!key) {
    console.warn(`[warn] row at line ${rowLine + 1}: no id found nearby`);
    continue;
  }

  lines[rowLine] = lines[rowLine].replace(
    tagRe,
    `<div class="pb-row" data-setting="${key}">`,
  );
  taggedRows++;
}
console.log(`[ok] tagged ${taggedRows} .pb-row elements with data-setting`);

// === B) Inject #pb-key-settings + #pb-more-settings containers ===
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].includes('<div id="pb-active-name">')) continue;
  if (lines[i + 1] && lines[i + 1].trim() === '</div>') {
    const closeIdx = i + 1;
    const insertion = [
      '        <div class="pb-section">',
      '            <div class="pb-label">Settings</div>',
      '            <div id="pb-key-settings"></div>',
      '        </div>',
      '        <div class="pb-section">',
      '            <div class="pb-label">Advanced</div>',
      '            <button id="pb-more-toggle" type="button" aria-expanded="true">▾</button>',
      '            <div id="pb-more-body"></div>',
      '        </div>',
    ];
    lines.splice(closeIdx + 1, 0, ...insertion);
    injectedContainers = true;
    console.log(`[ok] injected #pb-key-settings + #pb-more-settings at line ${closeIdx + 2}`);
    break;
  }
}
if (!injectedContainers) console.warn('[warn] could not inject container divs');

s = lines.join(LF);
if (s !== original) {
  fs.writeFileSync(FILE, s, 'utf8');
  console.log(`[ok] wrote ${FILE}`);
} else {
  console.log('[skip] no changes written');
}
console.log('done');
