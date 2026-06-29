<script>
  // Per-detector flag-% + overlaps, two ways. Data: qc.detectorSets() → { total, sets } over EVERY
  // enabled check (frame-based). Chord = proportional arcs + overlap ribbons; UpSet = bars + combos.
  import { qc } from "../qcStore.svelte.js";

  let mode = $state("chord"); // chord | upset

  const PALETTE = ["#5fd9f2", "#f3c56c", "#a7f3d0", "#fda4af", "#c4b5fd", "#86efac", "#fdba74", "#93c5fd", "#f9a8d4", "#fcd34d", "#67e8f9"];

  const data = $derived(qc.detectorSets());
  const dets = $derived.by(() =>
    data.sets.map((s, i) => ({
      id: s.id, label: s.label, set: s.set, count: s.set.size,
      pct: data.total ? s.set.size / data.total : 0, color: PALETTE[i % PALETTE.length],
    })),
  );
  const active = $derived(dets.filter((d) => d.count > 0));

  function overlap(a, b) {
    const [s, l] = a.set.size < b.set.size ? [a.set, b.set] : [b.set, a.set];
    let n = 0;
    for (const k of s) if (l.has(k)) n++;
    return n;
  }

  // ---- chord geometry ----
  const CX = 180, CY = 150, R_IN = 92, R_OUT = 110, R_LBL = 118;
  const polar = (r, a) => [CX + r * Math.cos(a), CY + r * Math.sin(a)];
  function arcBand(a0, a1, rIn, rOut) {
    const [x0o, y0o] = polar(rOut, a0), [x1o, y1o] = polar(rOut, a1);
    const [x1i, y1i] = polar(rIn, a1), [x0i, y0i] = polar(rIn, a0);
    const lg = a1 - a0 > Math.PI ? 1 : 0;
    return `M${x0o} ${y0o}A${rOut} ${rOut} 0 ${lg} 1 ${x1o} ${y1o}L${x1i} ${y1i}A${rIn} ${rIn} 0 ${lg} 0 ${x0i} ${y0i}Z`;
  }
  function ribbonPath(s1, s2, r) {
    const [ax, ay] = polar(r, s1.start), [bx, by] = polar(r, s1.end);
    const [cx, cy] = polar(r, s2.start), [dx, dy] = polar(r, s2.end);
    const l1 = s1.end - s1.start > Math.PI ? 1 : 0, l2 = s2.end - s2.start > Math.PI ? 1 : 0;
    return `M${ax} ${ay}A${r} ${r} 0 ${l1} 1 ${bx} ${by}Q${CX} ${CY} ${cx} ${cy}A${r} ${r} 0 ${l2} 1 ${dx} ${dy}Q${CX} ${CY} ${ax} ${ay}Z`;
  }

  // d3-style chord layout: arc length ∝ each detector's flagged count; M[i][j] = pairwise overlap,
  // M[i][i] = the "only this detector" remainder so arcs stay ≈ proportional to the flagged size.
  const chord = $derived.by(() => {
    const n = active.length;
    if (!n) return { arcs: [], ribbons: [] };
    const M = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const o = overlap(active[i], active[j]);
        M[i][j] = o;
        M[j][i] = o;
      }
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) if (j !== i) s += M[i][j];
      M[i][i] = Math.max(0, active[i].count - s);
    }
    const groupSum = M.map((row) => row.reduce((a, b) => a + b, 0));
    const total = groupSum.reduce((a, b) => a + b, 0) || 1;
    const pad = 0.06;
    const avail = 2 * Math.PI - n * pad;
    let ang = -Math.PI / 2;
    const arcs = [], subs = [];
    for (let i = 0; i < n; i++) {
      const a0 = ang;
      const arcAngle = (groupSum[i] / total) * avail;
      let sa = a0;
      subs[i] = [];
      for (let j = 0; j < n; j++) {
        const seg = (M[i][j] / total) * avail;
        subs[i][j] = { start: sa, end: sa + seg };
        sa += seg;
      }
      arcs.push({ a0, a1: a0 + arcAngle, mid: a0 + arcAngle / 2, det: active[i] });
      ang = a0 + arcAngle + pad;
    }
    const ribbons = [];
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        if (M[i][j] > 0) ribbons.push({ key: i + "-" + j, color: active[i].color, s1: subs[i][j], s2: subs[j][i] });
    return { arcs, ribbons };
  });

  // ---- upset: exact intersection combos ----
  const combos = $derived.by(() => {
    const union = new Set();
    for (const d of active) for (const k of d.set) union.add(k);
    const sig = new Map();
    for (const k of union) {
      const mask = active.map((d) => d.set.has(k));
      const key = mask.join(",");
      const e = sig.get(key) ?? { mask, count: 0 };
      e.count++;
      sig.set(key, e);
    }
    return [...sig.values()].sort((a, b) => b.count - a.count).slice(0, 12);
  });
  const maxCombo = $derived(Math.max(1, ...combos.map((c) => c.count)));
</script>

<div class="ov">
  <div class="ov-head">
    <span class="ov-title">Detector overlap<span class="ov-total"> · {data.total} frames</span></span>
    <div class="ov-modes">
      <button type="button" class:on={mode === "chord"} onclick={() => (mode = "chord")}>Chord</button>
      <button type="button" class:on={mode === "upset"} onclick={() => (mode = "upset")}>UpSet</button>
    </div>
  </div>

  {#if !active.length}
    <p class="ov-empty">No detectors are flagging anything — run QC and enable some checks.</p>
  {:else if mode === "chord"}
    <svg viewBox="0 0 360 300" class="ov-svg">
      {#each chord.ribbons as r (r.key)}
        <path d={ribbonPath(r.s1, r.s2, R_IN)} fill={r.color} fill-opacity="0.4" stroke={r.color} stroke-opacity="0.75" stroke-width="0.8" stroke-linejoin="round" />
      {/each}
      {#each chord.arcs as a (a.det.id)}
        <path d={arcBand(a.a0, a.a1, R_IN + 1, R_OUT)} fill={a.det.color} stroke="#0b0e13" stroke-width="0.6" />
      {/each}
      {#each chord.arcs as a (a.det.id)}
        {@const lp = polar(R_LBL, a.mid)}
        <text x={lp[0]} y={lp[1]} class="ov-lbl" dominant-baseline="middle"
          text-anchor={Math.cos(a.mid) > 0.15 ? "start" : Math.cos(a.mid) < -0.15 ? "end" : "middle"}>
          {a.det.label} · {(a.det.pct * 100).toFixed(1)}%
        </text>
      {/each}
    </svg>
    <p class="ov-note">Arc length = % of frames a detector flags · ribbon = frames two detectors share.</p>
  {:else}
    <div class="us">
      <div class="us-dets">
        {#each active as d (d.id)}
          <div class="us-det">
            <span class="us-dot" style:background={d.color}></span>
            <span class="us-name" title={d.label}>{d.label}</span>
            <span class="us-bar"><span style:width="{d.pct * 100}%" style:background={d.color}></span></span>
            <span class="us-pct">{(d.pct * 100).toFixed(1)}%</span>
          </div>
        {/each}
      </div>
      <div class="us-combos">
        <div class="us-cap">exact intersections (frames)</div>
        {#each combos as c (c.mask.join())}
          <div class="us-combo">
            <span class="us-mask">
              {#each c.mask as on, i (i)}<span class="us-cell" class:on style:--c={active[i].color}></span>{/each}
            </span>
            <span class="us-cbar"><span style:width="{(c.count / maxCombo) * 100}%"></span></span>
            <span class="us-ccount">{c.count}</span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .ov {
    width: 100%;
    color: var(--text);
  }
  .ov-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.6rem;
  }
  .ov-title {
    font-size: 0.82rem;
    font-weight: 600;
  }
  .ov-total {
    color: var(--dim);
    font-weight: 400;
  }
  .ov-modes {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    overflow: hidden;
  }
  .ov-modes button {
    background: none;
    border: none;
    color: var(--muted);
    font-size: 0.7rem;
    padding: 0.22rem 0.5rem;
    cursor: pointer;
  }
  .ov-modes button.on {
    background: rgba(95, 217, 242, 0.14);
    color: var(--text);
  }
  .ov-svg {
    width: 100%;
    height: auto;
    display: block;
  }
  .ov-lbl {
    fill: var(--text);
    font-size: 8.5px;
    font-weight: 600;
  }
  .ov-note {
    margin: 0.3rem 0 0;
    font-size: 0.66rem;
    color: var(--dim);
    text-align: center;
  }
  .ov-empty {
    font-size: 0.78rem;
    color: var(--muted);
    padding: 1.5rem 0.5rem;
    text-align: center;
  }
  .us-dets {
    display: grid;
    gap: 0.2rem;
    margin-bottom: 0.7rem;
  }
  .us-det {
    display: grid;
    grid-template-columns: auto 1fr 5rem 2.6rem;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.72rem;
  }
  .us-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
  }
  .us-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .us-bar, .us-cbar {
    height: 6px;
    background: var(--border);
    border-radius: 3px;
    overflow: hidden;
  }
  .us-bar span, .us-cbar span {
    display: block;
    height: 100%;
    border-radius: 3px;
  }
  .us-cbar span {
    background: color-mix(in srgb, var(--accent) 55%, transparent);
  }
  .us-pct {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
  }
  .us-cap {
    font-size: 0.64rem;
    color: var(--dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 0.3rem;
  }
  .us-combo {
    display: grid;
    grid-template-columns: auto 1fr 2.4rem;
    align-items: center;
    gap: 0.4rem;
    padding: 0.06rem 0;
  }
  .us-mask {
    display: inline-flex;
    gap: 3px;
  }
  .us-cell {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    border: 1px solid var(--border);
    background: transparent;
  }
  .us-cell.on {
    background: var(--c);
    border-color: var(--c);
  }
  .us-ccount {
    text-align: right;
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
  }
</style>
