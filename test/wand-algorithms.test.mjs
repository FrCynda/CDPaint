/**
 * Golden-mask regression tests.
 *
 * Compares the new incremental / priority-flood algorithms against the
 * legacy per-tick full-scan / stack-flood references at EVERY tolerance
 * value 0..255 for a matrix of synthetic test images.
 *
 * Run: node test/wand-algorithms.test.js  (no deps required)
 */

import { legacyGlobalMask, legacyFloodFillMask } from './reference-impls.mjs';

// The new algorithms will be imported from here once Tasks 3/4 are
// implemented. Until then, the tests that exercise them are skipped.
import * as WandAlgorithms from '../src/js/wand-algorithms.js';

/* ─── Test utilities ─────────────────────────────────────────────────── */

let passed = 0;
let failed = 0;

function assert(cond, msg) {
    if (cond) { passed++; return; }
    failed++;
    console.error(`  FAIL: ${msg}`);
}

function masksEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function maskDiffLabel(a, b, w, h) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            const x = i % w, y = (i / w) | 0;
            return `(x=${x},y=${y}): got ${a[i]} expected ${b[i]}`;
        }
    }
    return 'identical';
}

/* ─── Test images ────────────────────────────────────────────────────── */

/**
 * Each test image: { name, width, height, data: Uint8Array(diff values) }
 * Data is a flat array of per-pixel diff values (0..255), exactly as
 * PaintEngine.state.wandDiff would be after a wand click.
 */
const TEST_IMAGES = [];

// 8x8 gradient-like pattern
(function () {
    const w = 8, h = 8;
    const d = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
            d[y * w + x] = (x + y) * 16;
    TEST_IMAGES.push({ name: '8x8 diagonal gradient', width: w, height: h, data: d });
})();

// 8x8 checkerboard (high-frequency edges)
(function () {
    const w = 8, h = 8;
    const d = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
            d[y * w + x] = (x + y) % 2 === 0 ? 5 : 100;
    TEST_IMAGES.push({ name: '8x8 checkerboard', width: w, height: h, data: d });
})();

// 16x16 random-ish values
(function () {
    const w = 16, h = 16;
    const d = new Uint8Array(w * h);
    // Deterministic pseudo-random (seed + LCG), so results are reproducible.
    let seed = 42;
    for (let i = 0; i < d.length; i++) {
        seed = (seed * 1664525 + 1013904223) & 0xffffffff;
        d[i] = (seed >>> 24) & 0xff;
    }
    TEST_IMAGES.push({ name: '16x16 deterministic pseudo-random', width: w, height: h, data: d });
})();

// 16x16 all identical (edge case: everything selected at tolerance ≥ diff)
(function () {
    const w = 16, h = 16;
    const d = new Uint8Array(w * h);
    d.fill(42);
    TEST_IMAGES.push({ name: '16x16 uniform', width: w, height: h, data: d });
})();

/* ─── Tests ──────────────────────────────────────────────────────────── */

console.log('wand-algorithms test suite\n');

/* ── 1. Legacy reference self-consistency ──────────────────────────────── */

console.log('--- 1. Legacy reference self-consistency ---');

for (const img of TEST_IMAGES) {
    const { name, width: w, height: h, data: diff } = img;
    const seedX = 0, seedY = 0;

    // Sample tolerances at key boundaries rather than all 256 — enough to
    // verify the reference functions produce correct structure.
    const sampleTols = [0, 1, 5, 10, 42, 100, 200, 254, 255];

    for (const tol of sampleTols) {
        const globalRef = legacyGlobalMask(diff, tol);
        const floodRef = legacyFloodFillMask(diff, w, h, seedX, seedY, tol);

        // Global mask: verify every pixel
        for (let i = 0; i < diff.length; i++) {
            const expected = diff[i] <= tol ? 1 : 0;
            assert(globalRef[i] === expected,
                `${name} @tol=${tol}: global pixel ${i} expected ${expected} got ${globalRef[i]}`);
            if (failed > 10) { console.error('  (too many failures, aborting)'); process.exit(1); }
        }

        // Flood-fill: binary values, correct length
        assert(floodRef.length === diff.length,
            `${name} @tol=${tol}: flood mask length ${floodRef.length} !== ${diff.length}`);
        for (let i = 0; i < floodRef.length; i++) {
            assert(floodRef[i] === 0 || floodRef[i] === 1,
                `${name} @tol=${tol}: flood mask[${i}] = ${floodRef[i]}, expected 0 or 1`);
            if (failed > 10) { console.error('  (too many failures, aborting)'); process.exit(1); }
        }
    }
}

/* ── 2. Incremental global vs legacy reference ────────────────────────── */

console.log('\n--- 2. Incremental global vs legacy (requires wand-algorithms.js) ---');

if (WandAlgorithms._WAND_ALGORITHMS_READY) {

    for (const img of TEST_IMAGES) {
        const { name, width: w, height: h, data: diff } = img;

        const sortedIdx = WandAlgorithms.buildSortedDiffIndex(diff);
        const maskBuf = new Uint8Array(diff.length);
        let prevCutoff = 0;

        for (let tol = 0; tol <= 255; tol++) {
            const legacy = legacyGlobalMask(diff, tol);
            const result = WandAlgorithms.applyToleranceIncremental(
                diff, sortedIdx, prevCutoff, tol, maskBuf, w
            );
            prevCutoff = result.cutoff;

            assert(masksEqual(legacy, maskBuf),
                `${name} @tol=${tol}: mismatch ${maskDiffLabel(legacy, maskBuf, w, h)}`);
            if (failed > 5) { console.error('  (too many failures, aborting)'); process.exit(1); }
        }
    }
} else {
    console.log('  (skipped — wand-algorithms.js not yet populated with Task 3 exports)');
}

/* ── 3. Priority-flood contiguous vs legacy reference ─────────────────── */

console.log('\n--- 3. Priority-flood contiguous vs legacy (requires wand-algorithms.js) ---');

if (WandAlgorithms._WAND_ALGORITHMS_READY && typeof WandAlgorithms.buildPriorityFlood === 'function') {

    for (const img of TEST_IMAGES) {
        const { name, width: w, height: h, data: diff } = img;
        const seedX = 0, seedY = 0;

        const entered = WandAlgorithms.buildPriorityFlood(diff, w, h, seedX, seedY);
        const sortedIdx = WandAlgorithms.buildSortedDiffIndex(entered);
        const maskBuf = new Uint8Array(diff.length);
        let prevCutoff = 0;

        for (let tol = 0; tol <= 255; tol++) {
            const legacy = legacyFloodFillMask(diff, w, h, seedX, seedY, tol);
            const result = WandAlgorithms.applyToleranceIncremental(
                entered, sortedIdx, prevCutoff, tol, maskBuf, w
            );
            prevCutoff = result.cutoff;

            assert(masksEqual(legacy, maskBuf),
                `${name} @tol=${tol}: mismatch ${maskDiffLabel(legacy, maskBuf, w, h)}`);
            if (failed > 5) { console.error('  (too many failures, aborting)'); process.exit(1); }
        }
    }
} else {
    console.log('  (skipped — wand-algorithms.js not yet populated with Task 4 exports)');
}

/* ── 4. Non-monotonic global (oscillating tolerance) ──────────────────── */

console.log('\n--- 4. Non-monotonic global (exercise decrement branch) ---');

if (WandAlgorithms._WAND_ALGORITHMS_READY) {

    for (const img of TEST_IMAGES) {
        const { name, width: w, height: h, data: diff } = img;

        const sortedIdx = WandAlgorithms.buildSortedDiffIndex(diff);
        const maskBuf = new Uint8Array(diff.length);
        let prevCutoff = 0;

        // Oscillating tolerance: up, down, up
        const tols = [0, 10, 50, 100, 200, 100, 50, 10, 0, 255, 0, 255];
        for (const tol of tols) {
            const legacy = legacyGlobalMask(diff, tol);
            const result = WandAlgorithms.applyToleranceIncremental(
                diff, sortedIdx, prevCutoff, tol, maskBuf, w
            );
            prevCutoff = result.cutoff;

            assert(masksEqual(legacy, maskBuf),
                `${name} @tol=${tol}: mismatch ${maskDiffLabel(legacy, maskBuf, w, h)}`);
            if (failed > 5) { console.error('  (too many failures, aborting)'); process.exit(1); }
        }
    }
} else {
    console.log('  (skipped — wand-algorithms.js not ready)');
}

/* ── 5. Non-monotonic contiguous (oscillating tolerance) ──────────────── */

console.log('\n--- 5. Non-monotonic contiguous (exercise decrement branch) ---');

if (WandAlgorithms._WAND_ALGORITHMS_READY && typeof WandAlgorithms.buildPriorityFlood === 'function') {

    for (const img of TEST_IMAGES) {
        const { name, width: w, height: h, data: diff } = img;
        const seedX = 0, seedY = 0;

        const entered = WandAlgorithms.buildPriorityFlood(diff, w, h, seedX, seedY);
        const sortedIdx = WandAlgorithms.buildSortedDiffIndex(entered);
        const maskBuf = new Uint8Array(diff.length);
        let prevCutoff = 0;

        const tols = [0, 10, 50, 100, 200, 100, 50, 10, 0, 255, 0, 255];
        for (const tol of tols) {
            const legacy = legacyFloodFillMask(diff, w, h, seedX, seedY, tol);
            const result = WandAlgorithms.applyToleranceIncremental(
                entered, sortedIdx, prevCutoff, tol, maskBuf, w
            );
            prevCutoff = result.cutoff;

            assert(masksEqual(legacy, maskBuf),
                `${name} @tol=${tol}: mismatch ${maskDiffLabel(legacy, maskBuf, w, h)}`);
            if (failed > 5) { console.error('  (too many failures, aborting)'); process.exit(1); }
        }
    }
} else {
    console.log('  (skipped — buildPriorityFlood not yet implemented)');
}

/* ── Summary ──────────────────────────────────────────────────────────── */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
