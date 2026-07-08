// labelsStore.svelte.js
//
// The bridge between sleap-io.js (plain class instances) and Svelte 5 reactivity.
//
// Svelte 5 does NOT deep-proxy external class instances, so mutating
// `instance.points[i].xy` on a sleap-io.js object triggers nothing. We therefore
// hold the model in `$state.raw` (reactive *reference*, non-reactive contents) and
// expose a `rev` counter that every mutation bumps to signal "redraw". This is the
// pattern documented in the investigation (frontend-svelte.md, DQ-F1).

import { loadSlp, loadVideo } from "@talmolab/sleap-io.js";

// Predicted instances often carry keypoints the model never placed (NaN coords). With no position
// they can't be clicked or dragged, so seed each with an arbitrary IN-FRAME spot — clustered (by the
// golden angle) near the instance's visible centroid, kept `visible:false` — a faint "ghost" the user
// drags to fix (drag makes it visible). Only PREDICTED instances (`inst.score != null`); already-placed
// keypoints are untouched. Runs once at load, so it's part of the initial state (not an undoable edit).
function placeUnplacedNodes(labels) {
  const isPlaced = (xy) => xy && xy[0] != null && !Number.isNaN(xy[0]);
  for (const lf of labels.labeledFrames ?? []) {
    let fcx = 0, fcy = 0, fn = 0; // frame-wide placed centroid (fallback if an instance has none)
    for (const inst of lf.instances ?? []) for (const p of inst.points ?? []) {
      if (isPlaced(p.xy)) { fcx += p.xy[0]; fcy += p.xy[1]; fn++; }
    }
    const frameCenter = fn ? [fcx / fn, fcy / fn] : null;
    for (const inst of lf.instances ?? []) {
      if (inst.score == null) continue; // predicted only
      const pts = inst.points ?? [];
      let cx = 0, cy = 0, nc = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const unplaced = [];
      for (let k = 0; k < pts.length; k++) {
        const xy = pts[k].xy;
        if (isPlaced(xy)) {
          cx += xy[0]; cy += xy[1]; nc++;
          if (xy[0] < minX) minX = xy[0];
          if (xy[1] < minY) minY = xy[1];
          if (xy[0] > maxX) maxX = xy[0];
          if (xy[1] > maxY) maxY = xy[1];
        } else unplaced.push(k);
      }
      if (!unplaced.length) continue;
      const center = nc ? [cx / nc, cy / nc] : (frameCenter ?? [50, 50]);
      const spread = nc ? Math.max(18, Math.hypot(maxX - minX, maxY - minY) * 0.25) : 40;
      unplaced.forEach((k, idx) => {
        const a = idx * 2.39996; // golden angle -> a spread cluster, not a single stack
        pts[k].xy = [center[0] + Math.cos(a) * spread, center[1] + Math.sin(a) * spread];
        pts[k].visible = false; // a ghost; dragging it makes it visible (visible-on-drag)
      });
    }
  }
}

class LabelsStore {
  // Monotonic load generation. Every new load() bumps this; an in-flight load whose
  // token is no longer current discards its result instead of clobbering the newer
  // one. (The underlying sleap-io.js worker can't be aborted, so it runs to
  // completion in the background, but its stale result is ignored.)
  #loadToken = 0;

  // Frame-image pump state. Video decoders are stateful: firing overlapping/aborted
  // getFrame() calls (e.g. dragging the timeline) corrupts the decode order and can leave
  // the wrong frame on screen. So we decode ONE frame at a time and always reconcile to the
  // latest requested frame (#imgWant) — rapid scrubbing converges without overlapping decodes.
  #imgWant = null; // key of the frame the UI currently wants shown
  #imgHave = undefined; // key of the frame `frameImage` currently holds
  #imgPumping = false;
  // LRU cache of DECODED frame images (keyed by #frameKey). Embedded .pkg.slp frames are large
  // (~0.6 MB encoded) and cost ~50-100 ms to read+decode EACH — so without a cache every navigation
  // (even revisiting a frame you just saw) re-decoded from scratch, which was the dominant per-input
  // latency. Bounded to #imgCacheCap; cleared on file load. Eviction just drops the ref (GC reclaims).
  #imgCache = new Map();
  #imgCacheCap = 32;

  // --- model (non-reactive contents; reassigned wholesale on load) ---
  labels = $state.raw(null);
  videoModel = $state.raw(null); // optional externally-uploaded video backend
  frames = $state.raw([]); // navigable list: [{ video, frameIdx, lf }]
  frameImage = $state.raw(null); // decoded image for the current frame (kept in sync via the pump)

  // --- reactive scalars ---
  rev = $state(0); // bump to signal model mutated -> redraw
  index = $state(0); // position within `frames`
  // Which frames arrow-key nav (next/prev) steps through — a sorted list of `frames` indices, or
  // null for the whole file. `base` follows the frames-grid filter (all/labeled/flagged); a
  // drill-down (e.g. the manual-check tabs) can `override` it while active. So the arrows always
  // traverse whatever subset the user is currently looking at.
  navBase = $state.raw(null);
  navOverride = $state.raw(null);
  status = $state("idle"); // idle | loading | needs-video | ready | error
  message = $state("");
  error = $state(null);
  fileName = $state("");
  videoName = $state("");
  videoLoading = $state(false);
  hasEmbedded = $state(false);

  // --- derived-ish getters (reactive because they read $state fields) ---
  get current() {
    return this.frames[this.index] ?? null;
  }
  get skeleton() {
    return this.labels?.skeletons?.[0] ?? null;
  }
  get frameCount() {
    return this.frames.length;
  }
  /** Number of videos in the loaded file (a .pkg.slp can embed many). */
  get videoCount() {
    return this.labels?.videos?.length ?? 0;
  }
  /** Index (0-based) of the video the current frame belongs to, or -1. */
  get currentVideoIndex() {
    const v = this.current?.video;
    return v ? this.labels?.videos?.indexOf(v) ?? -1 : -1;
  }
  get ready() {
    return this.status === "ready" && this.frames.length > 0;
  }
  // A plain .slp (no embedded frames) must have a video attached before the viewer
  // opens. A .pkg.slp carries its own frames and skips this gate.
  get needsVideo() {
    return this.status === "needs-video";
  }

  async loadSlpFile(file) {
    // Supersede any in-flight load and clear the old model immediately so a second
    // upload can't queue behind / race the first.
    const token = ++this.#loadToken;
    this.#beginLoad(file.name);

    try {
      // Uploaded File -> sleap-io.js routes this through its streaming Web Worker
      // (h5wasm pulled from jsDelivr).
      //
      // openVideos:true is required for .pkg.slp embedded frames (otherwise the
      // backend is null and getFrame yields nothing). For a plain .slp the referenced
      // external video can't be opened in the browser; if that throws we retry once
      // without videos (poses still load; the user attaches the video next).
      let labels;
      try {
        labels = await loadSlp(file, { openVideos: true, h5: { filenameHint: file.name } });
      } catch (openErr) {
        if (token !== this.#loadToken) return; // superseded mid-parse — drop it
        console.warn("[sleap-web] openVideos:true failed; retrying without videos:", openErr);
        labels = await loadSlp(file, { openVideos: false, h5: { filenameHint: file.name } });
      }
      if (token !== this.#loadToken) return; // a newer load won; discard this result

      placeUnplacedNodes(labels); // give predicted instances' un-placed keypoints an in-frame position to edit
      this.#imgCache.clear(); // a prior file's cached frames must not survive (keys could collide)
      this.labels = labels;
      this.hasEmbedded = (labels.videos ?? []).some((v) => v?.hasEmbeddedImages);

      // Navigable units = the labeled / sampled frames stored in the file (single pass
      // + one sort; avoids the spread/filter/map allocation chain on large files).
      const frames = [];
      for (const lf of labels.labeledFrames) {
        if (Number.isFinite(lf.frameIdx)) frames.push({ video: lf.video, frameIdx: lf.frameIdx, lf });
      }
      // Group by video (file order), then chronological within each. A multi-video .pkg.slp
      // otherwise interleaves videos by frameIdx (each embedded video has its own 0..N range),
      // scrambling navigation across videos.
      const vOrder = new Map((labels.videos ?? []).map((v, i) => [v, i]));
      frames.sort((a, b) => (vOrder.get(a.video) ?? 0) - (vOrder.get(b.video) ?? 0) || a.frameIdx - b.frameIdx);

      this.frames = frames;
      this.index = 0;
      this.rev++;

      const n = frames.length;
      if (this.hasEmbedded) {
        // .pkg.slp — frames are embedded, open the viewer immediately.
        this.status = "ready";
        this.message = `Loaded ${n} labeled frame${n === 1 ? "" : "s"}`;
      } else {
        // plain .slp — pixels live in an external video we don't have. Require it.
        this.status = "needs-video";
        this.message = `Loaded ${n} labeled frame${n === 1 ? "" : "s"} — add the matching video to continue`;
      }
    } catch (e) {
      if (token !== this.#loadToken) return; // error belongs to a superseded load
      console.error("[sleap-web] loadSlp failed:", e);
      this.error = String(e?.message ?? e);
      this.status = "error";
      this.message = "Failed to load file";
    }
  }

  async loadVideoFile(file) {
    // Share the load token: a new .slp upload (or another video) supersedes this.
    const token = ++this.#loadToken;
    this.videoLoading = true;
    this.videoName = file.name;
    this.error = null;
    try {
      const videoModel = await loadVideo(file, { openBackend: true });
      if (token !== this.#loadToken) {
        videoModel?.close?.(); // a newer load won; release this backend
        return;
      }
      this.videoModel = videoModel;
      // Attaching the video satisfies the plain-.slp gate -> open the viewer.
      if (this.status === "needs-video") this.status = "ready";
      this.rev++;
    } catch (e) {
      if (token !== this.#loadToken) return;
      console.error("[sleap-web] loadVideo failed:", e);
      this.videoModel = null;
      this.videoName = "";
      this.error = `Could not open video: ${String(e?.message ?? e)}`;
    } finally {
      if (token === this.#loadToken) this.videoLoading = false;
    }
  }

  // Reset visible state at the start of a new labels load.
  #beginLoad(name) {
    this.labels = null;
    this.videoModel = null;
    this.frames = [];
    this.frameImage = null;
    this.#imgWant = null;
    this.#imgHave = undefined;
    this.index = 0;
    this.status = "loading";
    this.message = `Reading ${name} …`;
    this.error = null;
    this.fileName = name;
    this.videoName = "";
    this.videoLoading = false;
    this.hasEmbedded = false;
    this.rev++;
  }

  setIndex(i) {
    const n = this.frames.length;
    if (n === 0) return;
    this.index = Math.max(0, Math.min(n - 1, i));
  }
  /** The active nav subset (sorted `frames` indices), or null = whole file. Override beats base. */
  get navFrames() {
    return this.navOverride ?? this.navBase;
  }
  setNavBase(list) {
    this.navBase = list?.length ? list : null;
  }
  setNavOverride(list) {
    this.navOverride = list?.length ? list : null;
  }
  next() {
    const list = this.navFrames;
    if (list) {
      const nx = list.find((i) => i > this.index); // next filtered frame after the current position
      if (nx != null) this.setIndex(nx);
      return;
    }
    this.setIndex(this.index + 1);
  }
  prev() {
    const list = this.navFrames;
    if (list) {
      for (let k = list.length - 1; k >= 0; k--) if (list[k] < this.index) { this.setIndex(list[k]); return; }
      return;
    }
    this.setIndex(this.index - 1);
  }

  reset() {
    this.#loadToken++; // discard any in-flight load
    this.labels = null;
    this.videoModel = null;
    this.frames = [];
    this.frameImage = null;
    this.#imgCache.clear();
    this.#imgWant = null;
    this.#imgHave = undefined;
    this.index = 0;
    this.status = "idle";
    this.message = "";
    this.error = null;
    this.fileName = "";
    this.videoName = "";
    this.videoLoading = false;
    this.hasEmbedded = false;
    this.rev++;
  }

  // Fetch a drawable image (ImageBitmap | ImageData) for a navigable frame, or null
  // if no pixels are available (plain .slp with no embedded frames and no uploaded
  // video). Decodes raw Uint8Array (embedded PNG/JPEG) into an ImageBitmap so the
  // draw path can stay synchronous.
  // Identity of the displayed frame: source (external video vs embedded) + video + frameIdx.
  // Changing the attached video re-keys every frame so the image refetches.
  #frameKey(item) {
    if (!item) return "none";
    const src = this.videoModel ? "ext" : "emb";
    // Identify the video by its index, not filename — embedded .pkg.slp videos all report "." so a
    // filename key collides across videos and paints a stale frame from the wrong video.
    const vi = this.labels?.videos?.indexOf(item.video) ?? -1;
    return `${src}:${vi}:${item.frameIdx}`;
  }

  /**
   * Request that `frameImage` reflect the current frame. Safe to call on every index change;
   * decodes are serialized and reconciled to the latest request, so the displayed image
   * always converges to `current` (no overlapping decodes → no permanent image/overlay
   * offset while scrubbing). Call from a reactive effect that reads index/videoModel.
   */
  syncFrameImage() {
    this.#imgWant = this.#frameKey(this.current);
    this.#pumpFrameImage();
  }

  async #pumpFrameImage() {
    if (this.#imgPumping) return;
    this.#imgPumping = true;
    try {
      // Decode toward the wanted frame, one at a time; if the user moves on mid-decode the
      // result is discarded and we fetch the new target instead.
      while (this.#imgWant !== this.#imgHave) {
        const want = this.#imgWant;
        const item = this.current; // the frame `want` refers to
        const img = await this.getFrameImage(item);
        if (this.#imgWant !== want) continue; // superseded during decode — refetch latest
        this.frameImage = img ?? null;
        this.#imgHave = want;
      }
    } finally {
      this.#imgPumping = false;
    }
    // A request that arrived as we were exiting gets picked up here.
    if (this.#imgWant !== this.#imgHave) this.#pumpFrameImage();
  }

  async getFrameImage(item, signal) {
    if (!item) return null;

    // Cache hit → return the decoded image immediately (skips the ~50-100 ms read+decode). Refresh
    // LRU recency by re-inserting so hot frames survive eviction.
    const key = this.#frameKey(item);
    const hit = this.#imgCache.get(key);
    if (hit) { this.#imgCache.delete(key); this.#imgCache.set(key, hit); return hit; }

    let drawable = null;
    // An externally-uploaded video takes precedence (the plain-.slp workflow).
    if (this.videoModel) {
      const img = await this.#tryGetFrame(this.videoModel, item.frameIdx, signal);
      if (img) drawable = await this.#toDrawable(img);
    }
    // Otherwise use the embedded HDF5 backend (.pkg.slp).
    if (!drawable) {
      const backend = item.video?.backend;
      if (backend && item.video?.hasEmbeddedImages) {
        const img = await this.#tryGetFrame(item.video, item.frameIdx, signal);
        if (img) drawable = await this.#toDrawable(img);
      }
    }
    if (drawable) this.#cachePut(key, drawable);
    return drawable;
  }

  #cachePut(key, img) {
    this.#imgCache.set(key, img);
    // Evict least-recently-used (Map preserves insertion order; oldest key is first).
    while (this.#imgCache.size > this.#imgCacheCap) {
      const oldest = this.#imgCache.keys().next().value;
      this.#imgCache.delete(oldest);
    }
  }

  async #tryGetFrame(videoLike, frameIdx, signal) {
    try {
      // Video.getFrame accepts an AbortSignal; backend.getFrame may not.
      if (typeof videoLike.getFrame === "function") {
        return await videoLike.getFrame(frameIdx, signal);
      }
      return await videoLike.backend.getFrame(frameIdx);
    } catch (e) {
      console.warn("[sleap-web] getFrame failed:", e);
      return null;
    }
  }

  async #toDrawable(img) {
    if (img == null) return null;
    if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) return img;
    // Convert ImageData to an ImageBitmap so it can be drawn under a canvas transform
    // (putImageData ignores transforms; drawImage respects them — needed for crisp zoom).
    if (typeof ImageData !== "undefined" && img instanceof ImageData) {
      return await createImageBitmap(img);
    }
    if (img instanceof Uint8Array || img instanceof ArrayBuffer) {
      const blob = new Blob([img]); // createImageBitmap auto-detects PNG/JPEG
      return await createImageBitmap(blob);
    }
    return img; // already drawable (e.g. HTMLCanvasElement)
  }
}

// Singleton, shared across components via plain ESM import.
export const store = new LabelsStore();
