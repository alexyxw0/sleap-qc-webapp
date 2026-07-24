// Store-facing DINO backend: runs dino.js inside a dedicated module worker (embedWorker.js) so the
// model download, preprocessing, and WASM inference never block the UI thread — arrow-key frame
// traversal keeps working, and the store's next-frame decode overlaps inference. If the worker can't
// start (no Worker API, CSP), it degrades to running dino.js on the calling thread with a smaller
// batch so per-flush jank stays bounded.
import * as dino from "./dino.js";

export const MODEL = { ...dino.MODEL, batch: 8 }; // off the UI thread, big batches cost the UI nothing

let _worker = null;
let _direct = false; // main-thread fallback active
let _ready = null;
let _seq = 0;
const _pending = new Map(); // id -> { resolve, reject }

function failAll(message) {
  for (const p of _pending.values()) p.reject(new Error(message));
  _pending.clear();
}

export async function ensureModel(onProgress) {
  if (!_ready) {
    _ready = (async () => {
      if (typeof Worker !== "undefined") {
        try {
          const info = await new Promise((resolve, reject) => {
            const w = new Worker(new URL("./embedWorker.js", import.meta.url), { type: "module" });
            w.onerror = (e) => reject(new Error(e.message || "embed worker failed to start"));
            w.onmessage = (ev) => {
              const m = ev.data;
              if (m.type === "progress") onProgress?.(m.p);
              else if (m.type === "ready") resolve(m.info);
              else if (m.type === "error") reject(new Error(m.message));
            };
            w.postMessage({ type: "init" });
            _worker = w;
          });
          Object.assign(MODEL, info, { batch: 8, backend: `${info.backend} · worker` });
          _worker.onmessage = (ev) => {
            const m = ev.data;
            const p = _pending.get(m.id);
            if (!p) return;
            _pending.delete(m.id);
            if (m.type === "embs") p.resolve(m.embs);
            else p.reject(new Error(m.message ?? "embedding failed"));
          };
          _worker.onerror = (e) => failAll(e.message || "embed worker crashed");
          return;
        } catch (e) {
          console.warn("[dino] worker path unavailable — embedding on the main thread:", e?.message ?? e);
          try { _worker?.terminate(); } catch { /* already dead */ }
          _worker = null;
        }
      }
      const info = await dino.ensureModel(onProgress);
      _direct = true;
      Object.assign(MODEL, info, { batch: dino.MODEL.batch, backend: `${info.backend} · main thread` });
    })().catch((e) => { _ready = null; throw e; });
  }
  await _ready;
  return MODEL;
}

export function isLoaded() {
  return _direct ? dino.isLoaded() : !!MODEL.backend;
}

/** Embed RGBA crops ({ data, width, height }) → Float32Array vectors. Crop buffers are TRANSFERRED
 *  to the worker (zero-copy) — callers must treat the passed images as consumed. */
export async function embedBatch(images) {
  if (_direct) return dino.embedBatchImages(images);
  if (!_worker) throw new Error("call ensureModel() first");
  const id = ++_seq;
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    _worker.postMessage({ type: "embed", id, images }, images.map((im) => im.data.buffer));
  });
}
