<script>
  // A non-blocking, draggable floating window (no backdrop) so the main app stays interactive —
  // e.g. arrow-key frame traversal keeps working while it's open. Drag by the title bar.
  let { title = "", onclose, width = "420px", children } = $props();

  let el = $state.raw(null);
  let x = $state(null); // left px; null = initial centered
  let y = $state(null); // top px
  let drag = null;

  function down(e) {
    if (e.button != null && e.button !== 0) return; // left button / touch only
    const r = el.getBoundingClientRect();
    if (x == null) { x = r.left; y = r.top; } // pin the current (centered) position, then follow
    drag = { ox: e.clientX - x, oy: e.clientY - y };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }
  function move(e) {
    if (!drag) return;
    const w = el.offsetWidth;
    x = Math.max(-(w - 100), Math.min(window.innerWidth - 100, e.clientX - drag.ox)); // keep ≥100px on screen
    y = Math.max(6, Math.min(window.innerHeight - 36, e.clientY - drag.oy)); // keep the bar reachable
  }
  function up(e) {
    drag = null;
    try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
  }
</script>

<div
  class="popwin"
  bind:this={el}
  style:width={width}
  style:left={x == null ? "50%" : `${x}px`}
  style:top={y == null ? "10%" : `${y}px`}
  style:transform={x == null ? "translateX(-50%)" : "none"}
  role="dialog"
  aria-label={title}
>
  <div class="bar" onpointerdown={down} onpointermove={move} onpointerup={up}>
    <span class="grip" aria-hidden="true">⠿</span>
    <span class="ttl">{title}</span>
    <button class="x" onclick={onclose} title="Close">✕</button>
  </div>
  <div class="body">{@render children?.()}</div>
</div>

<style>
  .popwin {
    position: fixed;
    z-index: 300;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 16px 50px rgba(0, 0, 0, 0.5);
    max-width: 94vw;
    max-height: 88vh;
    display: flex;
    flex-direction: column;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.5rem 0.4rem 0.6rem;
    border-bottom: 1px solid var(--border);
    border-radius: 10px 10px 0 0;
    background: rgba(255, 255, 255, 0.025);
    cursor: move;
    user-select: none;
    touch-action: none;
  }
  .grip { color: var(--dim); font-size: 0.7rem; letter-spacing: -2px; }
  .ttl { font-size: 0.72rem; color: var(--muted); flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .x { background: none; border: none; color: var(--dim); cursor: pointer; font-size: 0.8rem; padding: 0 0.2rem; flex: none; }
  .x:hover { color: var(--accent); }
  .body { padding: 0.85rem 1rem; overflow: auto; }
</style>
