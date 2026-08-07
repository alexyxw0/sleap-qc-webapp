// Few-shot domain adaptation for the transferred per-keypoint SVM. PURE + testable — no Svelte, no I/O.
//
// WHY NOT JUST RECALIBRATE: the obvious cheap move — refit Platt's sigmoid on the new labels — is a NO-OP
// for ranking. ROC/PR are rank-based and a sigmoid is monotone, so recalibration cannot change either by a
// single point; it only moves where the threshold sits. Any real gain must MOVE THE DECISION BOUNDARY.
//
// WHAT THIS DOES: a prototype (nearest-centroid) direction in embedding space —
//     w = unit( mean(labelled faulty) − mean(labelled clean) ),  score_i = ⟨unit(emb_i), w⟩
// then blends it with the transferred SVM by RANK (both mapped to [0,1] by rank, so the two scales are
// commensurate and the blend is scale-free):
//     final_i = (1−α)·rank(svm)_i + α·rank(proto)_i
//
// Prototype rather than a fitted classifier because the whole point is very few positives (5–40): a
// centroid direction has one degree of freedom per dimension and no optimizer to diverge, and it degrades
// gracefully at n=5 where logistic regression would overfit hard.
//
// Offline (dino_probe), retraining an RBF-SVM with target labels moved center→gily nose from PR 0.080
// zero-shot to 0.290 @10 labels / 0.435 @40. This linear approximation should recover PART of that —
// measure it, don't assume it.

/** Rank-normalize to [0,1]; ties get their average rank; non-finite → 0. */
export function rankNormalize(xs) {
  const n = xs.length;
  const out = new Float64Array(n);
  const idx = [...xs.keys()].filter((i) => Number.isFinite(xs[i]));
  idx.sort((a, b) => xs[a] - xs[b]);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && xs[idx[j + 1]] === xs[idx[i]]) j++;
    const r = idx.length > 1 ? (i + j) / 2 / (idx.length - 1) : 0.5;
    for (let k = i; k <= j; k++) out[idx[k]] = r;
    i = j + 1;
  }
  return out;
}

function unit(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const o = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = v[i] / s;
  return o;
}

/**
 * Prototype direction from labelled row indices.
 * `posIdx` / `negIdx` index into `embs`. If there are too few labelled negatives (<3) the GLOBAL mean is
 * used as the clean prototype instead — reviewed-clean instances all come from frames a human already
 * flagged, so they are a biased sample of "clean"; the global mean is the less biased fallback.
 * Returns null when there is nothing to learn from.
 */
export function prototypeDirection(embs, posIdx, negIdx, minNeg = 3) {
  if (!embs?.length || !posIdx?.length) return null;
  const dim = embs[0].length;
  const mu = (idx) => {
    const m = new Float64Array(dim);
    for (const i of idx) {
      const e = embs[i];
      for (let d = 0; d < dim; d++) m[d] += e[d];
    }
    for (let d = 0; d < dim; d++) m[d] /= idx.length;
    return m;
  };
  const muPos = mu(posIdx);
  const usedGlobal = !negIdx || negIdx.length < minNeg;
  const muNeg = usedGlobal ? mu([...embs.keys()]) : mu(negIdx);
  const w = new Float64Array(dim);
  for (let d = 0; d < dim; d++) w[d] = muPos[d] - muNeg[d];
  return { w: unit(w), nPos: posIdx.length, nNeg: usedGlobal ? 0 : negIdx.length, usedGlobal };
}

/** Project every embedding onto the prototype direction (cosine, since both sides are unit-normalized). */
export function prototypeScores(embs, w) {
  const out = new Float64Array(embs.length);
  for (let i = 0; i < embs.length; i++) {
    const e = unit(embs[i]);
    let s = 0;
    for (let d = 0; d < e.length; d++) s += e[d] * w[d];
    out[i] = s;
  }
  return out;
}

/**
 * Blend a base score with a few-shot score by rank. `alpha` 0 = pure base (unchanged), 1 = pure few-shot.
 * Returns values in [0,1]; monotone in each input, so the base ranking is recovered exactly at alpha=0.
 */
export function blendByRank(base, extra, alpha) {
  const a = Math.min(1, Math.max(0, alpha));
  if (a === 0) return Float64Array.from(base);
  const rb = rankNormalize(base), re = rankNormalize(extra);
  const out = new Float64Array(base.length);
  for (let i = 0; i < out.length; i++) out[i] = (1 - a) * rb[i] + a * re[i];
  return out;
}
