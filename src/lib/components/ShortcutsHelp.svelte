<script>
  import { ui } from "../uiStore.svelte.js";

  const groups = [
    {
      title: "Navigate",
      keys: [
        ["← / A", "previous frame"],
        ["→ / D", "next frame"],
        ["Space", "play / pause"],
        ["N", "next flagged frame"],
        ["P", "previous flagged frame"],
      ],
    },
    {
      title: "Edit",
      keys: [
        ["click", "select point"],
        ["drag", "move selected point"],
        ["V", "show / hide point"],
        ["⌘/Ctrl-click", "show / hide a point"],
        ["Del", "delete instance"],
        ["⌘Z / ⇧⌘Z", "undo / redo"],
      ],
    },
    {
      title: "View & app",
      keys: [
        ["+ / −", "zoom in / out"],
        ["0", "reset view"],
        ["scroll", "zoom at cursor"],
        ["⌘K", "command palette"],
        ["?", "this overlay"],
      ],
    },
  ];

  function onKey(e) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "?" && !e.metaKey && !e.ctrlKey) {
      ui.toggleHelp();
      e.preventDefault();
    } else if (e.key === "Escape" && ui.helpOpen) {
      ui.helpOpen = false;
      e.preventDefault();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if ui.helpOpen}
  <div class="scrim" onpointerdown={() => (ui.helpOpen = false)}></div>
  <div class="sheet" role="dialog" aria-label="Keyboard shortcuts">
    <header>
      <h2>Keyboard shortcuts</h2>
      <button class="x" onclick={() => (ui.helpOpen = false)}>✕</button>
    </header>
    <div class="cols">
      {#each groups as g (g.title)}
        <section>
          <h3>{g.title}</h3>
          <dl>
            {#each g.keys as [k, desc] (k)}
              <dt><kbd>{k}</kbd></dt>
              <dd>{desc}</dd>
            {/each}
          </dl>
        </section>
      {/each}
    </div>
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
  .sheet {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 401;
    width: min(680px, 94vw);
    background: rgba(13, 15, 18, 0.92);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1.2rem 1.4rem 1.4rem;
    box-shadow: var(--shadow);
    /* fade-up would fill transform:none and clobber the centering translate */
    animation: sheet-in 0.16s var(--ease) both;
  }
  @keyframes sheet-in {
    from {
      opacity: 0;
      transform: translate(-50%, calc(-50% + 8px));
    }
    to {
      opacity: 1;
      transform: translate(-50%, -50%);
    }
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.9rem;
  }
  h2 {
    margin: 0;
    font-size: 0.8rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }
  .x {
    background: none;
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: 7px;
    width: 1.8rem;
    height: 1.8rem;
    cursor: pointer;
  }
  .x:hover {
    color: var(--text);
    border-color: #3a4a60;
  }
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 1.1rem;
  }
  h3 {
    margin: 0 0 0.5rem;
    font-size: 0.64rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--accent);
  }
  dl {
    margin: 0;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.4rem 0.7rem;
    align-items: center;
  }
  dt {
    margin: 0;
  }
  dd {
    margin: 0;
    color: var(--muted);
    font-size: 0.82rem;
  }
  kbd {
    font-family: inherit;
    font-size: 0.66rem;
    color: var(--text);
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: var(--r-xs);
    padding: 0.12rem 0.42rem;
    white-space: nowrap;
  }
</style>
