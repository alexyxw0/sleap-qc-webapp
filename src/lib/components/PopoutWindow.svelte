<script module>
  // Remember each window's last position AND size across open/close (keyed by title), so re-opening
  // a pop-out returns it to where you left it instead of re-centering at the default size.
  const POS = new Map();
  const SIZE = new Map();
</script>

<script>
  // A non-blocking, draggable floating window (no backdrop) so the main app stays interactive —
  // e.g. arrow-key frame traversal keeps working while it's open. Drag by the title bar.
  // `fill`: the body becomes a flex column that does NOT scroll, so a child can claim the leftover
  // height (the proofreading frame). Default stays "size to content, scroll if tall".
  // `resizable`: a corner grip. The proofreading frame is CONTAIN-fitted into the leftover height, so
  // on a wide-and-short window the picture letterboxes and there is nothing the layout can do about it
  // — only more height helps, and only the user knows how much of their screen to give it.
  import { ui } from "../uiStore.svelte.js";

  let { title = "", onclose, width = "420px", height = null, fill = false, resizable = false, children } = $props();

  let el = $state.raw(null);
  const saved = POS.get(title);
  let x = $state(saved?.x ?? null); // left px; null = initial centered
  let y = $state(saved?.y ?? null); // top px
  let drag = null;
  const savedSize = SIZE.get(title);
  let w = $state(savedSize?.w ?? null);   // px once resized; null = follow the `width` prop
  let h = $state(savedSize?.h ?? null);
  let sizing = null;
  const MIN_W = 380, MIN_H = 260;

  function sizeDown(e) {
    const r = el.getBoundingClientRect();
    sizing = { sx: e.clientX, sy: e.clientY, w0: r.width, h0: r.height };
    if (x == null) { x = r.left; y = r.top; }   // stop the centering transform fighting the resize
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  }
  function sizeMove(e) {
    if (!sizing) return;
    w = Math.max(MIN_W, Math.min(window.innerWidth - 16, sizing.w0 + (e.clientX - sizing.sx)));
    h = Math.max(MIN_H, Math.min(window.innerHeight - 16, sizing.h0 + (e.clientY - sizing.sy)));
  }
  function sizeUp(e) {
    sizing = null;
    if (w != null) SIZE.set(title, { w, h });
    try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
  }

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
    // Right bound stops at the chrome, not the viewport edge: a window parked under the tab strip or
    // the docked panel is behind them now, so its title bar would be there but ungrabbable.
    const right = window.innerWidth - ui.chromeW;
    x = Math.max(-(w - 100), Math.min(right - 100, e.clientX - drag.ox)); // keep ≥100px on screen
    y = Math.max(6, Math.min(window.innerHeight - 36, e.clientY - drag.oy)); // keep the bar reachable
  }
  function up(e) {
    drag = null;
    if (x != null) POS.set(title, { x, y }); // remember where it was left
    try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
  }
  function reset(e) {
    if (e.target.closest("button")) return; // ignore dbl-clicks on the ✕
    x = null; y = null; w = null; h = null;   // double-click the bar restores size as well as place
    POS.delete(title);
    SIZE.delete(title);
  }
</script>

<div
  class="popwin"
  bind:this={el}
  style:width={w == null ? width : `${w}px`}
  style:height={h == null ? (height ?? undefined) : `${h}px`}
  style:left={x == null ? `calc(50% - ${ui.chromeW / 2}px)` : `${x}px`}
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
  {#if resizable}
    <!-- Corner grip. `touch-action: none` so a drag on a trackpad/touch device resizes instead of
         scrolling the page out from under it. -->
    <div
      class="rgrip"
      role="separator"
      aria-label="Resize window"
      onpointerdown={sizeDown}
      onpointermove={sizeMove}
      onpointerup={sizeUp}
      onpointercancel={sizeUp}
      title="Drag to resize · double-click the title bar to reset"
    ></div>
  {/if}
</div>

<style>
  .popwin {
    position: fixed;
    z-index: 300;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 16px 50px rgba(0, 0, 0, 0.5);
    /* Caps keep a window on screen. They used to stop 12% short of the viewport, which silently
       overrode a resize past that — so a user dragging for more height simply stopped getting it. */
    max-width: 98vw;
    max-height: 96vh;
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
  .rgrip {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    touch-action: none;
    /* two hairlines, the conventional corner grip */
    background:
      linear-gradient(135deg, transparent 0 45%, var(--border) 45% 55%, transparent 55% 100%),
      linear-gradient(135deg, transparent 0 70%, var(--border) 70% 80%, transparent 80% 100%);
  }
  .rgrip:hover { background-color: color-mix(in srgb, var(--accent) 18%, transparent); }
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
