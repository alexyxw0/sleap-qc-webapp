<script>
  // THE TAB SELECTOR — always present as a column of square icons on the right edge, expanding to the
  // full labelled strip on hover. It is deliberately a SEPARATE component from the content panel
  // (Sidebar.svelte): the selector comes and goes with the pointer, while whatever you opened stays
  // docked until you close it. Merging the two is what forced the old rail to be permanently on screen
  // just to keep its content visible.
  //
  // The icons replaced an INVISIBLE 14px catch strip. Nothing marked where the tabs were, so they were
  // discoverable only by sweeping the edge and noticing something appear — and the four sections are
  // the app's whole navigation. Always-visible icons cost 2.6rem of gutter (reserved in App.svelte, so
  // they never overlay content) and make the sections both findable and clickable without expanding.
  //
  // Owns: the edge catch-strip, hover/pin, the file header, and the tab buttons. Owns NO content.
  import { store } from "../labelsStore.svelte.js";
  import { qc } from "../qcStore.svelte.js";
  import { ui } from "../uiStore.svelte.js";

  const BLOCKS = ui.constructor.BLOCKS;
  // One glyph per section, chosen to be distinct in SHAPE at 1rem rather than to be literal — at this
  // size an outline of a thing is a smudge, while a filled square, a tick, a ring and bars are not.
  const ICON = { frame: "▣", checks: "✓", appearance: "◉", analysis: "▤" };

  let hideTimer = null;
  // Small close delay: overshooting the edge or crossing a gap shouldn't slam the selector shut.
  function enter() { clearTimeout(hideTimer); ui.setRailHover(true); }
  function leave() { clearTimeout(hideTimer); hideTimer = setTimeout(() => ui.setRailHover(false), 260); }

  // Badges are computed HERE rather than passed down, so the selector needs nothing from the panel —
  // that independence is the point of the split.
  const enabledChecks = $derived(Object.values(qc.checks).filter(Boolean).length);
  const instanceCount = $derived(store.current?.lf?.instances?.length ?? 0);
  const frameCount = $derived(store.frames?.length ?? 0);
  const APPEARANCE = ["dino", "nodeDino", "noseAppearance"];
  const appearanceReady = $derived(APPEARANCE.some((k) => qc.checkReady(k)));
  function badge(id) {
    // Frame covers the file and this frame's instances, so it shows what's on screen now.
    if (id === "frame") return `${instanceCount} inst`;
    if (id === "checks") return `${enabledChecks} on`;
    // Appearance is only meaningful once something has been computed/loaded.
    if (id === "appearance") return appearanceReady ? "ready" : "needs compute";
    if (id === "analysis") return qc.hasResults ? `${qc.flaggedFrameCount} flagged` : "after a run";
    return null;
  }
</script>

<!-- The always-visible strip. It is the hover catcher AND a usable control: clicking an icon opens
     that section without waiting for the panel to slide out. -->
<nav class="mini" onpointerenter={enter} onpointerleave={leave} aria-label="Sections">
  {#each BLOCKS as b (b.id)}
    {@const on = ui.isBlockOpen(b.id)}
    <button type="button" class="mbtn" class:open={on} aria-pressed={on}
            title="{b.title} — {b.hint}" onclick={() => ui.toggleBlock(b.id)}>
      <span class="mico" aria-hidden="true">{ICON[b.id] ?? "▪"}</span>
      <span class="mlbl">{b.title}</span>
    </button>
  {/each}
</nav>

<aside class="tabs" class:open={ui.railOpen} onpointerenter={enter} onpointerleave={leave}
       aria-label="Sections">
  <header class="head">
    <span class="dot"></span>
    <div class="title" title={store.fileName}>{store.fileName}</div>
    <button class="ghost" class:on={ui.railPinned} onclick={() => ui.togglePin()}
            title={ui.railPinned ? "Unpin — hide when the pointer leaves" : "Pin the selector open"}>
      {ui.railPinned ? "📌" : "📍"}</button>
    <button class="ghost" onclick={() => store.reset()} title="Close file">✕</button>
  </header>

  {#each BLOCKS as b (b.id)}
    {@const on = ui.isBlockOpen(b.id)}
    <button type="button" class="block" class:open={on} title={b.hint} aria-pressed={on}
            onclick={() => ui.toggleBlock(b.id)}>
      <span class="btitle">{b.title}</span>
      {#if badge(b.id) != null}<span class="bbadge">{badge(b.id)}</span>{/if}
    </button>
  {/each}

  {#if ui.activeBlock}
    <button class="clear" onclick={() => ui.collapseAll()} title="Close the open panel">✕ close panel</button>
  {/if}
</aside>

<style>
  /* Always on screen. App.svelte reserves exactly --rail-mini so this never covers content. */
  .mini {
    position: fixed;
    top: 0; right: 0; bottom: 0;
    z-index: 60;
    width: var(--rail-mini);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 0.5rem 0;
    background: var(--panel, #12161b);
    border-left: 1px solid var(--border);
  }
  .mbtn {
    width: 2rem; height: 2rem;
    display: grid; place-items: center;
    border: none; border-radius: 7px;
    background: transparent;
    color: var(--dim);
    font-size: 0.95rem;
    line-height: 1;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }
  .mbtn:hover { background: rgba(255, 255, 255, 0.06); color: var(--text); }
  .mbtn.open { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
  /* The label exists for screen readers and is never shown — the expanded strip carries the words. */
  .mlbl {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip-path: inset(50%); white-space: nowrap;
  }
  /* Sits ABOVE the docked content panel so it can overlay it while you pick. */
  .tabs {
    position: fixed;
    top: 0; right: 0; bottom: 0;
    z-index: 61;
    width: 15.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.5rem;
    background: var(--panel, #12161b);
    border-left: 1px solid var(--border);
    box-shadow: -14px 0 34px rgba(0, 0, 0, 0.45);
    transform: translateX(100%);
    transition: transform 160ms ease;
    pointer-events: none;   /* parked off-screen: never intercept a click */
  }
  .tabs.open { transform: translateX(0); pointer-events: auto; }
  @media (prefers-reduced-motion: reduce) { .tabs { transition: none; } }

  .head { display: flex; align-items: center; gap: 0.35rem; margin-bottom: 0.2rem; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; }
  .title {
    flex: 1 1 auto; min-width: 0; font-size: 0.64rem; color: var(--muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .ghost { background: none; border: none; color: var(--dim); cursor: pointer; font-size: 0.66rem; padding: 0 0.15rem; }
  .ghost:hover, .ghost.on { color: var(--accent); }

  /* Borderless by design: outlines on every row turned the stack into a grid of boxes. State is carried
     by FILL and weight instead, which is quieter at rest and unmistakable when active. A softer radius
     than the instrument chrome (--r-xs = 2px) is the main "modern" signal. */
  .block {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.7rem 0.75rem;
    background: transparent;
    border: none;
    border-radius: 8px;
    color: var(--muted);
    font-size: 0.78rem;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }
  .block:hover { background: rgba(255, 255, 255, 0.05); color: var(--text); }
  .block.open {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent);
    font-weight: 600;
  }
  .block.open:hover { background: color-mix(in srgb, var(--accent) 20%, transparent); }
  .btitle { flex: 1 1 auto; }
  .bbadge {
    flex: none; font-size: 0.58rem; color: var(--dim);
    padding: 0.06rem 0.4rem; border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
  }
  .block.open .bbadge { background: color-mix(in srgb, var(--accent) 22%, transparent); color: var(--accent); }
  .clear {
    margin-top: auto; background: transparent; border: none; border-radius: 8px;
    color: var(--dim); font-size: 0.62rem; padding: 0.45rem; cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }
  .clear:hover { background: rgba(252, 165, 165, 0.1); color: #fca5a5; }
</style>
