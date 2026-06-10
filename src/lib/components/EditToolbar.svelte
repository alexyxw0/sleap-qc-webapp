<script>
  import { store } from "../labelsStore.svelte.js";
  import { edit } from "../editStore.svelte.js";
  import { qc } from "../qcStore.svelte.js";
  import { ui } from "../uiStore.svelte.js";

  function seekFlagged(dir) {
    const i = qc.seekFlagged(store.index, dir);
    if (i >= 0) store.setIndex(i);
  }
</script>

<div class="toolbar">
  <div class="brand">
    <svg class="logo" viewBox="0 0 28 28" aria-hidden="true">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#7dd3fc" />
          <stop offset="1" stop-color="#818cf8" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="26" height="26" rx="8" fill="url(#lg)" />
      <g stroke="#0a0f18" stroke-width="1.6" stroke-linecap="round" opacity="0.92">
        <line x1="9" y1="9" x2="14" y2="14" />
        <line x1="14" y1="14" x2="11" y2="20" />
        <line x1="14" y1="14" x2="20" y2="11" />
      </g>
      <g fill="#0a0f18">
        <circle cx="9" cy="9" r="2.1" />
        <circle cx="14" cy="14" r="2.3" />
        <circle cx="11" cy="20" r="2.1" />
        <circle cx="20" cy="11" r="2.1" />
      </g>
    </svg>
    <span class="wordmark">SLEAP<b>QC</b></span>
  </div>

  <div class="sep"></div>

  <button class="ic" onclick={() => edit.undo()} disabled={!edit.canUndo} title={edit.undoLabel ? `Undo ${edit.undoLabel} (⌘Z)` : "Nothing to undo"} aria-label="Undo">
    <svg viewBox="0 0 16 16"><path d="M6.5 3 3 6.5 6.5 10" /><path d="M3 6.5h6a4 4 0 0 1 0 8H7" /></svg>
  </button>
  <button class="ic" onclick={() => edit.redo()} disabled={!edit.canRedo} title={edit.redoLabel ? `Redo ${edit.redoLabel} (⇧⌘Z)` : "Nothing to redo"} aria-label="Redo">
    <svg viewBox="0 0 16 16"><path d="M9.5 3 13 6.5 9.5 10" /><path d="M13 6.5H7a4 4 0 0 0 0 8h2" /></svg>
  </button>

  <div class="sep"></div>

  <button class="ic" onclick={() => edit.addInstance()} title="Add instance to this frame" aria-label="Add instance">
    <svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" /></svg>
  </button>
  <button
    class="ic danger"
    onclick={() => edit.deleteInstance()}
    disabled={edit.selInstance < 0}
    title="Delete the selected instance (Del)"
    aria-label="Delete selected instance"
  >
    <svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8.5h4.8l.6-8.5" /></svg>
  </button>

  {#if edit.selInstance >= 0}
    <span class="pill">#{edit.selInstance}{edit.selNode >= 0 ? ` · ${store.skeleton?.nodeNames?.[edit.selNode] ?? edit.selNode}` : ""}</span>
  {/if}

  <div class="spacer"></div>

  <button class="run" onclick={() => qc.run()} disabled={qc.status === "running"} title="Run QC checks (anomaly + frame issues)">
    {#if qc.status === "running"}<span class="spin"></span>Running…{:else}Run QC{/if}
  </button>
  {#if qc.hasResults}
    <span class="qcstat" class:stale={qc.stale} title={qc.stale ? "Edited since the last run — results may be stale" : ""}>
      {qc.flaggedFrameCount} flagged{qc.stale ? " ·" : ""}
    </span>
    {#if qc.flaggedFrameCount > 0}
      <button class="ic seek" onclick={() => seekFlagged(-1)} title="Previous flagged frame (P)">‹</button>
      <button class="ic seek" onclick={() => seekFlagged(1)} title="Next flagged frame (N)">›</button>
    {/if}
  {/if}
  {#if qc.status === "error"}<span class="qcstat err">QC failed</span>{/if}

  <div class="sep"></div>

  <button class="cmdk" onclick={() => ui.togglePalette()} title="Command palette">
    <kbd>⌘K</kbd>
  </button>

  <div class="sep"></div>

  {#if edit.dirty}<span class="dot" title="Unsaved changes"></span>{/if}
  <button class="primary" onclick={() => edit.save({ embed: false })} disabled={edit.saving} title="Download edited labels as .slp">
    {edit.saving ? "Saving…" : "Save .slp"}
  </button>
  {#if store.hasEmbedded}
    <button class="ghost" onclick={() => edit.save({ embed: true })} disabled={edit.saving} title="Download as .pkg.slp with embedded frames">
      .pkg.slp
    </button>
  {/if}
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.45rem 0.6rem;
    background: rgba(13, 18, 27, 0.6);
    border: 1px solid var(--border);
    border-radius: var(--r);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.3rem 0 0.1rem;
  }
  .logo {
    width: 24px;
    height: 24px;
  }
  .wordmark {
    font-weight: 700;
    font-size: 0.9rem;
    letter-spacing: 0.01em;
    color: var(--text);
  }
  .wordmark b {
    background: var(--accent-grad);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    font-weight: 800;
    margin-left: 1px;
  }

  .sep {
    width: 1px;
    height: 1.2rem;
    background: var(--border);
    margin: 0 0.35rem;
    flex: none;
  }
  .spacer {
    flex: 1;
  }

  button {
    font: inherit;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.35;
    cursor: default;
  }

  /* quiet icon buttons */
  .ic {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.9rem;
    height: 1.9rem;
    background: none;
    border: none;
    border-radius: 7px;
    color: #9fb0c3;
    transition: background 0.12s, color 0.12s;
  }
  .ic svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .ic:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.05);
    color: var(--text);
  }
  .ic.danger:hover:not(:disabled) {
    background: rgba(251, 113, 133, 0.1);
    color: var(--danger);
  }
  .ic.seek {
    width: 1.5rem;
    font-size: 0.95rem;
    font-weight: 700;
    line-height: 1;
  }

  .pill {
    background: rgba(125, 211, 252, 0.1);
    color: var(--accent);
    border-radius: 999px;
    padding: 0.12rem 0.55rem;
    font-weight: 600;
    font-size: 0.72rem;
    margin-left: 0.3rem;
    white-space: nowrap;
  }

  .run {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: none;
    border: 1px solid rgba(167, 139, 250, 0.35);
    color: var(--accent-2);
    border-radius: 8px;
    padding: 0.32rem 0.7rem;
    font-size: 0.8rem;
    font-weight: 600;
    transition: background 0.12s, border-color 0.12s;
  }
  .run:hover:not(:disabled) {
    background: rgba(167, 139, 250, 0.1);
    border-color: rgba(167, 139, 250, 0.55);
  }

  .qcstat {
    font-size: 0.76rem;
    color: var(--muted);
    white-space: nowrap;
    padding: 0 0.25rem;
    font-variant-numeric: tabular-nums;
  }
  .qcstat.stale {
    color: var(--warn);
  }
  .qcstat.err {
    color: var(--danger);
  }

  .cmdk {
    background: none;
    border: none;
    padding: 0.2rem 0.25rem;
  }
  .cmdk kbd {
    font-family: inherit;
    font-size: 0.68rem;
    color: var(--muted);
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: 5px;
    padding: 0.14rem 0.45rem;
    transition: color 0.12s, border-color 0.12s;
  }
  .cmdk:hover kbd {
    color: var(--accent);
    border-color: #2c4a66;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--warn);
    margin-right: 0.35rem;
    animation: pulse-soft 2s ease-in-out infinite;
    flex: none;
  }

  .primary {
    background: var(--accent);
    color: #06121f;
    border: none;
    border-radius: 8px;
    padding: 0.34rem 0.8rem;
    font-size: 0.8rem;
    font-weight: 700;
    transition: filter 0.12s;
  }
  .primary:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .ghost {
    background: none;
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: 8px;
    padding: 0.32rem 0.7rem;
    font-size: 0.78rem;
    font-weight: 600;
    transition: color 0.12s, border-color 0.12s, background 0.12s;
  }
  .ghost:hover:not(:disabled) {
    color: var(--accent);
    border-color: #2c4a66;
    background: rgba(125, 211, 252, 0.06);
  }

  .spin {
    width: 11px;
    height: 11px;
    border: 2px solid rgba(167, 139, 250, 0.3);
    border-top-color: var(--accent-2);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
