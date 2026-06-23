<script>
  // QC-review correction popup. Steps through flagged frames WORST-FIRST (by qc.flagConfidence),
  // showing each one auto-zoomed to its faulty instance on a focused canvas. The user drags the
  // ringed keypoint to fix it (or deletes a duplicate instance), then advances. Reuses the main
  // canvas pipeline: drawScene/hitTestNode (draw.js), store.frameImage + setIndex, editStore.
  import { store } from "../labelsStore.svelte.js";
  import { edit } from "../editStore.svelte.js";
  import { qc, heatColor } from "../qcStore.svelte.js";
  import { ui } from "../uiStore.svelte.js";
  import { drawScene, frameDims, hitTestNode, colorFor } from "../draw.js";

  let wrap = $state();
  let canvas = $state();
  let ctx = $state();
  let vpW = $state(0);
  let vpH = $state(0);
  let pos = $state(0); // index into the ranked flagged-frame list
  let started = false;

  let mode = null; // 'node' (drag a point) | 'pan' (drag the background)
  let dragging = null;
  let panStart = null;
  let lt = { s: 1, offX: 0, offY: 0 }; // device transform, recomputed each draw for pointer mapping

  // View state — an ABSOLUTE scale + image-space center, set once when a frame is shown and then
  // user-controlled (zoom/pan). Decoupling it from the live points is what stops a node-drag from
  // re-framing the view (the "awkward animation"). Bounds derive from the image size.
  let s = $state(1);    // device px per image px
  let cx = $state(0);   // image-space x shown at the canvas center
  let cy = $state(0);   // image-space y shown at the canvas center
  let framedIndex = -1; // store.index this view was last auto-framed for
  let framedWithImg = false; // whether that framing happened with the real image decoded

  const DRAG_THRESH = 3;
  const HIT_PX = 14;
  const MAX_ZOOM = 24; // cap zoom-in at 24× the whole-image fit
  const dpr = Math.min((typeof window !== "undefined" && window.devicePixelRatio) || 1, 2);

  // Nav list snapshotted on open, so re-scoring after a correction doesn't reshuffle/drop frames
  // mid-session — you review the set that was flagged when you opened; verdicts still update live.
  let sessionRanked = $state([]);
  const total = $derived(sessionRanked.length);
  const item = $derived(store.current);
  const verdict = $derived.by(() => { void qc.rev; void store.rev; return item ? qc.frameTopIssue(item) : null; });
  // Tint the verdict label to the marked node's instance color (the dot color on the canvas), so
  // the text and the ringed node read as the same thing. Only when a specific node is ringed.
  const labelColor = $derived.by(() => {
    void qc.rev; void store.rev;
    if (!item || !(verdict?.worstNode >= 0)) return null;
    const fi = qc.frameWorstInstance(item);
    const idx = fi >= 0 ? fi : 0;
    const inst = item.lf?.instances?.[idx];
    return inst ? colorFor(inst, idx) : null;
  });
  const conf = $derived.by(() => { void qc.rev; return item ? qc.flagConfidence(item) : null; });
  const flaggers = $derived.by(() => { void qc.rev; return item ? qc.frameFlaggingChecks(item) : []; });
  const edited = $derived.by(() => { void edit.dirtyRev; return item?.lf ? edit.isFrameModified(item.lf) : false; });
  // When the selected (e.g. faulty) node has no position yet, prompt to click-to-place it.
  const unplacedHint = $derived.by(() => {
    void store.rev; void edit.selInstance; void edit.selNode;
    if (edit.selInstance < 0 || edit.selNode < 0) return null;
    const p = item?.lf?.instances?.[edit.selInstance]?.points?.[edit.selNode];
    if (p && Number.isNaN(p.xy?.[0])) return store.skeleton?.nodeNames?.[edit.selNode] ?? `node ${edit.selNode}`;
    return null;
  });

  $effect(() => {
    if (canvas && !ctx) ctx = canvas.getContext("2d");
  });

  // Track the canvas wrap size.
  $effect(() => {
    if (!wrap) return;
    const measure = () => { vpW = wrap.clientWidth; vpH = wrap.clientHeight; };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  });

  // (Re)initialize each time the popup OPENS. The component stays mounted (only the modal markup
  // is conditional), so a one-shot mount guard would fire once at app load — before QC has run —
  // and never again. Keying on ui.reviewOpen (and resetting `started` on close) makes every open
  // re-read the CURRENT flagged set, so it reflects the latest thresholds / re-run and jumps to
  // the worst frame. Without this, re-opening after a threshold change showed a stale frame.
  $effect(() => {
    if (!ui.reviewOpen) { started = false; return; }
    if (started) return;
    started = true;
    framedIndex = -1; framedWithImg = false; // re-frame the view for this session
    sessionRanked = qc.flaggedRanked.slice(); // snapshot the worst-first order for this session
    if (!sessionRanked.length) { pos = 0; return; }
    const at = sessionRanked.indexOf(store.index);
    pos = at >= 0 ? at : 0;
    goto(sessionRanked[pos]);
  });

  function goto(frameIdx) {
    if (frameIdx == null || frameIdx < 0) return;
    store.setIndex(frameIdx);
    store.syncFrameImage();
    // pre-select the faulty instance/node so it's ringed + immediately draggable
    const it = store.current;
    let wi = it ? qc.frameWorstInstance(it) : -1;
    if (wi < 0 && it?.lf?.instances?.length) wi = 0; // boolean-flagged frame -> focus first instance
    edit.select(wi, wi >= 0 ? qc.faultyNodeFor(it, wi) : -1);
  }
  function step(d) {
    if (!sessionRanked.length) return;
    pos = Math.max(0, Math.min(sessionRanked.length - 1, pos + d));
    goto(sessionRanked[pos]);
  }
  function close() { ui.reviewOpen = false; }

  // Prefer the ACTUAL decoded image size for the transform — that's what gets blitted, so framing
  // against video.shape (which can disagree) is what strands the view off-pixels. Fall back to
  // shape/default only before the image has loaded.
  const dimsNow = () => {
    const img = store.frameImage;
    if (img && img.width && img.height) return { w: img.width, h: img.height };
    return frameDims(item, null);
  };
  const fitWhole = (cw, ch, dims) => Math.min(cw / dims.w, ch / dims.h); // scale at which the whole image fits
  // Pure: clamp a center so the image can't be panned into the void (center a too-small axis).
  // Pure (no reactive read of s/cx/cy) so callers in the framing EFFECT can't form a write/read cycle.
  function clampedCenter(scale, ccx, ccy, cw, ch, dims) {
    const halfW = cw / 2 / scale, halfH = ch / 2 / scale;
    return {
      x: halfW * 2 >= dims.w ? dims.w / 2 : Math.max(halfW, Math.min(dims.w - halfW, ccx)),
      y: halfH * 2 >= dims.h ? dims.h / 2 : Math.max(halfH, Math.min(dims.h - halfH, ccy)),
    };
  }
  function zoomBy(factor) {
    const cw = Math.round(vpW * dpr), ch = Math.round(vpH * dpr);
    if (!cw || !ch) return;
    const dims = dimsNow();
    const minS = fitWhole(cw, ch, dims);
    const ns = Math.max(minS, Math.min(minS * MAX_ZOOM, s * factor)); // bound: whole-image .. 24×
    const c = clampedCenter(ns, cx, cy, cw, ch, dims);
    s = ns; cx = c.x; cy = c.y;
  }
  // Frame ALL instances' visible nodes (the whole labeled scene) with a little adjustment room —
  // set once per frame, never during a drag. Seeing every animal matters for the cross-instance
  // flags (duplicates, L/R swaps, chimeras), and it avoids the over-zoom when a single instance's
  // bbox is tiny. A single-instance frame is unchanged. Whole-image floor + max-zoom cap still apply.
  function frameScene(cw, ch) {
    const dims = dimsNow();
    const xs = [], ys = [];
    for (const inst of item?.lf?.instances ?? []) {
      for (const p of inst.points ?? []) {
        const x = p?.xy?.[0], y = p?.xy?.[1];
        if (x != null && !Number.isNaN(x)) { xs.push(x); ys.push(y); }
      }
    }
    let bx = 0, by = 0, bw = dims.w, bh = dims.h;
    if (xs.length) { bx = Math.min(...xs); by = Math.min(...ys); bw = Math.max(...xs) - bx; bh = Math.max(...ys) - by; }
    const margin = Math.max(bw, bh, 1) * 0.22 + 16; // breathing room so a dragged node stays in view
    const ow = bw + 2 * margin, oh = bh + 2 * margin;
    const minS = fitWhole(cw, ch, dims);
    const ns = Math.max(minS, Math.min(minS * MAX_ZOOM, Math.min((cw * 0.92) / ow, (ch * 0.92) / oh)));
    const c = clampedCenter(ns, bx + bw / 2, by + bh / 2, cw, ch, dims);
    s = ns; cx = c.x; cy = c.y;
  }

  // (Re)frame whenever the SHOWN FRAME changes — not on every edit. This is the key to a stable
  // view while dragging: the draw transform comes from s/cx/cy, which only change here or when the
  // user explicitly zooms/pans, so moving a point no longer re-frames the canvas.
  // Also re-frame once the REAL image arrives for a frame we framed without it: framing before the
  // decode finishes uses fallback dims (shape/default), which can strand the view off-pixels.
  $effect(() => {
    if (!ui.reviewOpen) return;
    void store.index;
    const hasImg = !!store.frameImage;
    const W = vpW, H = vpH;
    if (!W || !H || !item) return;
    if (store.index === framedIndex && (framedWithImg || !hasImg)) return;
    frameScene(Math.round(W * dpr), Math.round(H * dpr));
    framedIndex = store.index;
    framedWithImg = hasImg;
  });

  // Draw the focused frame + overlay. The transform comes from the STABLE view state (s/cx/cy),
  // not the live points — so a node-drag (store.rev) redraws the moved point without re-framing.
  $effect(() => {
    if (!ui.reviewOpen) return;
    void store.index; void store.frameImage; void store.rev; void qc.rev;
    const selI = edit.selInstance, selN = edit.selNode;
    let vs = s, vcx = cx, vcy = cy; // track zoom/pan
    const W = vpW, H = vpH;
    if (!ctx || !W || !H || !item) return;
    const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
    // recover a degenerate transform (e.g. computed before the frame had a size) instead of
    // drawing the scene at NaN/0 scale, which would show nothing.
    if (!Number.isFinite(vs) || vs <= 0 || !Number.isFinite(vcx) || !Number.isFinite(vcy)) {
      frameScene(cw, ch);
      vs = s; vcx = cx; vcy = cy;
    }
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;

    let offX = cw / 2 - vcx * vs, offY = ch / 2 - vcy * vs;
    // HARD GUARANTEE the image is on-screen: if the framed transform would show none of the image
    // rect (a degenerate bbox, an off-image flagged node, or a shape/decoded-size mismatch), re-fit
    // the whole frame so the user always sees pixels. Persist it so nav/zoom continue sanely.
    {
      const d = dimsNow();
      const onScreen = offX < cw && d.w * vs + offX > 0 && offY < ch && d.h * vs + offY > 0;
      if (!onScreen) {
        console.warn("[qc-review] framed off-screen — refitting whole frame", { vs, vcx, vcy, dims: d, cw, ch });
        vs = fitWhole(cw, ch, d); vcx = d.w / 2; vcy = d.h / 2;
        s = vs; cx = vcx; cy = vcy;
        offX = cw / 2 - vcx * vs; offY = ch / 2 - vcy * vs;
      }
    }
    lt = { s: vs, offX, offY };

    // Per-instance attribution (faultyNodeFor) can throw on a freshly-edited / degenerate pose;
    // never let that blank the canvas or kill this effect's reactivity (which would freeze the
    // view after the first edit). Compute defensively, and always draw — the image at minimum.
    let worstNodes = [];
    try {
      const insts = item.lf?.instances ?? [];
      worstNodes = insts.map((_, i) => (qc.instanceFlagged(item, i) ? qc.faultyNodeFor(item, i) : -1));
    } catch (err) {
      console.warn("[qc-review] node attribution failed:", err);
    }
    try {
      drawScene(ctx, store.frameImage, item, store.skeleton, {
        transform: { s: vs, offX, offY }, dims: dimsNow(), scale: dpr / vs,
        editing: true, selInstance: selI, selNode: selN, worstNodes, uncertainNodes: null,
        hiddenAlpha: 0.55, // hidden/occluded nodes are correction targets here — keep them grabbable
      });
    } catch (err) {
      console.warn("[qc-review] draw failed:", err);
    }
  });

  // Keep the popup's frame image in sync with the current frame itself, rather than relying on the
  // Viewer behind it (which may be unmounted/paused) — defends against a blank canvas after edits.
  $effect(() => {
    if (!ui.reviewOpen) return;
    void store.index;
    store.syncFrameImage();
  });

  function toImage(e) {
    const rect = canvas.getBoundingClientRect();
    const devPerCss = rect.width ? canvas.width / rect.width : dpr;
    const devX = (e.clientX - rect.left) * devPerCss;
    const devY = (e.clientY - rect.top) * devPerCss;
    return { x: (devX - lt.offX) / lt.s, y: (devY - lt.offY) / lt.s, scale: devPerCss / lt.s };
  }
  function onPointerDown(e) {
    const lf = store.current?.lf;
    if (!lf) return;
    const { x, y, scale } = toImage(e);
    const hit = hitTestNode(lf, HIT_PX * scale)(x, y);
    if (hit) {
      const already = edit.selInstance === hit.instIdx && edit.selNode === hit.nodeIdx;
      edit.select(hit.instIdx, hit.nodeIdx);
      if (already) {
        const p = lf.instances[hit.instIdx].points[hit.nodeIdx];
        dragging = { instIdx: hit.instIdx, nodeIdx: hit.nodeIdx, from: { xy: [...p.xy], visible: p.visible }, sx: e.clientX, sy: e.clientY, active: false };
        mode = "node";
      } else mode = "node-select"; // selected only; no movement this press
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    // background -> pan the view (or, if it doesn't move, a click that places an unplaced node)
    mode = "pan";
    panStart = { sx: e.clientX, sy: e.clientY, cx0: cx, cy0: cy, moved: false };
    canvas.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e) {
    if (mode === "node") {
      if (!dragging.active) {
        if (Math.hypot(e.clientX - dragging.sx, e.clientY - dragging.sy) <= DRAG_THRESH) return;
        dragging.active = true;
      }
      const { x, y } = toImage(e);
      // a correction asserts the node IS here -> make it visible (so hidden/occluded nodes can be fixed)
      edit.setPoint(dragging.instIdx, dragging.nodeIdx, x, y, true);
    } else if (mode === "pan") {
      if (!panStart.moved && Math.hypot(e.clientX - panStart.sx, e.clientY - panStart.sy) <= DRAG_THRESH) return;
      panStart.moved = true;
      const rect = canvas.getBoundingClientRect();
      const devPerCss = rect.width ? canvas.width / rect.width : dpr;
      const nx = panStart.cx0 - ((e.clientX - panStart.sx) * devPerCss) / s;
      const ny = panStart.cy0 - ((e.clientY - panStart.sy) * devPerCss) / s;
      const c = clampedCenter(s, nx, ny, Math.round(vpW * dpr), Math.round(vpH * dpr), dimsNow());
      cx = c.x; cy = c.y;
    }
  }
  function onPointerUp(e) {
    if (mode === "node" && dragging?.active) {
      edit.commitMove(dragging.instIdx, dragging.nodeIdx, dragging.from);
      // re-score this instance against the cached fit -> verdict + ring jump to the next issue
      qc.rescoreInstance(store.current, dragging.instIdx);
    } else if (mode === "pan" && panStart && !panStart.moved) {
      // a click on the background PLACES the selected node if it's unplaced (NaN coords). This is
      // how a missing/never-placed node gets a position in the popup (matches the main editor).
      const p = edit.selectedInstance?.points?.[edit.selNode];
      if (edit.selInstance >= 0 && edit.selNode >= 0 && p && Number.isNaN(p.xy?.[0])) {
        const { x, y } = toImage(e);
        const from = { xy: [...p.xy], visible: p.visible };
        edit.setPoint(edit.selInstance, edit.selNode, x, y, true);
        edit.commitMove(edit.selInstance, edit.selNode, from);
        qc.rescoreInstance(store.current, edit.selInstance);
      }
    }
    dragging = null;
    mode = null;
    panStart = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* gone */ }
  }
  function onWheel(e) {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }

  function onKey(e) {
    if (!ui.reviewOpen) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "z" || e.key === "Z")) { e.shiftKey ? edit.redo() : edit.undo(); qc.rescoreInstance(store.current, edit.selInstance); e.preventDefault(); return; }
    if (e.key === "Escape") { close(); e.preventDefault(); }
    else if (e.key === "ArrowRight" || e.key === "d" || e.key === "n") { step(1); e.preventDefault(); }
    else if (e.key === "ArrowLeft" || e.key === "a" || e.key === "p") { step(-1); e.preventDefault(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && edit.selInstance >= 0) { edit.deleteInstance(); e.preventDefault(); }
    else if (e.key === "v" && edit.selInstance >= 0 && edit.selNode >= 0) { edit.toggleVisible(edit.selInstance, edit.selNode); qc.rescoreInstance(store.current, edit.selInstance); e.preventDefault(); }
    else if (e.key === "=" || e.key === "+") { zoomBy(1.2); e.preventDefault(); }
    else if (e.key === "-" || e.key === "_") { zoomBy(1 / 1.2); e.preventDefault(); }
    else if (e.key === "0") { frameScene(Math.round(vpW * dpr), Math.round(vpH * dpr)); e.preventDefault(); }
  }
  // zoom % for the readout: current scale relative to the whole-image fit (1× = whole image).
  const zoomPct = $derived.by(() => {
    void s; void store.frameImage; void vpW; void vpH;
    const cw = Math.round(vpW * dpr), ch = Math.round(vpH * dpr);
    if (!cw || !ch) return 100;
    return Math.round((s / fitWhole(cw, ch, dimsNow())) * 100);
  });
</script>

<svelte:window onkeydown={onKey} />

{#if ui.reviewOpen}
  <div class="scrim" onpointerdown={close}></div>
  <div class="card" role="dialog" aria-label="QC review">
    <header class="rhead">
      <span class="title">QC Review</span>
      {#if total}
        <span class="prog">{pos + 1} <span class="dim">/ {total}</span></span>
        {#if conf != null}<span class="confchip" style:background={heatColor(conf)} title="Flag confidence">{conf.toFixed(2)}</span>{/if}
        {#if item}<span class="dim fr">frame {item.frameIdx}</span>{/if}
        {#if edited}<span class="editbadge" title="You edited this frame">edited</span>{/if}
      {/if}
      <button class="x" onclick={close} title="Close (Esc)">✕</button>
    </header>

    {#if !total}
      <div class="empty">No flagged frames. Run QC (and enable some checks) first.</div>
    {:else}
      <div class="stage" bind:this={wrap} onwheel={onWheel}>
        <canvas
          bind:this={canvas}
          style:cursor={mode === "pan" ? "grabbing" : "crosshair"}
          onpointerdown={onPointerDown}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
        ></canvas>
        {#if unplacedHint}
          <div class="placehint"><b>{unplacedHint}</b> isn't placed — click on the image to place it</div>
        {/if}
        <div class="zoomctl">
          <button onclick={() => zoomBy(1 / 1.2)} title="Zoom out (−)">−</button>
          <span class="pct">{zoomPct}%</span>
          <button onclick={() => zoomBy(1.2)} title="Zoom in (+)">＋</button>
          <button onclick={() => frameScene(Math.round(vpW * dpr), Math.round(vpH * dpr))} title="Refit to frame (0)">⤢</button>
        </div>
      </div>

      <div class="verdict">
        {#if verdict?.issue}
          <span class="vissue" style:color={labelColor}>
            {#if labelColor}<i class="swatch" style:background={labelColor}></i>{/if}{verdict.issue}{verdict.worstNodeName ? ` · ${verdict.worstNodeName}` : ""}
          </span>
        {:else if edited}
          <span class="resolved">✓ no remaining issues on this frame</span>
        {/if}
        <div class="tags">
          {#each flaggers as f (f.key)}
            <span class="ftag">{f.label}{#if f.score != null}<i>{f.score.toFixed(2)}</i>{/if}</span>
          {/each}
        </div>
      </div>

      <footer class="rfoot">
        <button class="nav" onclick={() => step(-1)} disabled={pos <= 0} title="Previous (←)">‹ Prev</button>
        <div class="mid">
          <button class="act danger" onclick={() => edit.deleteInstance()} disabled={edit.selInstance < 0} title="Delete the selected instance (duplicates)">Delete instance</button>
          <span class="hint">drag the ringed point to fix · drag bg / scroll to pan-zoom · <kbd>V</kbd> hide · <kbd>⌘Z</kbd> undo</span>
        </div>
        <button class="nav primary" onclick={() => (pos >= total - 1 ? close() : step(1))} title="Next (→)">
          {pos >= total - 1 ? "Done" : "Next ›"}
        </button>
      </footer>
    {/if}
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(4, 6, 10, 0.72);
    backdrop-filter: blur(4px);
    z-index: 500;
    animation: fade-up 0.15s var(--ease) both;
  }
  .card {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(880px, 94vw);
    height: min(680px, 90vh);
    z-index: 501;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow);
    overflow: hidden;
    animation: palette-in 0.16s var(--ease) both;
  }
  @keyframes palette-in {
    from { opacity: 0; transform: translate(-50%, -46%); }
    to { opacity: 1; transform: translate(-50%, -50%); }
  }
  .rhead {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.65rem 0.9rem;
    border-bottom: 1px solid var(--border);
  }
  .title {
    font-weight: 700;
    font-size: 0.82rem;
    letter-spacing: 0.04em;
  }
  .prog {
    font-size: 0.82rem;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }
  .dim { color: var(--dim); }
  .fr { font-size: 0.72rem; letter-spacing: 0.05em; }
  .confchip {
    color: #04181d;
    font-weight: 700;
    border-radius: var(--r-xs);
    padding: 0.04rem 0.4rem;
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
  }
  .editbadge {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent);
    border: 1px solid rgba(95, 217, 242, 0.4);
    border-radius: var(--r-xs);
    padding: 0.05rem 0.35rem;
  }
  .x {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--dim);
    cursor: pointer;
    font-size: 0.85rem;
    width: 1.6rem;
    height: 1.6rem;
    border-radius: var(--r-xs);
  }
  .x:hover { color: var(--danger); background: rgba(251, 113, 133, 0.08); }
  .empty {
    flex: 1;
    display: grid;
    place-items: center;
    color: var(--muted);
    font-size: 0.85rem;
    padding: 2rem;
  }
  .stage {
    flex: 1;
    min-height: 0;
    position: relative;
    background: repeating-conic-gradient(#0c0e11 0% 25%, #090b0d 0% 50%) 50% / 22px 22px;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none;
    cursor: crosshair;
  }
  .placehint {
    position: absolute;
    top: 0.6rem;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(11, 13, 15, 0.86);
    border: 1px solid rgba(231, 192, 138, 0.45);
    color: #e7c08a;
    border-radius: var(--r-xs);
    padding: 0.28rem 0.7rem;
    font-size: 0.72rem;
    white-space: nowrap;
    backdrop-filter: blur(8px);
    pointer-events: none;
  }
  .placehint b { color: #fff; }
  .zoomctl {
    position: absolute;
    right: 0.6rem;
    bottom: 0.6rem;
    display: flex;
    align-items: center;
    gap: 0.1rem;
    background: rgba(11, 13, 15, 0.82);
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    padding: 0.12rem 0.18rem;
    backdrop-filter: blur(8px);
  }
  .zoomctl button {
    width: 1.6rem;
    height: 1.6rem;
    background: none;
    border: none;
    color: var(--muted);
    border-radius: var(--r-xs);
    cursor: pointer;
    font-size: 0.85rem;
    line-height: 1;
  }
  .zoomctl button:hover {
    background: rgba(255, 255, 255, 0.06);
    color: var(--text);
  }
  .zoomctl .pct {
    min-width: 2.7rem;
    text-align: center;
    font-size: 0.66rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .verdict {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    padding: 0.5rem 0.9rem;
    border-top: 1px solid var(--border);
  }
  .vissue {
    display: inline-flex;
    align-items: center;
    gap: 0.34rem;
    font-size: 0.82rem;
    font-weight: 600;
    color: #e7c08a; /* default when no specific node is marked */
  }
  .vissue .swatch {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
  }
  .resolved {
    font-size: 0.82rem;
    font-weight: 600;
    color: #86efac; /* green: this frame is clean now */
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-left: auto;
  }
  .ftag {
    display: inline-flex;
    align-items: center;
    gap: 0.28rem;
    font-size: 0.66rem;
    color: #e7c08a;
    border: 1px solid rgba(231, 192, 138, 0.4);
    border-radius: var(--r-xs);
    padding: 0.04rem 0.36rem;
  }
  .ftag i { color: var(--dim); font-style: normal; font-variant-numeric: tabular-nums; }
  .rfoot {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.65rem 0.9rem;
    border-top: 1px solid var(--border);
  }
  .mid {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
  }
  .hint { font-size: 0.66rem; color: var(--dim); letter-spacing: 0.02em; }
  kbd {
    font-family: inherit;
    font-size: 0.62rem;
    color: var(--muted);
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0 0.25rem;
  }
  .nav, .act {
    background: none;
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: var(--r-xs);
    padding: 0.36rem 0.8rem;
    font-size: 0.78rem;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s, opacity 0.12s;
  }
  .nav:hover:not(:disabled), .act:hover:not(:disabled) { background: rgba(255, 255, 255, 0.05); }
  .nav:disabled, .act:disabled { opacity: 0.4; cursor: default; }
  .nav.primary {
    background: var(--accent);
    color: #04181d;
    border-color: var(--accent);
    font-weight: 600;
  }
  .nav.primary:hover { filter: brightness(1.08); }
  .act.danger { color: #fda4af; border-color: rgba(251, 113, 133, 0.4); }
  .act.danger:hover:not(:disabled) { background: rgba(251, 113, 133, 0.08); }
</style>
