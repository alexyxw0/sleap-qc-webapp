<script>
  import { store } from "../labelsStore.svelte.js";

  let dragging = $state(false);

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
    <div class="inner">
      <h1>SLEAP Web</h1>
      <p class="lead">Open a labels file to browse its frames and poses.</p>

      <label class="btn">
        Choose .slp / .pkg.slp
        <input type="file" accept=".slp,.pkg.slp" onchange={pickSlp} hidden />
      </label>

      <p class="hint">…or drag &amp; drop a file here</p>

      {#if store.status === "loading"}
        <p class="status loading">{store.message}</p>
      {/if}
      {#if store.error}
        <p class="status error">{store.error}</p>
      {/if}

      <ul class="notes">
        <li><strong>.pkg.slp</strong> — embedded frames render directly.</li>
        <li>
          <strong>.slp</strong> — poses load, then you'll be asked for the matching video.
        </li>
      </ul>
    </div>
  {/if}
</div>

<style>
  .dropzone {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 2rem;
  }
  .dropzone.dragging .inner {
    border-color: var(--accent);
    background: #141b26;
  }
  .inner {
    width: min(560px, 92vw);
    border: 2px dashed #2a3442;
    border-radius: 14px;
    padding: 2.5rem 2rem;
    text-align: center;
    background: #10151d;
    transition: border-color 0.15s, background 0.15s;
  }
  .step {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent);
    margin-bottom: 0.5rem;
  }
  h1 {
    margin: 0 0 0.25rem;
    font-size: 1.9rem;
    letter-spacing: -0.02em;
  }
  .lead {
    margin: 0 0 1.5rem;
    color: var(--muted);
    line-height: 1.5;
  }
  .lead code {
    background: #1a212c;
    padding: 0.05rem 0.3rem;
    border-radius: 4px;
    font-size: 0.85em;
  }
  .loaded {
    color: #86efac;
    font-size: 0.88rem;
    margin: -0.5rem 0 1.25rem;
  }
  .btn {
    display: inline-block;
    background: var(--accent);
    color: #06121f;
    font-weight: 600;
    padding: 0.6rem 1.1rem;
    border-radius: 8px;
    cursor: pointer;
  }
  .btn:hover {
    filter: brightness(1.07);
  }
  .hint {
    color: var(--muted);
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
    color: #fda4af;
  }
  .notes {
    margin: 1.75rem 0 0;
    padding: 0;
    list-style: none;
    text-align: left;
    color: var(--muted);
    font-size: 0.82rem;
    line-height: 1.6;
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
