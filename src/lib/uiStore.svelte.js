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

  // Once any panel is docked the rail becomes a tabbed interface: a "Main" tab holds everything
  // still inline, plus one tab per docked group. A tab can hold MORE than one panel — dragging a
  // tab onto another merges their groups. Only the active tab's content shows. In-session for now.
  sidebarTabs = $state([]); // [{ id, panels: ["checks"] }, …] — each tab groups one+ panel ids
  activeTabId = $state("__main__");
  #tabSeq = 0;

  static RAIL_MIN = 280;
  static RAIL_MAX = 440;
  static MAIN = "__main__";

  isDocked(id) {
    return this.sidebarTabs.some((t) => t.panels.includes(id));
  }
  tabOf(id) {
    return this.sidebarTabs.find((t) => t.panels.includes(id));
  }
  // The Main tab is showing (or there are no tabs yet, so everything is inline = Main).
  get mainActive() {
    return this.sidebarTabs.length === 0 || this.activeTabId === UIStore.MAIN;
  }
  // Hide a panel when tabs exist and it isn't the current view: a docked panel shows only on its
  // own tab; an inline (non-docked) panel shows only on the Main tab.
  panelHidden(id) {
    if (this.sidebarTabs.length === 0) return false;
    const t = this.tabOf(id);
    return t ? this.activeTabId !== t.id : !this.mainActive;
  }
  dockPanel(id) {
    if (this.isDocked(id)) return;
    const tabId = ++this.#tabSeq;
    this.sidebarTabs = [...this.sidebarTabs, { id: tabId, panels: [id] }];
    this.activeTabId = tabId; // dragging a panel out opens its freshly-created tab
  }
  // Drag one tab onto another: fold the source's panels into the target, drop the source tab.
  mergeTabs(sourceId, targetId) {
    if (sourceId === targetId) return;
    const src = this.sidebarTabs.find((t) => t.id === sourceId);
    if (!src || !this.sidebarTabs.some((t) => t.id === targetId)) return;
    this.sidebarTabs = this.sidebarTabs
      .map((t) => (t.id === targetId ? { ...t, panels: [...t.panels, ...src.panels] } : t))
      .filter((t) => t.id !== sourceId);
    this.activeTabId = targetId;
  }
  // Restore a tab's panels to Main (the per-tab × / drop-on-Main).
  undockTab(tabId) {
    this.sidebarTabs = this.sidebarTabs.filter((t) => t.id !== tabId);
    if (this.activeTabId === tabId) this.activeTabId = UIStore.MAIN;
  }
  // Merge every tab back into Main at once.
  undockAll() {
    this.sidebarTabs = [];
    this.activeTabId = UIStore.MAIN;
  }
  activateTab(id) {
    this.activeTabId = id;
  }
  activateMain() {
    this.activeTabId = UIStore.MAIN;
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
