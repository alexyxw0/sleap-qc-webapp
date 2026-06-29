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

// Desired internal canvas resolution for a navigable frame.
export function frameDims(item, image) {
  const shape = item?.video?.shape; // [nFrames, height, width, channels]
  if (Array.isArray(shape) && shape.length >= 3 && shape[1] && shape[2]) {
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
function drawPlaceholder(ctx, item, dims = {}, scale = 1) {
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
  ctx.fillText(
    `frame ${item?.frameIdx ?? "?"} — no image pixels (upload the video to see frames)`,
    14 * scale,
    24 * scale,
  );
}

const placed = (p) => p && !Number.isNaN(p.xy?.[0]) && p.xy?.[0] != null;

function drawSkeleton(ctx, lf, skeleton, sel = {}) {
  if (!lf || !skeleton) return;
  const edges = skeleton.edges ?? [];
  const instances = lf.instances ?? [];
  const names = skeleton.nodeNames ?? [];
  const { editing = false, selInstance = -1, selNode = -1, scale = 1, worstNodes = null, flaggedInstances = null, hiddenAlpha = 0.28 } = sel;

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
  const label = (name, px, py, alpha, color) => {
    if (!name) return;
    const m = ctx.getTransform();
    const k = m.a; // device px per image unit
    const dpr = s * k; // device px per CSS px
    const dx = Math.round(m.a * px + m.e + labelOff * k);
    const dy = Math.round(m.d * py + m.f - labelOff * k);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); // native device pixels -> crisp glyphs
    ctx.globalAlpha = alpha;
    ctx.font = `600 ${Math.round(11 * dpr)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.6 * dpr; // thin, soft outline
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.strokeText(name, dx, dy);
    ctx.fillStyle = color ?? "#eaf0f7";
    ctx.fillText(name, dx, dy);
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

    // nodes + labels — a hidden node renders only while its instance is selected (then faint, so it
    // can still be found and dragged); otherwise it isn't drawn at all.
    points.forEach((p, ni) => {
      if (!placed(p)) return;
      if (!p.visible && !isSel) return; // hidden node: shown only when its instance is selected
      const [px, py] = p.xy;
      const focused = isSel && ni === selNode;
      const nodeAlpha = p.visible ? 1 : focused ? Math.max(0.6, hiddenAlpha) : hiddenAlpha;

      ctx.globalAlpha = nodeAlpha;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (editing && isSel) {
        ctx.lineWidth = 1.5 * s;
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.stroke();
      }
      // QC: a flagged instance's faulty node gets a DASHED red ring — same color / dash / weight as
      // the flagged-instance bounding box, so the node and its box read as one consistent treatment.
      if (worstNodes && worstNodes[idx] === ni) {
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = "#ff2d55";
        ctx.lineWidth = 1.5 * s;
        ctx.setLineDash([5 * s, 4 * s]);
        ctx.beginPath();
        ctx.arc(px, py, r + 5 * s, 0, Math.PI * 2);
        ctx.stroke();
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

  // Focused node's label, opaque and on top of everything.
  if (selInstance >= 0 && selNode >= 0) {
    const p = instances[selInstance]?.points?.[selNode];
    if (placed(p)) label(names[selNode], p.xy[0], p.xy[1], 1, p.visible ? LABEL_VISIBLE : LABEL_HIDDEN);
  }

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

// Main entry: clear, apply the view transform (zoom/pan baked into the canvas so the
// overlay re-rasterizes crisply), draw the frame image, then the pose overlay.
export function drawScene(ctx, image, item, skeleton, opts = {}) {
  const { transform, dims, scale = 1, overlay = true } = opts;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (transform) {
    ctx.setTransform(transform.s, 0, 0, transform.s, transform.offX, transform.offY);
  }
  if (image) {
    ctx.imageSmoothingEnabled = true;
    blit(ctx, image);
  } else {
    drawPlaceholder(ctx, item, dims, scale);
  }
  if (overlay) drawSkeleton(ctx, item?.lf, skeleton, opts);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
