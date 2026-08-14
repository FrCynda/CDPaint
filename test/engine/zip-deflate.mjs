/* Verifies the ZIP deflate path against a REAL CompressionStream.
 *
 * The bug: `await writer.write(data)` before anything reads cs.readable.
 * The write promise only settles once the chunk is accepted downstream, so once
 * the data exceeds the stream's internal queue it blocks on backpressure that
 * can never clear — the save hung forever with no error. Small inputs fit in
 * the queue, which is why it looked like it "sometimes" worked.
 */
import { readFileSync } from 'fs';
import vm from 'vm';

const SRC = process.argv[2] || 'src/js/paint-engine.js';
const lines = readFileSync(SRC, 'utf8').split(/\r?\n/);

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

function extractFn(name) {
    const start = lines.findIndex(l => new RegExp(`function ${name}\\s*\\(`).test(l));
    if (start < 0) throw new Error(`function ${name} not found`);
    let depth = 0, started = false, out = [];
    for (let i = start; i < lines.length; i++) {
        out.push(lines[i]);
        for (const ch of lines[i]) {
            if (ch === '{') { depth++; started = true; }
            else if (ch === '}') depth--;
        }
        if (started && depth === 0) return out.join('\n');
    }
    throw new Error(`unbalanced braces in ${name}`);
}

const sandbox = { console, CompressionStream, DecompressionStream, Response, Uint8Array };
vm.createContext(sandbox);
vm.runInContext(extractFn('deflateRaw') + '\nglobalThis.__f = deflateRaw;', sandbox);
const deflateRaw = sandbox.__f;
console.log(`extracted deflateRaw from ${SRC}\n`);

const withTimeout = (p, ms) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('HUNG (timed out after ' + ms + 'ms)')), ms))
]);

async function inflate(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const done = new Response(ds.readable).arrayBuffer();
    const w = ds.writable.getWriter();
    await w.write(bytes);
    await w.close();
    return new Uint8Array(await done);
}

console.log('== deflate must complete at every size ==');
// A layer PNG is easily hundreds of KB; the stream's internal queue is ~1 chunk,
// so anything past it deadlocked under the old ordering.
for (const size of [16, 1024, 64 * 1024, 512 * 1024, 4 * 1024 * 1024]) {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = (i * 31) & 0xff;   // compressible but not trivial
    let out = null, err = null;
    try {
        out = await withTimeout(deflateRaw(data), 5000);
    } catch (e) { err = e; }
    const label = size >= 1024 ? (size / 1024) + 'KB' : size + 'B';
    check(`deflate completes for ${label}`, !err, err && err.message);
    if (out) {
        const round = await inflate(out);
        check(`  round-trips byte-for-byte at ${label}`,
            round.length === size && round.every((v, i) => v === data[i]));
    }
}

console.log('\n== the fix is structural, not incidental ==');
{
    // Strip comments — the explanatory comment quotes `await writer.write`,
    // which would otherwise be found before the real call.
    const body = extractFn('deflateRaw')
        .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const readerIdx = body.indexOf('new Response(');
    const writeIdx  = body.indexOf('await writer.write');
    check('output is drained before input is written', readerIdx > -1 && readerIdx < writeIdx,
        'reader must be attached first or large writes deadlock');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
