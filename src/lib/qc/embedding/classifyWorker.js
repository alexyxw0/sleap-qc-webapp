// Classify worker (see appearanceClf.js): the RBF-SVM decision over N instances is O(N·nSv·dim)
// (~7e9 mults at 7k instances) — same cost class as the kNN scorer, so it runs off the UI thread here.
// Pure math via svm.js, identical to the main-thread fallback.
import { rbfDecision } from "./svm.js";

self.onmessage = (ev) => {
  const { id, embs, clf } = ev.data;
  try {
    self.postMessage({ id, res: Array.from(rbfDecision(embs, clf)) });
  } catch (e) {
    self.postMessage({ id, error: e?.message ?? String(e) });
  }
};
