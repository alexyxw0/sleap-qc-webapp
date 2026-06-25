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

  // Sidebar panels the user has "docked" as tabs (in order) + which tab is active. Dragging a
  // panel's grip onto the tab strip docks it; a tab's × restores it inline. In-session for now.
  sidebarDocked = $state([]);
  sidebarActiveTab = $state(null);

  static RAIL_MIN = 280;
  static RAIL_MAX = 440;

  isDocked(id) {
    return this.sidebarDocked.includes(id);
  }
  dockPanel(id) {
    if (!this.sidebarDocked.includes(id)) this.sidebarDocked = [...this.sidebarDocked, id];
    this.sidebarActiveTab = id;
  }
  undockPanel(id) {
    this.sidebarDocked = this.sidebarDocked.filter((x) => x !== id);
    if (this.sidebarActiveTab === id) this.sidebarActiveTab = this.sidebarDocked.at(-1) ?? null;
  }
  activateSidebarTab(id) {
    this.sidebarActiveTab = id;
  }

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
  }
}

export const ui = new UIStore();
