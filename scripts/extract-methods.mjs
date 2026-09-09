/* Moves methods off the PaintEngine class body into a prototype-mixin file.
 *
 *   node scripts/extract-methods.mjs <mixin-name> <method> [method...]
 *
 * The split is purely mechanical: method bodies are copied verbatim, never
 * rewritten. `this` still means the same object, so behaviour is unchanged by
 * construction — the only thing that moves is which file the text lives in.
 *
 * Safety rests on one invariant, asserted before anything is written: the text
 * removed from paint-engine.js must equal the text placed in the mixin, byte
 * for byte. If that holds, no code was lost, duplicated or truncated, whatever
 * the slicer did.
 *
 * Method boundaries come from the *next* method's start line rather than brace
 * matching, then any slice whose braces do not balance absorbs the following
 * one. That repairs false starts such as the GLSL shader inside getHueSatGL(),
 * where a line of shader source looks exactly like a method declaration.
 */
import { readFileSync, writeFileSync } from 'fs';

const SRC = 'src/js/paint-engine.js';
const [mixinName, ...wanted] = process.argv.slice(2);
if (!mixinName || !wanted.length) {
    console.error('usage: extract-methods.mjs <mixin-name> <method> [method...]');
    process.exit(1);
}

const raw = readFileSync(SRC, 'utf8');
const EOL = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(/\r?\n/);

const CLASS_START = lines.findIndex(l => /^\s*class PaintEngine\b/.test(l));
const CLASS_END = lines.findIndex((l, i) => i > CLASS_START && /^    \}$/.test(l));
if (CLASS_START < 0 || CLASS_END < 0) throw new Error('could not locate the class body');

/* Strip strings, template literals, comments and regex literals so that brace
 * counting sees only real code. */
function strip(src) {
    let out = '', i = 0, prevSig = '';
    const n = src.length;
    while (i < n) {
        const c = src[i], d = src[i + 1];
        if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
        if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
        if (c === '"' || c === "'" || c === '`') {
            const q = c; i++;
            while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; }
            i++; out += '_'; prevSig = '_'; continue;
        }
        if (c === '/' && /[=(,:[!&|?{};+\-*%~^]/.test(prevSig)) {
            i++; let cls = false;
            while (i < n) {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === '[') cls = true;
                else if (src[i] === ']') cls = false;
                else if ((src[i] === '/' && !cls) || src[i] === '\n') break;
                i++;
            }
            i++; out += '_'; prevSig = '_'; continue;
        }
        out += c;
        if (!/\s/.test(c)) prevSig = c;
        i++;
    }
    return out;
}
const depthOf = txt => {
    const s = strip(txt);
    return (s.match(/\{/g) || []).length - (s.match(/\}/g) || []).length;
};

const isMethod = l =>
    /^ {8}(async )?[A-Za-z_$][\w$]*\s*\(/.test(l) &&
    !/^ {8}(if|for|while|switch|catch|return|else|do)\b/.test(l);

const cand = [];
for (let i = CLASS_START + 1; i < CLASS_END; i++) if (isMethod(lines[i])) cand.push(i);

const methods = [];
for (let k = 0; k < cand.length;) {
    const a = cand[k];
    let j = k + 1, b;
    for (;;) {
        b = (j < cand.length ? cand[j] : CLASS_END);
        if (depthOf(lines.slice(a, b).join('\n')) === 0 || b === CLASS_END) break;
        j++;
    }
    const name = (lines[a].trim().match(/^(?:async\s+)?([\w$]+)/) || [])[1];
    methods.push({ a, b, name });
    k = j;
}

const taken = methods.filter(m => wanted.includes(m.name));
const missing = wanted.filter(w => !taken.some(m => m.name === w));
if (missing.length) throw new Error(`not found in the class body: ${missing.join(', ')}`);

/* Removed text and mixin text must match exactly. Methods sit at 8-space indent
 * in a class body and 4-space in an object literal, so the mixin is compared
 * after re-indenting it back, not as written. */
const removed = taken.map(m => lines.slice(m.a, m.b).join(EOL)).join(EOL);

const body = taken.map(m => {
    const src = lines.slice(m.a, m.b);
    // Trailing blank lines belong between entries, not inside one.
    while (src.length && !src[src.length - 1].trim()) src.pop();
    return src.map(l => (l.trim() ? '    ' + l : l)).join(EOL);
}).join(',' + EOL + EOL);

const mixin = [
    `/* ${mixinName} — moved verbatim off the PaintEngine class body.`,
    ` *`,
    ` * Assigned onto the prototype, so \`this\` is the same PaintEngine instance`,
    ` * these methods have always run against. Loads after paint-engine.js and`,
    ` * before boot.js, which is where the instance is finally created.`,
    ` */`,
    `(function () {`,
    `    Object.assign(PaintEngine.prototype, {`,
    body,
    `    });`,
    `})();`,
    ''
].join(EOL);

// Re-derive what the mixin contributes and compare against what was cut.
const reindented = body
    .split(EOL)
    .map(l => (l.startsWith('    ') ? l.slice(4) : l))
    .join(EOL)
    .split(',' + EOL + EOL)
    .join(EOL);
const norm = s => s.replace(/[ \t]+$/gm, '').replace(/(\r?\n)+$/g, '').replace(/(\r?\n)\s*(\r?\n)/g, '$1');
if (norm(reindented) !== norm(removed)) {
    console.error('ABORT: mixin text does not match the text removed from the class.');
    process.exit(1);
}

// Rebuild paint-engine.js without the extracted methods.
const drop = new Set();
taken.forEach(m => { for (let i = m.a; i < m.b; i++) drop.add(i); });
const kept = lines.filter((_, i) => !drop.has(i));

writeFileSync(`src/js/${mixinName}.js`, mixin);
writeFileSync(SRC, kept.join(EOL));

console.log(`${mixinName}: ${taken.length} methods, ${removed.split(EOL).length} lines`);
console.log(`  paint-engine.js  ${lines.length} -> ${kept.length}`);
console.log(`  round-trip       text removed === text in mixin`);
