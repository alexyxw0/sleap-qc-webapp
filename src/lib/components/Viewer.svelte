<script>
  import { store } from "../labelsStore.svelte.js";
  import { edit } from "../editStore.svelte.js";
  import { drawScene, frameDims, hitTestNode } from "../draw.js";

  let canvas = $state();
  let ctx = $state();
  let playing = $state(false);
  let timer = null;
  let frameImage = $state.raw(null); // cached decoded frame, so edits don't re-fetch it
  let dragging = null; // { instIdx, nodeIdx, from }

  const HIT_PX = 12; // hit radius in screen pixels

  $effect(() => {
    if (canvas) ctx = canvas.getContext("2d");
  });

  // (A) Fetch the frame image — only when the frame or the attached video changes.
  // Guarded against out-of-order async so fast scrubbing never shows a stale frame.
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
      const { w, h } = frameDims(item, image);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      frameImage = image ?? null;
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  });

  // (B) Draw image + pose overlay. Re-runs on edits (store.rev) and selection changes
  // using the cached image — no re-fetch, so dragging stays smooth.
  $effect(() => {
    void store.rev;
    const selI = edit.selInstance;
    const selN = edit.selNode;
    const item = store.current;
    const sk = store.skeleton;
    if (!ctx) return;
    // image px per on-screen px, so node markers + labels stay a constant screen size
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width ? canvas.width / rect.width : 1;
    drawScene(ctx, frameImage, item, sk, { editing: true, selInstance: selI, selNode: selN, scale });
  });

  // Clear selection when navigating to another frame (indices won't match).
  $effect(() => {
    void store.index;
    edit.clearSelection();
  });

  // --- coordinate mapping (screen -> image space) ---
  function toImage(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy, scale: sx };
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
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    // No node hit. If the selected node is unplaced/hidden, place it here.
    const inst = edit.selectedInstance;
    const p = inst?.points?.[edit.selNode];
    if (p && (!p.visible || Number.isNaN(p.xy?.[0]))) {
      const from = { xy: [...p.xy], visible: p.visible };
      edit.setPoint(edit.selInstance, edit.selNode, x, y, true);
      edit.commitMove(edit.selInstance, edit.selNode, from);
      return;
    }
    edit.clearSelection();
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const { x, y } = toImage(e);
    edit.setPoint(dragging.instIdx, dragging.nodeIdx, x, y, true);
  }

  function onPointerUp(e) {
    if (!dragging) return;
    edit.commitMove(dragging.instIdx, dragging.nodeIdx, dragging.from);
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
    dragging = null;
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
    if (e.key === "ArrowRight" || e.key === "d") {
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
  <div class="canvas-wrap">
    <canvas
      bind:this={canvas}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
    ></canvas>
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
    flex: 1;
    min-height: 0;
    display: grid;
    place-items: center;
    background:
      repeating-conic-gradient(#0c0f14 0% 25%, #0a0d12 0% 50%) 50% / 24px 24px;
    border-radius: 10px;
    overflow: hidden;
  }
  canvas {
    max-width: 100%;
    max-height: 100%;
    touch-action: none; /* let pointer events drive editing, not scroll/zoom */
    cursor: crosshair;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.7rem 0.2rem 0;
  }
  button {
    background: #1a212c;
    color: #d7dee8;
    border: 1px solid #2a3442;
    border-radius: 7px;
    padding: 0.4rem 0.6rem;
    font-size: 0.9rem;
    cursor: pointer;
    line-height: 1;
  }
  button:hover {
    background: #222b38;
  }
  button.play {
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
