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

class LabelsStore {
  // Monotonic load generation. Every new load() bumps this; an in-flight load whose
  // token is no longer current discards its result instead of clobbering the newer
  // one. (The underlying sleap-io.js worker can't be aborted, so it runs to
  // completion in the background, but its stale result is ignored.)
  #loadToken = 0;

  // --- model (non-reactive contents; reassigned wholesale on load) ---
  labels = $state.raw(null);
  videoModel = $state.raw(null); // optional externally-uploaded video backend
  frames = $state.raw([]); // navigable list: [{ video, frameIdx, lf }]

  // --- reactive scalars ---
  rev = $state(0); // bump to signal model mutated -> redraw
  index = $state(0); // position within `frames`
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

      this.labels = labels;
      this.hasEmbedded = (labels.videos ?? []).some((v) => v?.hasEmbeddedImages);

      // Navigable units = the labeled / sampled frames stored in the file (single pass
      // + one sort; avoids the spread/filter/map allocation chain on large files).
      const frames = [];
      for (const lf of labels.labeledFrames) {
        if (Number.isFinite(lf.frameIdx)) frames.push({ video: lf.video, frameIdx: lf.frameIdx, lf });
      }
      frames.sort((a, b) => a.frameIdx - b.frameIdx);

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
  next() {
    this.setIndex(this.index + 1);
  }
  prev() {
    this.setIndex(this.index - 1);
  }

  reset() {
    this.#loadToken++; // discard any in-flight load
    this.labels = null;
    this.videoModel = null;
    this.frames = [];
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
  async getFrameImage(item, signal) {
    if (!item) return null;

    // An externally-uploaded video takes precedence (the plain-.slp workflow).
    if (this.videoModel) {
      const img = await this.#tryGetFrame(this.videoModel, item.frameIdx, signal);
      if (img) return this.#toDrawable(img);
    }

    // Otherwise use the embedded HDF5 backend (.pkg.slp).
    const backend = item.video?.backend;
    if (backend && item.video?.hasEmbeddedImages) {
      const img = await this.#tryGetFrame(item.video, item.frameIdx, signal);
      if (img) return this.#toDrawable(img);
    }
    return null;
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
