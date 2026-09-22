// @ts-check
/**
 * Pure (stateless) analysis for the Smart Select Brush: palette discovery
 * (k-means in OKLab space) and the per-pixel cost map a stroke floods over.
 *
 * Single source of truth — imported directly by
 * test/smart-select-analysis.test.mjs AND loaded in the browser via an
 * inline ES-module bootstrap in index.html that assigns it to
 * window.__smartSelectAnalysis. smart-select-brush.js must not keep its own
 * copies. Mirrors the pattern wand-algorithms.js already uses.
 *
 * No other tool depends on this module.
 */

export const _SMART_SELECT_ANALYSIS_READY = true;

function srgbToLinear(c) {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function linearToSrgb(v) {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
}

/** sRGB 0..255 -> OKLab. Same formulas quantize.js already uses for its palette worker. */
export function rgbToOklab(r, g, b) {
    const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
    let l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
    let m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
    let s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
    l = Math.cbrt(l); m = Math.cbrt(m); s = Math.cbrt(s);
    return {
        L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    };
}

/** OKLab -> sRGB 0..255, for painting cluster centroids into the debug view. */
export function oklabToRgb(L, a, b) {
    let l = L + 0.3963377774 * a + 0.2158037573 * b;
    let m = L - 0.1055613458 * a - 0.0638541728 * b;
    let s = L - 0.0894841775 * a - 1.2914855480 * b;
    l = l * l * l; m = m * m * m; s = s * s * s;
    return {
        r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
    };
}

export function distOklab2(c1, c2) {
    const dl = c1.L - c2.L, da = c1.a - c2.a, db = c1.b - c2.b;
    return dl * dl + da * da + db * db;
}

function makeRng(seed) {
    let rng = seed >>> 0;
    return () => { rng = (rng * 1664525 + 1013904223) >>> 0; return rng / 4294967296; };
}

function sampleOklab(data, w, h, sampleMax) {
    const n = w * h;
    const step = Math.max(1, Math.floor(n / sampleMax));
    const samples = [];
    for (let i = 0; i < n; i += step) {
        const p = i * 4;
        samples.push(rgbToOklab(data[p], data[p + 1], data[p + 2]));
    }
    return samples;
}

/**
 * k-means++ over a fixed sample set. Returns { centroids, inertia } — the
 * shared fitting step used both by kmeansOklab (final palette) and
 * chooseClusterCount (comparing candidate K values against the same samples).
 */
function fitCentroids(samples, K, seed, iterations) {
    K = Math.max(1, Math.min(K, samples.length));
    const rand = makeRng(seed);
    const centroids = [{ ...samples[Math.floor(rand() * samples.length)] }];
    for (let k = 1; k < K; k++) {
        const dists = new Float64Array(samples.length);
        let total = 0;
        for (let i = 0; i < samples.length; i++) {
            let minD = Infinity;
            for (let c = 0; c < centroids.length; c++) {
                const d = distOklab2(samples[i], centroids[c]);
                if (d < minD) minD = d;
            }
            dists[i] = minD; total += minD;
        }
        let threshold = rand() * total, chosen = samples.length - 1;
        for (let i = 0; i < samples.length; i++) {
            threshold -= dists[i];
            if (threshold <= 0) { chosen = i; break; }
        }
        centroids.push({ ...samples[chosen] });
    }
    let inertia = 0;
    for (let iter = 0; iter < iterations; iter++) {
        const sums = centroids.map(() => ({ L: 0, a: 0, b: 0, w: 0 }));
        let worstErr = -1, worstIdx = 0;
        inertia = 0;
        for (let i = 0; i < samples.length; i++) {
            let bestD = Infinity, idx = 0;
            for (let c = 0; c < centroids.length; c++) {
                const d = distOklab2(samples[i], centroids[c]);
                if (d < bestD) { bestD = d; idx = c; }
            }
            sums[idx].L += samples[i].L; sums[idx].a += samples[i].a; sums[idx].b += samples[i].b; sums[idx].w++;
            inertia += bestD;
            if (bestD > worstErr) { worstErr = bestD; worstIdx = i; }
        }
        for (let c = 0; c < centroids.length; c++) {
            if (sums[c].w > 0) {
                centroids[c].L = sums[c].L / sums[c].w;
                centroids[c].a = sums[c].a / sums[c].w;
                centroids[c].b = sums[c].b / sums[c].w;
            } else {
                centroids[c] = { ...samples[worstIdx] };
            }
        }
    }
    return { centroids, inertia };
}

/**
 * Auto-selects a cluster count: fits K = min..max (step 2) against one fixed
 * sample set and stops at the first elbow (marginal inertia drop below
 * `elbowThreshold`), the classic cheap heuristic for "how many flat colors
 * does this image actually have". Cheap because it reuses one sample set for
 * every candidate K rather than resampling.
 */
export function chooseClusterCount(data, w, h, opts = {}) {
    const min = opts.min || 4, max = opts.max || 16, step = opts.step || 2;
    const sampleMax = opts.sampleMax || 4000;
    const seed = opts.seed || 1337;
    const iterations = opts.iterations || 5;
    const elbowThreshold = opts.elbowThreshold != null ? opts.elbowThreshold : 0.12;
    const samples = sampleOklab(data, w, h, sampleMax);
    let prevInertia = null, chosen = min;
    for (let K = min; K <= max; K += step) {
        const { inertia } = fitCentroids(samples, K, seed, iterations);
        if (prevInertia != null) {
            const drop = prevInertia > 0 ? (prevInertia - inertia) / prevInertia : 0;
            if (drop < elbowThreshold) { chosen = K - step; break; }
        }
        chosen = K;
        prevInertia = inertia;
    }
    return Math.max(min, chosen);
}

/**
 * Full per-image analysis: discovers the flat-color palette (k-means in
 * OKLab space) and labels every pixel by nearest centroid. `margin` is the
 * gap (in OKLab distance) between the nearest and second-nearest centroid —
 * low margin means a pixel sits right on a cluster boundary, which is what
 * the debug view's "boundary evidence" mode shows.
 *
 * Fitting samples up to `sampleMax` pixels (cheap); labeling is the one
 * O(n*K) full-image pass, done once per image and cached by the caller.
 */
export function kmeansOklab(data, w, h, K, opts = {}) {
    const sampleMax = opts.sampleMax || 12000;
    const seed = opts.seed || 1337;
    const iterations = opts.iterations || 8;
    const samples = sampleOklab(data, w, h, sampleMax);
    const { centroids } = fitCentroids(samples, K, seed, iterations);

    const n = w * h;
    const labels = new Uint16Array(n);
    const margin = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const p = i * 4;
        const c = rgbToOklab(data[p], data[p + 1], data[p + 2]);
        let best = Infinity, second = Infinity, bestIdx = 0;
        for (let k = 0; k < centroids.length; k++) {
            const d = distOklab2(c, centroids[k]);
            if (d < best) { second = best; best = d; bestIdx = k; }
            else if (d < second) second = d;
        }
        labels[i] = bestIdx;
        margin[i] = Math.sqrt(second) - Math.sqrt(best);
    }
    return { centroids, labels, margin };
}

/**
 * Adaptive seeded region growing (Adams-Bischof style): grows from `seeds`
 * by comparing each candidate pixel to the RUNNING MEAN color of the region
 * accepted so far, not to a fixed target. That is what lets a region with
 * real internal drift (a highlight stroke that gradually fades, an AI
 * pseudo-gradient inside what should read as one flat area) keep absorbing
 * pixels as the mean tracks the drift, while a genuinely different
 * neighboring color — even one only slightly further away in an absolute
 * sense — still falls outside the accept radius.
 *
 * Two more constraints keep that adaptivity from running away or leaking:
 *   - `driftCap`: total OKLab distance from the ORIGINAL seed mean a pixel
 *     may have and still be accepted. Without this, a smooth gradient could
 *     be walked pixel-by-pixel all the way into an unrelated color.
 *   - a direct pairwise jump check: a candidate is also compared to the ONE
 *     specific already-accepted neighbor it's being grown from. This is what
 *     stops growth at a real hard edge. It deliberately does NOT use
 *     buildEdgeMagnitude (wand-algorithms.js): that function looks up to 2px
 *     ahead to catch softened/anti-aliased edges, which means a pixel merely
 *     *near* a hard edge reads as risky even when its own color is
 *     unambiguous — folding it in here eroded a selection by a pixel at
 *     every hard boundary it touched. An exact, lookahead-free adjacent-pair
 *     distance both stops at hard edges and, once it's re-evaluated against
 *     the drifting mean each step, degrades gracefully across a soft ramp.
 *
 * Frontier order approximates best-first (a 0..255 bucket queue keyed by
 * distance-to-mean at *push* time, Dial's-algorithm style like
 * buildPriorityFloodMultiSeed) so nearby/similar pixels are absorbed before
 * farther ones, but the accept test is re-evaluated at *pop* time against
 * whatever the mean has drifted to by then — that's what makes it adaptive
 * rather than a fixed-cost flood.
 *
 * Two opt-in refinements, both no-ops at their defaults so existing callers
 * and tests are unaffected:
 *
 *   - `trimSeeds`: an imprecise brush stroke can catch one or two pixels
 *     that don't belong (an outline, a highlight) among otherwise-uniform
 *     seed pixels. Those outliers skew the plain average used as the
 *     region's starting color. With `trimSeeds` on, the starting color is
 *     instead a median-anchored robust mean — seed pixels farther from the
 *     per-channel median than several times the median absolute deviation
 *     are excluded from the average (but still selected; a positive seed is
 *     always honored, only the color ESTIMATE ignores them).
 *
 *   - `aaTolerance` (>1) widens the accept tolerance specifically for
 *     pixels `edgeMagnitude` (buildEdgeMagnitude, optional) flags as near an
 *     edge — exactly the anti-aliased/blended fringe pixels a flat stepTol
 *     would otherwise reject before the ramp finishes resolving. Elevated
 *     edge readings only ever RAISE the ceiling here, never lower it below
 *     the base stepTol, so this cannot reproduce the erosion bug a hard
 *     edge-magnitude veto caused (see the pairwise-jump note above). Because
 *     "near an edge" doesn't mean "still blending" — an edge-adjacent pixel
 *     can just as well be a few pixels deep into a genuinely different
 *     region — the widened tolerance is withdrawn once a candidate reads as
 *     core color of a different cluster (`clusterLabels`/`clusterCentroids`,
 *     from kmeansOklab) rather than a blend of the seed's own cluster: that
 *     is the "new island" cutoff, and past it growth is judged by the plain
 *     stepTol like any other pixel.
 *
 * Returns a Uint8Array mask (1 = selected).
 */
export function regionGrowAdaptive(data, w, h, seedIndices, opts = {}) {
    const n = w * h;
    const stepTol = opts.stepTol != null ? opts.stepTol : 22;
    const driftCap = opts.driftCap != null ? opts.driftCap : 48;
    const colorScale = opts.colorScale || 170;
    const maxReach = opts.maxReach || Infinity;
    const trimSeeds = !!opts.trimSeeds;
    const aaTolerance = opts.aaTolerance || 1;
    const edgeMagnitude = opts.edgeMagnitude || null;
    const clusterLabels = opts.clusterLabels || null;
    const clusterCentroids = opts.clusterCentroids || null;

    const lab = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const p = i * 4;
        const c = rgbToOklab(data[p], data[p + 1], data[p + 2]);
        lab[i * 3] = c.L; lab[i * 3 + 1] = c.a; lab[i * 3 + 2] = c.b;
    }
    const labDist = (i, j) => {
        const dl = lab[i * 3] - lab[j * 3], da = lab[i * 3 + 1] - lab[j * 3 + 1], db = lab[i * 3 + 2] - lab[j * 3 + 2];
        return Math.sqrt(dl * dl + da * da + db * db) * colorScale;
    };

    const inMask = new Uint8Array(n);
    const reachDist = new Int32Array(n).fill(-1);
    const fromPixel = new Int32Array(n).fill(-1); // the accepted pixel each frontier entry grew from
    const seedArr = [];
    for (const s of seedIndices) {
        if (inMask[s]) continue;
        inMask[s] = 1; reachDist[s] = 0;
        seedArr.push(s);
    }
    if (!seedArr.length) return inMask;

    // Robust (median-anchored) seed color estimate, used only when trimSeeds
    // is on; identical to the plain average when there are no outliers, or
    // when trimSeeds is off (the common, unchanged path).
    let anchorL, anchorA, anchorB;
    if (trimSeeds && seedArr.length >= 4) {
        const sL = seedArr.map(s => lab[s * 3]).sort((a, b) => a - b);
        const sA = seedArr.map(s => lab[s * 3 + 1]).sort((a, b) => a - b);
        const sB = seedArr.map(s => lab[s * 3 + 2]).sort((a, b) => a - b);
        const mid = sL.length >> 1;
        const medL = sL[mid], medA = sA[mid], medB = sB[mid];
        const dists = seedArr.map(s => {
            const dl = lab[s * 3] - medL, da = lab[s * 3 + 1] - medA, db = lab[s * 3 + 2] - medB;
            return Math.sqrt(dl * dl + da * da + db * db);
        });
        const mad = [...dists].sort((a, b) => a - b)[dists.length >> 1] || 0;
        const cutoff = mad * 4;
        let sumL = 0, sumA = 0, sumB = 0, count = 0;
        seedArr.forEach((s, i) => {
            if (dists[i] <= cutoff) { sumL += lab[s * 3]; sumA += lab[s * 3 + 1]; sumB += lab[s * 3 + 2]; count++; }
        });
        anchorL = count ? sumL / count : medL;
        anchorA = count ? sumA / count : medA;
        anchorB = count ? sumB / count : medB;
    } else {
        let sumL = 0, sumA = 0, sumB = 0;
        for (const s of seedArr) { sumL += lab[s * 3]; sumA += lab[s * 3 + 1]; sumB += lab[s * 3 + 2]; }
        anchorL = sumL / seedArr.length; anchorA = sumA / seedArr.length; anchorB = sumB / seedArr.length;
    }
    const seed0L = anchorL, seed0A = anchorA, seed0B = anchorB;
    let sumL = anchorL * seedArr.length, sumA = anchorA * seedArr.length, sumB = anchorB * seedArr.length, count = seedArr.length;

    // Which cluster the seed's own (robust) color belongs to — the "new
    // island" check compares candidates against this, not against whichever
    // cluster the individual seed pixels happened to land in.
    let seedClusterIdx = -1;
    if (aaTolerance > 1 && clusterCentroids && clusterCentroids.length) {
        let best = Infinity;
        for (let k = 0; k < clusterCentroids.length; k++) {
            const d = distOklab2({ L: seed0L, a: seed0A, b: seed0B }, clusterCentroids[k]);
            if (d < best) { best = d; seedClusterIdx = k; }
        }
    }

    const buckets = Array.from({ length: 256 }, () => []);
    const pushNeighbors = (idx, dist) => {
        if (dist >= maxReach) return;
        const x = idx % w, y = (idx / w) | 0;
        const nbrs = [x > 0 ? idx - 1 : -1, x < w - 1 ? idx + 1 : -1, y > 0 ? idx - w : -1, y < h - 1 ? idx + w : -1];
        const meanL = sumL / count, meanA = sumA / count, meanB = sumB / count;
        for (const nb of nbrs) {
            if (nb < 0 || inMask[nb] || reachDist[nb] !== -1) continue;
            reachDist[nb] = dist + 1;
            fromPixel[nb] = idx;
            const dl = lab[nb * 3] - meanL, da = lab[nb * 3 + 1] - meanA, db = lab[nb * 3 + 2] - meanB;
            const pr = Math.min(255, Math.round(Math.sqrt(dl * dl + da * da + db * db) * colorScale));
            buckets[pr].push(nb);
        }
    };
    for (const s of seedArr) pushNeighbors(s, 0);

    for (let val = 0; val < 256; val++) {
        let i = 0;
        while (i < buckets[val].length) {
            const idx = buckets[val][i++];
            if (inMask[idx]) continue;
            const meanL = sumL / count, meanA = sumA / count, meanB = sumB / count;
            const dl = lab[idx * 3] - meanL, da = lab[idx * 3 + 1] - meanA, db = lab[idx * 3 + 2] - meanB;
            let cost = Math.sqrt(dl * dl + da * da + db * db) * colorScale;
            const step = labDist(idx, fromPixel[idx]);
            if (step > cost) cost = step;

            let effectiveTol = stepTol;
            if (aaTolerance > 1 && edgeMagnitude && edgeMagnitude[idx] > 0) {
                let allowAA = true;
                if (clusterLabels && seedClusterIdx >= 0) {
                    const cIdx = clusterLabels[idx];
                    if (cIdx !== seedClusterIdx) {
                        const own = { L: lab[idx * 3], a: lab[idx * 3 + 1], b: lab[idx * 3 + 2] };
                        const dOwn = distOklab2(own, clusterCentroids[cIdx]);
                        const dSeedCluster = distOklab2(own, clusterCentroids[seedClusterIdx]);
                        if (dOwn < dSeedCluster) allowAA = false; // core of a different, distinct region — not a blend
                    }
                }
                if (allowAA) effectiveTol = stepTol * aaTolerance;
            }
            if (cost > effectiveTol) continue;

            const sl = lab[idx * 3] - seed0L, sa = lab[idx * 3 + 1] - seed0A, sb = lab[idx * 3 + 2] - seed0B;
            const dSeed = Math.sqrt(sl * sl + sa * sa + sb * sb) * colorScale;
            if (dSeed > driftCap) continue;
            inMask[idx] = 1;
            sumL += lab[idx * 3]; sumA += lab[idx * 3 + 1]; sumB += lab[idx * 3 + 2]; count++;
            pushNeighbors(idx, reachDist[idx]);
        }
    }
    return inMask;
}

/**
 * Smooths a binary mask's contour by box-blurring it (two-pass, separable)
 * and re-thresholding at the midpoint — the output stays strictly binary,
 * as every mask this tool produces must. A small radius knocks down the
 * single-pixel staircase "teeth" a region-growing boundary leaves along a
 * diagonal edge without erasing genuine corners: a real spike or sharp
 * vertex is wider than the single-pixel noise the blur removes, so it
 * survives, just slightly rounded, while the jaggies flatten out. `radius`
 * of 0 is a no-op.
 */
export function smoothMaskContour(mask, w, h, radius) {
    const r = Math.max(0, Math.round(radius));
    if (!r) return mask;
    const n = w * h;
    const src = new Float32Array(n);
    for (let i = 0; i < n; i++) src[i] = mask[i] ? 255 : 0;
    const tmp = new Float32Array(n);
    const out = new Float32Array(n);
    const win = r * 2 + 1;

    for (let y = 0; y < h; y++) {
        const row = y * w;
        let sum = 0;
        for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
        for (let x = 0; x < w; x++) {
            tmp[row + x] = sum / win;
            const addX = Math.min(w - 1, x + r + 1), subX = Math.max(0, x - r);
            sum += src[row + addX] - src[row + subX];
        }
    }
    for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
        for (let y = 0; y < h; y++) {
            out[y * w + x] = sum / win;
            const addY = Math.min(h - 1, y + r + 1), subY = Math.max(0, y - r);
            sum += tmp[addY * w + x] - tmp[subY * w + x];
        }
    }
    const result = new Uint8Array(n);
    for (let i = 0; i < n; i++) result[i] = out[i] >= 128 ? 1 : 0;
    return result;
}
