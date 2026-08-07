<script>
  // RESULT VIEWER for the whole-instance appearance check: the 2-D embedding map, the crop it embedded,
  // its nearest neighbours, every score, the flag threshold. Configuration and launching live in
  // AppearanceWindow — this renders nothing until there are results, so the window owns the
  // empty / running / error states and this file stays about looking at the answer.
  import { store } from "../labelsStore.svelte.js";
  import { view as viewport } from "../viewStore.svelte.js";
  import { embeddingStores } from "../embeddingStore.svelte.js";
  import { instancePointsBox } from "../qc/focusBox.js";

  let jumpPos = $state(0);
  const es = embeddingStores.dino;
  es.setMethod("trained"); // idempotent — pinned here too, so the scorer holds however the store is reached

  // 2-D PCA scatter of every embedding (the learned appearance space).
  const scatter = $derived.by(() => {
    void es.rev;
    const res = es.results;
    if (!res) return null;
    const W = 250, H = 150, pad = 9;
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (const [x, y] of res.coords) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
    const sx = maxx - minx || 1, sy = maxy - miny || 1;
    const pts = res.coords.map((c, i) => ({ cx: pad + ((c[0] - minx) / sx) * (W - 2 * pad), cy: pad + ((c[1] - miny) / sy) * (H - 2 * pad), z: res.z[i], fi: es.records[i].fi, ii: es.records[i].ii, i }));
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

  // Records are keyed by frame index, not node position — so track store.index, NOT store.rev (a
  // node-drag must not rescan the crop records ~60/s while this panel is open).
  const cur = $derived.by(() => { void es.rev; return es.hasResults ? es.recordsForFrame(store.index) : []; });

  function go(fi, ii) {
    store.setIndex(fi); store.syncFrameImage?.();
    // Zoom the main view to the outlier instance's bbox (frame-nav alone keeps the prior zoom).
    if (ii == null) return;
    const box = instancePointsBox(store.frames[fi]?.lf?.instances?.[ii]?.points);
    if (box) viewport.requestFocus(box);
  }
  function jumpNext() {
    const outs = es.outlierRecords().filter((r) => r.z >= es.threshold);
    if (!outs.length) return;
    const o = outs[jumpPos % outs.length];
    go(o.fi, o.ii);
    jumpPos = (jumpPos + 1) % outs.length;
  }
  const zColor = (z) => (z >= es.threshold ? "#fb926e" : `hsl(190 70% ${Math.max(32, 60 - z * 7)}%)`);

</script>

<div class="emb">
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
              onclick={() => go(p.fi, p.ii)} />
          {/each}
        </svg>
        <p class="cap">{es.records.length} crops · trained SVM · color = decision · ⚪ = current</p>
        <div class="hist">
          {#each d.bins as b, i (i)}<i style:height="{(100 * b) / d.max}%" class:hot={((i + 0.5) / d.bins.length) * 100 >= d.tx}></i>{/each}
          <span class="thr" style:left="{d.tx}%"></span>
        </div>
        <label class="thr-ctl" title="Flag instances whose SVM decision is at or above this (0 = boundary, higher = more faulty)">
          decision ≥
          <input type="range" min={-3} max={3} step={0.05} bind:value={es.threshold} />
          <b>{es.threshold.toFixed(2)}</b>
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
                    <button class="nbb" title="neighbour · frame {nb.fi + 1} · z {nb.z.toFixed(1)}" onclick={() => go(nb.fi, nb.ii)}><img src={nb.thumb} alt="" /></button>
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
  {/if}
</div>

<style>
  .emb { display: flex; flex-direction: column; gap: 0.5rem; }
  .hint { font-size: 0.66rem; color: var(--dim); margin: 0; }

  .cols { display: flex; flex-direction: column; gap: 0.6rem; }
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

</style>
