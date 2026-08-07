<script module>
  // Remember each window's last position across open/close (keyed by title), so re-opening a
  // pop-out returns it to where you left it instead of re-centering.
  const POS = new Map();
</script>

<script>
  // A non-blocking, draggable floating window (no backdrop) so the main app stays interactive —
  // e.g. arrow-key frame traversal keeps working while it's open. Drag by the title bar.
  // `fill`: the body becomes a flex column that does NOT scroll, so a child can claim the leftover
  // height (the proofreading frame). Default stays "size to content, scroll if tall".
  let { title = "", onclose, width = "420px", height = null, fill = false, children } = $props();

  let el = $state.raw(null);
  const saved = POS.get(title);
  let x = $state(saved?.x ?? null); // left px; null = initial centered
  let y = $state(saved?.y ?? null); // top px
  let drag = null;

  function down(e) {
    if (e.button != null && e.button !== 0) return; // left button / touch only
    if (e.target.closest("button")) return; // don't start a drag on the ✕ (it would steal the click)
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
    if (x != null) POS.set(title, { x, y }); // remember where it was left
    try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
  }
  function reset(e) {
    if (e.target.closest("button")) return; // ignore dbl-clicks on the ✕
    x = null; y = null;
    POS.delete(title);
  }
</script>

<div
  class="popwin"
  bind:this={el}
  style:width={width}
  style:height={height ?? undefined}
  style:left={x == null ? "50%" : `${x}px`}
  style:top={y == null ? "10%" : `${y}px`}
  style:transform={x == null ? "translateX(-50%)" : "none"}
  role="dialog"
  aria-label={title}
>
  <div class="bar" onpointerdown={down} onpointermove={move} onpointerup={up} ondblclick={reset} title="Drag to move · double-click to reset">
    <span class="grip" aria-hidden="true">⠿</span>
    <span class="ttl">{title}</span>
    <button class="x" onclick={onclose} title="Close">✕</button>
  </div>
  <div class="body" class:fill>{@render children?.()}</div>
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
  .bar:hover { background: rgba(255, 255, 255, 0.05); }
  .grip { color: var(--dim); font-size: 0.7rem; letter-spacing: -2px; }
  .ttl { font-size: 0.72rem; color: var(--muted); flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .x { background: none; border: none; color: var(--dim); cursor: pointer; font-size: 0.8rem; padding: 0 0.2rem; flex: none; }
  .x:hover { color: var(--accent); }
  .body { padding: 0.85rem 1rem; overflow: auto; }
  .body.fill {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0.6rem 0.7rem;
  }
</style>
