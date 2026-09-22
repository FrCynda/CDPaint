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
function _priorityFloodCore(diff, w, h, seedIndices) {
    const n = w * h;
    const entered = new Uint8Array(n);
    entered.fill(255);

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

    // Multiple seeds start the same way a single seed does — each is its
    // own zero-length path, so its cost is just its own diff value. Later
    // buckets don't care how many sources are competing; the cheapest path
    // wins regardless of which seed it started from.
    for (const seedIdx of seedIndices) {
        const v = diff[seedIdx];
        entered[seedIdx] = v;
        push(seedIdx, v);
    }

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

export function buildPriorityFlood(diff, w, h, seedX, seedY) {
    return _priorityFloodCore(diff, w, h, [seedY * w + seedX]);
}

/**
 * Same bottleneck-path flood as buildPriorityFlood, but grown from many
 * seeds at once (e.g. every pixel a selection brush stroke passed over)
 * instead of a single click point. A pixel's cost is the cheapest of the
 * paths in from any seed, so seeds effectively merge into one region.
 * `seeds` is any iterable of pixel indices (y*w+x).
 */
export function buildPriorityFloodMultiSeed(diff, w, h, seeds) {
    return _priorityFloodCore(diff, w, h, seeds);
}

/**
 * Edge-strength map: for each pixel, the largest per-channel colour jump to
 * a neighbour 1 OR 2 pixels away in each direction. High values sit on real
 * boundaries (outlines, hard color changes); low values sit in flat fills
 * and smooth gradients (each step along a gradient is small even though its
 * far ends differ a lot). Feeding this into buildPriorityFloodMultiSeed as
 * the cost array is what makes the Smart Select Brush grow to fill a shape
 * and stop at its outline, instead of just matching colour: the flood is
 * cheap everywhere inside a region (however it's shaded) and expensive to
 * cross out of it.
 *
 * The 2-pixel-away comparison specifically targets anti-aliasing: a real
 * outline softened into a 1-2px ramp has each individual 1px step looking
 * small (a plain 1-neighbour gradient would read it as "smooth" and flood
 * straight through), but the 2-pixel-away comparison spans the whole ramp
 * in one step and sees the full jump.
 *
 * `data` is a flat RGBA Uint8ClampedArray (e.g. ImageData.data).
 */
export function buildEdgeMagnitude(data, w, h) {
    const n = w * h;
    const g = new Uint8Array(n);
    const chDiff = (a, b) => {
        const dr = Math.abs(data[a] - data[b]);
        const dg = Math.abs(data[a + 1] - data[b + 1]);
        const db = Math.abs(data[a + 2] - data[b + 2]);
        const da = Math.abs(data[a + 3] - data[b + 3]);
        let m = dr > dg ? dr : dg;
        m = db > m ? db : m;
        m = da > m ? da : m;
        return m;
    };
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            const i = row + x;
            const p = i * 4;
            let m = 0;
            if (x > 0) { const d = chDiff(p, p - 4); if (d > m) m = d; }
            if (x < w - 1) { const d = chDiff(p, p + 4); if (d > m) m = d; }
            if (y > 0) { const d = chDiff(p, p - w * 4); if (d > m) m = d; }
            if (y < h - 1) { const d = chDiff(p, p + w * 4); if (d > m) m = d; }
            if (x > 1) { const d = chDiff(p, p - 8); if (d > m) m = d; }
            if (x < w - 2) { const d = chDiff(p, p + 8); if (d > m) m = d; }
            if (y > 1) { const d = chDiff(p, p - w * 8); if (d > m) m = d; }
            if (y < h - 2) { const d = chDiff(p, p + w * 8); if (d > m) m = d; }
            g[i] = m;
        }
    }
    return g;
}

/**
 * Which pixels are within `maxReach` (4-connected steps) of any seed —
 * a plain unweighted multi-source BFS, expansion stopped past maxReach.
 *
 * This is the brush's actual contribution to "smart": it anchors how far
 * the flood above is allowed to grow to the shape of the stroke itself
 * (dilated outward by maxReach), not just a generic color/edge rule with
 * no sense of where the user actually painted. A long thin stroke gets a
 * long thin reachable zone; a blob gets a blob. Combined with the edge cost
 * (mask[i] = entered[i] <= tolerance && reach[i]), it's what keeps a stray
 * low-contrast corridor elsewhere on the canvas from ballooning the
 * selection far past what was ever painted over, while still allowing the
 * edge cost to do the precise boundary-following work close in.
 *
 * `seeds` is any iterable of pixel indices (y*w+x). Returns a Uint8Array
 * mask, 1 = reachable.
 */
export function buildSeedReachMask(w, h, seeds, maxReach) {
    const n = w * h;
    const dist = new Int32Array(n).fill(-1);
    const queue = new Int32Array(n);
    let qh = 0, qt = 0;
    for (const s of seeds) {
        if (s >= 0 && s < n && dist[s] === -1) { dist[s] = 0; queue[qt++] = s; }
    }
    while (qh < qt) {
        const idx = queue[qh++];
        const d = dist[idx];
        if (d >= maxReach) continue;
        const nd = d + 1;
        const x = idx % w, y = (idx / w) | 0;
        if (x > 0) { const ni = idx - 1; if (dist[ni] === -1) { dist[ni] = nd; queue[qt++] = ni; } }
        if (x < w - 1) { const ni = idx + 1; if (dist[ni] === -1) { dist[ni] = nd; queue[qt++] = ni; } }
        if (y > 0) { const ni = idx - w; if (dist[ni] === -1) { dist[ni] = nd; queue[qt++] = ni; } }
        if (y < h - 1) { const ni = idx + w; if (dist[ni] === -1) { dist[ni] = nd; queue[qt++] = ni; } }
    }
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (dist[i] !== -1) mask[i] = 1;
    return mask;
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
