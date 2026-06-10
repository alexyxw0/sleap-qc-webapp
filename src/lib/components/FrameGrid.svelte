<script>
  import { store } from "../labelsStore.svelte.js";
  import { edit } from "../editStore.svelte.js";
  import { qc, heatColor, hasFrameIssue } from "../qcStore.svelte.js";

  // A grid of discrete, clickable frame "tiles" — one per navigable frame. Virtualized:
  // only the rows currently scrolled into view are mounted, so it stays smooth even at
  // 180k frames (rendering that many real DOM nodes would freeze the page).

  const CELL = 30; // tile size (px)
  const GAP = 5;
  const PITCH = CELL + GAP;
  const PAD = 6; // .viewport padding (must match CSS)

  let viewport = $state(); // scroll container
  let viewportH = $state(240);
  let innerW = $state(280);
  let scrollTop = $state(0);

  const count = $derived(store.frameCount);
  const cols = $derived(Math.max(1, Math.floor((innerW + GAP) / PITCH)));
  const rows = $derived(Math.ceil(count / cols));
  const totalH = $derived(rows * PITCH);

  // visible row window (+2 rows overscan)
  const firstRow = $derived(Math.max(0, Math.floor(scrollTop / PITCH) - 2));
  const lastRow = $derived(Math.min(rows - 1, Math.ceil((scrollTop + viewportH) / PITCH) + 2));

  const cells = $derived.by(() => {
    const out = [];
    for (let r = firstRow; r <= lastRow; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (i >= count) break;
        out.push({ i, x: c * PITCH, y: r * PITCH });
      }
    }
    return out;
  });

  // Measure the viewport so column count / virtualization track its real size.
  $effect(() => {
    if (!viewport) return;
    const measure = () => {
      viewportH = viewport.clientHeight;
      innerW = viewport.clientWidth - 2 * PAD; // exclude padding so tiles don't clip
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(viewport);
    return () => ro.disconnect();
  });

  // Keep the selected tile in view when the frame changes from elsewhere (arrow keys,
  // slider, playback). Depends only on index/cols — it reads the live scroll position
  // off the DOM rather than the reactive `scrollTop`, so it never fights manual
  // scrolling (which would otherwise re-trigger this and yank the view back).
  $effect(() => {
    const i = store.index;
    void cols;
    if (!viewport || count === 0) return;
    const st = viewport.scrollTop;
    const vh = viewport.clientHeight;
    const y = Math.floor(i / cols) * PITCH;
    if (y < st) viewport.scrollTop = y;
    else if (y + CELL > st + vh) viewport.scrollTop = y + CELL - vh;
  });

  function jump(e) {
    const v = parseInt(e.target.value, 10);
    if (Number.isFinite(v)) store.setIndex(v - 1); // 1-based, matches the viewer counter
  }
</script>

<section class="card frames">
  <div class="head">
    <h3>Frames</h3>
    <div class="jump">
      go to
      <input
        type="number"
        min="1"
        max={count}
        value={store.index + 1}
        onchange={jump}
        aria-label="Go to frame number"
      />
      / {count}
    </div>
  </div>

  <div class="viewport" bind:this={viewport} onscroll={(e) => (scrollTop = e.target.scrollTop)}>
    <div class="canvas" style:height="{totalH}px">
      {#each cells as cell (cell.i)}
        {@const f = store.frames[cell.i]}
        {@const labeled = (f?.lf?.instances?.length ?? 0) > 0}
        {@const modified = edit.isFrameModified(f?.lf)}
        {@const qscore = qc.hasResults ? qc.frameScore(f) : null}
        {@const qissue = qc.hasResults ? hasFrameIssue(qc.frameQC(f)) : false}
        {@const qtop = qc.hasResults ? qc.frameTopIssue(f) : null}
        <button
          class="cell"
          class:current={cell.i === store.index}
          class:labeled
          class:modified
          style:left="{cell.x}px"
          style:top="{cell.y}px"
          style:width="{CELL}px"
          style:height="{CELL}px"
          title={`frame ${cell.i + 1} · video idx ${f?.frameIdx} · ${f?.lf?.instances?.length ?? 0} instance(s)${modified ? " · modified" : ""}${qscore != null ? ` · anomaly ${qscore.toFixed(2)}${qtop?.issue ? ` (${qtop.issue})` : ""}` : ""}${qissue ? " · frame issue" : ""}`}
          onclick={() => store.setIndex(cell.i)}
        >
          <span class="num">{f?.frameIdx}</span>
          {#if modified}<i class="moddot"></i>{/if}
          {#if qissue}<i class="issuedot"></i>{/if}
          {#if qscore != null}<i class="heat" style:background={heatColor(qscore)}></i>{/if}
        </button>
      {/each}
    </div>
  </div>

  <div class="legend">
    <span><i class="sw current"></i> selected</span>
    <span><i class="sw labeled"></i> has labels</span>
    <span><i class="sw mod"></i> modified</span>
    {#if qc.hasResults}
      <span><i class="sw issue"></i> QC issue</span>
      <span class="heatkey">anomaly <i class="heatbar"></i></span>
    {/if}
  </div>
</section>

<style>
  .frames {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    background: linear-gradient(180deg, rgba(20, 26, 37, 0.55), rgba(13, 18, 27, 0.55));
    border: 1px solid var(--border);
    border-radius: var(--r);
    padding: 0.85rem 0.9rem;
    box-shadow: var(--shadow-sm), inset 0 1px 0 rgba(255, 255, 255, 0.025);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  h3 {
    margin: 0;
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.09em;
    color: #9fb0c3;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  h3::before {
    content: "";
    width: 3px;
    height: 11px;
    border-radius: 2px;
    background: var(--accent-grad);
  }
  .jump {
    font-size: 0.72rem;
    color: var(--muted);
    white-space: nowrap;
  }
  .jump input {
    width: 4.5em;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: var(--r-xs);
    padding: 0.15rem 0.35rem;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    transition: border-color 0.12s;
  }
  .jump input:focus {
    border-color: var(--accent);
    outline: none;
  }
  .viewport {
    position: relative;
    height: 240px;
    overflow-y: auto;
    overflow-x: hidden;
    background: var(--bg);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-sm);
    padding: 6px;
    box-shadow: inset 0 2px 10px -4px rgba(0, 0, 0, 0.7);
  }
  .canvas {
    position: relative;
    width: 100%;
  }
  .cell {
    position: absolute;
    box-sizing: border-box;
    border: 1px solid #2a3442;
    background: #161d27;
    color: #6b7a8d;
    border-radius: 5px;
    padding: 0;
    font-size: 0.6rem;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    overflow: hidden;
    display: grid;
    place-items: center;
    transition: background 0.1s, border-color 0.1s, transform 0.1s, box-shadow 0.1s;
  }
  .cell:hover {
    border-color: var(--accent);
    color: #eaf2fb;
    transform: translateY(-1px) scale(1.06);
    box-shadow: 0 4px 12px -3px rgba(125, 211, 252, 0.45);
    z-index: 2;
  }
  .cell.labeled {
    background: #1c2a3a;
    color: #9ec3e6;
    border-color: #2c4a66;
  }
  .cell.current {
    background: var(--accent);
    color: #06121f;
    border-color: var(--accent);
    font-weight: 700;
    z-index: 1;
  }
  .cell.modified {
    border-color: #c98a2b;
  }
  .moddot {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #fbbf24;
    box-shadow: 0 0 0 1.5px rgba(0, 0, 0, 0.55);
    pointer-events: none;
  }
  .issuedot {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 0;
    height: 0;
    border-left: 5px solid transparent;
    border-right: 5px solid transparent;
    border-bottom: 8px solid #f87171;
    pointer-events: none;
  }
  .heat {
    position: absolute;
    left: 2px;
    right: 2px;
    bottom: 2px;
    height: 3px;
    border-radius: 2px;
    pointer-events: none;
  }
  .num {
    pointer-events: none;
    line-height: 1;
  }
  .legend {
    display: flex;
    gap: 0.9rem;
    font-size: 0.72rem;
    color: var(--muted);
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .sw {
    width: 11px;
    height: 11px;
    border-radius: 3px;
    display: inline-block;
    border: 1px solid #2a3442;
  }
  .sw.current {
    background: var(--accent);
    border-color: var(--accent);
  }
  .sw.labeled {
    background: #1c2a3a;
    border-color: #2c4a66;
  }
  .sw.mod {
    background: #fbbf24;
    border-color: #c98a2b;
  }
  .sw.issue {
    background: #f87171;
    border-color: #b04a4a;
  }
  .heatkey {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .heatbar {
    width: 34px;
    height: 7px;
    border-radius: 3px;
    display: inline-block;
    background: linear-gradient(90deg, hsl(140, 80%, 55%), hsl(70, 80%, 55%), hsl(0, 80%, 55%));
  }
</style>
