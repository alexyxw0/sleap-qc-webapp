<script>
  import { store } from "../labelsStore.svelte.js";

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
        <button
          class="cell"
          class:current={cell.i === store.index}
          class:labeled
          style:left="{cell.x}px"
          style:top="{cell.y}px"
          style:width="{CELL}px"
          style:height="{CELL}px"
          title={`frame ${cell.i + 1} · video idx ${f?.frameIdx} · ${f?.lf?.instances?.length ?? 0} instance(s)`}
          onclick={() => store.setIndex(cell.i)}
        >
          <span class="num">{f?.frameIdx}</span>
        </button>
      {/each}
    </div>
  </div>

  <div class="legend">
    <span><i class="sw current"></i> selected</span>
    <span><i class="sw labeled"></i> has labels</span>
  </div>
</section>

<style>
  .frames {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  h3 {
    margin: 0;
    font-size: 0.82rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #9fb0c3;
  }
  .jump {
    font-size: 0.72rem;
    color: var(--muted);
    white-space: nowrap;
  }
  .jump input {
    width: 4.5em;
    background: #0c1118;
    border: 1px solid #2a3442;
    color: #e7edf4;
    border-radius: 5px;
    padding: 0.1rem 0.3rem;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }
  .viewport {
    position: relative;
    height: 240px;
    overflow-y: auto;
    overflow-x: hidden;
    background: #0c1118;
    border: 1px solid #1d2632;
    border-radius: 8px;
    padding: 6px;
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
    transition: background 0.08s, border-color 0.08s;
  }
  .cell:hover {
    border-color: var(--accent);
    color: #cdd7e3;
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
</style>
