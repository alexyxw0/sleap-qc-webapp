// Port of sleap/qc/gmm.py GMMDetector (the sklearn GaussianMixture path).
//
// Parity note: the EM *fit* cannot bit-match sklearn (different RNG / k-means init), but
// the *scoring* math is deterministic. `GaussianMixture.fromParams()` lets us load
// sklearn's fitted params and validate scoreSamples exactly; `fit()` is a faithful EM
// (StandardScaler + full-covariance EM + percentile normalization) for in-browser use.

const LOG_2PI = Math.log(2 * Math.PI);

// ---- tiny linear algebra (full DxD SPD matrices) ----
function cholesky(A, n) {
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 0) s = 1e-12; // guard non-PD (sklearn adds reg_covar before this)
        L[i][j] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  return L;
}
// Solve L y = b (lower-triangular forward substitution).
function forwardSolve(L, b, n) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  return y;
}
// Solve Lᵀ v = b (upper-triangular back substitution; (Lᵀ)_{ij} = L_{ji}).
function backSolveT(L, b, n) {
  const v = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= L[j][i] * v[j];
    v[i] = s / L[i][i];
  }
  return v;
}
const logsumexp = (arr) => {
  const m = Math.max(...arr);
  if (!Number.isFinite(m)) return m;
  return m + Math.log(arr.reduce((s, x) => s + Math.exp(x - m), 0));
};

// log N(x | mean, cov) with cov given by its Cholesky factor L and logDet = log|cov|.
function logGaussian(x, mean, L, logDet, n) {
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) d[i] = x[i] - mean[i];
  const z = forwardSolve(L, d, n); // z = L^{-1} d ; quad = ||z||^2 = d^T cov^{-1} d
  let quad = 0;
  for (let i = 0; i < n; i++) quad += z[i] * z[i];
  return -0.5 * (n * LOG_2PI + logDet + quad);
}

// ---- StandardScaler (ddof=0; zero-variance -> scale 1, like sklearn) ----
export function standardScalerFit(X) {
  const n = X.length;
  const d = X[0].length;
  const mean = new Float64Array(d);
  const scale = new Float64Array(d);
  for (let j = 0; j < d; j++) {
    let m = 0;
    for (let i = 0; i < n; i++) m += X[i][j];
    m /= n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (X[i][j] - m) * (X[i][j] - m);
    v /= n;
    mean[j] = m;
    scale[j] = Math.sqrt(v) || 1;
    if (scale[j] <= 1e-12) scale[j] = 1;
  }
  return { mean, scale };
}
export const scalerTransform = (X, { mean, scale }) =>
  X.map((row) => row.map((v, j) => (v - mean[j]) / scale[j]));
export const scalerTransformRow = (row, { mean, scale }) => row.map((v, j) => (v - mean[j]) / scale[j]);

// ---- Gaussian Mixture (full covariance) ----
export class GaussianMixture {
  constructor({ nComponents = 1, regCovar = 1e-6, maxIter = 100, tol = 1e-3, seed = 42 } = {}) {
    this.K = nComponents;
    this.regCovar = regCovar;
    this.maxIter = maxIter;
    this.tol = tol;
    this.seed = seed;
  }

  static fromParams({ weights, means, covariances }) {
    const gmm = new GaussianMixture({ nComponents: weights.length });
    gmm.weights = weights;
    gmm.means = means;
    gmm.covariances = covariances;
    gmm._prepare();
    return gmm;
  }

  _prepare() {
    const d = this.means[0].length;
    this.d = d;
    this._chol = this.covariances.map((cov) => cholesky(cov, d));
    this._logDet = this._chol.map((L) => 2 * L.reduce((s, _, i) => s + Math.log(L[i][i]), 0));
    this._logW = this.weights.map((w) => Math.log(w));
  }

  // log p(x) per sample (matches sklearn GaussianMixture.score_samples).
  scoreSamples(X) {
    return X.map((x) => {
      const comp = new Array(this.K);
      for (let k = 0; k < this.K; k++) comp[k] = this._logW[k] + logGaussian(x, this.means[k], this._chol[k], this._logDet[k], this.d);
      return logsumexp(comp);
    });
  }

  fit(X) {
    const n = X.length;
    const d = X[0].length;
    this.d = d;
    const rng = mulberry32(this.seed);

    // k-means++ init -> hard assignment -> initial params.
    const centers = kmeanspp(X, this.K, rng);
    const labels = X.map((x) => argminDist(x, centers));
    this.weights = new Array(this.K).fill(0);
    this.means = centers.map((c) => Float64Array.from(c));
    this.covariances = Array.from({ length: this.K }, () => identity(d, 1));
    this._mStep(X, oneHot(labels, this.K)); // sets weights/means/covs from the assignment

    let prev = -Infinity;
    for (let iter = 0; iter < this.maxIter; iter++) {
      this._prepare();
      // E-step
      const resp = new Array(n);
      let ll = 0;
      for (let i = 0; i < n; i++) {
        const comp = new Array(this.K);
        for (let k = 0; k < this.K; k++) comp[k] = this._logW[k] + logGaussian(X[i], this.means[k], this._chol[k], this._logDet[k], d);
        const norm = logsumexp(comp);
        ll += norm;
        resp[i] = comp.map((c) => Math.exp(c - norm));
      }
      ll /= n; // mean lower bound (sklearn convergence metric)
      this._mStep(X, resp);
      if (Math.abs(ll - prev) < this.tol) break;
      prev = ll;
    }
    this._prepare();
    return this;
  }

  _mStep(X, resp) {
    const n = X.length;
    const d = this.d;
    const Nk = new Array(this.K).fill(0);
    for (let i = 0; i < n; i++) for (let k = 0; k < this.K; k++) Nk[k] += resp[i][k];

    this.weights = Nk.map((nk) => nk / n);
    this.means = Array.from({ length: this.K }, () => new Float64Array(d));
    for (let k = 0; k < this.K; k++) {
      const m = this.means[k];
      for (let i = 0; i < n; i++) { const r = resp[i][k]; for (let j = 0; j < d; j++) m[j] += r * X[i][j]; }
      for (let j = 0; j < d; j++) m[j] /= Nk[k] || 1;
    }
    this.covariances = Array.from({ length: this.K }, () => identity(d, 0));
    for (let k = 0; k < this.K; k++) {
      const cov = this.covariances[k];
      const m = this.means[k];
      for (let i = 0; i < n; i++) {
        const r = resp[i][k];
        if (r === 0) continue;
        const diff = new Float64Array(d);
        for (let j = 0; j < d; j++) diff[j] = X[i][j] - m[j];
        for (let a = 0; a < d; a++) for (let b = 0; b < d; b++) cov[a][b] += r * diff[a] * diff[b];
      }
      for (let a = 0; a < d; a++) {
        for (let b = 0; b < d; b++) cov[a][b] /= Nk[k] || 1;
        cov[a][a] += this.regCovar; // sklearn reg_covar on the diagonal
      }
    }
  }
}

// ---- GMMDetector (mirrors gmm.py) ----
export class GMMDetector {
  constructor({ nComponents = 5, percentileThreshold = 5.0 } = {}) {
    this.nComponents = nComponents;
    this.percentileThreshold = percentileThreshold;
  }
  fit(matrix) {
    const valid = matrix.filter((r) => r.every((x) => !Number.isNaN(x)));
    if (valid.length < 2) throw new Error("Need at least 2 valid instances to fit GMM");
    const nComp = Math.max(1, Math.min(this.nComponents, Math.floor(valid.length / 10)));
    this.scaler = standardScalerFit(valid);
    const scaled = scalerTransform(valid, this.scaler);
    this.gmm = new GaussianMixture({ nComponents: nComp }).fit(scaled);
    this.trainLL = this.gmm.scoreSamples(scaled);
    return this;
  }
  // normalized anomaly score in [0,1]: 1 - percentile(ll) (higher = more anomalous).
  scoreOne(vector) {
    if (vector.some((x) => Number.isNaN(x))) return Number.NaN;
    const ll = this.logLikelihoodOne(vector);
    const below = this.trainLL.reduce((s, t) => s + (t < ll ? 1 : 0), 0);
    return 1 - below / this.trainLL.length;
  }
  // Raw log p(x) under the fitted mixture (higher = more probable / normal). Used for
  // leave-one-node-out attribution: the node whose removal most raises this is "the
  // node the GMM thinks is wrong".
  logLikelihoodOne(vector) {
    if (vector.some((x) => Number.isNaN(x))) return -Infinity;
    return this.gmm.scoreSamples([scalerTransformRow(vector, this.scaler)])[0];
  }
  /**
   * Which feature DIMENSION makes this vector improbable. Under the most-responsible mixture
   * component, the (squared) Mahalanobis distance decomposes exactly per feature:
   *   dᵀ Σ⁻¹ d = Σ_j d_j · (Σ⁻¹ d)_j     (d = scaled vector − component mean)
   * so the largest term is the dimension the GMM finds most off (it accounts for the learned
   * feature correlations, unlike a plain per-feature z). Returns `{ index, contributions,
   * component }` in feature order; `index = -1` if unfitted or the input has NaNs.
   */
  worstFeature(vector) {
    if (!this.gmm) return { index: -1, contributions: [], component: -1 };
    const xs = scalerTransformRow(vector, this.scaler);
    if (xs.some((v) => Number.isNaN(v))) return { index: -1, contributions: [], component: -1 };
    const g = this.gmm;
    const n = g.d;
    let kBest = 0, lpBest = -Infinity;
    for (let k = 0; k < g.K; k++) {
      const lp = g._logW[k] + logGaussian(xs, g.means[k], g._chol[k], g._logDet[k], n);
      if (lp > lpBest) { lpBest = lp; kBest = k; }
    }
    const mean = g.means[kBest], L = g._chol[kBest];
    const d = new Float64Array(n);
    for (let j = 0; j < n; j++) d[j] = xs[j] - mean[j];
    const u = forwardSolve(L, d, n);  // u = L⁻¹ d
    const prec = backSolveT(L, u, n); // Σ⁻¹ d = L⁻ᵀ u
    const contributions = new Array(n);
    let index = -1, best = -Infinity;
    for (let j = 0; j < n; j++) {
      const c = d[j] * prec[j];
      contributions[j] = c;
      if (c > best) { best = c; index = j; }
    }
    return { index, contributions, component: kBest };
  }
}

// ---- helpers ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sqDist = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) { const dd = a[i] - b[i]; s += dd * dd; } return s; };
const argminDist = (x, centers) => { let best = 0, bd = Infinity; for (let k = 0; k < centers.length; k++) { const d = sqDist(x, centers[k]); if (d < bd) { bd = d; best = k; } } return best; };
function kmeanspp(X, K, rng) {
  const centers = [Array.from(X[Math.floor(rng() * X.length)])];
  while (centers.length < K) {
    const d2 = X.map((x) => Math.min(...centers.map((c) => sqDist(x, c))));
    const total = d2.reduce((s, v) => s + v, 0) || 1;
    let r = rng() * total, idx = 0;
    for (; idx < X.length; idx++) { r -= d2[idx]; if (r <= 0) break; }
    centers.push(Array.from(X[Math.min(idx, X.length - 1)]));
  }
  return centers;
}
const oneHot = (labels, K) => labels.map((l) => { const r = new Array(K).fill(0); r[l] = 1; return r; });
const identity = (d, diag) => Array.from({ length: d }, (_, i) => { const row = new Float64Array(d); row[i] = diag; return row; });
