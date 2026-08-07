// uiStore.svelte.js
//
// Cross-component UI chrome state (overlays). Kept out of the domain stores so the
// command palette / help overlay can be toggled from anywhere (toolbar, keyboard)
// and the Viewer's global key handler can yield while an overlay is up.

class UIStore {
  paletteOpen = $state(false);
  helpOpen = $state(false);
  reviewOpen = $state(false); // QC-review correction popup

  // panel sizes (resizable, clamped)
  railW = $state(312);

  // ---- RIGHT RAIL -----------------------------------------------------------------------------------
  // The rail is a HOVER-REVEALED drawer, not a permanent column: the viewer gets the whole window and
  // the controls come to you. It slides in when the pointer reaches the right edge (or the handle) and
  // slides out when the pointer leaves — unless PINNED, which is essential once you're dragging a
  // slider or typing, where an auto-hide would be maddening.
  //
  // Inside it, large horizontal blocks stacked vertically act as VERTICAL TABS: clicking one renders its
  // content in the single slate below, and only ONE can be shown at a time. They are not accordions —
  // expanding several in place is what made the old rail a scroll-forever wall. Launch state is `null`:
  // the tabs are there, the slate is blank.
  railHover = $state(false);  // pointer is over the edge zone or the drawer
  railPinned = $state(false); // stays open regardless of hover
  activeBlock = $state(null); // id of the ONE block whose content fills the slate; null = blank

  static BLOCKS = [
    // Grouped by WHAT YOU'RE DOING, not by which store owns the data:
    //   frame      — everything about the thing on screen right now (nav, verdict, file, skeleton, instances)
    //   checks     — coordinate-only detectors: they score the instant QC runs
    //   appearance — detectors that need something COMPUTED first (embeddings, or an uploaded bundle),
    //                plus the trained per-keypoint models and proofreading. Separating them stops the
    //                checks list from looking uniformly cheap when half of it needs a compute pass.
    { id: "frame", title: "Frame", hint: "Navigation, the frame grid, this frame's QC verdict, its instances, plus dataset totals and the skeleton" },
    { id: "checks", title: "Detection checks", hint: "Geometric, statistical and frame-level detectors — scored straight from coordinates" },
    { id: "appearance", title: "Appearance", hint: "Embedding-based outliers and the trained per-keypoint models — these need a compute pass or an uploaded bundle" },
    { id: "analysis", title: "Analysis", hint: "What the run found: detector overlap, agreement with a human review, and CSV export" },
  ];

  // setRailW clamps against these. They were lost in the tabs overhaul, which left the drag handle
  // computing Math.max(undefined, …) = NaN — both width declarations then dropped and the docked panel
  // collapsed to its content width, permanently, since railW is never re-assigned or persisted.
  static RAIL_MIN = 280;
  static RAIL_MAX = 440;

  get railOpen() { return this.railPinned || this.railHover; }
  setRailHover(v) { this.railHover = !!v; }
  togglePin() { this.railPinned = !this.railPinned; }

  isBlockOpen(id) { return this.activeBlock === id; }
  /** Click a tab: show it, or clear back to the blank slate if it was already showing. */
  toggleBlock(id) { this.activeBlock = this.activeBlock === id ? null : id; }
  collapseAll() { this.activeBlock = null; }

  setRailW(w) {
    this.railW = Math.round(Math.max(UIStore.RAIL_MIN, Math.min(UIStore.RAIL_MAX, w)));
  }

  get overlayOpen() {
    return this.paletteOpen || this.helpOpen || this.reviewOpen;
  }

  togglePalette() {
    this.helpOpen = false;
    this.paletteOpen = !this.paletteOpen;
  }
  toggleHelp() {
    this.paletteOpen = false;
    this.helpOpen = !this.helpOpen;
  }
  toggleReview() {
    this.paletteOpen = false;
    this.helpOpen = false;
    this.reviewOpen = !this.reviewOpen;
  }
  closeAll() {
    this.paletteOpen = false;
    this.helpOpen = false;
    this.reviewOpen = false;
    this.collapseAll();   // a new file starts minimal, same as launch
  }
}

export const ui = new UIStore();
