<script>
  // Upload a "manual check" CSV (human faulty/not-faulty review per frame) and compare it to the
  // QC checker's per-frame verdict: a Venn of the two flagged sets, agreement metrics, clickable
  // category tabs that tile each bucket, a per-video area breakdown, and a ranking of which
  // detector (and which feature) best predicts the human-faulty labels. Poppable to a wide layout.
  import { onDestroy } from "svelte";
  import { qc } from "../qcStore.svelte.js";
  import { store } from "../labelsStore.svelte.js";
  import { view } from "../viewStore.svelte.js";
  import { parseManualCheck, metrics } from "../manualCheck.js";
  import { manualCheck } from "../manualCheckStore.svelte.js";
  import PopoutWindow from "./PopoutWindow.svelte";

  // Upload lives in a store, not component-local state, so it survives the panel being collapsed
  // (the collapsible unmounts this component).
  const manual = $derived(manualCheck.manual); // { byKey, faulty, total } | { error } | null
  const fileName = $derived(manualCheck.fileName);
  let activeTab = $state(null); // "both" | "qcOnly" | "manualOnly" | null
  let expanded = $state(null); // detector id whose feature impact is shown
  let perVideoOpen = $state(false);
  let popped = $state(false); // render in a wide pop-out window

  async function onFile(e) {
    const f = e.currentTarget.files?.[0];
    if (!f) return;
    manualCheck.fileName = f.name;
    manualCheck.manual = parseManualCheck(await f.text());
    activeTab = null;
  }

  const vidxMap = () => new Map((store.labels?.videos ?? []).map((v, i) => [v, i]));
  const keyOf = (f, vidx) => `${vidx.get(f.video) ?? 0}:${f.frameIdx}`;

  // Match store frames to manual rows by "<videoIdx>:<frameIdx>", classify vs qc.frameFlagged.
  const cmp = $derived.by(() => {
    void qc.rev;
    if (!manual || manual.error || !qc.hasAnyResults) return null;
    const vidx = vidxMap();
    const cats = { both: [], qcOnly: [], manualOnly: [], neither: [] };
    const perVid = new Map();
    // A faulty-only CSV (faulty_keypoints.csv) lists every faulty frame, so unmatched frames are
    // reviewed-clean and belong in the comparison. An all-frames CSV (status/n_faulty) lists both, so
    // frames it doesn't mention were never reviewed → skip them.
    let matchedManual = 0;
    store.frames.forEach((f, i) => {
      const m = manual.byKey.get(keyOf(f, vidx));
      if (!m && !manual.faultyOnly) return;
      if (m) matchedManual++;
      const manualFaulty = m ? m.faulty : false;
      const qcFlag = qc.frameFlagged(f);
      const cat = qcFlag && manualFaulty ? "both" : qcFlag ? "qcOnly" : manualFaulty ? "manualOnly" : "neither";
      cats[cat].push({ i, note: m?.notes });
      const vi = vidx.get(f.video) ?? 0;
      let pv = perVid.get(vi);
      if (!pv) { pv = { videoIdx: vi, both: 0, qcOnly: 0, manualOnly: 0, neither: 0, n: 0, firstIdx: i }; perVid.set(vi, pv); }
      pv[cat]++; pv.n++;
    });
    const m = metrics({ both: cats.both.length, qcOnly: cats.qcOnly.length, manualOnly: cats.manualOnly.length, neither: cats.neither.length });
    const perVideo = [...perVid.values()].sort((a, b) => (b.both + b.manualOnly) / b.n - (a.both + a.manualOnly) / a.n || a.videoIdx - b.videoIdx);
    return { cats, m, manualUnmatched: manual.total - matchedManual, perVideo };
  });

  // Venn: circle AREA ∝ set size, with a fixed comfortable overlap so the intersection label always
  // has room (exact counts are labeled; the metrics carry the exact numbers).
  const venn = $derived.by(() => {
    if (!cmp) return null;
    const { qcFlagged: A, manualFaulty: B } = cmp.m;
    const W = 250, H = 118, cy = 60, Rmax = 45, big = Math.max(A, B, 1);
    const rA = A ? Math.max(15, Rmax * Math.sqrt(A / big)) : 0;
    const rB = B ? Math.max(15, Rmax * Math.sqrt(B / big)) : 0;
    if (!rA || !rB) {
      const r = rA || rB, x = W / 2;
      return { W, H, cy, rA, rB, ax: x, bx: x, leftX: x, lensX: x, rightX: x, single: true };
    }
    const d = rA + rB - 0.55 * Math.min(rA, rB); // center distance -> ~comfortable lens
    const startX = (W - (rA + d + rB)) / 2;
    const ax = startX + rA, bx = ax + d;
    return { W, H, cy, rA, rB, ax, bx, leftX: (ax - rA + (bx - rB)) / 2, lensX: (ax + rA + (bx - rB)) / 2, rightX: (ax + rA + (bx + rB)) / 2 };
  });

  function scoreSet(set, matched, faulty, nFaulty) {
    let tp = 0, det = 0;
    for (const i of set) if (matched.has(i)) { det++; if (faulty.has(i)) tp++; }
    const precision = det ? tp / det : 0;
    const recall = nFaulty ? tp / nFaulty : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { tp, det, precision, recall, f1 };
  }

  // Which detector best predicts the human-faulty labels? Ranked by F1.
  const ranking = $derived.by(() => {
    void qc.rev;
    if (!cmp || !manual) return null;
    const vidx = vidxMap();
    const matched = new Set(), faulty = new Set();
    store.frames.forEach((f, i) => {
      const m = manual.byKey.get(keyOf(f, vidx));
      if (!m && !manual.faultyOnly) return; // faulty-only file: unmatched frames are reviewed-clean
      matched.add(i);
      if (m?.faulty) faulty.add(i);
    });
    const nFaulty = faulty.size;
    const rows = qc.detectorSets().sets
      .map((s) => ({ id: s.id, label: s.label, expandable: s.id === "anomaly" || s.id === "gmm", ...scoreSet(s.set, matched, faulty, nFaulty) }))
      .sort((a, b) => b.f1 - a.f1 || b.precision - a.precision);
    return { rows, nFaulty, matched, faulty };
  });

  // Per-feature breakdown when an Anomaly/GMM row is expanded (feature 3σ-set vs manual).
  const featureRanking = $derived.by(() => {
    void qc.rev;
    if (!expanded || !ranking) return null;
    const { matched, faulty, nFaulty } = ranking;
    return qc.featureImpactSets(3)
      .map((s) => ({ label: s.label, ...scoreSet(s.set, matched, faulty, nFaulty) }))
      .filter((r) => r.det > 0)
      .sort((a, b) => b.f1 - a.f1 || b.precision - a.precision);
  });

  // While a category tab is open, arrow keys traverse just that bucket; revert when it closes.
  $effect(() => { store.setNavOverride(activeTab && cmp ? cmp.cats[activeTab].map((t) => t.i) : null); });
  onDestroy(() => store.setNavOverride(null));

  function goto(i) {
    store.setIndex(i); store.syncFrameImage?.();
    // Zoom the main view to the frame's flagged instance (its faulty node / bbox), if QC flags one.
    const item = store.frames[i];
    const wi = qc.frameWorstInstance(item);
    const t = wi >= 0 ? qc.faultyTarget(item, wi) : null;
    if (t) view.requestFocus(t.box);
  }
  function tileTitle(t) {
    const f = store.frames[t.i];
    return `frame ${t.i + 1}${f ? ` · idx ${f.frameIdx}` : ""}${t.note ? ` · ${t.note}` : ""}`;
  }
  const pct = (x) => `${Math.round(x * 100)}%`;
  const TABS = [
    { key: "both", label: "agree-faulty" },
    { key: "qcOnly", label: "QC-only" },
    { key: "manualOnly", label: "missed" },
  ];
</script>

{#snippet body()}
  <div class="mcc" class:wide={popped}>
    <div class="mcc-head">
      <label class="upload">
        <input type="file" accept=".csv,text/csv" onchange={onFile} />
        <span>⤒ Upload manual-check CSV</span>
      </label>
      {#if fileName}<span class="fname" title={fileName}>{fileName}</span>{/if}
      <button class="mcc-pop" onclick={() => (popped = !popped)} title={popped ? "Dock back" : "Pop out"}>{popped ? "⤡" : "⤢"}</button>
    </div>

    {#if !manual}
      <p class="hint">Upload a per-frame faulty / not-faulty review CSV to compare it against QC.</p>
    {:else if manual.error}
      <p class="err">{manual.error}</p>
    {:else if !qc.hasResults}
      <p class="hint">Parsed {manual.total} rows ({manual.faulty} faulty) — run QC to compare.</p>
    {:else if cmp}
      {@const m = cmp.m}
      {@const v = venn}
      <div class="mcc-cols">
        <div class="col-a">
          <svg class="venn" viewBox="0 0 {v.W} {v.H}" role="img" aria-label="QC-flagged vs manual-faulty overlap">
            {#if v.rA}<circle cx={v.ax} cy={v.cy} r={v.rA} class="cA" />{/if}
            {#if v.rB}<circle cx={v.bx} cy={v.cy} r={v.rB} class="cB" />{/if}
            {#if m.qcOnly}<text x={v.leftX} y={v.cy} class="rc">{m.qcOnly}</text>{/if}
            {#if m.both}<text x={v.lensX} y={v.cy} class="rc lens">{m.both}</text>{/if}
            {#if m.manualOnly}<text x={v.rightX} y={v.cy} class="rc">{m.manualOnly}</text>{/if}
            <text x="2" y={v.H - 3} class="lbl a" text-anchor="start">QC flagged · {m.qcFlagged}</text>
            <text x={v.W - 2} y={v.H - 3} class="lbl b" text-anchor="end">manual faulty · {m.manualFaulty}</text>
          </svg>

          <div class="metrics">
            <div><b>{pct(m.recall)}</b><span>caught<i>{m.both}/{m.manualFaulty} faulty found</i></span></div>
            <div><b>{pct(m.precision)}</b><span>precision<i>{m.both}/{m.qcFlagged} flags real</i></span></div>
            <div><b>{pct(m.accuracy)}</b><span>agreement<i>{m.both + m.neither}/{m.n} match</i></span></div>
            <div><b>{m.kappa.toFixed(2)}</b><span>κ kappa<i>beyond chance</i></span></div>
          </div>

          <div class="tabs" role="tablist">
            {#each TABS as t (t.key)}
              <button class="tab {t.key}" class:on={activeTab === t.key} disabled={!cmp.cats[t.key].length}
                onclick={() => (activeTab = activeTab === t.key ? null : t.key)}>{t.label} <b>{cmp.cats[t.key].length}</b></button>
            {/each}
          </div>

          {#if activeTab && cmp.cats[activeTab].length}
            <div class="tiles">
              {#each cmp.cats[activeTab].slice(0, 800) as t (t.i)}
                <button class="tile {activeTab}" class:cur={t.i === store.index} class:noted={!!t.note}
                  title={tileTitle(t)} onclick={() => goto(t.i)} aria-label={`Go to frame ${t.i + 1}`}></button>
              {/each}
            </div>
            {#if cmp.cats[activeTab].length > 800}<p class="cover">first 800 of {cmp.cats[activeTab].length}</p>{/if}
          {/if}
          <p class="cover">{m.n} matched · {m.neither} agree-clean{#if cmp.manualUnmatched > 0} · {cmp.manualUnmatched} not in file{/if}</p>
        </div>

        <div class="col-b">
          {#if cmp.perVideo.length > 1}
            {#if !popped}<button class="pv-toggle" onclick={() => (perVideoOpen = !perVideoOpen)} title="Category areas per video (worst first)">{perVideoOpen ? "▾" : "▸"} Per-video areas · {cmp.perVideo.length} videos</button>{/if}
            {#if perVideoOpen || popped}
              <div class="pv-legend">
                <span class="lg both">agree-faulty</span><span class="lg man">missed</span><span class="lg qc">QC-only</span><span class="lg neither">clean</span>
              </div>
              <div class="pv-list">
                {#each cmp.perVideo as pv (pv.videoIdx)}
                  {@const faultyPct = Math.round((100 * (pv.both + pv.manualOnly)) / pv.n)}
                  <button class="pv-row" onclick={() => goto(pv.firstIdx)} title="video {pv.videoIdx} · {pv.n} frames · {faultyPct}% faulty (agree-faulty {pv.both}, missed {pv.manualOnly}, QC-only {pv.qcOnly}, clean {pv.neither}) — click to jump">
                    <span class="pv-name">vid {pv.videoIdx}</span>
                    <span class="pv-bar"><i class="s both" style:width="{(100 * pv.both) / pv.n}%"></i><i class="s man" style:width="{(100 * pv.manualOnly) / pv.n}%"></i><i class="s qc" style:width="{(100 * pv.qcOnly) / pv.n}%"></i><i class="s neither" style:width="{(100 * pv.neither) / pv.n}%"></i></span>
                    <span class="pv-pct" class:hot={faultyPct >= 20}>{faultyPct}%</span>
                    <span class="pv-n">{pv.n}</span>
                  </button>
                {/each}
              </div>
            {/if}
          {/if}

          {#if ranking && ranking.rows.length}
            <div class="rank">
              <p class="rank-h">Detector effectiveness <span title="Ranked by F1 against the human-faulty labels — precision (flags aren't noise) x recall (catches real faults). {ranking.nFaulty} faulty.">vs manual · by F1</span></p>
              {#each ranking.rows as r (r.id)}
                <div class="rrow" title="{r.label}: F1 {r.f1.toFixed(2)} · precision {pct(r.precision)} ({r.tp}/{r.det}) · recall {pct(r.recall)} ({r.tp}/{ranking.nFaulty})">
                  {#if r.expandable}<button class="rexp" onclick={() => (expanded = expanded === r.id ? null : r.id)} title="Break down by feature">{expanded === r.id ? "▾" : "▸"}</button>{:else}<span class="rexp"></span>{/if}
                  <span class="rname">{r.label}</span>
                  <span class="rbar"><i style:width={pct(r.f1)}></i></span>
                  <span class="rf1">{r.f1.toFixed(2)}</span>
                  <span class="rpr">{pct(r.precision)}<span class="rsep">/</span>{pct(r.recall)}</span>
                </div>
                {#if expanded === r.id}
                  {#if featureRanking?.length}
                    {#each featureRanking as fr (fr.label)}
                      <div class="rrow sub" title="{fr.label}: F1 {fr.f1.toFixed(2)} · precision {pct(fr.precision)} ({fr.tp}/{fr.det}) · recall {pct(fr.recall)} ({fr.tp}/{ranking.nFaulty})">
                        <span class="rexp"></span>
                        <span class="rname sub">{fr.label}</span>
                        <span class="rbar sub"><i style:width={pct(fr.f1)}></i></span>
                        <span class="rf1">{fr.f1.toFixed(2)}</span>
                        <span class="rpr">{pct(fr.precision)}<span class="rsep">/</span>{pct(fr.recall)}</span>
                      </div>
                    {/each}
                  {:else}
                    <p class="rank-k sub-note">no single feature clears 3σ on the reviewed frames</p>
                  {/if}
                {/if}
              {/each}
              <p class="rank-k">▸ expand Anomaly/GMM for per-feature impact · P/R = precision/recall</p>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
{/snippet}

{#if popped}
  <p class="mcc-popped">Popped out · <button class="mcc-link" onclick={() => (popped = false)}>show inline</button></p>
  <PopoutWindow title="Manual-check comparison" width="760px" onclose={() => (popped = false)}>{@render body()}</PopoutWindow>
{:else}
  {@render body()}
{/if}

<style>
  .mcc { display: flex; flex-direction: column; gap: 0.5rem; }
  .mcc-head { display: flex; align-items: center; gap: 0.4rem; }
  .upload {
    display: inline-flex; align-items: center; font-size: 0.72rem; color: var(--accent);
    border: 1px dashed color-mix(in srgb, var(--accent) 45%, transparent);
    border-radius: var(--r-xs); padding: 0.28rem 0.5rem; cursor: pointer; white-space: nowrap;
  }
  .upload input { display: none; }
  .fname { font-size: 0.64rem; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; min-width: 0; }
  .mcc-pop { margin-left: auto; background: none; border: none; color: var(--dim); font-size: 0.9rem; cursor: pointer; padding: 0 0.1rem; flex: none; }
  .mcc-pop:hover { color: var(--accent); }
  .err { font-size: 0.68rem; color: #fca5a5; margin: 0; }
  .hint { font-size: 0.68rem; color: var(--dim); margin: 0; }

  .mcc-cols { display: flex; flex-direction: column; gap: 0.5rem; }
  .mcc.wide .mcc-cols { display: grid; grid-template-columns: 264px 1fr; gap: 1.2rem; align-items: start; }
  .col-a, .col-b { display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; }

  /* Venn */
  .venn { width: 100%; max-width: 250px; align-self: center; overflow: visible; }
  .cA { fill: rgba(95, 217, 242, 0.30); stroke: #5fd9f2; stroke-width: 1.2; }
  .cB { fill: rgba(251, 146, 110, 0.30); stroke: #fb926e; stroke-width: 1.2; }
  .rc { fill: var(--text); font-size: 13px; font-weight: 700; text-anchor: middle; dominant-baseline: central; paint-order: stroke; stroke: #0b0e13; stroke-width: 3px; }
  .rc.lens { font-size: 11px; }
  .lbl { font-size: 8.5px; }
  .lbl.a { fill: #5fd9f2; }
  .lbl.b { fill: #fb926e; }

  .metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.3rem; }
  .metrics > div { display: flex; align-items: baseline; gap: 0.4rem; background: rgba(255, 255, 255, 0.03); border-radius: var(--r-xs); padding: 0.3rem 0.45rem; }
  .metrics b { font-size: 0.9rem; font-variant-numeric: tabular-nums; }
  .metrics span { display: flex; flex-direction: column; font-size: 0.66rem; color: var(--muted); line-height: 1.2; }
  .metrics i { font-style: normal; font-size: 0.56rem; color: var(--dim); }

  .tabs { display: flex; gap: 0.3rem; }
  .tab { flex: 1 1 0; min-width: 0; font-size: 0.64rem; border: 1px solid var(--border); border-radius: var(--r-xs); padding: 0.26rem 0.3rem; background: none; color: var(--muted); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tab b { font-variant-numeric: tabular-nums; }
  .tab:disabled { opacity: 0.4; cursor: default; }
  .tab.both.on { border-color: #86efac; color: #86efac; background: rgba(134, 239, 172, 0.12); }
  .tab.qcOnly.on { border-color: #5fd9f2; color: #5fd9f2; background: rgba(95, 217, 242, 0.12); }
  .tab.manualOnly.on { border-color: #fb926e; color: #fb926e; background: rgba(251, 146, 110, 0.12); }

  .tiles { display: flex; flex-wrap: wrap; gap: 3px; max-height: 150px; overflow-y: auto; padding: 2px; background: rgba(0, 0, 0, 0.2); border-radius: var(--r-xs); }
  .mcc.wide .tiles { max-height: 220px; }
  .tile { width: 15px; height: 15px; border-radius: 2px; cursor: pointer; padding: 0; border: none; }
  .tile.both { background: rgba(134, 239, 172, 0.35); }
  .tile.qcOnly { background: rgba(95, 217, 242, 0.35); }
  .tile.manualOnly { background: rgba(251, 146, 110, 0.35); }
  .tile.noted { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35); }
  .tile.cur { outline: 2px solid #fff; outline-offset: 1px; }
  .tile:hover { filter: brightness(1.5); }

  .pv-toggle { align-self: flex-start; background: none; border: none; color: var(--dim); font-size: 0.66rem; cursor: pointer; padding: 0; }
  .pv-toggle:hover { color: var(--accent); }
  .pv-legend { display: flex; flex-wrap: wrap; gap: 0.5rem; font-size: 0.56rem; color: var(--dim); }
  .lg { display: inline-flex; align-items: center; gap: 0.2rem; }
  .lg::before { content: ""; width: 8px; height: 8px; border-radius: 2px; }
  .lg.both::before { background: #86efac; }
  .lg.man::before { background: #fb926e; }
  .lg.qc::before { background: #5fd9f2; }
  .lg.neither::before { background: #39414f; }
  .pv-list { display: flex; flex-direction: column; gap: 2px; max-height: 160px; overflow-y: auto; }
  .mcc.wide .pv-list { max-height: 300px; }
  .pv-row { display: grid; grid-template-columns: 2.6rem 1fr 2.2rem 2.4rem; align-items: center; gap: 0.35rem; background: none; border: none; padding: 1px 0; cursor: pointer; }
  .pv-row:hover { background: rgba(255, 255, 255, 0.04); }
  .pv-name { font-size: 0.62rem; color: var(--muted); text-align: left; }
  .pv-bar { display: flex; height: 9px; border-radius: 2px; overflow: hidden; }
  .pv-bar .s { height: 100%; }
  .pv-bar .s.both { background: #86efac; }
  .pv-bar .s.man { background: #fb926e; }
  .pv-bar .s.qc { background: #5fd9f2; }
  .pv-bar .s.neither { background: #2a313d; }
  .pv-pct { font-size: 0.62rem; font-variant-numeric: tabular-nums; color: var(--muted); text-align: right; }
  .pv-pct.hot { color: #fca5a5; font-weight: 600; }
  .pv-n { font-size: 0.58rem; color: var(--dim); text-align: right; }

  .rank { display: flex; flex-direction: column; gap: 0.16rem; }
  .rank-h { font-size: 0.66rem; color: var(--muted); margin: 0.15rem 0 0.1rem; }
  .rank-h span { color: var(--accent); cursor: help; }
  .rrow { display: grid; grid-template-columns: 0.9rem 3.9rem 1fr 2rem 3.2rem; align-items: center; gap: 0.3rem; font-size: 0.64rem; }
  .rexp { width: 0.9rem; background: none; border: none; color: var(--dim); font-size: 0.55rem; cursor: pointer; padding: 0; text-align: left; }
  button.rexp:hover { color: var(--accent); }
  .rrow.sub { font-size: 0.6rem; }
  .sub-note { padding-left: 1.2rem; margin: 0; }
  .rname { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rname.sub { color: var(--muted); }
  .rbar { height: 6px; background: rgba(255, 255, 255, 0.06); border-radius: 3px; overflow: hidden; }
  .rbar i { display: block; height: 100%; background: linear-gradient(90deg, #5fd9f2, #86efac); }
  .rbar.sub i { opacity: 0.7; }
  .rf1 { font-variant-numeric: tabular-nums; color: var(--text); text-align: right; }
  .rpr { font-variant-numeric: tabular-nums; color: var(--dim); text-align: right; }
  .rsep { color: var(--border); margin: 0 1px; }
  .rank-k { font-size: 0.56rem; color: var(--dim); margin: 0.05rem 0 0; text-align: right; }
  .cover { font-size: 0.62rem; color: var(--dim); margin: 0; }

  /* pop-out (inline "popped out" note; the window itself is PopoutWindow) */
  .mcc-popped { margin: 0; font-size: 0.72rem; color: var(--dim); }
  .mcc-link { background: none; border: none; padding: 0; font: inherit; color: var(--accent); cursor: pointer; }
</style>
