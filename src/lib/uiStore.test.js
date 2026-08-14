// The rail is a hover-revealed drawer of collapsible blocks. Two properties matter most: it launches
// MINIMAL (nothing expanded), and it can't auto-hide while pinned — an auto-hide mid-slider would be
// maddening, which is the whole reason pinning exists.
import { describe, it, expect, beforeEach } from "vitest";
import { ui } from "./uiStore.svelte.js";

describe("right rail", () => {
  beforeEach(() => { ui.railHover = false; ui.railPinned = false; ui.collapseAll(); });

  it("launches on a blank slate — no tab selected", () => {
    expect(ui.activeBlock).toBeNull();
    for (const b of ui.constructor.BLOCKS) expect(ui.isBlockOpen(b.id)).toBe(false);
  });

  it("is closed until hovered", () => {
    expect(ui.railOpen).toBe(false);
    ui.setRailHover(true);
    expect(ui.railOpen).toBe(true);
    ui.setRailHover(false);
    expect(ui.railOpen).toBe(false);
  });

  it("pinning keeps it open through a hover-out", () => {
    ui.togglePin();
    expect(ui.railOpen).toBe(true);
    ui.setRailHover(false);
    expect(ui.railOpen).toBe(true);      // pin wins
    ui.togglePin();
    expect(ui.railOpen).toBe(false);
  });

  it("only ONE tab can be shown — selecting another replaces it", () => {
    ui.toggleBlock("checks");
    expect(ui.activeBlock).toBe("checks");
    ui.toggleBlock("appearance");
    expect(ui.activeBlock).toBe("appearance");
    expect(ui.isBlockOpen("checks")).toBe(false);   // never two at once
    for (const b of ui.constructor.BLOCKS) {
      ui.toggleBlock(b.id);
      const shown = ui.constructor.BLOCKS.filter((x) => ui.isBlockOpen(x.id));
      expect(shown.length).toBeLessThanOrEqual(1);
    }
  });

  it("clicking the active tab returns to the blank slate", () => {
    ui.toggleBlock("frame");
    expect(ui.activeBlock).toBe("frame");
    ui.toggleBlock("frame");
    expect(ui.activeBlock).toBeNull();
  });

  it("collapseAll clears the slate", () => {
    ui.toggleBlock("appearance");
    ui.collapseAll();
    expect(ui.activeBlock).toBeNull();
  });

  it("every declared block has an id, title and hint the header can render", () => {
    const ids = ui.constructor.BLOCKS.map((b) => b.id);
    expect(ids).toEqual(["frame", "checks", "appearance", "analysis"]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of ui.constructor.BLOCKS) {
      expect(typeof b.title).toBe("string");
      expect(b.hint.length).toBeGreaterThan(8);
    }
  });

  it("opening a new file returns to the minimal launch state", () => {
    ui.toggleBlock("checks");
    ui.paletteOpen = true;
    ui.closeAll();
    expect(ui.activeBlock).toBeNull();
    expect(ui.overlayOpen).toBe(false);
  });

  it("a drag clamps to a usable width — it can never be dragged to NaN", () => {
    // setRailW reads UIStore.RAIL_MIN/MAX. When the tabs overhaul deleted them the clamp became
    // Math.max(undefined, …) = NaN, both width declarations dropped, and the panel collapsed for good.
    ui.setRailW(50);
    expect(ui.railW).toBe(ui.constructor.RAIL_MIN);
    ui.setRailW(9999);
    expect(ui.railW).toBe(ui.constructor.RAIL_MAX);
    ui.setRailW(320);
    expect(Number.isFinite(ui.railW)).toBe(true);
    expect(ui.constructor.RAIL_MIN).toBeLessThan(ui.constructor.RAIL_MAX);
  });

  it("the old drag-to-dock tab API is gone", () => {
    for (const m of ["dockPanel", "mergeTabs", "undockTab", "undockAll", "activateTab", "panelHidden"]) {
      expect(ui[m]).toBeUndefined();
    }
  });
});

// The selector and the panel are SEPARATE components: hovering away must never take the open content
// with it. These pin the store-level contract that makes that possible.
describe("selector visibility is independent of panel visibility", () => {
  beforeEach(() => { ui.railHover = false; ui.railPinned = false; ui.collapseAll(); });

  it("an open panel SURVIVES the selector hiding", () => {
    ui.setRailHover(true);
    ui.toggleBlock("checks");
    expect(ui.railOpen).toBe(true);
    ui.setRailHover(false);            // pointer leaves the edge
    expect(ui.railOpen).toBe(false);   // selector gone...
    expect(ui.activeBlock).toBe("checks"); // ...content stays
  });

  it("the selector can open and close repeatedly without disturbing the panel", () => {
    ui.toggleBlock("frame");
    for (let i = 0; i < 3; i++) { ui.setRailHover(true); ui.setRailHover(false); }
    expect(ui.activeBlock).toBe("frame");
  });

  it("closing the panel does not close the selector", () => {
    ui.setRailHover(true);
    ui.toggleBlock("frame");
    ui.collapseAll();
    expect(ui.activeBlock).toBeNull();
    expect(ui.railOpen).toBe(true);     // still hovering the selector
  });

  it("railOpen and activeBlock are genuinely independent axes", () => {
    for (const hover of [false, true]) {
      for (const block of [null, "checks"]) {
        ui.setRailHover(hover);
        ui.activeBlock = block;
        expect(ui.railOpen).toBe(hover);
        expect(ui.activeBlock).toBe(block);
      }
    }
  });
});

describe("chromeW — the width floating windows must keep clear of", () => {
  it("is the tab strip alone when no section is open", () => {
    ui.collapseAll();
    expect(ui.chromeW).toBeCloseTo(2.6 * 16, 6);   // no document in this env: the 16px fallback
  });

  it("grows by the docked panel when a section is open, and follows a resize", () => {
    ui.openBlock("checks");
    ui.setRailW(320);
    expect(ui.chromeW).toBeCloseTo(2.6 * 16 + 320, 6);
    ui.setRailW(300);
    expect(ui.chromeW).toBeCloseTo(2.6 * 16 + 300, 6);
    ui.collapseAll();
    expect(ui.chromeW).toBeCloseTo(2.6 * 16, 6);
  });

  it("the rem constant matches the CSS custom property it stands in for", async () => {
    // Two hard-coded widths would drift, and the drift shows up as a window you cannot quite grab.
    const { readFileSync } = await import("node:fs");
    const m = /--rail-mini:\s*([\d.]+)rem/.exec(readFileSync("src/app.css", "utf8"));
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBe(ui.constructor.RAIL_MINI_REM);
  });
});
