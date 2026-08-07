<script>
  // The METHODOLOGY blurb for a computation panel, collapsed by default.
  //
  // Each appearance panel used to print two or three paragraphs of prose above its controls. It reads well
  // once and is noise every time after, and it pushed the actual controls below the fold. Folding it behind
  // a single line keeps a panel to its controls and its results — the same "minimal by default, dropdown if
  // you want more" rule the tabs follow. Shared so all three panels disclose it identically.
  let { label = "What this computes", open = false, children } = $props();
  let show = $state(open);
</script>

<div class="ex">
  <button type="button" class="ex-h" onclick={() => (show = !show)} aria-expanded={show}>
    <span class="ex-c" class:open={show}>▸</span>
    <span class="ex-l">{label}</span>
  </button>
  {#if show}
    <div class="ex-b">{@render children()}</div>
  {/if}
</div>

<style>
  .ex { margin: 0; }
  .ex-h {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    width: 100%;
    padding: 0.1rem 0;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--dim);
    font-size: 0.58rem;
    text-align: left;
  }
  .ex-h:hover { color: var(--muted); }
  .ex-c { font-size: 0.52rem; transition: transform 120ms ease; }
  .ex-c.open { transform: rotate(90deg); }
  @media (prefers-reduced-motion: reduce) { .ex-c { transition: none; } }
  .ex-l { text-transform: uppercase; letter-spacing: 0.05em; }
  /* The rule is the only chrome — a bordered card here would compete with the panel it sits inside. */
  .ex-b {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin: 0.15rem 0 0.1rem 0.18rem;
    padding: 0 0 0.1rem 0.65rem;
    border-left: 1px solid var(--border);
  }
</style>
