// @ts-check
/**
 * Pure (stateless) wand mask algorithms.
 *
 * This is the single source of truth for the wand algorithms. It is imported
 * by test/wand-algorithms.test.mjs AND by paint-engine.js at runtime via an
 * inline ES-module bootstrap in index.html that assigns it to
 * window.__wandAlgorithms. paint-engine.js must NOT keep its own copies.
 *
 * Tasks 3-5 of the wand-perf plan.
 */

export const _WAND_ALGORITHMS_READY = true;

/**
 * Priority flood (Dijkstra on 4-connected grid with max-as-cost).
 *
 * For each pixel computes the minimum possible maximum-diff along any
 * path from the seed — i.e. the tolerance at which that pixel would
 * first be reached by a contiguous flood fill. O(n log n) worst case.
 *
 * Returns a Uint8Array of length w*h with values 0..255.
 */
export function buildPriorityFlood(diff, w, h, seedX, seedY) {
    const n = w * h;
    const entered = new Uint8Array(n);
    entered.fill(255);
    const seedIdx = seedY * w + seedX;
    entered[seedIdx] = diff[seedIdx];
    const heap = new Uint32Array(n + 1);
    let heapSize = 0;
    const push = (idx) => {
        let i = ++heapSize, pi = i >> 1;
        while (pi > 0 && entered[heap[pi]] > entered[idx]) { heap[i] = heap[pi]; i = pi; pi = i >> 1; }
        heap[i] = idx;
    };
    const pop = () => {
        const min = heap[1], last = heap[heapSize--];
        let i = 1, ci = 2;
        while (ci <= heapSize) {
            if (ci + 1 <= heapSize && entered[heap[ci + 1]] < entered[heap[ci]]) ci++;
            if (entered[last] <= entered[heap[ci]]) break;
            heap[i] = heap[ci]; i = ci; ci = i << 1;
        }
        heap[i] = last;
        return min;
    };
    const relax = (nIdx, val) => {
        const nd = diff[nIdx];
        const newVal = nd > val ? nd : val;
        if (newVal < entered[nIdx]) { entered[nIdx] = newVal; push(nIdx); }
    };
    push(seedIdx);
    while (heapSize > 0) {
        const idx = pop(), val = entered[idx], y = (idx / w) | 0, x = idx - y * w;
        if (x > 0)     relax(idx - 1, val);
        if (x < w - 1) relax(idx + 1, val);
        if (y > 0)     relax(idx - w, val);
        if (y < h - 1) relax(idx + w, val);
    }
    return entered;
}

/**
 * Counting sort over diff values (0..255). O(n), single pass.
 * Returns a Uint32Array of pixel indices sorted ascending by diff[i].
 */
export function buildSortedDiffIndex(diff) {
    const n = diff.length;
    const counts = new Uint32Array(256);
    for (let i = 0; i < n; i++) counts[diff[i]]++;
    const offsets = new Uint32Array(256);
    for (let v = 1; v < 256; v++) offsets[v] = offsets[v - 1] + counts[v - 1];
    const cursor = offsets.slice();
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[cursor[diff[i]]++] = i;
    return idx;
}

/**
 * Incremental mask update using a pre-sorted index.
 *
 * Given a keyArray (diff values or entered-at-tol values), a sorted index
 * over it, the previous cutoff in that index, and a new tolerance:
 * walks only the newly (de)selected pixels, mutating maskBuf in place.
 *
 * Returns { cutoff, dirty } where dirty is { x, y, w, h } or null.
 */
export function applyToleranceIncremental(keyArray, sortedIdx, prevCutoff, tolerance, maskBuf, width) {
    const n = sortedIdx.length;

    // Binary search for how many sorted entries satisfy keyArray[i] <= tolerance.
    let lo = 0, hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (keyArray[sortedIdx[mid]] <= tolerance) lo = mid + 1; else hi = mid;
    }
    const newCutoff = lo;
    const realPrev = prevCutoff < 0 ? 0 : prevCutoff;

    let dirtyMinX = Infinity, dirtyMinY = Infinity, dirtyMaxX = -Infinity, dirtyMaxY = -Infinity;
    const mark = (px) => {
        const x = px % width, y = (px / width) | 0;
        if (x < dirtyMinX) dirtyMinX = x;
        if (x > dirtyMaxX) dirtyMaxX = x;
        if (y < dirtyMinY) dirtyMinY = y;
        if (y > dirtyMaxY) dirtyMaxY = y;
    };

    if (newCutoff > realPrev) {
        for (let k = realPrev; k < newCutoff; k++) {
            const px = sortedIdx[k];
            maskBuf[px] = 1;
            mark(px);
        }
    } else if (newCutoff < realPrev) {
        for (let k = newCutoff; k < realPrev; k++) {
            const px = sortedIdx[k];
            maskBuf[px] = 0;
            mark(px);
        }
    }

    return {
        cutoff: newCutoff,
        dirty: dirtyMinX === Infinity ? null : { x: dirtyMinX, y: dirtyMinY, w: dirtyMaxX - dirtyMinX + 1, h: dirtyMaxY - dirtyMinY + 1 }
    };
}
