// Fit an RBF-SVM in the browser, on the embeddings this app already computed and the labels the user
// already made. Emits exactly the `clf` shape parseClassifier produces, so rbfDecision / rbfProbability
// score a locally-trained model and an uploaded one identically — and a local model can be exported.
//
// Why this can exist at all: the crop-geometry mismatch that stops the SHIPPED per-keypoint models from
// scoring browser-computed patches does not apply here. Training and scoring use the same crops by
// construction, so consistency is automatic rather than something to match.
//
// Scale: one sample per instance per keypoint — a few hundred typically, a few thousand at most. SMO on
// 200x384 is milliseconds. The binding constraint is LABELS, never compute.

/** Column mean / std of the training rows. Baked into the model so scoring needs no separate scaler. */
function standardizer(rows, dim) {
  const mean = new Float32Array(dim);
  const scale = new Float32Array(dim);
  for (const r of rows) for (let d = 0; d < dim; d++) mean[d] += r[d];
  for (let d = 0; d < dim; d++) mean[d] /= rows.length || 1;
  for (const r of rows) for (let d = 0; d < dim; d++) { const v = r[d] - mean[d]; scale[d] += v * v; }
  // A zero-variance column would divide to Infinity; 1 leaves it as a constant offset instead.
  for (let d = 0; d < dim; d++) scale[d] = Math.sqrt(scale[d] / (rows.length || 1)) || 1;
  return { mean, scale };
}

const applyScaler = (rows, dim, mean, scale) =>
  rows.map((r) => {
    const z = new Float64Array(dim);
    for (let d = 0; d < dim; d++) z[d] = (r[d] - mean[d]) / scale[d];
    return z;
  });

function rbfGram(X, gamma) {
  const n = X.length, K = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let sq = 0;
      const a = X[i], b = X[j];
      for (let d = 0; d < a.length; d++) { const t = a[d] - b[d]; sq += t * t; }
      const v = Math.exp(-gamma * sq);
      K[i * n + j] = v; K[j * n + i] = v;
    }
  }
  return K;
}

/**
 * SMO for C-SVC (Platt 1998), simplified working-set selection. `y` is +1/-1.
 * Class-balanced: the positive class gets a larger C, which is what makes a ~5% fault rate learnable
 * at all — without it the trivial "everything is clean" solution wins.
 */
function smo(K, y, C, { tol = 1e-3, maxPasses = 12, maxIter = 6000 } = {}) {
  const n = y.length;
  const alpha = new Float64Array(n);
  let b = 0, passes = 0, iter = 0;
  const f = (i) => { let s = b; for (let j = 0; j < n; j++) if (alpha[j] !== 0) s += alpha[j] * y[j] * K[i * n + j]; return s; };
  while (passes < maxPasses && iter < maxIter) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      iter++;
      const Ci = C[i];
      const Ei = f(i) - y[i];
      if ((y[i] * Ei < -tol && alpha[i] < Ci) || (y[i] * Ei > tol && alpha[i] > 0)) {
        // Deterministic partner choice: no RNG, so a re-fit on the same labels gives the same model.
        let j = -1, best = -1;
        for (let k = 0; k < n; k++) {
          if (k === i) continue;
          const d = Math.abs((f(k) - y[k]) - Ei);
          if (d > best) { best = d; j = k; }
        }
        if (j < 0) continue;
        const Cj = C[j];
        const Ej = f(j) - y[j];
        const ai = alpha[i], aj = alpha[j];
        let L, H;
        if (y[i] !== y[j]) { L = Math.max(0, aj - ai); H = Math.min(Cj, Ci + aj - ai); }
        else { L = Math.max(0, ai + aj - Ci); H = Math.min(Cj, ai + aj); }
        if (L >= H) continue;
        const eta = 2 * K[i * n + j] - K[i * n + i] - K[j * n + j];
        if (eta >= 0) continue;
        let ajNew = aj - (y[j] * (Ei - Ej)) / eta;
        ajNew = Math.min(H, Math.max(L, ajNew));
        if (Math.abs(ajNew - aj) < 1e-7) continue;
        const aiNew = ai + y[i] * y[j] * (aj - ajNew);
        const b1 = b - Ei - y[i] * (aiNew - ai) * K[i * n + i] - y[j] * (ajNew - aj) * K[i * n + j];
        const b2 = b - Ej - y[i] * (aiNew - ai) * K[i * n + j] - y[j] * (ajNew - aj) * K[j * n + j];
        alpha[i] = aiNew; alpha[j] = ajNew;
        b = aiNew > 0 && aiNew < Ci ? b1 : ajNew > 0 && ajNew < Cj ? b2 : (b1 + b2) / 2;
        changed++;
      }
    }
    passes = changed === 0 ? passes + 1 : 0;
  }
  return { alpha, b };
}

/**
 * Platt scaling over decision values, by Newton's method.
 *
 * CONVENTION, and the reason this is worth a comment: Platt's paper fits p = sigmoid(-(A·f + B)) with A
 * negative, while svm.js scores p = sigmoid(A·f + B). Returning the paper's coefficients directly gives
 * probabilities that are exactly backwards — high decision, low probability — which looks like a working
 * model with inverted labels. Fit in the paper's form, return in the scorer's.
 */
export function plattCalibrate(dec, y) {
  const n = dec.length;
  const pos = y.reduce((s, v) => s + (v > 0 ? 1 : 0), 0);
  const neg = n - pos;
  if (!pos || !neg) return { A: -1, B: 0 };
  // Platt's smoothed targets keep A,B finite when the classes separate perfectly.
  const hi = (pos + 1) / (pos + 2), lo = 1 / (neg + 2);
  const t = y.map((v) => (v > 0 ? hi : lo));
  let A = 0, B = Math.log((neg + 1) / (pos + 1));
  for (let it = 0; it < 100; it++) {
    let g1 = 0, g2 = 0, h11 = 0, h22 = 0, h21 = 0;
    for (let i = 0; i < n; i++) {
      const fApB = dec[i] * A + B;
      const p = fApB >= 0 ? Math.exp(-fApB) / (1 + Math.exp(-fApB)) : 1 / (1 + Math.exp(fApB));
      const q = 1 - p;
      const d1 = t[i] - p, d2 = p * q;
      g1 += dec[i] * d1; g2 += d1;
      h11 += dec[i] * dec[i] * d2; h22 += d2; h21 += dec[i] * d2;
    }
    if (Math.abs(g1) < 1e-6 && Math.abs(g2) < 1e-6) break;
    const det = h11 * h22 - h21 * h21;
    if (Math.abs(det) < 1e-12) break;
    const dA = -(h22 * g1 - h21 * g2) / det;
    const dB = -(-h21 * g1 + h11 * g2) / det;
    A += dA; B += dB;
  }
  return { A: -A, B: -B }; // -> svm.js's sigmoid(A·f + B)
}

/** ROC-AUC by rank (ties averaged), and average precision. Both on the caller's held-out scores. */
export function rocAuc(scores, y) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  const ranks = new Float64Array(scores.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k]] = r;
    i = j + 1;
  }
  let pos = 0, sumR = 0;
  for (let i = 0; i < y.length; i++) if (y[i] > 0) { pos++; sumR += ranks[i]; }
  const neg = y.length - pos;
  if (!pos || !neg) return null;
  return (sumR - (pos * (pos + 1)) / 2) / (pos * neg);
}

export function averagePrecision(scores, y) {
  const order = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a]);
  let tp = 0, fp = 0, ap = 0;
  const P = y.reduce((s, v) => s + (v > 0 ? 1 : 0), 0);
  if (!P) return null;
  for (const i of order) {
    if (y[i] > 0) { tp++; ap += tp / (tp + fp); } else fp++;
  }
  return ap / P;
}

/** Deterministic stratified folds — no RNG, so the reported score is reproducible. */
export function stratifiedFolds(y, k) {
  const folds = Array.from({ length: k }, () => []);
  let p = 0, n = 0;
  for (let i = 0; i < y.length; i++) {
    if (y[i] > 0) folds[p++ % k].push(i);
    else folds[n++ % k].push(i);
  }
  return folds;
}

function fitRaw(rows, y, dim, { gamma, C }) {
  const { mean, scale } = standardizer(rows, dim);
  const X = applyScaler(rows, dim, mean, scale);
  const pos = y.reduce((s, v) => s + (v > 0 ? 1 : 0), 0);
  const neg = y.length - pos;
  // class_weight="balanced": C_i scaled by n / (2 * n_class) so the rare faults are not simply ignored.
  const wPos = neg && pos ? y.length / (2 * pos) : 1;
  const wNeg = neg && pos ? y.length / (2 * neg) : 1;
  const Ci = y.map((v) => C * (v > 0 ? wPos : wNeg));
  const K = rbfGram(X, gamma);
  const { alpha, b } = smo(K, y, Ci);
  const svIdx = [];
  for (let i = 0; i < alpha.length; i++) if (alpha[i] > 1e-8) svIdx.push(i);
  const nSv = svIdx.length;
  const dual = new Float32Array(nSv);
  const sv = new Float32Array(nSv * dim);
  svIdx.forEach((i, s) => { dual[s] = alpha[i] * y[i]; sv.set(X[i], s * dim); });
  return { dim, nSv, gamma, intercept: b, threshold: 0, plattA: null, plattB: null, mean, scale, dual, sv };
}

/** Decision values for already-scaled rows — used internally by CV without re-standardising. */
function decisionRaw(rows, clf) {
  const { dim, nSv, gamma, intercept, mean, scale, dual, sv } = clf;
  return rows.map((x) => {
    let f = intercept;
    const z = new Float64Array(dim);
    for (let d = 0; d < dim; d++) z[d] = (x[d] - mean[d]) / scale[d];
    for (let i = 0; i < nSv; i++) {
      const base = i * dim;
      let sq = 0;
      for (let d = 0; d < dim; d++) { const t = z[d] - sv[base + d]; sq += t * t; }
      f += dual[i] * Math.exp(-gamma * sq);
    }
    return f;
  });
}

export const MIN_POSITIVES = 8; // below this the CV number is noise, not a measurement

/**
 * Fit on EVERY labelled embedding — never a sample. A subsample would mean a model trained on part of
 * the ground truth the user paid for in review time, and would make the reported score depend on which
 * part was drawn.
 *
 * @param rows  array of length-dim Float32Array — one per LABELLED patch
 * @param y     +1 (faulty) / -1 (clean), index-aligned with rows
 * -> { clf, cv: { roc, pr, folds, nPos, nNeg }, warning }
 */
export function fitSvm(rows, y, { gamma = null, C = 2, folds = 5 } = {}) {
  if (!rows.length || rows.length !== y.length) throw new Error("rows and labels must be the same non-zero length");
  const dim = rows[0].length;
  const nPos = y.reduce((s, v) => s + (v > 0 ? 1 : 0), 0);
  const nNeg = y.length - nPos;
  if (!nPos || !nNeg) throw new Error("need both faulty and clean examples — one class cannot be learned");
  const g = gamma ?? 1 / dim; // sklearn's "scale" on standardised data reduces to ~1/dim

  // Honest CV: fold-out scoring only, and the standardiser is refit inside each fold so no test row
  // leaks into the scaler. Fewer positives than folds means k is capped, not silently wrong.
  const k = Math.max(2, Math.min(folds, nPos, nNeg));
  const parts = stratifiedFolds(y, k);
  const oof = new Float64Array(rows.length);
  for (let f = 0; f < k; f++) {
    const test = new Set(parts[f]);
    const trIdx = rows.map((_, i) => i).filter((i) => !test.has(i));
    const trY = trIdx.map((i) => y[i]);
    if (!trY.some((v) => v > 0) || !trY.some((v) => v < 0)) continue; // degenerate fold; leave at 0
    const sub = fitRaw(trIdx.map((i) => rows[i]), trY, dim, { gamma: g, C });
    const dec = decisionRaw(parts[f].map((i) => rows[i]), sub);
    parts[f].forEach((i, t) => { oof[i] = dec[t]; });
  }
  const roc = rocAuc(Array.from(oof), y);
  const pr = averagePrecision(Array.from(oof), y);

  // The shipped model is fit on everything; the score above is what the held-out folds said about it.
  const clf = fitRaw(rows, y, dim, { gamma: g, C });
  const { A, B } = plattCalibrate(decisionRaw(rows, clf), y);
  clf.plattA = A; clf.plattB = B;
  clf.threshold = 0;

  const warning = nPos < MIN_POSITIVES
    ? `Only ${nPos} faulty example${nPos === 1 ? "" : "s"}. Below ${MIN_POSITIVES} the cross-validated score is noise, not a measurement — treat this model as a hint and label more before trusting it.`
    : null;
  return { clf, cv: { roc, pr, folds: k, nPos, nNeg }, warning };
}
