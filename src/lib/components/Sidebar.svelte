<script>
  import { store } from "../labelsStore.svelte.js";
  import FrameGrid from "./FrameGrid.svelte";

  const PALETTE = [
    "#f3c56c", "#7dd3fc", "#a7f3d0", "#fda4af", "#c4b5fd",
    "#fca5a5", "#93c5fd", "#86efac", "#f0abfc", "#fdba74",
  ];
  // Mirror of draw.js fallback coloring for the per-instance dot.
  const dotColor = (i) => PALETTE[i % PALETTE.length];

  // Reactive summaries — recomputed when the model revision changes.
  const labels = $derived(store.labels);
  const skeleton = $derived(store.skeleton);
  const item = $derived(store.current);

  const totals = $derived.by(() => {
    store.rev;
    const L = store.labels;
    if (!L) return null;
    let instances = 0;
    for (const lf of L.labeledFrames) instances += lf.instances?.length ?? 0;
    return {
      videos: L.videos?.length ?? 0,
      skeletons: L.skeletons?.length ?? 0,
      tracks: L.tracks?.length ?? 0,
      labeledFrames: L.labeledFrames?.length ?? 0,
      instances,
    };
  });

  const videoShape = $derived.by(() => {
    const v = item?.video ?? store.labels?.videos?.[0];
    const s = v?.shape;
    return Array.isArray(s) ? { n: s[0], h: s[1], w: s[2], c: s[3] } : null;
  });
</script>

<aside class="sidebar">
  <header class="head">
    <div class="title" title={store.fileName}>{store.fileName}</div>
    <button class="ghost" onclick={() => store.reset()}>✕ Close</button>
  </header>

  {#if store.error}
    <p class="err">{store.error}</p>
  {/if}

  <!-- Discrete frame selector -->
  <FrameGrid />

  <!-- Video / source -->
  <section class="card">
    <h3>Video</h3>
    {#if videoShape}
      <dl>
        <dt>Resolution</dt>
        <dd>{videoShape.w} × {videoShape.h}{videoShape.c ? ` × ${videoShape.c}` : ""}</dd>
        <dt>Frames</dt>
        <dd>{videoShape.n ?? "—"}</dd>
        <dt>Embedded</dt>
        <dd>{store.hasEmbedded ? "yes (.pkg.slp)" : "no"}</dd>
      </dl>
    {:else}
      <p class="muted">No video metadata.</p>
    {/if}

    {#if store.videoModel}
      <p class="muted small">video: {store.videoName}</p>
    {/if}
  </section>

  <!-- Counts -->
  {#if totals}
    <section class="card">
      <h3>Labels</h3>
      <dl>
        <dt>Labeled frames</dt>
        <dd>{totals.labeledFrames}</dd>
        <dt>Instances</dt>
        <dd>{totals.instances}</dd>
        <dt>Tracks</dt>
        <dd>{totals.tracks}</dd>
        <dt>Videos</dt>
        <dd>{totals.videos}</dd>
      </dl>
    </section>
  {/if}

  <!-- Skeleton -->
  {#if skeleton}
    <section class="card">
      <h3>Skeleton{skeleton.name ? ` · ${skeleton.name}` : ""}</h3>
      <dl>
        <dt>Nodes</dt>
        <dd>{skeleton.nodeNames?.length ?? 0}</dd>
        <dt>Edges</dt>
        <dd>{skeleton.edges?.length ?? 0}</dd>
      </dl>
      <div class="chips">
        {#each skeleton.nodeNames ?? [] as name}
          <span class="chip">{name}</span>
        {/each}
      </div>
    </section>
  {/if}

  <!-- Current-frame instances -->
  <section class="card grow">
    <h3>This frame{item ? ` · ${item.lf?.instances?.length ?? 0} instance(s)` : ""}</h3>
    {#if item?.lf?.instances?.length}
      {#each item.lf.instances as inst, i}
        <div class="inst">
          <div class="inst-head">
            <span class="dot" style:background={dotColor(i)}></span>
            #{i}
            {inst.track?.name ? `· track ${inst.track.name}` : "· untracked"}
            {inst.score != null ? `· ${inst.score.toFixed(2)}` : ""}
          </div>
          <div class="pts">
            {#each inst.points ?? [] as p, j}
              <div class="pt" class:hidden={!p.visible}>
                <span class="pname">{skeleton?.nodeNames?.[j] ?? j}</span>
                <span class="pxy">
                  {p.visible && !Number.isNaN(p.xy?.[0])
                    ? `${p.xy[0].toFixed(1)}, ${p.xy[1].toFixed(1)}`
                    : "—"}
                </span>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    {:else}
      <p class="muted">No instances on this frame.</p>
    {/if}
  </section>
</aside>

<style>
  .sidebar {
    width: 320px;
    flex: 0 0 320px;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    overflow-y: auto;
    padding-right: 0.25rem;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .title {
    font-weight: 600;
    font-size: 0.9rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ghost {
    background: none;
    border: 1px solid #2a3442;
    color: var(--muted);
    border-radius: 6px;
    padding: 0.25rem 0.5rem;
    font-size: 0.78rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .ghost:hover {
    color: #fda4af;
    border-color: #5a3540;
  }
  .card {
    background: #10151d;
    border: 1px solid #1d2632;
    border-radius: 10px;
    padding: 0.8rem 0.9rem;
  }
  .card.grow {
    flex: 1;
    min-height: 120px;
  }
  h3 {
    margin: 0 0 0.55rem;
    font-size: 0.82rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #9fb0c3;
  }
  dl {
    margin: 0;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.2rem 0.75rem;
    font-size: 0.85rem;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .muted {
    color: var(--muted);
    font-size: 0.85rem;
    margin: 0.25rem 0 0;
  }
  .small {
    font-size: 0.78rem;
  }
  .err {
    color: #fda4af;
    font-size: 0.82rem;
    margin: 0;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-top: 0.6rem;
  }
  .chip {
    background: #18212d;
    border: 1px solid #243040;
    color: #b8c6d6;
    border-radius: 999px;
    padding: 0.1rem 0.5rem;
    font-size: 0.72rem;
  }
  .inst {
    border-top: 1px solid #1b2430;
    padding: 0.5rem 0 0.2rem;
  }
  .inst:first-of-type {
    border-top: none;
  }
  .inst-head {
    font-size: 0.8rem;
    color: #cdd7e3;
    margin-bottom: 0.35rem;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    display: inline-block;
  }
  .pts {
    display: grid;
    gap: 0.1rem;
  }
  .pt {
    display: flex;
    justify-content: space-between;
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
  }
  .pt.hidden {
    opacity: 0.4;
  }
  .pname {
    color: var(--muted);
  }
  .pxy {
    color: #d7dee8;
  }
</style>
