<script>
  import { qc } from "../qcStore.svelte.js";
  import { store } from "../labelsStore.svelte.js";

  // Each detection technique the user can include in the flagged set. Pick the ones you want
  // BEFORE running QC — only selected techniques are computed, and each result is memoized so
  // re-selecting a computed check never recomputes. The flagged frames are the UNION of the
  // enabled checks.
  const CHECKS = [
    { key: "chirality", label: "L/R flip (chirality)", hint: "Whole-instance left/right mirror flip: symmetric pairs (e.g. Ear_L/Ear_R) sitting on the wrong side of the body midline. Coordinate-only; auto-disables when the skeleton has no symmetric (or name-inferred) pairs." },
    { key: "poseSplit", label: "Split pose (chimera)", hint: "One labeled instance spanning two animals, joined by an over-stretched bridging edge (two tight clusters with a wide gap). Coordinate-only; reuses the learned edge-length stats." },
    { key: "anomaly", label: "Anomaly", hint: "Geometrically unusual instance vs. the rest of the file" },
    { key: "gmm", label: "GMM (probability)", hint: "Low-probability instance under a Gaussian-mixture density model. Heaviest check — opt-in." },
    { key: "spatial", label: "Spatial outlier", hint: "A single node sitting out of place (drives the red ring)" },
    { key: "count", label: "Instance count", hint: "Frame has fewer instances than expected" },
    { key: "negative", label: "Negative frames", hint: "A negative frame that still has instances" },
    { key: "duplicates", label: "Duplicates", hint: "Two instances overlapping / duplicated" },
  ];

  let collapsed = $state(false); // collapse the whole detection-checks block to de-clutter
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
    <ul class="checks">
      {#each CHECKS as c (c.key)}
        {@const ready = qc.checkReady(c.key)}
        {@const pending = qc.checkPending(c.key)}
        <li class:off={!qc.checks[c.key]}>
          <label title={c.hint}>
            <input
              type="checkbox"
              checked={qc.checks[c.key]}
              onchange={() => qc.toggleCheck(c.key)}
            />
            <span class="lbl">{c.label}</span>
            {#if pending}
              <span class="penddot" title="Selected — needs a Run QC to compute"></span>
            {:else if ready}
              <span class="cnt">{qc.checkCount(c.key)}</span>
            {/if}
          </label>
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
          {#if c.key === "poseSplit" && qc.checks.poseSplit}
            <!-- Chimera flag threshold (squashed split_score; 0.5 == raw split_score 1). -->
            <div class="thresh" title="Flag an instance when its chimera (split-pose) score is at or above this value">
              <span class="tlbl">threshold</span>
              <input
                type="range"
                min="0.3"
                max="0.99"
                step="0.01"
                value={qc.poseSplitThreshold}
                oninput={(e) => (qc.poseSplitThreshold = +e.currentTarget.value)}
              />
              <span class="tval">{qc.poseSplitThreshold.toFixed(2)}</span>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    {#if qc.hasResults}
      <p class="union">
        <span>flagged · union</span><b>{qc.flaggedFrameCount}</b>
      </p>
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
</style>
