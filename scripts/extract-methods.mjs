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
if (CLASS_START < 0) throw new Error('could not locate the class');

/* Strip strings, template literals, comments and regex literals so that brace
 * counting sees only real code.
 *
 * Newlines inside what is removed are kept, so the stripped text still has the
 * same number of lines as the original and line numbers stay usable. Without
 * that, a multi-line template literal shifts every line after it. */
function strip(src) {
    const keepEol = s => s.replace(/[^\n]/g, '');
    let out = '', i = 0, prevSig = '';
    const n = src.length;
    while (i < n) {
        const c = src[i], d = src[i + 1];
        if (c === '/' && d === '/') { const a = i; while (i < n && src[i] !== '\n') i++; out += keepEol(src.slice(a, i)); continue; }
        if (c === '/' && d === '*') { const a = i; i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; out += keepEol(src.slice(a, i)); continue; }
        if (c === '"' || c === "'" || c === '`') {
            const q = c, a = i; i++;
            while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; }
            i++; out += '_' + keepEol(src.slice(a, i)); prevSig = '_'; continue;
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

// Stripped once, aligned line for line with `lines`.
const codeLines = strip(lines.join('\n')).split('\n');
if (codeLines.length !== lines.length) throw new Error('strip() lost line alignment');
const depthAt = i => {
    const l = codeLines[i] || '';
    return (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
};
const depthOfRange = (a, b) => { let d = 0; for (let i = a; i < b; i++) d += depthAt(i); return d; };

/* The class closes where its own brace depth returns to zero. A line-pattern
 * search cannot find it: `^    }` also matches inside the GLSL shader source
 * embedded in getHueSatGL(), which silently truncates the class body and hides
 * every method defined after it. */
let CLASS_END = -1;
for (let i = CLASS_START, depth = 0; i < lines.length; i++) {
    depth += depthAt(i);
    if (i > CLASS_START && depth === 0) { CLASS_END = i; break; }
}
if (CLASS_END < 0) throw new Error('could not locate the end of the class body');

/* A declaration in real code. The stripped line is checked too: a line of GLSL
 * inside a template literal can look exactly like a method declaration, and in
 * stripped code that line is blank. */
const isMethod = i =>
    /^ {8}(async )?[A-Za-z_$][\w$]*\s*\(/.test(lines[i]) &&
    !/^ {8}(if|for|while|switch|catch|return|else|do)\b/.test(lines[i]) &&
    codeLines[i].trim() !== '';

/* Members that must not be moved. They still have to end the preceding method's
 * slice, or they get dragged along inside it — which is how
 * `static _freehandEasingMap` ended up in a mixin and failed to parse.
 *
 *   static members and class fields  no meaning in an object literal
 *   get / set accessors              Object.assign COPIES THE VALUE: it would
 *                                    invoke the getter once and assign whatever
 *                                    it returned, turning an accessor into a
 *                                    frozen property. Silent, and wrong.
 */
const isClassOnly = i =>
    codeLines[i].trim() !== '' && (
        /^ {8}static\b/.test(lines[i]) ||
        /^ {8}(get|set)\s+[A-Za-z_$][\w$]*\s*\(/.test(lines[i]) ||
        /^ {8}#?[A-Za-z_$][\w$]*\s*=[^=]/.test(lines[i]));

const cand = [];
const barrier = new Set();
for (let i = CLASS_START + 1; i < CLASS_END; i++) {
    if (isMethod(i)) cand.push(i);
    else if (isClassOnly(i)) { cand.push(i); barrier.add(i); }
}

const methods = [];
for (let k = 0; k < cand.length;) {
    const a = cand[k];
    let j = k + 1, b;
    for (;;) {
        b = (j < cand.length ? cand[j] : CLASS_END);
        if (depthOfRange(a, b) === 0 || b === CLASS_END) break;
        j++;
    }
    const name = (lines[a].trim().match(/^(?:async\s+)?([\w$]+)/) || [])[1];
    methods.push({ a, b, name, movable: !barrier.has(a) });
    k = j;
}

const taken = methods.filter(m => m.movable && wanted.includes(m.name));

/* A slice that still swallowed a class-only line cannot be moved as-is. */
for (const m of taken) {
    for (let i = m.a + 1; i < m.b; i++) {
        if (barrier.has(i)) {
            console.error(`ABORT: ${m.name} spans the class-only declaration at line ${i + 1}:`);
            console.error(`  ${lines[i].trim()}`);
            process.exit(1);
        }
    }
}
const missing = wanted.filter(w => !taken.some(m => m.name === w));
if (missing.length) throw new Error(`not found in the class body: ${missing.join(', ')}`);

/* Removed text and mixin text must match exactly. Methods sit at 8-space indent
 * in a class body and 4-space in an object literal, so the mixin is compared
 * after re-indenting it back, not as written. */
const removed = taken.map(m => lines.slice(m.a, m.b).join(EOL)).join(EOL);

/* Each entry needs a comma after it, and it has to land on the line that closes
 * the method. A slice runs to the *next* declaration, so it often ends with the
 * blank lines and lead-in comment belonging to the method that follows; a comma
 * appended there would sit inside a `//` comment and be swallowed, leaving two
 * entries fused together. Find the real last line of code and mark it. */
const entries = taken.map(m => {
    const src = lines.slice(m.a, m.b);
    let last = src.length - 1;
    while (last >= 0 && (!src[last].trim() || codeLines[m.a + last].trim() === '')) last--;
    return { src, last };
});

const body = entries.map(({ src, last }, i) => src.map((l, j) => {
    const indented = l.trim() ? '    ' + l : l;
    return (j === last && i < entries.length - 1) ? indented + ',' : indented;
}).join(EOL)).join(EOL);

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

/* Undo exactly what was added — the 4-space indent, and the separator comma on
 * each entry's known last line — and require the result to be identical to the
 * text cut out of the class. Nothing is written unless this holds. */
const rebuilt = entries.map(({ src, last }, i) => src.map((l, j) => {
    const indented = l.trim() ? '    ' + l : l;
    const withComma = (j === last && i < entries.length - 1) ? indented + ',' : indented;
    const decommaed = (j === last && i < entries.length - 1) ? withComma.slice(0, -1) : withComma;
    return decommaed.startsWith('    ') ? decommaed.slice(4) : decommaed;
}).join(EOL)).join(EOL);

if (rebuilt !== removed) {
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
