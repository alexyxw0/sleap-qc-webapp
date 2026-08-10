// DINOv2 PATCH tokens, compacted so a whole run's worth fits in memory.
//
// The appearance pipeline has only ever kept the CLS token: one 384-d vector summarising the crop.
// That is the right thing for "does this animal look wrong overall", and the wrong thing for "is one
// small region of this crop wrong" — CLS averages a local defect away. Patch-level methods
// (PatchCore, AnomalyDINO) score the tokens instead, which is what anomalyDino.js does.
//
// The obstacle is size. A 224² crop at patch 14 gives a 16×16 grid = 256 tokens × 384 dims = 393 KB
// per crop as f32; a full per-keypoint run is ~58,000 crops, i.e. 23 GB. Nobody is holding that, and
// the forward pass that produced it costs half an hour, so recomputing on demand is not an option
// either. So each crop's token grid is compacted, once, as it comes out of the model:
//
//   pool 16×16 -> `grid`×`grid`   spatial detail we cannot afford, traded away first: a keypoint
//                                 patch is small, and a fault moves a region, not a single token
//   L2-normalize                  tokens are compared by cosine; make the dot product BE the cosine
//   project 384 -> `dim`          a fixed seeded Gaussian random projection (Johnson-Lindenstrauss).
//                                 PatchCore does the same thing (sklearn SparseRandomProjection) for
//                                 the same reason. Seeded, so a descriptor built today matches one
//                                 read back from the cache next week.
//   quantize to int8              tokens are unit vectors, so every component is in [-1, 1] and a
//                                 1/127 step is far below the noise between two real patches
//
// 16 tokens × 64 dims × 1 byte = 1 KB per crop: 59 MB for that same 58,000-crop run, less than the
// thumbnails already cost, and small enough to sit in the embedding cache beside the CLS vector.

export const PATCH = {
  grid: 4, // pooled tokens per side (4 => 16 tokens/crop)
  dim: 64, // random-projection target
  seed: 0x5eed1e,
};

/** Tokens per crop for a config — the descriptor's length is `tokens * dim` bytes. */
export const tokenCount = (cfg = PATCH) => cfg.grid * cfg.grid;

// ── seeded Gaussian projection ────────────────────────────────────────────────────────────────────
// mulberry32: a small, fast, well-distributed PRNG. The point is only determinism — the same (D,P,seed)
// must give the same matrix in the worker, on the main thread, and in a session a week from now, or a
// cached descriptor stops being comparable to a fresh one.
function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _mats = new Map();
/** D×P Gaussian matrix, row-major (row d, column p), cached per (D, P, seed). */
export function projectionMatrix(D, P, seed = PATCH.seed) {
  const key = `${D}:${P}:${seed}`;
  let m = _mats.get(key);
  if (m) return m;
  const rnd = mulberry32(seed);
  m = new Float32Array(D * P);
  const s = 1 / Math.sqrt(P);
  for (let i = 0; i < m.length; i += 2) {
    // Box-Muller: two standard normals per pair of uniforms.
    const u = Math.max(1e-12, rnd()), v = rnd();
    const r = Math.sqrt(-2 * Math.log(u));
    m[i] = r * Math.cos(2 * Math.PI * v) * s;
    if (i + 1 < m.length) m[i + 1] = r * Math.sin(2 * Math.PI * v) * s;
  }
  _mats.set(key, m);
  return m;
}

/**
 * Compact one crop's patch grid.
 *
 * `tokens` is the model's patch output for a single crop, flat and row-major: T tokens of D dims,
 * CLS already dropped. T must be a square (a ViT's grid is square); anything else means the caller
 * handed us something other than a patch grid, and a silent guess there would poison every score
 * downstream — so it returns null and the caller treats the crop as having no patch features.
 */
export function packPatchTokens(tokens, T, D, cfg = PATCH) {
  const side = Math.round(Math.sqrt(T));
  if (side * side !== T || T < 1 || D < 1) return null;
  const g = Math.max(1, Math.min(side, cfg.grid | 0));
  const P = Math.max(1, cfg.dim | 0);
  const M = projectionMatrix(D, P, cfg.seed);
  const out = new Int8Array(g * g * P);

  const pooled = new Float32Array(D);
  const proj = new Float32Array(P);
  for (let gr = 0; gr < g; gr++) {
    // Proportional binning rather than a fixed block size, so a grid that does not divide the
    // model's (a different input size, a different patch size) still bins evenly instead of
    // dropping the remainder rows.
    const r0 = Math.floor((gr * side) / g), r1 = Math.max(r0 + 1, Math.floor(((gr + 1) * side) / g));
    for (let gc = 0; gc < g; gc++) {
      const c0 = Math.floor((gc * side) / g), c1 = Math.max(c0 + 1, Math.floor(((gc + 1) * side) / g));
      pooled.fill(0);
      let n = 0;
      for (let r = r0; r < r1; r++) {
        for (let c = c0; c < c1; c++) {
          const base = (r * side + c) * D;
          for (let d = 0; d < D; d++) pooled[d] += tokens[base + d];
          n++;
        }
      }
      let s = 0;
      for (let d = 0; d < D; d++) { pooled[d] /= n; s += pooled[d] * pooled[d]; }
      const inv = 1 / (Math.sqrt(s) || 1);
      for (let d = 0; d < D; d++) pooled[d] *= inv;

      proj.fill(0);
      for (let d = 0; d < D; d++) {
        const v = pooled[d];
        if (v === 0) continue;
        const row = d * P;
        for (let p = 0; p < P; p++) proj[p] += v * M[row + p];
      }
      let s2 = 0;
      for (let p = 0; p < P; p++) s2 += proj[p] * proj[p];
      const inv2 = 127 / (Math.sqrt(s2) || 1);
      const off = (gr * g + gc) * P;
      for (let p = 0; p < P; p++) {
        const q = Math.round(proj[p] * inv2);
        out[off + p] = q > 127 ? 127 : q < -127 ? -127 : q;
      }
    }
  }
  return out;
}

/**
 * Int8 descriptor -> unit-norm float tokens, flat [tokens × P].
 *
 * Re-normalizing after dequantization matters: rounding to int8 moves a unit vector off the sphere by
 * up to ~0.4%, and the scorer treats a dot product AS a cosine. Left un-normalized, a token's norm
 * would leak into its distance and every score would carry a small quantization bias.
 */
export function unpackPatchTokens(desc, P) {
  const T = desc.length / P;
  const out = new Float32Array(desc.length);
  for (let t = 0; t < T; t++) {
    const off = t * P;
    let s = 0;
    for (let p = 0; p < P; p++) { const v = desc[off + p]; s += v * v; }
    const inv = 1 / (Math.sqrt(s) || 1);
    for (let p = 0; p < P; p++) out[off + p] = desc[off + p] * inv;
  }
  return out;
}
