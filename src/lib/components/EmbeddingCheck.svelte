<script>
  // Appearance-outlier check (DINOv2 ViT-S). Fully inspectable: the 2-D embedding map, the crop it
  // embedded, its nearest neighbours (what the model thinks it looks like), and every score.
  import { store } from "../labelsStore.svelte.js";
  import { embeddingStore as es } from "../embeddingStore.svelte.js";
  import PopoutWindow from "./PopoutWindow.svelte";

  let popped = $state(false);
  let jumpPos = $state(0);

  const running = $derived(es.status === "loading-model" || es.status === "running" || es.status === "scoring");

  // 2-D PCA scatter of every embedding (the learned appearance space).
  const scatter = $derived.by(() => {
    void es.rev;
    const res = es.results;
    if (!res) return null;
    const W = 250, H = 150, pad = 9;
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (const [x, y] of res.coords) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
    const sx = maxx - minx || 1, sy = maxy - miny || 1;
    const pts = res.coords.map((c, i) => ({ cx: pad + ((c[0] - minx) / sx) * (W - 2 * pad), cy: pad + ((c[1] - miny) / sy) * (H - 2 * pad), z: res.z[i], fi: es.records[i].fi, i }));
    return { W, H, pts };
  });

  const dist = $derived.by(() => {
    void es.rev;
    const res = es.results;
    if (!res) return null;
    const lo = -1, hi = Math.max(6, es.threshold + 2), NB = 26;
    const bins = new Array(NB).fill(0);
    for (const z of res.z) bins[Math.max(0, Math.min(NB - 1, Math.floor(((z - lo) / (hi - lo)) * NB)))]++;
    return { bins, max: Math.max(...bins, 1), tx: ((es.threshold - lo) / (hi - lo)) * 100 };
  });

  const cur = $derived.by(() => { void es.rev; void store.rev; return es.hasResults ? es.recordsForFrame(store.index) : []; });

  function go(fi) { store.setIndex(fi); store.syncFrameImage?.(); }
  function jumpNext() {
    const outs = es.outlierRecords().filter((r) => r.z >= es.threshold);
    if (!outs.length) return;
    go(outs[jumpPos % outs.length].fi);
    jumpPos = (jumpPos + 1) % outs.length;
  }
  const zColor = (z) => (z >= es.threshold ? "#fb926e" : `hsl(190 70% ${Math.max(32, 60 - z * 7)}%)`);
</script>

{#snippet body()}
  <div class="emb" class:wide={popped}>
    <div class="head">
      <span class="ttl">Appearance outliers · DINOv2 ViT-S</span>
      <button class="pop" onclick={() => (popped = !popped)} title={popped ? "Dock back" : "Pop out"}>{popped ? "⤡" : "⤢"}</button>
    </div>
    <p class="card" title="DINOv2 is a self-supervised vision transformer — it learns to embed image appearance with NO keypoint labels. We embed each instance's crop into a 384-d vector; instances whose appearance is unlike the rest (occlusions, obstructed or mis-placed nodes, odd crops) are flagged — the class geometry can't detect.">
      {es.modelInfo ? `${es.modelInfo.name} · ${es.modelInfo.dim}-d · patch ${es.modelInfo.patch}` : "DINOv2 ViT-S/14 · 384-d self-supervised appearance embedding"} <span class="q">ⓘ</span>
    </p>

    <div class="ctl">
      <label title="Instances are evenly sampled to this many crops (embedding is heavy)">sample
        <input type="number" min="100" max="6000" step="100" bind:value={es.sampleCap} disabled={running} />
      </label>
      {#if running}
        <button class="run stop" onclick={() => es.abort()}>Stop</button>
      {:else}
        <button class="run" onclick={() => es.run()}>{es.hasResults ? "Re-run" : "Run"} embedding</button>
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
      {@const s = scatter}
      {@const d = dist}
      <div class="cols">
        <div class="col-a">
          <svg class="map" viewBox="0 0 {s.W} {s.H}" role="img" aria-label="Embedding map (PCA)">
            {#each s.pts as p (p.i)}
              <circle cx={p.cx} cy={p.cy} r={p.fi === store.index ? 3.4 : 1.9} fill={zColor(p.z)}
                stroke={p.fi === store.index ? "#fff" : "none"} stroke-width="1"
                class="pt" role="button" tabindex="-1" title="frame {p.fi + 1} · z {p.z.toFixed(1)}"
                onclick={() => go(p.fi)} />
            {/each}
          </svg>
          <p class="cap">PCA of {es.records.length} crop embeddings · color = outlier z · ⚪ = current frame</p>
          <div class="hist">
            {#each d.bins as b, i (i)}<i style:height="{(100 * b) / d.max}%" class:hot={((i + 0.5) / d.bins.length) * 100 >= d.tx}></i>{/each}
            <span class="thr" style:left="{d.tx}%"></span>
          </div>
          <label class="thr-ctl" title="Flag instances whose appearance robust-z is at or above this">
            z ≥ <input type="range" min="1.5" max="8" step="0.1" bind:value={es.threshold} /> <b>{es.threshold.toFixed(1)}</b>
          </label>
          <div class="foot">
            <span class="flag"><b>{es.flaggedCount}</b> flagged</span>
            <button class="jump" disabled={!es.flaggedCount} onclick={jumpNext}>walk outliers →</button>
          </div>
        </div>

        <div class="col-b">
          <p class="sub-h">This frame's crops + nearest neighbours <span title="The model's own view: the crop it embedded and the 5 most-similar crops in the file. An occluded instance sits far from clean look-alikes (high z) — its 'neighbours' are dissimilar or few.">ⓘ</span></p>
          {#if cur.length}
            {#each cur as c (c.r)}
              <div class="qrow">
                <img class="crop" class:hot={c.z >= es.threshold} src={c.thumb} alt="instance crop" />
                <div class="qmeta">
                  <span class="qz" class:hot={c.z >= es.threshold}>z {c.z.toFixed(1)}</span>
                  <div class="nbrs">
                    {#each es.neighborsOf(c.r, 5) as nb (nb.r)}
                      <button class="nbb" title="neighbour · frame {nb.fi + 1} · z {nb.z.toFixed(1)}" onclick={() => go(nb.fi)}><img src={nb.thumb} alt="" /></button>
                    {/each}
                  </div>
                </div>
              </div>
            {/each}
          {:else}
            <p class="hint">Current frame wasn't in the sample. Click a map point or walk the outliers.</p>
          {/if}
        </div>
      </div>
    {:else if !running && es.status !== "error"}
      <p class="hint">Runs DINOv2 in-browser on each instance crop to catch occlusion / appearance errors geometry misses. First run downloads ~90 MB (cached after).</p>
    {/if}
  </div>
{/snippet}

{#if popped}
  <p class="popped">Popped out · <button class="link" onclick={() => (popped = false)}>show inline</button></p>
  <PopoutWindow title="Appearance outliers · DINOv2 ViT-S" width="720px" onclose={() => (popped = false)}>{@render body()}</PopoutWindow>
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

  .ctl { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .ctl label { font-size: 0.66rem; color: var(--muted); display: inline-flex; align-items: center; gap: 0.3rem; }
  .ctl input[type="number"] { width: 4rem; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-xs); color: var(--text); font-size: 0.66rem; padding: 0.15rem 0.3rem; }
  .run { font-size: 0.68rem; border: 1px solid var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); border-radius: var(--r-xs); padding: 0.24rem 0.55rem; cursor: pointer; }
  .run.stop { border-color: #fb926e; color: #fb926e; background: rgba(251, 146, 110, 0.12); }

  .prog { display: flex; align-items: center; gap: 0.4rem; font-size: 0.62rem; color: var(--dim); }
  .prog .bar { flex: 1 1 auto; height: 6px; background: rgba(255, 255, 255, 0.07); border-radius: 3px; overflow: hidden; }
  .prog .bar i { display: block; height: 100%; background: var(--accent); transition: width 0.1s linear; }

  .cols { display: flex; flex-direction: column; gap: 0.6rem; }
  .emb.wide .cols { display: grid; grid-template-columns: 264px 1fr; gap: 1.2rem; align-items: start; }
  .col-a, .col-b { display: flex; flex-direction: column; gap: 0.45rem; min-width: 0; }

  .map { width: 100%; max-width: 260px; align-self: center; background: rgba(0, 0, 0, 0.25); border-radius: var(--r-xs); }
  .pt { cursor: pointer; }
  .pt:hover { stroke: #fff; stroke-width: 1; }
  .cap { font-size: 0.56rem; color: var(--dim); margin: 0; text-align: center; }
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
