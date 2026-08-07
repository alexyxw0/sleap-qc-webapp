// Per-KEYPOINT appearance-outlier analysis. Where embeddingStore embeds one whole-instance crop, this
// embeds a small patch around EACH node and scores each keypoint type against ITS OWN kind (nose vs
// noses) — a far more sensitive, localized signal for a single mis-placed / occluded keypoint, plus
// per-node attribution. One pinned backend (dino), same as embeddingStore. It deliberately
// exposes the SAME frame-level QC interface (hasResults / resultRev / threshold / frameZByKey /
// flaggedFrameKeys / flaggedFrameCount) so qcStore folds it into the flagged union like any other
// appearance check. The per-node graphs (one PCA scatter per keypoint) live behind the node-indexed
// getters the panel reads.
import { store } from "./labelsStore.svelte.js";
import * as dinoBackend from "./qc/embedding/dinoRemote.js";
import { l2norm, stratifiedReference, buildFrameZ } from "./qc/embedding/outlier.js";
import { scoreEmbeddings } from "./qc/embedding/scoreRemote.js";
import { nodePatchPlan } from "./qc/embedding/nodePatch.js";
import { loadAll as loadCache, putMany as saveCache } from "./qc/embedding/embcache.js";

const BACKENDS = { dino: dinoBackend };

// A node patch is fully determined by (video, frame, node, box) — round the box to keep the key stable
// against sub-pixel jitter. `node:` distinguishes it from the instance-level cropKey (same cache store).
const patchKey = (vi, frameIdx, node, box) =>
  `node:${vi}:${frameIdx}:${node}:${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.side)}`;

function drawPatch(canvas, img, box) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const W = img.width, H = img.height;
  const x = Math.max(0, Math.min(W - 4, box.x));
  const y = Math.max(0, Math.min(H - 4, box.y));
  ctx.drawImage(img, x, y, Math.min(box.side, W - x), Math.min(box.side, H - y), 0, 0, canvas.width, canvas.height);
}

const evenSample = (arr, cap) => {
  if (arr.length <= cap) return arr;
  const step = arr.length / cap, out = [];
  for (let i = 0; i < cap; i++) out.push(arr[Math.floor(i * step)]);
  return out;
};

export class NodeEmbeddingStore {
  status = $state("idle"); // idle | loading-model | running | scoring | done | error | aborted
  message = $state("");
  progress = $state({ done: 0, total: 0, startedAt: 0 });
  modelInfo = $state(null);
  backend; // pinned at construction; "dino" is the only one built
  threshold = $state(3.5); // robust-z cutoff, shared across all node graphs
  sampleCap = $state(null); // max INSTANCES to embed (each expands to its visible-node patches); null/0 => all
  referenceFraction = $state(0.2); // per-node kNN "normal" reference fraction (stratified by video)
  patchFraction = 0.3; // node patch side as a fraction of the instance's bbox max-side
  k = 6;
  selectedNode = $state(null); // which keypoint's graph the panel is inspecting
  // WHICH keypoints to embed. null = every placed node (the default). An array of node indices = only
  // those. [] is INVALID, not "all" — a subset pass is instances x nodes, so silently widening an empty
  // selection to the whole skeleton is the most expensive possible misreading of a click.
  nodes = $state(null);
  static REF_MIN_PER_VIDEO = 20;
  static MIN_PER_NODE = 8; // a node group smaller than this can't yield a meaningful outlier reference
  rev = $state(0);
  resultRev = $state(0); // bumps only when scored frame-flags change — the cheap dep for the QC check

  // What the LAST RUN asked for, snapshotted where the plan is filtered. Coverage must be a property of
  // the results, never of the live `nodes` field: otherwise re-ticking a chip retroactively relabels
  // finished results, and a check that examined 2 keypoints starts claiming it examined 13.
  #ranNodes = null;
  #recs = []; // { fi, ii, node, thumb }
  #embs = []; // Float32Array (L2-normalized), index-aligned with #recs
  #z = []; // outlier robust-z, index-aligned with #recs (per-node within its group)
  #coords = []; // [x,y] PCA coords, index-aligned with #recs (per-node projection)
  #nodeIndex = new Map(); // node -> [record indices] for that node
  #nodeStats = []; // [{ node, count, scored, refCount }] sorted by node
  #frameZ = new Map(); // "videoIdx:frameIdx" -> max node-patch z over that frame
  #scored = false;
  #abort = false;
  #cache = new Map(); // patchKey -> { emb, thumb }
  #cacheLabels = null;
  #loadedFileId = null;
  #scoreSig = null;
  #scoreRes = null; // { z, coords, nodeIndex, nodeStats, frameZ } cached for an identical re-run

  /** One store per backend, so a second encoder could coexist here (like embeddingStores). */
  constructor(backend = "dino") { this.backend = BACKENDS[backend] ? backend : "dino"; }
  #be() { return BACKENDS[this.backend] ?? dinoBackend; }

  // Namespaced by backend AND the "node" mode so per-node patches never collide with the instance-level
  // crop cache (different (video,frame,bbox) semantics) in the shared IndexedDB store.
  #fileId() {
    const L = store.labels;
    const shapes = (L?.videos ?? []).map((v) => (Array.isArray(v?.shape) ? v.shape.join("x") : "?")).join(",");
    return `node|${this.backend}|${store.fileName || "?"}|${store.frames?.length ?? 0}|${shapes}`;
  }

  /** Node patches embedded in the current results — cheap (record count), NOT a re-scan of all frames.
   *  (A pre-run count would need an O(frames·nodes²) re-plan of every keypoint, which stalls large files.) */
  get embeddedCount() { this.rev; return this.#recs.length; }
  get instanceCount() {
    let n = 0;
    for (const f of store.frames ?? []) n += f.lf?.instances?.length ?? 0;
    return n;
  }

  /**
   * What the results actually cover. `requested` is the selection the run used (null = whole skeleton),
   * `covered` is the nodes that produced at least one patch — a requested keypoint placed in no instance
   * yields nothing, and that is a different fact from not asking for it.
   *
   * Every "is this check done" surface reads THIS, not hasResults, because a 2-of-13 pass and a 13-of-13
   * pass are the same boolean and very different claims.
   */
  get coverage() {
    this.resultRev;
    const covered = new Set();
    for (const r of this.#recs) covered.add(r.node);
    return { requested: this.#ranNodes ? [...this.#ranNodes] : null, covered, partial: this.#ranNodes != null };
  }
  /** Was this keypoint embedded in the run that produced the current results? */
  coveredNode(ni) { this.resultRev; return this.#nodeIndex.has(ni); }

  // ── frame-level QC interface (identical to embeddingStore, so qcStore treats it as an appearance check) ──
  /** Results for the CURRENTLY LOADED file — see embeddingStore.hasResults for why the identity check
   *  is load-bearing rather than defensive. */
  get hasResults() { this.resultRev; return this.#scored && this.#cacheLabels === store.labels; }
  frameZByKey(key) { this.resultRev; return this.#frameZ.get(key) ?? null; }
  get flaggedFrameCount() {
    this.resultRev;
    let n = 0;
    for (const z of this.#frameZ.values()) if (z >= this.threshold) n++;
    return n;
  }
  flaggedFrameKeys() {
    this.resultRev;
    const out = [];
    for (const [k, z] of this.#frameZ) if (z >= this.threshold) out.push(k);
    return out;
  }
  /** Total flagged patches across all nodes (panel summary). */
  get flaggedCount() {
    this.rev;
    let n = 0;
    for (const z of this.#z) if (z >= this.threshold) n++;
    return n;
  }

  // ── per-node getters the panel reads ──
  /** [{ node, count, scored, refCount }] sorted by node index — drives the node selector + summary. */
  get nodeStats() { this.rev; return this.#nodeStats; }
  /** Scatter points for one node's graph: { cx-less raw coords x,y, z, fi, ii, r }. */
  pointsForNode(ni) {
    this.rev;
    const idxs = this.#nodeIndex.get(ni) ?? [];
    return idxs.map((r) => ({ x: this.#coords[r]?.[0] ?? 0, y: this.#coords[r]?.[1] ?? 0, z: this.#z[r] ?? 0, fi: this.#recs[r].fi, ii: this.#recs[r].ii, r }));
  }
  /** z-values for one node (histogram). */
  zForNode(ni) {
    this.rev;
    return (this.#nodeIndex.get(ni) ?? []).map((r) => this.#z[r] ?? 0);
  }
  flaggedCountForNode(ni) {
    this.rev;
    let n = 0;
    for (const r of this.#nodeIndex.get(ni) ?? []) if ((this.#z[r] ?? 0) >= this.threshold) n++;
    return n;
  }
  /** This frame's patch records for one node (usually one per instance), with stats. */
  recordsForFrameNode(fi, ni) {
    this.rev;
    const out = [];
    for (const r of this.#nodeIndex.get(ni) ?? []) if (this.#recs[r].fi === fi) out.push(this.#withStats(r));
    return out;
  }
  /** Worst node patches (most-outlier first) for one node, for "walk outliers". */
  outlierRecordsForNode(ni) {
    this.rev;
    return (this.#nodeIndex.get(ni) ?? []).map((r) => this.#withStats(r)).sort((a, b) => b.z - a.z);
  }
  /** The most-outlier node of one instance among the keypoints THIS RUN EMBEDDED, or null. Under a
   *  subset that is not the worst node of the instance — see `coverage` before presenting it as one. */
  worstNodeFor(fi, ii) {
    this.rev;
    let best = null;
    for (let r = 0; r < this.#recs.length; r++) {
      const rec = this.#recs[r];
      if (rec.fi !== fi || rec.ii !== ii) continue;
      const z = this.#z[r] ?? 0;
      if (!best || z > best.z) best = { node: rec.node, z };
    }
    return best;
  }
  /** Nearest neighbours of record `r` WITHIN its own node group (what a normal <that node> looks like). */
  neighborsInNode(r, k = 5) {
    this.rev;
    const ni = this.#recs[r]?.node;
    const idxs = this.#nodeIndex.get(ni) ?? [];
    const a = this.#embs[r];
    if (!a) return [];
    const arr = [];
    for (const j of idxs) {
      if (j === r || !this.#embs[j]) continue;
      let dot = 0; const b = this.#embs[j];
      for (let d = 0; d < a.length; d++) dot += a[d] * b[d];
      arr.push([j, 2 - 2 * dot]);
    }
    arr.sort((x, y) => x[1] - y[1]);
    return arr.slice(0, k).map((x) => this.#withStats(x[0]));
  }
  #withStats(r) {
    const rec = this.#recs[r];
    return { r, fi: rec.fi, ii: rec.ii, node: rec.node, thumb: rec.thumb, z: this.#z[r] ?? 0, xy: this.#coords[r] ?? [0, 0] };
  }

  /** Throughput + ETA for the in-flight run, or null when there is not yet enough to say anything.
   *  Read off progress.done, so it re-derives on every batch — `performance.now()` alone is not reactive.
   *  `startedAt` is stamped AFTER the model is ready, so a one-time 90 MB download can't poison the rate. */
  get pace() {
    const { done, total, startedAt } = this.progress;
    if (!startedAt || !total || done <= 0) return null;
    const elapsed = (performance.now() - startedAt) / 1000;
    if (elapsed < 0.75) return null; // the first fraction of a second says nothing useful
    const rate = done / elapsed;
    return { rate, elapsed, etaSec: done < total ? (total - done) / rate : 0, frac: done / total };
  }

  abort() { this.#abort = true; }

  async run() {
    if (this.status === "running" || this.status === "loading-model" || this.status === "scoring") return;
    if (store.labels !== this.#cacheLabels) {
      // Node INDICES mean different keypoints under a different skeleton, so a selection cannot follow a
      // file across. But only clear it when we are actually LEAVING a file: #cacheLabels is null until
      // the first run, so clearing unconditionally threw away the selection the user had just made —
      // every first run silently embedded the whole skeleton.
      const hadFile = this.#cacheLabels !== null;
      this.#cache.clear(); this.#scoreSig = null; this.#scoreRes = null; this.#cacheLabels = store.labels;
      this.#loadedFileId = null;
      if (hadFile) { this.nodes = null; this.#ranNodes = null; }
    }
    this.#abort = false;
    this.#recs = []; this.#embs = []; this.#z = []; this.#coords = []; this.#nodeIndex = new Map(); this.#nodeStats = []; this.#frameZ = new Map(); this.#scored = false;
    this.rev++; this.resultRev++;
    const be = this.#be();
    this.status = "loading-model"; this.message = `Loading ${be.MODEL.name}…`;
    try {
      this.modelInfo = await be.ensureModel((p) => { if (p?.status) this.message = `Loading model · ${p.status}${p.progress ? ` ${Math.round(p.progress)}%` : ""}`; });
    } catch (e) { this.status = "error"; this.message = `Model load failed — ${e.message}.`; return; }

    const fileId = this.#fileId();
    if (this.#loadedFileId !== fileId) {
      this.message = "Loading cached embeddings…"; this.rev++;
      const persisted = await loadCache(fileId);
      for (const [k, v] of persisted) if (!this.#cache.has(k)) this.#cache.set(k, v);
      this.#loadedFileId = fileId;
    }

    const frames = store.frames ?? [];
    // Cap by INSTANCE (each instance expands to its visible-node patches), so coverage semantics match
    // the instance-level panel: "all" = every instance's every node.
    const insts = [];
    for (let fi = 0; fi < frames.length; fi++) {
      const n = frames[fi].lf?.instances?.length ?? 0;
      for (let ii = 0; ii < n; ii++) insts.push({ fi, ii });
    }
    const cap = this.sampleCap && this.sampleCap > 0 ? this.sampleCap : insts.length;
    const list = evenSample(insts, cap);
    if (!list.length) { this.status = "error"; this.message = "No instances to embed."; return; }

    // Resolve the keypoint selection ONCE, here, and snapshot it: the results must keep describing the
    // run that made them even if the user re-ticks chips afterwards.
    const sel = Array.isArray(this.nodes) ? [...new Set(this.nodes)].filter((n) => Number.isInteger(n) && n >= 0) : null;
    if (sel && !sel.length) {
      this.status = "error";
      this.message = "No keypoints selected — pick at least one to embed.";
      this.rev++; return;
    }
    const want = sel ? new Set(sel) : null;
    this.#ranNodes = sel;

    const byFrame = new Map();
    for (const it of list) { if (!byFrame.has(it.fi)) byFrame.set(it.fi, []); byFrame.get(it.fi).push(it.ii); }
    const vidx = new Map((store.labels?.videos ?? []).map((v, i) => [v, i]));

    // Plan every (instance, node) patch up front (pure point math) so fully-cached frames skip decode
    // and the next frame's decode overlaps this one's embedding — same strategy as embeddingStore.
    const jobs = [];
    for (const [fi, iis] of byFrame) {
      const item = frames[fi];
      const vi = vidx.get(item.video) ?? 0;
      const plan = [];
      for (const ii of iis) {
        const pts = item.lf?.instances?.[ii]?.points;
        for (const { node, box } of nodePatchPlan(pts, this.patchFraction)) {
          if (want && !want.has(node)) continue; // not in this pass's keypoint selection
          plan.push({ ii, node, box, key: `${this.backend}:${patchKey(vi, item.frameIdx, node, box)}` });
        }
      }
      if (plan.length) jobs.push({ fi, item, plan, needsImg: plan.some((p) => !this.#cache.has(p.key)) });
    }
    const total = jobs.reduce((s, j) => s + j.plan.length, 0);
    if (!total) {
      // Distinguish "your selection isn't in this file" from "this file has no usable poses" — the first
      // is a two-second fix, the second is not.
      this.status = "error";
      this.message = want
        ? "None of the selected keypoints are placed in any sampled instance — pick different keypoints."
        : "No placed keypoints to embed (instances need ≥2 nodes).";
      this.rev++; return;
    }

    this.status = "running";
    this.progress = { done: 0, total, startedAt: performance.now() };
    const crop = document.createElement("canvas");
    crop.width = crop.height = be.MODEL.input;
    const cropCtx = crop.getContext("2d", { willReadFrequently: true });
    const thumb = document.createElement("canvas");
    thumb.width = thumb.height = 56;
    const thumbCtx = thumb.getContext("2d");
    let hits = 0;
    const fresh = [];
    const usedKeys = [];
    let lastYield = performance.now();
    const setMsg = () => { this.message = `Embedding ${total} keypoint patches…${hits ? ` · ${hits} reused` : ""}`; };
    setMsg();

    const decode = (j) => (j < jobs.length && jobs[j].needsImg ? store.getFrameImage(jobs[j].item).catch(() => null) : null);
    const BATCH = Math.max(1, be.MODEL.batch || 1);
    let queue = []; // { r, key }
    const flush = async () => {
      if (!queue.length) return;
      const batch = queue; queue = [];
      const embs = await be.embedBatch(batch.map((b) => b.img));
      for (let i = 0; i < batch.length; i++) {
        const { r, key } = batch[i];
        const emb = l2norm(embs[i]);
        this.#embs[r] = emb;
        const hit = { emb, thumb: this.#recs[r].thumb };
        this.#cache.set(key, hit);
        fresh.push([key, hit]);
      }
      this.progress = { ...this.progress, done: this.progress.done + batch.length };
    };

    let imgP = decode(0);
    for (let j = 0; j < jobs.length && !this.#abort; j++) {
      const { fi, plan } = jobs[j];
      const img = await imgP;
      imgP = decode(j + 1);
      for (const { ii, node, box, key } of plan) {
        if (this.#cache.has(key)) {
          const hit = this.#cache.get(key);
          hits++;
          this.#recs.push({ fi, ii, node, thumb: hit.thumb }); this.#embs.push(hit.emb); usedKeys.push(key);
          this.progress = { ...this.progress, done: this.progress.done + 1 };
        } else if (img?.width) {
          drawPatch(crop, img, box);
          const id = cropCtx.getImageData(0, 0, crop.width, crop.height);
          thumbCtx.drawImage(crop, 0, 0, thumb.width, thumb.height);
          const r = this.#recs.length;
          this.#recs.push({ fi, ii, node, thumb: thumb.toDataURL("image/jpeg", 0.7) });
          this.#embs.push(null); usedKeys.push(key);
          queue.push({ r, key, img: { data: id.data, width: id.width, height: id.height } });
          if (queue.length >= BATCH) {
            try { await flush(); } catch (e) { this.status = "error"; this.message = `Embedding failed — ${e.message}`; return; }
          }
        } else {
          this.progress = { ...this.progress, done: this.progress.done + 1 };
        }
        const now = performance.now();
        if (now - lastYield > 40) { setMsg(); this.rev++; await new Promise((res) => requestAnimationFrame(res)); lastYield = now; }
      }
    }
    try { if (!this.#abort) await flush(); } catch (e) { this.status = "error"; this.message = `Embedding failed — ${e.message}`; return; }
    // Persist BEFORE the abort check: a partially-embedded set is exactly as reusable as a complete one
    // (each entry is keyed by file/video/frame/node/box), and throwing away twenty minutes of DINO
    // because someone pressed Stop is the most expensive bug in this file.
    if (fresh.length) saveCache(fileId, fresh);
    if (this.#abort) {
      for (let r = this.#recs.length - 1; r >= 0; r--) if (!this.#embs[r]) { this.#recs.splice(r, 1); this.#embs.splice(r, 1); usedKeys.splice(r, 1); }
      this.status = "aborted"; this.message = "Stopped."; this.rev++; return;
    }
    if (!this.#embs.length) { this.status = "error"; this.message = "No patches could be embedded (no frame images?)."; return; }

    // Scoring wrapped so a throw can NEVER wedge the panel in "scoring" (mirrors embeddingStore's guard).
    try {
      const sig = `${this.k}|${this.referenceFraction}|${this.patchFraction}|${usedKeys.join("|")}`;
      if (this.#scoreSig === sig && this.#scoreRes) {
        ({ z: this.#z, coords: this.#coords, nodeIndex: this.#nodeIndex, nodeStats: this.#nodeStats, frameZ: this.#frameZ } = this.#scoreRes);
      } else {
        this.status = "scoring"; this.rev++;
        await this.#scoreAllNodes(vidx);
        this.#scoreSig = sig;
        this.#scoreRes = { z: this.#z, coords: this.#coords, nodeIndex: this.#nodeIndex, nodeStats: this.#nodeStats, frameZ: this.#frameZ };
      }
      this.#scored = true;
      // Default the panel's viewed node to the SCORED node with the most patches (a useful graph); if
      // none scored (a tiny file), leave it null so the panel shows the hint, not a degenerate blob.
      const scoredNow = this.#nodeStats.some((s) => s.scored && s.node === this.selectedNode);
      if (this.selectedNode == null || !scoredNow) {
        const best = [...this.#nodeStats].filter((s) => s.scored).sort((a, b) => b.count - a.count)[0];
        this.selectedNode = best ? best.node : null;
      }
      this.status = "done"; this.message = ""; this.rev++; this.resultRev++;
    } catch (e) {
      this.status = "error"; this.message = `Scoring failed — ${e?.message ?? e}`; this.rev++; this.resultRev++;
    }
  }

  /** Score each node group independently: kNN outlier + robust-z + 2-D PCA over the SAME node's patches
   *  (a per-video-stratified reference within the node), so each keypoint type gets its own graph and its
   *  own "normal". Groups below MIN_PER_NODE are left unscored (z=0) — too few for a reference. */
  async #scoreAllNodes(vidx) {
    const byNode = new Map();
    for (let r = 0; r < this.#recs.length; r++) { const ni = this.#recs[r].node; if (!byNode.has(ni)) byNode.set(ni, []); byNode.get(ni).push(r); }
    const z = new Array(this.#recs.length).fill(0);
    const coords = new Array(this.#recs.length).fill(null);
    const nodeIndex = new Map();
    const nodeStats = [];
    const nodes = [...byNode.keys()].sort((a, b) => a - b);
    let done = 0;
    for (const ni of nodes) {
      const idxs = byNode.get(ni);
      nodeIndex.set(ni, idxs);
      done++;
      if (idxs.length < NodeEmbeddingStore.MIN_PER_NODE) {
        for (const r of idxs) coords[r] = [0, 0];
        nodeStats.push({ node: ni, count: idxs.length, scored: false, refCount: 0 });
        continue;
      }
      const embsN = idxs.map((r) => this.#embs[r]);
      const vkeys = idxs.map((r) => vidx.get(store.frames[this.#recs[r].fi]?.video) ?? 0);
      const refIdx = stratifiedReference(vkeys, this.referenceFraction, NodeEmbeddingStore.REF_MIN_PER_VIDEO);
      this.message = `Scoring keypoint ${done}/${nodes.length}…`; this.rev++;
      const res = await scoreEmbeddings(embsN, refIdx, this.k); // off-thread; falls back on the main thread
      for (let s = 0; s < idxs.length; s++) { const r = idxs[s]; z[r] = res.z[s]; coords[r] = res.coords[s]; }
      nodeStats.push({ node: ni, count: idxs.length, scored: true, refCount: refIdx.length });
    }
    this.#z = z; this.#coords = coords; this.#nodeIndex = nodeIndex; this.#nodeStats = nodeStats;
    this.#frameZ = buildFrameZ(this.#recs, z, store.frames, vidx);
  }
}

// One per-node store per backend, coexisting with the instance-level embeddingStores.
export const nodeEmbeddingStores = {
  dino: new NodeEmbeddingStore("dino"),
};
