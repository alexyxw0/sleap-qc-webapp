<script>
  import { store } from "../labelsStore.svelte.js";
  import { edit } from "../editStore.svelte.js";
  import { view } from "../viewStore.svelte.js";
  import { drawScene, frameDims, hitTestNode } from "../draw.js";

  let wrap = $state();
  let canvas = $state();
  let ctx = $state();
  let vpW = $state(0); // wrap size in CSS px
  let vpH = $state(0);
  let playing = $state(false);
  let timer = null;
  let frameImage = $state.raw(null); // cached decoded frame, so edits don't re-fetch it

  let mode = null; // 'node' (drag a point) | 'pan'
  let dragging = null;
  let panStart = null;
  let moved = false;

  // Maps image coords -> canvas device px: deviceX = imageX * s + offX. Stored each draw
  // so pointer handlers can invert it.
  let xform = { s: 1, offX: 0, offY: 0 };

  const HIT_PX = 12; // hit radius in screen pixels
  const dpr = Math.min((typeof window !== "undefined" && window.devicePixelRatio) || 1, 2);

  $effect(() => {
    if (canvas) ctx = canvas.getContext("2d");
  });

  // Track the wrap's CSS size so the canvas bitmap can match it (× dpr).
  $effect(() => {
    if (!wrap) return;
    const measure = () => {
      vpW = wrap.clientWidth;
      vpH = wrap.clientHeight;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  });

  // (A) Fetch the frame image — only when the frame or attached video changes.
  $effect(() => {
    const item = store.current;
    void store.index;
    void store.videoModel;
    if (!ctx) return;
    let cancelled = false;
    const ac = new AbortController();
    (async () => {
      const image = await store.getFrameImage(item, ac.signal);
      if (cancelled) return;
      frameImage = image ?? null;
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  });

  // (B) Draw image + overlay. The zoom/pan transform is applied *inside* the canvas
  // (not via CSS), so node markers and labels re-rasterize crisply at any zoom. Redraw
  // is one drawImage + a few shapes — cheap enough to run on every zoom/pan/edit frame.
  $effect(() => {
    void store.rev;
    const selI = edit.selInstance;
    const selN = edit.selNode;
    const z = view.zoom;
    const px = view.panX;
    const py = view.panY;
    const W = vpW;
    const H = vpH;
    const item = store.current;
    const sk = store.skeleton;
    if (!ctx || !W || !H) return;

    const cw = Math.round(W * dpr);
    const ch = Math.round(H * dpr);
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;

    const dims = frameDims(item, frameImage);
    const fitCss = Math.min(W / dims.w, H / dims.h); // CSS px per image px to fit
    const s = fitCss * z * dpr; // device px per image px
    const offX = (cw - dims.w * s) / 2 + px * dpr;
    const offY = (ch - dims.h * s) / 2 + py * dpr;
    xform = { s, offX, offY };

    const scale = 1 / (fitCss * z); // image px per CSS px — keeps overlay a constant screen size
    drawScene(ctx, frameImage, item, sk, {
      transform: { s, offX, offY },
      dims,
      scale,
      editing: true,
      selInstance: selI,
      selNode: selN,
    });
  });

  // Clear selection when navigating to another frame.
  $effect(() => {
    void store.index;
    edit.clearSelection();
  });

  // screen -> image coords (inverts the in-canvas transform)
  function toImage(e) {
    const rect = canvas.getBoundingClientRect();
    const devPerCss = rect.width ? canvas.width / rect.width : dpr;
    const devX = (e.clientX - rect.left) * devPerCss;
    const devY = (e.clientY - rect.top) * devPerCss;
    return {
      x: (devX - xform.offX) / xform.s,
      y: (devY - xform.offY) / xform.s,
      scale: devPerCss / xform.s, // image px per CSS px
    };
  }

  function onPointerDown(e) {
    const lf = store.current?.lf;
    if (!lf) return;
    const { x, y, scale } = toImage(e);
    const hit = hitTestNode(lf, HIT_PX * scale)(x, y);

    if (hit) {
      edit.select(hit.instIdx, hit.nodeIdx);
      const p = lf.instances[hit.instIdx].points[hit.nodeIdx];
      dragging = { instIdx: hit.instIdx, nodeIdx: hit.nodeIdx, from: { xy: [...p.xy], visible: p.visible } };
      mode = "node";
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    mode = "pan";
    moved = false;
    panStart = { cx: e.clientX, cy: e.clientY, panX: view.panX, panY: view.panY };
    canvas.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (mode === "node") {
      const { x, y } = toImage(e);
      // preserve visibility so a hidden node stays hidden while moved
      edit.setPoint(dragging.instIdx, dragging.nodeIdx, x, y, dragging.from.visible);
    } else if (mode === "pan") {
      const dx = e.clientX - panStart.cx;
      const dy = e.clientY - panStart.cy;
      if (!moved && Math.hypot(dx, dy) > 3) moved = true;
      if (moved && view.zoom > 1) {
        view.panX = panStart.panX + dx;
        view.panY = panStart.panY + dy;
      }
    }
  }

  function onPointerUp(e) {
    if (mode === "node") {
      edit.commitMove(dragging.instIdx, dragging.nodeIdx, dragging.from);
      dragging = null;
    } else if (mode === "pan" && !moved) {
      const p = edit.selectedInstance?.points?.[edit.selNode];
      if (p && Number.isNaN(p.xy?.[0])) {
        const { x, y } = toImage(e);
        const from = { xy: [...p.xy], visible: p.visible };
        edit.setPoint(edit.selInstance, edit.selNode, x, y, true);
        edit.commitMove(edit.selInstance, edit.selNode, from);
      } else {
        edit.clearSelection();
      }
    }
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
    mode = null;
    panStart = null;
    moved = false;
  }

  function onWheel(e) {
    e.preventDefault();
    e.deltaY < 0 ? view.zoomIn() : view.zoomOut();
  }

  function togglePlay() {
    playing = !playing;
    if (playing) {
      timer = setInterval(() => {
        if (store.index >= store.frameCount - 1) store.setIndex(0);
        else store.next();
      }, 1000 / 12);
    } else {
      clearInterval(timer);
      timer = null;
    }
  }
  $effect(() => () => clearInterval(timer));

  function onKey(e) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "z" || e.key === "Z")) {
      e.shiftKey ? edit.redo() : edit.undo();
      e.preventDefault();
      return;
    }
    if (mod && (e.key === "y" || e.key === "Y")) {
      edit.redo();
      e.preventDefault();
      return;
    }
    if (e.key === "=" || e.key === "+") {
      view.zoomIn();
      e.preventDefault();
    } else if (e.key === "-" || e.key === "_") {
      view.zoomOut();
      e.preventDefault();
    } else if (e.key === "0") {
      view.reset();
      e.preventDefault();
    } else if (e.key === "ArrowRight" || e.key === "d") {
      store.next();
      e.preventDefault();
    } else if (e.key === "ArrowLeft" || e.key === "a") {
      store.prev();
      e.preventDefault();
    } else if (e.key === " ") {
      togglePlay();
      e.preventDefault();
    } else if (e.key === "v" && edit.selInstance >= 0 && edit.selNode >= 0) {
      edit.toggleVisible(edit.selInstance, edit.selNode);
      e.preventDefault();
    } else if ((e.key === "Delete" || e.key === "Backspace") && edit.selInstance >= 0) {
      edit.deleteInstance();
      e.preventDefault();
    } else if (e.key === "Escape") {
      edit.clearSelection();
    }
  }

  const item = $derived(store.current);
</script>

<svelte:window onkeydown={onKey} />

<section class="viewer">
  <div class="canvas-wrap" bind:this={wrap} onwheel={onWheel}>
    <canvas
      bind:this={canvas}
      style:cursor={view.zoom > 1 ? "grab" : "crosshair"}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
    ></canvas>

    <div class="zoomctl">
      <button onclick={() => view.zoomOut()} disabled={view.zoom <= 1} title="Zoom out (−)">−</button>
      <span class="pct">{view.zoomPct}%</span>
      <button onclick={() => view.zoomIn()} title="Zoom in (+)">＋</button>
      <button onclick={() => view.reset()} disabled={view.zoom === 1 && view.panX === 0 && view.panY === 0} title="Reset view (0)">⤢</button>
    </div>
  </div>

  <div class="controls">
    <button onclick={() => store.setIndex(0)} title="First frame">⏮</button>
    <button onclick={() => store.prev()} title="Previous (←/A)">◀</button>
    <button class="play" onclick={togglePlay} title="Play/Pause (Space)">
      {playing ? "❚❚" : "▶"}
    </button>
    <button onclick={() => store.next()} title="Next (→/D)">▶</button>
    <button onclick={() => store.setIndex(store.frameCount - 1)} title="Last frame">⏭</button>

    <input
      class="slider"
      type="range"
      min="0"
      max={Math.max(0, store.frameCount - 1)}
      value={store.index}
      oninput={(e) => store.setIndex(+e.target.value)}
    />

    <div class="counter">
      <strong>{store.index + 1}</strong> / {store.frameCount}
      {#if item}<span class="fidx">frameIdx {item.frameIdx}</span>{/if}
    </div>
  </div>
</section>

<style>
  .viewer {
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
  }
  .canvas-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    background:
      repeating-conic-gradient(#0c0f14 0% 25%, #0a0d12 0% 50%) 50% / 24px 24px;
    border-radius: 10px;
    overflow: hidden;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none; /* pointer events drive editing/pan, not scroll/zoom */
  }
  .zoomctl {
    position: absolute;
    right: 0.6rem;
    bottom: 0.6rem;
    display: flex;
    align-items: center;
    gap: 0.2rem;
    background: rgba(13, 18, 26, 0.85);
    border: 1px solid #25303d;
    border-radius: 8px;
    padding: 0.2rem 0.3rem;
    backdrop-filter: blur(4px);
  }
  .zoomctl button {
    background: #1a212c;
    color: #d7dee8;
    border: 1px solid #2a3442;
    border-radius: 5px;
    width: 1.7rem;
    height: 1.5rem;
    font-size: 0.9rem;
    cursor: pointer;
    line-height: 1;
  }
  .zoomctl button:hover:not(:disabled) {
    background: #222b38;
  }
  .zoomctl button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .zoomctl .pct {
    font-size: 0.72rem;
    color: var(--muted);
    min-width: 2.6rem;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.7rem 0.2rem 0;
  }
  .controls button {
    background: #1a212c;
    color: #d7dee8;
    border: 1px solid #2a3442;
    border-radius: 7px;
    padding: 0.4rem 0.6rem;
    font-size: 0.9rem;
    cursor: pointer;
    line-height: 1;
  }
  .controls button:hover {
    background: #222b38;
  }
  .controls button.play {
    background: var(--accent);
    color: #06121f;
    border-color: transparent;
    font-weight: 700;
    min-width: 2.4rem;
  }
  .slider {
    flex: 1;
    accent-color: var(--accent);
  }
  .counter {
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .counter strong {
    color: #eaf0f7;
  }
  .fidx {
    margin-left: 0.5rem;
    opacity: 0.7;
  }
</style>
