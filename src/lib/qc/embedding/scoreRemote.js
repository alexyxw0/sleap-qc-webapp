// Off-thread outlier scoring: the kNN + robust-z + PCA pass is O(N·R·D) (~1.1s at 2700 crops,
// ~8.4s at 8000 — and R grows with N, so it scales quadratically) and used to freeze the whole UI
// at "Scoring…". Ship the vectors to a dedicated worker instead; fall back to the same functions
// on the calling thread when workers aren't available (vitest/node) or the worker dies. The
// postMessage clone of the vectors (~4 MB at 2700 crops) costs a few ms — noise next to the pass
// itself. One request at a time (the store awaits each run).
import { knnOutlierScoresRef, robustZ, pca2 } from "./outlier.js";
import { anomalyDinoScores } from "./anomalyDino.js";

let _worker = null;
let _seq = 0;
const _pending = new Map();

function ensureWorker() {
  if (_worker || typeof Worker === "undefined") return _worker;
  try {
    _worker = new Worker(new URL("./scoreWorker.js", import.meta.url), { type: "module" });
    _worker.onmessage = (ev) => {
      const p = _pending.get(ev.data.id);
      if (!p) return;
      _pending.delete(ev.data.id);
      ev.data.error ? p.reject(new Error(ev.data.error)) : p.resolve(ev.data.res);
    };
    _worker.onerror = () => {
      for (const p of _pending.values()) p.reject(new Error("score worker crashed"));
      _pending.clear();
      try { _worker.terminate(); } catch { /* already dead */ }
      _worker = null; // next call re-tries once, else falls back to the main thread
    };
  } catch {
    _worker = null;
  }
  return _worker;
}

function scoreSync(msg) {
  const { embs, refIdx, k, scorer, patches, P, opts } = msg;
  const scores = scorer === "anomalyDino"
    ? anomalyDinoScores(patches, refIdx, P, opts ?? {})
    : knnOutlierScoresRef(embs, refIdx, k);
  return { scores: Array.from(scores), z: robustZ(scores), coords: pca2(embs).coords };
}

/**
 * Score embeddings without blocking the UI thread — mean-kNN outlier by default, AnomalyDINO when
 * `extra.scorer` says so. Both return the SAME shape (raw scores, robust-z, 2-D PCA coords) and both
 * put z on the same robust-z scale, because everything downstream — the threshold slider, frameZByKey,
 * the QC union, the per-node counts — is written against that scale and would silently never flag if
 * a scorer handed back its own units.
 *
 * `extra` for AnomalyDINO: { scorer:"anomalyDino", patches: Int8Array[], P, opts:{ q, bankTokens } }.
 * The PCA coords still come from `embs`, so the graph is the same map whichever scorer ran.
 */
export async function scoreEmbeddings(embs, refIdx, k, extra = null) {
  const msg = { embs, refIdx, k, ...(extra ?? {}) };
  const w = ensureWorker();
  if (!w) return scoreSync(msg);
  const id = ++_seq;
  try {
    return await new Promise((resolve, reject) => {
      _pending.set(id, { resolve, reject });
      w.postMessage({ id, ...msg });
    });
  } catch {
    return scoreSync(msg); // worker died mid-request — degrade, don't fail the run
  }
}
