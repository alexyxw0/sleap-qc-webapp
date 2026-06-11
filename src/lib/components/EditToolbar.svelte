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
    <svg class="logo" viewBox="0 0 24 24" aria-hidden="true">
      <!-- viewfinder reticle around a pose node -->
      <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square">
        <path d="M3 7.5V3h4.5M16.5 3H21v4.5M21 16.5V21h-4.5M7.5 21H3v-4.5" />
        <path d="M12 12 8 16.5M12 12l4.5-2.5" opacity="0.7" />
      </g>
      <g fill="currentColor">
        <circle cx="12" cy="12" r="2" />
        <circle cx="8" cy="16.5" r="1.3" />
        <circle cx="16.5" cy="9.5" r="1.3" />
      </g>
    </svg>
    <span class="wordmark">SLEAP<b>·QC</b></span>
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
      FLAGGED <b>{qc.flaggedFrameCount}</b>{qc.stale ? " ·" : ""}
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
    {edit.saving ? "SAVING…" : "SAVE .SLP"}
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
    padding: 0.45rem 0.75rem;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0 0.3rem 0 0.1rem;
  }
  .logo {
    width: 20px;
    height: 20px;
    color: var(--accent);
  }
  .wordmark {
    font-weight: 700;
    font-size: 0.84rem;
    letter-spacing: 0.08em;
    color: var(--text);
  }
  .wordmark b {
    color: var(--accent);
    font-weight: 700;
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
    border-radius: var(--r-xs);
    color: var(--muted);
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
    background: rgba(95, 217, 242, 0.08);
    color: var(--accent);
    border: 1px solid rgba(95, 217, 242, 0.3);
    border-radius: var(--r-xs);
    padding: 0.1rem 0.5rem;
    font-weight: 600;
    font-size: 0.7rem;
    margin-left: 0.3rem;
    white-space: nowrap;
  }

  .run {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: none;
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: var(--r-xs);
    padding: 0.3rem 0.7rem;
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
  }
  .run:hover:not(:disabled) {
    color: var(--accent);
    border-color: rgba(95, 217, 242, 0.45);
    background: rgba(95, 217, 242, 0.06);
  }

  .qcstat {
    font-size: 0.66rem;
    letter-spacing: 0.1em;
    color: var(--dim);
    white-space: nowrap;
    padding: 0 0.25rem;
  }
  .qcstat b {
    color: var(--warn);
    font-weight: 700;
    font-size: 0.76rem;
    letter-spacing: 0;
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
    font-size: 0.66rem;
    color: var(--muted);
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: var(--r-xs);
    padding: 0.12rem 0.4rem;
    transition: color 0.12s, border-color 0.12s;
  }
  .cmdk:hover kbd {
    color: var(--accent);
    border-color: rgba(95, 217, 242, 0.4);
  }

  .dot {
    width: 7px;
    height: 7px;
    background: var(--warn);
    margin-right: 0.35rem;
    animation: pulse-soft 2s ease-in-out infinite;
    flex: none;
  }

  .primary {
    background: var(--accent);
    color: #04181d;
    border: none;
    border-radius: var(--r-xs);
    padding: 0.34rem 0.8rem;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    transition: filter 0.12s;
  }
  .primary:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  .ghost {
    background: none;
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: var(--r-xs);
    padding: 0.32rem 0.7rem;
    font-size: 0.72rem;
    font-weight: 600;
    transition: color 0.12s, border-color 0.12s, background 0.12s;
  }
  .ghost:hover:not(:disabled) {
    color: var(--accent);
    border-color: rgba(95, 217, 242, 0.4);
    background: rgba(95, 217, 242, 0.05);
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
