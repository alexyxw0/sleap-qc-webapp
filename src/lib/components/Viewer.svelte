<script>
  import { store } from "../labelsStore.svelte.js";
  import { edit } from "../editStore.svelte.js";
  import { view } from "../viewStore.svelte.js";
  import { qc, heatColor } from "../qcStore.svelte.js";
  import { ui } from "../uiStore.svelte.js";
  import { toast } from "../toastStore.svelte.js";
  import { drawScene, frameDims, hitTestNode } from "../draw.js";
  import { keypointLabels } from "../keypointLabels.svelte.js";
  import { keypointModels } from "../keypointModels.svelte.js";
  import { keybinds } from "../keybinds.svelte.js";
  import { framePass } from "../framePass.svelte.js";
  import { proofread } from "../proofreadSession.svelte.js";
  import HeatTimeline from "./HeatTimeline.svelte";

  let wrap = $state();
  let canvas = $state();
  let ctx = $state();
  let vpW = $state(0); // wrap size in CSS px
  let vpH = $state(0);
  let playing = $state(false);
  let timer = null;

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

  // (A) Keep the decoded frame image in sync with the current frame. Decoding is serialized
  // in the store (latest-wins reconciliation), so fast timeline scrubbing converges to the
  // current frame without overlapping/aborted decodes that would desync image vs. overlay.
  $effect(() => {
    void store.index;
    void store.videoModel;
    void store.rev;
    store.syncFrameImage();
  });

  // What is ACTUALLY on the canvas. `store.current` flips the instant you navigate; the decode lands
  // ~50-100 ms later, and drawing the new pose over the old picture is what made the skeleton look like
  // it arrived first. Everything that draws or computes canvas geometry reads this, so the overlay, the
  // hit-test and the zoom maths can never disagree about which frame they are talking about.
  const shown = $derived(store.shownItem ?? store.current);

  // (B) Draw image + overlay. The zoom/pan transform is applied *inside* the canvas
  // (not via CSS), so node markers and labels re-rasterize crisply at any zoom. Redraw
  // is one drawImage + a few shapes — cheap enough to run on every zoom/pan/edit frame.
  $effect(() => {
    // While the review modal is open it fully occludes this canvas, yet its in-modal node edits bump
    // store.rev/qc.rev ~60/s — redrawing this hidden canvas (+ rebuilding the QC ring/flag arrays and
    // their GMM caches) for nothing. Skip it; reading ui.reviewOpen makes the effect re-run + repaint
    // the moment review closes (same guard as the selection-sync effect below).
    if (ui.reviewOpen) return;
    void store.rev;
    void qc.rev;
    const selI = edit.selInstance;
    const selN = edit.selNode;
    const z = view.zoom;
    const px = view.panX;
    const py = view.panY;
    const W = vpW;
    const H = vpH;
    const item = shown;
    const sk = store.skeleton;
    if (!ctx || !W || !H) return;

    // Keypoints the user has labelled faulty in THIS frame (proofreading ground truth), as "inst:node".
    // MUST come after `item`/`sk` are declared — reading them above put this in the temporal dead zone
    // and the ReferenceError killed the whole draw effect (blank canvas: no image, no overlay).
    void keypointLabels.rev;
    const gtFaulty = keypointLabels.faultyKeySet(item?.fkey, item?.lf?.instances?.length ?? 0, sk?.nodeNames);

    // QC rings: red on the worst *geometric* node of flagged instances; amber on the
    // least-confident node of low-confidence instances. Both only when concerning, so normal
    // poses stay clean. *Nodes[instIdx] = nodeIdx to ring, or -1.
    let worstNodes = null;
    let worstEdges = null;
    let flaggedInstances = null;
    if (qc.hasResults && item) {
      const insts = item.lf?.instances ?? [];
      // red ring on the faulty node of any flagged instance — chirality's wrong-pair node,
      // the pose-split bridge node, or the GMM's leave-one-out node. Reacts live to the sliders.
      // When the flag is an EDGE (chirality pair / pose-split bridge / worst anomaly edge) we
      // highlight the edge instead and suppress that instance's ring.
      worstEdges = insts.map((_, i) => (qc.instanceFlagged(item, i) ? qc.faultyEdgeFor(item, i) : null));
      worstNodes = insts.map((_, i) => (qc.instanceFlagged(item, i) && !worstEdges[i] ? qc.faultyNodeFor(item, i) : -1));
      flaggedInstances = qc.frameFlaggedInstances(item); // bbox around each flagged instance
    }

    const cw = Math.round(W * dpr);
    const ch = Math.round(H * dpr);
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;

    const dims = frameDims(item, store.frameImage);
    const fitCss = Math.min(W / dims.w, H / dims.h); // CSS px per image px to fit
    const s = fitCss * z * dpr; // device px per image px
    const offX = (cw - dims.w * s) / 2 + px * dpr;
    const offY = (ch - dims.h * s) / 2 + py * dpr;
    xform = { s, offX, offY };

    const scale = 1 / (fitCss * z); // image px per CSS px — keeps overlay a constant screen size
    drawScene(ctx, store.frameImage, item, sk, {
      transform: { s, offX, offY },
      dims,
      scale,
      editing: true,
      selInstance: selI,
      selNode: selN,
      worstNodes,
      worstEdges,
      gtFaulty,
      flaggedInstances,
      overlay: view.showOverlay,
    });
  });

  // (C) "Zoom to faulty node" — the sidebar requests an image-space box; compute the zoom/pan
  // that frames it (with a little context) and apply it once.
  $effect(() => {
    const box = view.focusBox;
    if (!box || !vpW || !vpH) return;
    const dims = frameDims(shown, store.frameImage);
    const fitCss = Math.min(vpW / dims.w, vpH / dims.h);
    const margin = 36; // image px of context around the box
    const bw = box.w + 2 * margin;
    const bh = box.h + 2 * margin;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const fill = 0.6; // the box should fill ~60% of the viewport
    let z = Math.min((vpW * fill) / (bw * fitCss), (vpH * fill) / (bh * fitCss));
    z = Math.max(2.5, Math.min(6, z));
    view.applyFocus(z, fitCss * z * (dims.w / 2 - cx), fitCss * z * (dims.h / 2 - cy));
    view.clearFocus();
  });

  // Clear selection when navigating to another frame. (Yields while the QC-review popup is
  // open — it drives navigation and keeps the faulty node selected for correction.)
  $effect(() => {
    void store.index;
    if (ui.reviewOpen) return;
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

  /** Label (or un-label) one keypoint as faulty, then re-score the trained detectors so the queue
   *  re-ranks immediately — that live feedback is the point of labelling in-app. */
  function labelNode(instIdx, nodeIdx) {
    const it = store.current, nm = store.skeleton?.nodeNames?.[nodeIdx];
    if (!it?.fkey || !nm) return;
    keypointLabels.toggleAt(it.fkey, instIdx, nm);   // fkey is the numeric "videoIdx:frameIdx" everyone uses
    for (const sl of keypointModels.slots) sl.store.rescore();
  }

  function onPointerDown(e) {
    const lf = shown?.lf; // hit what is drawn, not what the index points at
    if (!lf) return;
    const { x, y, scale } = toImage(e);
    const hit = hitTestNode(lf, HIT_PX * scale)(x, y);

    // Ctrl / Cmd + click a placed node toggles its visibility (no select / drag).
    if (hit && (e.ctrlKey || e.metaKey)) {
      edit.select(hit.instIdx, hit.nodeIdx);
      edit.toggleVisible(hit.instIdx, hit.nodeIdx);
      e.preventDefault();
      return;
    }

    // PROOFREADING MODE: a plain click labels the keypoint. Drag/edit is suppressed so rapid labelling
    // can't nudge coordinates — the user is asserting ground truth, not editing the pose.
    if (hit && keypointLabels.proofreading) {
      edit.select(hit.instIdx, hit.nodeIdx);
      labelNode(hit.instIdx, hit.nodeIdx);
      e.preventDefault();
      return;
    }

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
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16; // lines → ~px
    else if (e.deltaMode === 2) dy *= 400; // pages → ~px
    dy = Math.max(-100, Math.min(100, dy)); // clamp so one fast event can't jump far
    zoomAtCursor(e, Math.exp(-dy * 0.0022)); // proportional (trackpad-safe) + a touch more responsive
  }

  // Zoom by `factor` keeping the image point under the cursor fixed (mirrors the draw transform).
  function zoomAtCursor(e, factor) {
    const rect = wrap.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(rect.width * dpr), ch = Math.round(rect.height * dpr);
    const dims = frameDims(shown, store.frameImage);
    const fitCss = Math.min(rect.width / dims.w, rect.height / dims.h);
    const z0 = view.zoom, z1 = view.clampZoom(z0 * factor);
    if (z1 === z0) return;
    const s0 = fitCss * z0 * dpr, s1 = fitCss * z1 * dpr;
    const curX = (e.clientX - rect.left) * dpr, curY = (e.clientY - rect.top) * dpr;
    const imgX = (curX - ((cw - dims.w * s0) / 2 + view.panX * dpr)) / s0;
    const imgY = (curY - ((ch - dims.h * s0) / 2 + view.panY * dpr)) / s0;
    const panX = (curX - imgX * s1 - (cw - dims.w * s1) / 2) / dpr;
    const panY = (curY - imgY * s1 - (ch - dims.h * s1) / 2) / dpr;
    view.applyFocus(z1, panX, panY);
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

  function seekFlagged(dir) {
    const i = qc.seekFlagged(store.index, dir);
    if (i >= 0) store.setIndex(i);
    else toast(qc.hasResults ? "No flagged frames" : "Run QC first to navigate flagged frames");
  }

  function onKey(e) {
    // PROOFREADING owns the keyboard while active: a pass is meant to run entirely on the home row, and
    // the viewer's global keys (n/p seek, space play, v visibility) would otherwise fight the loop.
    // Unbound keys still fall through to the normal handler below.
    if (keypointLabels.proofreading) {
      const a = keybinds.resolve(e);
      if (a) {
        e.preventDefault();
        // Two passes share the keymap: the frame queue in the proofreading window, and the model's
        // candidate queue. Routing here (rather than a second listener in the window) is what keeps a
        // keystroke from firing twice.
        (framePass.active ? framePass : proofread).dispatch(a);
        return;
      }
    } else if (framePass.active) {
      // The proofreading window can drive its queue with the mode OFF: navigating is not labelling.
      // Without this, pressing n while looking at that window fell through to the viewer's own frame
      // stepping — which walks the file numerically and makes the ranked queue look unsorted.
      const a = keybinds.resolve(e);
      if (a && framePass.isMove(a.id)) {
        e.preventDefault();
        framePass.dispatch(a);
        return;
      }
    }
    if (!keypointLabels.proofreading) {
      // Entering the mode must ALSO be keyless-reachable, or the first step still needs the cursor.
      const g = keybinds.resolveGlobal(e);
      if (g) {
        e.preventDefault();
        proofread.dispatch(g);
        return;
      }
    }
    if (ui.overlayOpen) return; // palette/help own the keyboard while up
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
    } else if (e.key === "h" || e.key === "H") {
      view.toggleOverlay();
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
    } else if (e.key === "n" || e.key === "N") {
      seekFlagged(e.shiftKey ? -1 : 1);
      e.preventDefault();
    } else if (e.key === "p" || e.key === "P") {
      seekFlagged(-1);
      e.preventDefault();
    } else if ((e.key === "f" || e.key === "F") && edit.selInstance >= 0 && edit.selNode >= 0) {
      labelNode(edit.selInstance, edit.selNode);   // works with or without proofreading mode
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

  // Zero-padded frame readout, instrument style: 0169/0266.
  const pad = (n) => String(n).padStart(String(store.frameCount).length, "0");

  // Expected / average instance count for the current frame's video (per-video, once QC has run).
  const countInfo = $derived.by(() => {
    void qc.rev;
    if (!qc.hasResults || !item) return null;
    const fq = qc.frameQC(item);
    return fq ? { expected: fq.expectedInstanceCount, avg: fq.avgInstanceCount } : null;
  });

  // HUD: current-frame QC verdict for the chip overlaid on the canvas.
  const hud = $derived.by(() => {
    void qc.rev;
    if (!qc.hasResults || !item) return null;
    const s = qc.frameScore(item);
    const flagged = qc.frameFlagged(item);
    const issue = flagged ? qc.frameTopIssue(item)?.issue : null;
    return { score: s, flagged, issue };
  });
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
      oncontextmenu={(e) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); }}
    ></canvas>

    <div class="vf" aria-hidden="true"></div>

    <div class="hud">
      <span class="chip">
        <span class="frac"><b>{pad(store.index + 1)}</b><span class="dim">/{pad(store.frameCount)}</span></span>
        {#if store.videoCount > 1}<span class="dim" title="Which embedded video in this .pkg.slp">· vid {store.currentVideoIndex + 1}/{store.videoCount}</span>{/if}
        <span
          class="dim"
          class:miscount={countInfo && (item?.lf?.instances?.length ?? 0) !== countInfo.expected}
          title={countInfo ? `${item?.lf?.instances?.length ?? 0} placed · expected ${countInfo.expected}${countInfo.avg != null ? ` (avg ${countInfo.avg.toFixed(1)})` : ""} for ${store.videoCount > 1 ? "this video" : "this file"}` : "instances in this frame"}
        >· {item?.lf?.instances?.length ?? 0}{#if countInfo}/{countInfo.expected}{/if} INST</span>
      </span>
      {#if !view.showOverlay}<span class="chip ovl-off" title="Pose overlay hidden — press H to show">pose hidden · H</span>{/if}
      {#if hud}
        <span class="chip qc" class:flagged={hud.flagged}>
          {#if hud.score != null}<i class="heat" style:background={heatColor(hud.score)}></i>{/if}
          {#if hud.flagged}
            {hud.issue ?? "frame issue"}
          {:else}
            OK
          {/if}
        </span>
      {/if}
    </div>

  </div>

  <div class="controls">
    <button onclick={() => store.setIndex(0)} title="First frame">
      <svg viewBox="0 0 14 14"><path d="M3 2.5v9" stroke="currentColor" stroke-width="1.5" /><path d="M11.5 2.8v8.4L5 7z" fill="currentColor" /></svg>
    </button>
    <button onclick={() => store.prev()} title="Previous (←/A)">
      <svg viewBox="0 0 14 14"><path d="M10.5 2.8v8.4L4 7z" fill="currentColor" /></svg>
    </button>
    <button class="play" onclick={togglePlay} title="Play/Pause (Space)">
      {#if playing}
        <svg viewBox="0 0 14 14"><path d="M4 2.5h2.2v9H4zM7.8 2.5H10v9H7.8z" fill="currentColor" /></svg>
      {:else}
        <svg viewBox="0 0 14 14"><path d="M4 2.4v9.2L11.5 7z" fill="currentColor" /></svg>
      {/if}
    </button>
    <button onclick={() => store.next()} title="Next (→/D)">
      <svg viewBox="0 0 14 14"><path d="M3.5 2.8v8.4L10 7z" fill="currentColor" /></svg>
    </button>
    <button onclick={() => store.setIndex(store.frameCount - 1)} title="Last frame">
      <svg viewBox="0 0 14 14"><path d="M11 2.5v9" stroke="currentColor" stroke-width="1.5" /><path d="M2.5 2.8v8.4L9 7z" fill="currentColor" /></svg>
    </button>

    <HeatTimeline />

    <div class="counter">
      <strong>{pad(store.index + 1)}</strong><span class="of">/{store.frameCount}</span>
      {#if item}<span class="fidx">IDX {item.frameIdx}</span>{/if}
    </div>

    <span class="div"></span>

    <div class="zoomctl">
      <button onclick={() => view.zoomOut()} disabled={view.zoom <= 1} title="Zoom out (−)">−</button>
      <span class="pct">{view.zoomPct}%</span>
      <button onclick={() => view.zoomIn()} title="Zoom in (+)">＋</button>
      <button onclick={() => view.reset()} disabled={view.zoom === 1 && view.panX === 0 && view.panY === 0} title="Reset view (0)">⤢</button>
    </div>
  </div>
</section>

<style>
  .viewer {
    flex: 1; /* fill the row */
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
  }
  .canvas-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    /* the footage well sits a step darker than the chrome */
    background:
      repeating-conic-gradient(#0c0e11 0% 25%, #090b0d 0% 50%) 50% / 22px 22px;
    overflow: hidden;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none; /* pointer events drive editing/pan, not scroll/zoom */
  }
  /* viewfinder corner brackets — each corner is two 1px strokes */
  .vf {
    position: absolute;
    inset: 10px;
    pointer-events: none;
    z-index: 2;
    --vfc: rgba(232, 236, 239, 0.28);
    background:
      linear-gradient(var(--vfc), var(--vfc)) 0 0 / 16px 1px,
      linear-gradient(var(--vfc), var(--vfc)) 0 0 / 1px 16px,
      linear-gradient(var(--vfc), var(--vfc)) 100% 0 / 16px 1px,
      linear-gradient(var(--vfc), var(--vfc)) 100% 0 / 1px 16px,
      linear-gradient(var(--vfc), var(--vfc)) 0 100% / 16px 1px,
      linear-gradient(var(--vfc), var(--vfc)) 0 100% / 1px 16px,
      linear-gradient(var(--vfc), var(--vfc)) 100% 100% / 16px 1px,
      linear-gradient(var(--vfc), var(--vfc)) 100% 100% / 1px 16px;
    background-repeat: no-repeat;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.45rem 0.75rem;
    background: var(--surface);
    border-top: 1px solid var(--border);
  }
  .controls button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    color: var(--muted);
    border: none;
    border-radius: var(--r-xs);
    width: 1.9rem;
    height: 1.9rem;
    cursor: pointer;
    line-height: 1;
    transition: background 0.12s, color 0.12s;
  }
  .controls button svg {
    width: 13px;
    height: 13px;
  }
  .controls button:hover {
    background: rgba(255, 255, 255, 0.05);
    color: var(--text);
  }
  .controls button.play {
    background: var(--accent);
    color: #04181d;
    width: 2.4rem;
  }
  .controls button.play:hover {
    filter: brightness(1.1);
    color: #04181d;
  }
  .controls .div {
    width: 1px;
    height: 1.1rem;
    background: var(--border);
    margin: 0 0.3rem;
    flex: none;
  }
  .zoomctl {
    display: flex;
    align-items: center;
    gap: 0.05rem;
  }
  .zoomctl button {
    width: 1.7rem;
    height: 1.7rem;
    font-size: 0.85rem;
  }
  .zoomctl button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .zoomctl .pct {
    font-size: 0.68rem;
    color: var(--muted);
    min-width: 2.6rem;
    text-align: center;
  }
  .hud {
    position: absolute;
    top: 1.1rem;
    left: 1.1rem;
    display: flex;
    gap: 0.35rem;
    pointer-events: none;
    z-index: 3;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    /* No backdrop-filter: the HUD chips sit over the canvas and are always visible, so a blur would
       re-rasterize the backdrop on every redraw (drag/pan/zoom/nav). The 90%-opaque fill reads fine. */
    background: rgba(11, 13, 15, 0.9);
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    padding: 0.24rem 0.6rem;
    font-size: 0.7rem;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  /* keep the frame fraction tight as one unit; the chip gap only separates it
     from the instance count, so it reads "007/266 · 3 INST", not "007 /266". */
  .frac {
    display: inline-flex;
    align-items: baseline;
  }
  .chip b {
    color: var(--text);
    font-size: 0.76rem;
    font-weight: 700;
  }
  .chip .dim {
    color: var(--dim);
  }
  .chip.qc {
    color: #9fd3ac;
  }
  .chip.qc.flagged {
    color: var(--warn);
    border-color: rgba(243, 195, 78, 0.35);
  }
  .chip .heat {
    width: 7px;
    height: 7px;
    flex: none;
  }
  .counter {
    color: var(--dim);
    font-size: 0.78rem;
    white-space: nowrap;
    letter-spacing: 0.03em;
  }
  .counter strong {
    color: var(--text);
    font-size: 0.86rem;
    font-weight: 700;
  }
  .counter .of {
    color: var(--dim);
  }
  .fidx {
    margin-left: 0.6rem;
    color: var(--dim);
    font-size: 0.66rem;
    letter-spacing: 0.1em;
  }
  .ovl-off {
    color: var(--accent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .chip .miscount {
    color: #fca5a5; /* placed instance count != expected for this video */
    font-weight: 600;
  }
</style>
