/**
 * Legacy (reference) wand mask implementations, extracted verbatim from
 * PaintEngine for regression-testing algorithmic refactors. These are the
 * "golden" implementations that the new incremental/path-compressed
 * algorithms must match byte-for-byte at every tolerance value.
 */

/**
 * Full-scan global mask: O(w*h) per call, matching
 * PaintEngine.calculateWandMaskFast / _lightweightWandUpdate global branch.
 */
function legacyGlobalMask(diff, tolerance) {
    const n = diff.length;
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        if (diff[i] <= tolerance) mask[i] = 1;
    }
    return mask;
}

/**
 * Per-tick 4-connected stack flood, matching PaintEngine._lightweightWandUpdate
 * contiguous branch (without the RAF yield — the yield at 20k steps doesn't
 * affect the final mask, only latency).
 */
function legacyFloodFillMask(diff, w, h, seedX, seedY, tolerance) {
    const n = w * h;
    const mask = new Uint8Array(n);
    const stack = new Int32Array(n * 16);
    let sp = 0;
    const push = (x, y) => { stack[sp++] = x; stack[sp++] = y; };
    push(Math.floor(seedX), Math.floor(seedY));
    while (sp > 0) {
        const y = stack[--sp], x = stack[--sp];
        if (x < 0 || x >= w || y < 0 || y >= h) continue;
        const idx = y * w + x;
        if (mask[idx]) continue;
        if (diff[idx] > tolerance) continue;
        mask[idx] = 1;
        push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
    }
    return mask;
}

export { legacyGlobalMask, legacyFloodFillMask };
