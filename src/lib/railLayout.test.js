// The hover rail parks OFF-SCREEN (position:fixed, translateX(100%)). That extends the document past the
// viewport, raises a horizontal scrollbar, and the scrollbar appearing/disappearing changes the viewport
// size — so the canvas re-fits and the whole page appears to rescale as the rail opens. The fix is a root
// overflow clip. It's pure CSS, so pin it here rather than let a future cleanup silently undo it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("src/app.css", "utf8");
const tabs = readFileSync("src/lib/components/RailTabs.svelte", "utf8");

describe("rail layout must not reflow the page", () => {
  it("the document root clips overflow", () => {
    const block = css.slice(css.indexOf("html,"), css.indexOf("#app"));
    expect(block).toMatch(/overflow:\s*hidden/);
  });

  it("the drawer is fixed + transform-animated, so showing it never changes layout width", () => {
    expect(tabs).toMatch(/position:\s*fixed/);
    expect(tabs).toMatch(/transform:\s*translateX\(100%\)/);
    expect(tabs).toMatch(/transition:\s*transform/);
    // animating width/right would reflow the canvas on every frame
    expect(tabs).not.toMatch(/transition:[^;]*\b(width|right)\b/);
  });

  it("a parked drawer cannot intercept the pointer", () => {
    expect(tabs).toMatch(/pointer-events:\s*none/);
    expect(tabs).toMatch(/\.tabs\.open\s*\{[^}]*pointer-events:\s*auto/);
  });
});

describe("tab styling is borderless", () => {
  const rule = tabs.slice(tabs.indexOf("  .block {"), tabs.indexOf("  .block:hover"));
  it("no border on a tab at rest", () => {
    expect(rule).toMatch(/border:\s*none/);
  });
  it("the active tab carries state with fill + weight, not an outline", () => {
    const open = tabs.slice(tabs.indexOf("  .block.open {"), tabs.indexOf("  .block.open:hover"));
    expect(open).toMatch(/background:/);
    expect(open).toMatch(/font-weight:/);
    expect(open).not.toMatch(/border(-color)?:/);
    expect(open).not.toMatch(/box-shadow:/);   // the old inset marker is gone
  });
});

// The tabs are grouped by COST and by WHEN you read them: `checks` scores from coordinates the moment QC
// runs, `appearance` needs embeddings computed or a bundle uploaded first, and `analysis` reports on a
// finished run (overlap / manual agreement / export). One component serves all three via a `mode` prop,
// so the filter that separates them is the thing worth pinning.
describe("geometry / appearance / analysis split", () => {
  const qcc = readFileSync("src/lib/components/QcChecks.svelte", "utf8");
  const side = readFileSync("src/lib/components/Sidebar.svelte", "utf8");

  it("QcChecks takes a mode and filters the groups by it", () => {
    expect(qcc).toMatch(/let \{ mode = "geometry" \} = \$props\(\)/);
    expect(qcc).toMatch(/const groupsFor = \$derived\(/);
    expect(qcc).toMatch(/isGeom \? GROUPS\.filter\(\(g\) => g\.id !== "appearance"\)/);
    expect(qcc).toMatch(/isAppearMode \? GROUPS\.filter\(\(g\) => g\.id === "appearance"\)/);
    expect(qcc).toMatch(/\[\],\s*\/\/ analysis shows no detector list/);   // analysis lists no detectors
  });

  it("all three tabs are wired to the one component", () => {
    for (const m of ["geometry", "appearance", "analysis"]) {
      expect(side).toContain(`<QcChecks mode="${m}" />`);
      expect(side).toContain(`ui.activeBlock === "${m === "geometry" ? "checks" : m}"`);
    }
  });

  it("configuring a run stays on the checks tab", () => {
    for (const guard of ["{#if isGeom && qc.runProgress}", "{#if isGeom && qc.pendingCount > 0}",
                         "{#if isGeom}"]) {   // reset-to-defaults
      expect(qcc).toContain(guard);
    }
    expect(qcc).toContain("{#if isAppearMode && store.ready}");   // the appearance panels
  });

  it("reading a finished run — overlap, manual comparison, export — is the analysis tab", () => {
    for (const guard of ["{#if isAnalysis && qc.hasResults}", "{#if isAnalysis && qc.canExportCsv}"]) {
      expect(qcc).toContain(guard);
    }
    // ...and NOT the checks tab, which would put the same panel in two places
    for (const stale of ["{#if isGeom && qc.hasResults}", "{#if isGeom && qc.canExportCsv}"]) {
      expect(qcc).not.toContain(stale);
    }
    // each analysis panel is rendered exactly once
    for (const tag of ["<DetectorOverlap />", "<ManualCheckCompare />"]) {
      expect(qcc.split(tag).length - 1, tag).toBe(1);
    }
    expect(qcc).toContain("{#if isAnalysis && !qc.hasResults}");   // empty state before a run
  });

  it("the slate renders instances inside the frame tab, and no instances tab exists", () => {
    expect(side).toMatch(/activeBlock === "frame"\}\{@render frameBody\(\)\}\{@render instancesBody\(\)\}/);
    expect(side).not.toMatch(/activeBlock === "instances"/);
  });
});

// Tabs already scope the view, so the groups inside a tab open by default — collapsing on top of a tab
// hides the tab's own content behind a second click. The optional DETAIL layer stays collapsed.
describe("check groups start expanded", () => {
  const qcc = readFileSync("src/lib/components/QcChecks.svelte", "utf8");
  const decl = (name) => qcc.match(new RegExp(`let ${name} = \\$state\\(([^;]+)\\);`))?.[1] ?? "";

  it("every group in the tab is expanded on arrival", () => {
    const g = decl("groupOpen");
    for (const id of ["geometric", "statistical", "frame", "appearance"]) {
      expect(g, `group "${id}"`).toMatch(new RegExp(`${id}:\\s*true`));
    }
  });

  it("the Appearance tab is one button, not an inline computation panel", () => {
    // appOpen/appMode are gone: the run is configured in AppearanceWindow, so there is nothing here to
    // expand or collapse — which is the point. Keeping the assertion pins that it stays that way.
    expect(qcc).not.toMatch(/let appOpen = \$state/);
    expect(qcc).not.toMatch(/let appMode = \$state/);
    expect(qcc).toMatch(/class="run-dino"/);
  });

  it("the analysis tab's panels are its content, so they are open too", () => {
    for (const n of ["overlapOpen", "manualOpen"]) expect(decl(n).trim(), n).toBe("true");
  });

  it("the deep-dive dropdowns stay collapsed — they are 'more information', not content", () => {
    for (const n of ["featOpen", "timingOpen"]) {
      expect(decl(n).trim(), n).toBe("false");
    }
    expect(decl("infoOpen").trim()).toBe("{}");   // per-check ⓘ, all closed
  });
});
