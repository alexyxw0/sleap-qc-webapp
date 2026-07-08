// Appearance-outlier analysis: crop each instance, embed the crop with DINOv2 ViT-S, and flag
// instances whose appearance is an outlier (occlusions / mis-placed nodes that geometry can't see).
// Kept fully inspectable — every crop, embedding neighbourhood, and score is exposed to the UI.
import { store } from "./labelsStore.svelte.js";
import { ensureModel, embed, MODEL } from "./qc/embedding/dino.js";
import { l2norm, knnOutlierScores, robustZ, pca2, nearestNeighbors } from "./qc/embedding/outlier.js";

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
  const ctx = canvas.getContext("2d");
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
  progress = $state({ done: 0, total: 0 });
  modelInfo = $state(null);
  threshold = $state(3.5); // robust-z cutoff for "outlier"
  sampleCap = $state(1200);
  k = 6;
  rev = $state(0);
  resultRev = $state(0); // bumps only when scored frame-flags change — cheap dep for the DINO QC check

  #recs = []; // { fi, ii, thumb }  (store-frame index, instance index, crop dataURL)
  #embs = []; // Float32Array (L2-normalized) per record, index-aligned with #recs
  #res = null; // { scores, z, coords }
  #frameZ = new Map(); // "videoIdx:frameIdx" -> max embedding z over that frame's instances
  #abort = false;
  // Embedding cache: cropKey -> { emb, thumb }. Persists across runs; a crop's DINO embedding never
  // changes unless the crop does, so re-running the same file skips decode + inference for hits.
  #cache = new Map();
  #cacheLabels = null; // the labels the cache was built for (cleared when a new file loads)
  // Scoring cache: kNN+PCA are a pure function of the embedding set (O(N²)), independent of the
  // threshold, so an identical re-run reuses the result instead of recomputing.
  #scoreSig = null;
  #scoreRes = null;

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
    if (store.labels !== this.#cacheLabels) { this.#cache.clear(); this.#scoreSig = null; this.#scoreRes = null; this.#cacheLabels = store.labels; } // new file -> drop stale cache
    this.#abort = false; this.#recs = []; this.#embs = []; this.#res = null; this.#frameZ = new Map(); this.rev++; this.resultRev++;
    this.status = "loading-model"; this.message = "Loading DINOv2 ViT-S…";
    try {
      this.modelInfo = await ensureModel((p) => { if (p?.status) this.message = `Loading model · ${p.status}${p.progress ? ` ${Math.round(p.progress)}%` : ""}`; });
    } catch (e) { this.status = "error"; this.message = `Model load failed — ${e.message}. (Needs network for the CDN + HF hub.)`; return; }

    const frames = store.frames ?? [];
    const items = [];
    for (let fi = 0; fi < frames.length; fi++) {
      const insts = frames[fi].lf?.instances ?? [];
      for (let ii = 0; ii < insts.length; ii++) items.push({ fi, ii });
    }
    const list = evenSample(items, this.sampleCap);
    if (!list.length) { this.status = "error"; this.message = "No instances to embed."; return; }

    const byFrame = new Map();
    for (const it of list) { if (!byFrame.has(it.fi)) byFrame.set(it.fi, []); byFrame.get(it.fi).push(it.ii); }

    const vidx = new Map((store.labels?.videos ?? []).map((v, i) => [v, i]));
    this.status = "running";
    this.progress = { done: 0, total: list.length };
    const crop = document.createElement("canvas");
    crop.width = crop.height = MODEL.input;
    const thumb = document.createElement("canvas");
    thumb.width = thumb.height = 56;
    let hits = 0, embedded = 0;
    const usedKeys = []; // crop keys in emit order — signs the embedding set for the scoring cache
    let lastYield = performance.now();
    const setMsg = () => { this.message = `Embedding ${list.length} crops…${hits ? ` · ${hits} reused from cache` : ""}`; };
    setMsg();

    for (const [fi, iis] of byFrame) {
      if (this.#abort) { this.status = "aborted"; this.message = "Stopped."; this.rev++; return; }
      const item = frames[fi];
      const vi = vidx.get(item.video) ?? 0;
      // Resolve each instance's box + cache key up front, so a fully-cached frame skips the decode.
      const plan = iis.map((ii) => { const sq = squareBox(item, ii); return { ii, sq, key: sq ? cropKey(vi, item.frameIdx, sq) : null }; });
      let img = null;
      if (plan.some((p) => p.key && !this.#cache.has(p.key))) { try { img = await store.getFrameImage(item); } catch { /* skip */ } }
      for (const { ii, sq, key } of plan) {
        if (key) {
          let hit = this.#cache.get(key);
          if (hit) hits++;
          else if (img?.width) {
            try {
              drawCrop(crop, img, sq);
              const emb = l2norm(await embed(crop));
              drawCrop(thumb, img, sq);
              hit = { emb, thumb: thumb.toDataURL("image/jpeg", 0.7) };
              this.#cache.set(key, hit);
              embedded++;
            } catch (e) { this.status = "error"; this.message = `Embedding failed — ${e.message}`; return; }
          }
          if (hit) { this.#recs.push({ fi, ii, thumb: hit.thumb }); this.#embs.push(hit.emb); usedKeys.push(key); }
        }
        this.progress = { ...this.progress, done: this.progress.done + 1 };
        // Yield on a time budget, not a fixed count: a warm cache blasts through with a handful of
        // yields, while a cold run (each embed blocks ~100ms) still repaints ~every frame.
        const now = performance.now();
        if (now - lastYield > 40) { setMsg(); this.rev++; await new Promise((r) => requestAnimationFrame(r)); lastYield = now; }
      }
    }

    if (!this.#embs.length) { this.status = "error"; this.message = "No crops could be embedded (no frame images?)."; return; }
    // Reuse the cached score if the exact set of crops (in the same order) is unchanged — kNN is O(N²).
    const sig = `${this.k}|${usedKeys.join("|")}`;
    if (this.#scoreSig === sig && this.#scoreRes) {
      this.#res = this.#scoreRes;
    } else {
      this.status = "scoring"; this.message = `Scoring ${this.#embs.length} embeddings…`; this.rev++;
      await new Promise((r) => setTimeout(r));
      const scores = knnOutlierScores(this.#embs, this.k);
      const z = robustZ(scores);
      const { coords } = pca2(this.#embs);
      this.#res = { scores: Array.from(scores), z, coords };
      this.#scoreSig = sig; this.#scoreRes = this.#res;
    }
    // Per-frame max z, keyed like qcStore's #fkey (videoIdx:frameIdx), so the DINO check can join.
    this.#frameZ = new Map();
    for (let r = 0; r < this.#recs.length; r++) {
      const f = store.frames[this.#recs[r].fi];
      if (!f) continue;
      const key = `${vidx.get(f.video) ?? 0}:${f.frameIdx}`;
      if (z[r] > (this.#frameZ.get(key) ?? -Infinity)) this.#frameZ.set(key, z[r]);
    }
    this.status = "done"; this.message = ""; this.rev++; this.resultRev++;
  }
}

export const embeddingStore = new EmbeddingStore();
