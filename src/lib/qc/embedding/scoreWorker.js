// Scoring worker (see scoreRemote.js): kNN outlier scores + robust-z + 2-D PCA are O(N·R·D) —
// measured ~1.1s at 2700 crops and ~8.4s at 8000 — so they run here, off the UI thread. Pure math
// on plain data: the EXACT same outlier.js functions as the main-thread fallback, so results are
// identical either way. AnomalyDINO is heavier still (every crop's patch tokens against a memory
// bank), which is the whole reason it is not allowed near the UI thread.
import { knnOutlierScoresRef, robustZ, pca2 } from "./outlier.js";
import { anomalyDinoScores } from "./anomalyDino.js";

self.onmessage = (ev) => {
  const { id, embs, refIdx, k, scorer, patches, P, opts } = ev.data;
  try {
    const scores = scorer === "anomalyDino"
      ? anomalyDinoScores(patches, refIdx, P, opts ?? {})
      : knnOutlierScoresRef(embs, refIdx, k);
    const z = robustZ(scores);
    // The scatter stays a projection of the CLS embeddings whichever scorer ran: it is the map of
    // where these patches sit relative to each other, and re-projecting it per scorer would move
    // every point on screen for a reason that has nothing to do with what changed.
    const { coords } = pca2(embs);
    self.postMessage({ id, res: { scores: Array.from(scores), z, coords } });
  } catch (e) {
    self.postMessage({ id, error: e?.message ?? String(e) });
  }
};
