<script>
  import { qc } from "../qcStore.svelte.js";
  import { store } from "../labelsStore.svelte.js";

  // Each detection technique the user can include in the flagged set. Pick the ones you want
  // BEFORE running QC — only selected techniques are computed, and each result is memoized so
  // re-selecting a computed check never recomputes. The flagged frames are the UNION of the
  // enabled checks.
  // `hint` is the quick hover tooltip; `info` is the longer, expand-on-click explanation
  // of what the detector measures and when to trust it.
  const CHECKS = [
    {
      key: "chirality",
      label: "L/R flip (chirality)",
      hint: "Whole-instance left/right mirror flip: symmetric pairs (e.g. Ear_L/Ear_R) sitting on the wrong side of the body midline.",
      info: "Whole-instance left/right mirror flip — symmetric keypoint pairs (Ear_L/Ear_R, …) sitting on the wrong side of the body midline. A mirror flip preserves every edge length and unsigned angle, so it is invisible to the feature-based Anomaly / GMM checks; this is the dedicated signed-side test, measuring which side of the body axis each left/right keypoint falls on. Coordinate-only and scale-invariant. Auto-disables when the skeleton has no symmetric (or name-inferable) pairs. On by default.",
    },
    {
      key: "ordering",
      label: "Chain ordering",
      hint: "Keypoints labeled out of order along a chain (e.g. a tail).",
      info: "Flags an instance whose keypoints are labeled out of order along an ordered chain (tail / spine / limb): sharp turning angles between consecutive segments and/or self-crossing segments (a strong, unambiguous signal of a non-adjacent swap). Deterministic and scale-invariant (a hard rule, like chirality), keyed to the skeleton's curvature chains. The slider is the order-inversion rate; a chain crossing always flags. Off by default (experimental).",
    },
    {
      key: "anomaly",
      label: "Anomaly",
      hint: "Geometrically unusual instance vs. the rest of the file.",
      info: "General “this pose looks geometrically wrong” detector. It builds an 18-dimensional descriptor per instance (edge lengths, joint angles, pairwise distances, bounding-box & convex-hull area, symmetry, curvature, visibility …) and flags an instance whose single most-extreme feature deviates far from the rest of the file. The threshold slider sets how extreme counts as extreme. On by default.",
    },
    {
      key: "gmm",
      label: "GMM (probability)",
      hint: "Low-probability instance under a Gaussian-mixture density model. Heaviest check — opt-in.",
      info: "Probabilistic counterpart to the anomaly check: it fits a Gaussian-mixture density over the same 18 features and flags poses that are rare under it (threshold 0.95 ≈ the rarest 5%). Catches subtle, multi-feature weirdness the single-feature anomaly score misses. It is the heaviest check to compute (and needs ≥ 50 instances). On by default.",
    },
    {
      key: "count",
      label: "Instance count",
      hint: "Frame has the wrong number of instances.",
      info: "Frame-level: flags a frame whose instance count differs from the expected (the median per-frame count of NON-empty frames, per video) — too few (a missed/un-labeled animal, incl. a non-negative empty frame) OR too many (a spurious extra). Negative frames are exempt. Boolean — no threshold. Off by default.",
    },
    {
      key: "sparse",
      label: "Sparse instance",
      hint: "An instance localized by too few visible nodes.",
      info: "Flags a frame containing an instance placed with fewer than N visible nodes — a barely-localized / off-frame instance the anomaly check can miss (it's baseline-relative, so messy data dilutes it). Deterministic; N is the slider below (default 2 = flag instances with 0–1 visible nodes). Negative frames are exempt. Off by default.",
    },
    {
      key: "confidence",
      label: "Low confidence",
      hint: "A predicted keypoint with a low confidence score.",
      info: "For PREDICTED labels only: flags a frame whose weakest visible keypoint scores below the threshold below (the SLEAP confidence-map peak value, 0–1). Identifies uncertain placements to review. Shown only when the file has predicted instances; user-labeled instances have no scores. Off by default.",
    },
    {
      key: "negative",
      label: "Negative frames",
      hint: "A negative frame that still has instances.",
      info: "Consistency check: a frame explicitly marked negative (background / no animal) should carry no labeled instances. Flags any negative frame that still has instances. Boolean — no threshold. Off by default.",
    },
    {
      key: "duplicates",
      label: "Duplicates",
      hint: "Two instances overlapping / duplicated.",
      info: "Flags a frame where two instances overlap — either by bounding-box IoU (> 0.5) or by node-wise overlap (most shared-visible nodes within ~10 px of each other). Catches the same animal accidentally labeled twice. On by default.",
    },
  ];

  const CHECK_BY_KEY = Object.fromEntries(CHECKS.map((c) => [c.key, c]));

  // The detectors grouped by KIND, each its own collapsible sub-section, so the panel reads as three
  // short lists instead of one long one. Geometric = scale-invariant hard rules (population-
  // independent verdict); Statistical = outlier detectors that score each instance RELATIVE to the
  // file's distribution (they share the feature vector + the outlier-baseline control — only GMM is
  // non-deterministic, the z-score is deterministic); Frame-level = whole-frame consistency checks.
  const GROUPS = [
    { id: "geometric", label: "Geometric", hint: "Deterministic geometric hard rules — scale-invariant, no learned baseline.", keys: ["chirality", "ordering"] },
    { id: "statistical", label: "Statistical", hint: "Outlier detectors that score each instance against the file's distribution (shared feature vector + baseline control). Only GMM is non-deterministic (EM fit); the z-score is deterministic.", keys: ["anomaly", "gmm"] },
    { id: "frame", label: "Frame-level", hint: "Whole-frame consistency: count, sparsity, confidence, negative frames, duplicates.", keys: ["count", "sparse", "confidence", "negative", "duplicates"] },
  ];

  let collapsed = $state(false); // collapse the whole detection-checks block to de-clutter
  let groupOpen = $state({ geometric: false, statistical: false, frame: false }); // per-group collapse (compact by default; each header shows "N on")
  let infoOpen = $state({}); // per-check key -> show the long-form description
  let featOpen = $state(false); // read-only "feature vector" panel under the GMM check

  // a check is hidden when it can't apply (confidence needs predicted instances)
  const visibleInGroup = (g) =>
    g.keys.map((k) => CHECK_BY_KEY[k]).filter((c) => c.key !== "confidence" || !qc.hasResults || qc.hasPredictions);
</script>

{#if store.labels}
  <section class="side-section">
    <button type="button" class="sec-head" onclick={() => (collapsed = !collapsed)} aria-expanded={!collapsed} title="Collapse / expand detection checks">
      <span class="schev" class:open={!collapsed}>▸</span>
      <span class="side-h">Detection checks</span>
      {#if qc.hasResults}
        <span class="sum">{qc.flaggedFrameCount} flagged</span>
      {:else if qc.pendingCount > 0}
        <span class="sum pend">{qc.pendingCount} to run</span>
      {/if}
    </button>
    {#if !collapsed}
    {#snippet checkRow(c)}
      {@const ready = qc.checkReady(c.key)}
      {@const pending = qc.checkPending(c.key)}
        <li class:off={!qc.checks[c.key]}>
          <div class="row">
            <button
              type="button"
              class="info-btn"
              class:open={infoOpen[c.key]}
              onclick={() => (infoOpen[c.key] = !infoOpen[c.key])}
              aria-expanded={!!infoOpen[c.key]}
              aria-label="What this check detects"
              title="What this check detects"
            >ⓘ</button>
            <label title={c.hint}>
              <span class="lbl">{c.label}</span>
              {#if pending}
                <span class="penddot" title="Selected — needs a Run QC to compute"></span>
              {:else if ready}
                <span class="cnt">{qc.checkCount(c.key)}</span>
              {/if}
              <input
                type="checkbox"
                checked={qc.checks[c.key]}
                onchange={() => qc.toggleCheck(c.key)}
              />
            </label>
          </div>
          {#if infoOpen[c.key]}
            <p class="info">{c.info}</p>
          {/if}
          {#if c.key === "anomaly" && qc.checks.anomaly}
            <!-- Anomaly flag threshold. Scores are cached, so dragging only re-derives the
                 flagged set (no recompute) — counts + union update live. -->
            <div class="thresh" title="Flag an instance when its anomaly score is at or above this value">
              <span class="tlbl">threshold</span>
              <input
                type="range"
                min="0.3"
                max="0.99"
                step="0.01"
                value={qc.threshold}
                oninput={(e) => (qc.threshold = +e.currentTarget.value)}
              />
              <span class="tval">{qc.threshold.toFixed(2)}</span>
            </div>
          {/if}
          {#if c.key === "gmm" && qc.checks.gmm}
            <!-- GMM flag threshold (1 − likelihood percentile; higher = rarer). Same memoized
                 re-derive: dragging re-flags without recomputing the mixture. -->
            <div class="thresh" title="Flag an instance when its GMM anomaly is at or above this value (0.95 ≈ rarest 5%)">
              <span class="tlbl">threshold</span>
              <input
                type="range"
                min="0.5"
                max="0.99"
                step="0.01"
                value={qc.gmmThreshold}
                oninput={(e) => (qc.gmmThreshold = +e.currentTarget.value)}
              />
              <span class="tval">{qc.gmmThreshold.toFixed(2)}</span>
            </div>
          {/if}
          {#if c.key === "gmm" && qc.vectorFeatures.length}
            <!-- Read-only view of the shared anomaly/GMM feature vector (incl. pose_split_score).
                 Values are the worst instance on the current frame, if any. -->
            {@const wi = qc.frameWorstInstance(store.current)}
            {@const contrib = qc.contributionsFor(store.current, wi)}
            <button type="button" class="featbtn" class:open={featOpen} onclick={() => (featOpen = !featOpen)} aria-expanded={featOpen} title="The feature vector the anomaly + GMM scores are computed from">
              <span class="featchev" class:open={featOpen}>▸</span> feature vector · {qc.vectorFeatures.length}
            </button>
            {#if featOpen}
              <ul class="featlist">
                {#each qc.vectorFeatures as fname (fname)}
                  <li class:psf={fname === "pose_split_score"}>
                    <span class="fn">{fname}</span>
                    {#if contrib}<span class="fv">{(contrib[fname] ?? 0).toFixed(2)}</span>{/if}
                  </li>
                {/each}
              </ul>
              <p class="featnote">{contrib ? `values · worst instance on this frame (#${wi})` : "shared by Anomaly + GMM · read-only"}</p>
            {/if}
          {/if}
          {#if c.key === "chirality" && qc.checks.chirality}
            <!-- Chirality flag threshold (wrong-side fraction; the hard rule forces >=0.9). -->
            <div class="thresh" title="Flag an instance when its L/R-flip score is at or above this value">
              <span class="tlbl">threshold</span>
              <input
                type="range"
                min="0.3"
                max="0.99"
                step="0.01"
                value={qc.chiralityThreshold}
                oninput={(e) => (qc.chiralityThreshold = +e.currentTarget.value)}
              />
              <span class="tval">{qc.chiralityThreshold.toFixed(2)}</span>
            </div>
          {/if}
          {#if c.key === "ordering" && qc.checks.ordering}
            <!-- Order-inversion rate threshold (a chain crossing always flags regardless). -->
            <div class="thresh" title="Flag when the order-inversion rate is at or above this value (a chain crossing always flags)">
              <span class="tlbl">inversion</span>
              <input
                type="range"
                min="0.05"
                max="0.95"
                step="0.05"
                value={qc.orderingThreshold}
                oninput={(e) => (qc.orderingThreshold = +e.currentTarget.value)}
              />
              <span class="tval">{qc.orderingThreshold.toFixed(2)}</span>
            </div>
          {/if}
          {#if c.key === "sparse" && qc.checks.sparse}
            <!-- Min visible nodes: flag instances localized by fewer than this many nodes. -->
            <div class="thresh" title="Flag an instance localized by fewer than this many visible nodes">
              <span class="tlbl">min&nbsp;nodes</span>
              <input
                type="range"
                min="1"
                max="8"
                step="1"
                value={qc.sparseThreshold}
                oninput={(e) => (qc.sparseThreshold = +e.currentTarget.value)}
              />
              <span class="tval">&lt;&thinsp;{qc.sparseThreshold}</span>
            </div>
          {/if}
          {#if c.key === "confidence" && qc.checks.confidence}
            <!-- Min keypoint confidence: flag predicted instances with a weaker visible keypoint. -->
            <div class="thresh" title="Flag a predicted instance whose weakest visible keypoint scores below this">
              <span class="tlbl">min&nbsp;score</span>
              <input
                type="range"
                min="0.05"
                max="0.95"
                step="0.05"
                value={qc.confidenceThreshold}
                oninput={(e) => (qc.confidenceThreshold = +e.currentTarget.value)}
              />
              <span class="tval">&lt;&thinsp;{qc.confidenceThreshold.toFixed(2)}</span>
            </div>
          {/if}
        </li>
    {/snippet}

    {#each GROUPS as g (g.id)}
      {@const visible = visibleInGroup(g)}
      {@const visKeys = visible.map((c) => c.key)}
      {@const onCount = visKeys.filter((k) => qc.checks[k]).length}
      {@const allOn = visible.length > 0 && onCount === visible.length}
      {#if visible.length}
        <div class="group">
          <div class="grp-head">
            <button type="button" class="grp-toggle" onclick={() => (groupOpen[g.id] = !groupOpen[g.id])} aria-expanded={groupOpen[g.id]} title={g.hint}>
              <span class="grpchev" class:open={groupOpen[g.id]}>▸</span>
              <span class="grp-lbl">{g.label}</span>
              {#if onCount}<span class="grp-sum">{onCount} on</span>{/if}
            </button>
            <input
              type="checkbox"
              class="grp-check"
              checked={allOn}
              indeterminate={onCount > 0 && !allOn}
              onchange={() => qc.setChecks(visKeys, !allOn)}
              title="{allOn ? 'Disable' : 'Enable'} all {g.label.toLowerCase()} checks"
              aria-label="Toggle all {g.label} checks"
            />
          </div>
          {#if groupOpen[g.id]}
            {#if g.id === "statistical" && (!qc.hasResults || (qc.hasPredictions && qc.hasUserInstances))}
              <div class="baseline" title="Which instances define the 'normal' reference the Anomaly / GMM outlier checks score against">
                <span class="bl-lbl">outlier baseline</span>
                <div class="seg">
                  <button type="button" class:on={qc.baselineSource === "all"} onclick={() => qc.setBaselineSource("all")}>All labeled</button>
                  <button type="button" class:on={qc.baselineSource === "user"} onclick={() => qc.setBaselineSource("user")} title="Fit the reference on user-annotated instances only (cleaner ground truth)">User only</button>
                </div>
              </div>
            {/if}
            <ul class="checks">
              {#each visible as c (c.key)}
                {@render checkRow(c)}
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    {/each}
    {#if qc.hasResults}
      <p class="union">
        <span>flagged · union</span><b>{qc.flaggedFrameCount}</b>
      </p>
    {/if}
    {#if qc.canExportCsv}
      <button class="export" onclick={() => qc.downloadCsv()} title="Download per-instance QC scores + features as a CSV">
        ⤓ Export results (CSV)
      </button>
    {/if}
    {#if qc.pendingCount > 0}
      <p class="hint">
        {qc.pendingCount} selected check{qc.pendingCount === 1 ? "" : "s"} need{qc.pendingCount === 1 ? "s" : ""} a run{qc.checks.gmm && !qc.checkReady("gmm") ? " · GMM is slow" : ""}
      </p>
    {/if}
    {/if}
  </section>
{/if}

<style>
  .baseline {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.1rem 0.55rem;
    margin-bottom: 0.3rem;
    border-bottom: 1px solid var(--border);
  }
  .bl-lbl {
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--dim);
  }
  .seg {
    display: inline-flex;
    margin-left: auto;
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    overflow: hidden;
  }
  .seg button {
    background: none;
    border: none;
    color: var(--muted);
    font: inherit;
    font-size: 0.68rem;
    padding: 0.16rem 0.5rem;
    cursor: pointer;
  }
  .seg button + button {
    border-left: 1px solid var(--border);
  }
  .seg button.on {
    background: rgba(95, 217, 242, 0.12);
    color: var(--accent);
  }
  .seg button:hover:not(.on) {
    color: var(--text);
  }
  /* a detector group: a category checkbox + a small secondary (collapsible) header */
  .grp-head {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    border-top: 1px solid var(--border-soft, var(--border));
    padding: 0.5rem 0 0.32rem;
  }
  .grp-check {
    flex: none;
    accent-color: var(--accent);
    width: 13px;
    height: 13px;
    margin: 0;
    cursor: pointer;
  }
  .grp-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex: 1;
    min-width: 0;
    appearance: none;
    -webkit-appearance: none;
    background: none;
    border: none;
    border-radius: 0;
    box-shadow: none;
    padding: 0;
    font: inherit;
    cursor: pointer;
    text-align: left;
    color: inherit;
  }
  .group:first-of-type .grp-head {
    border-top: 0;
    padding-top: 0.2rem;
  }
  .grpchev {
    flex: none;
    color: var(--dim);
    font-size: 0.64rem;
    transition: transform 0.15s var(--ease), color 0.12s;
  }
  .grpchev.open {
    transform: rotate(90deg);
  }
  .grp-lbl {
    flex: 1;
    font-size: 0.78rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .grp-toggle:hover .grp-lbl,
  .grp-toggle:hover .grpchev {
    color: var(--text);
  }
  .grp-sum {
    flex: none;
    font-size: 0.63rem;
    color: var(--dim);
    letter-spacing: 0.03em;
    font-variant-numeric: tabular-nums;
  }
  .checks {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .checks li {
    border-bottom: 1px solid var(--border-soft, var(--border));
  }
  .checks li:last-child {
    border-bottom: 0;
  }
  .sec-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
    color: inherit;
  }
  .sec-head .side-h {
    margin: 0;
    flex: 1;
  }
  .schev {
    flex: none;
    color: var(--dim);
    font-size: 0.62rem;
    transition: transform 0.15s var(--ease), color 0.12s;
  }
  .schev.open {
    transform: rotate(90deg);
  }
  .sec-head:hover .schev {
    color: var(--text);
  }
  .sum {
    font-size: 0.7rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
  }
  .sum.pend {
    color: var(--accent);
  }
  .penddot {
    flex: none;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
    opacity: 0.85;
  }
  label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.42rem 0;
    cursor: pointer;
    font-size: 0.78rem;
    color: var(--text);
  }
  input[type="checkbox"] {
    accent-color: var(--accent);
    width: 13px;
    height: 13px;
    margin: 0;
    cursor: pointer;
    flex: none;
  }
  .lbl {
    flex: 1;
    letter-spacing: 0.01em;
  }
  .cnt {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    font-size: 0.72rem;
  }
  /* check label + info toggle share one row; label flexes, ⓘ sits at the right edge */
  .row {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .row label {
    flex: 1;
    min-width: 0;
  }
  .info-btn {
    flex: none;
    background: none;
    border: none;
    padding: 0 0.1rem;
    cursor: pointer;
    color: var(--dim);
    font-size: 0.8rem;
    line-height: 1;
    transition: color 0.12s;
  }
  .info-btn:hover {
    color: var(--text);
  }
  .info-btn.open {
    color: var(--accent);
  }
  /* long-form description, indented to line up with the threshold slider */
  .info {
    margin: -0.05rem 0 0.5rem;
    padding: 0.1rem 0.2rem 0.4rem 1.35rem;
    font-size: 0.705rem;
    line-height: 1.5;
    color: var(--muted);
    letter-spacing: 0.01em;
  }
  /* anomaly flag-threshold slider, tucked under its check row */
  .thresh {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0 0.45rem 1.35rem;
    margin-top: -0.12rem;
  }
  .thresh .tlbl {
    font-size: 0.68rem;
    color: var(--muted);
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }
  .thresh input[type="range"] {
    flex: 1;
    min-width: 0;
    accent-color: var(--accent);
    height: 13px;
    cursor: pointer;
  }
  .thresh .tval {
    color: var(--text);
    font-variant-numeric: tabular-nums;
    font-size: 0.72rem;
    min-width: 2.1ch;
    text-align: right;
  }
  li.off .thresh {
    opacity: 0.5;
  }
  /* a disabled technique dims, so it reads as "not contributing" */
  li.off label {
    color: var(--muted);
  }
  li.off .cnt {
    opacity: 0.5;
  }
  .hint {
    margin: 0.5rem 0 0;
    font-size: 0.68rem;
    color: var(--muted);
    letter-spacing: 0.02em;
  }
  .union {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin: 0.65rem 0 0;
    padding-top: 0.55rem;
    border-top: 1px solid var(--border);
    font-size: 0.72rem;
    color: var(--muted);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .union b {
    color: var(--text);
    font-size: 0.92rem;
    font-variant-numeric: tabular-nums;
  }
  .export {
    margin-top: 0.55rem;
    width: 100%;
    background: none;
    border: 1px solid var(--border);
    color: var(--accent);
    border-radius: var(--r-xs);
    padding: 0.32rem 0.5rem;
    font-size: 0.72rem;
    letter-spacing: 0.02em;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }
  .export:hover {
    background: rgba(95, 217, 242, 0.07);
    border-color: rgba(95, 217, 242, 0.4);
  }
  /* read-only feature-vector panel under the GMM check */
  .featbtn {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    width: 100%;
    background: none;
    border: none;
    padding: 0.15rem 0 0.2rem 1.35rem;
    color: var(--muted);
    font-size: 0.68rem;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .featbtn:hover {
    color: var(--text);
  }
  .featchev {
    color: var(--dim);
    font-size: 0.6rem;
    transition: transform 0.15s var(--ease);
  }
  .featchev.open {
    transform: rotate(90deg);
  }
  .featlist {
    list-style: none;
    margin: 0 0 0 1.35rem;
    padding: 0;
    font-size: 0.68rem;
    font-variant-numeric: tabular-nums;
  }
  .featlist li {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.06rem 0.2rem;
    color: var(--muted);
  }
  .featlist li.psf .fn {
    color: var(--accent);
  }
  .featlist .fv {
    color: var(--text);
  }
  .featnote {
    margin: 0.25rem 0 0 1.35rem;
    font-size: 0.64rem;
    color: var(--dim);
    letter-spacing: 0.02em;
  }
</style>
