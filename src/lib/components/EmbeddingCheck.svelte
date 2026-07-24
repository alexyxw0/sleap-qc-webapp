<script>
  // Appearance-outlier check. Two INDEPENDENT backends — Classical (fast grayscale pixel features) and
  // DINOv2 ViT-S (slower, semantic) — each embedded + scored in its own store, so both can be enabled
  // as separate detection checks under Appearance. This panel inspects one backend at a time (the
  // "view"); switching never discards the other backend's results. Fully inspectable: the 2-D
  // embedding map, the crop it embedded, its nearest neighbours, and every score.
  import { store } from "../labelsStore.svelte.js";
  import { view as viewport } from "../viewStore.svelte.js";
  import { embeddingStores } from "../embeddingStore.svelte.js";
  import { instancePointsBox } from "../qc/focusBox.js";
  import { classifierInfo } from "../qc/embedding/appearanceClf.js";
  import PopoutWindow from "./PopoutWindow.svelte";

  const clf = classifierInfo(); // trained appearance-SVM header (DINO-ViT-S), for the method toggle

  let popped = $state(false);
  let jumpPos = $state(0);
  let view = $state("classical"); // which backend's results this panel currently inspects
  const es = $derived(embeddingStores[view]); // the viewed store (results/threshold/status are per-backend)

  const isRunning = (s) => s.status === "loading-model" || s.status === "running" || s.status === "scoring";
  const running = $derived(isRunning(es));
  // Any backend running: the view switch is locked while one runs (so we never start two embed loops at
  // once), which keeps the viewed store === the running store — the rest of the panel keys off `running`.
  const anyRunning = $derived(isRunning(embeddingStores.classical) || isRunning(embeddingStores.dino));

  // Coverage control: default is ALL instances (sampleCap null) so no frame is skipped — the sampling
  // gap is exactly why a genuine appearance outlier could go unscored. Uncheck "all" to subsample for
  // speed. capOn mirrors the VIEWED store's sampleCap (follows the backend switch); capVal remembers
  // the last numeric cap across toggles.
  const capOn = $derived(es.sampleCap != null && es.sampleCap > 0);
  let capVal = $state(2000);
  function setCapOn(on) { es.sampleCap = on ? capVal : null; }
  function setCapVal(v) { capVal = Math.max(100, Math.round(v) || 100); es.sampleCap = capVal; }

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

  // Backend chooser: classical pixel features (fast, default) vs the DINO ViT (slow, semantic).
  const BACKEND_INFO = {
    classical: { label: "Classical", tag: "fast", sub: "grayscale pixel features · no download", desc: "Plain pixel features — tiny-image (silhouette) + gradient/HOG (edges, occluding clutter) + intensity histogram (dark occluder / background). No model download, sub-millisecond per crop, so it embeds EVERY instance in seconds and never contends with the UI. Catches gross occlusion / obstruction / nodes-on-background. More literal than DINO (weaker on subtle semantics)." },
    dino: { label: "DINO ViT-S", tag: "slow", sub: "DINOv2 self-supervised 384-d embedding", desc: "DINOv2 vision transformer — a 384-d semantic appearance embedding, strongest on subtle differences. A one-time model download, then batched WASM inference in a background worker (multi-threaded when the host sends COOP/COEP — the label above shows what it actually got). Still ~4.5 GFLOPs per crop: expect minutes, not seconds, at full coverage." },
  };
  const bi = $derived(BACKEND_INFO[view] ?? BACKEND_INFO.classical);
</script>

{#snippet body()}
  <div class="emb" class:wide={popped}>
    <div class="head">
      <span class="ttl">Appearance outliers · {bi.label}</span>
      <button class="pop" onclick={() => (popped = !popped)} title={popped ? "Dock back" : "Pop out"}>{popped ? "⤡" : "⤢"}</button>
    </div>

    <div class="backend" role="group" aria-label="Appearance backend to inspect">
      {#each [["classical", "Classical", "fast"], ["dino", "DINO", "slow"]] as [k, lbl, tag] (k)}
        <button class:sel={view === k} disabled={anyRunning} onclick={() => (view = k)} title={BACKEND_INFO[k].desc}>
          {lbl} <small>{tag}</small>
          {#if embeddingStores[k].hasResults}<span class="rdy" title="{embeddingStores[k].flaggedCount} flagged · computed — its check is available">✓</span>{/if}
        </button>
      {/each}
    </div>
    <p class="be-note">Each backend is its own <b>Appearance</b> check. Switching just changes which you inspect.</p>

    {#if view === "dino"}
      <div class="method" role="group" aria-label="Scoring method">
        <button class:sel={es.method === "knn"} disabled={running} onclick={() => es.setMethod("knn")}
          title="Unsupervised — mean distance to k nearest neighbours (robust-z). No labels. ≈chance on these faults.">kNN <small>unsup</small></button>
        <button class:sel={es.method === "trained"} disabled={running} onclick={() => es.setMethod("trained")}
          title="Supervised RBF-SVM trained on the proofread labels (ported from the dino_probe). CV ROC {clf.cv_roc.toFixed(3)}.">Trained SVM <small>{clf.cv_roc.toFixed(2)} roc</small></button>
      </div>
      {#if es.method === "trained"}
        <p class="be-note">RBF-SVM trained on <b>{clf.dataset}</b> ({clf.granularity}) — CV ROC {clf.cv_roc.toFixed(3)} / PR {clf.cv_pr.toFixed(3)}. Flags by SVM decision (0 = boundary); the unsupervised kNN is ≈chance on these faults.</p>
      {/if}
    {/if}

    <p class="card" title={bi.desc}>
      {es.modelInfo ? `${es.modelInfo.name} · ${es.modelInfo.dim}-d${es.modelInfo.backend ? ` · ${es.modelInfo.backend}` : ""}` : bi.sub} <span class="q">ⓘ</span>
    </p>

    <div class="ctl">
      <label class="allcap" title="Embed EVERY instance — full coverage, so no frame is skipped (embeddings are cached, so this is a one-time cost per file). Uncheck to evenly subsample for speed on very large files.">
        <input type="checkbox" checked={!capOn} onchange={(e) => setCapOn(!e.currentTarget.checked)} disabled={running} />
        all{es.instanceCount ? ` (${es.instanceCount})` : ""}
      </label>
      {#if capOn}
        <label title="Evenly sample this many crops instead of embedding all of them">cap
          <input type="number" min="100" max={es.instanceCount || 100000} step="100" value={capVal} oninput={(e) => setCapVal(+e.currentTarget.value)} disabled={running} />
        </label>
      {/if}
      <label title="Every instance is SCORED, but the “normal” yardstick (the kNN reference) is an even, per-video subsample of this size — decorrelated so near-duplicate video frames don't mask each other. 100% = compare against everything.">ref
        <input type="number" min="5" max="100" step="5" value={Math.round(es.referenceFraction * 100)} oninput={(e) => (es.referenceFraction = Math.min(1, Math.max(0.05, (+e.currentTarget.value || 20) / 100)))} disabled={running} />%
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
                onclick={() => go(p.fi, p.ii)} />
            {/each}
          </svg>
          <p class="cap">{es.records.length} crops{es.method === "trained" ? " · trained SVM" : ` · vs ${es.refCount} ref`} · color = {es.method === "trained" ? "decision" : "z"} · ⚪ = current</p>
          <div class="hist">
            {#each d.bins as b, i (i)}<i style:height="{(100 * b) / d.max}%" class:hot={((i + 0.5) / d.bins.length) * 100 >= d.tx}></i>{/each}
            <span class="thr" style:left="{d.tx}%"></span>
          </div>
          <label class="thr-ctl" title={es.method === "trained" ? "Flag instances whose SVM decision is at or above this (0 = boundary, higher = more faulty)" : "Flag instances whose appearance robust-z is at or above this"}>
            {es.method === "trained" ? "decision ≥" : "z ≥"}
            <input type="range" min={es.method === "trained" ? -3 : 1.5} max={es.method === "trained" ? 3 : 8} step={es.method === "trained" ? 0.05 : 0.1} bind:value={es.threshold} />
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
    {:else if !running && es.status !== "error"}
      <p class="hint">Flags instance crops that look unlike the rest — occlusion / appearance errors geometry misses. {view === "dino" ? "DINO downloads ~90 MB on first run." : "Classical needs no download."} Run to enable its <b>Appearance</b> check.</p>
    {/if}
  </div>
{/snippet}

{#if popped}
  <p class="popped">Popped out · <button class="link" onclick={() => (popped = false)}>show inline</button></p>
  <PopoutWindow title="Appearance outliers · {bi.label}" width="720px" onclose={() => (popped = false)}>{@render body()}</PopoutWindow>
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
  .method { display: inline-flex; border: 1px solid var(--border); border-radius: var(--r-xs); overflow: hidden; }
  .method button { font-size: 0.64rem; color: var(--muted); background: transparent; border: none; border-right: 1px solid var(--border); padding: 0.2rem 0.5rem; cursor: pointer; display: inline-flex; align-items: baseline; gap: 0.3rem; }
  .method button:last-child { border-right: none; }
  .method button small { font-size: 0.52rem; color: var(--dim); text-transform: uppercase; letter-spacing: 0.04em; }
  .method button.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
  .method button:disabled { cursor: default; opacity: 0.55; }
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
