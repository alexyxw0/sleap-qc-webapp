<script>
  // Per-KEYPOINT appearance-outlier panel. Where EmbeddingCheck embeds one whole-instance crop, this
  // embeds a patch around EACH keypoint and gives every keypoint type its OWN outlier graph — so a
  // single mis-placed / occluded node stands out against the same node elsewhere. Two pinned backends
  // (classical / dino) inspected one at a time via the view switch (non-destructive); within a backend,
  // a node selector (which doubles as the per-node flagged-count summary) picks which keypoint's graph
  // to inspect.
  import { store } from "../labelsStore.svelte.js";
  import { view as viewport } from "../viewStore.svelte.js";
  import { nodeEmbeddingStores } from "../nodeEmbeddingStore.svelte.js";
  import { nodePointBox } from "../qc/focusBox.js";
  import PopoutWindow from "./PopoutWindow.svelte";

  let popped = $state(false);
  let jumpPos = $state(0);
  let view = $state("classical");
  const es = $derived(nodeEmbeddingStores[view]);

  const isRunning = (s) => s.status === "loading-model" || s.status === "running" || s.status === "scoring";
  const running = $derived(isRunning(es));
  const anyRunning = $derived(isRunning(nodeEmbeddingStores.classical) || isRunning(nodeEmbeddingStores.dino));

  const capOn = $derived(es.sampleCap != null && es.sampleCap > 0);
  let capVal = $state(2000);
  function setCapOn(on) { es.sampleCap = on ? capVal : null; }
  function setCapVal(v) { capVal = Math.max(100, Math.round(v) || 100); es.sampleCap = capVal; }

  const BACKEND_INFO = {
    classical: { label: "Classical", tag: "fast", sub: "grayscale pixel features · no download", desc: "Per-keypoint patch embedded with fast grayscale pixel features (tiny-image + gradient/HOG + intensity histogram). No download, sub-millisecond per patch — embeds every keypoint of every instance in seconds. Catches a keypoint dropped on background / an occluder / the wrong body part." },
    dino: { label: "DINO ViT-S", tag: "slow", sub: "DINOv2 384-d embedding per keypoint", desc: "Per-keypoint patch embedded with the DINOv2 ViT — the most sensitive to subtle appearance, but it runs one forward pass per KEYPOINT per instance (many more crops than the instance-level check), so expect minutes at full coverage. Cached after the first run." },
  };
  const bi = $derived(BACKEND_INFO[view] ?? BACKEND_INFO.classical);
  const nodeName = (ni) => store.skeleton?.nodeNames?.[ni] ?? `node ${ni}`;

  // Scatter of the SELECTED keypoint's patches (its own appearance space).
  const scatter = $derived.by(() => {
    void es.rev;
    const ni = es.selectedNode;
    if (ni == null || !es.hasResults) return null;
    const raw = es.pointsForNode(ni);
    if (!raw.length) return null;
    const W = 250, H = 150, pad = 9;
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (const p of raw) { if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x; if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y; }
    const sx = maxx - minx || 1, sy = maxy - miny || 1;
    const pts = raw.map((p) => ({ cx: pad + ((p.x - minx) / sx) * (W - 2 * pad), cy: pad + ((p.y - miny) / sy) * (H - 2 * pad), z: p.z, fi: p.fi, ii: p.ii, r: p.r }));
    return { W, H, pts };
  });

  const dist = $derived.by(() => {
    void es.rev;
    const ni = es.selectedNode;
    if (ni == null || !es.hasResults) return null;
    const zs = es.zForNode(ni);
    if (!zs.length) return null;
    const lo = -1, hi = Math.max(6, es.threshold + 2), NB = 26;
    const bins = new Array(NB).fill(0);
    for (const z of zs) bins[Math.max(0, Math.min(NB - 1, Math.floor(((z - lo) / (hi - lo)) * NB)))]++;
    return { bins, max: Math.max(...bins, 1), tx: ((es.threshold - lo) / (hi - lo)) * 100 };
  });

  const cur = $derived.by(() => { void es.rev; return es.hasResults && es.selectedNode != null ? es.recordsForFrameNode(store.index, es.selectedNode) : []; });

  function go(fi, ii, node) {
    store.setIndex(fi); store.syncFrameImage?.();
    // Zoom the main view tight onto the specific keypoint (frame-nav alone keeps the prior zoom).
    if (ii == null || node == null) return;
    const box = nodePointBox(store.frames[fi]?.lf?.instances?.[ii]?.points, node);
    if (box) viewport.requestFocus(box);
  }
  function jumpNext() {
    const ni = es.selectedNode;
    if (ni == null) return;
    const outs = es.outlierRecordsForNode(ni).filter((r) => r.z >= es.threshold);
    if (!outs.length) return;
    const o = outs[jumpPos % outs.length];
    go(o.fi, o.ii, o.node);
    jumpPos = (jumpPos + 1) % outs.length;
  }
  const zColor = (z) => (z >= es.threshold ? "#fb926e" : `hsl(190 70% ${Math.max(32, 60 - z * 7)}%)`);
</script>

{#snippet body()}
  <div class="emb" class:wide={popped}>
    <div class="head">
      <span class="ttl">Per-node appearance · {bi.label}</span>
      <button class="pop" onclick={() => (popped = !popped)} title={popped ? "Dock back" : "Pop out"}>{popped ? "⤡" : "⤢"}</button>
    </div>

    <div class="backend" role="group" aria-label="Per-node backend to inspect">
      {#each [["classical", "Classical", "fast"], ["dino", "DINO", "slow"]] as [k, lbl, tag] (k)}
        <button class:sel={view === k} disabled={anyRunning} onclick={() => (view = k)} title={BACKEND_INFO[k].desc}>
          {lbl} <small>{tag}</small>
          {#if nodeEmbeddingStores[k].hasResults}<span class="rdy" title="{nodeEmbeddingStores[k].flaggedCount} keypoint patches flagged · computed">✓</span>{/if}
        </button>
      {/each}
    </div>
    <p class="be-note">A patch per <b>keypoint</b>, scored against its own kind — each keypoint gets its own graph. Its <b>Per-node · {bi.label}</b> check sits under Appearance.</p>

    <p class="card" title={bi.desc}>
      {es.modelInfo ? `${es.modelInfo.name} · ${es.modelInfo.dim}-d${es.modelInfo.backend ? ` · ${es.modelInfo.backend}` : ""}` : bi.sub} <span class="q">ⓘ</span>
    </p>

    <div class="ctl">
      <label class="allcap" title="Embed EVERY instance's every keypoint — full coverage (cached, so a one-time cost). Uncheck to evenly subsample instances for speed.">
        <input type="checkbox" checked={!capOn} onchange={(e) => setCapOn(!e.currentTarget.checked)} disabled={running} />
        all{es.instanceCount ? ` (${es.instanceCount} inst${es.hasResults ? ` · ${es.embeddedCount} patches` : ""})` : ""}
      </label>
      {#if capOn}
        <label title="Evenly sample this many INSTANCES (each expands to its keypoint patches)">cap
          <input type="number" min="100" max={es.instanceCount || 100000} step="100" value={capVal} oninput={(e) => setCapVal(+e.currentTarget.value)} disabled={running} />
        </label>
      {/if}
      <label title="Per keypoint, the 'normal' reference is an even, per-video subsample of this size.">ref
        <input type="number" min="5" max="100" step="5" value={Math.round(es.referenceFraction * 100)} oninput={(e) => (es.referenceFraction = Math.min(1, Math.max(0.05, (+e.currentTarget.value || 20) / 100)))} disabled={running} />%
      </label>
      {#if running}
        <button class="run stop" onclick={() => es.abort()}>Stop</button>
      {:else}
        <button class="run" onclick={() => es.run()}>{es.hasResults ? "Re-run" : "Run"} per-node</button>
      {/if}
    </div>

    {#if running}
      <div class="prog">
        <div class="bar"><i style:width="{es.progress.total ? (100 * es.progress.done) / es.progress.total : 8}%"></i></div>
        <span>{es.message}{es.progress.total ? ` · ${es.progress.done}/${es.progress.total}` : ""}</span>
      </div>
    {:else if es.status === "error"}
      <p class="err">{es.message}</p>
    {:else if es.status === "aborted"}
      <p class="hint">{es.message} {es.hasResults ? "Partial results shown." : ""}</p>
    {/if}

    {#if es.hasResults}
      <!-- Node selector = per-node flagged-count summary in one row: click a keypoint to view its graph. -->
      <div class="nodes" role="group" aria-label="Keypoint">
        {#each es.nodeStats as ns (ns.node)}
          {@const flagged = ns.scored ? es.flaggedCountForNode(ns.node) : 0}
          <button class="nodechip" class:sel={es.selectedNode === ns.node} class:unscored={!ns.scored}
            disabled={!ns.scored} onclick={() => (es.selectedNode = ns.node)}
            title={ns.scored ? `${nodeName(ns.node)} · ${ns.count} patches · ${flagged} flagged · ref ${ns.refCount}` : `${nodeName(ns.node)} · ${ns.count} patches — too few to score`}>
            {nodeName(ns.node)}{#if ns.scored}<span class="nc" class:hot={flagged > 0}>{flagged}</span>{/if}
          </button>
        {/each}
      </div>

      {#if scatter}
        {@const s = scatter}
        {@const d = dist}
        <div class="cols">
          <div class="col-a">
            <svg class="map" viewBox="0 0 {s.W} {s.H}" role="img" aria-label="Keypoint embedding map (PCA)">
              {#each s.pts as p (p.r)}
                <circle cx={p.cx} cy={p.cy} r={p.fi === store.index ? 3.4 : 1.9} fill={zColor(p.z)}
                  stroke={p.fi === store.index ? "#fff" : "none"} stroke-width="1"
                  class="pt" role="button" tabindex="-1" title="frame {p.fi + 1} · z {p.z.toFixed(1)}"
                  onclick={() => go(p.fi, p.ii, es.selectedNode)} />
              {/each}
            </svg>
            <p class="cap"><b>{nodeName(es.selectedNode)}</b> · {s.pts.length} patches · color = z · ⚪ = current</p>
            {#if d}
              <div class="hist">
                {#each d.bins as b, i (i)}<i style:height="{(100 * b) / d.max}%" class:hot={((i + 0.5) / d.bins.length) * 100 >= d.tx}></i>{/each}
                <span class="thr" style:left="{d.tx}%"></span>
              </div>
            {/if}
            <label class="thr-ctl" title="Flag a keypoint whose appearance robust-z is at or above this (shared across all keypoints)">
              z ≥ <input type="range" min="1.5" max="8" step="0.1" bind:value={es.threshold} /> <b>{es.threshold.toFixed(1)}</b>
            </label>
            <div class="foot">
              <span class="flag"><b>{es.flaggedCountForNode(es.selectedNode)}</b> flagged</span>
              <button class="jump" disabled={!es.flaggedCountForNode(es.selectedNode)} onclick={jumpNext}>walk outliers →</button>
            </div>
          </div>

          <div class="col-b">
            <p class="sub-h">This frame's <b>{nodeName(es.selectedNode)}</b> patch + nearest neighbours <span title="The patch this instance's selected keypoint sits in, and the 5 most-similar patches of the SAME keypoint elsewhere. A mis-placed / occluded keypoint sits far from clean look-alikes (high z).">ⓘ</span></p>
            {#if cur.length}
              {#each cur as c (c.r)}
                <div class="qrow">
                  <img class="crop" class:hot={c.z >= es.threshold} src={c.thumb} alt="keypoint patch" />
                  <div class="qmeta">
                    <span class="qz" class:hot={c.z >= es.threshold}>z {c.z.toFixed(1)}</span>
                    <div class="nbrs">
                      {#each es.neighborsInNode(c.r, 5) as nb (nb.r)}
                        <button class="nbb" title="neighbour · frame {nb.fi + 1} · z {nb.z.toFixed(1)}" onclick={() => go(nb.fi, nb.ii, nb.node)}><img src={nb.thumb} alt="" /></button>
                      {/each}
                    </div>
                  </div>
                </div>
              {/each}
            {:else}
              <p class="hint">Current frame's {nodeName(es.selectedNode)} wasn't in the sample. Click a map point or walk the outliers.</p>
            {/if}
          </div>
        </div>
      {:else if es.nodeStats.some((n) => n.scored)}
        <p class="hint">Select a keypoint above to see its graph.</p>
      {:else}
        <p class="hint">No keypoint had enough patches to score — each keypoint needs ≥ 8 placed instances. Label more frames, then re-run.</p>
      {/if}
    {:else if !running && es.status !== "error"}
      <p class="hint">Flags a keypoint that looks unlike that same keypoint elsewhere — a mis-placed / occluded node the whole-instance crop misses. {view === "dino" ? "DINO is slow here (a pass per keypoint) — minutes." : "Classical runs in seconds."} Run to enable the <b>Per-node · {bi.label}</b> check.</p>
    {/if}
  </div>
{/snippet}

{#if popped}
  <p class="popped">Popped out · <button class="link" onclick={() => (popped = false)}>show inline</button></p>
  <PopoutWindow title="Per-node appearance · {bi.label}" width="760px" onclose={() => (popped = false)}>{@render body()}</PopoutWindow>
{:else}
  {@render body()}
{/if}

<style>
  .emb { display: flex; flex-direction: column; gap: 0.5rem; }
  .head { display: flex; align-items: center; gap: 0.4rem; }
  .ttl { font-size: 0.74rem; color: var(--text); flex: 1 1 auto; min-width: 0; }
  .pop { background: none; border: none; color: var(--dim); font-size: 0.9rem; cursor: pointer; padding: 0 0.1rem; }
  .pop:hover { color: var(--accent); }
  .card { margin: 0; font-size: 0.62rem; color: var(--dim); cursor: help; }
  .card .q { color: var(--accent); }
  .err { font-size: 0.68rem; color: #fca5a5; margin: 0; }
  .hint { font-size: 0.66rem; color: var(--dim); margin: 0; }

  .backend { display: inline-flex; border: 1px solid var(--border); border-radius: var(--r-xs); overflow: hidden; }
  .backend button { font-size: 0.64rem; color: var(--muted); background: transparent; border: none; border-right: 1px solid var(--border); padding: 0.2rem 0.5rem; cursor: pointer; display: inline-flex; align-items: baseline; gap: 0.3rem; }
  .backend button:last-child { border-right: none; }
  .backend button small { font-size: 0.52rem; color: var(--dim); text-transform: uppercase; letter-spacing: 0.04em; }
  .backend button.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
  .backend button.sel small { color: color-mix(in srgb, var(--accent) 70%, var(--dim)); }
  .backend button:disabled { cursor: default; opacity: 0.55; }
  .backend button .rdy { color: #6ee7a8; font-size: 0.6rem; margin-left: 0.05rem; }
  .be-note { margin: 0; font-size: 0.58rem; color: var(--dim); line-height: 1.3; }
  .be-note b { color: var(--muted); font-weight: 600; }

  .ctl { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .ctl label { font-size: 0.66rem; color: var(--muted); display: inline-flex; align-items: center; gap: 0.3rem; }
  .ctl input[type="number"] { width: 4rem; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-xs); color: var(--text); font-size: 0.66rem; padding: 0.15rem 0.3rem; }
  .run { font-size: 0.68rem; border: 1px solid var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); border-radius: var(--r-xs); padding: 0.24rem 0.55rem; cursor: pointer; }
  .run.stop { border-color: #fb926e; color: #fb926e; background: rgba(251, 146, 110, 0.12); }

  .prog { display: flex; align-items: center; gap: 0.4rem; font-size: 0.62rem; color: var(--dim); }
  .prog .bar { flex: 1 1 auto; height: 6px; background: rgba(255, 255, 255, 0.07); border-radius: 3px; overflow: hidden; }
  .prog .bar i { display: block; height: 100%; background: var(--accent); transition: width 0.1s linear; }

  .nodes { display: flex; flex-wrap: wrap; gap: 3px; }
  .nodechip { font-size: 0.6rem; color: var(--muted); background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-xs); padding: 0.12rem 0.35rem; cursor: pointer; display: inline-flex; align-items: center; gap: 0.25rem; }
  .nodechip:hover:not(:disabled) { border-color: var(--accent); }
  .nodechip.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); border-color: var(--accent); }
  .nodechip.unscored { opacity: 0.4; cursor: default; }
  .nodechip .nc { font-size: 0.54rem; background: rgba(255,255,255,0.08); border-radius: 999px; padding: 0 0.28rem; font-variant-numeric: tabular-nums; }
  .nodechip .nc.hot { background: #fb926e; color: #1a1a1a; font-weight: 600; }

  .cols { display: flex; flex-direction: column; gap: 0.6rem; }
  .emb.wide .cols { display: grid; grid-template-columns: 264px 1fr; gap: 1.2rem; align-items: start; }
  .col-a, .col-b { display: flex; flex-direction: column; gap: 0.45rem; min-width: 0; }

  .map { width: 100%; max-width: 260px; align-self: center; background: rgba(0, 0, 0, 0.25); border-radius: var(--r-xs); }
  .pt { cursor: pointer; }
  .pt:hover { stroke: #fff; stroke-width: 1; }
  .cap { font-size: 0.56rem; color: var(--dim); margin: 0; text-align: center; }
  .cap b { color: var(--muted); }
  .hist { position: relative; display: flex; align-items: flex-end; gap: 1px; height: 30px; background: rgba(0, 0, 0, 0.2); border-radius: var(--r-xs); padding: 2px; }
  .hist i { flex: 1 1 0; background: #3a6b78; min-height: 1px; border-radius: 1px; }
  .hist i.hot { background: #fb926e; }
  .hist .thr { position: absolute; top: 0; bottom: 0; width: 1px; background: #fff8; }
  .thr-ctl { display: flex; align-items: center; gap: 0.3rem; font-size: 0.64rem; color: var(--muted); }
  .thr-ctl input { flex: 1 1 auto; min-width: 0; }
  .foot { display: flex; align-items: center; gap: 0.5rem; font-size: 0.66rem; }
  .flag { color: #fb926e; }
  .jump { font-size: 0.62rem; border: 1px solid var(--border); border-radius: var(--r-xs); background: none; color: var(--muted); padding: 0.2rem 0.4rem; cursor: pointer; }
  .jump:disabled { opacity: 0.4; cursor: default; }

  .sub-h { font-size: 0.66rem; color: var(--muted); margin: 0; }
  .sub-h b { color: var(--text); }
  .sub-h span { color: var(--accent); cursor: help; }
  .qrow { display: flex; gap: 0.5rem; align-items: flex-start; }
  .crop { width: 48px; height: 48px; border-radius: var(--r-xs); object-fit: cover; border: 1px solid var(--border); flex: none; }
  .crop.hot { border-color: #fb926e; }
  .qmeta { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
  .qz { font-size: 0.66rem; color: var(--muted); font-variant-numeric: tabular-nums; }
  .qz.hot { color: #fb926e; font-weight: 600; }
  .nbrs { display: flex; gap: 3px; flex-wrap: wrap; }
  .nbb { padding: 0; border: 1px solid var(--border); border-radius: 3px; background: none; cursor: pointer; line-height: 0; }
  .nbb:hover { border-color: var(--accent); }
  .nbb img { width: 30px; height: 30px; border-radius: 2px; object-fit: cover; display: block; }

  .popped { margin: 0; font-size: 0.72rem; color: var(--dim); }
  .link { background: none; border: none; padding: 0; font: inherit; color: var(--accent); cursor: pointer; }
</style>
