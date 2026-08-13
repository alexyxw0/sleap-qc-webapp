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
import { l2norm, stratifiedReference, buildScoreMaps, robustZ } from "./qc/embedding/outlier.js";
import { PATCH, tokenCount } from "./qc/embedding/patchTokens.js";
import { ANOMALY_DINO } from "./qc/embedding/anomalyDino.js";
import { scoreEmbeddings } from "./qc/embedding/scoreRemote.js";
import { nodePatchPlan } from "./qc/embedding/nodePatch.js";
import { rbfDecision } from "./qc/embedding/svm.js";
import { prototypeDirection, prototypeScores, blendByRank } from "./qc/embedding/fewshot.js";
import { fitSvm, MIN_POSITIVES } from "./qc/embedding/svmFit.js";
import { keypointLabels } from "./keypointLabels.svelte.js";
import { frameKey } from "./labelsStore.svelte.js";
import { loadAll as loadCache, putMany as saveCache, requestPersist } from "./qc/embedding/embcache.js";

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


export class NodeEmbeddingStore {
  status = $state("idle"); // idle | loading-model | running | scoring | done | error | aborted
  message = $state("");
  progress = $state({ done: 0, total: 0, startedAt: 0 });
  modelInfo = $state(null);
  backend; // pinned at construction; "dino" is the only one built
  threshold = $state(3.5); // robust-z cutoff, shared across all node graphs
  /**
   * Which UNSUPERVISED scorer runs. Both are label-free and both put z on the same robust-z scale;
   * they differ in what they look at.
   *   "knn"         CLS token vs the k most similar patches of this keypoint. Cheap, and the right
   *                 question when the whole patch is wrong (occluded, on the wrong animal).
   *   "anomalyDino" the patch's own DINOv2 patch tokens vs a memory bank of normal ones, scored by the
   *                 worst quarter of them. Sees a locally-wrong region that CLS averages away.
   * Changing it re-scores from the SAME embeddings — no re-inference — provided the run kept patch
   * features (see patchCoverage).
   */
  scorer = $state("knn");
  anomalyQ = ANOMALY_DINO.q;
  /** Re-embed crops whose cache entry predates patch features, instead of reusing them. Off by
   *  default: it turns a warm cache back into a full inference run, which is a choice the user makes
   *  once they have seen how many crops it would actually cost (patchCoverage tells them). */
  requirePatches = $state(false);
  // The kNN "normal" yardstick — NOT a coverage setting: every patch is scored either way. It is an
  // even, per-video subsample on purpose. At 100% a slow-moving animal's own neighbouring video frames
  // become its nearest neighbours, distance goes to ~0, and a fault that persists across a few frames
  // reads as perfectly normal. Fixed rather than exposed: it is a tuned constant, not a user choice.
  referenceFraction = $state(0.2);
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
  #trainedNodes = new Map(); // node -> locally-fitted clf, for the groups no longer scored by kNN
  #fewShot = new Map(); // node -> { alpha, nPos, nNeg, usedGlobal } when a prototype is blended in
  #fsBase = new Map();  // node -> the pre-blend z, so re-applying few-shot never compounds
  #recs = []; // { fi, ii, node, thumb }
  #embs = []; // Float32Array (L2-normalized), index-aligned with #recs
  // Compacted DINOv2 patch descriptors (int8), index-aligned with #recs — null for a record whose
  // crop came from a cache entry written before patch features existed. Built on every fresh embed
  // whatever the scorer is: the forward pass that produces them is the half-hour part, so taking
  // them costs a pooling pass now and asking for them later costs the whole run again.
  #pts = [];
  #z = []; // outlier robust-z, index-aligned with #recs (per-node within its group)
  #coords = []; // [x,y] PCA coords, index-aligned with #recs (per-node projection)
  #nodeIndex = new Map(); // node -> [record indices] for that node
  #nodeStats = []; // [{ node, count, scored, refCount }] sorted by node
  #frameZ = new Map(); // "videoIdx:frameIdx" -> max node-patch z over that frame
  // "videoIdx:frameIdx:instIdx" -> { node, z } for that instance's worst patch. Built in the same pass
  // as #frameZ because the alternative — scanning #recs per call — is O(58,000) on the render path.
  #worstByInst = new Map();
  #scored = false;
  #abort = false;
  #cache = new Map(); // patchKey -> { emb, thumb }
  cacheNote = $state(null); // set when persisting the embedding cache failed (e.g. quota)
  #cacheLabels = null;
  #loadedFileId = null;
  #scoreSig = null;
  #scoreRes = null; // { z, coords, nodeIndex, nodeStats, frameZ } cached for an identical re-run

  /** Is this crop's cached work enough for the run we are about to do? A cache entry written before
   *  patch features existed has a CLS vector and no patch tokens: everything kNN needs, nothing
   *  AnomalyDINO needs. */
  #reusable(key) {
    const hit = this.#cache.get(key);
    if (!hit) return false;
    return !(this.requirePatches && !hit.pt);
  }

  /** Write-behind for the embedding cache. Fire-and-forget on purpose — the run is done and the
   *  user should not wait on a 200 MB write — but a FAILED write is reported, because a quota wall
   *  used to be indistinguishable from success and showed up later as "the cache disappeared". */
  #persist(fileId, fresh) {
    saveCache(fileId, fresh).then((r) => {
      if (r?.error) {
        this.cacheNote = `Could not cache ${(r.failed ?? 0).toLocaleString()} of ${fresh.length.toLocaleString()} patches (${r.error}) — they will be re-embedded next run.`;
        this.rev++;
      } else if (r?.wrote) {
        this.cacheNote = null;
      }
    });
  }

  /** One store per backend, so a second encoder could coexist here (like embeddingStores). */
  constructor(backend = "dino") { this.backend = BACKENDS[backend] ? backend : "dino"; }
  #be() { return BACKENDS[this.backend] ?? dinoBackend; }

  // Namespaced by backend AND the "node" mode so per-node patches never collide with the instance-level
  // crop cache (different (video,frame,bbox) semantics) in the shared IndexedDB store.
  /** The IndexedDB partition for this file. Exposed so a caller can PROBE the cache without
   *  re-deriving the key — a probe against a slightly different key silently reports zero. */
  get cacheId() { return this.#fileId(); }
  #fileId() {
    const L = store.labels;
    const shapes = (L?.videos ?? []).map((v) => (Array.isArray(v?.shape) ? v.shape.join("x") : "?")).join(",");
    return `node|${this.backend}|${store.fileName || "?"}|${store.frames?.length ?? 0}|${shapes}`;
  }

  /** Node patches embedded in the current results — cheap (record count), NOT a re-scan of all frames.
   *  (A pre-run count would need an O(frames·nodes²) re-plan of every keypoint, which stalls large files.) */
  get embeddedCount() { this.rev; return this.#recs.length; }
  /** Embedding width — what an uploaded model has to match before it may score these patches. */
  get dim() { this.rev; return this.#embs[0]?.length ?? null; }
  /** How many patches of ONE keypoint were embedded, for the per-keypoint scoring copy. */
  patchCount(ni) { this.resultRev; return (this.#nodeIndex.get(ni) ?? []).length; }
  get instanceCount() {
    let n = 0;
    for (const f of store.frames ?? []) n += f.lf?.instances?.length ?? 0;
    return n;
  }

  /** The settings this run actually used, so a later ✓ can say whether it still describes them. Compares
   *  the EFFECTIVE cap — cap=5000 on a 1,500-instance file is the same pass as no cap at all, and a raw
   *  comparison would report "settings changed" when nothing did. */
  #configSig() {
    const sel = Array.isArray(this.nodes) ? [...this.nodes].sort((a, b) => a - b).join(",") : "all";
    return `${this.instanceCount}|${this.referenceFraction}|${this.patchFraction}|${sel}|${this.requirePatches ? "pt" : ""}`;
  }
  #ranSig = null;
  /** Settings have moved since the run that produced these results. */
  get configDirty() { this.rev; return this.#ranSig != null && this.#ranSig !== this.#configSig(); }

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
  /**
   * Every embedded patch of one keypoint that the user has JUDGED, as training rows.
   *
   * Uses every labelled patch — never a sample. A subsample would train on part of the ground truth the
   * user paid for in review time, and would make the reported score depend on which part was drawn.
   * Unreviewed patches are excluded outright: "not looked at" is not a clean label, and folding it in as
   * one would teach the model that whatever nobody checked is correct.
   */
  trainingSetFor(ni) {
    this.resultRev;
    const names = store.skeleton?.nodeNames ?? [];
    const nm = names[ni];
    const rows = [], y = [];
    if (!nm) return { rows, y };
    const frames = store.frames ?? [];
    for (let r = 0; r < this.#recs.length; r++) {
      const rec = this.#recs[r];
      if (rec.node !== ni || !this.#embs[r]) continue;
      const f = frames[rec.fi];
      if (!f) continue;
      // Join on the STAMPED key, the same one the labels were written under. Re-deriving it here is
      // what let the two sides disagree and report an empty training set.
      const fk = frameKey(f);
      if (!keypointLabels.isReviewedAt(fk, rec.ii)) continue;
      rows.push(this.#embs[r]);
      y.push(keypointLabels.isBadAt(fk, rec.ii, nm) ? 1 : -1);
    }
    return { rows, y };
  }

  /** How many judged patches this keypoint has, and whether that is enough to fit anything meaningful. */
  trainableFor(ni) {
    const { y } = this.trainingSetFor(ni);
    const pos = y.reduce((s, v) => s + (v > 0 ? 1 : 0), 0);
    return { n: y.length, pos, neg: y.length - pos, enough: pos > 0 && y.length - pos > 0, floor: MIN_POSITIVES };
  }

  /** Fit an RBF-SVM for one keypoint on its judged patches. -> { clf, cv, warning } or throws. */
  trainFor(ni) {
    const { rows, y } = this.trainingSetFor(ni);
    return fitSvm(rows, y);
  }

  /**
   * Re-score ONE keypoint's patches with a trained model, replacing that group's unsupervised z.
   *
   * The decisions are converted to the SAME robust-z scale the kNN path produces, rather than left as
   * probabilities: every consumer downstream — the threshold slider, frameZByKey, the QC union, the
   * per-node counts — is written against that scale, and a group that suddenly reported 0..1 would be
   * silently compared to a cutoff of 3.5 and never flag. Higher decision still means more faulty, so the
   * ordering the model learned is preserved exactly; only the units change.
   */
  applyTrainedModel(ni, clf) {
    const idxs = this.#nodeIndex.get(ni) ?? [];
    if (!idxs.length) return;
    const dec = rbfDecision(idxs.map((r) => this.#embs[r]), clf);
    const z = robustZ(Array.from(dec));
    idxs.forEach((r, k) => { this.#z[r] = z[k]; });
    this.#trainedNodes.set(ni, clf);
    // The trained decisions ARE the new baseline; a few-shot blend over the kNN scores no longer
    // describes anything, and its saved base belongs to a scoring pass that is gone.
    this.#fewShot.delete(ni); this.#fsBase.delete(ni);
    // frameZ is the max over a frame's patches, so it has to be rebuilt from every group, not this one.
    const vidx = new Map((store.labels?.videos ?? []).map((v, i) => [v, i]));
    ({ frameZ: this.#frameZ, worstByInst: this.#worstByInst } = buildScoreMaps(this.#recs, this.#z, store.frames, vidx));
    // The memo describes the unsupervised pass; a trained group is no longer it.
    this.#scoreSig = null; this.#scoreRes = null;
    this.rev++; this.resultRev++;
  }
  /**
   * Drop a keypoint's trained model and put it back on the unsupervised baseline.
   *
   * Fitting was a one-way door: #trainedNodes was only ever written by applyTrainedModel or cleared
   * wholesale by a re-run, so a model you decided was worse than kNN could only be undone by
   * re-embedding the whole file. The two layers are supposed to compose, and composing means being
   * able to take one off.
   *
   * The group is RE-SCORED, not just unmarked — leaving the SVM's z values in place under a "kNN"
   * label would report one thing and show another. Any few-shot blend goes too: it was computed over
   * the scores that are being replaced.
   */
  async clearTrainedModel(ni) {
    if (!this.#trainedNodes.has(ni)) return false;
    this.#trainedNodes.delete(ni);
    this.#fewShot.delete(ni); this.#fsBase.delete(ni);
    const idxs = this.#nodeIndex.get(ni) ?? [];
    const vidx = new Map((store.labels?.videos ?? []).map((v, i) => [v, i]));
    if (idxs.length >= NodeEmbeddingStore.MIN_PER_NODE) {
      const { res, usedScorer, refCount } = await this.#scoreGroup(idxs, vidx);
      idxs.forEach((r, k) => { this.#z[r] = res.z[k]; this.#coords[r] = res.coords[k]; });
      const st = this.#nodeStats.find((x) => x.node === ni);
      if (st) { st.scored = true; st.refCount = refCount; st.scorer = usedScorer; }
    } else {
      idxs.forEach((r) => { this.#z[r] = 0; });
    }
    ({ frameZ: this.#frameZ, worstByInst: this.#worstByInst } = buildScoreMaps(this.#recs, this.#z, store.frames, vidx));
    this.#scoreSig = null; this.#scoreRes = null;   // the memo describes a state that no longer holds
    this.rev++; this.resultRev++;
    return true;
  }

  /** Which keypoints are scored by a locally-trained model rather than by unsupervised kNN. */
  trainedNode(ni) { this.resultRev; return this.#trainedNodes.has(ni); }
  /** How a keypoint is currently scored. The supervised modes override whichever unsupervised
   *  scorer produced the group's baseline. */
  scoringOf(ni) {
    this.resultRev;
    if (this.#fewShot.has(ni)) return "fewshot";
    if (this.#trainedNodes.has(ni)) return "svm";
    return this.#nodeStats.find((s) => s.node === ni)?.scorer ?? "knn";
  }

  /**
   * How much of this run carries DINOv2 patch features — what AnomalyDINO needs and kNN does not.
   *
   * It is never all-or-nothing, because the embedding cache predates patch features: a file embedded
   * before this existed re-serves its CLS vectors happily and has no patch tokens to give. Those
   * records are the difference between "AnomalyDINO scored everything" and "AnomalyDINO scored the
   * two-thirds of your file that came from a fresh embed", and a check that quietly did the second
   * while reporting the first would be worse than not offering it.
   */
  get patchCoverage() {
    this.resultRev;
    const total = this.#recs.length;
    let have = 0;
    for (const d of this.#pts) if (d?.length) have++;
    return { have, total, full: total > 0 && have === total, tokens: tokenCount(PATCH), dim: PATCH.dim };
  }

  /** Can AnomalyDINO run at all on the current results? */
  get canAnomalyDino() { this.resultRev; return this.patchCoverage.have > 0; }

  /**
   * Switch the unsupervised scorer and re-score, WITHOUT re-embedding: the patch descriptors are
   * already here, so this is a couple of minutes of arithmetic against a half-hour of inference.
   *
   * Supervised groups keep their models — the scorer is the unsupervised baseline, and a group the
   * user fitted an SVM for is not asking a question this answers. Their z is rebuilt from the model
   * afterwards so the frame-level maps stay consistent with what each group actually reports.
   */
  async setScorer(which) {
    const next = which === "anomalyDino" ? "anomalyDino" : "knn";
    if (next === this.scorer || !this.#scored) { this.scorer = next; this.rev++; return; }
    this.scorer = next;
    this.#scoreSig = null; this.#scoreRes = null;
    this.#fewShot.clear(); this.#fsBase.clear(); // a blend over scores that no longer exist
    this.status = "scoring"; this.message = `Re-scoring with ${next === "anomalyDino" ? "AnomalyDINO" : "kNN"}…`;
    this.rev++;
    try {
      const vidx = new Map((store.labels?.videos ?? []).map((v, i) => [v, i]));
      await this.#scoreAllNodes(vidx);
      for (const [ni, clf] of this.#trainedNodes) this.#reapplyTrained(ni, clf);
      ({ frameZ: this.#frameZ, worstByInst: this.#worstByInst } = buildScoreMaps(this.#recs, this.#z, store.frames, vidx));
      this.status = "done"; this.message = "";
    } catch (e) {
      this.status = "error"; this.message = `Scoring failed — ${e?.message ?? e}`;
    }
    this.rev++; this.resultRev++;
  }

  /** A trained group's z, recomputed in place (no map rebuild — the caller does one at the end). */
  #reapplyTrained(ni, clf) {
    const idxs = this.#nodeIndex.get(ni) ?? [];
    if (!idxs.length) return;
    const z = robustZ(Array.from(rbfDecision(idxs.map((r) => this.#embs[r]), clf)));
    idxs.forEach((r, k) => { this.#z[r] = z[k]; });
  }

  /**
   * Few-shot: nudge a keypoint's ranking toward the patches you marked faulty.
   *
   * The cheap sibling of trainFor — a nearest-centroid direction rather than a fitted boundary — so it
   * works at label counts where an SVM's cross-validated score would be meaningless. Blended BY RANK
   * over whatever is scoring the group now (kNN or a trained SVM), so alpha=0 recovers that exactly and
   * the units never change out from under the threshold.
   */
  applyFewShot(ni, alpha = 0.5) {
    const idxs = this.#nodeIndex.get(ni) ?? [];
    const names = store.skeleton?.nodeNames ?? [];
    const nm = names[ni];
    if (!idxs.length || !nm) return null;
    const frames = store.frames ?? [];
    const embs = idxs.map((r) => this.#embs[r]);
    const pos = [], neg = [];
    idxs.forEach((r, k) => {
      const f = frames[this.#recs[r].fi];
      if (!f) return;
      const fk = frameKey(f);   // the stamped key, as above — not a second derivation
      if (!keypointLabels.isReviewedAt(fk, this.#recs[r].ii)) return;
      (keypointLabels.isBadAt(fk, this.#recs[r].ii, nm) ? pos : neg).push(k);
    });
    const proto = prototypeDirection(embs, pos, neg);
    if (!proto) return null;
    // Blend from the UNBLENDED scores, always. Re-applying (a second click, a moved alpha, new labels)
    // would otherwise blend a blend, drifting the ranking further each time with nothing to show for it.
    if (this.#fsBase.has(ni)) { const b = this.#fsBase.get(ni); idxs.forEach((r, k) => { this.#z[r] = b[k]; }); }
    else this.#fsBase.set(ni, Float64Array.from(idxs.map((r) => this.#z[r])));
    const base = idxs.map((r) => this.#z[r]);
    const blended = blendByRank(base, Array.from(prototypeScores(embs, proto.w)), alpha);
    // blendByRank returns [0,1]; put it back on the robust-z scale the threshold and every consumer use.
    const z = robustZ(Array.from(blended));
    idxs.forEach((r, k) => { this.#z[r] = z[k]; });
    this.#fewShot.set(ni, { alpha, ...proto });
    const vidx = new Map((store.labels?.videos ?? []).map((v, i) => [v, i]));
    ({ frameZ: this.#frameZ, worstByInst: this.#worstByInst } = buildScoreMaps(this.#recs, this.#z, store.frames, vidx));
    this.#scoreSig = null; this.#scoreRes = null;
    this.rev++; this.resultRev++;
    return this.#fewShot.get(ni);
  }
  fewShotInfoFor(ni) { this.resultRev; return this.#fewShot.get(ni) ?? null; }

  /** The locally-fitted model for a keypoint, in the shape the .bin exporter and svm.js both use. */
  trainedModelFor(ni) { return this.#trainedNodes.get(ni) ?? null; }

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
  /** Worst-scoring node of one instance, by the SAME "videoIdx:frameIdx" key the QC store already
   *  holds. O(1) — this is called once per instance per render, and the scan it replaces was over
   *  every embedded patch in the file. */
  worstNodeAtKey(fkey, ii) {
    this.resultRev;
    return this.#worstByInst.get(`${fkey}:${ii}`) ?? null;
  }
  /** Same, addressed by index into store.frames. Kept for callers that only have the index. */
  worstNodeFor(fi, ii) {
    this.resultRev;
    const f = store.frames?.[fi];
    if (!f) return null;
    const vidx = (store.labels?.videos ?? []).indexOf(f.video);
    return this.worstNodeAtKey(f.fkey ?? `${vidx < 0 ? 0 : vidx}:${f.frameIdx}`, ii);
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
    // Best-effort: without this the origin is evictable, and a 200 MB embedding cache is
    // exactly the kind of thing a browser drops under disk pressure.
    requestPersist();
    this.#recs = []; this.#embs = []; this.#pts = []; this.#z = []; this.#coords = []; this.#nodeIndex = new Map(); this.#nodeStats = []; this.#frameZ = new Map(); this.#worstByInst = new Map(); this.#scored = false;
    // The scoring choices describe the patches that are about to be thrown away: a model fitted on the
    // old embeddings, and a blend over scores that no longer exist. Keeping them would make the next run
    // report "trained SVM" for a group the kNN pass just scored, and hand out that stale model on export.
    this.#trainedNodes.clear(); this.#fewShot.clear(); this.#fsBase.clear();
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
    if (!insts.length) { this.status = "error"; this.message = "No instances to embed."; return; }

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
    this.#ranSig = this.#configSig();

    const byFrame = new Map();
    for (const it of insts) { if (!byFrame.has(it.fi)) byFrame.set(it.fi, []); byFrame.get(it.fi).push(it.ii); }
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
      if (plan.length) jobs.push({ fi, item, plan, needsImg: plan.some((p) => !this.#reusable(p.key)) });
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
      const { embs, patches } = await be.embedBatch(batch.map((b) => b.img), PATCH);
      for (let i = 0; i < batch.length; i++) {
        const { r, key } = batch[i];
        const emb = l2norm(embs[i]);
        const pt = patches?.[i] ?? null;
        this.#embs[r] = emb;
        this.#pts[r] = pt;
        const hit = { emb, thumb: this.#recs[r].thumb, pt };
        this.#cache.set(key, hit);
        fresh.push([key, hit]);
      }
      this.progress.done += batch.length; // in-place: progress is a deep $state proxy, so this is
      // reactive without allocating a new object (and a new proxy) per flush.
    };

    let imgP = decode(0);
    for (let j = 0; j < jobs.length && !this.#abort; j++) {
      const { fi, plan } = jobs[j];
      const img = await imgP;
      imgP = decode(j + 1);
      for (const { ii, node, box, key } of plan) {
        if (this.#reusable(key)) {
          const hit = this.#cache.get(key);
          hits++;
          this.#recs.push({ fi, ii, node, thumb: hit.thumb }); this.#embs.push(hit.emb); this.#pts.push(hit.pt ?? null); usedKeys.push(key);
          this.progress.done += 1; // in-place — see the flush above; this one runs once per PATCH
        } else if (img?.width) {
          drawPatch(crop, img, box);
          const id = cropCtx.getImageData(0, 0, crop.width, crop.height);
          thumbCtx.drawImage(crop, 0, 0, thumb.width, thumb.height);
          const r = this.#recs.length;
          this.#recs.push({ fi, ii, node, thumb: thumb.toDataURL("image/jpeg", 0.7) });
          this.#embs.push(null); this.#pts.push(null); usedKeys.push(key);
          queue.push({ r, key, img: { data: id.data, width: id.width, height: id.height } });
          if (queue.length >= BATCH) {
            try { await flush(); } catch (e) { this.status = "error"; this.message = `Embedding failed — ${e.message}`; return; }
          }
        } else {
          this.progress.done += 1; // in-place — see the flush above; this one runs once per PATCH
        }
        const now = performance.now();
        if (now - lastYield > 40) { setMsg(); this.rev++; await new Promise((res) => requestAnimationFrame(res)); lastYield = now; }
      }
    }
    try { if (!this.#abort) await flush(); } catch (e) { this.status = "error"; this.message = `Embedding failed — ${e.message}`; return; }
    // Persist BEFORE the abort check: a partially-embedded set is exactly as reusable as a complete one
    // (each entry is keyed by file/video/frame/node/box), and throwing away twenty minutes of DINO
    // because someone pressed Stop is the most expensive bug in this file.
    if (fresh.length) this.#persist(fileId, fresh);
    if (this.#abort) {
      for (let r = this.#recs.length - 1; r >= 0; r--) if (!this.#embs[r]) { this.#recs.splice(r, 1); this.#embs.splice(r, 1); this.#pts.splice(r, 1); usedKeys.splice(r, 1); }
      this.status = "aborted"; this.message = "Stopped."; this.rev++; return;
    }
    if (!this.#embs.length) { this.status = "error"; this.message = "No patches could be embedded (no frame images?)."; return; }

    // Scoring wrapped so a throw can NEVER wedge the panel in "scoring" (mirrors embeddingStore's guard).
    try {
      const sig = `${this.scorer}|${this.anomalyQ}|${this.k}|${this.referenceFraction}|${this.patchFraction}|${usedKeys.join("|")}`;
      if (this.#scoreSig === sig && this.#scoreRes) {
        ({ z: this.#z, coords: this.#coords, nodeIndex: this.#nodeIndex, nodeStats: this.#nodeStats, frameZ: this.#frameZ, worstByInst: this.#worstByInst } = this.#scoreRes);
      } else {
        this.status = "scoring"; this.rev++;
        await this.#scoreAllNodes(vidx);
        this.#scoreSig = sig;
        this.#scoreRes = { z: this.#z, coords: this.#coords, nodeIndex: this.#nodeIndex, nodeStats: this.#nodeStats, frameZ: this.#frameZ, worstByInst: this.#worstByInst };
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
  /**
   * Score ONE keypoint group with the current unsupervised baseline. Factored out so the full run and
   * a single group being reverted from a trained model cannot drift apart on the reference, the
   * fallback rule, or which scorer they report.
   */
  async #scoreGroup(idxs, vidx) {
    const embsN = idxs.map((r) => this.#embs[r]);
    const vkeys = idxs.map((r) => vidx.get(store.frames[this.#recs[r].fi]?.video) ?? 0);
    const refIdx = stratifiedReference(vkeys, this.referenceFraction, NodeEmbeddingStore.REF_MIN_PER_VIDEO);
    // AnomalyDINO needs patch features, and a group whose reference has none would score every patch 0
    // and read as "all clean" — the worst possible failure for a QC check. Fall the group back to kNN
    // and SAY which scorer ran, rather than silently returning zeros.
    const ptsN = idxs.map((r) => this.#pts[r]);
    const haveAd = this.scorer === "anomalyDino"
      && refIdx.some((i) => ptsN[i]?.length) && ptsN.some((d) => d?.length);
    const res = await scoreEmbeddings(embsN, refIdx, this.k, haveAd
      ? { scorer: "anomalyDino", patches: ptsN, P: PATCH.dim, opts: { q: this.anomalyQ, bankTokens: ANOMALY_DINO.bankTokens } }
      : null); // off-thread; falls back on the main thread
    return { res, usedScorer: haveAd ? "anomalyDino" : "knn", refCount: refIdx.length };
  }

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
        nodeStats.push({ node: ni, count: idxs.length, scored: false, refCount: 0, scorer: null });
        continue;
      }
      this.message = `Scoring keypoint ${done}/${nodes.length}${this.scorer === "anomalyDino" ? " · AnomalyDINO" : ""}…`; this.rev++;
      const { res, usedScorer, refCount } = await this.#scoreGroup(idxs, vidx);
      for (let s = 0; s < idxs.length; s++) { const r = idxs[s]; z[r] = res.z[s]; coords[r] = res.coords[s]; }
      nodeStats.push({ node: ni, count: idxs.length, scored: true, refCount, scorer: usedScorer });
    }
    this.#z = z; this.#coords = coords; this.#nodeIndex = nodeIndex; this.#nodeStats = nodeStats;
    ({ frameZ: this.#frameZ, worstByInst: this.#worstByInst } = buildScoreMaps(this.#recs, z, store.frames, vidx));
  }
}

// One per-node store per backend, coexisting with the instance-level embeddingStores.
export const nodeEmbeddingStores = {
  dino: new NodeEmbeddingStore("dino"),
};
