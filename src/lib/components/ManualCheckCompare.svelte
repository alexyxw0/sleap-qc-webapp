<script>
  // Upload a "manual check" CSV (human faulty/not-faulty review per frame) and compare it to the
  // QC checker's per-frame verdict: a proportional Euler (Venn) of the two flagged sets, agreement
  // metrics, clickable category tabs that tile the frames in each bucket, and a ranking of which
  // detector best predicts the human-faulty labels (by F1).
  import { qc } from "../qcStore.svelte.js";
  import { store } from "../labelsStore.svelte.js";
  import { parseManualCheck, metrics } from "../manualCheck.js";

  let manual = $state(null); // { byKey, faulty, total } | { error }
  let fileName = $state("");
  let activeTab = $state(null); // "both" | "qcOnly" | "manualOnly" | null

  async function onFile(e) {
    const f = e.currentTarget.files?.[0];
    if (!f) return;
    fileName = f.name;
    manual = parseManualCheck(await f.text());
    activeTab = null;
  }

  const vidxMap = () => new Map((store.labels?.videos ?? []).map((v, i) => [v, i]));
  const keyOf = (f, vidx) => `${vidx.get(f.video) ?? 0}:${f.frameIdx}`;

  // Match store frames to manual rows by "<videoIdx>:<frameIdx>", classify vs qc.frameFlagged.
  const cmp = $derived.by(() => {
    void qc.rev;
    if (!manual || manual.error || !qc.hasResults) return null;
    const vidx = vidxMap();
    const cats = { both: [], qcOnly: [], manualOnly: [], neither: [] };
    store.frames.forEach((f, i) => {
      const m = manual.byKey.get(keyOf(f, vidx));
      if (!m) return; // frame wasn't in the manual review — excluded
      const qcFlag = qc.frameFlagged(f);
      const cat = qcFlag && m.faulty ? "both" : qcFlag ? "qcOnly" : m.faulty ? "manualOnly" : "neither";
      cats[cat].push({ i, note: m.notes });
    });
    const m = metrics({ both: cats.both.length, qcOnly: cats.qcOnly.length, manualOnly: cats.manualOnly.length, neither: cats.neither.length });
    return { cats, m, manualUnmatched: manual.total - m.n };
  });

  // Euler geometry: circle AREA ∝ set size; center distance ∝ how much of the smaller set overlaps.
  const venn = $derived.by(() => {
    if (!cmp) return null;
    const { qcFlagged: A, manualFaulty: B, both } = cmp.m;
    const W = 240, cy = 58, Rmax = 42, big = Math.max(A, B, 1);
    const rA = A ? Math.max(9, Rmax * Math.sqrt(A / big)) : 0;
    const rB = B ? Math.max(9, Rmax * Math.sqrt(B / big)) : 0;
    const overlap = Math.min(A, B) ? both / Math.min(A, B) : 0;
    const d = rA && rB ? rA + rB - overlap * (rA + rB - Math.abs(rA - rB)) : 0;
    const ax = W / 2 - d / 2, bx = W / 2 + d / 2;
    const lens = rA && rB ? (ax + rA + (bx - rB)) / 2 : W / 2;
    return { W, H: 116, cy, rA, rB, ax, bx, lens };
  });

  // Which detector best predicts the human-faulty labels? Per detector: precision/recall/F1 over
  // the matched frames. F1 balances "flags real faults" (recall) with "flags aren't noise" (precision).
  const ranking = $derived.by(() => {
    void qc.rev;
    if (!cmp || !manual) return null;
    const vidx = vidxMap();
    const matched = new Set(), faulty = new Set();
    store.frames.forEach((f, i) => {
      const m = manual.byKey.get(keyOf(f, vidx));
      if (!m) return;
      matched.add(i);
      if (m.faulty) faulty.add(i);
    });
    const nFaulty = faulty.size;
    const rows = qc.detectorSets().sets
      .map((s) => {
        let tp = 0, det = 0;
        for (const i of s.set) if (matched.has(i)) { det++; if (faulty.has(i)) tp++; }
        const precision = det ? tp / det : 0;
        const recall = nFaulty ? tp / nFaulty : 0;
        const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
        return { label: s.label, tp, det, precision, recall, f1 };
      })
      .sort((a, b) => b.f1 - a.f1 || b.precision - a.precision);
    return { rows, nFaulty };
  });

  function goto(i) { store.setIndex(i); store.syncFrameImage?.(); }
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

<div class="mcc">
  <label class="upload">
    <input type="file" accept=".csv,text/csv" onchange={onFile} />
    <span>⤒ Upload manual-check CSV</span>
  </label>
  {#if fileName}<span class="fname" title={fileName}>{fileName}</span>{/if}

  {#if manual?.error}
    <p class="err">{manual.error}</p>
  {:else if manual && !qc.hasResults}
    <p class="hint">Run QC first, then the comparison appears.</p>
  {:else if cmp}
    {@const m = cmp.m}
    {@const v = venn}
    <svg class="venn" viewBox="0 0 {v.W} {v.H}" role="img" aria-label="QC-flagged vs manual-faulty overlap">
      {#if v.rA}<circle cx={v.ax} cy={v.cy} r={v.rA} class="cA" />{/if}
      {#if v.rB}<circle cx={v.bx} cy={v.cy} r={v.rB} class="cB" />{/if}
      {#if m.qcOnly}<text x={v.rA ? v.ax - v.rA * 0.45 : v.W / 2} y={v.cy} class="rc">{m.qcOnly}</text>{/if}
      {#if m.both}<text x={v.lens} y={v.cy} class="rc">{m.both}</text>{/if}
      {#if m.manualOnly}<text x={v.rB ? v.bx + v.rB * 0.45 : v.W / 2} y={v.cy} class="rc">{m.manualOnly}</text>{/if}
      <text x="1" y={v.H - 3} class="lbl a" text-anchor="start">◑ QC flagged · {m.qcFlagged}</text>
      <text x={v.W - 1} y={v.H - 3} class="lbl b" text-anchor="end">manual faulty · {m.manualFaulty} ◐</text>
    </svg>

    <div class="metrics">
      <div><b>{pct(m.recall)}</b><span>caught<i>{m.both}/{m.manualFaulty} faulty found</i></span></div>
      <div><b>{pct(m.precision)}</b><span>precision<i>{m.both}/{m.qcFlagged} flags real</i></span></div>
      <div><b>{pct(m.accuracy)}</b><span>agreement<i>{m.both + m.neither}/{m.n} match</i></span></div>
      <div><b>{m.kappa.toFixed(2)}</b><span>κ kappa<i>beyond chance</i></span></div>
    </div>

    <div class="tabs" role="tablist">
      {#each TABS as t (t.key)}
        <button
          class="tab {t.key}"
          class:on={activeTab === t.key}
          disabled={!cmp.cats[t.key].length}
          onclick={() => (activeTab = activeTab === t.key ? null : t.key)}
        >{t.label} <b>{cmp.cats[t.key].length}</b></button>
      {/each}
    </div>

    {#if activeTab && cmp.cats[activeTab].length}
      <div class="tiles">
        {#each cmp.cats[activeTab].slice(0, 800) as t (t.i)}
          <button
            class="tile {activeTab}"
            class:cur={t.i === store.index}
            class:noted={!!t.note}
            title={tileTitle(t)}
            onclick={() => goto(t.i)}
            aria-label={`Go to frame ${t.i + 1}`}
          ></button>
        {/each}
      </div>
      {#if cmp.cats[activeTab].length > 800}<p class="cover">showing first 800 of {cmp.cats[activeTab].length}</p>{/if}
    {/if}

    {#if ranking && ranking.rows.length}
      <div class="rank">
        <p class="rank-h">Detector effectiveness <span title="Ranked by F1 against the human-faulty labels — the balance of precision (flags aren't noise) and recall (catches real faults). Best for this imbalanced, {ranking.nFaulty}-faulty set.">vs manual · by F1</span></p>
        {#each ranking.rows as r (r.label)}
          <div class="rrow" title="{r.label}: F1 {r.f1.toFixed(2)} · precision {pct(r.precision)} ({r.tp}/{r.det}) · recall {pct(r.recall)} ({r.tp}/{ranking.nFaulty})">
            <span class="rname">{r.label}</span>
            <span class="rbar"><i style:width={pct(r.f1)}></i></span>
            <span class="rf1">{r.f1.toFixed(2)}</span>
            <span class="rpr">{pct(r.precision)}<span class="rsep">/</span>{pct(r.recall)}</span>
          </div>
        {/each}
        <p class="rank-k">P / R = precision / recall</p>
      </div>
    {/if}

    <p class="cover">
      {m.n} matched · {m.neither} agree-clean{#if cmp.manualUnmatched > 0} · {cmp.manualUnmatched} manual row{cmp.manualUnmatched === 1 ? "" : "s"} not in file{/if}
    </p>
  {:else if manual}
    <p class="hint">Parsed {manual.total} row{manual.total === 1 ? "" : "s"} ({manual.faulty} faulty) — run QC to compare.</p>
  {/if}
</div>

<style>
  .mcc { display: flex; flex-direction: column; gap: 0.45rem; }
  .upload {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    font-size: 0.72rem;
    color: var(--accent);
    border: 1px dashed color-mix(in srgb, var(--accent) 45%, transparent);
    border-radius: var(--r-xs);
    padding: 0.28rem 0.5rem;
    cursor: pointer;
  }
  .upload input { display: none; }
  .fname { font-size: 0.64rem; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .err { font-size: 0.68rem; color: #fca5a5; margin: 0; }
  .hint { font-size: 0.68rem; color: var(--dim); margin: 0; }

  .venn { width: 100%; max-width: 260px; align-self: center; overflow: visible; }
  .cA { fill: rgba(95, 217, 242, 0.32); stroke: #5fd9f2; stroke-width: 1; }
  .cB { fill: rgba(251, 146, 110, 0.32); stroke: #fb926e; stroke-width: 1; }
  .rc { fill: var(--text); font-size: 12px; font-weight: 700; text-anchor: middle; dominant-baseline: central; paint-order: stroke; stroke: #0b0e13; stroke-width: 2.5px; }
  .lbl { font-size: 8.5px; }
  .lbl.a { fill: #5fd9f2; }
  .lbl.b { fill: #fb926e; }

  .metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.3rem; }
  .metrics > div { display: flex; align-items: baseline; gap: 0.3rem; background: rgba(255, 255, 255, 0.03); border-radius: var(--r-xs); padding: 0.28rem 0.4rem; }
  .metrics b { font-size: 0.85rem; font-variant-numeric: tabular-nums; min-width: 2.6ch; }
  .metrics span { display: flex; flex-direction: column; font-size: 0.66rem; color: var(--muted); line-height: 1.2; }
  .metrics i { font-style: normal; font-size: 0.56rem; color: var(--dim); }

  .tabs { display: flex; gap: 0.3rem; }
  .tab {
    flex: 1 1 0;
    min-width: 0;
    font-size: 0.64rem;
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    padding: 0.26rem 0.3rem;
    background: none;
    color: var(--muted);
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tab b { font-variant-numeric: tabular-nums; }
  .tab:disabled { opacity: 0.4; cursor: default; }
  .tab.both.on { border-color: #86efac; color: #86efac; background: rgba(134, 239, 172, 0.12); }
  .tab.qcOnly.on { border-color: #5fd9f2; color: #5fd9f2; background: rgba(95, 217, 242, 0.12); }
  .tab.manualOnly.on { border-color: #fb926e; color: #fb926e; background: rgba(251, 146, 110, 0.12); }

  .tiles {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    max-height: 150px;
    overflow-y: auto;
    padding: 2px;
    background: rgba(0, 0, 0, 0.2);
    border-radius: var(--r-xs);
  }
  .tile { width: 15px; height: 15px; border: 1px solid transparent; border-radius: 2px; cursor: pointer; padding: 0; }
  .tile.both { background: rgba(134, 239, 172, 0.35); }
  .tile.qcOnly { background: rgba(95, 217, 242, 0.35); }
  .tile.manualOnly { background: rgba(251, 146, 110, 0.35); }
  .tile.noted { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35); }
  .tile.cur { outline: 2px solid #fff; outline-offset: 1px; }
  .tile:hover { filter: brightness(1.5); }

  .rank { display: flex; flex-direction: column; gap: 0.16rem; }
  .rank-h { font-size: 0.66rem; color: var(--muted); margin: 0.15rem 0 0.1rem; }
  .rank-h span { color: var(--accent); cursor: help; }
  .rrow { display: grid; grid-template-columns: 4.6rem 1fr 2.2rem 3.4rem; align-items: center; gap: 0.35rem; font-size: 0.64rem; }
  .rname { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rbar { height: 6px; background: rgba(255, 255, 255, 0.06); border-radius: 3px; overflow: hidden; }
  .rbar i { display: block; height: 100%; background: linear-gradient(90deg, #5fd9f2, #86efac); }
  .rf1 { font-variant-numeric: tabular-nums; color: var(--text); text-align: right; }
  .rpr { font-variant-numeric: tabular-nums; color: var(--dim); text-align: right; }
  .rsep { color: var(--border); margin: 0 1px; }
  .rank-k { font-size: 0.56rem; color: var(--dim); margin: 0.05rem 0 0; text-align: right; }
  .cover { font-size: 0.62rem; color: var(--dim); margin: 0; }
</style>
