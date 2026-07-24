// Scoring worker (see scoreRemote.js): kNN outlier scores + robust-z + 2-D PCA are O(N·R·D) —
// measured ~1.1s at 2700 crops and ~8.4s at 8000 — so they run here, off the UI thread. Pure math
// on plain data: the EXACT same outlier.js functions as the main-thread fallback, so results are
// identical either way.
import { knnOutlierScoresRef, robustZ, pca2 } from "./outlier.js";

self.onmessage = (ev) => {
  const { id, embs, refIdx, k } = ev.data;
  try {
    const scores = knnOutlierScoresRef(embs, refIdx, k);
    const z = robustZ(scores);
    const { coords } = pca2(embs);
    self.postMessage({ id, res: { scores: Array.from(scores), z, coords } });
  } catch (e) {
    self.postMessage({ id, error: e?.message ?? String(e) });
  }
};
