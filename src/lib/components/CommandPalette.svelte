<script>
  import { store } from "../labelsStore.svelte.js";
  import { edit } from "../editStore.svelte.js";
  import { view } from "../viewStore.svelte.js";
  import { qc } from "../qcStore.svelte.js";
  import { ui } from "../uiStore.svelte.js";
  import { toast } from "../toastStore.svelte.js";

  let query = $state("");
  let sel = $state(0);
  let input = $state();

  // Focus + reset whenever the palette opens.
  $effect(() => {
    if (ui.paletteOpen) {
      query = "";
      sel = 0;
      queueMicrotask(() => input?.focus());
    }
  });

  function go(i) {
    store.setIndex(i);
  }
  function seek(dir) {
    const i = qc.seekFlagged(store.index, dir);
    if (i >= 0) go(i);
    else toast("No flagged frames", { kind: "info" });
  }

  // The action catalog is rebuilt per keystroke — it's tiny, and conditions
  // (selection, QC results, embedded video) change between openings.
  const actions = $derived.by(() => {
    const out = [];
    const n = parseInt(query.trim(), 10);
    if (Number.isFinite(n) && n >= 1 && n <= store.frameCount) {
      out.push({ icon: "→", label: `Go to frame ${n}`, kbd: "↵", always: true, run: () => go(n - 1) });
    }
    out.push(
      { icon: "◆", label: "Run QC checks", kbd: "", run: () => qc.run() },
      ...(qc.hasResults
        ? [
            { icon: "▸", label: "Next flagged frame", kbd: "N", run: () => seek(1) },
            { icon: "◂", label: "Previous flagged frame", kbd: "P", run: () => seek(-1) },
          ]
        : []),
      { icon: "＋", label: "Add instance to this frame", kbd: "", run: () => edit.addInstance() },
      ...(edit.selInstance >= 0
        ? [{ icon: "✕", label: `Delete instance #${edit.selInstance}`, kbd: "⌫", run: () => edit.deleteInstance() }]
        : []),
      ...(edit.canUndo ? [{ icon: "↺", label: `Undo ${edit.undoLabel ?? ""}`, kbd: "⌘Z", run: () => edit.undo() }] : []),
      ...(edit.canRedo ? [{ icon: "↻", label: `Redo ${edit.redoLabel ?? ""}`, kbd: "⇧⌘Z", run: () => edit.redo() }] : []),
      { icon: "⤓", label: "Save .slp", kbd: "", run: () => edit.save({ embed: false }) },
      ...(store.hasEmbedded
        ? [{ icon: "⤓", label: "Export .pkg.slp (embedded frames)", kbd: "", run: () => edit.save({ embed: true }) }]
        : []),
      { icon: "⏮", label: "First frame", kbd: "", run: () => go(0) },
      { icon: "⏭", label: "Last frame", kbd: "", run: () => go(store.frameCount - 1) },
      { icon: "⤢", label: "Reset zoom & pan", kbd: "0", run: () => view.reset() },
      { icon: "?", label: "Keyboard shortcuts", kbd: "?", run: () => ui.toggleHelp() },
      { icon: "⌫", label: "Close file", kbd: "", run: () => store.reset() },
    );
    return out;
  });

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => a.always || fuzzy(a.label.toLowerCase(), q));
  });

  // Subsequence match: every query char appears, in order.
  function fuzzy(text, q) {
    let i = 0;
    for (const ch of text) if (ch === q[i] && ++i === q.length) return true;
    return i === q.length;
  }

  $effect(() => {
    void filtered;
    if (sel >= filtered.length) sel = Math.max(0, filtered.length - 1);
  });

  function runSel(i = sel) {
    const a = filtered[i];
    if (!a) return;
    ui.closeAll();
    a.run();
  }

  function onKey(e) {
    // Global hotkey — works whether or not the palette is open.
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      ui.togglePalette();
      return;
    }
    if (!ui.paletteOpen) return;
    if (e.key === "Escape") {
      ui.closeAll();
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      sel = Math.min(filtered.length - 1, sel + 1);
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      sel = Math.max(0, sel - 1);
      e.preventDefault();
    } else if (e.key === "Enter") {
      runSel();
      e.preventDefault();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if ui.paletteOpen}
  <div class="scrim" onpointerdown={() => ui.closeAll()}></div>
  <div class="palette" role="dialog" aria-label="Command palette">
    <div class="inputrow">
      <span class="glyph">⌘</span>
      <input
        bind:this={input}
        bind:value={query}
        placeholder="Type a command, or a frame number…"
        spellcheck="false"
        oninput={() => (sel = 0)}
      />
      <kbd>esc</kbd>
    </div>
    <ul class="list">
      {#each filtered as a, i (a.label)}
        <li>
          <button class:sel={i === sel} onpointerenter={() => (sel = i)} onclick={() => runSel(i)}>
            <span class="icon">{a.icon}</span>
            <span class="label">{a.label}</span>
            {#if a.kbd}<kbd>{a.kbd}</kbd>{/if}
          </button>
        </li>
      {:else}
        <li class="empty">No matching command</li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(4, 6, 10, 0.55);
    backdrop-filter: blur(3px);
    z-index: 400; /* above the recency-layered islands (≤380) */
    animation: fade-up 0.15s var(--ease) both;
  }
  .palette {
    position: fixed;
    top: 14vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(560px, 92vw);
    z-index: 401;
    background: rgba(13, 15, 18, 0.92);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
    border: 1px solid var(--border);
    border-radius: 4px;
    box-shadow: var(--shadow);
    overflow: hidden;
    animation: palette-in 0.16s var(--ease) both;
  }
  @keyframes palette-in {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(-10px);
    }
    to {
      opacity: 1;
      transform: translateX(-50%);
    }
  }
  .inputrow {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.75rem 0.9rem;
    border-bottom: 1px solid var(--border);
  }
  .glyph {
    color: var(--accent);
    font-weight: 700;
  }
  input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--text);
    font-size: 0.98rem;
    font-family: inherit;
  }
  input::placeholder {
    color: var(--dim);
  }
  kbd {
    font-family: inherit;
    font-size: 0.66rem;
    color: var(--muted);
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: var(--r-xs);
    padding: 0.1rem 0.4rem;
    white-space: nowrap;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0.35rem;
    max-height: 46vh;
    overflow-y: auto;
  }
  .list button {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: var(--r-xs);
    color: var(--muted);
    font: inherit;
    font-size: 0.82rem;
    padding: 0.5rem 0.65rem;
    cursor: pointer;
  }
  .list button.sel {
    background: rgba(95, 217, 242, 0.07);
    color: var(--text);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .icon {
    width: 1.4rem;
    text-align: center;
    color: var(--accent);
    flex: none;
  }
  .label {
    flex: 1;
  }
  .empty {
    padding: 0.9rem;
    text-align: center;
    color: var(--dim);
    font-size: 0.85rem;
  }
</style>
