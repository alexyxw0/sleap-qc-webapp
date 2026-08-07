// Appearance-outlier analysis: crop each instance, embed the crop, and flag instances whose appearance
// is an outlier (occlusions / mis-placed nodes that geometry can't see). One backend: "dino", the DINOv2
// ViT semantic embedding, batched in a worker. (A classical pixel-feature backend used to sit alongside
// it; the experiments dropped it, so it is gone rather than left as an option that scores nothing worth
// acting on.) Kept fully inspectable — every crop, neighbourhood, and score is UI-visible.
import { store } from "./labelsStore.svelte.js";
import * as dinoBackend from "./qc/embedding/dinoRemote.js";
import { l2norm, stratifiedReference, nearestNeighbors, buildFrameZ, pca2 } from "./qc/embedding/outlier.js";
import { scoreEmbeddings } from "./qc/embedding/scoreRemote.js";
import { classifyDecisions, classifierInfo } from "./qc/embedding/appearanceClf.js";
import { loadAll as loadCache, putMany as saveCache } from "./qc/embedding/embcache.js";

const BACKENDS = { dino: dinoBackend };

// Padded square around the instance's placed nodes — image-INDEPENDENT (points only), so it can
// key the embedding cache; clamping to the actual image happens at draw time.
function squareBox(item, ii) {
  const pts = item?.lf?.instances?.[ii]?.points ?? [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
  for (const p of pts) {
    const xy = p?.xy;
    if (!xy || Number.isNaN(xy[0]) || Number.isNaN(xy[1])) continue;
    minX = Math.min(minX, xy[0]); minY = Math.min(minY, xy[1]);
    maxX = Math.max(maxX, xy[0]); maxY = Math.max(maxY, xy[1]); n++;
  }
  if (n < 2) return null;
  const side = Math.max(maxX - minX, maxY - minY) * 1.7 + 16;
  return { x: (minX + maxX) / 2 - side / 2, y: (minY + maxY) / 2 - side / 2, side };
}

// A crop is fully determined by (video, frame, box) — so is its embedding. Round the box to keep
// the key stable against sub-pixel jitter.
const cropKey = (vi, frameIdx, sq) => `${vi}:${frameIdx}:${Math.round(sq.x)}:${Math.round(sq.y)}:${Math.round(sq.side)}`;

function drawCrop(canvas, img, sq) {
  // willReadFrequently keeps the canvas CPU-backed: run() reads pixels straight back out of it for
  // every fresh crop, and a GPU-backed readback would dominate the per-crop cost.
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const W = img.width, H = img.height;
  const x = Math.max(0, Math.min(W - 4, sq.x));
  const y = Math.max(0, Math.min(H - 4, sq.y));
  ctx.drawImage(img, x, y, Math.min(sq.side, W - x), Math.min(sq.side, H - y), 0, 0, canvas.width, canvas.height);
}

const evenSample = (arr, cap) => {
  if (arr.length <= cap) return arr;
  const step = arr.length / cap, out = [];
  for (let i = 0; i < cap; i++) out.push(arr[Math.floor(i * step)]);
  return out;
};

class EmbeddingStore {
  status = $state("idle"); // idle | loading-model | running | scoring | done | error | aborted
  message = $state("");
  progress = $state({ done: 0, total: 0, startedAt: 0 });
  modelInfo = $state(null);
  backend; // pinned at construction; "dino" (ViT — slow, semantic) is the only one built
  // Scoring method: "knn" = unsupervised kNN-outlier (robust-z); "trained" = the RBF-SVM ported from the
  // dino_probe (supervised, ~0.82 ROC, DINO-ViT-S-only). threshold's meaning follows the method (robust-z
  // for knn, SVM decision value for trained), so the flag logic (z >= threshold) is unchanged.
  // Trained by default: the unsupervised kNN scored ~chance on whole-animal crops in the experiments,
  // so it is no longer offered in the UI. setMethod("knn") still works (the pipeline is intact) but
  // nothing selects it — per-keypoint patches are where the unsupervised route still discriminates.
  method = $state("trained");
  threshold = $state(classifierInfo()?.threshold ?? -0.67); // trained: SVM decision cutoff · knn: robust-z
  sampleCap = $state(null); // max crops to EMBED; null/0 => ALL instances (full coverage, no sampling gap)
  referenceFraction = $state(0.2); // fraction of embedded instances forming the kNN "normal" reference
  k = 6;
  static REF_MIN_PER_VIDEO = 20; // per-video floor so every video has enough same-domain reference points
  rev = $state(0);
  resultRev = $state(0); // bumps only when scored frame-flags change — cheap dep for the DINO QC check

  #recs = []; // { fi, ii, thumb }  (store-frame index, instance index, crop dataURL)
  #embs = []; // Float32Array (L2-normalized) per record, index-aligned with #recs
  #res = null; // { scores, z, coords }
  #frameZ = new Map(); // "videoIdx:frameIdx" -> max embedding z over that frame's instances
  #refCount = 0; // size of the kNN reference used for the current results
  #abort = false;
  // Embedding cache: cropKey -> { emb, thumb }. Persists across runs; a crop's DINO embedding never
  // changes unless the crop does, so re-running the same file skips decode + inference for hits.
  #cache = new Map();
  #cacheLabels = null; // the labels the cache was built for (cleared when a new file loads)
  #loadedFileId = null; // fileId the in-memory cache was hydrated from IndexedDB for (once per file)
  // Scoring cache: kNN+PCA are a pure function of the embedding set (O(N²)), independent of the
  // threshold, so an identical re-run reuses the result instead of recomputing.
  #scoreSig = null;
  #scoreRes = null;

  /** Each store instance is pinned to ONE backend so several encoders could run and be scored
   *  side-by-side (their vectors, dims, thresholds, and caches are all backend-namespaced). */
  constructor(backend = "dino") { this.backend = BACKENDS[backend] ? backend : "dino"; }

  /** The active backend module. */
  #be() { return BACKENDS[this.backend] ?? dinoBackend; }

  // Stable identity for the loaded file (+ backend) — namespaces the persistent cache so crops from a
  // different file OR a different backend can't be served for a matching (video,frame,bbox) key.
  // Filename + frame count + each video's shape is distinctive without reading pixels.
  #fileId() {
    const L = store.labels;
    const shapes = (L?.videos ?? []).map((v) => (Array.isArray(v?.shape) ? v.shape.join("x") : "?")).join(",");
    return `${this.backend}|${store.fileName || "?"}|${store.frames?.length ?? 0}|${shapes}`;
  }

  /** Total embeddable instances in the loaded file — the ceiling for full-coverage embedding. Reads
   *  store.frames (recomputes on file load), NOT store.rev, so it's not a node-drag hot path. */
  get instanceCount() {
    let n = 0;
    for (const f of store.frames ?? []) n += f.lf?.instances?.length ?? 0;
    return n;
  }
  /** Size of the kNN "normal" reference behind the current results (scored set is every embedding). */
  get refCount() { this.rev; return this.#refCount; }
  get records() { this.rev; return this.#recs; }
  get results() { this.rev; return this.#res; }
  get hasResults() { this.resultRev; return !!this.#res; }
  get flaggedCount() { this.rev; return this.#res ? this.#res.z.reduce((a, z) => a + (z >= this.threshold), 0) : 0; }
  /** Max embedding z for a frame, by "videoIdx:frameIdx" key (the DINO QC check reads this), or null. */
  frameZByKey(key) { this.resultRev; return this.#frameZ.get(key) ?? null; }
  /** Frames flagged at the current threshold (frame-level, for the check count). */
  get flaggedFrameCount() {
    this.resultRev;
    let n = 0;
    for (const z of this.#frameZ.values()) if (z >= this.threshold) n++;
    return n;
  }
  /** Keys ("videoIdx:frameIdx") of frames flagged at the current threshold — so the QC store can
   *  fold DINO into its union flagged-frame count (keys match qcStore's #fkey). */
  flaggedFrameKeys() {
    this.resultRev;
    const out = [];
    for (const [k, z] of this.#frameZ) if (z >= this.threshold) out.push(k);
    return out;
  }

  /** Records whose frame is `fi` (store index), with their outlier stats attached. */
  recordsForFrame(fi) {
    this.rev;
    const out = [];
    for (let r = 0; r < this.#recs.length; r++) if (this.#recs[r].fi === fi) out.push(this.#withStats(r));
    return out;
  }
  /** All records sorted worst (most-outlier) first. */
  outlierRecords() {
    this.rev;
    if (!this.#res) return [];
    return this.#recs.map((_, r) => this.#withStats(r)).sort((a, b) => b.z - a.z);
  }
  /** Nearest-neighbour records of record `r` (what the model thinks it looks like). */
  neighborsOf(r, k = 5) {
    this.rev;
    if (!this.#embs.length) return [];
    return nearestNeighbors(this.#embs, r, k).map((j) => this.#withStats(j));
  }
  #withStats(r) {
    const rec = this.#recs[r];
    return { r, fi: rec.fi, ii: rec.ii, thumb: rec.thumb, z: this.#res?.z[r] ?? 0, score: this.#res?.scores[r] ?? 0, xy: this.#res?.coords[r] ?? [0, 0] };
  }

  abort() { this.#abort = true; }

  async run() {
    if (this.status === "running" || this.status === "loading-model" || this.status === "scoring") return;
    if (store.labels !== this.#cacheLabels) { this.#cache.clear(); this.#scoreSig = null; this.#scoreRes = null; this.#cacheLabels = store.labels; this.#loadedFileId = null; } // new file -> drop stale cache
    this.#abort = false; this.#recs = []; this.#embs = []; this.#res = null; this.#frameZ = new Map(); this.rev++; this.resultRev++;
    const be = this.#be();
    this.status = "loading-model"; this.message = `Loading ${be.MODEL.name}…`;
    try {
      this.modelInfo = await be.ensureModel((p) => { if (p?.status) this.message = `Loading model · ${p.status}${p.progress ? ` ${Math.round(p.progress)}%` : ""}`; });
    } catch (e) { this.status = "error"; this.message = `Model load failed — ${e.message}. (The DINO backend needs the network for the CDN + HF hub.)`; return; }

    // Hydrate the in-memory cache from IndexedDB once per file, so a re-run after a page reload reuses
    // embeddings instead of recomputing (the in-memory Map alone doesn't survive a reload).
    const fileId = this.#fileId();
    if (this.#loadedFileId !== fileId) {
      this.message = "Loading cached embeddings…"; this.rev++;
      const persisted = await loadCache(fileId);
      for (const [k, v] of persisted) if (!this.#cache.has(k)) this.#cache.set(k, v);
      this.#loadedFileId = fileId;
    }

    const frames = store.frames ?? [];
    const items = [];
    for (let fi = 0; fi < frames.length; fi++) {
      const insts = frames[fi].lf?.instances ?? [];
      for (let ii = 0; ii < insts.length; ii++) items.push({ fi, ii });
    }
    // null/0/≥total => embed ALL instances (no sampling gap); a positive cap < total evenly subsamples.
    const cap = this.sampleCap && this.sampleCap > 0 ? this.sampleCap : items.length;
    const list = evenSample(items, cap);
    if (!list.length) { this.status = "error"; this.message = "No instances to embed."; return; }

    const byFrame = new Map();
    for (const it of list) { if (!byFrame.has(it.fi)) byFrame.set(it.fi, []); byFrame.get(it.fi).push(it.ii); }

    const vidx = new Map((store.labels?.videos ?? []).map((v, i) => [v, i]));
    this.status = "running";
    this.progress = { done: 0, total: list.length, startedAt: performance.now() };
    const crop = document.createElement("canvas");
    crop.width = crop.height = be.MODEL.input;
    const cropCtx = crop.getContext("2d", { willReadFrequently: true });
    const thumb = document.createElement("canvas");
    thumb.width = thumb.height = 56;
    const thumbCtx = thumb.getContext("2d");
    let hits = 0, embedded = 0;
    const fresh = []; // [cropKey, { emb, thumb }] embedded this run — persisted to IndexedDB after
    const usedKeys = []; // crop keys, index-aligned with #recs — signs the embedding set for the scoring cache
    let lastYield = performance.now();
    const setMsg = () => { this.message = `Embedding ${list.length} crops…${hits ? ` · ${hits} reused from cache` : ""}`; };
    setMsg();

    // Resolve every frame's crop boxes + cache keys up front (pure point math): fully-cached frames
    // skip the decode entirely, and the NEXT frame's decode can start while the current one embeds.
    // Keys are prefixed by backend so two encoders' vectors could never collide in the in-memory cache.
    const jobs = [];
    for (const [fi, iis] of byFrame) {
      const item = frames[fi];
      const vi = vidx.get(item.video) ?? 0;
      const plan = iis.map((ii) => { const sq = squareBox(item, ii); return { ii, sq, key: sq ? `${this.backend}:${cropKey(vi, item.frameIdx, sq)}` : null }; });
      jobs.push({ fi, item, plan, needsImg: plan.some((p) => p.key && !this.#cache.has(p.key)) });
    }
    const decode = (j) => (j < jobs.length && jobs[j].needsImg ? store.getFrameImage(jobs[j].item).catch(() => null) : null);

    // Fresh crops are embedded in batches: ONE forward pass per BATCH crops (the DINO worker path
    // amortizes the postMessage + JS↔WASM round-trip and keeps the WASM thread pool fed between
    // layers). Each queued crop reserves its #recs/#embs slot at plan time, so record order stays
    // exactly the plan order no matter when its batch flushes; flush() fills the vector in.
    const BATCH = Math.max(1, be.MODEL.batch || 1);
    let queue = []; // { r, key, img: {data,width,height} } — r = reserved index into #recs/#embs
    const flush = async () => {
      if (!queue.length) return;
      const batch = queue; queue = [];
      const embs = await be.embedBatch(batch.map((b) => b.img)); // buffers may be transferred — consumed
      for (let i = 0; i < batch.length; i++) {
        const { r, key } = batch[i];
        const emb = l2norm(embs[i]);
        this.#embs[r] = emb;
        const hit = { emb, thumb: this.#recs[r].thumb };
        this.#cache.set(key, hit);
        fresh.push([key, hit]);
        embedded++;
      }
      this.progress.done += batch.length; // in-place: progress is a deep $state proxy, so this is reactive without a per-flush object alloc
    };

    let imgP = decode(0);
    for (let j = 0; j < jobs.length && !this.#abort; j++) {
      const { fi, plan } = jobs[j];
      const img = await imgP;
      imgP = decode(j + 1); // kick off the next frame's decode now — it overlaps this frame's embedding
      for (const { ii, sq, key } of plan) {
        if (key && this.#cache.has(key)) {
          const hit = this.#cache.get(key);
          hits++;
          this.#recs.push({ fi, ii, thumb: hit.thumb }); this.#embs.push(hit.emb); usedKeys.push(key);
          this.progress.done += 1;
        } else if (key && img?.width) {
          drawCrop(crop, img, sq);
          const id = cropCtx.getImageData(0, 0, crop.width, crop.height);
          thumbCtx.drawImage(crop, 0, 0, thumb.width, thumb.height); // thumb from the cropped canvas — one source sample, not two
          const r = this.#recs.length;
          this.#recs.push({ fi, ii, thumb: thumb.toDataURL("image/jpeg", 0.7) });
          this.#embs.push(null); usedKeys.push(key); // reserved — filled by flush()
          queue.push({ r, key, img: { data: id.data, width: id.width, height: id.height } });
          if (queue.length >= BATCH) {
            try { await flush(); } catch (e) { this.status = "error"; this.message = `Embedding failed — ${e.message}`; return; }
          }
        } else {
          this.progress.done += 1; // no box / no decodable image
        }
        // Yield on a time budget, not a fixed count: a warm cache blasts through with a handful of
        // yields, while a cold run still repaints steadily (the embed itself no longer blocks paint —
        // the DINO forward pass runs in a worker).
        const now = performance.now();
        if (now - lastYield > 40) { setMsg(); this.rev++; await new Promise((r) => requestAnimationFrame(r)); lastYield = now; }
      }
    }
    try { if (!this.#abort) await flush(); } catch (e) { this.status = "error"; this.message = `Embedding failed — ${e.message}`; return; }
    if (this.#abort) {
      // Drop reservations whose batch never ran; the filled records remain valid partial output.
      for (let r = this.#recs.length - 1; r >= 0; r--) if (!this.#embs[r]) { this.#recs.splice(r, 1); this.#embs.splice(r, 1); usedKeys.splice(r, 1); }
      this.status = "aborted"; this.message = "Stopped."; this.rev++; return;
    }

    // Persist crops embedded this run so a future run — even after a page reload — reuses them
    // (fire-and-forget; failures are swallowed inside embcache).
    if (fresh.length) saveCache(fileId, fresh);

    if (!this.#embs.length) { this.status = "error"; this.message = "No crops could be embedded (no frame images?)."; return; }
    // Everything past here is wrapped so a throw can NEVER leave the panel wedged in "scoring" with a
    // locked checkbox (the failure this replaced): on error we surface it and bump resultRev so the UI reacts.
    try {
      // Reuse the cached score only if the METHOD, crop set, and reference selection are unchanged.
      const sig = `${this.method}|${this.k}|${this.referenceFraction}|${usedKeys.join("|")}`;
      if (this.#scoreSig === sig && this.#scoreRes) {
        this.#res = this.#scoreRes;
      } else {
        this.status = "scoring";
        this.message = this.method === "trained" ? `Scoring ${this.#embs.length} with the trained classifier…`
                                                 : `Scoring ${this.#embs.length} vs reference…`;
        this.rev++;
        await new Promise((r) => setTimeout(r));
        this.#res = await this.#computeRes(vidx); // knn (off-thread) OR trained SVM (off-thread)
        this.#scoreSig = sig; this.#scoreRes = this.#res;
      }
      // Per-frame max z, keyed like qcStore's #fkey (videoIdx:frameIdx), so the appearance check can join.
      this.#frameZ = buildFrameZ(this.#recs, this.#res.z, store.frames, vidx);
      this.status = "done"; this.message = ""; this.rev++; this.resultRev++;
    } catch (e) {
      this.status = "error"; this.message = `Scoring failed — ${e?.message ?? e}`; this.rev++; this.resultRev++;
    }
  }

  /** Compute results for the CURRENT method from the embedded set (no re-embed). "trained" = the ported
   *  RBF-SVM decision (DINO-ViT-S only); otherwise the unsupervised kNN-outlier vs a per-video reference.
   *  Both return { scores, z, coords }; higher z = more faulty, so `z >= threshold` flags either way. */
  async #computeRes(vidx) {
    if (this.method === "trained" && this.backend === "dino") {
      const dec = await classifyDecisions(this.#embs); // SVM decision value per instance
      const { coords } = pca2(this.#embs); // 2-D map is method-independent (just PCA of the embeddings)
      this.#refCount = 0;
      return { scores: Array.from(dec), z: Array.from(dec), coords };
    }
    // Reference = an even, per-video-stratified subsample; every instance is scored against it.
    const refKeys = this.#recs.map((rec) => vidx.get(store.frames[rec.fi]?.video) ?? 0);
    const refIdx = stratifiedReference(refKeys, this.referenceFraction, EmbeddingStore.REF_MIN_PER_VIDEO);
    this.#refCount = refIdx.length;
    return await scoreEmbeddings(this.#embs, refIdx, this.k);
  }

  /** Re-score the already-embedded set for the current method (used on a method switch — no re-embed). */
  async #rescore() {
    if (!this.#embs.length) return;
    const vidx = new Map((store.labels?.videos ?? []).map((v, i) => [v, i]));
    this.status = "scoring"; this.message = "Re-scoring…"; this.rev++;
    await new Promise((r) => requestAnimationFrame(r));
    try {
      this.#res = await this.#computeRes(vidx);
      this.#scoreSig = null; this.#scoreRes = this.#res;
      this.#frameZ = buildFrameZ(this.#recs, this.#res.z, store.frames, vidx);
      this.status = "done"; this.message = ""; this.rev++; this.resultRev++;
    } catch (e) {
      this.status = "error"; this.message = `Scoring failed — ${e?.message ?? e}`; this.rev++; this.resultRev++;
    }
  }

  /** Switch scoring method. "trained" is DINO-ViT-S-only (the classifier's feature space). Resets the
   *  threshold to the method's default and re-scores the cached embeddings in place if we have them. */
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

  setMethod(m) {
    if (m === this.method || (m !== "knn" && m !== "trained")) return;
    if (m === "trained" && this.backend !== "dino") return; // classifier is DINO-specific
    this.method = m;
    this.threshold = m === "trained" ? (classifierInfo()?.threshold ?? -0.67) : 3.5;
    this.#scoreSig = null;
    if (this.#embs.length && (this.status === "done" || this.status === "aborted")) this.#rescore();
    else { this.rev++; }
  }

  /** Whether the trained classifier applies to this store (DINO backend only). */
  get canUseTrained() { return this.backend === "dino"; }
}

// One store PER backend, so both can be embedded, scored, and enabled as independent checks at the
// same time (each holds its own results + threshold; caches are namespaced by backend).
// A one-entry registry rather than a bare store: the per-backend shape is what makes adding a second
// encoder a one-line change, and every call site already indexes by name.
export const embeddingStores = {
  dino: new EmbeddingStore("dino"),
};
