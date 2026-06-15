// Small numeric helpers for the QC checks (porting NumPy idioms used by sleap.qc).
// A "pose" is number[][] of shape (nNodes, 2); invisible nodes are [NaN, NaN].

export const isVisible = (p) => p != null && !Number.isNaN(p[0]) && !Number.isNaN(p[1]);

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export const visibilityMask = (pose) => pose.map(isVisible);

export function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

export function std(xs) {
  if (!xs.length) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length); // population std (np.std)
}

// np.std with a floor (mirrors safe_std / np.maximum(std, 1e-6)).
export const safeStd = (xs, minVal = 1e-6) => Math.max(std(xs), minVal);
export const safeMean = (xs) => (xs.length ? mean(xs) : 0);

export const maxAbs = (xs) => (xs.length ? Math.max(...xs.map(Math.abs)) : 0);
export const meanAbs = (xs) => (xs.length ? mean(xs.map(Math.abs)) : 0);

// Visible points of a pose as [x,y][].
export const visiblePoints = (pose) => pose.filter(isVisible);

// Axis-aligned bbox [minX,minY,maxX,maxY] over visible points, or null if < `min` visible.
export function bbox(pose, min = 2) {
  const vis = visiblePoints(pose);
  if (vis.length < min) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of vis) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}
