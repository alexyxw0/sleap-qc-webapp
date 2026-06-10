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

  let mode = null; // 'node' (drag a point) | 'select' (just selected, no move) | 'pan'
  let dragging = null;
  let panStart = null;
  let moved = false;

  const DRAG_THRESH = 3; // px the pointer must move before a node actually moves

  // Maps image coords -> canvas device px: deviceX = imageX * s + offX. Stored each draw
  // so pointer handlers can invert it.
  let xform = { s: 1, offX: 0, offY: 0 };

  const HIT_PX = 12; // hit radius in screen pixels
  const dpr = Math.min((typeof window !== "undefined" && window.devicePixelRatio) || 1, 2);

  $effect(() => {
    if (!canvas) return;
    ctx = canvas.getContext("2d");
    // Zoom/pan is rendered inside the canvas now (not via CSS). Clear any inline
    // transform a previous build may have left on the element (e.g. via hot-reload),
    // which would otherwise CSS-scale the whole bitmap and blur the overlay.
    canvas.style.transform = "none";
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
      // A node is only draggable if it was already the selected node *before* this
      // press. A first click just selects it, so a stray click can't nudge a point.
      const alreadySelected = edit.selInstance === hit.instIdx && edit.selNode === hit.nodeIdx;
      edit.select(hit.instIdx, hit.nodeIdx);
      if (alreadySelected) {
        const p = lf.instances[hit.instIdx].points[hit.nodeIdx];
        dragging = {
          instIdx: hit.instIdx,
          nodeIdx: hit.nodeIdx,
          from: { xy: [...p.xy], visible: p.visible },
          sx: e.clientX,
          sy: e.clientY,
          active: false, // becomes true only after the pointer moves past DRAG_THRESH
        };
        mode = "node";
      } else {
        mode = "select"; // selected only; no movement this interaction
      }
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
      if (!dragging.active) {
        if (Math.hypot(e.clientX - dragging.sx, e.clientY - dragging.sy) <= DRAG_THRESH) return;
        dragging.active = true; // crossed the threshold -> this is a real drag
      }
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
      // Only record a move if the pointer actually dragged; a plain click is a no-op.
      if (dragging.active) edit.commitMove(dragging.instIdx, dragging.nodeIdx, dragging.from);
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
      style:--fill="{store.frameCount > 1 ? (store.index / (store.frameCount - 1)) * 100 : 0}%"
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
      repeating-conic-gradient(#0b0e14 0% 25%, #090c11 0% 50%) 50% / 22px 22px;
    border: 1px solid var(--border);
    border-radius: var(--r);
    overflow: hidden;
    box-shadow: var(--shadow), inset 0 0 0 1px rgba(255, 255, 255, 0.02);
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none; /* pointer events drive editing/pan, not scroll/zoom */
  }
  .zoomctl {
    position: absolute;
    right: 0.7rem;
    bottom: 0.7rem;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    background: rgba(11, 15, 22, 0.72);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.25rem 0.35rem;
    backdrop-filter: blur(10px);
    box-shadow: var(--shadow-sm);
  }
  .zoomctl button {
    background: var(--surface-2);
    color: #d7dee8;
    border: 1px solid var(--border);
    border-radius: 50%;
    width: 1.7rem;
    height: 1.7rem;
    font-size: 0.9rem;
    cursor: pointer;
    line-height: 1;
    transition: background 0.12s, transform 0.12s;
  }
  .zoomctl button:hover:not(:disabled) {
    background: var(--surface-3);
    transform: translateY(-1px);
  }
  .zoomctl button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .zoomctl .pct {
    font-size: 0.72rem;
    color: var(--muted);
    min-width: 2.7rem;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin-top: 0.7rem;
    padding: 0.45rem 0.6rem;
    background: linear-gradient(180deg, rgba(20, 26, 37, 0.7), rgba(13, 18, 27, 0.7));
    border: 1px solid var(--border);
    border-radius: var(--r);
    box-shadow: var(--shadow-sm);
  }
  .controls button {
    background: linear-gradient(180deg, var(--surface-3), var(--surface-2));
    color: #d7dee8;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 0.4rem 0.6rem;
    font-size: 0.9rem;
    cursor: pointer;
    line-height: 1;
    transition: background 0.12s, transform 0.12s, border-color 0.12s;
  }
  .controls button:hover {
    background: linear-gradient(180deg, #1d2735, var(--surface-3));
    transform: translateY(-1px);
  }
  .controls button.play {
    background: var(--accent-grad);
    color: #06121f;
    border-color: transparent;
    font-weight: 700;
    min-width: 2.6rem;
    box-shadow: var(--glow);
  }
  .controls button.play:hover {
    filter: brightness(1.06);
    transform: none;
  }
  .slider {
    flex: 1;
    appearance: none;
    -webkit-appearance: none;
    height: 6px;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--accent), var(--accent-2)) no-repeat,
      var(--surface);
    background-size: var(--fill, 0%) 100%, 100% 100%;
    cursor: pointer;
  }
  .slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 15px;
    height: 15px;
    border-radius: 50%;
    background: #fff;
    border: none;
    box-shadow: 0 2px 8px -2px rgba(125, 211, 252, 0.9), 0 0 0 4px rgba(125, 211, 252, 0.18);
  }
  .slider::-moz-range-thumb {
    width: 15px;
    height: 15px;
    border: none;
    border-radius: 50%;
    background: #fff;
  }
  .counter {
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .counter strong {
    color: var(--text);
    font-size: 0.95rem;
  }
  .fidx {
    margin-left: 0.5rem;
    color: var(--dim);
  }
</style>
