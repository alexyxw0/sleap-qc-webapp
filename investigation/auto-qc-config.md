# Auto-tuning QC-detector configuration — investigation

**Date:** 2026-06-29
**Goal:** A new tab that uses heuristics to suggest the best QC-detector configuration for a
loaded dataset — *which* detectors to enable and *what* threshold each gets — with the
heuristics kept **general and adaptable** so future detectors plug in without rewiring.

---

## 1. Problem framing

"Best configuration" decomposes into two sub-problems of very different difficulty:

1. **Calibration** — the *threshold* each detector gets (`anomaly ≥`, `gmm ≥`, `chirality ≥`,
   `ordering ≥`, `poseSplit ≥`, `confidence <`, `instConfidence <`, plus per-feature `|z| ≥`).
2. **Selection** — *whether* a detector should run at all on this dataset (including the boolean
   structural ones: count / negative / duplicates, which have no threshold).

Hard constraint: **no ground truth.** A `.slp` file is not labeled "which instances are errors,"
so every heuristic is *unsupervised*. Consequences:

- Every suggestion must be **transparent** (show the user *why*) and **overridable** (it seeds the
  existing sliders/toggles; it never locks anything).
- We optimize a *proxy*, not a true error rate. Keep a human in the loop conceptually.

The literature is encouraging on calibration and sobering on selection (see §2).

---

## 2. What the field offers (research)

### Calibration without a contamination guess — essentially solved
- **PyThresh** — a library of **30+ thresholders** that turn a 1-D score distribution into a cutoff
  with *no* contamination parameter: robust-z, MAD, IQR, Otsu (bimodal valley), kneedle (knee of the
  sorted-score curve), plus graph/topology methods. All are small, pure-math, portable to JS.
- **Extreme Value Theory / Peaks-Over-Threshold (POT, SPOT, DSPOT)** — Siffer et al., KDD 2017. Fit a
  Generalized Pareto Distribution to the score *tail* (Pickands–Balkema–de Haan) and place the
  threshold for a **target false-alarm rate**, distribution-agnostically. DSPOT adds drift handling.
  This is the most principled "set a tail threshold for a target flag-rate" method.
- Classic robust statistics: median + k·MAD, IQR fences, 3σ on log-scores, largest-gap.

### Selection / model choice without labels — genuinely hard
- **Internal-validation metrics** (Excess-Mass, Mass-Volume, IREOS) exist, **but** a large-scale study
  (Ma & Zhao, 2021, "Do Internal Strategies Suffice?") found they are expensive and **don't reliably
  beat trivial baselines**. → Don't trust a pure internal metric to pick detectors.
- **MetaOD** (Zhao, NeurIPS 2021) — meta-learn `dataset-profile → best detector` from a *corpus of
  labeled benchmark datasets*. Works well but needs that corpus + a training pipeline. Future, not MVP.
- Pragmatic label-free selection therefore leans on: **domain structure** (the skeleton tells you which
  geometric checks are even meaningful), **cross-detector consensus** (detectors validate each other),
  and **a little human feedback** (a few taps calibrates better than any heuristic).

---

## 3. The general/adaptable core — a per-detector `Recommender` registry

This is the part that makes the feature future-proof. Do **not** centralize the heuristics. Each
detector ships its own recommender, exactly like each one already ships a `computeXUnit(ctx)`. The
Auto-tune tab is a thin loop over the registry — adding a detector never touches the tab.

```js
// one of these per detector; the tab just iterates the registry
const Recommender = {
  id: "chirality",

  // (1) SELECTION: should this detector even run on THIS dataset?
  applicable(profile) {
    return profile.symmetryPairs > 0
      ? { enable: true,  rationale: `${profile.symmetryPairs} L/R node pairs` }
      : { enable: false, rationale: "skeleton has no symmetric nodes" };
  },

  // (2) CALIBRATION: pick a threshold from the score distribution + a global policy.
  //     Boolean detectors (count/negative/duplicates) omit this.
  calibrate(scores, profile, policy) {
    return {
      threshold: evtThreshold(scores, policy.targetFlagRate),
      rationale: "GPD tail · ~3% flagged",
      spark: histogram(scores),         // for the UI sparkline
    };
  },
};
```

### `DatasetProfile` — meta-features (all already computable)
Built once from `buildContext(labels, config)` + the `SkeletonAnalyzer` — nothing new to compute:

| field | source | drives |
|---|---|---|
| `nNodes`, `edges` | analyzer | general |
| `symmetryPairs` | `analyzer.symmetryPairs` | chirality |
| `chainCount`, `maxChainLength` | `analyzer.getCurvatureChains()` / `maxChainLength` | ordering, curvature features |
| `nTracks`, `multiAnimal` | labels / tracks | duplicates, pose-split |
| `hasPredictions` | `ctx.hasPredictions` | confidence, instConfidence |
| `instPerFrame` mean+var | `ctx.frameCounts` | count check (stable count?) |
| `nInstances`, `nFrames` | ctx | fit feasibility (enough rows?) |
| per-detector score stats | unit outputs | calibration + "degenerate signal?" check |

### Global **policy** knob
A single user-facing control — *conservative ↔ aggressive*, i.e. **target flagged-rate** (or target
false-alarm rate for EVT) — flows into every `calibrate()`. One intuitive dial instead of N sliders.

### What "adding a future detector" costs
1. Its `computeXUnit(ctx)` (already required today).
2. A `Recommender` (≈10 lines). → it appears in the tab automatically.

---

## 4. Implementation approaches (simplest → most ambitious)

**A. Rule-based domain selection + statistical calibration — the MVP.**
- *Selection* from skeleton/data structure: symmetry→chirality, chains→ordering/curvature,
  multi-animal→duplicates/pose-split, predicted→confidence/instConfidence, stable per-frame
  count→count. Disable any detector whose score distribution is degenerate (no spread ⇒ no signal).
- *Calibration* per detector via a robust method (MAD / robust-z / percentile / kneedle).
- Deterministic, transparent, zero training, fast. Each rule lives in its detector's recommender.

**B. Score-distribution auto-thresholding (PyThresh / EVT port) — calibration depth.**
- Port a handful of PyThresh-style methods to JS (tiny pure functions): EVT/POT (GPD tail → target
  FAR), Otsu, kneedle, MAD/IQR. The policy knob = "target flagged %." More adaptive than fixed defaults.

**C. Consensus / ensemble self-calibration — selection without labels.**
- Run all applicable detectors; inspect *agreement*. Instances flagged by many detectors are likely
  real errors; a detector firing on a large, disjoint set is likely noise → downweight/disable it.
  Nudge each threshold so its flagged set overlaps the consensus while total coverage stays in a sane
  band (~1–10%). The detectors validate each other — label-free, cheap-ish. Yields a detector ranking.

**D. Internal-validation scoring — principled tiebreaker only.**
- Rank candidate configs by **stability** (subsample → flagged-set Jaccard) and **separability** (gap
  between flagged/not), as a cheap EM/MV proxy. Use as a tiebreaker, *not* the sole driver (per §2).

**E. Human-in-the-loop active calibration — the reliable closer.**
- The tab surfaces a small, *diverse* set of borderline candidates; the user taps a few
  "real error / fine"; thresholds + detector weights re-fit to match (tiny active-learning loop). A
  handful of labels calibrates far better than any pure heuristic — and doubles as data collection for F.

**F. Meta-learning (MetaOD-style) — future end-state.**
- Log `(profile, chosen config, accepted flags)` across every file the lab QCs; learn
  `profile → config`. Carries experience to new files with zero labels. Heavy (corpus + likely
  server-side training), but A–E generate exactly its training data, so it's a graduation, not a rewrite.

---

## 5. Recommended phasing + tab UX

- **Phase 1 (build first):** `Recommender` registry + `DatasetProfile` + **A** (domain rules) + **B**
  (EVT/robust auto-threshold) + the **Auto-tune tab**. Already genuinely useful and fully general.
- **Phase 2:** **C** consensus reweighting + the coverage-policy slider.
- **Phase 3:** **E** human-in-the-loop (and begin logging for **F**).
- **Later:** **F** if the corpus pays off.

**Tab UX**
- Top: dataset-profile summary (nodes, symmetry, chains, multi-animal, predicted?, size).
- One **recommendation card per detector**: enabled? · suggested threshold · one-line rationale · a
  tiny score-histogram sparkline showing where the cutoff lands.
- Global **conservative ↔ aggressive** slider (target flagged-rate).
- **"Apply to checks"** button → writes the toggles + thresholds into the existing `qc` store. Re-runnable.
- Everything is a *starting point*; the user can override any card before/after applying.

---

## 6. Open decisions (to settle before Phase-1 build)

1. **Tab placement** — a new section inside the Detection-checks panel, vs. its own dockable sidebar tab.
2. **Default calibration method** — single method (EVT) vs. per-detector best-of (EVT for tailed
   scores, Otsu when bimodal, kneedle otherwise).
3. **Policy semantics** — "target flagged %" of instances vs. EVT false-alarm-rate; and whether it's
   global or per-detector-overridable.
4. **Boolean detectors** — count/negative/duplicates have no threshold; recommender is selection-only.
   Confirm count's "expected N" inference (mode of `instPerFrame`?).
5. **Apply granularity** — apply all cards at once vs. per-card "use this."

---

## Sources
- PyThresh — <https://github.com/KulikDM/pythresh> · write-up: <https://towardsdatascience.com/thresholding-outlier-detection-scores-with-pythresh-f26299d14fa/>
- EVT streaming anomaly detection (Siffer et al., KDD 2017) — <https://www.eecs.yorku.ca/course_archive/2017-18/F/6412/reading/kdd17p1067.pdf> · SPOT/DSPOT code: <https://github.com/cbhua/peak-over-threshold>
- MetaOD (Zhao et al., NeurIPS 2021) — <https://arxiv.org/abs/2009.10606>
- "A Large-scale Study on Unsupervised Outlier Model Selection: Do Internal Strategies Suffice?" (Ma & Zhao, 2021) — <https://arxiv.org/abs/2104.01422>
