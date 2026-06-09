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

function colorFor(instance, fallbackIdx) {
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
  if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) {
    ctx.drawImage(image, 0, 0);
  } else if (typeof ImageData !== "undefined" && image instanceof ImageData) {
    ctx.putImageData(image, 0, 0);
  } else if (image) {
    // HTMLCanvasElement / HTMLImageElement
    try {
      ctx.drawImage(image, 0, 0);
    } catch {
      /* not drawable */
    }
  }
}

function drawPlaceholder(ctx, item) {
  const { width, height } = ctx.canvas;
  ctx.fillStyle = "#0e1218";
  ctx.fillRect(0, 0, width, height);
  // subtle grid so panning/zoom is visible even without pixels
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.font = "16px system-ui, sans-serif";
  ctx.fillText(
    `frame ${item?.frameIdx ?? "?"} — no image pixels (upload the video to see frames)`,
    16,
    28,
  );
}

function drawSkeleton(ctx, lf, skeleton) {
  if (!lf || !skeleton) return;
  const edges = skeleton.edges ?? [];
  const instances = lf.instances ?? [];

  instances.forEach((instance, idx) => {
    const color = colorFor(instance, idx);
    const points = instance.points ?? [];

    // edges
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    for (const edge of edges) {
      const si = skeleton.index(edge.source?.name ?? edge.source);
      const di = skeleton.index(edge.destination?.name ?? edge.destination);
      const s = points[si];
      const d = points[di];
      if (!s || !d || !s.visible || !d.visible) continue;
      if (Number.isNaN(s.xy?.[0]) || Number.isNaN(d.xy?.[0])) continue;
      ctx.beginPath();
      ctx.moveTo(s.xy[0], s.xy[1]);
      ctx.lineTo(d.xy[0], d.xy[1]);
      ctx.stroke();
    }

    // nodes
    ctx.fillStyle = color;
    for (const p of points) {
      if (!p?.visible || Number.isNaN(p.xy?.[0])) continue;
      ctx.beginPath();
      ctx.arc(p.xy[0], p.xy[1], 4, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

// Main entry: draw the (optional) frame image then the pose overlay.
export function drawScene(ctx, image, item, skeleton) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (image) blit(ctx, image);
  else drawPlaceholder(ctx, item);
  drawSkeleton(ctx, item?.lf, skeleton);
}
