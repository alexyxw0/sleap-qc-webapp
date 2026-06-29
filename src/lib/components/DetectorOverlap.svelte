<script>
  // Rough, side-by-side prototypes of three ways to show per-detector flag-% + overlaps.
  // Data: qc.detectorSets() → { total, sets:[{id,label,set:Set<key>}] } over instance-level checks.
  import { qc } from "../qcStore.svelte.js";

  let mode = $state("chord"); // chord (front-runner) | upset | euler

  const PALETTE = ["#5fd9f2", "#f3c56c", "#a7f3d0", "#fda4af", "#c4b5fd", "#86efac", "#fdba74", "#93c5fd"];

  const data = $derived(qc.detectorSets());
  const dets = $derived.by(() =>
    data.sets.map((s, i) => ({
      id: s.id, label: s.label, set: s.set, count: s.set.size,
      pct: data.total ? s.set.size / data.total : 0, color: PALETTE[i % PALETTE.length],
    })),
  );
  const active = $derived(dets.filter((d) => d.count > 0)); // non-empty sets, for chord/euler

  function overlap(a, b) {
    const [s, l] = a.set.size < b.set.size ? [a.set, b.set] : [b.set, a.set];
    let n = 0;
    for (const k of s) if (l.has(k)) n++;
    return n;
  }

  // ---- chord: pairwise overlap ribbons ----
  const edges = $derived.by(() => {
    const e = [];
    for (let i = 0; i < active.length; i++)
      for (let j = i + 1; j < active.length; j++) {
        const o = overlap(active[i], active[j]);
        if (o > 0) e.push({ i, j, o });
      }
    return e;
  });
  const maxEdge = $derived(Math.max(1, ...edges.map((e) => e.o)));
  function pt(i, n, r) {
    const a = (i / n) * 2 * Math.PI - Math.PI / 2;
    return { x: 150 + r * Math.cos(a), y: 150 + r * Math.sin(a), a };
  }

  // ---- upset: exact intersection combos (rows, sorted by size) ----
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

  // ---- euler: APPROXIMATE top-3 proportional circles ----
  const euler = $derived.by(() => {
    const top = [...active].sort((a, b) => b.count - a.count).slice(0, 3);
    if (!top.length) return [];
    const maxC = Math.max(...top.map((d) => d.count));
    const R = top.map((d) => 24 + 58 * Math.sqrt(d.count / maxC));
    const dist = (i, j) => {
      const f = overlap(top[i], top[j]) / Math.max(1, Math.min(top[i].count, top[j].count));
      return Math.max(6, (R[i] + R[j]) * (1 - 0.85 * f)); // full overlap → near-concentric
    };
    const pos = [{ x: 0, y: 0 }];
    if (top[1]) pos.push({ x: dist(0, 1), y: 0 });
    if (top[2]) {
      const d01 = pos[1].x, d02 = dist(0, 2), d12 = dist(1, 2);
      const x = d01 ? (d01 * d01 + d02 * d02 - d12 * d12) / (2 * d01) : 0;
      const y2 = d02 * d02 - x * x;
      pos.push({ x, y: y2 > 0 ? Math.sqrt(y2) : 0 });
    }
    const xs = pos.flatMap((p, k) => [p.x - R[k], p.x + R[k]]);
    const ys = pos.flatMap((p, k) => [p.y - R[k], p.y + R[k]]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    return top.map((d, k) => ({ d, r: R[k], x: 150 + pos[k].x - cx, y: 150 + pos[k].y - cy }));
  });
</script>

<div class="ov">
  <div class="ov-head">
    <span class="ov-title">Detector overlap<span class="ov-total"> · {data.total} frames</span></span>
    <div class="ov-modes">
      <button type="button" class:on={mode === "chord"} onclick={() => (mode = "chord")}>Chord</button>
      <button type="button" class:on={mode === "upset"} onclick={() => (mode = "upset")}>UpSet</button>
      <button type="button" class:on={mode === "euler"} onclick={() => (mode = "euler")}>Euler</button>
    </div>
  </div>

  {#if !active.length}
    <p class="ov-empty">No detectors are flagging anything — run QC and enable some checks.</p>
  {:else if mode === "chord"}
    <svg viewBox="0 0 300 300" class="ov-svg">
      {#each edges as e (e.i + "-" + e.j)}
        {@const p = pt(e.i, active.length, 108)}
        {@const q = pt(e.j, active.length, 108)}
        <path d="M{p.x} {p.y} Q150 150 {q.x} {q.y}" fill="none" stroke={active[e.i].color}
          stroke-width={1.2 + 9 * (e.o / maxEdge)} stroke-linecap="round" opacity="0.42" />
      {/each}
      {#each active as d, i (d.id)}
        {@const p = pt(i, active.length, 108)}
        <circle cx={p.x} cy={p.y} r={4.5 + 8 * Math.sqrt(d.pct)} fill={d.color} />
        <text x={150 + 126 * Math.cos(p.a)} y={150 + 126 * Math.sin(p.a)} class="ov-lbl"
          text-anchor={Math.cos(p.a) > 0.15 ? "start" : Math.cos(p.a) < -0.15 ? "end" : "middle"}>
          {d.label} · {(d.pct * 100).toFixed(1)}%
        </text>
      {/each}
    </svg>
    <p class="ov-note">Ribbon thickness = # frames both detectors flag (pairwise).</p>
  {:else if mode === "euler"}
    <svg viewBox="0 0 300 300" class="ov-svg">
      {#each euler as c (c.d.id)}
        <circle cx={c.x} cy={c.y} r={c.r} fill={c.d.color} fill-opacity="0.3" stroke={c.d.color} stroke-width="1.3" />
      {/each}
      {#each euler as c (c.d.id)}
        <text x={c.x} y={c.y - 2} text-anchor="middle" class="ov-lbl">{c.d.label}</text>
        <text x={c.x} y={c.y + 11} text-anchor="middle" class="ov-sub">{(c.d.pct * 100).toFixed(1)}%</text>
      {/each}
    </svg>
    <p class="ov-note">Approximate · top 3 detectors only (Euler can't cleanly show 4+ sets).</p>
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
    width: 360px;
    max-width: 90vw;
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
  .ov-sub {
    fill: var(--dim);
    font-size: 7.5px;
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
  /* upset */
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
