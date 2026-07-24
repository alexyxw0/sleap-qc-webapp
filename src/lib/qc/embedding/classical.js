// Classical pixel-feature "embedding" — a fast, transparent alternative to the DINO ViT backend.
//
// A DINO forward pass is ~4.5 GFLOPs on the CPU (~hundreds of ms/crop); these features are plain
// pixel math (sub-millisecond/crop, no model download, no GPU) yet feed the SAME kNN/robust-z/PCA
// outlier pipeline. The frames here are grayscale, so the vector is built from STRUCTURE, not color:
//   • tiny-image (16×16, per-crop illumination-normalized) — coarse silhouette / pose / layout
//   • HOG-lite (4×4 cells × 8 gradient orientations)       — local edges / contour / occluding clutter
//   • intensity histogram (16 bins)                        — dark occluder / blown-out / background
//   • intensity stats (mean, std, skew, dark%, bright%)    — gross exposure / occlusion signals
// Each block is L2-normalized so no block dominates the distance; the store L2-norms the whole vector.
// Catches the GROSS appearance errors this check is for (occlusion, obstruction, nodes on background);
// it is more literal than DINO (weaker on subtle semantics), but sees every frame in seconds.

const S = 64; // working crop resolution (the store draws the crop at MODEL.input)
const T = 16; // tiny-image side
const HB = 16; // intensity histogram bins
const C = 4; // HOG cells per side
const O = 8; // HOG orientation bins
const DIM = T * T + C * C * O + HB + 5; // 256 + 128 + 16 + 5 = 405

export const MODEL = {
  id: "classical-grayscale-v1",
  name: "Classical (pixel features)",
  dim: DIM,
  patch: null,
  input: S,
  backend: "CPU · pixels",
  batch: 16, // sub-ms/crop synchronous math — batches only bound work between UI yields
  note: "tiny-image + HOG + intensity histogram · no model download, sub-ms/crop",
};

export async function ensureModel() { return MODEL; } // nothing to load
export function isLoaded() { return true; }

// --- pure helpers (operate on a gray Float32Array, so they're testable without a DOM) ---

/** RGBA ImageData bytes → grayscale luma Float32Array(S·S). */
export function toGray(rgba, side) {
  const g = new Float32Array(side * side);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  return g;
}

function l2normInto(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (n > 1e-8) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** Box-downsample a `side`×`side` gray image to `t`×`t`. */
export function downsample(g, side, t) {
  const out = new Float32Array(t * t);
  const step = side / t;
  for (let ty = 0; ty < t; ty++) {
    for (let tx = 0; tx < t; tx++) {
      const x0 = Math.floor(tx * step), x1 = Math.max(x0 + 1, Math.floor((tx + 1) * step));
      const y0 = Math.floor(ty * step), y1 = Math.max(y0 + 1, Math.floor((ty + 1) * step));
      let sum = 0, cnt = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += g[y * side + x]; cnt++; }
      out[ty * t + tx] = cnt ? sum / cnt : 0;
    }
  }
  return out;
}

/** Tiny-image block: downsample, then per-crop normalize (subtract mean / divide std) so lighting
 *  drift doesn't dominate, then L2-normalize. Captures coarse silhouette / pose. */
export function tinyImage(g, side) {
  const t = downsample(g, side, T);
  let mean = 0;
  for (const v of t) mean += v;
  mean /= t.length;
  let varr = 0;
  for (const v of t) varr += (v - mean) * (v - mean);
  const std = Math.sqrt(varr / t.length) || 1;
  for (let i = 0; i < t.length; i++) t[i] = (t[i] - mean) / std;
  return l2normInto(t);
}

/** Normalized 16-bin intensity histogram (illumination distribution), L2-normalized. */
export function histogram(g) {
  const h = new Float32Array(HB);
  for (const v of g) h[Math.max(0, Math.min(HB - 1, Math.floor((v / 256) * HB)))]++;
  for (let i = 0; i < HB; i++) h[i] /= g.length; // to a distribution first (interpretable)
  return l2normInto(h);
}

/** HOG-lite: per-pixel Sobel gradient → per-cell histogram of UNSIGNED orientation (0..π), weighted
 *  by magnitude; each cell L2-normalized (contrast invariance). Captures local structure / edges. */
export function hog(g, side) {
  const feat = new Float32Array(C * C * O);
  const cellPx = side / C;
  for (let y = 1; y < side - 1; y++) {
    for (let x = 1; x < side - 1; x++) {
      const gx = g[y * side + x + 1] - g[y * side + x - 1];
      const gy = g[(y + 1) * side + x] - g[(y - 1) * side + x];
      const mag = Math.hypot(gx, gy);
      if (mag < 1e-6) continue;
      let ang = Math.atan2(gy, gx); // (-π, π]
      if (ang < 0) ang += Math.PI; // fold to unsigned [0, π)
      const ob = Math.min(O - 1, Math.floor((ang / Math.PI) * O));
      const cx = Math.min(C - 1, Math.floor(x / cellPx));
      const cy = Math.min(C - 1, Math.floor(y / cellPx));
      feat[(cy * C + cx) * O + ob] += mag;
    }
  }
  // per-cell L2 normalization
  for (let c = 0; c < C * C; c++) {
    let s = 0;
    for (let o = 0; o < O; o++) s += feat[c * O + o] * feat[c * O + o];
    const n = Math.sqrt(s);
    if (n > 1e-8) for (let o = 0; o < O; o++) feat[c * O + o] /= n;
  }
  return feat;
}

/** 5 gross intensity statistics (mean, std, skew, dark-fraction, bright-fraction), L2-normalized. */
export function stats(g) {
  const n = g.length;
  let mean = 0;
  for (const v of g) mean += v;
  mean /= n;
  let m2 = 0, m3 = 0, dark = 0, bright = 0;
  for (const v of g) { const d = v - mean; m2 += d * d; m3 += d * d * d; if (v < 40) dark++; if (v > 215) bright++; }
  const varr = m2 / n;
  const std = Math.sqrt(varr) || 1;
  const skew = m3 / n / (std * std * std);
  return l2normInto(new Float32Array([mean / 255, std / 128, skew, dark / n, bright / n]));
}

/** Full feature vector from a grayscale image (pure — the store's embed() wraps this over a canvas). */
export function featuresFromGray(g, side) {
  const out = new Float32Array(DIM);
  let off = 0;
  const put = (block) => { out.set(block, off); off += block.length; };
  put(tinyImage(g, side));
  put(hog(g, side));
  put(histogram(g));
  put(stats(g));
  return out;
}

/** Embed a batch of RGBA crops ({ data, width, height } — e.g. an ImageData) → one feature vector per
 *  crop (Float32Array, length DIM). Same signature as the DINO backend so the store treats them alike. */
export async function embedBatch(images) {
  return images.map((im) => featuresFromGray(toGray(im.data, im.width), im.width));
}
