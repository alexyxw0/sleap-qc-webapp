// Appearance-outlier analysis: crop each instance, embed the crop with DINOv2 ViT-S, and flag
// instances whose appearance is an outlier (occlusions / mis-placed nodes that geometry can't see).
// Kept fully inspectable — every crop, embedding neighbourhood, and score is exposed to the UI.
import { store } from "./labelsStore.svelte.js";
import { ensureModel, embed, MODEL } from "./qc/embedding/dino.js";
import { l2norm, knnOutlierScores, robustZ, pca2, nearestNeighbors } from "./qc/embedding/outlier.js";

// Instance bounding box (placed nodes), padded + squared, clamped to the image.
function instanceBox(item, ii, W, H) {
  const pts = item?.lf?.instances?.[ii]?.points ?? [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
  for (const p of pts) {
    const xy = p?.xy;
    if (!xy || Number.isNaN(xy[0]) || Number.isNaN(xy[1])) continue;
    minX = Math.min(minX, xy[0]); minY = Math.min(minY, xy[1]);
    maxX = Math.max(maxX, xy[0]); maxY = Math.max(maxY, xy[1]); n++;
  }
  if (n < 2) return null;
  const pad = Math.max(maxX - minX, maxY - minY) * 0.35 + 8;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const side = Math.max(maxX - minX, maxY - minY) + 2 * pad;
  const x = Math.max(0, Math.min(W - 4, cx - side / 2));
  const y = Math.max(0, Math.min(H - 4, cy - side / 2));
  return { x, y, w: Math.min(side, W - x), h: Math.min(side, H - y) };
}

function drawCrop(canvas, img, box) {
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, canvas.width, canvas.height);
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

  #recs = []; // { fi, ii, thumb }  (store-frame index, instance index, crop dataURL)
  #embs = []; // Float32Array (L2-normalized) per record, index-aligned with #recs
  #res = null; // { scores, z, coords }
  #abort = false;

  get records() { this.rev; return this.#recs; }
  get results() { this.rev; return this.#res; }
  get hasResults() { this.rev; return !!this.#res; }
  get flaggedCount() { this.rev; return this.#res ? this.#res.z.reduce((a, z) => a + (z >= this.threshold), 0) : 0; }

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
    this.#abort = false; this.#recs = []; this.#embs = []; this.#res = null; this.rev++;
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

    this.status = "running";
    this.message = `Embedding ${list.length} crops…`;
    this.progress = { done: 0, total: list.length };
    const crop = document.createElement("canvas");
    crop.width = crop.height = MODEL.input;
    const thumb = document.createElement("canvas");
    thumb.width = thumb.height = 56;

    for (const [fi, iis] of byFrame) {
      if (this.#abort) { this.status = "aborted"; this.message = "Stopped."; this.rev++; return; }
      const item = frames[fi];
      let img = null;
      try { img = await store.getFrameImage(item); } catch { /* skip */ }
      if (!img?.width) { this.progress = { ...this.progress, done: this.progress.done + iis.length }; continue; }
      for (const ii of iis) {
        const box = instanceBox(item, ii, img.width, img.height);
        if (box) {
          drawCrop(crop, img, box);
          try {
            const emb = await embed(crop);
            drawCrop(thumb, img, box);
            this.#recs.push({ fi, ii, thumb: thumb.toDataURL("image/jpeg", 0.7) });
            this.#embs.push(l2norm(emb));
          } catch (e) { this.status = "error"; this.message = `Embedding failed — ${e.message}`; return; }
        }
        this.progress = { ...this.progress, done: this.progress.done + 1 };
        if (this.#recs.length % 6 === 0) { this.rev++; await new Promise((r) => requestAnimationFrame(r)); }
      }
    }

    if (!this.#embs.length) { this.status = "error"; this.message = "No crops could be embedded (no frame images?)."; return; }
    this.status = "scoring"; this.message = `Scoring ${this.#embs.length} embeddings…`; this.rev++;
    await new Promise((r) => setTimeout(r));
    const scores = knnOutlierScores(this.#embs, this.k);
    const z = robustZ(scores);
    const { coords } = pca2(this.#embs);
    this.#res = { scores: Array.from(scores), z, coords };
    this.status = "done"; this.message = ""; this.rev++;
  }
}

export const embeddingStore = new EmbeddingStore();
