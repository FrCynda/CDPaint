/**
 * Bundle CDPaint into a single self-contained HTML file.
 *
 * Inlines all JS, CSS, and images as data URIs so the file works
 * when opened from any location (no relative path dependencies).
 *
 * Usage:  node scripts/bundle-standalone.js
 * Output: ~/Desktop/cdpaint.html
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Configuration ──────────────────────────────────────────────────────────
const SRC    = path.resolve(__dirname, '..', 'src');
const OUT    = path.resolve(
    process.env.USERPROFILE || process.env.HOME || __dirname,
    'Desktop',
    'cdpaint.html'
);

const MIME_TYPES = {
    '.png'  : 'image/png',
    '.svg'  : 'image/svg+xml',
    '.gif'  : 'image/gif',
    '.jpg'  : 'image/jpeg',
    '.jpeg' : 'image/jpeg',
    '.webp' : 'image/webp',
    '.ico'  : 'image/x-icon',
    '.bmp'  : 'image/bmp',
};

// ── Helpers ────────────────────────────────────────────────────────────────

function mimeOf(filePath) {
    return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function isBinary(mime) {
    return !mime.startsWith('text/') && mime !== 'application/json';
}

const dataUriCache = new Map();

function fileToDataUri(absPath) {
    if (dataUriCache.has(absPath)) return dataUriCache.get(absPath);
    const buf = fs.readFileSync(absPath);
    const mime = mimeOf(absPath);
    let uri;
    if (mime === 'image/svg+xml') {
        // Inline SVG as UTF-8 data URI (smaller than base64 and preserves
        // readability in the output).
        const svg = buf.toString('utf8').replace(/^\uFEFF/, '');
        uri = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    } else {
        uri = `data:${mime};base64,${buf.toString('base64')}`;
    }
    dataUriCache.set(absPath, uri);
    return uri;
}

function readFileSafe(absPath) {
    try {
        let text = fs.readFileSync(absPath, 'utf8');
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM
        return text;
    } catch (e) {
        return null;
    }
}

function replaceAll(str, search, replacement) {
    return str.split(search).join(replacement);
}

// ── Asset index ────────────────────────────────────────────────────────────
// Build two lookup maps:
//   1. absolute path  →  data URI
//   2. filename only  →  [absolute path, ...]  (for ambiguous short-name resolution)

const absToUri   = new Map();   // full absolute path → data URI
const nameToAbs  = new Map();   // base filename      → [absolute paths...]

function indexDirectory(dirPath) {
    let entries;
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const full = path.join(dirPath, e.name);
        if (e.isDirectory()) {
            indexDirectory(full);
        } else {
            const uri = fileToDataUri(full);
            absToUri.set(full, uri);
            const base = e.name.toLowerCase();
            if (!nameToAbs.has(base)) nameToAbs.set(base, []);
            nameToAbs.get(base).push(full);
        }
    }
}

// Index assets/ + app-icon.png at root
const assetRoot = path.join(SRC, 'assets');
if (fs.existsSync(assetRoot)) indexDirectory(assetRoot);
const rootIcon = path.join(SRC, 'app-icon.png');
if (fs.existsSync(rootIcon)) {
    absToUri.set(rootIcon, fileToDataUri(rootIcon));
    nameToAbs.set('app-icon.png', [rootIcon]);
}

// ── Resolve a relative reference to a data URI ─────────────────────────────
// Tries, in order:
//   a) ./assets/foo.png → SRC/assets/foo.png
//   b) assets/foo.png   → SRC/assets/foo.png
//   c) assets/foo.png   → SRC/foo.png
//   d) foo.png          → SRC/assets/foo.png  (if unique)
//   e) ./foo.png        → SRC/foo.png

function resolveToUri(ref) {
    const clean = ref.replace(/^\.\//, '').replace(/^\//, '').replace(/\\/g, '/');

    // Direct path under SRC
    let abs = path.resolve(SRC, clean);
    if (absToUri.has(abs)) return absToUri.get(abs);

    // Prepend assets/
    abs = path.resolve(SRC, 'assets', clean);
    if (absToUri.has(abs)) return absToUri.get(abs);

    // Try full path under SRC (for ./app-icon.png)
    abs = path.resolve(SRC, clean);
    if (absToUri.has(abs)) return absToUri.get(abs);

    // Short name — unique match in the asset index
    const base = path.basename(clean).toLowerCase();
    if (nameToAbs.has(base)) {
        const candidates = nameToAbs.get(base);
        if (candidates.length === 1) return absToUri.get(candidates[0]);
        // Multiple files with the same name — try matching the full relative path
        for (const c of candidates) {
            const rel = path.relative(SRC, c).replace(/\\/g, '/');
            if (rel === clean || rel === path.join('assets', clean).replace(/\\/g, '/')) {
                return absToUri.get(c);
            }
        }
    }

    return null;
}

// ── Collect all unique asset references from a blob of text ────────────────
// Returns an array of { raw, inner } where `raw` is the original quoted
// or backtick string and `inner` is the path inside the quotes.

function findAssetRefs(text) {
    const seen = new Set();
    const refs = [];

    function add(raw, inner) {
        if (seen.has(raw)) return;
        seen.add(raw);
        refs.push({ raw, inner: inner.replace(/^\.\//, '') });
    }

    // Single/double quoted: 'assets/...', "assets/...", './assets/...'
    const qRe = /['"]((?:\.\/)?(?:assets|app-icon)[^'"]*\.(?:png|svg|gif|jpg|jpeg|webp|ico|bmp))['"]/gi;
    let m;
    while ((m = qRe.exec(text)) !== null) add(m[0], m[1]);

    // Backtick template literals with simple known paths: `assets/foo.png`
    const btRe = /`((?:\.\/)?(?:assets|app-icon)[^`]*\.(?:png|svg|gif|jpg|jpeg|webp|ico|bmp))`/gi;
    while ((m = btRe.exec(text)) !== null) add(m[0], m[1]);

    // JS strings where the full path is concatenated from known parts:
    // e.g. 'assets/' + name + '.png'  — only if the literal part includes 'assets/'
    // We look for: 'assets/FILENAME.EXT' where FILENAME.EXT is literal
    // This is already handled by the first pattern. For dynamic parts like
    // 'assets/' + var + '.png' we can't resolve statically — skip them.

    // CSS url() references (unused in this project, but keep for robustness)
    const cssRe = /url\(["']?((?:\.\/)?(?:assets|app-icon)[^"')]+\.[a-z]+)["']?\)/gi;
    while ((m = cssRe.exec(text)) !== null) {
        const raw = m[0];
        const inner = m[1];
        if (!seen.has(raw)) { seen.add(raw); refs.push({ raw, inner }); }
    }

    return refs;
}

// ── Main ───────────────────────────────────────────────────────────────────

let html = readFileSafe(path.join(SRC, 'index.html'));
if (!html) {
    console.error('FATAL: src/index.html not found at', path.join(SRC, 'index.html'));
    process.exit(1);
}

const warnings = [];
let cssInlined = 0, jsInlined = 0, imgInlined = 0;

// ── Step 1: Inline CSS ─────────────────────────────────────────────────────
html = html.replace(
    /<link\s+rel=["']stylesheet["']\s+href=["']([^"']+)["']\s*\/?>/gi,
    (match, href) => {
        const abs = path.resolve(SRC, href);
        const css = readFileSafe(abs);
        if (css === null) {
            warnings.push(`CSS file not found: ${abs}`);
            return match;
        }
        cssInlined++;
        return `<style>\n${css}\n</style>`;
    }
);

// ── Step 2: Inline JS files ────────────────────────────────────────────────
html = html.replace(
    /<script\s+src=["']([^"']+)["']><\/script>/gi,
    (match, src) => {
        const abs = path.resolve(SRC, src);
        const code = readFileSafe(abs);
        if (code === null) {
            warnings.push(`JS file not found: ${abs}`);
            return match;
        }
        jsInlined++;
        return `<script>\n${code}\n</script>`;
    }
);

// ── Step 3: Convert local asset references to data URIs ────────────────────
const refs = findAssetRefs(html);
const unresolved = [];

for (const { raw, inner } of refs) {
    const uri = resolveToUri(inner);
    if (uri) {
        // Replace the original (quoted) reference with the data URI (always
        // double-quoted so it works in both HTML and JS contexts).
        const replacement = `"${uri}"`;
        html = replaceAll(html, raw, replacement);
        imgInlined++;
    } else {
        unresolved.push(inner);
    }
}

// ── Step 4: Remove Tauri window controls ───────────────────────────────────
html = html.replace(
    /<button\s+class="title-btn[^"]*"\s+id="title-(?:minimize|maximize|close)"[^>]*>.*?<\/button>\s*/gi,
    ''
);

// ── Step 5: Post-build verification ────────────────────────────────────────
// Scan for any remaining path patterns that look like un-inlined local files.
const leftoverRe = /['"`]((?:\.\/)?(?:assets|app-icon)[^'"`]+\.[a-z]+)['"`]/gi;
const leftovers = [];
let lm;
while ((lm = leftoverRe.exec(html)) !== null) {
    const p = lm[1];
    // Skip data: URIs
    if (p.startsWith('data:')) continue;
    // Skip external URLs
    if (p.startsWith('http://') || p.startsWith('https://')) continue;
    leftovers.push(p);
}

// Deduplicate
const uniqueLeftovers = [...new Set(leftovers)];
if (uniqueLeftovers.length > 0) {
    warnings.push(
        `${uniqueLeftovers.length} local asset path(s) were NOT inlined:\n` +
        uniqueLeftovers.map(s => `  ${s}`).join('\n')
    );
}

// ── Write output ───────────────────────────────────────────────────────────
const outDir = path.dirname(OUT);
try { fs.mkdirSync(outDir, { recursive: true }); } catch {}

fs.writeFileSync(OUT, html, 'utf8');
const sizeKB = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);

// ── Report ─────────────────────────────────────────────────────────────────
console.log('');
console.log('── Bundle complete ────────────────────────');
console.log(`  Output  : ${OUT}`);
console.log(`  Size    : ${sizeKB} KB`);
console.log(`  CSS     : ${cssInlined} file(s) inlined`);
console.log(`  JS      : ${jsInlined} file(s) inlined`);
console.log(`  Images  : ${imgInlined} reference(s) → data URI`);
console.log('───────────────────────────────────────────');

if (unresolved.length > 0) {
    console.warn(`\n⚠  ${unresolved.length} asset(s) could not be resolved (file missing?):`);
    for (const r of unresolved) console.warn(`   ${r}`);
}

if (warnings.length > 0) {
    for (const w of warnings) console.warn(`⚠  ${w}`);
}

if (uniqueLeftovers.length > 0) {
    console.error('\n✖  Output still contains un-inlined local paths.');
    process.exit(1);
}

console.log('✓  Output verified — no remaining local file references.\n');
