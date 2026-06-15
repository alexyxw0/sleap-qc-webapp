// Port of sleap/qc/features/skeleton.py — skeleton topology analysis (which features
// apply, the spine/chains for curvature). networkx is replaced with plain BFS over the
// (typically tree-shaped) skeleton graph.

export class SkeletonAnalyzer {
  /**
   * @param nNodes number of nodes
   * @param edges index pairs [[src,dst], ...]
   * @param symmetryPairs [[leftIdx, rightIdx], ...]
   */
  constructor(nNodes, edges, symmetryPairs = []) {
    this.nNodes = nNodes;
    this.edges = edges;
    this.symmetryPairs = symmetryPairs;

    this._adj = Array.from({ length: nNodes }, () => new Set());
    for (const [s, d] of edges) { this._adj[s].add(d); this._adj[d].add(s); }
    this._adj = this._adj.map((s) => [...s]);

    this.endpoints = this._nodes().filter((n) => this._adj[n].length === 1);
    this.branchPoints = this._nodes().filter((n) => this._adj[n].length > 2);
    this.spine = this._longestPath();
    this.maxChainLength = this.spine.length;
    this.allChains = this._findAllChains(3);
  }

  _nodes() {
    return Array.from({ length: this.nNodes }, (_, i) => i);
  }

  _bfsDistances(start) {
    const dist = new Map([[start, 0]]);
    const q = [start];
    while (q.length) {
      const u = q.shift();
      for (const v of this._adj[u]) if (!dist.has(v)) { dist.set(v, dist.get(u) + 1); q.push(v); }
    }
    return dist;
  }

  _shortestPath(start, end) {
    const prev = new Map([[start, null]]);
    const q = [start];
    while (q.length) {
      const u = q.shift();
      if (u === end) break;
      for (const v of this._adj[u]) if (!prev.has(v)) { prev.set(v, u); q.push(v); }
    }
    if (!prev.has(end)) return [];
    const path = [];
    for (let n = end; n != null; n = prev.get(n)) path.push(n);
    return path.reverse();
  }

  _longestPath() {
    if (this.nNodes === 0) return [];
    const starts = this.endpoints.length ? this.endpoints : [0];
    let longest = [];
    for (const start of starts) {
      const dist = this._bfsDistances(start);
      let farthest = start, best = -1;
      for (const [node, d] of dist) if (d > best) { best = d; farthest = node; }
      const path = this._shortestPath(start, farthest);
      if (path.length > longest.length) longest = path;
    }
    return longest;
  }

  _findAllChains(minLength = 3) {
    const terminators = new Set([...this.endpoints, ...this.branchPoints]);
    const chains = [];
    const visited = new Set();
    const ekey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
    for (const start of terminators) {
      for (const neighbor of this._adj[start]) {
        if (visited.has(ekey(start, neighbor))) continue;
        const chain = [start, neighbor];
        visited.add(ekey(start, neighbor));
        let current = neighbor, prev = start;
        while (!terminators.has(current)) {
          const next = this._adj[current].filter((n) => n !== prev);
          if (!next.length) break;
          const nn = next[0];
          visited.add(ekey(current, nn));
          chain.push(nn);
          prev = current;
          current = nn;
        }
        if (chain.length >= minLength) chains.push(chain);
      }
    }
    return chains;
  }

  /** Chains usable for curvature (spine first, then others not contained in it). */
  getCurvatureChains(minLength = 3) {
    const chains = [];
    if (this.spine.length >= minLength) chains.push(this.spine);
    const spineSet = new Set(this.spine);
    for (const chain of this.allChains) {
      if (chain.every((n) => spineSet.has(n))) continue;
      if (chain.length >= minLength) chains.push(chain);
    }
    chains.sort((a, b) => b.length - a.length);
    return chains;
  }

  get hasSymmetry() {
    return this.symmetryPairs.length >= 1;
  }
}

/** Build a SkeletonAnalyzer from a sleap-io.js Skeleton. */
export function analyzerFromSkeleton(skeleton) {
  const names = skeleton.nodeNames ?? skeleton.nodes.map((n) => n.name);
  const idx = new Map(names.map((n, i) => [n, i]));
  const edges = (skeleton.edges ?? []).map((e) => [
    idx.get(e.source?.name ?? e.source),
    idx.get(e.destination?.name ?? e.destination),
  ]);
  // Sort each pair ascending for determinism. NOTE: the Python source uses
  // `list(sym.nodes)` over a *set*, so its intra-pair (left/right) order is arbitrary
  // and run-dependent — which makes `min_symmetry_consistency` non-reproducible there.
  // We pin a stable order here (see qc-checks-port.md, "symmetry parity").
  const symmetryPairs = (skeleton.symmetries ?? [])
    .map((s) => [...s.nodes].map((n) => idx.get(n.name)))
    .filter((p) => p.length === 2)
    .map((p) => [Math.min(p[0], p[1]), Math.max(p[0], p[1])]);
  return new SkeletonAnalyzer(names.length, edges, symmetryPairs);
}
