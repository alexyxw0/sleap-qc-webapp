// Trained appearance-fault classifier — the RBF-SVM ported from the dino_probe (see svm.js). It scores
// each instance's DINO ViT-S embedding (the SAME vectors the dino backend produces) with the model
// learned on the proofread faulty/clean labels. Unlike the unsupervised kNN-outlier (≈chance on these
// faults), this reaches CV ROC ~0.82 — but it's DINO-specific (384-d ViT-S), so it only applies to the
// dino backend. Loads the ~4 MB weights lazily (once) as an asset; scores off-thread in classifyWorker.
import clfMeta from "./appearance_clf.json";
import clfBinUrl from "./appearance_clf.bin?url";
import { parseClassifier, rbfDecision } from "./svm.js";

let _clf = null;
let _loading = null;
let _worker = null;
let _seq = 0;
const _pending = new Map();

/** Static header (dim, gamma, intercept, threshold, cv metrics, provenance) — available without loading weights. */
export function classifierInfo() {
  return clfMeta;
}

/** Load + parse the weights once (memoized). */
export async function ensureClassifier() {
  if (_clf) return _clf;
  if (!_loading) {
    _loading = fetch(clfBinUrl)
      .then((r) => r.arrayBuffer())
      .then((buf) => { _clf = parseClassifier(clfMeta, buf); return _clf; });
  }
  return _loading;
}

function ensureWorker() {
  if (_worker || typeof Worker === "undefined") return _worker;
  try {
    _worker = new Worker(new URL("./classifyWorker.js", import.meta.url), { type: "module" });
    _worker.onmessage = (ev) => {
      const p = _pending.get(ev.data.id);
      if (!p) return;
      _pending.delete(ev.data.id);
      ev.data.error ? p.reject(new Error(ev.data.error)) : p.resolve(ev.data.res);
    };
    _worker.onerror = () => {
      for (const p of _pending.values()) p.reject(new Error("classify worker crashed"));
      _pending.clear();
      try { _worker.terminate(); } catch { /* already dead */ }
      _worker = null;
    };
  } catch {
    _worker = null;
  }
  return _worker;
}

/** Per-instance SVM decision values (>= classifierInfo().threshold ⇒ faulty). Off-thread via the worker;
 *  falls back to the main thread when workers are unavailable (vitest/node) or the worker dies. */
export async function classifyDecisions(embs) {
  const clf = await ensureClassifier();
  const w = ensureWorker();
  if (!w) return rbfDecision(embs, clf);
  const id = ++_seq;
  try {
    return await new Promise((resolve, reject) => { _pending.set(id, { resolve, reject }); w.postMessage({ id, embs, clf }); });
  } catch {
    return rbfDecision(embs, clf); // worker died mid-request — degrade, don't fail the run
  }
}
