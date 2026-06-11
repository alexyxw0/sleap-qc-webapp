<script>
  import { qc } from "../qcStore.svelte.js";

  // Each detection technique the user can include in the flagged set. The flagged frames
  // are the UNION of the enabled checks.
  const CHECKS = [
    { key: "anomaly", label: "Anomaly", hint: "Geometrically unusual instance vs. the rest of the file" },
    { key: "spatial", label: "Spatial outlier", hint: "A single node sitting out of place (drives the red ring)" },
    { key: "count", label: "Instance count", hint: "Frame has fewer instances than expected" },
    { key: "negative", label: "Negative frames", hint: "A negative frame that still has instances" },
    { key: "duplicates", label: "Duplicates", hint: "Two instances overlapping / duplicated" },
  ];
</script>

{#if qc.hasResults}
  <section class="side-section">
    <h3 class="side-h">Detection checks</h3>
    <ul class="checks">
      {#each CHECKS as c (c.key)}
        <li class:off={!qc.checks[c.key]}>
          <label title={c.hint}>
            <input
              type="checkbox"
              checked={qc.checks[c.key]}
              onchange={() => qc.toggleCheck(c.key)}
            />
            <span class="lbl">{c.label}</span>
            <span class="cnt">{qc.checkCount(c.key)}</span>
          </label>
        </li>
      {/each}
    </ul>
    <p class="union">
      <span>flagged · union</span><b>{qc.flaggedFrameCount}</b>
    </p>
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
  /* a disabled technique dims, so it reads as "not contributing" */
  li.off label {
    color: var(--muted);
  }
  li.off .cnt {
    opacity: 0.5;
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
