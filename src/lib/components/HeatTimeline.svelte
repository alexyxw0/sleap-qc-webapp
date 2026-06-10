<script>
  import { store } from "../labelsStore.svelte.js";
  import { qc, heatColor, hasFrameIssue } from "../qcStore.svelte.js";

  // A scrubbable timeline that doubles as a QC heatmap. Every navigable frame maps to
  // a horizontal bucket; after a QC run each bucket is tinted by its worst anomaly
  // score — opacity rises steeply with the score, so the strip stays calm and only
  // genuine hotspots glow. Buckets are per-device-pixel, so 180k frames stay O(width).

  let wrap = $state();
  let canvas = $state();
  let w = $state(0);
  let h = $state(0);
  let hover = $state(null); // { i, x } — frame index + CSS x of the pointer
  let scrubbing = false;

  const dpr = Math.min((typeof window !== "undefined" && window.devicePixelRatio) || 1, 2);

  $effect(() => {
    if (!wrap) return;
    const measure = () => {
      w = wrap.clientWidth;
      h = wrap.clientHeight;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  });

  $effect(() => {
    void store.rev;
    void qc.rev;
    const index = store.index;
    const count = store.frameCount;
    const W = w;
    const H = h;
    if (!canvas || !W || !H) return;

    const cw = Math.round(W * dpr);
    const ch = Math.round(H * dpr);
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, cw, ch);
    if (count === 0) return;

    const frames = store.frames;
    const px = count / cw; // frames per device pixel column

    // One pass per device-pixel column; each column shows the worst frame in its bucket.
    for (let x = 0; x < cw; x++) {
      const lo = Math.floor(x * px);
      const hi = Math.min(count - 1, Math.floor((x + 1) * px));
      let labeled = false;
      let score = null;
      for (let i = lo; i <= hi; i++) {
        const f = frames[i];
        if ((f?.lf?.instances?.length ?? 0) > 0) labeled = true;
        if (qc.hasResults) {
          const s = qc.frameScore(f);
          if (s != null && (score == null || s > score)) score = s;
        }
      }

      // base lane (uniform height — no waveform)
      ctx.fillStyle = labeled ? "rgba(125, 211, 252, 0.13)" : "rgba(255, 255, 255, 0.04)";
      ctx.fillRect(x, 0, 1, ch);

      // anomaly tint with a knee: scores below ~0.35 render nothing (every labeled
      // frame has *some* score — painting them all reads as mush), then opacity ramps
      // so only genuine hotspots glow. Full per-frame detail stays in the tooltip.
      if (score != null) {
        const t = Math.max(0, Math.min(1, score));
        const k = Math.max(0, (t - 0.35) / 0.65);
        if (k > 0) {
          ctx.fillStyle = heatColor(score);
          ctx.globalAlpha = 0.8 * Math.pow(k, 1.5);
          ctx.fillRect(x, 0, 1, ch);
          ctx.globalAlpha = 1;
        }
      }
    }

    // playhead — a thin line, no glow band
    const playX = Math.round(((index + 0.5) / count) * cw);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fillRect(playX - dpr, 0, 2 * dpr, ch);
  });

  function frameAt(e) {
    const rect = canvas.getBoundingClientRect();
    const t = (e.clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(store.frameCount - 1, Math.floor(t * store.frameCount)));
  }

  function onPointerDown(e) {
    scrubbing = true;
    canvas.setPointerCapture(e.pointerId);
    store.setIndex(frameAt(e));
  }
  function onPointerMove(e) {
    const rect = canvas.getBoundingClientRect();
    hover = { i: frameAt(e), x: e.clientX - rect.left };
    if (scrubbing) store.setIndex(hover.i);
  }
  function onPointerUp(e) {
    scrubbing = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }

  const hoverInfo = $derived.by(() => {
    if (hover == null) return null;
    const f = store.frames[hover.i];
    const s = qc.hasResults ? qc.frameScore(f) : null;
    const issue = qc.hasResults && hasFrameIssue(qc.frameQC(f));
    return {
      x: hover.x,
      label: `frame ${hover.i + 1}`,
      sub:
        s != null
          ? `anomaly ${s.toFixed(2)}${issue ? " · issue" : ""}`
          : issue
            ? "frame issue"
            : `${f?.lf?.instances?.length ?? 0} inst`,
      heat: s != null ? heatColor(s) : null,
    };
  });
</script>

<div class="timeline" bind:this={wrap} role="slider" aria-label="Frame timeline" aria-valuenow={store.index + 1} aria-valuemin="1" aria-valuemax={store.frameCount} tabindex="-1">
  <canvas
    bind:this={canvas}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointerleave={() => (hover = null)}
  ></canvas>

  {#if hoverInfo}
    <div class="tip" style:left="{hoverInfo.x}px">
      <span class="f">{hoverInfo.label}</span>
      <span class="s">
        {#if hoverInfo.heat}<i style:background={hoverInfo.heat}></i>{/if}
        {hoverInfo.sub}
      </span>
    </div>
  {/if}
</div>

<style>
  .timeline {
    position: relative;
    flex: 1;
    height: 22px;
    align-self: center;
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: rgba(7, 10, 16, 0.8);
    box-shadow: inset 0 2px 8px -3px rgba(0, 0, 0, 0.7);
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    cursor: ew-resize;
    touch-action: none;
    border-radius: 7px; /* the tooltip sits above the bar, so clip the canvas, not the wrap */
  }
  .tip {
    position: absolute;
    bottom: calc(100% + 7px);
    transform: translateX(-50%);
    background: rgba(10, 14, 21, 0.95);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.28rem 0.55rem;
    font-size: 0.7rem;
    line-height: 1.35;
    white-space: nowrap;
    pointer-events: none;
    z-index: 5;
    box-shadow: var(--shadow-sm);
    display: flex;
    flex-direction: column;
    backdrop-filter: blur(8px);
  }
  .tip .f {
    font-weight: 700;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .tip .s {
    color: var(--muted);
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .tip i {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: inline-block;
  }
</style>
