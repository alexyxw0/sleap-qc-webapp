<script>
  import { qc } from "../qcStore.svelte.js";
  import { store } from "../labelsStore.svelte.js";
  import DetectorOverlap from "./DetectorOverlap.svelte";
  import ManualCheckCompare from "./ManualCheckCompare.svelte";
  import EmbeddingCheck from "./EmbeddingCheck.svelte";
  import NodeEmbeddingCheck from "./NodeEmbeddingCheck.svelte";
  import NoseCheck from "./NoseCheck.svelte";
  import { embeddingStores } from "../embeddingStore.svelte.js";

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
      hint: "Whole-instance L/R mirror flip — symmetric pairs (Ear_L/Ear_R) on the wrong side of the midline.",
      info: "A mirror flip preserves edge lengths and angles, so Anomaly/GMM can't see it — this is the dedicated signed-side test. Scale-invariant; auto-disables without symmetric pairs. On by default.",
    },
    {
      key: "ordering",
      label: "Chain ordering",
      hint: "Keypoints labeled out of order along a chain (tail / spine / limb).",
      info: "Flags a chain with sharp turns or self-crossings — a keypoint-order swap. Deterministic + scale-invariant; slider = order-inversion rate, a crossing always flags. Off by default (experimental).",
    },
    {
      key: "poseSplit",
      label: "Split pose (chimera)",
      hint: "One instance whose keypoints span two animals, joined by a stretched bridge edge.",
      info: "Flags a chimera — one instance covering two animals (head of A + body of B), split by an over-stretched bridge edge. Uses learned edge-length stats; slider = split strength. On by default.",
    },
    {
      key: "anomaly",
      label: "Anomaly",
      hint: "Geometrically unusual instance vs the rest of the file.",
      info: "Builds an 18-feature geometric descriptor per instance (edges, angles, areas, symmetry, curvature…) and flags the ones whose most-extreme feature is far from the file. Slider = how extreme. On by default.",
    },
    {
      key: "gmm",
      label: "GMM (probability)",
      hint: "Low-probability instance under a Gaussian-mixture density. Usually the heaviest check.",
      info: "Fits a Gaussian mixture over the same 18 features and flags rare poses (0.95 ≈ rarest 5%) — multi-feature weirdness Anomaly misses. Heaviest step; needs ≥ 50 instances. On by default.",
    },
    {
      key: "count",
      label: "Instance count",
      hint: "Frame has the wrong number of instances.",
      info: "Flags a frame whose instance count differs from the per-video median of non-empty frames — too few (missed animal) or too many (spurious). Negative frames exempt. Off by default.",
    },
    {
      key: "sparse",
      label: "Sparse instance",
      hint: "An instance localized by too few visible nodes.",
      info: "Flags an instance with fewer than N visible nodes (slider below, default 2) — a barely-localized / off-frame instance Anomaly can dilute. Negative frames exempt. Off by default.",
    },
    {
      key: "confidence",
      label: "Keypoint confidence",
      hint: "A predicted keypoint with low confidence (weakest or mean per instance).",
      info: "PREDICTED labels only: flags a frame whose keypoint confidence drops below the threshold (mode = weakest or mean). Hidden without predicted instances. Off by default.",
    },
    {
      key: "instConfidence",
      label: "Instance confidence",
      hint: "A predicted instance with a low instance-level confidence score.",
      info: "PREDICTED labels only: flags a frame with an instance whose overall detection score is below the threshold. Hidden without predicted instances. Off by default.",
    },
    {
      key: "negative",
      label: "Negative frames",
      hint: "A negative frame that still has instances.",
      info: "A frame marked negative (no animal) should carry no instances — flags any that still do. Boolean. Off by default.",
    },
    {
      key: "duplicates",
      label: "Duplicates",
      hint: "Two instances overlapping / duplicated.",
      info: "Flags a frame with two overlapping instances (bbox IoU > 0.5, or shared nodes within ~10 px) — the same animal labeled twice. On by default.",
    },
    {
      key: "classical",
      label: "Appearance · Classical",
      hint: "Instance crop that looks unlike the rest — occlusion / mis-placement geometry can't see. Needs embeddings.",
      info: "Image (not geometry) check: flags instance crops whose fast pixel-feature embedding is unlike the file — occluded / obstructed / mis-placed. Run Classical (Whole-instance) in the Appearance panel; threshold is its z-slider. Off by default.",
    },
    {
      key: "dino",
      label: "Appearance · DINO",
      hint: "Instance crop that looks unlike the rest by the DINOv2 ViT embedding. Needs embeddings.",
      info: "Image check using the DINOv2 ViT semantic embedding — strongest on subtle differences, slower. Run DINO (Whole-instance) in the Appearance panel; threshold is its z-slider. Off by default.",
    },
    {
      key: "nodeClassical",
      label: "Per-node · Classical",
      hint: "A single keypoint whose patch is unlike that keypoint elsewhere (pixel features). Needs embeddings.",
      info: "Per-keypoint image check: flags a keypoint whose patch is unlike that same keypoint elsewhere (nose vs noses) — catches a single mis-placed / occluded node and points at it. Run Per-keypoint · Classical in the Appearance panel. Off by default.",
    },
    {
      key: "nodeDino",
      label: "Per-node · DINO",
      hint: "A single keypoint whose patch is unlike that keypoint elsewhere (DINOv2 ViT — slow). Needs embeddings.",
      info: "Per-keypoint check using the DINOv2 ViT embedding — most sensitive but slow (a pass per keypoint, minutes at full coverage). Run Per-keypoint · DINO in the Appearance panel. Off by default.",
    },
    {
      key: "noseAppearance",
      label: "Nose keypoint (trained)",
      hint: "A mislabeled NOSE, from the trained DINO detector (per-project). Upload precomputed embeddings to enable.",
      info: "The validated per-keypoint appearance detector (CV ROC ~0.92): scores each nose patch with a calibrated RBF-SVM trained on proofread labels and flags likely-mislabeled noses. Uses precomputed DINO embeddings (in-browser DINO is too slow) — upload them in the Nose panel below. Off by default.",
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
    { id: "appearance", label: "Appearance", hint: "Image-embedding outliers geometry can't see — whole-instance or per-keypoint, Classical or DINO. Precompute a backend in the Appearance panel below to enable its check.", keys: ["classical", "dino", "nodeClassical", "nodeDino", "noseAppearance"] },
  ];
  // Each appearance check can only run once ITS backend's embeddings are precomputed (Appearance-outliers panel).
  const APPEARANCE_KEYS = GROUPS.find((g) => g.id === "appearance").keys;
  const isAppearance = (key) => APPEARANCE_KEYS.includes(key);
  // Which mode + backend (in the single Appearance panel) unlocks each check (drives the "locked" hint).
  const APPEARANCE_SRC = {
    classical: { backend: "Classical", mode: "Whole instance" },
    dino: { backend: "DINO", mode: "Whole instance" },
    nodeClassical: { backend: "Classical", mode: "Per keypoint" },
    nodeDino: { backend: "DINO", mode: "Per keypoint" },
    noseAppearance: { backend: "upload", mode: "precomputed embeddings", upload: true },
  };
  const appLocked = $derived(Object.fromEntries(APPEARANCE_KEYS.map((k) => [k, !qc.checkReady(k)])));

  let groupOpen = $state({ geometric: false, statistical: false, frame: false }); // per-group collapse (compact by default; each header shows "N on")
  let infoOpen = $state({}); // per-check key -> show the long-form description
  let featOpen = $state(false); // read-only "feature vector" panel under the GMM check
  let dragFeature = $state(null); // feature name currently being dragged out to the custom drop zone
  let dropHot = $state(false); // the custom drop zone is hovered during a drag
  let timingOpen = $state(false); // expand the per-step run-timing breakdown (auto-open while running)
  let overlapOpen = $state(false); // the detector-overlap viz overlay (chord / upset / euler prototypes)
  let manualOpen = $state(false); // the manual-check CSV comparison panel
  let appOpen = $state(false); // the Appearance-outliers panel (holds both granularities)
  let appMode = $state("instance"); // "instance" (whole-instance crops) | "node" (per-keypoint patches)

  // Consolidated Appearance check: ONE check with three binary MODES that route to the underlying per-variant
  // store (classical / dino / nodeClassical / nodeDino / noseAppearance). Only one variant is ever enabled.
  let appModes = $state({ gran: "instance", backend: "dino", model: "live" }); // model: "live" (kNN) | "pretrained"
  function resolveAppKey(m) {
    if (m.gran === "instance") return m.backend === "classical" ? "classical" : "dino";
    return m.backend === "classical" ? "nodeClassical" : m.model === "pretrained" ? "noseAppearance" : "nodeDino";
  }
  const appKey = $derived(resolveAppKey(appModes));
  const appOn = $derived(qc.checks[appKey] === true);
  function syncAppMethod() {
    // whole-instance DINO is a single store with a knn/trained switch — keep it aligned with the Model toggle
    if (appModes.gran === "instance" && appModes.backend === "dino")
      embeddingStores.dino.setMethod(appModes.model === "pretrained" ? "trained" : "knn");
  }
  function soloAppearance(on) {
    qc.setChecks(APPEARANCE_KEYS.filter((k) => k !== appKey), false); // clear the other variants
    qc.setChecks([appKey], on); // setChecks gates on #canEnable (ready), so a not-precomputed variant stays off
    syncAppMethod();
  }
  function setAppMode(dim, val) {
    const wasOn = appOn; // capture before mutating (appKey/appOn re-derive to the NEW variant after)
    appModes[dim] = val;
    if (appModes.backend !== "dino") appModes.model = "live"; // pretrained models are DINO-only
    appMode = appModes.gran; // keep the Appearance-outliers panel granularity in sync
    if (wasOn) soloAppearance(true); // carry the "on" state to the newly-resolved variant
    else syncAppMethod();
  }
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
                disabled={isAppearance(c.key) && appLocked[c.key]}
                onchange={() => qc.toggleCheck(c.key)}
                oncontextmenu={(e) => { e.preventDefault(); qc.soloChecks([c.key]); }}
                title={isAppearance(c.key) && appLocked[c.key] ? (APPEARANCE_SRC[c.key].upload ? "Upload the precomputed nose embeddings (Nose panel below) to enable" : `Precompute first: Appearance panel below → ${APPEARANCE_SRC[c.key].mode} → ${APPEARANCE_SRC[c.key].backend}`) : "Right-click: solo (run only this check)"}
              />
            </label>
          </div>
          {#if infoOpen[c.key]}
            <p class="info">{c.info}</p>
          {/if}
          {#if isAppearance(c.key) && appLocked[c.key]}
            {#if APPEARANCE_SRC[c.key].upload}
              <p class="dino-lock">↓ In the <b>Nose (trained)</b> panel below, upload the precomputed nose embeddings to activate this check.</p>
            {:else}
              <p class="dino-lock">↓ In <b>Appearance outliers</b> below, run <b>{APPEARANCE_SRC[c.key].backend}</b> ({APPEARANCE_SRC[c.key].mode}) to activate this check.</p>
            {/if}
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
      <!-- "all on" ignores checks that CAN'T be enabled (a locked appearance backend): a locked-off
           row would pin allOn false and turn the master into a one-way switch — able to arm the
           ready check but never able to toggle the group back off. -->
      {@const enableable = visKeys.filter((k) => !(isAppearance(k) && appLocked[k]))}
      {@const allOn = enableable.length > 0 && enableable.every((k) => qc.checks[k])}
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
              checked={g.id === "appearance" ? appOn : allOn}
              indeterminate={g.id === "appearance" ? false : onCount > 0 && !allOn}
              disabled={g.id === "appearance" ? !qc.checkReady(appKey) : !enableable.length}
              onchange={() => (g.id === "appearance" ? soloAppearance(!appOn) : qc.setChecks(visKeys, !allOn))}
              oncontextmenu={(e) => { e.preventDefault(); g.id === "appearance" ? soloAppearance(true) : qc.soloChecks(visKeys); }}
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
            {#if g.id === "appearance"}
              {@const ready = qc.checkReady(appKey)}
              <div class="app-modes">
                <div class="app-seg">
                  <span class="seg-lbl">Granularity</span>
                  <div class="seg">
                    <button type="button" class:on={appModes.gran === "instance"} onclick={() => setAppMode("gran", "instance")}>Whole instance</button>
                    <button type="button" class:on={appModes.gran === "node"} onclick={() => setAppMode("gran", "node")}>Per keypoint</button>
                  </div>
                </div>
                <div class="app-seg">
                  <span class="seg-lbl">Backend</span>
                  <div class="seg">
                    <button type="button" class:on={appModes.backend === "classical"} onclick={() => setAppMode("backend", "classical")}>Classical</button>
                    <button type="button" class:on={appModes.backend === "dino"} onclick={() => setAppMode("backend", "dino")}>DINO</button>
                  </div>
                </div>
                <div class="app-seg">
                  <span class="seg-lbl">Model</span>
                  <div class="seg">
                    <button type="button" class:on={appModes.model === "live"} onclick={() => setAppMode("model", "live")}>Live · kNN</button>
                    <button type="button" class:on={appModes.model === "pretrained"} disabled={appModes.backend !== "dino"} onclick={() => setAppMode("model", "pretrained")} title={appModes.backend !== "dino" ? "Pretrained models are DINO-only" : "Trained RBF-SVM"}>Pretrained</button>
                  </div>
                </div>
                <p class="app-status">
                  {#if ready}
                    <span class="app-ok">✓ ready · {qc.checkCount(appKey)} flagged{appOn ? "" : " · enable above"}</span>
                  {:else if APPEARANCE_SRC[appKey]?.upload}
                    <span class="app-lock">↓ load the nose bundle in the panel below to enable</span>
                  {:else}
                    <span class="app-lock">↓ run <b>{APPEARANCE_SRC[appKey].backend}</b> ({APPEARANCE_SRC[appKey].mode}) in the panel below to enable</span>
                  {/if}
                </p>
              </div>
            {:else}
              <ul class="checks">
                {#each visible as c (c.key)}
                  {@render checkRow(c)}
                {/each}
              </ul>
            {/if}
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
    {#if store.ready}
      <button class="export" onclick={() => (appOpen = !appOpen)} title="Embed instance crops (whole-instance) or per-keypoint patches — flags occlusion / appearance / mis-placement errors geometry can't detect">
        ⧉ Appearance outliers {appOpen ? "▴" : "▾"}
      </button>
      {#if appOpen}
        <div class="app-mode" role="group" aria-label="Appearance granularity">
          <button class:on={appMode === "instance"} onclick={() => (appMode = "instance")} title="One embedding per whole-instance crop">Whole instance</button>
          <button class:on={appMode === "node"} onclick={() => (appMode = "node")} title="One embedding per keypoint patch — a graph for each keypoint type">Per keypoint</button>
        </div>
        <div class="ovl-inline">
          {#if appMode === "instance"}<EmbeddingCheck />{:else}<NodeEmbeddingCheck />{/if}
        </div>
      {/if}
      <NoseCheck />
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
  .seg button:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  /* consolidated Appearance check: a label + a segmented mode toggle per row */
  .app-modes {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.4rem 0.6rem 0.55rem 1.35rem;
  }
  .app-seg {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .app-seg .seg {
    margin-left: 0;
    flex: 1;
  }
  .app-seg .seg button {
    flex: 1;
    text-align: center;
  }
  .seg-lbl {
    font-size: 0.66rem;
    color: var(--muted);
    width: 4.8rem;
    flex: none;
  }
  .app-status {
    margin: 0.15rem 0 0 1.35rem;
    font-size: 0.66rem;
  }
  .app-ok { color: #39d353; }
  .app-lock { color: #e0a030; }
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
  .dino-lock {
    margin: -0.1rem 0 0.4rem;
    padding: 0 0.2rem 0 1.35rem;
    font-size: 0.64rem;
    color: var(--dim);
  }
  .dino-lock b { color: var(--accent); font-weight: 600; }
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
  /* Appearance granularity switch (whole-instance vs per-keypoint) atop the merged Appearance panel */
  .app-mode { display: inline-flex; margin-top: 0.5rem; border: 1px solid var(--border); border-radius: var(--r-xs); overflow: hidden; }
  .app-mode button { font-size: 0.66rem; color: var(--muted); background: transparent; border: none; border-right: 1px solid var(--border); padding: 0.24rem 0.6rem; cursor: pointer; }
  .app-mode button:last-child { border-right: none; }
  .app-mode button.on { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
</style>
