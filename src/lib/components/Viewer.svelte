<script>
  import { store } from "../labelsStore.svelte.js";
  import { drawScene, frameDims } from "../draw.js";

  let canvas = $state();
  let ctx = $state();
  let playing = $state(false);
  let timer = null;

  // Grab the 2D context once the canvas element binds.
  $effect(() => {
    if (canvas) ctx = canvas.getContext("2d");
  });

  // Redraw whenever the frame index or the model revision changes. The async image
  // fetch is guarded by a `cancelled` flag so fast scrubbing never paints a stale
  // frame (the out-of-order-resolution guard from the investigation).
  $effect(() => {
    // declare reactive deps explicitly:
    store.index;
    store.rev;
    const item = store.current;
    const skeleton = store.skeleton;
    if (!ctx) return;

    let cancelled = false;
    const ac = new AbortController();
    (async () => {
      const image = await store.getFrameImage(item, ac.signal);
      if (cancelled) return;
      const { w, h } = frameDims(item, image);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      drawScene(ctx, image, item, skeleton);
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  });

  function togglePlay() {
    playing = !playing;
    if (playing) {
      timer = setInterval(() => {
        if (store.index >= store.frameCount - 1) {
          store.setIndex(0);
        } else {
          store.next();
        }
      }, 1000 / 12);
    } else {
      clearInterval(timer);
      timer = null;
    }
  }

  // stop playback teardown
  $effect(() => () => clearInterval(timer));

  function onKey(e) {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowRight" || e.key === "d") {
      store.next();
      e.preventDefault();
    } else if (e.key === "ArrowLeft" || e.key === "a") {
      store.prev();
      e.preventDefault();
    } else if (e.key === " ") {
      togglePlay();
      e.preventDefault();
    }
  }

  const item = $derived(store.current);
</script>

<svelte:window onkeydown={onKey} />

<section class="viewer">
  <div class="canvas-wrap">
    <canvas bind:this={canvas}></canvas>
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
    object-fit: contain;
    image-rendering: auto;
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
