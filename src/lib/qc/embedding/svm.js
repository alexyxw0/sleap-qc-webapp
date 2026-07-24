// Portable RBF-SVM decision function — the appearance-fault classifier trained in the dino_probe and
// exported to appearance_clf.{bin,json} (see dino_probe/export_to_webapp.py). Pure math so it's testable
// and runs identically on the main thread or in classifyWorker.js.
//
// decision(x) = Σ_i dual_i · exp(-gamma · ‖ (x-mean)/scale − SV_i ‖²) + intercept
// The scaler (mean/scale) is baked in, so `embs` are the SAME L2-normalized DINO embeddings the store
// already produces. decision >= clf.threshold ⇒ faulty (positive class), matching the Python pipeline.

/** Parse the Float32 blob (mean | scale | dual_coef | support_vectors) + JSON header into a clf object. */
export function parseClassifier(header, buffer) {
  const dim = header.dim, nSv = header.n_sv;
  const f = new Float32Array(buffer);
  let o = 0;
  const mean = f.subarray(o, (o += dim));
  const scale = f.subarray(o, (o += dim));
  const dual = f.subarray(o, (o += nSv));
  const sv = f.subarray(o, (o += nSv * dim));
  // plattA/plattB present only for calibrated per-keypoint models (e.g. nose_clf.json); null otherwise.
  return { dim, nSv, gamma: header.gamma, intercept: header.intercept, threshold: header.threshold,
           plattA: header.platt_a ?? null, plattB: header.platt_b ?? null, mean, scale, dual, sv };
}

/** Per-row RBF-SVM decision values for `embs` (array of length-dim Float32Array). O(N·nSv·dim). */
export function rbfDecision(embs, clf) {
  const { dim, nSv, gamma, intercept, mean, scale, dual, sv } = clf;
  const out = new Float64Array(embs.length);
  const z = new Float64Array(dim);
  for (let n = 0; n < embs.length; n++) {
    const x = embs[n];
    for (let d = 0; d < dim; d++) z[d] = (x[d] - mean[d]) / scale[d];
    let f = intercept;
    for (let i = 0; i < nSv; i++) {
      const base = i * dim;
      let sq = 0;
      for (let d = 0; d < dim; d++) { const diff = z[d] - sv[base + d]; sq += diff * diff; }
      f += dual[i] * Math.exp(-gamma * sq);
    }
    out[n] = f;
  }
  return out;
}

/** Calibrated fault probability: sigmoid(plattA·decision + plattB). Falls back to raw decisions if the
 *  classifier has no Platt calibration (plattA/plattB null). */
export function rbfProbability(embs, clf) {
  const d = rbfDecision(embs, clf);
  const a = clf.plattA, b = clf.plattB;
  if (a == null || b == null) return d;
  const out = new Float64Array(d.length);
  for (let i = 0; i < d.length; i++) out[i] = 1 / (1 + Math.exp(-(a * d[i] + b)));
  return out;
}
