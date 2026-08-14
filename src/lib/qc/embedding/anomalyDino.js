// AnomalyDINO — patch-level unsupervised anomaly detection on DINOv2 features.
// Damm et al., "AnomalyDINO: Boosting Patch-based Few-Shot Anomaly Detection with DINOv2", WACV 2025.
//
// WHY IT IS HERE, next to the kNN scorer rather than instead of it. The existing unsupervised route
// scores the CLS token: one vector for the whole crop, compared to the k most similar crops of the
// same keypoint. That asks "does this patch look like a nose?" — and a nose keypoint dropped two
// pixels off the nostril still looks almost entirely like a nose, because most of the crop is
// unchanged. The CLS token averages the wrong part away. Which is exactly the regime this method was
// built for: keep the PATCH tokens, and let a small wrong region speak for itself.
//
// The method, and what this file does with it:
//
//   memory bank   Every patch token of a reference set of "normal" samples. The paper's setting is
//                 few-shot (k=1..16 known-good images); ours is a whole file with no labels at all,
//                 so the reference is the same per-video stratified subsample the kNN path uses —
//                 most patches in a proofread-pending file are correct, and stratifying keeps a
//                 slow-moving animal's own neighbouring frames from becoming its own yardstick.
//
//   distance      For each test patch token, the cosine distance to its NEAREST bank token. A patch
//                 that resembles anything normal scores ~0 whatever it resembles; only a patch with
//                 no normal counterpart anywhere scores high. (PatchCore's nearest-neighbour step.)
//
//   aggregation   The mean of the top-q fraction of those distances — the paper's contribution over
//                 PatchCore's max. Max is one token and therefore one token's noise; the mean over
//                 all of them drowns a genuine local fault in a sea of correct background.
//
// Deliberate departures, all forced by running in a browser on ~58,000 crops rather than on MVTec:
//
//   - Tokens are the compacted descriptors from patchTokens.js (pooled 16×16 -> 4×4, projected to
//     64-d, int8), not raw 384-d tokens. See that file for the arithmetic; without it the token
//     store alone would be 23 GB.
//   - q defaults to 0.25, not the paper's 0.01. q is a FRACTION OF TOKENS, and pooling leaves 16 of
//     them: 1% of 16 rounds to one token, which is exactly the max-aggregation the paper argues
//     against. A quarter of 16 is four — the same "a few worst regions, not one, not all" shape the
//     paper's 1% of 256+ has.
//   - No foreground masking. The paper masks background patches (PCA on the reference tokens) so a
//     plain backdrop cannot dilute the score. Here the background IS diagnostic: a keypoint dragged
//     off the animal is one of the faults we most want to catch, and masking is what would hide it.
//   - The bank is an evenly-spaced subsample rather than a greedy k-center coreset. Coreset selection
//     is O(budget × candidates) — a minute of its own on this data — for a bank that is already an
//     arbitrary subsample of an unlabelled file.

import { unpackPatchTokens } from "./patchTokens.js";

/**
 * Can AnomalyDINO actually run over this group, or must it fall back to kNN?
 *
 * BOTH sides have to carry patch tokens, and the reference side is the one that is easy to get wrong.
 * The bank is built from the REFERENCE descriptors only, so a reference whose entries all predate patch
 * features yields an empty bank — and an empty bank puts every distance at 0, i.e. every crop perfectly
 * clean. That is indistinguishable from a flawless file, which is the worst answer a QC check can give.
 *
 * Shared by both embedding stores rather than written twice: it is the same rule about the same data,
 * and the whole-instance copy of it was un-testable in place (with a small fixture the reference IS the
 * whole set, so the two halves of the condition collapse into one).
 */
export function canScorePatches(descriptors, refIndices) {
  if (!descriptors?.length || !refIndices?.length) return false;
  // The reference alone answers it. Both stores also tested `descriptors.some(...)`, which cannot fail
  // while this holds — refIndices index INTO descriptors, so a reference entry with tokens is a
  // descriptor with tokens. No test could tell the two versions apart, so the second one is gone.
  return refIndices.some((i) => descriptors[i]?.length > 0);
}

export const ANOMALY_DINO = {
  q: 0.25, // fraction of a crop's patch tokens averaged into its score (see the note above)
  bankTokens: 2048, // memory-bank budget per scored group
};

/**
 * Memory bank of "normal" patch tokens: every token of the reference descriptors, evenly subsampled
 * to `budget`.
 *
 * `owner[t]` is the descriptor index token t came from, so a reference sample can be excluded when
 * scoring ITSELF. Without that, every reference crop finds its own tokens at distance 0 and scores a
 * perfect 0 — and since the reference is a fifth of the set, that drags the median the robust-z is
 * measured against and quietly deflates everyone else's z.
 */
export function buildMemoryBank(descriptors, refIndices, P, budget = ANOMALY_DINO.bankTokens) {
  const usable = refIndices.filter((i) => descriptors[i]?.length >= P);
  if (!usable.length) return null;
  const perDesc = usable.map((i) => descriptors[i].length / P);
  const totalTokens = perDesc.reduce((a, b) => a + b, 0);
  const take = Math.min(totalTokens, Math.max(1, budget | 0));

  const data = new Float32Array(take * P);
  const owner = new Int32Array(take);
  let written = 0;
  // Allocate the budget ACROSS crops and then spread within each one, rather than striding over the
  // concatenated token stream. A single global stride can land near a multiple of the tokens-per-crop
  // and then bank the same two grid positions from every crop — a bank that has never seen the
  // bottom-left of anything, which calls every bottom-left an anomaly. The integer split below sums
  // to exactly `take`, and the `+u` rotation moves which positions each crop contributes.
  for (let u = 0; u < usable.length && written < take; u++) {
    const di = usable[u];
    const T = perDesc[u];
    const k = Math.min(T, Math.floor(((u + 1) * take) / usable.length) - Math.floor((u * take) / usable.length));
    if (k <= 0) continue;
    const toks = unpackPatchTokens(descriptors[di], P);
    for (let j = 0; j < k && written < take; j++) {
      const t = (Math.floor((j * T) / k) + u) % T;
      data.set(toks.subarray(t * P, t * P + P), written * P);
      owner[written] = di;
      written++;
    }
  }
  return { data: data.subarray(0, written * P), owner: owner.subarray(0, written), n: written, P };
}

/**
 * Nearest-bank cosine distance for each of one descriptor's patch tokens.
 *
 * Tokens on both sides are unit vectors, so cosine distance is 1 − dot and the whole thing is one
 * dense matrix product. `skipOwner` excludes the bank tokens contributed by this same descriptor.
 */
export function patchDistances(desc, bank, skipOwner = -1) {
  const { data, owner, n, P } = bank;
  const toks = unpackPatchTokens(desc, P);
  const T = toks.length / P;
  const out = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    const off = t * P;
    let best = -Infinity;
    for (let b = 0; b < n; b++) {
      if (owner[b] === skipOwner) continue;
      const bo = b * P;
      let dot = 0;
      for (let p = 0; p < P; p++) dot += toks[off + p] * data[bo + p];
      if (dot > best) best = dot;
    }
    out[t] = best === -Infinity ? 0 : 1 - best;
  }
  return out;
}

/** Mean of the top-q fraction of patch distances — at least one token, at most all of them. */
export function aggregate(dists, q = ANOMALY_DINO.q) {
  const n = dists.length;
  if (!n) return 0;
  const take = Math.min(n, Math.max(1, Math.ceil(q * n)));
  const sorted = Array.from(dists).sort((a, b) => b - a);
  let s = 0;
  for (let i = 0; i < take; i++) s += sorted[i];
  return s / take;
}

/**
 * Score every descriptor against a bank built from `refIndices`.
 *
 * Descriptors that have no patch features (an older cache entry, a crop that failed) score 0 — the
 * bottom of the scale, i.e. "nothing is known against this one", never a flag. The caller is expected
 * to have told the user how many of those there are rather than let them pass as clean; see
 * `patchCoverage` in the node store.
 */
export function anomalyDinoScores(descriptors, refIndices, P, opts = {}) {
  const q = opts.q ?? ANOMALY_DINO.q;
  const N = descriptors.length;
  const out = new Float64Array(N);
  const bank = buildMemoryBank(descriptors, refIndices, P, opts.bankTokens ?? ANOMALY_DINO.bankTokens);
  if (!bank || bank.n < 2) return out;
  for (let i = 0; i < N; i++) {
    const d = descriptors[i];
    if (!d?.length) continue;
    out[i] = aggregate(patchDistances(d, bank, i), q);
  }
  return out;
}
