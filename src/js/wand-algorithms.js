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
 * first be reached by a contiguous flood fill.
 *
 * Returns a Uint8Array of length w*h with values 0..255.
 *
 * Implemented as a bucket queue (Dial's algorithm) rather than a binary
 * heap. Two properties of this particular problem make that exact, not an
 * approximation:
 *
 *   - costs are pixel diffs, so they are integers in 0..255 — a fixed 256
 *     buckets covers every key that can ever exist;
 *   - relaxing an edge yields max(currentCost, neighbourDiff), which is
 *     never less than the cost being processed, so keys come out in
 *     non-decreasing order and one forward sweep over the buckets is
 *     enough.
 *
 * That replaces O(n log n) of sift-up/sift-down per pixel with O(n) list
 * pushes, which is the difference between a wand click stalling for over a
 * second on a large canvas and returning promptly. Output is identical to
 * the heap version — test/wand-algorithms.test.mjs checks the resulting
 * masks against a plain flood fill at every tolerance 0..255.
 *
 * 255 doubles as "unreachable": a diff can never exceed it, and the
 * strict `<` in relax() means a pixel only reachable at 255 keeps the 255
 * it was initialised with.
 */
export function buildPriorityFlood(diff, w, h, seedX, seedY) {
    const n = w * h;
    const entered = new Uint8Array(n);
    entered.fill(255);
    const seedIdx = seedY * w + seedX;
    entered[seedIdx] = diff[seedIdx];

    // One growable array per cost. Draining a bucket is then a linear walk
    // over contiguous memory, which matters a lot at this size — the queue
    // holds millions of entries and pointer-chasing a linked pool spends
    // most of its time waiting on cache misses.
    const bucketData = new Array(256).fill(null);
    const bucketLen = new Int32Array(256);

    function push(idx, val) {
        let arr = bucketData[val];
        const len = bucketLen[val];
        if (arr === null) {
            arr = new Uint32Array(256);
            bucketData[val] = arr;
        } else if (len === arr.length) {
            const bigger = new Uint32Array(arr.length * 2);
            bigger.set(arr);
            arr = bigger;
            bucketData[val] = arr;
        }
        arr[len] = idx;
        bucketLen[val] = len + 1;
    }

    push(seedIdx, entered[seedIdx]);

    for (let val = 0; val < 256; val++) {
        let i = 0;
        // A bucket can grow while it is being drained: relaxing an edge
        // whose neighbour diff is <= val lands back in this same bucket.
        // The outer loop picks those up — and re-reads the array, which
        // push() may have replaced with a larger one. Everything inside
        // the inner loop is then loop-invariant, which is what makes this
        // faster than re-reading bucketData[val] per pixel.
        while (i < bucketLen[val]) {
            const arr = bucketData[val];
            const stop = bucketLen[val];
            for (; i < stop; i++) {
                const idx = arr[i];
                // Superseded by a cheaper path found after this was queued.
                if (entered[idx] !== val) continue;

                const y = (idx / w) | 0, x = idx - y * w;

                if (x > 0) {
                    const nIdx = idx - 1;
                    const nd = diff[nIdx];
                    const nv = nd > val ? nd : val;
                    if (nv < entered[nIdx]) { entered[nIdx] = nv; push(nIdx, nv); }
                }
                if (x < w - 1) {
                    const nIdx = idx + 1;
                    const nd = diff[nIdx];
                    const nv = nd > val ? nd : val;
                    if (nv < entered[nIdx]) { entered[nIdx] = nv; push(nIdx, nv); }
                }
                if (y > 0) {
                    const nIdx = idx - w;
                    const nd = diff[nIdx];
                    const nv = nd > val ? nd : val;
                    if (nv < entered[nIdx]) { entered[nIdx] = nv; push(nIdx, nv); }
                }
                if (y < h - 1) {
                    const nIdx = idx + w;
                    const nd = diff[nIdx];
                    const nv = nd > val ? nd : val;
                    if (nv < entered[nIdx]) { entered[nIdx] = nv; push(nIdx, nv); }
                }
            }
        }
        // Nothing revisits a drained bucket — release it.
        bucketData[val] = null;
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
