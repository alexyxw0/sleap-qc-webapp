// draw.js — imperative canvas rendering of a frame + pose overlay.
//
// One canvas, one synchronous draw call. Svelte only decides *when* to call this
// (see Viewer.svelte's $effect). Coordinates are in image space; the canvas's
// internal resolution is set to the image/video resolution so poses map 1:1.

const PALETTE = [
  "#f3c56c", "#7dd3fc", "#a7f3d0", "#fda4af", "#c4b5fd",
  "#fca5a5", "#93c5fd", "#86efac", "#f0abfc", "#fdba74",
];

const trackColors = new Map();

// Instance/track color (shared, stable per track). Exported so overlays (e.g. the QC-review
// popup) can tint UI to match a node's on-canvas color. The map is populated as instances are
// drawn; by the time an overlay reads it the Viewer has long since drawn the tracks.
export function colorFor(instance, fallbackIdx) {
  const track = instance?.track;
  const key = track?.name ?? track ?? null;
  if (key != null) {
    if (!trackColors.has(key)) {
      trackColors.set(key, PALETTE[trackColors.size % PALETTE.length]);
    }
    return trackColors.get(key);
  }
  return PALETTE[fallbackIdx % PALETTE.length];
}

/** Does the FILE state this frame's size, without needing the pixels decoded? */
export function hasKnownDims(item) {
  const shape = item?.video?.shape; // [nFrames, height, width, channels]
  return Array.isArray(shape) && shape.length >= 3 && !!shape[1] && !!shape[2];
}

// Desired internal canvas resolution for a navigable frame.
export function frameDims(item, image) {
  const shape = item?.video?.shape; // [nFrames, height, width, channels]
  if (hasKnownDims(item)) {
    return { w: shape[2], h: shape[1] };
  }
  if (image && image.width && image.height) {
    return { w: image.width, h: image.height };
  }
  return { w: 1024, h: 768 };
}

function blit(ctx, image) {
  // image is normalized to an ImageBitmap (or HTMLCanvas/Image) by the store, so it
  // can be drawn under the active transform. ImageData (which ignores transforms) is
  // converted upstream.
  if (image) {
    try {
      ctx.drawImage(image, 0, 0);
    } catch {
      /* not drawable */
    }
  }
}

// Drawn in image coordinates (the caller has applied the view transform). `dims` and
// `scale` (image px per screen px) keep the grid/text a sensible on-screen size.
function drawPlaceholder(ctx, item, dims = {}, scale = 1, decoding = false) {
  const w = dims.w ?? 1024;
  const h = dims.h ?? 768;
  ctx.fillStyle = "#0e1218";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = scale;
  const step = 64 * scale;
  for (let x = 0; x < w; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.font = `${14 * scale}px system-ui, sans-serif`;
  // "no image pixels (upload the video)" is a diagnosis, and it is the WRONG one while a decode is in
  // flight — the pixels are on their way. Say what is actually happening instead.
  ctx.fillText(
    decoding
      ? `frame ${item?.frameIdx ?? "?"} — decoding…`
      : `frame ${item?.frameIdx ?? "?"} — no image pixels (upload the video to see frames)`,
    14 * scale,
    24 * scale,
  );
}

// A keypoint the USER has labelled faulty. Filled + haloed rather than outlined, which is what keeps it
// apart from the detector's DASHED ring below even though both are red: a solid red dot is a fact you
// recorded, a dashed ring is a guess the model made.
const GT_FAULTY = "#ff3b30";

const placed = (p) => p && !Number.isNaN(p.xy?.[0]) && p.xy?.[0] != null;

function drawSkeleton(ctx, lf, skeleton, sel = {}) {
  if (!lf || !skeleton) return;
  const edges = skeleton.edges ?? [];
  const instances = lf.instances ?? [];
  const names = skeleton.nodeNames ?? [];
  const { editing = false, selInstance = -1, selNode = -1, scale = 1, worstNodes = null, worstEdges = null,
    worstAngles = null, worstNodeVariants = null, flaggedInstances = null, gtFaulty = null, hiddenAlpha = 0.28 } = sel;

  // Sizes are specified in on-screen pixels and converted to image-space via `scale`
  // (image px per screen px), so the overlay + labels look consistent at any video
  // resolution.
  const s = scale > 0 ? scale : 1;
  const r = (editing ? 5.5 : 4) * s;
  const labelOff = r + 3 * s;

  // Node-name labels colored by visibility (green = visible, gray = invisible). Drawn at NATIVE
  // device resolution (the transform is reset per label) so the text stays crisp at any zoom —
  // bold weight + a thin soft outline instead of a heavy black border.
  const LABEL_VISIBLE = "#39e87a"; // strong green
  const LABEL_HIDDEN = "#b6bfca"; // legible gray
  // The canvas transform + dpr are constant for the whole call (drawScene sets them once before this),
  // so the label geometry + font are loop-invariant. Compute them ONCE and just queue each label's
  // position/color; flushLabels() below draws them all in a single native-resolution pass. (Was:
  // getTransform + font-string rebuild + save/setTransform/restore PER label — run per visible node on
  // every redraw, i.e. ~60/s while dragging a node.)
  const m = ctx.getTransform();
  const k = m.a; // device px per image unit
  const dpr = s * k; // device px per CSS px
  const labelFont = `600 ${Math.round(11 * dpr)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const labelQueue = []; // { name, px, py, alpha, color }
  const label = (name, px, py, alpha, color) => { if (name) labelQueue.push({ name, px, py, alpha, color }); };
  const flushLabels = () => {
    if (!labelQueue.length) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); // native device pixels -> crisp glyphs
    ctx.font = labelFont;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.6 * dpr; // thin, soft outline
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    for (const { name, px, py, alpha, color } of labelQueue) {
      const dx = Math.round(m.a * px + m.e + labelOff * k);
      const dy = Math.round(m.d * py + m.f - labelOff * k);
      ctx.globalAlpha = alpha;
      ctx.strokeText(name, dx, dy);
      ctx.fillStyle = color ?? "#eaf0f7";
      ctx.fillText(name, dx, dy);
    }
    ctx.restore();
  };

  instances.forEach((instance, idx) => {
    const color = colorFor(instance, idx);
    const points = instance.points ?? [];
    const isSel = idx === selInstance;

    // QC: a dashed red bounding box around a flagged instance, so flagged frames read at a glance.
    if (flaggedInstances?.[idx]) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of points) {
        if (!placed(p)) continue;
        if (p.xy[0] < minX) minX = p.xy[0];
        if (p.xy[1] < minY) minY = p.xy[1];
        if (p.xy[0] > maxX) maxX = p.xy[0];
        if (p.xy[1] > maxY) maxY = p.xy[1];
      }
      if (Number.isFinite(minX)) {
        const pad = r + 5 * s;
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = "#ff2d55";
        ctx.lineWidth = 1.5 * s;
        ctx.setLineDash([5 * s, 4 * s]);
        ctx.strokeRect(minX - pad, minY - pad, maxX - minX + 2 * pad, maxY - minY + 2 * pad);
        ctx.restore();
      }
    }

    // edges — between two *placed* nodes. An edge touching a hidden node is drawn only while this
    // instance is selected, and then THIN + faint, to signal "this node isn't visible".
    ctx.strokeStyle = color;
    for (const edge of edges) {
      const a = points[skeleton.index(edge.source?.name ?? edge.source)];
      const b = points[skeleton.index(edge.destination?.name ?? edge.destination)];
      if (!placed(a) || !placed(b)) continue;
      const hidden = !a.visible || !b.visible;
      if (hidden && !isSel) continue;
      ctx.globalAlpha = hidden ? 0.22 : 1;
      ctx.lineWidth = (hidden ? 1 : isSel ? 3 : 2) * s;
      ctx.beginPath();
      ctx.moveTo(a.xy[0], a.xy[1]);
      ctx.lineTo(b.xy[0], b.xy[1]);
      ctx.stroke();
    }

    // QC: when the flag is fundamentally an EDGE (chirality L/R pair, pose-split bridge, worst
    // anomaly edge), highlight that edge in place of the ring. A dark casing UNDER the red dashes
    // keeps them legible where they overlay a same-warm-colored bone; drawn before the nodes so the
    // endpoints stay clean.
    // QC: when the flag is an ANGLE — a deviant joint, or a deviant bend along the body chain — the
    // culprit is neither a node nor an edge. Highlight both arms and arc the angle between them, so
    // "which bend" is answered on the canvas instead of in the sidebar text.
    const ang = worstAngles?.[idx];
    if (ang) {
      const [pv, pa, pb] = [points[ang[0]], points[ang[1]], points[ang[2]]];
      if (placed(pv) && placed(pa) && placed(pb)) {
        ctx.save();
        ctx.lineCap = "round";
        for (const pass of [{ c: "#0b0e13", w: 5, dash: [] }, { c: "#ff2d55", w: 2.2, dash: [6, 4] }]) {
          ctx.beginPath();
          ctx.moveTo(pa.xy[0], pa.xy[1]);
          ctx.lineTo(pv.xy[0], pv.xy[1]);
          ctx.lineTo(pb.xy[0], pb.xy[1]);
          ctx.globalAlpha = pass.c === "#0b0e13" ? 0.85 : 1;
          ctx.strokeStyle = pass.c;
          ctx.lineWidth = pass.w * s;
          ctx.setLineDash(pass.dash.map((d) => d * s));
          ctx.stroke();
        }
        // the arc itself, at a radius that clears the joint's own dot
        const a0 = Math.atan2(pa.xy[1] - pv.xy[1], pa.xy[0] - pv.xy[0]);
        const a1 = Math.atan2(pb.xy[1] - pv.xy[1], pb.xy[0] - pv.xy[0]);
        let d = a1 - a0;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        ctx.beginPath();
        ctx.setLineDash([]);
        ctx.globalAlpha = 0.95;
        ctx.lineWidth = 1.6 * s;
        ctx.strokeStyle = "#ff2d55";
        ctx.arc(pv.xy[0], pv.xy[1], 13 * s, a0, a0 + d, d < 0);
        ctx.stroke();
        ctx.restore();
      }
    }
    if (worstEdges?.[idx]) {
      const pa = points[worstEdges[idx][0]], pb = points[worstEdges[idx][1]];
      if (placed(pa) && placed(pb)) {
        ctx.save();
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(pa.xy[0], pa.xy[1]);
        ctx.lineTo(pb.xy[0], pb.xy[1]);
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = "#0b0e13"; // dark casing
        ctx.lineWidth = 5 * s;
        ctx.setLineDash([]);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#ff2d55"; // red dashes on top of the casing -> high contrast
        ctx.lineWidth = 3 * s;
        ctx.setLineDash([5 * s, 4 * s]);
        ctx.stroke();
        ctx.restore();
      }
    }

    // nodes + labels — a hidden node renders only while its instance is selected (then faint, so it
    // can still be found and dragged); otherwise it isn't drawn at all.
    points.forEach((p, ni) => {
      if (!placed(p)) return;
      const gtBad = !!gtFaulty?.has(`${idx}:${ni}`);
      // A label YOU made outranks the hidden-node rule: an invisible keypoint you marked faulty was
      // either not drawn at all, or drawn at 28% — the one mark that must never be missable.
      if (!p.visible && !isSel && !gtBad) return;
      const [px, py] = p.xy;
      const focused = isSel && ni === selNode;
      const nodeAlpha = p.visible ? 1 : focused ? Math.max(0.6, hiddenAlpha) : hiddenAlpha;
      const markAlpha = gtBad ? 1 : nodeAlpha;

      // PROOFREADING: a keypoint you labelled faulty is unmistakable — a soft red halo under it, the dot
      // itself shaded red instead of its track colour, and a solid red ring. Drawn as three layers so it
      // still reads over a bright frame, a dark frame, or a tangle of overlapping bones.
      if (gtBad) {
        ctx.save();
        ctx.globalAlpha = markAlpha * 0.3;
        ctx.beginPath();
        ctx.arc(px, py, r + 7.5 * s, 0, Math.PI * 2);
        ctx.fillStyle = GT_FAULTY;
        ctx.fill();
        ctx.restore();
      }

      ctx.globalAlpha = markAlpha;
      ctx.beginPath();
      ctx.arc(px, py, gtBad ? r * 1.2 : r, 0, Math.PI * 2);
      ctx.fillStyle = gtBad ? GT_FAULTY : color;
      ctx.fill();
      if (editing && isSel) {
        ctx.lineWidth = 1.5 * s;
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.stroke();
      }
      if (gtBad) {
        ctx.save();
        ctx.globalAlpha = markAlpha;
        ctx.strokeStyle = GT_FAULTY;
        ctx.lineWidth = 2.4 * s;
        ctx.beginPath();
        ctx.arc(px, py, r + 4 * s, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      // QC: a flagged instance's faulty node gets a DASHED red ring — same color / dash / weight as
      // the flagged-instance bounding box, so the node and its box read as one consistent treatment.
      if (worstNodes && worstNodes[idx] === ni) {
        const variant = worstNodeVariants?.[idx] ?? null;
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = "#ff2d55";
        ctx.lineWidth = 1.5 * s;
        ctx.setLineDash([5 * s, 4 * s]);
        ctx.beginPath();
        ctx.arc(px, py, r + 5 * s, 0, Math.PI * 2);
        ctx.stroke();
        // The visibility check flags a node two opposite ways, so the ring says which. "absent" —
        // expected here and not labelled — gets a hollow cross-hair, the mark for something that
        // should be here; "present" — labelled where it almost never co-occurs — gets a filled
        // centre dot, the mark for something that should not.
        if (variant === "absent") {
          ctx.setLineDash([]);
          ctx.lineWidth = 1.4 * s;
          const k = r + 2.5 * s;
          ctx.beginPath();
          ctx.moveTo(px - k, py); ctx.lineTo(px + k, py);
          ctx.moveTo(px, py - k); ctx.lineTo(px, py + k);
          ctx.stroke();
        } else if (variant === "present") {
          ctx.setLineDash([]);
          ctx.fillStyle = "#ff2d55";
          ctx.beginPath();
          ctx.arc(px, py, 2.2 * s, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      if (focused) {
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(px, py, r + 3.5 * s, 0, Math.PI * 2);
        ctx.lineWidth = 2 * s;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
      }

      // Default label opacity: half-transparent (so overlapping labels don't fight),
      // fainter still when the node is hidden. The focused node's label is drawn on
      // top fully opaque in a final pass below.
      // label colored by visibility (green = visible, gray = invisible), legible even when the
      // instance isn't selected so invisible nodes read at a glance
      if (!focused) label(names[ni], px, py, p.visible ? 0.95 : 0.85, p.visible ? LABEL_VISIBLE : LABEL_HIDDEN);
    });
  });

  // Focused node's label, opaque and on top of everything — queued LAST so it draws over the rest.
  if (selInstance >= 0 && selNode >= 0) {
    const p = instances[selInstance]?.points?.[selNode];
    if (placed(p)) label(names[selNode], p.xy[0], p.xy[1], 1, p.visible ? LABEL_VISIBLE : LABEL_HIDDEN);
  }

  flushLabels(); // one native-resolution pass for every queued label
  ctx.globalAlpha = 1;
}

// Nearest *placed* node to (x,y) within `radius` image-px, scanning topmost instances
// first so overlapping points resolve intuitively. Hidden-but-placed nodes are included
// (so they can still be grabbed); only unplaced (NaN) points are skipped.
// Returns {instIdx,nodeIdx,dist} | null.
export function hitTestNode(lf, radius) {
  return (x, y) => {
    const instances = lf?.instances ?? [];
    let best = null;
    for (let idx = instances.length - 1; idx >= 0; idx--) {
      const points = instances[idx].points ?? [];
      for (let ni = 0; ni < points.length; ni++) {
        const p = points[ni];
        if (!placed(p)) continue;
        const dx = p.xy[0] - x;
        const dy = p.xy[1] - y;
        const d = Math.hypot(dx, dy);
        if (d <= radius && (!best || d < best.dist)) best = { instIdx: idx, nodeIdx: ni, dist: d };
      }
    }
    return best;
  };
}

/**
 * Should the canvas keep the frame it is already showing rather than paint this one?
 *
 * YES while the pose and the picture describe different frames — repainting there would put the new
 * animal on top of the old photograph, and the swap should happen once, with both halves together.
 *
 * NO when the canvas has never been painted, which is the case this was missing. There was no previous
 * frame to hold, so holding one held NOTHING: the proofreader opened on its stage's own background —
 * a black rectangle — for the ~50-100 ms of the first decode, then the picture appeared. Painting the
 * pose over the placeholder immediately makes that read as loading rather than as broken.
 *
 * `paintedEl` is the canvas ELEMENT last painted, not a boolean: closing the proofreader destroys the
 * canvas and re-opening it makes a new, blank one, so "we have painted before" has to mean "we have
 * painted THIS canvas before".
 *
 * YES again when the frame's size is unknown until its pixels arrive: the early paint would have to
 * guess the dimensions, putting the pose at the wrong scale and jumping when the picture lands. A brief
 * hold beats a jump.
 */
export function shouldHoldPaint({ havePair, paintedEl, canvasEl, dimsKnown = true }) {
  if (havePair) return false;
  if (paintedEl != null && paintedEl === canvasEl) return true;
  return !dimsKnown;
}

// Main entry: clear, apply the view transform (zoom/pan baked into the canvas so the
// overlay re-rasterizes crisply), draw the frame image, then the pose overlay.
export function drawScene(ctx, image, item, skeleton, opts = {}) {
  const { transform, dims, scale = 1, overlay = true, decoding = false } = opts;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (transform) {
    ctx.setTransform(transform.s, 0, 0, transform.s, transform.offX, transform.offY);
  }
  if (image) {
    ctx.imageSmoothingEnabled = true;
    blit(ctx, image);
  } else {
    drawPlaceholder(ctx, item, dims, scale, decoding);
  }
  if (overlay) drawSkeleton(ctx, item?.lf, skeleton, opts);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
