<script>
  import { store } from "../labelsStore.svelte.js";
  import { edit } from "../editStore.svelte.js";
  import { qc } from "../qcStore.svelte.js";
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

  <div class="group">
    <button onclick={() => edit.undo()} disabled={!edit.canUndo} title={edit.undoLabel ? `Undo ${edit.undoLabel}` : "Nothing to undo"}>
      ↺ Undo
    </button>
    <button onclick={() => edit.redo()} disabled={!edit.canRedo} title={edit.redoLabel ? `Redo ${edit.redoLabel}` : "Nothing to redo"}>
      ↻ Redo
    </button>
  </div>

  <div class="sep"></div>

  <div class="group">
    <button onclick={() => edit.addInstance()} title="Add a new instance to this frame">＋ Instance</button>
    <button
      class="danger"
      onclick={() => edit.deleteInstance()}
      disabled={edit.selInstance < 0}
      title="Delete the selected instance (Del)"
    >
      🗑 Delete
    </button>
  </div>

  <div class="hint">
    {#if edit.selInstance >= 0}
      <span class="pill">#{edit.selInstance}{edit.selNode >= 0 ? ` · ${store.skeleton?.nodeNames?.[edit.selNode] ?? edit.selNode}` : ""}</span>
      <span class="keys">drag = move · V = show/hide · Esc = deselect</span>
    {:else}
      <span class="keys">click a point to select · drag to move · ⌘/Ctrl+Z to undo</span>
    {/if}
  </div>

  <div class="spacer"></div>

  <div class="group qc">
    <button class="run" onclick={() => qc.run()} disabled={qc.status === "running"} title="Run deterministic QC checks (anomaly + frame issues)">
      {#if qc.status === "running"}<span class="spin"></span>Running…{:else}🔍 Run QC{/if}
    </button>
    {#if qc.hasResults}
      <span class="qcstat" class:stale={qc.stale}>
        <b>{qc.flaggedFrameCount}</b> flagged{qc.stale ? " · stale" : ""}
      </span>
    {/if}
    {#if qc.status === "error"}<span class="qcstat err">QC failed</span>{/if}
  </div>

  <div class="sep"></div>

  <div class="group save">
    {#if edit.dirty}<span class="dot" title="Unsaved changes"></span>{/if}
    <button class="primary" onclick={() => edit.save({ embed: false })} disabled={edit.saving} title="Download edited labels as .slp">
      {edit.saving ? "Saving…" : "⤓ Save .slp"}
    </button>
    {#if store.hasEmbedded}
      <button class="primary ghost" onclick={() => edit.save({ embed: true })} disabled={edit.saving} title="Download as .pkg.slp with embedded frames">
        .pkg.slp
      </button>
    {/if}
  </div>
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.6rem;
    background: linear-gradient(180deg, rgba(22, 29, 41, 0.9), rgba(13, 18, 27, 0.9));
    border: 1px solid var(--border);
    border-radius: var(--r);
    box-shadow: var(--shadow-sm), inset 0 1px 0 rgba(255, 255, 255, 0.03);
    backdrop-filter: blur(8px);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.2rem 0 0.1rem;
  }
  .logo {
    width: 27px;
    height: 27px;
    filter: drop-shadow(0 4px 10px rgba(125, 211, 252, 0.45));
  }
  .wordmark {
    font-weight: 700;
    font-size: 0.92rem;
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

  .group {
    display: flex;
    gap: 0.35rem;
  }
  .sep {
    width: 1px;
    align-self: stretch;
    background: linear-gradient(transparent, var(--border), transparent);
    margin: 0.1rem 0.2rem;
  }
  .spacer {
    flex: 1;
  }

  button {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background: linear-gradient(180deg, var(--surface-3), var(--surface-2));
    color: #d7dee8;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 0.4rem 0.65rem;
    font-size: 0.82rem;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: transform 0.12s var(--ease), background 0.12s, border-color 0.12s, box-shadow 0.12s;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }
  button:hover:not(:disabled) {
    transform: translateY(-1px);
    border-color: #2f3c4e;
    background: linear-gradient(180deg, #1d2735, var(--surface-3));
  }
  button:active:not(:disabled) {
    transform: translateY(0);
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  button.danger:hover:not(:disabled) {
    background: linear-gradient(180deg, #3a1f27, #2a151b);
    border-color: #5a3540;
    color: var(--danger);
  }

  button.run {
    background: var(--violet-grad);
    border-color: transparent;
    color: #0b0a1f;
    font-weight: 650;
    box-shadow: 0 6px 18px -6px rgba(129, 140, 248, 0.55);
  }
  button.run:hover:not(:disabled) {
    filter: brightness(1.07);
    background: var(--violet-grad);
  }

  button.primary {
    background: var(--accent-grad);
    color: #06121f;
    border-color: transparent;
    font-weight: 700;
    box-shadow: var(--glow);
  }
  button.primary:hover:not(:disabled) {
    filter: brightness(1.06);
    background: var(--accent-grad);
  }
  button.primary.ghost {
    background: transparent;
    color: var(--accent);
    border: 1px solid #2c4a66;
    box-shadow: none;
    font-weight: 600;
  }
  button.primary.ghost:hover:not(:disabled) {
    background: rgba(125, 211, 252, 0.08);
  }

  .hint {
    font-size: 0.76rem;
    color: #9fb0c3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .pill {
    background: rgba(125, 211, 252, 0.14);
    color: var(--accent);
    border: 1px solid rgba(125, 211, 252, 0.25);
    border-radius: 999px;
    padding: 0.08rem 0.5rem;
    font-weight: 600;
    font-size: 0.72rem;
  }
  .keys {
    color: var(--dim);
  }

  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--warn);
    animation: pulse-soft 2s ease-in-out infinite;
  }
  .qcstat {
    font-size: 0.76rem;
    color: var(--muted);
    white-space: nowrap;
    background: rgba(125, 211, 252, 0.08);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.12rem 0.55rem;
  }
  .qcstat b {
    color: var(--text);
  }
  .qcstat.stale {
    color: var(--warn);
    border-color: rgba(251, 191, 36, 0.3);
    background: rgba(251, 191, 36, 0.08);
  }
  .qcstat.err {
    color: var(--danger);
  }

  .spin {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(11, 10, 31, 0.3);
    border-top-color: #0b0a1f;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
