    // Minimal seeded LCG (linear congruential generator) used for repeatable brush jitter and noise patterns.
    // Not cryptographically secure — only used for visual randomness.
    class SeededRNG {
        constructor(seed) { this.seed = seed; }
        next() {
            let t = this.seed += 0x6D2B79F5;
            t = Math.imul(t ^ t >>> 15, t | 1);
            t ^= t + Math.imul(t ^ t >>> 7, t | 61);
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        }
    }