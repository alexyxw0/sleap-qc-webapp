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
  panBy(dx, dy) {
    this.panX += dx;
    this.panY += dy;
  }
  reset() {
    this.zoom = MIN;
    this.panX = 0;
    this.panY = 0;
  }
}

export const view = new ViewStore();
