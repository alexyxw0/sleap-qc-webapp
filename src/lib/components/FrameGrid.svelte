<script>
  import { store } from "../labelsStore.svelte.js";
  import { edit } from "../editStore.svelte.js";
  import { qc } from "../qcStore.svelte.js";

  // A minimap of discrete, clickable frame tiles — one per navigable frame, unnumbered
  // (the tooltip and the go-to box carry the indices). Virtualized: only the rows
  // currently scrolled into view are mounted, so it stays smooth even at 180k frames.
  //
  // One signal per tile: flagged frames are filled on a yellow→red severity ramp,
  // edited frames get an amber underline, everything else stays calm. Details live
  // in the tooltip.

  const CELL = 15; // tile size (px)
  const GAP = 3;
  const PITCH = CELL + GAP;
  const PAD = 6; // .viewport padding (must match CSS)

  let viewport = $state(); // scroll container
  let viewportH = $state(190);
  let innerW = $state(280);
  let scrollTop = $state(0);

  let filter = $state("all"); // all | labeled | flagged | modified

  function matches(f) {
    switch (filter) {
      case "labeled":
        return (f?.lf?.instances?.length ?? 0) > 0;
      case "flagged":
        return qc.frameFlagged(f);
      case "modified":
        return edit.isFrameModified(f?.lf);
      default:
        return true;
    }
  }

  // Frame indices passing the active filter; null = identity ("all"), so the common
  // case never allocates a 180k-entry array.
  const idxList = $derived.by(() => {
    void store.rev;
    void qc.rev;
    void edit.dirtyRev;
    if (filter === "all") return null;
    const out = [];
    for (let i = 0; i < store.frameCount; i++) if (matches(store.frames[i])) out.push(i);
    return out;
  });

  const modifiedCount = $derived.by(() => {
    void store.rev;
    void edit.dirtyRev;
    let n = 0;
    for (const f of store.frames) if (edit.isFrameModified(f?.lf)) n++;
    return n;
  });

  // A filter that loses its meaning (QC reset) or empties out falls back to "all".
  $effect(() => {
    if (filter === "flagged" && !qc.hasResults) filter = "all";
    else if (idxList && idxList.length === 0 && store.frameCount > 0) filter = "all";
  });

  const count = $derived(idxList ? idxList.length : store.frameCount);
  const realIdx = (pos) => (idxList ? idxList[pos] : pos);
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
        out.push({ fi: realIdx(i), x: c * PITCH, y: r * PITCH });
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
  // timeline, playback). Reads the live scroll position off the DOM rather than the
  // reactive `scrollTop`, so it never fights manual scrolling.
  $effect(() => {
    const i = store.index;
    void cols;
    if (!viewport || count === 0) return;
    // With a filter active, the tile position is the index's rank within idxList
    // (binary search — the list is sorted). Not in the list -> nothing to scroll to.
    let pos = i;
    if (idxList) {
      let lo = 0;
      let hi = idxList.length - 1;
      pos = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (idxList[mid] === i) {
          pos = mid;
          break;
        }
        if (idxList[mid] < i) lo = mid + 1;
        else hi = mid - 1;
      }
      if (pos < 0) return;
    }
    const st = viewport.scrollTop;
    const vh = viewport.clientHeight;
    const y = Math.floor(pos / cols) * PITCH;
    if (y < st) viewport.scrollTop = y;
    else if (y + CELL > st + vh) viewport.scrollTop = y + CELL - vh;
  });

  function jump(e) {
    const v = parseInt(e.target.value, 10);
    if (Number.isFinite(v)) store.setIndex(v - 1); // 1-based, matches the viewer counter
  }

  // Flagged tiles: severity ramp from yellow (borderline) to red (worst). Scores at or
  // below ~0.5 (frame-issue-only flags) sit at the yellow end. Unflagged tiles stay
  // neutral/labeled — severity for them isn't worth the noise.
  function tileBg(qscore, flagged) {
    if (!flagged) return null; // styled by class
    const t = Math.max(0, Math.min(1, ((qscore ?? 0.6) - 0.5) / 0.5));
    return `hsl(${Math.round(50 * (1 - t))} 88% 55% / ${(0.5 + 0.4 * t).toFixed(2)})`;
  }
</script>

<section class="side-section frames">
  <div class="head">
    <h3 class="side-h">Frames</h3>
    <div class="filters">
      <button class:on={filter === "all"} onclick={() => (filter = "all")}>all</button>
      <button class:on={filter === "labeled"} onclick={() => (filter = "labeled")}>labeled</button>
      {#if qc.hasResults}
        <button class="flag" class:on={filter === "flagged"} onclick={() => (filter = "flagged")}>
          flagged {qc.flaggedFrameCount}
        </button>
      {/if}
      {#if modifiedCount > 0}
        <button class="mod" class:on={filter === "modified"} onclick={() => (filter = "modified")}>
          edited {modifiedCount}
        </button>
      {/if}
    </div>
  </div>

  <div class="viewport" bind:this={viewport} onscroll={(e) => (scrollTop = e.target.scrollTop)}>
    <div class="canvas" style:height="{totalH}px">
      {#each cells as cell (cell.fi)}
        {@const f = store.frames[cell.fi]}
        {@const labeled = (f?.lf?.instances?.length ?? 0) > 0}
        {@const modified = edit.isFrameModified(f?.lf)}
        {@const qscore = qc.hasResults ? qc.frameScore(f) : null}
        {@const flagged = qc.hasResults ? qc.frameFlagged(f) : false}
        {@const qtop = flagged ? qc.frameTopIssue(f) : null}
        <button
          class="cell"
          class:current={cell.fi === store.index}
          class:labeled
          class:modified
          style:left="{cell.x}px"
          style:top="{cell.y}px"
          style:width="{CELL}px"
          style:height="{CELL}px"
          style:background={tileBg(qscore, flagged)}
          title={`frame ${cell.fi + 1} · video idx ${f?.frameIdx} · ${f?.lf?.instances?.length ?? 0} instance(s)${modified ? " · edited" : ""}${qscore != null ? ` · anomaly ${qscore.toFixed(2)}${qtop?.issue ? ` (${qtop.issue})` : ""}` : ""}`}
          onclick={() => store.setIndex(cell.fi)}
          aria-label={`Go to frame ${cell.fi + 1}`}
        ></button>
      {/each}
    </div>
  </div>

  <div class="jump">
    go to
    <input
      type="number"
      min="1"
      max={store.frameCount}
      value={store.index + 1}
      onchange={jump}
      aria-label="Go to frame number"
    />
    / {store.frameCount}
  </div>
</section>

<style>
  .frames {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    border-top: none; /* first section under the file header */
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 0.55rem;
  }
  .head .side-h {
    margin: 0;
    flex: 1;
  }
  .filters {
    display: flex;
    gap: 0.7rem;
  }
  .filters button {
    background: none;
    border: none;
    padding: 0;
    font-size: 0.64rem;
    letter-spacing: 0.06em;
    color: var(--dim);
    cursor: pointer;
    transition: color 0.12s;
  }
  .filters button:hover {
    color: var(--muted);
  }
  .filters button.on {
    color: var(--accent);
  }
  .filters button.flag.on {
    color: #fda4af;
  }
  .filters button.mod.on {
    color: var(--warn);
  }
  .viewport {
    position: relative;
    height: 190px;
    overflow-y: auto;
    overflow-x: hidden;
    background: rgba(8, 10, 12, 0.7);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-xs);
    padding: 6px;
  }
  .canvas {
    position: relative;
    width: 100%;
  }
  .cell {
    position: absolute;
    box-sizing: border-box;
    border: 1px solid transparent;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 1px;
    padding: 0;
    cursor: pointer;
    transition: border-color 0.1s, transform 0.1s;
  }
  .cell.labeled {
    background: rgba(95, 217, 242, 0.15);
  }
  .cell.modified {
    box-shadow: inset 0 -2px 0 0 rgba(243, 195, 78, 0.7);
  }
  .cell:hover {
    border-color: var(--accent);
    transform: scale(1.2);
    z-index: 2;
  }
  .cell.current {
    border-color: #fff;
    box-shadow: 0 0 0 1px #fff;
    z-index: 1;
  }
  .jump {
    font-size: 0.66rem;
    letter-spacing: 0.06em;
    color: var(--dim);
    white-space: nowrap;
    align-self: flex-end;
  }
  .jump input {
    width: 4.2em;
    background: rgba(8, 10, 12, 0.7);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: var(--r-xs);
    padding: 0.12rem 0.35rem;
    font-size: 0.72rem;
    transition: border-color 0.12s;
  }
  .jump input:focus {
    border-color: var(--accent);
    outline: none;
  }
</style>
