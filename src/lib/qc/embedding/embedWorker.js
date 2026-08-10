// DINO inference worker (see dinoRemote.js): model download, preprocessing, and the WASM forward
// pass all happen here, so the UI thread never blocks on a ~4.5-GFLOP inference — and the store can
// decode the next video frame while this one embeds. Same-origin module worker: it inherits the
// page's cross-origin isolation, so ORT's nested pthread pool works whenever COOP/COEP are set
// (vite.config.js). Crop buffers arrive transferred (zero-copy) and vectors return the same way.
import * as dino from "./dino.js";

self.onmessage = async (ev) => {
  const { type, id, images, patchCfg } = ev.data;
  try {
    if (type === "init") {
      const info = await dino.ensureModel((p) => {
        // transformers.js progress events carry functions on some paths — forward only plain fields
        if (p) self.postMessage({ type: "progress", p: { status: p.status, progress: p.progress, file: p.file } });
      });
      self.postMessage({ type: "ready", info: { ...info } });
    } else if (type === "embed") {
      const { embs, patches } = await dino.embedBatchImages(images, patchCfg ?? undefined);
      // Transfer both: at batch 8 that is ~12 KB of vectors and ~8 KB of descriptors per message, and
      // a structured clone of either would be pure copying on the hot path.
      const xfer = embs.map((v) => v.buffer);
      for (const p of patches ?? []) if (p) xfer.push(p.buffer);
      self.postMessage({ type: "embs", id, embs, patches }, xfer);
    }
  } catch (e) {
    self.postMessage({ type: "error", id, message: e?.message ?? String(e) });
  }
};
