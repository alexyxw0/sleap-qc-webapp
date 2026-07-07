<script>
  import { qc } from "../qcStore.svelte.js";
  import { store } from "../labelsStore.svelte.js";
  import DetectorOverlap from "./DetectorOverlap.svelte";
  import ManualCheckCompare from "./ManualCheckCompare.svelte";

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
      key: "poseSplit",
      label: "Split pose (chimera)",
      hint: "One instance whose keypoints span two animals, joined by a stretched bridging edge.",
      info: "Flags a chimera — a single labeled instance whose keypoints actually belong to two animals (head of A + body of B), joined by one abnormally-stretched bridging edge that cleanly splits the pose into two clusters. A dedicated structural check with its own threshold + bridge-node ring (it was previously folded into the GMM/anomaly vector as a feature, where it was less sensitive). The slider is the split-strength threshold. Uses learned edge-length statistics (the bridge z-score), so unlike the other two it isn't a pure hard rule. On by default.",
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
      hint: "Low-probability instance under a Gaussian-mixture density model. Usually the heaviest check — see the run-timing breakdown.",
      info: "Probabilistic counterpart to the anomaly check: it fits a Gaussian-mixture density over the same 18 features and flags poses that are rare under it (threshold 0.95 ≈ the rarest 5%). Catches subtle, multi-feature weirdness the single-feature anomaly score misses. Its EM fit is typically the heaviest step (and it needs ≥ 50 instances) — the run-timing breakdown shows exactly how long it took, so disable it if it dominates. On by default.",
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
      label: "Keypoint confidence",
      hint: "A predicted keypoint with a low confidence score (weakest or mean per instance).",
      info: "For PREDICTED labels only: flags a frame whose per-keypoint confidence (the SLEAP confidence-map peak value, 0–1) drops below the threshold. The mode toggle picks WEAKEST (the single least-confident visible keypoint — most actionable) or AVERAGE (the mean over an instance's visible keypoints). Shown only when the file has predicted instances; user-labeled instances have no scores. Off by default.",
    },
    {
      key: "instConfidence",
      label: "Instance confidence",
      hint: "A predicted instance with a low instance-level confidence score.",
      info: "For PREDICTED labels only: flags a frame containing an instance whose INSTANCE-level score (PredictedInstance.score — the model's overall confidence in that detection, distinct from the per-keypoint scores) is below the threshold. Catches whole detections the model was unsure about. Shown only when the file has predicted instances. Off by default.",
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
    { id: "geometric", label: "Geometric", hint: "Structural checks: L/R flip + chain ordering (scale-invariant hard rules) and split-pose / chimera.", keys: ["chirality", "ordering", "poseSplit"] },
    { id: "statistical", label: "Statistical", hint: "Outlier detectors that score each instance against the file's distribution (shared feature vector + baseline control). Only GMM is non-deterministic (EM fit); the z-score is deterministic.", keys: ["anomaly", "gmm"] },
    { id: "frame", label: "Frame-level", hint: "Whole-frame consistency: count, sparsity, keypoint/instance confidence, negative frames, duplicates.", keys: ["count", "sparse", "confidence", "instConfidence", "negative", "duplicates"] },
  ];

  let groupOpen = $state({ geometric: false, statistical: false, frame: false }); // per-group collapse (compact by default; each header shows "N on")
  let infoOpen = $state({}); // per-check key -> show the long-form description
  let featOpen = $state(false); // read-only "feature vector" panel under the GMM check
  let dragFeature = $state(null); // feature name currently being dragged out to the custom drop zone
  let dropHot = $state(false); // the custom drop zone is hovered during a drag
  let timingOpen = $state(false); // expand the per-step run-timing breakdown (auto-open while running)
  let overlapOpen = $state(false); // the detector-overlap viz overlay (chord / upset / euler prototypes)
  let manualOpen = $state(false); // the manual-check CSV comparison panel
  let featTimeOpen = $state(false); // expand the feature-vector step into its per-metric breakdown

  // a check is hidden when it can't apply (confidence needs predicted instances)
  const visibleInGroup = (g) =>
    g.keys.map((k) => CHECK_BY_KEY[k]).filter((c) => (c.key !== "confidence" && c.key !== "instConfidence") || !qc.hasResults || qc.hasPredictions);
</script>

{#if store.labels}
  <section class="side-section">
    <div class="sec-head">
      <span class="side-h">Detection checks</span>
      {#if qc.hasResults}
        <span class="sum">{qc.flaggedFrameCount} flagged</span>
      {:else if qc.pendingCount > 0}
        <span class="sum pend">{qc.pendingCount} to run</span>
      {/if}
    </div>

    <!-- Live run progress (during a run) → per-step timing breakdown (after) -->
    {#if qc.runProgress}
      {@const p = qc.runProgress}
      {@const running = qc.status === "running"}
      {@const totalMs = p.steps.reduce((s, x) => s + x.ms, 0)}
      {@const maxMs = Math.max(1, ...p.steps.map((s) => s.ms))}
      <div class="runtime" class:running>
        <button type="button" class="rt-head" onclick={() => (timingOpen = !timingOpen)} aria-expanded={timingOpen || running} title="Per-step QC run timing — what each check cost">
          <span class="rt-chev" class:open={timingOpen || running}>▸</span>
          {#if running}
            <span class="rt-title">Running QC · {p.done}/{p.total}</span>
          {:else}
            <span class="rt-title">⏱ QC ran in {totalMs.toFixed(0)} ms</span>
          {/if}
        </button>
        {#if running}
          <div class="rt-bar"><div class="rt-fill" style:width="{Math.round((p.done / p.total) * 100)}%"></div></div>
        {/if}
        {#if timingOpen || running}
          <ul class="rt-steps">
            {#each p.steps as s (s.key)}
              {@const hasSub = s.key === "features" && s.sub?.length}
              <li class="rt-step" class:on={s.status === "running"} class:done={s.status === "done"}>
                {#if hasSub}
                  <button type="button" class="rt-name rt-expand" onclick={() => (featTimeOpen = !featTimeOpen)} aria-expanded={featTimeOpen} title="Per-metric breakdown of the feature-vector build">
                    <span class="rt-subchev" class:open={featTimeOpen}>▸</span>{s.label}
                  </button>
                {:else}
                  <span class="rt-name">{s.label}</span>
                {/if}
                <span class="rt-track">
                  {#if s.status === "running"}<span class="rt-indet"></span>{:else if s.status === "done"}<span class="rt-meter" style:width="{Math.round((s.ms / maxMs) * 100)}%"></span>{/if}
                </span>
                <span class="rt-val">{s.status === "done" ? `${s.ms.toFixed(0)} ms` : s.status === "running" ? "…" : "·"}</span>
              </li>
              {#if hasSub && featTimeOpen}
                {@const subMax = Math.max(1, ...s.sub.map((x) => x.ms))}
                {#each s.sub as sm (sm.label)}
                  <li class="rt-step rt-substep done">
                    <span class="rt-name" title={sm.label}>{sm.label}</span>
                    <span class="rt-track"><span class="rt-meter sub" style:width="{Math.round((sm.ms / subMax) * 100)}%"></span></span>
                    <span class="rt-val">{sm.ms.toFixed(0)} ms</span>
                  </li>
                {/each}
              {/if}
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
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
                oncontextmenu={(e) => { e.preventDefault(); qc.soloChecks([c.key]); }}
                title="Right-click: solo (run only this check)"
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
                  {@const added = qc.featureChecks.some((f) => f.feature === fname)}
                  <li
                    class="featrow"
                    class:added
                    draggable={!added}
                    ondragstart={(e) => { e.dataTransfer.setData("text/plain", fname); e.dataTransfer.effectAllowed = "copy"; dragFeature = fname; }}
                    ondragend={() => (dragFeature = null)}
                    title={added ? "Already pinned as a check below" : "Drag down to the drop zone (or ＋) to flag this feature on its own"}
                  >
                    <span class="grip" aria-hidden="true">⠿</span>
                    <span class="fn">{fname}</span>
                    {#if contrib}<span class="fv">{(contrib[fname] ?? 0).toFixed(2)}</span>{/if}
                    <button type="button" class="pin" disabled={added} onclick={() => qc.addFeatureCheck(fname)} title="Pin as its own check" aria-label="Pin {fname} as a check">＋</button>
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
          {#if c.key === "poseSplit" && qc.checks.poseSplit}
            <!-- Split-strength threshold (saturating split score; higher = a clearer two-animal split). -->
            <div class="thresh" title="Flag an instance when its split-pose / chimera score is at or above this value">
              <span class="tlbl">split</span>
              <input
                type="range"
                min="0.3"
                max="0.95"
                step="0.05"
                value={qc.poseSplitThreshold}
                oninput={(e) => (qc.poseSplitThreshold = +e.currentTarget.value)}
              />
              <span class="tval">{qc.poseSplitThreshold.toFixed(2)}</span>
            </div>
          {/if}
          {#if c.key === "sparse" && qc.checks.sparse}
            <!-- Sparse cutoff auto-adapts: a fraction of the dataset's average visible-node count. -->
            <div class="thresh" title="Flag an instance with fewer visible nodes than (this fraction × the dataset's average visible-node count)">
              <span class="tlbl">min&nbsp;nodes</span>
              <input
                type="range"
                min="0.1"
                max="1"
                step="0.05"
                value={qc.sparseFraction}
                oninput={(e) => (qc.sparseFraction = +e.currentTarget.value)}
              />
              <span class="tval">&lt;&thinsp;{qc.sparseThreshold}</span>
            </div>
            <p class="thresh-note">{Math.round(qc.sparseFraction * 100)}% of the {qc.avgVisibleNodes ? `${qc.avgVisibleNodes.toFixed(1)}-node average` : "average — run QC"}</p>
          {/if}
          {#if c.key === "confidence" && qc.checks.confidence}
            <!-- Keypoint-confidence mode: the single weakest visible keypoint, or the instance mean. -->
            <div class="seg cmode">
              <button type="button" class:on={qc.confidenceMode === "min"} onclick={() => (qc.confidenceMode = "min")} title="Flag on the single least-confident visible keypoint">Weakest</button>
              <button type="button" class:on={qc.confidenceMode === "avg"} onclick={() => (qc.confidenceMode = "avg")} title="Flag on the mean confidence over an instance's visible keypoints">Average</button>
            </div>
            <div class="thresh" title="Flag a predicted instance whose {qc.confidenceMode === 'avg' ? 'mean' : 'weakest'} keypoint confidence is below this">
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
          {#if c.key === "instConfidence" && qc.checks.instConfidence}
            <!-- Instance-level (PredictedInstance.score) confidence threshold. -->
            <div class="thresh" title="Flag a predicted instance whose instance-level score is below this">
              <span class="tlbl">min&nbsp;score</span>
              <input
                type="range"
                min="0.05"
                max="0.95"
                step="0.05"
                value={qc.instConfidenceThreshold}
                oninput={(e) => (qc.instConfidenceThreshold = +e.currentTarget.value)}
              />
              <span class="tval">&lt;&thinsp;{qc.instConfidenceThreshold.toFixed(2)}</span>
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
              oncontextmenu={(e) => { e.preventDefault(); qc.soloChecks(visKeys); }}
              title="{allOn ? 'Disable' : 'Enable'} all {g.label.toLowerCase()} checks · right-click: solo this group"
              aria-label="Toggle all {g.label} checks"
            />
          </div>
          {#if groupOpen[g.id]}
            {#if g.id === "statistical" && (!qc.hasResults || (qc.hasPredictions && qc.hasUserInstances))}
              <div class="baseline" title="Which instances define the 'normal' reference the Anomaly / GMM outlier checks score against">
                <span class="bl-lbl">outlier baseline</span>
                <div class="seg">
                  <button type="button" class:on={qc.baselineSource === "all"} onclick={() => qc.setBaselineSource("all")}>All frames</button>
                  <button type="button" class:on={qc.baselineSource === "user"} onclick={() => qc.setBaselineSource("user")} title="Fit the reference on user-annotated instances only (cleaner ground truth)">User only</button>
                </div>
              </div>
            {/if}
            <ul class="checks">
              {#each visible as c (c.key)}
                {@render checkRow(c)}
              {/each}
            </ul>
            {#if g.id === "statistical"}
              {@const nOn = qc.featureChecks.filter((f) => f.on).length}
              <!-- Custom per-feature checks: pick from the dropdown, or drag a feature out of the vector above -->
              <div class="custom">
                <div class="grp-head">
                  <span class="grpchev" style="visibility:hidden">▸</span>
                  <span class="grp-lbl">Custom · per-feature</span>
                  {#if nOn}<span class="grp-sum">{nOn} on</span>{/if}
                </div>
                {#if qc.vectorFeatures.length}
                  <select
                    class="featadd"
                    onchange={(e) => { const v = e.currentTarget.value; if (v) { qc.addFeatureCheck(v); e.currentTarget.value = ""; } }}
                    title="Add a per-feature |z| check"
                  >
                    <option value="">＋ add a feature check…</option>
                    {#each qc.vectorFeatures.filter((vf) => !qc.featureChecks.some((c) => c.feature === vf)) as vf (vf)}
                      <option value={vf}>{vf.replace(/_zscore$/, "")}</option>
                    {/each}
                  </select>
                {/if}
                <div
                  class="dropzone"
                  class:armed={dragFeature}
                  class:hot={dropHot}
                  ondragenter={(e) => { e.preventDefault(); dropHot = true; }}
                  ondragover={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; dropHot = true; }}
                  ondragleave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) dropHot = false; }}
                  ondrop={(e) => { e.preventDefault(); dropHot = false; const f = e.dataTransfer.getData("text/plain"); if (f) qc.addFeatureCheck(f); }}
                  role="group"
                  aria-label="Custom feature-check drop zone"
                >
                  {#if !qc.vectorFeatures.length}
                    <p class="dz-hint">Run QC, then add per-feature <i>|z|</i> checks here.</p>
                  {:else if !qc.featureChecks.length}
                    <p class="dz-hint">⊹ pick a feature above, or drag one from the vector<br /><span class="dz-sub">to flag it on its own</span></p>
                  {/if}
                  {#each qc.featureChecks as f (f.id)}
                    {@const ready = qc.checkReady("anomaly")}
                    <div class="fcheck" class:off={!f.on}>
                      <div class="fc-head">
                        <input type="checkbox" class="grp-check" checked={f.on} onchange={() => qc.toggleFeatureCheck(f.id)} oncontextmenu={(e) => { e.preventDefault(); qc.soloFeatureCheck(f.id); }} title="Enable / disable · right-click: solo" />
                        <span class="fc-name" title={f.feature}>{f.feature.replace(/_zscore$/, "")}</span>
                        {#if ready}<span class="cnt">{qc.featureCheckCount(f.id)}</span>{/if}
                        <button type="button" class="fc-del" onclick={() => qc.removeFeatureCheck(f.id)} title="Remove this check" aria-label="Remove {f.feature}">×</button>
                      </div>
                      <div class="thresh" title="Flag an instance when this feature's |z| is at or above this value">
                        <span class="tlbl">|z|&nbsp;≥</span>
                        <input type="range" min="1" max="6" step="0.25" value={f.threshold} oninput={(e) => qc.setFeatureThreshold(f.id, +e.currentTarget.value)} />
                        <span class="tval">{f.threshold.toFixed(2)}</span>
                      </div>
                    </div>
                  {/each}
                  {#if qc.featureChecks.length}
                    <p class="dz-foot" class:hot={dropHot}>{dropHot ? "↓ drop to add" : "drag another feature here"}</p>
                  {/if}
                </div>
              </div>
            {/if}
          {/if}
        </div>
      {/if}
    {/each}
    {#if qc.hasResults}
      <p class="union">
        <span>flagged · union</span><b>{qc.flaggedFrameCount}</b>
      </p>
      <button class="export" onclick={() => (overlapOpen = !overlapOpen)} title="See what % each detector flags + where they overlap">
        ⊞ Detector overlap {overlapOpen ? "▴" : "▾"}
      </button>
      {#if overlapOpen}
        <div class="ovl-inline"><DetectorOverlap /></div>
      {/if}
      <button class="export" onclick={() => (manualOpen = !manualOpen)} title="Upload a manual faulty/not-faulty review CSV and compare it against the QC checker">
        ✓ Manual-check comparison {manualOpen ? "▴" : "▾"}
      </button>
      {#if manualOpen}
        <div class="ovl-inline"><ManualCheckCompare /></div>
      {/if}
    {/if}
    {#if qc.canExportCsv}
      <button class="export" onclick={() => qc.downloadCsv()} title="Download per-instance QC scores + features as a CSV">
        ⤓ Export results (CSV)
      </button>
    {/if}
    {#if qc.pendingCount > 0}
      <p class="hint">
        {qc.pendingCount} selected check{qc.pendingCount === 1 ? "" : "s"} need{qc.pendingCount === 1 ? "s" : ""} a run
      </p>
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
  /* keypoint-confidence Weakest/Average toggle — indented under the check, not pushed right */
  .seg.cmode {
    margin: 0 0 0.45rem 1.35rem;
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
  }
  .sec-head .side-h {
    margin: 0;
    flex: 1;
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
  /* run-timing: live progress bar during a run, per-step breakdown after */
  .runtime {
    margin: 0 0 0.6rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.02);
    overflow: hidden;
  }
  .runtime.running {
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  }
  .rt-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    background: none;
    border: none;
    padding: 0.4rem 0.55rem;
    color: var(--text);
    font-size: 0.72rem;
    cursor: pointer;
    text-align: left;
  }
  .rt-chev {
    color: var(--dim);
    font-size: 0.6rem;
    transition: transform 0.15s var(--ease);
  }
  .rt-chev.open {
    transform: rotate(90deg);
  }
  .rt-title {
    font-variant-numeric: tabular-nums;
  }
  .runtime.running .rt-title {
    color: var(--accent);
  }
  .rt-bar {
    height: 3px;
    background: var(--border);
    overflow: hidden;
  }
  .rt-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s var(--ease);
  }
  .rt-steps {
    list-style: none;
    margin: 0;
    padding: 0.2rem 0.55rem 0.5rem;
    font-size: 0.66rem;
    font-variant-numeric: tabular-nums;
  }
  .rt-step {
    display: grid;
    grid-template-columns: 1fr 3rem 3.5rem;
    align-items: center;
    gap: 0.45rem;
    padding: 0.12rem 0;
    color: var(--muted);
  }
  .rt-step.on {
    color: var(--accent);
  }
  .rt-step.done {
    color: var(--text);
  }
  .rt-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rt-track {
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }
  .rt-meter {
    display: block;
    height: 100%;
    background: color-mix(in srgb, var(--accent) 55%, transparent);
    border-radius: 2px;
    transition: width 0.2s var(--ease);
  }
  .rt-meter.sub {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  /* The feature-vector row expands into a per-metric breakdown. */
  .rt-expand {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rt-expand:hover {
    color: var(--accent);
  }
  .rt-subchev {
    flex: none;
    font-size: 0.55rem;
    transition: transform 0.15s var(--ease);
  }
  .rt-subchev.open {
    transform: rotate(90deg);
  }
  .rt-substep {
    color: var(--dim);
  }
  .rt-substep .rt-name {
    padding-left: 0.9rem; /* indent the metrics under the feature-vector row */
  }
  /* Indeterminate bar for the running step. Animates `transform` (GPU-composited), so it keeps
     sliding on the compositor thread even while that step's synchronous compute blocks the main
     thread — a live "working" cue when there's no real intra-step progress to report. */
  .rt-indet {
    display: block;
    height: 100%;
    width: 35%;
    background: var(--accent);
    border-radius: 2px;
    will-change: transform;
    animation: rt-indet 1.1s ease-in-out infinite;
  }
  @keyframes rt-indet {
    0% { transform: translateX(-115%); }
    100% { transform: translateX(315%); }
  }
  .rt-val {
    text-align: right;
    white-space: nowrap;
    color: var(--dim);
  }
  .rt-step.done .rt-val {
    color: var(--muted);
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
  .thresh-note {
    margin: 0.15rem 0 0;
    font-size: 0.64rem;
    color: var(--dim);
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
  .featlist .featrow {
    align-items: center;
    cursor: grab;
    border-radius: var(--r-xs);
  }
  .featlist .featrow:hover {
    background: rgba(255, 255, 255, 0.04);
    color: var(--text);
  }
  .featlist .featrow.added {
    cursor: default;
    opacity: 0.45;
  }
  .featlist .featrow .fn {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .grip {
    flex: none;
    color: var(--dim);
    font-size: 0.66rem;
    cursor: grab;
  }
  .pin {
    flex: none;
    background: none;
    border: none;
    color: var(--accent);
    font-size: 0.92rem;
    line-height: 1;
    padding: 0 0.1rem;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s;
  }
  .featrow:hover .pin {
    opacity: 0.9;
  }
  .pin:disabled {
    color: var(--dim);
    opacity: 0.25;
    cursor: default;
  }
  .featlist .fv {
    flex: none;
    color: var(--text);
  }
  .featnote {
    margin: 0.25rem 0 0 1.35rem;
    font-size: 0.64rem;
    color: var(--dim);
    letter-spacing: 0.02em;
  }
  /* --- custom per-feature checks (drag-and-drop) --- */
  .featadd {
    width: 100%;
    margin: 0.1rem 0 0.35rem;
    padding: 0.3rem 0.4rem;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    font-size: 0.72rem;
    cursor: pointer;
  }
  .featadd:hover {
    border-color: var(--accent);
  }
  .dropzone {
    margin: 0.1rem 0 0;
    border: 1px dashed var(--border);
    border-radius: 6px;
    padding: 0.35rem 0.4rem;
    transition: border-color 0.15s, background 0.15s;
  }
  .dropzone.armed {
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .dropzone.hot {
    border-color: var(--accent);
    border-style: solid;
    background: rgba(95, 217, 242, 0.08);
  }
  .dz-hint {
    margin: 0;
    padding: 0.45rem 0.2rem;
    text-align: center;
    font-size: 0.68rem;
    color: var(--dim);
    line-height: 1.5;
  }
  .dz-sub {
    font-size: 0.62rem;
    opacity: 0.8;
  }
  .dz-foot {
    margin: 0.3rem 0 0;
    text-align: center;
    font-size: 0.62rem;
    letter-spacing: 0.04em;
    color: var(--dim);
  }
  .dz-foot.hot {
    color: var(--accent);
  }
  .fcheck {
    border-top: 1px solid var(--border-soft, var(--border));
    padding-top: 0.32rem;
  }
  .fcheck:first-child {
    border-top: 0;
  }
  .fc-head {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }
  .fc-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.76rem;
    color: var(--text);
    letter-spacing: 0.01em;
  }
  .fcheck.off .fc-name {
    color: var(--muted);
  }
  .fc-del {
    flex: none;
    background: none;
    border: none;
    color: var(--dim);
    font-size: 0.95rem;
    line-height: 1;
    padding: 0 0.15rem;
    cursor: pointer;
  }
  .fc-del:hover {
    color: #fb7185;
  }
  .ovl-inline {
    margin-top: 0.5rem;
    padding: 0.6rem 0.5rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    background: rgba(255, 255, 255, 0.015);
  }
</style>
