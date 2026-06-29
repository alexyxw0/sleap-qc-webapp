// viewStore.svelte.js
//
// A reusable view transform (zoom + pan) for the canvas. Kept generic so other
// features (minimap, fit-to-instance, programmatic focus, etc.) can drive it later.
//
// The transform is applied as a CSS `transform` on the canvas element, so the drawing
// code is untouched and pointer mapping stays correct via getBoundingClientRect.

const MIN = 1; // 1 = fit (don't zoom out past the fitted image)
const MAX = 12;
const STEP = 1.25;

class ViewStore {
  zoom = $state(1);
  panX = $state(0); // screen px
  panY = $state(0);
  showOverlay = $state(true); // pose overlay (skeleton + nodes + labels) drawn over the frame; toggle with H

  // A pending "zoom to this image-space box" request. The Viewer (which knows the viewport +
  // fit scale) consumes it, computes the zoom/pan to frame the box, and clears it.
  focusBox = $state.raw(null); // { x, y, w, h } in image coordinates

  /** Ask the Viewer to zoom in on an image-space box (e.g. a faulty node / node-pair). */
  requestFocus(box) {
    this.focusBox = box;
  }
  clearFocus() {
    this.focusBox = null;
  }
  /** Apply a Viewer-computed focus (zoom + screen pan), clamped. */
  applyFocus(zoom, panX, panY) {
    this.zoom = Math.min(MAX, Math.max(MIN, zoom));
    this.panX = panX;
    this.panY = panY;
  }

  get transform() {
    return `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
  }
  get zoomPct() {
    return Math.round(this.zoom * 100);
  }

  setZoom(z) {
    const nz = Math.min(MAX, Math.max(MIN, z));
    this.zoom = nz;
    if (nz === MIN) {
      this.panX = 0;
      this.panY = 0; // snap back to centered fit
    }
  }
  zoomIn() {
    this.setZoom(this.zoom * STEP);
  }
  zoomOut() {
    this.setZoom(this.zoom / STEP);
  }
  zoomBy(factor) {
    this.setZoom(this.zoom * factor);
  }
  toggleOverlay() {
    this.showOverlay = !this.showOverlay;
  }
  reset() {
    this.zoom = MIN;
    this.panX = 0;
    this.panY = 0;
  }
}

export const view = new ViewStore();
