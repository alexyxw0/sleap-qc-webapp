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

  // Sidebar panels the user has "docked" as tabs (in order). Once any panel is docked the rail
  // becomes a tabbed interface: a "Main" tab holds everything still inline, plus one tab per
  // docked panel — only the active tab's content shows. In-session for now.
  sidebarDocked = $state([]);
  sidebarActiveTab = $state("__main__");

  static RAIL_MIN = 280;
  static RAIL_MAX = 440;
  static MAIN = "__main__";

  isDocked(id) {
    return this.sidebarDocked.includes(id);
  }
  // The Main tab is showing (or there are no tabs yet, so everything is inline = Main).
  get mainActive() {
    return this.sidebarDocked.length === 0 || this.sidebarActiveTab === UIStore.MAIN;
  }
  // Hide a panel when tabs exist and it isn't the current view: docked panels show only on their
  // own tab; inline (non-docked) panels show only on the Main tab.
  panelHidden(id) {
    if (this.sidebarDocked.length === 0) return false;
    return this.isDocked(id) ? this.sidebarActiveTab !== id : !this.mainActive;
  }
  dockPanel(id) {
    if (!this.sidebarDocked.includes(id)) this.sidebarDocked = [...this.sidebarDocked, id];
    this.sidebarActiveTab = id; // dragging a panel out opens its freshly-created tab
  }
  undockPanel(id) {
    this.sidebarDocked = this.sidebarDocked.filter((x) => x !== id);
    if (this.sidebarActiveTab === id) this.sidebarActiveTab = UIStore.MAIN; // its content returns to Main
  }
  activateSidebarTab(id) {
    this.sidebarActiveTab = id;
  }
  activateMain() {
    this.sidebarActiveTab = UIStore.MAIN;
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
