<script>
  import { store } from "../labelsStore.svelte.js";

  let dragging = $state(false);
  let bg = $state(); // constellation canvas

  // Ambient backdrop: a handful of pose-skeleton "constellations" drifting slowly,
  // nodes wobbling around their cluster like tracked keypoints. Pure decoration —
  // static single frame under prefers-reduced-motion.
  $effect(() => {
    if (!bg) return;
    const ctx = bg.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;

    const COLORS = ["#7dd3fc", "#a78bfa", "#86efac", "#fda4af", "#f3c56c"];
    const rand = (a, b) => a + Math.random() * (b - a);

    // Each creature: a hub node with limbs radiating off it (star-ish skeleton).
    const creatures = Array.from({ length: 7 }, (_, k) => {
      const limbs = Math.round(rand(4, 7));
      return {
        x: Math.random(),
        y: Math.random(),
        vx: rand(-0.012, 0.012),
        vy: rand(-0.009, 0.009),
        rot: rand(0, Math.PI * 2),
        vrot: rand(-0.1, 0.1),
        r: rand(34, 70),
        color: COLORS[k % COLORS.length],
        nodes: Array.from({ length: limbs }, (_, j) => ({
          ang: (j / limbs) * Math.PI * 2 + rand(-0.4, 0.4),
          len: rand(0.45, 1),
          phase: rand(0, Math.PI * 2),
          speed: rand(0.6, 1.6),
        })),
      };
    });

    const size = () => {
      bg.width = Math.round(bg.clientWidth * dpr);
      bg.height = Math.round(bg.clientHeight * dpr);
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(bg);

    let t = rand(0, 100);
    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      t += dt;
      const W = bg.width;
      const H = bg.height;
      ctx.clearRect(0, 0, W, H);
      ctx.lineWidth = 1.2 * dpr;

      for (const c of creatures) {
        c.x = (c.x + c.vx * dt + 1) % 1;
        c.y = (c.y + c.vy * dt + 1) % 1;
        c.rot += c.vrot * dt;
        const cx = c.x * W;
        const cy = c.y * H;
        ctx.strokeStyle = c.color;
        ctx.fillStyle = c.color;
        ctx.globalAlpha = 0.16;

        const pts = c.nodes.map((n) => {
          const wob = 1 + 0.12 * Math.sin(t * n.speed + n.phase);
          const a = c.rot + n.ang;
          return [cx + Math.cos(a) * c.r * n.len * wob * dpr, cy + Math.sin(a) * c.r * n.len * wob * dpr];
        });
        ctx.beginPath();
        for (const [x, y] of pts) {
          ctx.moveTo(cx, cy);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.globalAlpha = 0.34;
        for (const [x, y] of pts) {
          ctx.beginPath();
          ctx.arc(x, y, 2.2 * dpr, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(cx, cy, 2.8 * dpr, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (!reduced) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  });

  function isSlp(name) {
    return /\.(pkg\.)?slp$/i.test(name);
  }
  function isVideo(name) {
    return /\.(mp4|avi|mov|mkv|webm|m4v|mj2|ogg|ogv)$/i.test(name);
  }

  // --- step 1: the .slp / .pkg.slp ---
  function pickSlp(e) {
    const file = e.target.files?.[0];
    if (file) handleSlp(file);
  }
  function handleSlp(file) {
    if (!isSlp(file.name)) {
      store.error = `“${file.name}” is not a .slp / .pkg.slp file`;
      return;
    }
    store.loadSlpFile(file);
  }

  // --- step 2: the required video (plain .slp only) ---
  function pickVideo(e) {
    const file = e.target.files?.[0];
    if (file) handleVideo(file);
  }
  function handleVideo(file) {
    if (!isVideo(file.name)) {
      store.error = `“${file.name}” doesn't look like a video file`;
      return;
    }
    store.loadVideoFile(file);
  }

  function onDrop(e) {
    e.preventDefault();
    dragging = false;
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (store.needsVideo) handleVideo(file);
    else handleSlp(file);
  }
</script>

<canvas class="constellation" bind:this={bg} aria-hidden="true"></canvas>

<div
  class="dropzone"
  class:dragging
  role="button"
  tabindex="0"
  ondragover={(e) => {
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={() => (dragging = false)}
  ondrop={onDrop}
>
  {#if store.needsVideo}
    <!-- Step 2 — a plain .slp was loaded; its video is required to continue. -->
    <div class="inner">
      <div class="step">Step 2 of 2</div>
      <h1>Add the video</h1>
      <p class="lead">
        <strong>{store.fileName}</strong> is a plain <code>.slp</code> with no embedded
        frames — it references an external video. Upload that video to view its frames.
      </p>

      <div class="loaded">
        ✓ {store.frameCount} labeled frame{store.frameCount === 1 ? "" : "s"} loaded
      </div>

      <label class="btn">
        {store.videoLoading ? "Opening video…" : "Choose video file"}
        <input
          type="file"
          accept="video/*,.mp4,.avi,.mov,.mkv,.webm"
          onchange={pickVideo}
          hidden
          disabled={store.videoLoading}
        />
      </label>

      <p class="hint">…or drag &amp; drop the video here</p>

      {#if store.error}
        <p class="status error">{store.error}</p>
      {/if}

      <button class="link" onclick={() => store.reset()}>← choose a different file</button>
    </div>
  {:else}
    <!-- Step 1 — choose the labels file. -->
    <div class="inner hero">
      <svg class="biglogo" viewBox="0 0 28 28" aria-hidden="true">
        <defs>
          <linearGradient id="hg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#7dd3fc" />
            <stop offset="1" stop-color="#818cf8" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="26" height="26" rx="8" fill="url(#hg)" />
        <g stroke="#0a0f18" stroke-width="1.6" stroke-linecap="round" opacity="0.92">
          <line x1="9" y1="9" x2="14" y2="14" />
          <line x1="14" y1="14" x2="11" y2="20" />
          <line x1="14" y1="14" x2="20" y2="11" />
        </g>
        <g fill="#0a0f18">
          <circle cx="9" cy="9" r="2.1" /><circle cx="14" cy="14" r="2.3" />
          <circle cx="11" cy="20" r="2.1" /><circle cx="20" cy="11" r="2.1" />
        </g>
      </svg>
      <h1>SLEAP<span>QC</span></h1>
      <p class="tag">Pose-estimation proofreading, right in your browser.</p>

      <label class="btn">
        {store.status === "loading" ? "Loading…" : "Choose .slp / .pkg.slp"}
        <input type="file" accept=".slp,.pkg.slp" onchange={pickSlp} hidden disabled={store.status === "loading"} />
      </label>

      <p class="hint">…or drop a file anywhere here</p>

      {#if store.status === "loading"}
        <p class="status loading">{store.message}</p>
      {/if}
      {#if store.error}
        <p class="status error">{store.error}</p>
      {/if}

      <ul class="notes">
        <li><span class="tick">●</span><strong>.pkg.slp</strong> — embedded frames render directly.</li>
        <li><span class="tick">●</span><strong>.slp</strong> — poses load, then you'll be asked for the matching video.</li>
      </ul>
    </div>
  {/if}
</div>

<style>
  .constellation {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 0;
  }
  .dropzone {
    position: relative;
    z-index: 1;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 2rem;
  }
  .dropzone.dragging .inner {
    border-color: var(--accent);
    background: #131b27;
    box-shadow: var(--shadow), 0 0 40px -8px rgba(125, 211, 252, 0.35);
    transform: translateY(-2px);
  }
  .inner {
    position: relative;
    width: min(540px, 92vw);
    border: 1.5px dashed #2b3a4e;
    border-radius: 18px;
    padding: 3rem 2.2rem;
    text-align: center;
    background: linear-gradient(180deg, rgba(20, 26, 37, 0.85), rgba(11, 15, 22, 0.85));
    box-shadow: var(--shadow);
    transition: border-color 0.2s var(--ease), background 0.2s, box-shadow 0.2s, transform 0.2s;
    animation: fade-up 0.5s var(--ease) both;
  }
  .biglogo {
    width: 64px;
    height: 64px;
    margin-bottom: 1rem;
    filter: drop-shadow(0 10px 24px rgba(125, 211, 252, 0.45));
  }
  .step {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-weight: 700;
    color: var(--accent);
    margin-bottom: 0.5rem;
  }
  h1 {
    margin: 0 0 0.4rem;
    font-size: 2.3rem;
    font-weight: 800;
    letter-spacing: -0.03em;
  }
  h1 span {
    background: var(--accent-grad);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    margin-left: 2px;
  }
  .tag {
    margin: 0 0 1.8rem;
    color: var(--muted);
    font-size: 1rem;
  }
  .lead {
    margin: 0 0 1.5rem;
    color: var(--muted);
    line-height: 1.5;
  }
  .lead code {
    background: var(--surface-2);
    padding: 0.05rem 0.35rem;
    border-radius: 4px;
    font-size: 0.85em;
  }
  .loaded {
    color: var(--good);
    font-size: 0.9rem;
    font-weight: 600;
    margin: -0.5rem 0 1.4rem;
  }
  .btn {
    display: inline-block;
    background: var(--accent-grad);
    color: #06121f;
    font-weight: 700;
    padding: 0.7rem 1.4rem;
    border-radius: 10px;
    cursor: pointer;
    box-shadow: var(--glow);
    transition: filter 0.12s, transform 0.12s;
  }
  .btn:hover {
    filter: brightness(1.07);
    transform: translateY(-1px);
  }
  .hint {
    color: var(--dim);
    margin: 1rem 0 0;
    font-size: 0.9rem;
  }
  .status {
    margin-top: 1rem;
    font-size: 0.9rem;
  }
  .status.loading {
    color: var(--accent);
  }
  .status.error {
    color: var(--danger);
  }
  .notes {
    margin: 2rem 0 0;
    padding: 0.9rem 1rem;
    list-style: none;
    text-align: left;
    color: var(--muted);
    font-size: 0.82rem;
    line-height: 1.7;
    background: rgba(0, 0, 0, 0.18);
    border: 1px solid var(--border-soft);
    border-radius: 10px;
  }
  .notes li {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
  }
  .notes .tick {
    color: var(--accent);
    font-size: 0.5rem;
  }
  .notes strong {
    color: #cdd7e3;
  }
  .link {
    display: inline-block;
    margin-top: 1.25rem;
    background: none;
    border: none;
    color: var(--muted);
    font-size: 0.85rem;
    cursor: pointer;
    text-decoration: underline;
  }
  .link:hover {
    color: #cdd7e3;
  }
</style>
