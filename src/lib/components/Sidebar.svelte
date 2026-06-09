<script>
  import { store } from "../labelsStore.svelte.js";
  import { edit } from "../editStore.svelte.js";
  import FrameGrid from "./FrameGrid.svelte";
  import SkeletonEditor from "./SkeletonEditor.svelte";

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

  // Reactive snapshot of the current frame's instances/points — recomputes on every
  // edit (store.rev) so coordinates/visibility update live, without re-mounting the DOM.
  const panel = $derived.by(() => {
    store.rev;
    const lf = store.current?.lf;
    const names = store.skeleton?.nodeNames ?? [];
    if (!lf) return [];
    return lf.instances.map((inst, i) => ({
      i,
      track: inst.track?.name ?? null,
      score: inst.score,
      points: (inst.points ?? []).map((p, j) => ({
        j,
        name: names[j] ?? j,
        x: p.xy?.[0],
        y: p.xy?.[1],
        visible: p.visible,
        placed: p.xy?.[0] != null && !Number.isNaN(p.xy?.[0]),
      })),
    }));
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

  <!-- Skeleton editor (nodes + edges) -->
  {#if skeleton}
    <SkeletonEditor />
  {/if}

  <!-- Current-frame instances (interactive) -->
  <section class="card grow">
    <div class="ihead">
      <h3>This frame · {panel.length} instance(s)</h3>
      <button class="addbtn" onclick={() => edit.addInstance()}>＋ Instance</button>
    </div>
    {#if panel.length}
      {#each panel as inst (inst.i)}
        <div class="inst" class:sel={inst.i === edit.selInstance}>
          <div class="inst-head">
            <button class="selbtn" onclick={() => edit.select(inst.i, 0)} title="Select instance">
              <span class="dot" style:background={dotColor(inst.i)}></span>
              #{inst.i}
              {inst.track ? `· ${inst.track}` : "· untracked"}
              {inst.score != null ? `· ${inst.score.toFixed(2)}` : ""}
            </button>
            <button class="del" onclick={() => edit.deleteInstance(inst.i)} title="Delete instance">×</button>
          </div>
          <div class="pts">
            {#each inst.points as p (p.j)}
              <button
                class="pt"
                class:hidden={!p.visible}
                class:psel={inst.i === edit.selInstance && p.j === edit.selNode}
                onclick={() => edit.select(inst.i, p.j)}
                ondblclick={() => edit.toggleVisible(inst.i, p.j)}
                title="Click to select · double-click to show/hide"
              >
                <span class="pname">{p.name}</span>
                <span class="pxy">
                  {p.placed ? `${p.x.toFixed(1)}, ${p.y.toFixed(1)}` : "—"}
                  <i class="vis" class:on={p.visible}></i>
                </span>
              </button>
            {/each}
          </div>
        </div>
      {/each}
    {:else}
      <p class="muted">No instances on this frame. Use ＋ Instance to add one.</p>
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
  .ihead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
  }
  .ihead h3 {
    margin: 0;
  }
  .addbtn {
    background: #18212d;
    border: 1px solid #2a3442;
    color: var(--accent);
    border-radius: 6px;
    padding: 0.2rem 0.5rem;
    font-size: 0.76rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .addbtn:hover {
    background: #1f2937;
  }
  .inst {
    border-top: 1px solid #1b2430;
    padding: 0.45rem 0.3rem 0.3rem;
    border-radius: 6px;
  }
  .inst:first-of-type {
    border-top: none;
  }
  .inst.sel {
    background: #131c27;
    box-shadow: inset 0 0 0 1px #2c4a66;
  }
  .inst-head {
    font-size: 0.8rem;
    color: #cdd7e3;
    margin-bottom: 0.35rem;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .selbtn {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    padding: 0.1rem;
    border-radius: 5px;
  }
  .selbtn:hover {
    color: #fff;
  }
  .del {
    background: none;
    border: 1px solid #2a3442;
    color: #9fb0c3;
    border-radius: 5px;
    padding: 0 0.4rem;
    cursor: pointer;
    line-height: 1.4;
  }
  .del:hover {
    color: #fda4af;
    border-color: #5a3540;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    display: inline-block;
    flex: none;
  }
  .pts {
    display: grid;
    gap: 0.1rem;
  }
  .pt {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
    background: none;
    border: 1px solid transparent;
    border-radius: 5px;
    color: inherit;
    padding: 0.12rem 0.35rem;
    cursor: pointer;
    text-align: left;
  }
  .pt:hover {
    background: #141b25;
  }
  .pt.hidden {
    opacity: 0.45;
  }
  .pt.psel {
    border-color: var(--accent);
    background: #14202c;
  }
  .pname {
    color: var(--muted);
  }
  .pxy {
    color: #d7dee8;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .vis {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: 1px solid #45526a;
    display: inline-block;
  }
  .vis.on {
    background: #86efac;
    border-color: #86efac;
  }
</style>
