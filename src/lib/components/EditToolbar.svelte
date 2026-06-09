<script>
  import { store } from "../labelsStore.svelte.js";
  import { edit } from "../editStore.svelte.js";
</script>

<div class="toolbar">
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
      instance #{edit.selInstance}{edit.selNode >= 0 ? ` · ${store.skeleton?.nodeNames?.[edit.selNode] ?? edit.selNode}` : ""}
      <span class="keys">drag = move · V = show/hide · Esc = deselect</span>
    {:else}
      <span class="keys">click a point to select · drag to move · ⌘/Ctrl+Z to undo</span>
    {/if}
  </div>

  <div class="spacer"></div>

  <div class="group save">
    {#if edit.dirty}<span class="dot" title="Unsaved changes"></span>{/if}
    <button onclick={() => edit.save({ embed: false })} disabled={edit.saving} title="Download edited labels as .slp">
      {edit.saving ? "Saving…" : "⤓ Save .slp"}
    </button>
    {#if store.hasEmbedded}
      <button onclick={() => edit.save({ embed: true })} disabled={edit.saving} title="Download as .pkg.slp with embedded frames">
        ⤓ .pkg.slp
      </button>
    {/if}
  </div>
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.6rem;
    background: #10151d;
    border: 1px solid #1d2632;
    border-radius: 10px;
  }
  .group {
    display: flex;
    gap: 0.35rem;
  }
  .sep {
    width: 1px;
    align-self: stretch;
    background: #1d2632;
    margin: 0.1rem 0.15rem;
  }
  .spacer {
    flex: 1;
  }
  button {
    background: #1a212c;
    color: #d7dee8;
    border: 1px solid #2a3442;
    border-radius: 7px;
    padding: 0.35rem 0.6rem;
    font-size: 0.82rem;
    cursor: pointer;
    white-space: nowrap;
  }
  button:hover:not(:disabled) {
    background: #222b38;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  button.danger:hover:not(:disabled) {
    background: #3a1f27;
    border-color: #5a3540;
    color: #fda4af;
  }
  .save button {
    background: var(--accent);
    color: #06121f;
    border-color: transparent;
    font-weight: 600;
  }
  .hint {
    font-size: 0.76rem;
    color: #9fb0c3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .keys {
    color: var(--muted);
    margin-left: 0.4rem;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #fbbf24;
    box-shadow: 0 0 0 3px rgba(251, 191, 36, 0.15);
  }
</style>
