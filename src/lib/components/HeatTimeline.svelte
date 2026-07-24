<script>
  import { store } from "../labelsStore.svelte.js";
  import { qc, heatColor, hasFrameIssue } from "../qcStore.svelte.js";
  import { edit } from "../editStore.svelte.js";

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

  // The heat STRIP is O(allFrames) to build, so it must NOT rebuild on a node-drag (store.rev) or on
  // frame navigation (store.index) — only when the data/scores/thresholds (qc.rev) or the size change.
  // The current-frame playhead is a separate, cheap DOM overlay (see the markup) that moves on its own.
  $effect(() => {
    void qc.rev;
    void edit.structRev; // labeled-lane tracks add/remove instance (rare) — NOT node-drags
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
      let flagged = false;
      const has = qc.hasResults; // hoist: this getter allocates (Object.keys) — don't re-call it per frame
      for (let i = lo; i <= hi; i++) {
        const f = frames[i];
        if ((f?.lf?.instances?.length ?? 0) > 0) labeled = true;
        if (has) {
          const s = qc.frameScore(f);
          if (s != null && (score == null || s > score)) score = s;
          if (qc.frameFlagged(f)) flagged = true; // reads the thresholds -> redraws on slider drag
        }
      }

      // base lane (uniform height — no waveform)
      ctx.fillStyle = labeled ? "rgba(95, 217, 242, 0.12)" : "rgba(255, 255, 255, 0.04)";
      ctx.fillRect(x, 0, 1, ch);

      // Flagged columns glow at full strength; unflagged-but-scored columns keep only a faint
      // context tint. The flag is the union of the enabled checks at the current thresholds, so
      // the strip stays in lockstep with the sliders — frames slide in/out of the glow live.
      if (flagged) {
        ctx.fillStyle = heatColor(score ?? 1);
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x, 0, 1, ch);
        ctx.globalAlpha = 1;
      } else if (score != null) {
        const k = Math.max(0, (Math.min(1, score) - 0.3) / 0.7);
        if (k > 0) {
          ctx.fillStyle = heatColor(score);
          ctx.globalAlpha = 0.2 * Math.pow(k, 1.5);
          ctx.fillRect(x, 0, 1, ch);
          ctx.globalAlpha = 1;
        }
      }
    }

    // graticule: engraved frame ticks at a "nice" step (≈10 majors across the strip)
    if (count > 1) {
      const raw = count / 10;
      const pow = Math.pow(10, Math.floor(Math.log10(raw)));
      let step = 10 * pow;
      for (const m of [1, 2, 5, 10]) {
        if (raw <= m * pow) {
          step = m * pow;
          break;
        }
      }
      ctx.fillStyle = "rgba(232, 236, 239, 0.22)";
      for (let f = 0; f < count; f += step) {
        const x = Math.round(((f + 0.5) / count) * cw);
        ctx.fillRect(x, ch * 0.55, dpr, ch * 0.45);
      }
      const minor = step / 5;
      if (minor >= 1 && cw / (count / minor) > 4 * dpr) {
        ctx.fillStyle = "rgba(232, 236, 239, 0.1)";
        for (let f = 0; f < count; f += minor) {
          const x = Math.round(((f + 0.5) / count) * cw);
          ctx.fillRect(x, ch * 0.78, dpr, ch * 0.22);
        }
      }
    }

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
    const has = qc.hasResults;
    const s = has ? qc.frameScore(f) : null;
    const flagged = has && qc.frameFlagged(f); // reads thresholds -> tooltip tracks the sliders
    const issue = has && hasFrameIssue(qc.frameQC(f));
    let sub;
    if (s != null) sub = `score ${s.toFixed(2)}${flagged ? " · flagged" : ""}`;
    else if (flagged || issue) sub = "flagged";
    else sub = `${f?.lf?.instances?.length ?? 0} inst`;
    return {
      x: hover.x,
      label: `frame ${hover.i + 1}`,
      sub,
      heat: flagged ? heatColor(s ?? 1) : s != null ? heatColor(s) : null,
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

  <!-- Playhead as a cheap CSS-positioned overlay: moves on frame change without redrawing the
       O(allFrames) strip. translateZ(0) keeps it on its own compositor layer (smooth scrubbing). -->
  {#if store.frameCount > 0}
    <div class="playhead" style:left="{((store.index + 0.5) / store.frameCount) * 100}%"></div>
  {/if}

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
    height: 24px;
    align-self: center;
    min-width: 0;
    margin: 0 0.45rem;
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    background: rgba(8, 10, 12, 0.85);
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    cursor: ew-resize;
    touch-action: none;
    border-radius: 1px; /* the tooltip sits above the bar, so clip the canvas, not the wrap */
  }
  .playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    margin-left: -0.5px;
    background: rgba(255, 255, 255, 0.92);
    pointer-events: none;
    transform: translateZ(0); /* own compositor layer → smooth scrubbing, no strip repaint */
  }
  .playhead::before {
    content: "";
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    border-left: 4px solid transparent;
    border-right: 4px solid transparent;
    border-top: 4px solid rgba(255, 255, 255, 0.92);
  }
  .tip {
    position: absolute;
    bottom: calc(100% + 7px);
    transform: translateX(-50%);
    background: rgba(11, 13, 15, 0.96);
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    padding: 0.28rem 0.55rem;
    font-size: 0.68rem;
    line-height: 1.4;
    white-space: nowrap;
    pointer-events: none;
    z-index: 5;
    display: flex;
    flex-direction: column;
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
    display: inline-block;
  }
</style>
