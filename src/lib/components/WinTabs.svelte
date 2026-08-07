<script>
  // Subtabs for a floating window. Same idea as the right-rail tabs — one pane at a time, no accordions —
  // but scoped inside a window, so the styling is lighter: an underline rather than a filled block, which
  // would fight the rail tabs for attention.
  let { tabs = [], active = "", onpick, disabled = false } = $props();
</script>

<div class="wt" role="tablist">
  {#each tabs as t (t.id)}
    <button type="button" role="tab" class:on={active === t.id} aria-selected={active === t.id}
            {disabled} title={t.hint} onclick={() => onpick?.(t.id)}>
      {t.label}{#if t.badge}<span class="b">{t.badge}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .wt {
    display: flex;
    gap: 0.15rem;
    border-bottom: 1px solid var(--border);
    margin-bottom: 0.1rem;
  }
  .wt button {
    position: relative;
    display: inline-flex;
    align-items: baseline;
    gap: 0.32rem;
    padding: 0.35rem 0.7rem;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    color: var(--dim);
    font-size: 0.7rem;
    cursor: pointer;
    transition: color 120ms ease, border-color 120ms ease;
  }
  .wt button:hover:not(:disabled) { color: var(--muted); }
  .wt button.on { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
  .wt button:disabled { opacity: 0.5; cursor: default; }
  .b {
    font-size: 0.54rem;
    padding: 0.04rem 0.32rem;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.07);
    color: var(--dim);
  }
  .wt button.on .b { background: color-mix(in srgb, var(--accent) 22%, transparent); color: var(--accent); }
  @media (prefers-reduced-motion: reduce) { .wt button { transition: none; } }
</style>
