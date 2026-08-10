// Outlier scoring + 2-D projection for image-crop embeddings (DINOv2 ViT-S). Pure + testable —
// the appearance an occluded/mis-placed instance shows lives far from the rest in embedding space,
// which geometry (coordinates only) cannot see.

/** L2-normalize a vector, so euclidean distance relates to cosine (dist² = 2 − 2·cos). */
export function l2norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** Mean distance from EVERY row to its k nearest neighbours WITHIN a reference subset — a density/
 *  isolation outlier score. Decoupling the reference (a subsample) from the scored set (all rows) is
 *  what lets us score every instance against a smaller, decorrelated "normal" population: it avoids
 *  near-duplicate video frames masking each other, and costs O(N·R·D) instead of O(N²·D). Rows must be
 *  L2-normalized. `refIndices` = indices into `embs` forming the reference; a row is never compared to
 *  itself even if it's in the reference. */
export function knnOutlierScoresRef(embs, refIndices, k = 6) {
  const N = embs.length;
  const scores = new Float64Array(N);
  const R = refIndices.length;
  if (N < 2 || R < 2) return scores;
  const D = embs[0].length;
  const kk = Math.min(k, R - 1); // -1: a scored row may itself be in the reference (skipped below)
  const best = new Float64Array(kk); // kk smallest dist², kept sorted ascending
  for (let i = 0; i < N; i++) {
    best.fill(Infinity);
    const a = embs[i];
    for (let ri = 0; ri < R; ri++) {
      const j = refIndices[ri];
      if (j === i) continue;
      const b = embs[j];
      let dot = 0;
      for (let d = 0; d < D; d++) dot += a[d] * b[d];
      const dist = 2 - 2 * dot;
      if (dist < best[kk - 1]) {
        let p = kk - 1;
        while (p > 0 && best[p - 1] > dist) { best[p] = best[p - 1]; p--; }
        best[p] = dist;
      }
    }
    let s = 0;
    for (let m = 0; m < kk; m++) s += Math.sqrt(Math.max(0, best[m]));
    scores[i] = s / kk;
  }
  return scores;
}

/** All-vs-all mean-kNN outlier score (the reference is every row). Thin wrapper over the ref version. */
export function knnOutlierScores(embs, k = 6) {
  return knnOutlierScoresRef(embs, embs.map((_, i) => i), k);
}

/** Choose a reference subsample STRATIFIED by group (video), so every group is represented — a global
 *  subsample can skip a small video entirely, and since videos differ visually, instances from an
 *  unrepresented video would have no same-domain neighbours and read as false outliers. Per group, take
 *  an evenly-spaced `max(minPer, round(frac·n))` (all of it if the group is smaller). `keys[i]` is row
 *  i's group id. Returns sorted row indices. */
export function stratifiedReference(keys, frac, minPer) {
  const groups = new Map();
  for (let i = 0; i < keys.length; i++) { const g = keys[i]; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(i); }
  const out = [];
  for (const idxs of groups.values()) {
    const n = idxs.length;
    const take = Math.min(n, Math.max(minPer, Math.round(frac * n)));
    if (take >= n) { for (const i of idxs) out.push(i); }
    else { const step = n / take; for (let t = 0; t < take; t++) out.push(idxs[Math.floor(t * step)]); }
  }
  return out.sort((a, b) => a - b);
}

/** Indices of the k nearest neighbours of row `i` (nearest first). */
export function nearestNeighbors(embs, i, k = 5) {
  const N = embs.length, D = embs[0].length, a = embs[i];
  const arr = [];
  for (let j = 0; j < N; j++) {
    if (j === i) continue;
    let dot = 0;
    const b = embs[j];
    for (let d = 0; d < D; d++) dot += a[d] * b[d];
    arr.push([j, 2 - 2 * dot]);
  }
  arr.sort((x, y) => x[1] - y[1]);
  return arr.slice(0, k).map((x) => x[0]);
}

/** Per-frame max embedding z, keyed "videoIdx:frameIdx" (matches qcStore's #fkey so the DINO check
 *  can join on it). `recs[r].fi` indexes into `frames`; `zArr[r]` is that record's z; `vidx` maps a
 *  video object to its index. Kept a pure function with EXPLICIT params so the z-scores can never be
 *  dropped by a scoping slip (the bug this replaced: `z` was block-scoped and undefined here). */
export function buildFrameZ(recs, zArr, frames, vidx) {
  return buildScoreMaps(recs, zArr, frames, vidx).frameZ;
}

/**
 * Both per-frame and per-INSTANCE worst-z lookups, in one pass over the records.
 *
 * The per-instance map exists because the QC store asks "which node of this instance is worst?" once
 * per instance per render, and answering it by scanning every record was O(#recs) — ~58,000 patches on
 * a full per-keypoint run, on the frame-navigation path. Keyed the same way as frameZ
 * ("videoIdx:frameIdx", plus ":instIdx") so the caller can use the frame key it already has instead of
 * an index it has to search `frames` for.
 *
 * The value is threshold-INDEPENDENT — the worst node is the worst node whatever the cutoff — so this
 * survives a threshold change and only needs rebuilding when the scores themselves do.
 */
export function buildScoreMaps(recs, zArr, frames, vidx) {
  const frameZ = new Map();
  const worstByInst = new Map();
  for (let r = 0; r < recs.length; r++) {
    const rec = recs[r];
    const f = frames[rec.fi];
    if (!f) continue;
    const fk = `${vidx.get(f.video) ?? 0}:${f.frameIdx}`;
    const z = zArr[r];
    if (z > (frameZ.get(fk) ?? -Infinity)) frameZ.set(fk, z);
    const ik = `${fk}:${rec.ii}`;
    const cur = worstByInst.get(ik);
    if (!cur || z > cur.z) worstByInst.set(ik, { node: rec.node, z });
  }
  return { frameZ, worstByInst };
}

/** Robust z-score (median / 1.4826·MAD) of an array — outlier cutoff without a Gaussian assumption. */
export function robustZ(scores) {
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const m = med(scores);
  const mad = med(scores.map((x) => Math.abs(x - m))) || 1e-9;
  const scale = 1.4826 * mad;
  return Array.from(scores, (x) => (x - m) / scale);
}

/** Top-2 principal components via implicit power iteration on XᵀX (no D×D matrix), returns per-row
 *  [x,y] coords for the 2-D embedding map. Deterministic init so results are stable. */
export function pca2(embs, iters = 40) {
  const N = embs.length;
  if (N < 2) return { coords: embs.map(() => [0, 0]) };
  const D = embs[0].length;
  const mean = new Float64Array(D);
  for (const v of embs) for (let d = 0; d < D; d++) mean[d] += v[d];
  for (let d = 0; d < D; d++) mean[d] /= N;
  const Xc = embs.map((v) => { const r = new Float64Array(D); for (let d = 0; d < D; d++) r[d] = v[d] - mean[d]; return r; });
  const Cv = (v) => {
    const Xv = new Float64Array(N);
    for (let i = 0; i < N; i++) { const r = Xc[i]; let s = 0; for (let d = 0; d < D; d++) s += r[d] * v[d]; Xv[i] = s; }
    const out = new Float64Array(D);
    for (let i = 0; i < N; i++) { const r = Xc[i], xi = Xv[i]; for (let d = 0; d < D; d++) out[d] += r[d] * xi; }
    for (let d = 0; d < D; d++) out[d] /= N;
    return out;
  };
  const norm = (v) => { let s = 0; for (const x of v) s += x * x; return Math.sqrt(s) || 1; };
  const power = (orth) => {
    let v = new Float64Array(D);
    for (let d = 0; d < D; d++) v[d] = Xc[0][d] + ((d % 7) - 3) * 1e-3 + 1e-6; // deterministic, non-degenerate
    for (let t = 0; t < iters; t++) {
      const w = Cv(v);
      if (orth) { let dot = 0; for (let d = 0; d < D; d++) dot += w[d] * orth[d]; for (let d = 0; d < D; d++) w[d] -= dot * orth[d]; }
      const n = norm(w);
      for (let d = 0; d < D; d++) w[d] /= n;
      v = w;
    }
    return v;
  };
  const p1 = power(null);
  const p2 = power(p1);
  const coords = Xc.map((r) => { let x = 0, y = 0; for (let d = 0; d < D; d++) { x += r[d] * p1[d]; y += r[d] * p2[d]; } return [x, y]; });
  return { coords };
}
