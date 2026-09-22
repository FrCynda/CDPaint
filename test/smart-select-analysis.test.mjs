/**
 * Smart Select Brush algorithm tests: OKLab round-trip, palette discovery,
 * and adaptive region growing on synthetic images built to exercise the
 * exact failure modes the tool is meant to survive — a thin band between
 * near-identical colors, a soft pseudo-gradient, and a hard outline next to
 * a similar-colored fill.
 *
 * Run: node test/smart-select-analysis.test.mjs
 */
import * as SA from '../src/js/smart-select-analysis.js';
import { buildEdgeMagnitude } from '../src/js/wand-algorithms.js';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; return; }
    failed++;
    console.error(`  FAIL: ${msg}`);
}

function makeImage(w, h, fillFn) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const [r, g, b] = fillFn(x, y);
            const i = (y * w + x) * 4;
            data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
        }
    }
    return data;
}

console.log('smart-select-analysis test suite\n');

// --- 1. OKLab round-trip ---
console.log('--- 1. rgbToOklab / oklabToRgb round-trip ---');
for (const [r, g, b] of [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255], [128, 64, 200], [30, 200, 190]]) {
    const lab = SA.rgbToOklab(r, g, b);
    const back = SA.oklabToRgb(lab.L, lab.a, lab.b);
    assert(Math.abs(back.r - r) <= 1 && Math.abs(back.g - g) <= 1 && Math.abs(back.b - b) <= 1,
        `round-trip (${r},${g},${b}) -> (${back.r},${back.g},${back.b})`);
}

// --- 2. k-means finds a well-separated two-color palette ---
console.log('--- 2. kmeansOklab separates two distinct flat colors ---');
{
    const w = 20, h = 20;
    const data = makeImage(w, h, (x) => x < 10 ? [230, 40, 40] : [40, 40, 230]);
    const { centroids, labels } = SA.kmeansOklab(data, w, h, 2, { sampleMax: 400, seed: 1 });
    assert(centroids.length === 2, 'produces 2 centroids');
    const leftLabel = labels[10 * w + 2], rightLabel = labels[10 * w + 17];
    assert(leftLabel !== rightLabel, 'the two flat-color halves get different labels');
    for (let y = 0; y < h; y++) {
        assert(labels[y * w + 2] === leftLabel, `left half consistent at row ${y}`);
        assert(labels[y * w + 17] === rightLabel, `right half consistent at row ${y}`);
    }
}

// --- 3. Thin band between two near-identical colors: seeded region growing
//    must follow the band without leaking into either neighbor. ---
console.log('--- 3. regionGrowAdaptive: thin band between near-identical neighbors ---');
{
    const w = 40, h = 40;
    // Two very close blues on either side, a distinctly different (but still
    // blue-family) 3px band down the middle — the exact shape of the "very
    // similar neighboring colors" failure mode described in the brief.
    const data = makeImage(w, h, (x) => {
        if (x >= 18 && x < 21) return [90, 90, 220]; // the band
        if (x < 18) return [70, 130, 200];
        return [75, 135, 205]; // near-identical to the left color
    });
    const seeds = new Set();
    for (let y = 5; y < 35; y++) seeds.add(y * w + 19); // brush down the band's centerline
    const mask = SA.regionGrowAdaptive(data, w, h, seeds, {
        stepTol: 10, driftCap: 60, colorScale: 160, maxReach: 100
    });
    let leaked = false, bandSelected = 0, bandTotal = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const inBand = x >= 18 && x < 21;
            if (inBand) { bandTotal++; if (mask[i]) bandSelected++; }
            else if (mask[i]) leaked = true;
        }
    }
    assert(!leaked, 'selection never leaks outside the 3px band into either neighbor');
    assert(bandSelected / bandTotal > 0.8, `selection covers most of the band (${bandSelected}/${bandTotal})`);
}

// --- 4. Soft pseudo-gradient still stops at the true edge, not partway
//    through the ramp, and produces a strictly binary mask. ---
console.log('--- 4. regionGrowAdaptive: binary output, no partial selection ---');
{
    const w = 30, h = 10;
    // A flat region 0..14 blending smoothly into a very different flat
    // region 15..29 over a 4px ramp (a pseudo-gradient), like an
    // anti-aliased or AI-blurred edge.
    const data = makeImage(w, h, (x) => {
        if (x < 13) return [220, 220, 220];
        if (x > 16) return [30, 30, 30];
        const t = (x - 13) / 4;
        const v = Math.round(220 * (1 - t) + 30 * t);
        return [v, v, v];
    });
    const seeds = new Set();
    for (let y = 0; y < h; y++) seeds.add(y * w + 3);
    const mask = SA.regionGrowAdaptive(data, w, h, seeds, {
        stepTol: 20, driftCap: 60, colorScale: 160, maxReach: 60
    });
    assert(mask instanceof Uint8Array, 'mask is a Uint8Array');
    let onlyBinary = true;
    for (let i = 0; i < mask.length; i++) if (mask[i] !== 0 && mask[i] !== 1) onlyBinary = false;
    assert(onlyBinary, 'every mask value is exactly 0 or 1 — no partial/soft selection');
    // Boundary should land inside the ramp (13..16), not deep into the dark side.
    let rightmostSelected = -1;
    for (let x = 0; x < w; x++) if (mask[0 * w + x]) rightmostSelected = x;
    assert(rightmostSelected >= 12 && rightmostSelected <= 18,
        `boundary lands within/near the ramp, not deep into the far region (got x=${rightmostSelected})`);
}

// --- 5. A real (color-jump) boundary stops growth even when colors are coincidentally close on both sides. ---
console.log('--- 5. regionGrowAdaptive: pairwise jump stops growth at a real outline ---');
{
    const w = 20, h = 20;
    const data = makeImage(w, h, (x) => {
        if (x === 10) return [10, 10, 10]; // a 1px dark outline
        return [200, 200, 200]; // same flat color on both sides
    });
    const seeds = new Set([10 * w + 3]);
    const mask = SA.regionGrowAdaptive(data, w, h, seeds, {
        stepTol: 30, driftCap: 90, colorScale: 160, maxReach: 60
    });
    let crossed = false;
    for (let y = 0; y < h; y++) if (mask[y * w + 15]) crossed = true;
    assert(!crossed, 'growth does not cross the dark outline even though both sides are the same color');
}

// --- 6. trimSeeds: one contaminating outlier seed pixel (the brush wobbled
//    onto an outline) shouldn't be allowed to shrink how far the selection
//    is allowed to drift from its TRUE start color. ---
console.log('--- 6. regionGrowAdaptive: trimSeeds discards an outlier seed pixel from the start-color estimate ---');
{
    const w = 20, h = 6;
    const A = [100, 100, 100];
    const OUTLIER = [250, 10, 10]; // one accidental outline/highlight pixel among the seeds
    const seedCoords = [];
    for (let x = 2; x <= 9; x++) seedCoords.push([x, 2]);
    const outlierCoord = [10, 2];
    seedCoords.push(outlierCoord);

    const oklabs = seedCoords.map(([x, y]) =>
        (x === outlierCoord[0] && y === outlierCoord[1]) ? SA.rgbToOklab(...OUTLIER) : SA.rgbToOklab(...A));
    let sumL = 0, sumA = 0, sumB = 0;
    for (const c of oklabs) { sumL += c.L; sumA += c.a; sumB += c.b; }
    const pollutedOklab = { L: sumL / oklabs.length, a: sumA / oklabs.length, b: sumB / oklabs.length };
    const cleanOklab = SA.rgbToOklab(...A);
    const colorScale = 160;
    const dPollutedToClean = Math.sqrt(SA.distOklab2(pollutedOklab, cleanOklab)) * colorScale;
    const driftCap = dPollutedToClean * 0.5; // strictly between 0 (trimmed) and dPollutedToClean (untrimmed)

    const data = makeImage(w, h, (x, y) => {
        for (const [sx, sy] of seedCoords) {
            if (x === sx && y === sy) return (sx === outlierCoord[0] && sy === outlierCoord[1]) ? OUTLIER : A;
        }
        return A; // everywhere else is the TRUE flat color
    });
    const seeds = new Set(seedCoords.map(([x, y]) => y * w + x));
    const opts = { stepTol: 40, driftCap, colorScale, maxReach: 30 };

    const maskUntrimmed = SA.regionGrowAdaptive(data, w, h, seeds, { ...opts, trimSeeds: false });
    const maskTrimmed = SA.regionGrowAdaptive(data, w, h, seeds, { ...opts, trimSeeds: true });
    const farIdx = 2 * w + 15; // plain-A pixel well past the seed cluster
    assert(maskUntrimmed[farIdx] === 0,
        'without trimSeeds, the outlier drags the drift-cap anchor away from the true color and truncates the selection');
    assert(maskTrimmed[farIdx] === 1,
        'with trimSeeds, the outlier is excluded from the anchor estimate and the true-colored region is reached');
}

// --- 7. aaTolerance widens acceptance specifically across a blended/AA
//    edge, but the "new island" cutoff still keeps it from crossing all the
//    way into a genuinely different region's flat core. ---
console.log('--- 7. regionGrowAdaptive: aaTolerance crosses further into a blend but stops before the far region\'s core ---');
{
    const w = 30, h = 5;
    const data = makeImage(w, h, (x) => {
        if (x < 10) return [220, 220, 220];
        if (x > 13) return [30, 30, 30];
        const t = (x - 10) / 4;
        const v = Math.round(220 * (1 - t) + 30 * t);
        return [v, v, v];
    });
    const edge = buildEdgeMagnitude(data, w, h);
    const { centroids, labels } = SA.kmeansOklab(data, w, h, 2, { sampleMax: 400, seed: 1 });
    const seeds = new Set();
    for (let y = 0; y < h; y++) seeds.add(y * w + 3);
    const baseOpts = { stepTol: 18, driftCap: 90, colorScale: 160, maxReach: 60 };

    const maskOff = SA.regionGrowAdaptive(data, w, h, seeds, baseOpts);
    const maskOn = SA.regionGrowAdaptive(data, w, h, seeds, {
        ...baseOpts, aaTolerance: 3, edgeMagnitude: edge, clusterLabels: labels, clusterCentroids: centroids
    });
    function rightmost(mask) {
        let r = -1;
        for (let x = 0; x < w; x++) if (mask[2 * w + x]) r = x;
        return r;
    }
    const rOff = rightmost(maskOff), rOn = rightmost(maskOn);
    assert(rOn > rOff, `aaTolerance extends the selection further across the blend (off=${rOff}, on=${rOn})`);
    assert(rOn < 14, `aaTolerance still stops before the far region's flat core begins (got x=${rOn})`);
}

// --- 8. smoothMaskContour: knocks out single-pixel staircase jaggies,
//    leaves the mask strictly binary, and radius 0 is a no-op. ---
console.log('--- 8. smoothMaskContour: removes single-pixel notches, stays binary, radius 0 is a no-op ---');
{
    const w = 12, h = 12;
    const mask = new Uint8Array(w * h);
    for (let y = 2; y < 10; y++) for (let x = 2; x < 10; x++) mask[y * w + x] = 1;
    mask[5 * w + 9] = 0; // a single-pixel notch cut into an otherwise straight edge

    const smoothed = SA.smoothMaskContour(mask, w, h, 2);
    let onlyBinary = true;
    for (let i = 0; i < smoothed.length; i++) if (smoothed[i] !== 0 && smoothed[i] !== 1) onlyBinary = false;
    assert(onlyBinary, 'smoothed mask stays strictly binary');
    assert(smoothed[5 * w + 9] === 1, 'a single-pixel notch is smoothed away by a radius-2 pass');

    const unchanged = SA.smoothMaskContour(mask, w, h, 0);
    let identical = true;
    for (let i = 0; i < mask.length; i++) if (unchanged[i] !== mask[i]) identical = false;
    assert(identical, 'radius 0 is a no-op');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
