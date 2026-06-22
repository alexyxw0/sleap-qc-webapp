# SLEAP-QC detection checks

Low-level developer reference for the per-instance and per-frame quality-control engine. Audience: engineers working on the QC engine.

**Source roots.** Two distinct locations — do not assume one tree:
- **Engine units, detectors, features:** `src/lib/qc/checks/` (`detector.js`, `gmm.js`, `frameLevel.js`, `config.js`, `util.js`, `explain.js`, and `features/`).
- **Store / orchestration:** `src/lib/qcStore.svelte.js` (one level **up**, not under `qc/`).

All `checks/…` citations below are relative to `src/lib/qc/`; `qcStore.svelte.js` citations are relative to `src/lib/`.

## Architecture

**Unit model.** Each detection technique is a pure `computeXUnit(ctx)` function in `checks/detector.js` (`computeAnomalyUnit`, `computeGmmUnit`, `computeFrameUnit`, `computeChiralityUnit`). Pose-split is **not** a unit — `pose_split_score` is a feature in the anomaly/GMM vector (see "The feature vector"), matching the desktop GUI. A unit takes the shared `ctx` (built once by `buildContext`, carrying `frames`, `allPoses`, `analyzer`, `frameCounts`, `videoIds`, `config`, `labels`, fitted features) and returns `Map`s keyed by `` `${videoIdx}:${frameIdx}:${instIdx}` `` for instance-level results, or `` `${videoIdx}:${frameIdx}` `` for frame-level results.

**Memoization.** `qcStore.svelte.js` maps each user-facing check to a unit via `UNIT_OF` (`count`/`negative`/`duplicates` all share the `frame` unit). Results live in `#computed[unit]`; re-selecting a previously-computed technique never recomputes. `#ctx` is rebuilt only when the underlying labels change (`#ctxLabels` identity check), via `buildContext(store.labels, makeQCConfig({ useGmm: false }))` (see GMM Notes for why the `useGmm:false` override is inert for the unit path). After the first run, toggling a new check auto-reruns (an `$effect` in `App.svelte` gated on `status === "done"`), computing only the newly-needed unit.

**Score + threshold convention.** Instance scorers (anomaly, gmm, chirality) emit a score in `[0,1]`; an instance is flagged when `score >= threshold`. Frame checks emit booleans. Per-instance scores roll up to a frame via **max** aggregation.

**UNION flagging.** `flaggedFrameCount` / the flagged set is the UNION of all *enabled-and-computed* checks: anomaly (`>= threshold`), gmm (`>= gmmThreshold`), chirality (`>= chiralityThreshold`), plus boolean frame checks `count`/`negative`/`duplicates`. Pose-split has no row of its own — it raises the anomaly/GMM score via its feature. Disabling a check removes its contribution from the union without recomputation.

**Default toggle state (as shipped).** `checks = { anomaly:true, gmm:false, chirality:true, count:true, negative:true, duplicates:true }`. GMM defaults **OFF** (opt-in/heaviest); chirality defaults ON but self-disables without symmetric pairs; the others default ON.

**Two population-stat implementations.** Z-scores and GMM scaling are both *population* (`/N`, ddof=0) but live in **two independent code paths**: `util.js` (`mean`/`safeStd`, floor `1e-6`) for ZScore and the 19-feature stats; `gmm.js` `standardScalerFit` (zero-variance scale→1). Do not assume a single shared helper.

---

## Anomaly (ZScore)

**Flags:** instance whose worst single-feature deviation across the 19-dim vector is extreme — `sigmoid(maxZ − 3.0) >= threshold(0.7)`, i.e. effective cutoff `maxZ >= ~3.85`.

**Algorithm:** `ZScoreDetector` (`checks/detector.js`). `fit(matrix)` keeps only NaN-free rows (`valid`); per feature `j` computes `means[j] = mean(col j)` and `stds[j] = max(std(col j), 1e-6)` using **population** mean/std (`/N`, `util.js`). `scoreOne(vector)`: returns `NaN` if any element is NaN, else `maxZ = max_j |(vector[j] − means[j]) / stds[j]|` over all 19 features, returning `sigmoid(maxZ − 3.0) = 1/(1+exp(−(maxZ−3.0)))`. So `z==3 → 0.5`. `computeAnomalyUnit` fits on `fx.rawMatrix` and scores each instance on its `fx.cleanMatrix` row (NaN→0, +Inf→10, −Inf→−10); reported `contributions` are `fx.rawMatrix[row][j] ?? 0`.

**Threshold/params:** `ZScoreDetector.threshold = 3.0` (hardcoded); flag threshold `0.7` (`config.instanceThreshold`, `qcStore.threshold`); std floor `1e-6`.

**Notes:** The score is a *smooth sigmoid*, not a hard z-cut — solving `sigmoid(maxZ−3) >= 0.7` gives `maxZ >= 3 + ln(7/3) ≈ 3.847`. Scoring uses the cleaned (sanitized) row but contributions show raw values, so a NaN/Inf feature is silently absorbed into the score yet surfaced raw. The `?? 0` coalesce on contributions only catches `null`/`undefined` (a *missing* slot shows `0`); a genuine `NaN` raw feature passes through and is **displayed as `NaN`**. Fit drops NaN rows entirely, but those instances are still *scored* on their zero-filled clean row.

**Node attribution.** The score is instance-level, but for a flagged instance the verdict names *which* node when its dominant feature (`topIssue`) is **node-localizable**. `BaselineFeatureExtractor.attribute(pose)` returns the culprit node(s) — the argmax/argmin that `extract()`'s reductions discard — for `max_edge_zscore` (both endpoints), `max_angle_zscore` (the joint), `max_pairwise_zscore` (the pair), `max_centroid_distance` (the "isolated" node), `min_symmetry_consistency` (the worst pair), and `has_isolated_invisible` (the invisible node whose neighbors are all visible). `visibility_pattern_score` is localized separately by `VisibilityModel.worstNode` — the most-blamed node in the co-visibility matrix (a peer that is expected-co-visible `P>0.9` yet absent, or rarely-co-visible `P<0.1` yet present). `qcStore.#anomalyAttribution` (lazy, cached; uses the `fx` returned by `computeAnomalyUnit`) resolves `topIssue`'s feature to `{ node, dir, feature }` — node via the baseline extractor (or the visibility model for `visibility_pattern_score`); `anomalyWorstNode` exposes the node and feeds `faultyNodeFor` → the red ring + sidebar name + zoom. Whole-instance features (`mean_*`, `nn`, `visibility_rate`) are intentionally **not** localized → no node, generic verdict. A named *invisible* node that is **unplaced** (no coordinates) cannot be ringed/zoomed — zoom falls back to the instance box. A **placed-but-hidden** node (real `xy`, `visible:false`) *is* still ringed and zoomable: QC NaNs it via `numpy({invisibleAsNaN:true})` for scoring, but the canvas draws from its real coordinates.

**Direction (increased / decreased).** The deviation features are z-scores, so for the `DIRECTIONAL_FEATURES` (`max_edge_zscore`, `max_angle_zscore`, `max_pairwise_zscore`, `bbox_area_zscore`, `hull_area_zscore`) `instanceIssue` appends `withDirection` → e.g. **"Unusual edge length (increased)"** / **"(decreased)"** (larger / smaller than the learned mean). The sign for the `max_*` features comes from `attribute`'s `dir` (their `contributions` value is `|z|`, sign-stripped); the area features are signed directly in `contributions`. Non-z features (`max_centroid_distance`, `min_symmetry_consistency`, `has_isolated_invisible`, `visibility_pattern_score`) carry no direction. Note `topIssue` ranks by raw signed value, so a *decreased* area z (negative contribution) rarely wins the top issue — area direction is in practice "(increased)".

---

## GMM (probability)

**Flags:** instance whose pose is among the rarest under a fitted Gaussian mixture — score `= 1 − empirical-CDF(logLikelihood) >= gmmThreshold(0.95)`, i.e. roughly the bottom 5% by likelihood.

**Algorithm:** `GMMDetector` (`checks/gmm.js`) wrapping `GaussianMixture`. `fit(matrix)`: `valid` = NaN-free rows (throws if `< 2`); component count `nComp = max(1, min(nComponents=5, floor(valid.length/10)))` — K grows by 1 per 10 instances, capped at 5 (so **50–499 instances yield fewer than 5 components**; only `>=50` reaches 5). Fits a `StandardScaler` (population var ddof=0, zero-variance scale→1), scales, then EM: k-means++ init (mulberry32 seed=42) → iterate `maxIter=100`: per-component Cholesky of full DxD covariance, `logGaussian = −0.5·(D·log2π + logDet + ||L⁻¹(x−μ)||²)`, responsibilities via softmax, M-step with `regCovar=1e-6` on the diagonal, stop when `|Δll| < tol=1e-3`. Training log-likelihoods are cached as `trainLL`. `scoreOne(vector)`: `NaN` if any NaN, else `ll = logLikelihoodOne(vector)`; `below = count(trainLL < ll)`; returns `1 − below/N`. Higher `ll` (more normal) → lower score; rarest poses → near 1.

**Threshold/params:** `nComponents=5` (`config.gmmNComponents`), `gmmMinSamples=50` (gating, see Notes), `gmmPercentileThreshold=5.0` (stored, *unused* by `scoreOne`), `regCovar=1e-6`, `maxIter=100`, `tol=1e-3`, seed `42`; flag threshold `gmmThreshold=0.95`.

**Notes:**
- `scoreOne` returns the *full* `1 − CDF` in `[0,1]` (strict-less-than count / N); the 5%/0.95 cut is applied **downstream** by `gmmThreshold`, not inside the detector. Score direction is **inverted** vs likelihood. EM is not bit-identical to sklearn (different RNG/init); only `scoreSamples` math is sklearn-exact.
- **The live app path is driven solely by `checks.gmm` + `computeGmmUnit`.** `computeGmmUnit` reads `ctx.config.gmmNComponents`/`gmmPercentileThreshold` and tries to fit unconditionally; it ignores both `gmmMinSamples` *and* `useGmm`, and leaves the unit empty (`det=null`) only if `fit()` throws (`valid < 2`).
- `gmmMinSamples (50)` **and** `config.useGmm` together gate **only** the legacy `LabelQCDetector.fit` path (`if (instances.length >= gmmMinSamples && useGmm)`), which `fitAndScoreLabels` drives. The store builds its context with `makeQCConfig({ useGmm:false })`, so even that legacy path would never pick GMM under the store's config — but that override is moot because the unit path never consults `useGmm`.
- **Leave-one-node-out attribution** lives in `qcStore.svelte.js` (`gmmWorstNode`, not in `gmm.js`): for a flagged instance it masks each visible node `k` to `[NaN,NaN]`, re-extracts features (reusing a single `baseNN` since NN distance is not node-specific), and the "worst node" is the one whose **removal most raises** log-likelihood (`improve = ll_masked − baseLL > 1e-6`; `−1` if none helps). It is reached via `faultyNodeFor` only when none of chirality, pose-split, or the anomaly attribution claims the node.

---

## L/R flip (chirality)

**Flags:** a whole-instance left/right mirror flip — symmetric pairs (Ear_L/Ear_R, …) sitting on the wrong side of the body midline. A reflection preserves every length and unsigned angle, so a flip is **invisible to the geometric feature vector**; chirality is the dedicated *signed* test. Headline detector of the `sleap/qc` update; **default ON** (self-disables without symmetric pairs).

**Algorithm:** `ChiralityModel` (`checks/features/chirality.js`). **Inputs** (`resolveChiralityInputs`): symmetric index pairs from `analyzer.symmetryPairs`, else name-inferred (`inferSymmetryPairsByName` — shared-stem L/R: suffix `Ear_L`/`Ear_R`, prefix `left_eye`/`right_eye`; `left`/`right` tried before `l`/`r`, suffix before prefix, first match wins); plus a midline = the non-symmetric "spine" nodes ordered nose→tail by mean PCA projection (`orderMidlineByPca`). **fit** (over `ctx.allPoses`): resolve the midline polyline (ordered visible midline nodes → 2 axis anchors → PCA single-segment fallback); for each co-visible pair, `signedSideLocal = sign(cross(local-tangent, left − foot))` where `foot` is the pair *midpoint* projected onto the nearest midline segment — the **local-tangent** construction that stops a *curled* but correct animal reading as flipped; canonical side = `sign(mean side)` (ties → +1). **score** (`scoreInstance`): `wrongFraction = nWrong / nPairs` over co-visible learned pairs; `< 2` scorable pairs → 0 (safety floor). **No SVD in JS:** the PCA axis is the largest-eigenvalue eigenvector of the 2×2 covariance (same direction up to sign; sign is irrelevant since fit and score share the axis).

**Hard rule + threshold:** `wrongFraction >= 0.5` forces the emitted score to `>= 0.9` (`computeChiralityUnit`); flag at `chiralityThreshold = 0.5`. The verdict — **"Whole-instance L/R flip"** — has **top precedence** in `instanceIssue` and `faultyNodeFor` (a flip is the dominant, most-actionable error, so it preempts the anomaly/gmm chain).

**Notes:** coordinate-only own-check; translation/rotation/scale-invariant. Requires both pair members visible at fit and score; on-axis pairs (cross == 0) contribute nothing; never emits NaN. The legacy `min_symmetry_consistency` baseline feature → "Likely L/R swap" is the *weak* geometric signal; chirality is the strong standalone verdict that overrides it.

---

## Split pose (chimera) — a feature, not a standalone check

**What it catches:** one labeled instance that actually spans **two animals** (head of A + abdomen of B), joined by a single over-stretched bridging edge. Unlike chirality, it has **no standalone check / threshold** — `pose_split_score` is feature #19 of the anomaly/GMM vector (mirroring the desktop GUI, where pose-split is a GMM feature with no hard rule). A chimera is flagged only when it lifts the combined anomaly/GMM score past that detector's threshold, and surfaces as the verdict **"Split pose / chimera"** via `topIssue` when `pose_split_score` is the dominant contribution. No dedicated node attribution (whole-instance).

**Algorithm:** `computePoseSplit` (`checks/features/poseSplit.js`), called from `extractFeatures`. On the *visible* subgraph: (1) find the edge with the largest length **z-score** `(len − mean) / std` from the learned baseline edge stats — the "bridge"; (2) cut it and require **exactly two** components (a clean bridge — partial occlusion yields >2, a cycle-redundant edge yields 1; both → score 0); (3) `split_score = bridge_z × balance(split_ratio) × gap_term(gap_ratio)`, a **gated product** so all three must be high. `balance` ramps 0→1 across `split_ratio ∈ [0.18, 0.30]`; `gap_term = max(gap_ratio − 1.5, 0)` with `gap_ratio = ‖centroidA − centroidB‖ / max(spreadA, spreadB)`. Star / short / adjacency-less skeletons use a **2-means bimodality fallback**. The unbounded `split_score` is **log1p-compressed** (`Math.log1p`, matching the desktop) before entering the vector; `0` for a normal pose. Uses the extractor's own `baseline.stats.edgeMeans`/`edgeStds` + precomputed `_adjacency`.

**Notes:** coordinate-only; `split_ratio`/`gap_ratio` are translation/rotation-invariant. `MIN_VISIBLE_NODES = 4`; never emits NaN. **Tradeoff:** as one feature among 19 (no dedicated 0.5 threshold) it is *less* independently sensitive than the former standalone check — it only fires when it moves the combined score.

---

## Instance count

**Flags:** frame with fewer instances than its expected (median) count — `isIncomplete = instanceCount < expected`.

**Algorithm:** `InstanceCountChecker` (`checks/frameLevel.js`). `fit(frameCounts, videoIds)` computes `globalExpected = median(frameCounts)` and, when `perVideo` (default true) with video IDs, a per-video median in `expectedCounts`. `check(instanceCount, videoId)` selects the per-video median when available else the global median, returning `{ isIncomplete: count < expected, expectedCount, actualCount, countDifference }`. Wired via `computeFrameUnit` → `checkFrame`; `expectedInstanceCount` is `Math.round(expected)`.

**Threshold/params:** no numeric threshold — the boundary is the (per-video) **median** count. `perVideo=true`.

**Notes:** Strictly less-than median (a frame exactly at median is not incomplete). Per-video median requires `videoId != null` and a fitted entry, else falls back to global. Only *under*-count is flagged; over-count is not an `isIncomplete`. Median is computed over all fitted frame counts.

---

## Negative frames

**Flags:** a frame marked negative (background) that nonetheless carries instances — `isNegativeWithInstances = isNegative && instanceCount > 0`.

**Algorithm:** `checkNegativeFrame(isNegative, instanceCount)` (`checks/frameLevel.js`): `Boolean(isNegative) && instanceCount > 0`. Computed per frame in `checkFrame` from the frame's `isNegative` flag and `poses.length`.

**Threshold/params:** none — pure boolean consistency check.

**Notes:** A negative frame with zero instances is consistent (not flagged); a non-negative frame is never flagged by this check regardless of count. Depends on the labels carrying a correct `isNegative` per frame.

---

## Duplicates

**Flags:** frame containing at least one pair of overlapping instances (`duplicatePairs.length > 0`), by bbox IoU or node-wise overlap.

**Algorithm:** `detectDuplicates(instances, opts)` (`checks/frameLevel.js`), only run when `poses.length >= 2`. For each pair `(i,j)`: `iou = computeInstanceIou` (IoU of axis-aligned bboxes of visible points; returns 0 if either has `<2` visible) and `overlap = computeNodeOverlap` (per commonly-visible node distance; `overlapRatio = #(<distThresh) / #common`). Reason: `"iou"` if `iou > iouThreshold`; else `"node_overlap"` if `overlap.commonNodes.length >= 2 && overlap.overlapRatio > nodeOverlapRatio`. Each detected hit pushes the full `{indexA, indexB, iou, nodeOverlap, reason}` into the detector's return array.

**Two return shapes.** The detector returns rich `{indexA, indexB, iou, nodeOverlap, reason}` objects, but `checkFrame` keeps only `[indexA, indexB]` into `fq.duplicatePairs` and `reason` into `fq.duplicateReasons` (parallel arrays); `iou`/`nodeOverlap` are dropped at the frame-result boundary.

**Threshold/params:** `duplicateIouThreshold=0.5`, `duplicateNodeDistanceThreshold=10.0` px, `duplicateNodeOverlapRatio=0.8` (`config.js`).

**Notes:** IoU is checked first; only if IoU fails does the partial-duplicate node-overlap path run. Node-overlap requires `>= 2` commonly-visible nodes (guards against a single shared node triggering a false dupe). `computeNodeOverlap` returns `overlapRatio=0` / `Infinity` distances when there are no common nodes. The node distance threshold (10 px) is in raw pixel space, not normalized.

---

## Instance verdict / explanation pipeline

The human-readable sidebar verdict is assembled by `instanceIssue` (`qcStore.svelte.js`) on top of `explain.js` (`checks/explain.js`), which is otherwise undocumented but load-bearing for the UI.

**`explain.js` exports.**
- `topIssue(contributions)` → `{ feature, issue }`: scales each raw contribution by `SCALE_FACTORS[feat] ?? 1.0`, special-cases `min_symmetry_consistency === 1.0` to `0` ("no symmetry info → ignore"), takes the argmax, and maps it through `ISSUE_MAP` (e.g. `min_symmetry_consistency → "Likely L/R swap"`, `max_centroid_distance → "Isolated node"`, fallback `"High <feature>"`). Empty contributions → `{ feature:null, issue:"Unknown" }`.
- `confidence(score)` → `"high"` (`>0.8`) / `"medium"` (`>0.5`) / `"low"`.
- `topContributions(contributions, k=3)` → top-k `[name, value]`, highest first.

**Verdict precedence (`instanceIssue`).** The chirality verdict short-circuits first; below it returns `null` if anomaly and gmm scores are both absent. In order:
1. **Chirality:** if the instance is flagged as a whole-instance L/R flip (`chScore >= chiralityThreshold`), the verdict is `"Whole-instance L/R flip"` — highest precedence.
2. Else, if anomaly is absent, **or** GMM flags while anomaly does *not* (`gFlag && checks.gmm && !(checks.anomaly && aScore >= threshold)`), the verdict is the GMM density verdict `"Improbable pose"` (`feature:null`), localized to the GMM leave-one-out node.
3. Else the **anomaly** explanation wins: `topIssue(contributions)` supplies `issue`/`feature`, `confidence(aScore)` the bucket. (A chimera surfaces here as `"Split pose / chimera"` when `pose_split_score` is the dominant feature.)

The displayed `worstNode` always comes from `faultyNodeFor` (chirality → anomaly → GMM precedence), independent of which verdict string was chosen.

---

## The 19-feature vector

Assembled per pose in `LabelQCDetector.extractFeatures` (`checks/detector.js`) as `[...baseline, ...v3]` — **12 baseline** (`checks/features/baseline.js`) then **7 V3** (the 6 below + `pose_split_score`, the log1p-compressed chimera signal). This vector is what **Anomaly** and **GMM** score, and what the read-only "feature vector" panel under the GMM check displays. Reference stats are fit over all pooled user instances (`fitFeatures`). `isVisible` requires *both* coords non-NaN; an invisible node is `[NaN,NaN]`. `rawMatrix` feeds the scorers; `cleanMatrix` maps `NaN→0, +Inf→10, −Inf→−10`. All z-score denominators are floored at `1e-6` (`safeStd`).

Baseline (1–12):

1. **max_edge_zscore** — `maxAbs` of per-visible-edge `z=(len − edgeMean)/edgeStd` vs per-edge fitted stats; both endpoints visible; empty set → 0.
2. **mean_edge_zscore** — `meanAbs` of the edge z-scores.
3. **max_angle_zscore** — joint angle at a node between a neighbor pair (`acos` of normalized dot, radians; null if either vector `<1e-6`), `z` vs per-triplet `(center, min(n1,n2), max)` fitted stats; needs center + both neighbors visible.
4. **mean_angle_zscore** — `meanAbs` of the angle z-scores.
5. **max_pairwise_zscore** — all node-pair distances (both visible) `z` vs per-pair fitted stats.
6. **mean_pairwise_zscore** — `meanAbs` of the pairwise z-scores.
7. **bbox_area_zscore** — visible-points bbox area (`>=2` visible) `z` vs fitted area mean/std; 0 if no bbox.
8. **max_centroid_distance** — max distance from the visible centroid over visible nodes (`>=2` visible else 0).
9. **centroid_distance_std** — population std of those centroid distances; 0 if `<2`.
10. **min_symmetry_consistency** — over symmetry pairs, min consistency ratio from left/right inter-pair distance ratios (ratio `<0.9` +1, `<=1.1` +0.5); `1.0` if `<2` pairs / none visible. Left/right order pinned in JS for reproducibility.
11. **visibility_rate** — `#visible / nNodes`.
12. **has_isolated_invisible** — 1 if any invisible node whose *every* skeleton neighbor is visible, else 0.

V3 (13–18):

13. **max_curvature** — max `|signed curvature|` (π − interior angle, signed by cross product) along the longest curvature chain/spine; 0 if curvature disabled or no chain; any triplet with an invisible node → NaN, dropped from the valid set.
14. **curvature_std** — population std of signed curvatures over valid (all-visible) triplets.
15. **visibility_pattern_score** — `VisibilityModel.score` violations/`nNodes` capped at 1: node visible while an expected-co-visible peer (`P>0.9`) is invisible, or a rarely-co-visible peer (`P<0.1`) is visible, vs the fitted co-visibility matrix.
16. **nn_distance** — nearest-neighbor L2 in normalized-pose space (center at visible centroid, scale by bbox diagonal, NaN coords imputed to 0; `scale<1e-6 → 1.0`); fit-time uses leave-one-out distances.
17. **hull_area_zscore** — convex-hull area over visible points (`>=3`, monotone chain + shoelace) `z` vs fitted hull-area mean/std (floored `1e-6`); only positive areas fit.
18. **hull_compactness** — `4π·area / perimeter²` of that hull; 0 if degenerate.

Edge cases: edge/angle/pairwise z-scores are only computed over nodes visible *and* present in fitted stats; an entirely-missing feature yields `maxAbs/meanAbs = 0` (not NaN). Convex hull needs `>=3` visible, centroid/bbox need `>=2`. `nn_distance`'s `normalizePose` imputes NaN to 0 before L2 (np.nan_to_num parity).

---

## Config: dead / reserved fields

`makeQCConfig` (`config.js`) mirrors the Python `QCConfig` and carries fields the unit pipeline does **not** consult — do not hunt for where they apply:
- `frameThreshold=0.5` — defined but unused by the unit pipeline (frame checks are boolean).
- `autoCalibrate=true`, `calibrationPercentile=95.0` — reserved / dead, mirror the Python dead fields.
- `useGmm=true` (default) — overridden to `false` by the store, but inert anyway since `computeGmmUnit` ignores it.
- `gmmPercentileThreshold=5.0` — passed into `GMMDetector` but unused by `scoreOne` (the 0.95 cut is `gmmThreshold` in the store).

---

## sleap/qc update — port status

The `sleap/qc` update (`origin/develop e89db4696`, issue #2756) added seven detectors. **Chirality** and **pose-split / chimera** (both above) are ported; **curvature** was already present as the `max_curvature`/`curvature_std` features (see "The 18-feature vector"). The rest:

**Coordinate-only, port specs verified, pending implementation:**
- **Chain order** (`ordering.py`, default OFF, needs a chain ≥4 nodes) — keypoints out of sequence along an ordered chain: `order_inversion_rate` (fraction of interior nodes whose turning angle > 60°) + `chain_intersection_count` (non-adjacent segment crossings); hard rule (intersections ≥1 or rate ≥0.3) → "Wrong keypoint order along chain". Translation/rotation/scale-invariant, no learned stats.
- **Missing node** (`missing_node.py`, default OFF) — an invisible node whose visible peers almost always keep it: `p_expected[k] = mean over visible i of P(k visible | i visible) >= 0.9`, reusing the co-visibility `VisibilityModel`. Channel detector (`final = max(gmm, channel)` in Python). Catches *outlier* drops, not dataset-wide systematic under-labeling.
- **Split duplicate** (`duplicate_split.py`) — enhances `detectDuplicates`: the "split" case where one animal is split across two instances on largely-disjoint (0.55–0.85), spatially-contiguous, coherently-gapped node sets; `duplicate_score = saturating max(IoU, node-overlap, split)`.

**Server-tier (not browser-feasible) — deferred:**
- **In-sample prediction** (`insample_prediction.py`) — runs a trained sleap-nn model in-sample and flags blank nodes the model confidently localizes. Needs a model + torch → Python precompute → sidecar.
- **Appearance outlier** (`appearance.py`) — per-node image-patch (mean+std descriptor) Mahalanobis model. Needs decoded frame pixels.
