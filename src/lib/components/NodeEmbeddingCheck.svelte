<script>
  // RESULT VIEWER for the per-keypoint appearance check: every keypoint type gets its OWN outlier graph,
  // so a single mis-placed / occluded node stands out against the same node elsewhere. The node selector
  // doubles as the per-node flagged-count summary. Configuration and launching live in AppearanceWindow —
  // this renders nothing until there are results.
  import { store } from "../labelsStore.svelte.js";
  import { view as viewport } from "../viewStore.svelte.js";
  import { nodeEmbeddingStores } from "../nodeEmbeddingStore.svelte.js";
  import { nodePointBox } from "../qc/focusBox.js";
  import { keypointLabels } from "../keypointLabels.svelte.js";

  let jumpPos = $state(0);
  const es = nodeEmbeddingStores.dino;

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

  // One chip per SKELETON keypoint, not per result row. A keypoint the run never embedded used to have
  // no chip at all, which reads as "this skeleton has 3 keypoints" rather than "nothing is known about
  // the other 10" — the exact confusion a subset pass invites. Built here rather than in the store so
  // nodeStats keeps its record-derived contract.
  const chips = $derived.by(() => {
    void es.resultRev;
    const names = store.skeleton?.nodeNames ?? [];
    const byNode = new Map(es.nodeStats.map((n) => [n.node, n]));
    const rows = names.length ? names.map((_, ni) => ni) : es.nodeStats.map((n) => n.node);
    return rows.map((ni) => {
      const ns = byNode.get(ni);
      if (!ns) return { node: ni, state: "absent", count: 0 };            // never embedded
      if (!ns.scored) return { node: ni, state: "few", count: ns.count }; // embedded, too few to score
      return { node: ni, state: "scored", count: ns.count, refCount: ns.refCount };
    });
  });
  const someAbsent = $derived(chips.some((c) => c.state === "absent"));

  // ---- train an SVM on the judged patches of the viewed keypoint ---------------------------------
  // The embeddings are already here and the labels are already here; this closes the loop without a
  // round trip through the offline exporter. Fit on EVERY judged patch — never a sample.
  let trained = $state(null);   // { node, cv, warning }
  let trainErr = $state("");
  let training = $state(false);
  const trainable = $derived.by(() => {
    void es.resultRev; void keypointLabels.rev;
    const ni = es.selectedNode;
    return ni == null ? null : es.trainableFor(ni);
  });
  function train() {
    const ni = es.selectedNode;
    if (ni == null) return;
    training = true; trainErr = ""; trained = null;
    try {
      const { clf, cv, warning } = es.trainFor(ni);
      es.applyTrainedModel(ni, clf);
      trained = { node: ni, cv, warning };
    } catch (e) {
      trainErr = e?.message ?? String(e);
    } finally {
      training = false;
    }
  }
</script>

<div class="emb">
  {#if es.hasResults}
    <!-- Node selector = per-node flagged-count summary in one row: click a keypoint to view its graph. -->
    <div class="nodes" role="group" aria-label="Keypoint">
      {#each chips as ch (ch.node)}
        {@const flagged = ch.state === "scored" ? es.flaggedCountForNode(ch.node) : 0}
        <button class="nodechip" class:sel={es.selectedNode === ch.node}
          class:unscored={ch.state === "few"} class:absent={ch.state === "absent"}
          disabled={ch.state !== "scored"} onclick={() => (es.selectedNode = ch.node)}
          title={ch.state === "scored" ? `${nodeName(ch.node)} · ${ch.count} patches · ${flagged} flagged · ref ${ch.refCount}`
            : ch.state === "few" ? `${nodeName(ch.node)} · ${ch.count} patches — too few to score`
              : `${nodeName(ch.node)} — NOT embedded in this run. Nothing is known about it; re-run with it selected.`}>
          {nodeName(ch.node)}{#if ch.state === "scored"}<span class="nc" class:hot={flagged > 0}>{flagged}</span>{/if}
        </button>
      {/each}
    </div>
    {#if es.selectedNode != null && trainable}
      <div class="train">
        <div class="t-row">
          <span class="t-l">Train an SVM on <b>{nodeName(es.selectedNode)}</b></span>
          <span class="t-n">{trainable.n} judged · {trainable.pos} faulty / {trainable.neg} clean</span>
          <button class="t-go" disabled={!trainable.enough || training} onclick={train}
                  title={trainable.enough
                    ? "Fits on every judged patch of this keypoint — no sampling — and scores itself by stratified cross-validation"
                    : "Needs at least one faulty AND one clean judged patch of this keypoint. Proofread a few frames first."}>
            {training ? "fitting…" : "fit"}
          </button>
        </div>
        {#if !trainable.enough}
          <p class="t-warn">Needs at least one faulty and one clean judged <b>{nodeName(es.selectedNode)}</b> — one class cannot be learned.</p>
        {:else if trainable.pos < trainable.floor}
          <p class="t-warn">
            ⚠ Only {trainable.pos} faulty example{trainable.pos === 1 ? "" : "s"}. Below {trainable.floor} the
            cross-validated score is noise rather than a measurement — label more before trusting it.
          </p>
        {/if}
        {#if trainErr}<p class="t-err">{trainErr}</p>{/if}
        {#if trained && trained.node === es.selectedNode}
          <p class="t-res">
            ✓ fitted on {trained.cv.nPos + trained.cv.nNeg} judged patches ·
            <b>CV ROC {trained.cv.roc == null ? "—" : trained.cv.roc.toFixed(3)}</b>
            {#if trained.cv.pr != null}· PR {trained.cv.pr.toFixed(3)}{/if}
            <span class="t-k">({trained.cv.folds}-fold, held out)</span>
          </p>
          {#if trained.warning}<p class="t-warn">⚠ {trained.warning}</p>{/if}
          <p class="t-note">Scores below now come from this model. It is trained on <i>this</i> file — it is not the validated bundle, and its score is only as good as the labels behind it.</p>
        {/if}
      </div>
    {/if}
    {#if someAbsent}
      <p class="cov">
        ✳ {chips.filter((c) => c.state !== "absent").length} of {chips.length} keypoints embedded —
        the struck-through ones were not looked at, which is not the same as clean.
      </p>
    {/if}

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
  {/if}
</div>

<style>
  .emb { display: flex; flex-direction: column; gap: 0.5rem; }
  .hint { font-size: 0.66rem; color: var(--dim); margin: 0; }
  .cov { margin: 0; font-size: 0.6rem; color: #f0b47a; line-height: 1.4; }
  .train { display: flex; flex-direction: column; gap: 0.25rem; padding: 0.4rem 0.5rem; border: 1px solid var(--border); border-radius: 7px; }
  .t-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .t-l { font-size: 0.68rem; color: var(--text); }
  .t-n { font-size: 0.6rem; color: var(--dim); font-variant-numeric: tabular-nums; margin-left: auto; }
  .t-go { background: transparent; border: 1px solid var(--accent); border-radius: var(--r-xs); color: var(--accent); font-size: 0.64rem; padding: 0.15rem 0.6rem; cursor: pointer; }
  .t-go:disabled { opacity: 0.4; border-color: var(--border); color: var(--dim); cursor: default; }
  .t-warn { margin: 0; font-size: 0.6rem; color: #f0b47a; line-height: 1.4; }
  .t-err { margin: 0; font-size: 0.6rem; color: #fca5a5; }
  .t-res { margin: 0; font-size: 0.64rem; color: #6ee7a8; }
  .t-res b { color: #6ee7a8; }
  .t-k { color: var(--dim); font-size: 0.56rem; }
  .t-note { margin: 0; font-size: 0.58rem; color: var(--dim); line-height: 1.4; }
  /* struck through, like the picker's off-state — the same keypoint in the same visual language */
  .nodechip.absent { text-decoration: line-through; opacity: 0.5; border-style: dashed; }

  .nodes { display: flex; flex-wrap: wrap; gap: 3px; }
  .nodechip { font-size: 0.6rem; color: var(--muted); background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-xs); padding: 0.12rem 0.35rem; cursor: pointer; display: inline-flex; align-items: center; gap: 0.25rem; }
  .nodechip:hover:not(:disabled) { border-color: var(--accent); }
  .nodechip.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); border-color: var(--accent); }
  .nodechip.unscored { opacity: 0.4; cursor: default; }
  .nodechip .nc { font-size: 0.54rem; background: rgba(255,255,255,0.08); border-radius: 999px; padding: 0 0.28rem; font-variant-numeric: tabular-nums; }
  .nodechip .nc.hot { background: #fb926e; color: #1a1a1a; font-weight: 600; }

  .cols { display: flex; flex-direction: column; gap: 0.6rem; }
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

</style>
