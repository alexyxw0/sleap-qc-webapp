<script>
  // Upload a "manual check" CSV (human faulty/not-faulty review per frame) and compare it to the
  // QC checker's per-frame verdict. Shows a proportional Euler (Venn) of the two flagged sets +
  // agreement metrics, and lets you jump through the frames where they disagree.
  import { qc } from "../qcStore.svelte.js";
  import { store } from "../labelsStore.svelte.js";
  import { parseManualCheck, metrics } from "../manualCheck.js";

  let manual = $state(null); // { byKey, faulty, total } | { error }
  let fileName = $state("");

  async function onFile(e) {
    const f = e.currentTarget.files?.[0];
    if (!f) return;
    fileName = f.name;
    manual = parseManualCheck(await f.text());
    cursor = { both: 0, qcOnly: 0, manualOnly: 0, neither: 0 };
  }

  // Match store frames to manual rows by "<videoIdx>:<frameIdx>", classify vs qc.frameFlagged.
  const cmp = $derived.by(() => {
    void qc.rev;
    if (!manual || manual.error || !qc.hasResults) return null;
    const vidx = new Map((store.labels?.videos ?? []).map((v, i) => [v, i]));
    const cats = { both: [], qcOnly: [], manualOnly: [], neither: [] };
    store.frames.forEach((f, i) => {
      const m = manual.byKey.get(`${vidx.get(f.video) ?? 0}:${f.frameIdx}`);
      if (!m) return; // frame wasn't in the manual review — excluded
      const qcFlag = qc.frameFlagged(f);
      const cat = qcFlag && m.faulty ? "both" : qcFlag ? "qcOnly" : m.faulty ? "manualOnly" : "neither";
      cats[cat].push(i);
    });
    const m = metrics({ both: cats.both.length, qcOnly: cats.qcOnly.length, manualOnly: cats.manualOnly.length, neither: cats.neither.length });
    return { cats, m, manualUnmatched: manual.total - m.n };
  });

  // Euler geometry: circle AREA ∝ set size; center distance ∝ how much of the smaller set overlaps.
  const venn = $derived.by(() => {
    if (!cmp) return null;
    const { qcFlagged: A, manualFaulty: B, both } = cmp.m;
    const W = 240, cy = 66, Rmax = 44, big = Math.max(A, B, 1);
    const rA = A ? Math.max(9, Rmax * Math.sqrt(A / big)) : 0;
    const rB = B ? Math.max(9, Rmax * Math.sqrt(B / big)) : 0;
    const minAB = Math.min(A, B);
    const overlap = minAB ? both / minAB : 0; // 0 = disjoint, 1 = smaller fully inside
    const d = rA && rB ? rA + rB - overlap * (rA + rB - Math.abs(rA - rB)) : 0;
    const ax = W / 2 - d / 2, bx = W / 2 + d / 2;
    return { W, H: 132, cy, rA, rB, ax, bx, mid: (ax + bx) / 2 };
  });

  // Jump through a disagreement bucket (cycles).
  let cursor = $state({ both: 0, qcOnly: 0, manualOnly: 0, neither: 0 });
  function jump(cat) {
    const list = cmp?.cats?.[cat];
    if (!list?.length) return;
    const k = cursor[cat] % list.length;
    store.setIndex(list[k]);
    store.syncFrameImage?.();
    cursor = { ...cursor, [cat]: (cursor[cat] + 1) % list.length };
  }
  const pct = (x) => `${Math.round(x * 100)}%`;
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
      {#if m.qcOnly}<text x={v.rA ? v.ax - v.rA * 0.55 : v.mid} y={v.cy} class="rc">{m.qcOnly}</text>{/if}
      {#if m.both}<text x={v.mid} y={v.cy} class="rc">{m.both}</text>{/if}
      {#if m.manualOnly}<text x={v.rB ? v.bx + v.rB * 0.55 : v.mid} y={v.cy} class="rc">{m.manualOnly}</text>{/if}
      <text x={v.ax} y={v.H - 8} class="lbl a">QC flagged · {m.qcFlagged}</text>
      <text x={v.bx} y={v.H - 8} class="lbl b">manual faulty · {m.manualFaulty}</text>
    </svg>

    <div class="metrics">
      <div><b>{pct(m.recall)}</b><span>caught<i>QC found {m.both}/{m.manualFaulty} faulty</i></span></div>
      <div><b>{pct(m.precision)}</b><span>precision<i>{m.both}/{m.qcFlagged} QC flags were faulty</i></span></div>
      <div><b>{pct(m.accuracy)}</b><span>agreement<i>{m.both + m.neither}/{m.n} frames match</i></span></div>
      <div><b>{m.kappa.toFixed(2)}</b><span>κ (kappa)<i>agreement beyond chance</i></span></div>
    </div>

    <div class="buckets">
      <button class="bk both" disabled={!m.both} onclick={() => jump("both")}>agree-faulty {m.both} →</button>
      <button class="bk qc" disabled={!m.qcOnly} onclick={() => jump("qcOnly")}>QC-only (false pos) {m.qcOnly} →</button>
      <button class="bk man" disabled={!m.manualOnly} onclick={() => jump("manualOnly")}>missed {m.manualOnly} →</button>
    </div>
    <p class="cover">
      {m.n} matched frame{m.n === 1 ? "" : "s"} · {m.neither} agree-clean
      {#if cmp.manualUnmatched > 0}· {cmp.manualUnmatched} manual row{cmp.manualUnmatched === 1 ? "" : "s"} not in this file{/if}
    </p>
  {:else if manual}
    <p class="hint">Parsed {manual.total} row{manual.total === 1 ? "" : "s"} ({manual.faulty} faulty) — run QC to compare.</p>
  {/if}
</div>

<style>
  .mcc {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
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
  .fname {
    font-size: 0.64rem;
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .err { font-size: 0.68rem; color: #fca5a5; margin: 0.2rem 0 0; }
  .hint { font-size: 0.68rem; color: var(--dim); margin: 0.2rem 0 0; }

  .venn {
    width: 100%;
    max-width: 260px;
    align-self: center;
    overflow: visible;
  }
  .cA { fill: rgba(95, 217, 242, 0.34); stroke: #5fd9f2; stroke-width: 1; }
  .cB { fill: rgba(251, 146, 110, 0.34); stroke: #fb926e; stroke-width: 1; }
  .rc { fill: var(--text); font-size: 12px; font-weight: 700; text-anchor: middle; dominant-baseline: central; }
  .lbl { font-size: 9px; text-anchor: middle; }
  .lbl.a { fill: #5fd9f2; }
  .lbl.b { fill: #fb926e; }

  .metrics {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.3rem;
  }
  .metrics > div {
    display: flex;
    align-items: baseline;
    gap: 0.3rem;
    background: rgba(255, 255, 255, 0.03);
    border-radius: var(--r-xs);
    padding: 0.28rem 0.4rem;
  }
  .metrics b { font-size: 0.85rem; font-variant-numeric: tabular-nums; min-width: 2.6ch; }
  .metrics span { display: flex; flex-direction: column; font-size: 0.66rem; color: var(--muted); }
  .metrics i { font-style: normal; font-size: 0.58rem; color: var(--dim); }

  .buckets { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .bk {
    font-size: 0.64rem;
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    padding: 0.22rem 0.4rem;
    background: none;
    color: var(--muted);
    cursor: pointer;
    white-space: nowrap;
  }
  .bk:disabled { opacity: 0.4; cursor: default; }
  .bk.both:not(:disabled) { border-color: rgba(134, 239, 172, 0.5); color: #86efac; }
  .bk.qc:not(:disabled) { border-color: rgba(95, 217, 242, 0.5); color: #5fd9f2; }
  .bk.man:not(:disabled) { border-color: rgba(251, 146, 110, 0.5); color: #fb926e; }
  .cover { font-size: 0.62rem; color: var(--dim); margin: 0; }
</style>
