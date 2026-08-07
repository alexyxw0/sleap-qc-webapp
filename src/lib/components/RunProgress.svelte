<script>
  // The progress readout for an embedding run: a determinate bar plus the three numbers that actually
  // answer "should I go and do something else?" — how far in, how fast, and how long is left.
  //
  // Before the first batch lands there is no rate to report, so the bar goes indeterminate rather than
  // sitting at 0% pretending to know. Same during model download, which is untimed and not per-item.
  import { fmtEta, fmtRate } from "../appearanceRun.svelte.js";

  let { store: es, compact = false } = $props();

  const p = $derived(es?.progress ?? { done: 0, total: 0 });
  const pace = $derived(es?.pace ?? null);
  const pct = $derived(p.total ? Math.min(100, (100 * p.done) / p.total) : 0);
</script>

<div class="rp" class:compact>
  <div class="bar" class:indet={!p.total} role="progressbar"
       aria-valuenow={p.total ? Math.round(pct) : undefined} aria-valuemin="0" aria-valuemax="100">
    <i style:width={p.total ? `${pct}%` : undefined}></i>
  </div>
  <div class="line">
    {#if p.total}
      <span class="pct">{Math.round(pct)}%</span>
      <span class="cnt">{p.done.toLocaleString()} / {p.total.toLocaleString()}</span>
      <span class="sp" title="Crops embedded per second, averaged over this run">{pace ? fmtRate(pace.rate) : "—"}</span>
      <span class="eta" title="Estimated time remaining at the current rate">
        eta {pace ? fmtEta(pace.etaSec) : "—"}
      </span>
    {:else}
      <span class="cnt">{es?.message || "working…"}</span>
    {/if}
  </div>
  {#if p.total && es?.message && !compact}
    <p class="msg">{es.message}</p>
  {/if}
</div>

<style>
  .rp { display: flex; flex-direction: column; gap: 0.28rem; min-width: 0; }
  .bar {
    position: relative;
    height: 7px;
    background: rgba(255, 255, 255, 0.07);
    border-radius: 4px;
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: 4px;
    transition: width 140ms linear;
  }
  /* No total yet (model download / enumeration): sliding sweep instead of a fake 0%. */
  .bar.indet i {
    width: 33%;
    animation: sweep 1.1s ease-in-out infinite;
  }
  @keyframes sweep {
    0% { transform: translateX(-105%); }
    100% { transform: translateX(310%); }
  }
  @media (prefers-reduced-motion: reduce) {
    .bar.indet i { animation: none; width: 100%; opacity: 0.45; }
    .bar i { transition: none; }
  }
  .line {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.6rem;
    color: var(--dim);
    font-variant-numeric: tabular-nums;
  }
  .pct { color: var(--accent); font-weight: 600; }
  .cnt { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sp, .eta { flex: none; }
  .msg {
    margin: 0;
    font-size: 0.58rem;
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .compact .line { font-size: 0.56rem; gap: 0.4rem; }
</style>
