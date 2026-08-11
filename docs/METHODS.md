# Methods layered on the baseline detector

The baseline is the JS port of `sleap.qc` — an 18-feature geometric vector per instance, scored by a
ZScore or GMM outlier model, plus a handful of frame-level rules. That port and its features are
documented in [`../src/lib/qc/CHECKS.md`](../src/lib/qc/CHECKS.md); this file covers what was built
**on top of it**, and why each piece exists.

The short version of the motivation: the baseline is a detector of *implausible geometry*. Most
ground-truth annotation errors are not implausible. A nose dropped two pixels off the nostril leaves
every bone length, joint angle and symmetry ratio inside its normal range, so no function of the
coordinates can see it. Everything below is an attempt to get at that class of error, plus the
plumbing needed to make any detector's output actionable.

---

## 1. Appearance: reading the image, not the coordinates

The one signal geometry cannot have. A frozen **DINOv2 ViT-S/14** (`Xenova/dinov2-small`, 384-d,
14 px patches, 224² input) embeds an image crop; a misplaced keypoint sits on the wrong *texture*
even when it sits at a plausible *position*.

Nothing is fine-tuned. The model runs in the browser via transformers.js on WASM (int8), inside a
dedicated worker (`qc/embedding/embedWorker.js`). WebGPU is deliberately not used: at batch-1 on a
small model it is slower than WASM and it contends with the compositor, so the whole UI stutters.

Two granularities, which answer different questions:

| | crop | question it answers |
|---|---|---|
| **`dino`** — whole instance | padded square over the animal's placed nodes | does this animal look unusual overall (occlusion, wrong subject, bad frame)? |
| **`nodeDino`** — per keypoint | small box centred on one keypoint, side = `0.3 × animal scale` | does *this keypoint* sit on something that doesn't look like that keypoint? |

Per-keypoint is the one that matters. It is far more sensitive to a single bad node, and — critically
— a flag **names the keypoint**, which the whole-instance crop cannot do.

### Scoring the embeddings

Four scorers, all reduced to the same robust-z scale so the threshold slider, the frame-level maps
and the QC union never have to know which one ran:

- **kNN (unsupervised).** Mean cosine distance to the *k* nearest patches of the *same keypoint*
  elsewhere in the file, robust-z'd. The reference is a per-video **stratified subsample**
  (`referenceFraction = 0.2`, floor 20/video), not the whole set. This is load-bearing: at 100% a
  slow-moving animal's own neighbouring frames become its nearest neighbours, distance collapses to
  ~0, and a fault that persists for a few frames reads as perfectly normal.
- **RBF-SVM (supervised).** A fitted boundary between faulty and clean appearance. Either loaded
  from a bundle exported earlier, or fitted in-app on labels you make in the proofreading window.
- **Few-shot.** A nearest-centroid direction rather than a fitted boundary, blended **by rank** over
  whatever is scoring the group. Works at label counts where an SVM's cross-validated score would be
  meaningless. Blending is always from the *unblended* base, so re-applying never compounds.
- **AnomalyDINO (unsupervised, patch-level).** See below.

### AnomalyDINO

Damm et al., *Boosting Patch-based Few-Shot Anomaly Detection with DINOv2*, WACV 2025.
Implementation: `qc/embedding/anomalyDino.js`, `qc/embedding/patchTokens.js`.

kNN scores the **CLS token** — one vector for the whole crop. A keypoint that is only *locally*
wrong barely moves it, because most of the crop is unchanged. AnomalyDINO keeps the **patch tokens**:
each test patch token's cosine distance to its nearest neighbour in a memory bank of normal tokens,
aggregated as the **mean of the worst quarter**. A small wrong region speaks for itself instead of
being averaged away.

Both are label-free and land on the same scale, so switching between them re-scores in place — the
descriptors come out of the *same forward pass* as CLS, so the half-hour of inference is not paid
twice.

Three deliberate departures from the paper, all forced by running in a browser over ~58,000 crops:

- **Compacted descriptors.** A 16×16 grid of 384-d tokens is 393 KB/crop — 23 GB over a full
  per-keypoint run. Each grid is pooled to 4×4, L2-normalized, projected to 64-d by a fixed seeded
  Gaussian random projection (PatchCore does the same, for the same reason), and quantized to int8:
  **1 KB/crop**, ~59 MB for that run, small enough to cache beside the CLS vector.
- **q = 0.25, not 0.01.** `q` is a *fraction of tokens*, and pooling leaves 16 of them, so 1% rounds
  to one token — exactly the max-aggregation the paper argues against.
- **No foreground masking.** The paper masks background so a plain backdrop cannot dilute the score.
  Here the background *is* diagnostic: a keypoint dragged off the animal is one of the faults we most
  want to catch, and masking is what would hide it.

The memory bank allocates its budget across reference crops and rotates which grid positions each
contributes. A single global stride over the concatenated token stream can lock onto a grid position
and bank a memory that has never seen the bottom-left of anything — which then calls every
bottom-left an anomaly.

### Caching

Embedding is the expensive step (minutes to tens of minutes), so `qc/embedding/embcache.js` persists
every crop's vector in IndexedDB keyed by `(file, video, frame, box)` — a crop's embedding cannot
change unless the crop does. Patch descriptors ride along in the same record.

Four failure modes that were silent and are now not: counting via `count(IDBKeyRange)` instead of
deserializing every value; `onclose`/`onversionchange` dropping the memoized handle so one forced
close doesn't turn every later read into "0 cached"; chunked writes so a quota wall costs the last
chunk rather than the run; and `navigator.storage.persist()`, because a 200 MB cache in an evictable
bucket is exactly what a browser drops under disk pressure.

---

## 2. Geometry beyond the port

- **Chirality** and **pose-split / chimera** are ports of the newer `sleap/qc` detectors.
- **Chain ordering** (`ordering`, default off) scores keypoints out of sequence along an ordered
  chain — turning-angle inversions plus non-adjacent segment crossings. Inert unless a chain is
  declared in config, which is why it ships off.
- **Custom per-feature checks.** Any of the 18 features can be pulled out of the aggregate vector and
  run as its own check with its own threshold. The aggregate scorers answer "is this pose weird";
  a feature check answers "is *this measurement* out of range", which is a different and often more
  actionable question — and it is the check whose flags the reviewer can most easily verify by eye.

The 18 features, for reference: `max_edge_zscore`, `mean_edge_zscore`, `max_angle_zscore`,
`mean_angle_zscore`, `max_pairwise_zscore`, `mean_pairwise_zscore`, `bbox_area_zscore`,
`max_centroid_distance`, `centroid_distance_std`, `min_symmetry_consistency`, `visibility_rate`,
`has_isolated_invisible`, `max_curvature`, `curvature_std`, `visibility_pattern_score`,
`nn_distance`, `hull_area_zscore`, `hull_compactness`.

---

## 3. Attribution — turning a score into a place on the animal

A flag that says "this frame is suspect" is a search problem handed back to the user. Every check now
answers a stronger question through **one** resolver, `qc.instanceBlame(item, inst)`:

```
{ check, feature, kind: "edge" | "angle" | "node" | "instance", nodes, node, variant, dir }
```

`kind` is what the canvas draws, and it is chosen to match the geometry the check actually measured:

- **edge** — a bone too long, a chirality L/R pair, a chimera's bridging edge → both endpoints cased
- **angle** — a deviant joint or a bend along the body chain → both arms plus an arc at the vertex
- **node** — a single keypoint → dashed ring; the visibility check also says *which way* it is wrong
  (cross-hair for "expected here and absent", filled dot for "present where it almost never occurs")
- **instance** — a whole-instance feature, a duplicate pair, a sparse instance → the bounding box

Precedence is most-specific-first: a structural verdict (chirality, ordering, split) names a shape the
aggregate scorers can only approximate, so it wins; an explicit feature check beats the anomaly
aggregate because the user asked for that feature by name; frame-level checks come last.

Two checks deliberately blame *nobody*: instance count and negative-frame. They are statements about
the frame, and inventing a culprit would be a guess.

`frameWorstInstance` ranks **flagged-first, then by margin relative to each check's threshold**. Raw
margins mix scales — anomaly and GMM live on 0..1 while a feature z runs to 20 — so a raw comparison
lets whichever check has the widest range win by construction, and can hand back an instance that
nothing flagged.

---

## 4. What the numbers actually say

Measured with this repo's own detector modules over the two proofread projects
(`presentation/eval/` in the working tree: export poses with parse's h5py reader → score in Node with
`LabelQCDetector`/`GMMDetector`/`ZScoreDetector` → ROC/AP verified against sklearn to 1e-9).

**Per-instance faulty:**

| | max_angle | GMM |
|---|---|---|
| gily_only (6.5% base, 454/6962) | ROC 0.709 · PR 0.292 | ROC 0.687 · PR 0.155 |
| center_no_gily (4.4% base, 325/7397) | ROC 0.667 · PR 0.140 | ROC 0.619 · PR 0.072 |

**Nose faulty** (instances with a placed nose — the population an appearance run can embed):

| | max_angle | GMM | DINO 64px + RBF-SVM |
|---|---|---|---|
| gily_only (2.58% base) | ROC 0.690 · PR 0.110 | ROC 0.707 · PR 0.076 | ROC 0.957 |
| center_no_gily (0.89% base) | ROC 0.844 · PR 0.079 | ROC 0.619 · PR 0.012 | ROC 0.949 |

**Review budget** — fraction of nose faults found after reviewing the top *x*% by score:

| top 5% | top 10% |
|---|---|
| DINO-SVM 77% · max_angle (gily) 28% · GMM 17% · random 5% | 90% · 38% · 26% · 10% |

Three things worth reading off this rather than skipping past:

1. **Report PR, not ROC.** `center_no_gily` max_angle reaches ROC 0.844 while its PR is 0.079 at a
   0.89% base rate. The ROC number would let geometry look like a contender; the PR number says it
   is not. The PR chance line moves with prevalence, ROC's does not.
2. **Geometry is not uniformly blind.** max_angle finds 54% of `center_no_gily`'s nose faults in the
   top 5%. "Geometry can't see these" is a `gily_only` statement, not a universal one.
3. **Appearance is supervised-or-nothing here.** Unsupervised kNN on whole-animal crops scored ~chance
   in the experiments, which is why the instance-level check ships with the trained SVM and no kNN
   option. Per-keypoint patches are small enough for the unsupervised route to discriminate.

The DINO figures above are quoted from the project's experiment sweep, not recomputed here; the
geometry figures are measured by the code in this repo.

---

## 5. Known limits

- **Cross-dataset transfer is data-limited.** A boundary fitted on one project lands at PR 0.064
  zero-shot on the other; 5–10 targeted labels move it to 0.23. Cheap to adapt, not free.
- **One annotator.** Every ground-truth label came from one person, so the jitter/clean boundary
  carries their judgement. Inter-annotator agreement on that class is unmeasured.
- **AnomalyDINO is unvalidated on this data.** Its discriminative claim is verified on synthetic
  descriptors in the unit tests; it has not been scored against the proofread labels.
- **Two `sleap/qc` detectors remain server-tier**: in-sample prediction (needs a trained model +
  torch) and the per-node Mahalanobis appearance model (needs decoded pixels at scale). Both would
  arrive as a Python precompute sidecar.
- **The strongest untried baseline is ensemble model-disagreement** (Schwarz et al. 2024: five pose
  models, per-keypoint deviation, isolation forest) — the field's concrete keypoint-QC method.
