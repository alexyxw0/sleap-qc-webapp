// Port of sleap/qc/features/visibility.py — co-visibility model + isolated-invisible check.

/** Learns P(node_j visible | node_i visible) and scores unusual visibility patterns. */
export class VisibilityModel {
  constructor() {
    this.nNodes = 0;
    this.coVisibility = null; // nNodes x nNodes
    this.visibilityRates = null;
    this.nInstances = 0;
  }

  /** masks: boolean[N_instances][N_nodes]. */
  fit(masks) {
    this.nInstances = masks.length;
    this.nNodes = masks.length ? masks[0].length : 0;
    this.visibilityRates = Array.from({ length: this.nNodes }, (_, j) =>
      masks.length ? masks.reduce((s, m) => s + (m[j] ? 1 : 0), 0) / masks.length : 0,
    );
    this.coVisibility = Array.from({ length: this.nNodes }, () => new Array(this.nNodes).fill(0));
    for (let i = 0; i < this.nNodes; i++) {
      const withI = masks.filter((m) => m[i]);
      if (withI.length === 0) continue;
      for (let j = 0; j < this.nNodes; j++) {
        this.coVisibility[i][j] = withI.reduce((s, m) => s + (m[j] ? 1 : 0), 0) / withI.length;
      }
    }
    return this;
  }

  /** mask: boolean[N_nodes] -> { patternScore (0..1), nViolations }. */
  score(mask) {
    if (!this.coVisibility) throw new Error("Model not fitted. Call fit() first.");
    let nViolations = 0;
    for (let i = 0; i < this.nNodes; i++) {
      if (!mask[i]) continue;
      for (let j = 0; j < this.nNodes; j++) {
        if (i === j) continue;
        const p = this.coVisibility[i][j];
        if (!mask[j] && p > 0.9) nViolations++; // expected visible, but invisible
        else if (mask[j] && p < 0.1) nViolations++; // rarely co-visible, yet visible
      }
    }
    return { patternScore: Math.min(1, nViolations / Math.max(1, this.nNodes)), nViolations };
  }

  /**
   * The node whose visibility state most violates the co-visibility model — for naming *which*
   * node drives a `visibility_pattern_score` anomaly. A violation is a pair (visible anchor `i`,
   * surprising peer `j`): `j` is either expected-co-visible (`P(j|i)>0.9`) yet absent, or
   * rarely-co-visible (`P(j|i)<0.1`) yet present. Blame accrues to `j` (the surprising node);
   * returns the most-blamed node, or -1 if the pose has no violations. Mirrors `score()`'s
   * conditions exactly so the named node is the one actually inflating the feature.
   */
  worstNode(mask) {
    if (!this.coVisibility) throw new Error("Model not fitted. Call fit() first.");
    const blame = new Array(this.nNodes).fill(0);
    for (let i = 0; i < this.nNodes; i++) {
      if (!mask[i]) continue;
      for (let j = 0; j < this.nNodes; j++) {
        if (i === j) continue;
        const p = this.coVisibility[i][j];
        if (!mask[j] && p > 0.9) blame[j]++; // j expected visible, but absent
        else if (mask[j] && p < 0.1) blame[j]++; // j rarely co-visible, yet present
      }
    }
    let best = -1, bestC = 0;
    for (let j = 0; j < this.nNodes; j++) if (blame[j] > bestC) { bestC = blame[j]; best = j; }
    return best;
  }
}
