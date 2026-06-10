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
    z-index: 40;
    animation: fade-up 0.15s var(--ease) both;
  }
  .sheet {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 41;
    width: min(680px, 94vw);
    background: linear-gradient(180deg, rgba(22, 29, 41, 0.97), rgba(12, 16, 24, 0.97));
    border: 1px solid #2a3850;
    border-radius: 16px;
    padding: 1.2rem 1.4rem 1.4rem;
    box-shadow: 0 30px 80px -20px rgba(0, 0, 0, 0.85), 0 0 60px -20px rgba(125, 211, 252, 0.2);
    /* fade-up would fill transform:none and clobber the centering translate */
    animation: sheet-in 0.18s var(--ease) both;
  }
  @keyframes sheet-in {
    from {
      opacity: 0;
      transform: translate(-50%, calc(-50% + 10px)) scale(0.985);
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
    font-size: 1.05rem;
    letter-spacing: -0.01em;
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
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.09em;
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
    font-size: 0.68rem;
    color: #cdd7e3;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: 5px;
    padding: 0.12rem 0.42rem;
    white-space: nowrap;
  }
</style>
