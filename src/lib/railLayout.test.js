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
    // Geometry drops the appearance group ONLY while none of it is ready. Once a compute pass has
    // happened those checks run like any other and belong in the tab that manages the detection set.
    expect(qcc).toMatch(/isGeom \? GROUPS\.filter\(\(g\) => g\.id !== "appearance" \|\| anyAppearReady\)/);
    expect(qcc).toMatch(/anyAppearReady = \$derived\.by/);
    expect(qcc).toMatch(/APPEARANCE_KEYS\.some\(\(k\) => qc\.checkReady\(k\)\)/);
    expect(qcc).toMatch(/isAppearMode \? GROUPS\.filter\(\(g\) => g\.id === "appearance"\)/);
    expect(qcc).toMatch(/\[\],\s*\/\/ analysis shows no detector list/);   // analysis lists no detectors
  });

  it("a READY appearance check also belongs to the checks tab, an unready one does not", () => {
    // The tab split was by cost: everything in "Detection checks" scores the instant QC runs. Once a
    // compute pass has happened that is true of an appearance check too, and hiding it there meant
    // the tab that manages the detection set no longer showed what was actually running.
    expect(qcc).toMatch(/g\.id !== "appearance" \|\| anyAppearReady/);
    // ...and it says where it came from, so the group does not silently break the cost promise.
    expect(qcc).toContain('g.id === "appearance" && isGeom');
    expect(qcc).toContain("Computed, so they run like any other check here");
    expect(qcc).toContain('ui.openBlock("appearance")');
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
    // No `store.ready` on the entry point any more: the bundle route needs no file, so gating the only
    // way into the window on a decodable video locked those users out entirely.
    expect(qcc).toContain("{#if isAppearMode}");
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

// The tab strip used to be an INVISIBLE 14px catch strip: nothing marked where the app's four
// sections were, so they were discoverable only by sweeping the right edge and noticing something
// appear. The icons are now always on screen, and expand to the labelled strip on hover.
describe("the tab strip is always visible", () => {
  const app = readFileSync("src/App.svelte", "utf8");
  const uiSrc = readFileSync("src/lib/uiStore.svelte.js", "utf8");

  it("renders a square icon for every section, permanently", () => {
    expect(tabs, "the invisible catch strip is still the only target").not.toMatch(/class="edge"/);
    expect(tabs).toContain('class="mini"');
    const icons = tabs.match(/const ICON = \{([^}]*)\}/)[1];
    const blocks = uiSrc.match(/\{ id: "(\w+)", title:/g).map((m) => m.match(/"(\w+)"/)[1]);
    expect(blocks.length).toBeGreaterThan(0);
    for (const id of blocks) expect(icons, `no icon for ${id}`).toContain(`${id}:`);
  });

  it("an icon is a control, not just a hover target", () => {
    // Clicking one opens that section directly — waiting for the panel to slide out before you can
    // click a label would make the icons decoration.
    expect(tabs).toMatch(/class="mbtn"[\s\S]{0,200}?onclick=\{\(\) => ui\.toggleBlock\(b\.id\)\}/);
    expect(tabs).toContain("aria-pressed={on}");
  });

  it("it still expands on hover, and the panel still overlays it", () => {
    expect(tabs).toMatch(/class="mini"[\s\S]{0,140}?onpointerenter=\{enter\}/);
    expect(tabs).toMatch(/\.tabs\.open \{ transform: translateX\(0\)/);
  });

  it("the shell reserves exactly the strip's width, from one definition", () => {
    // A fixed strip over a flex shell sits ON TOP of whatever is rightmost. Two hard-coded widths
    // would drift; both sides read the same custom property.
    expect(css).toMatch(/--rail-mini:\s*[\d.]+rem/);
    expect(app).toMatch(/padding-right: var\(--rail-mini\)/);
    expect(tabs).toMatch(/width: var\(--rail-mini\)/);
  });

  it("the icon's label is available to a screen reader, not painted twice", () => {
    expect(tabs).toContain('class="mlbl"');
    expect(tabs).toMatch(/\.mlbl \{[^}]*clip-path: inset\(50%\)/s);
  });
});

// ---------------------------------------------------------------------------------------------------
// With the proofreading window open, clicking "Detection checks" or "Appearance" appeared to do
// nothing. Both DID open — you could not see them. Two separate causes had to line up, and fixing
// either one alone leaves the bug in place (verified in a real browser, one at a time):
//
//   1. `.app` animated with `animation-fill-mode: both`, which keeps the last keyframe applied
//      forever. That keyframe sets `transform: translateY(0)` — a transform other than `none` makes
//      the element a permanent STACKING CONTEXT, sealing every z-index inside it below any
//      root-level sibling. The floating windows are root-level siblings.
//   2. The chrome's z-indexes (60/61, and the in-flow panel) were below the windows' 300 anyway.
//
// So the window painted over the navigation, and the only route into a section is that navigation.
describe("app chrome outranks the floating windows", () => {
  const app = readFileSync("src/App.svelte", "utf8");
  const panel = readFileSync("src/lib/components/Sidebar.svelte", "utf8");
  const pop = readFileSync("src/lib/components/PopoutWindow.svelte", "utf8");
  const zOf = (src, sel) => {
    const at = src.indexOf(`${sel} {`);
    expect(at, `no ${sel} rule`).toBeGreaterThan(-1);
    const m = /z-index:\s*(\d+)/.exec(src.slice(at, at + 400));
    expect(m, `${sel} declares no z-index`).not.toBeNull();
    return Number(m[1]);
  };

  it("the shell does not leave a transform on itself, which would trap every z-index inside it", () => {
    const at = app.indexOf(".app {");
    const rule = app.slice(at, app.indexOf("\n  }", at));   // the whole rule; the comment in it is long
    expect(rule).toMatch(/animation:[^;]*\bbackwards\b/);
    // `both` and `forwards` both retain the final keyframe. The keyframe is identical to the base
    // style, so retaining it buys nothing and costs the stacking context.
    expect(rule).not.toMatch(/animation:[^;]*\b(both|forwards)\b/);
  });

  it("...and the keyframe it would have retained is indeed a transform", () => {
    // If fade-up ever stops ending on a transform, the rule above is no longer load-bearing — but it
    // is still correct, and this test is what tells the next reader which of the two it is.
    const k = css.slice(css.indexOf("@keyframes fade-up"));
    expect(k.slice(0, k.indexOf("}") + 1) + k.slice(k.indexOf("to"), k.indexOf("to") + 80))
      .toMatch(/transform:/);
  });

  it("the tab strip and the docked panel both sit above a floating window", () => {
    const win = zOf(pop, ".popwin");
    expect(zOf(tabs, ".mini"), "the icon strip is the ONLY way to open a section").toBeGreaterThan(win);
    expect(zOf(tabs, ".tabs")).toBeGreaterThan(win);
    expect(zOf(panel, ".panel"), "the panel is what the tab opens").toBeGreaterThan(win);
  });

  it("the selector still overlays the panel, and both stay under the modal overlays", () => {
    expect(zOf(tabs, ".tabs")).toBeGreaterThan(zOf(tabs, ".mini"));
    expect(zOf(tabs, ".mini")).toBeGreaterThan(zOf(panel, ".panel"));
    for (const f of ["CommandPalette", "ShortcutsHelp", "QcReview", "Toasts"]) {
      const src = readFileSync(`src/lib/components/${f}.svelte`, "utf8");
      const top = Math.max(...[...src.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1])));
      expect(top, `${f} must stay above the chrome`).toBeGreaterThan(zOf(tabs, ".tabs"));
    }
  });

  it("a raised panel needs a position for the z-index to apply at all", () => {
    // z-index on a static element is ignored, silently — the panel would still be buried.
    const at = panel.indexOf(".panel {");
    expect(panel.slice(at, at + 400)).toMatch(/position:\s*relative/);
  });
});

describe("floating windows keep clear of the chrome", () => {
  const pop = readFileSync("src/lib/components/PopoutWindow.svelte", "utf8");

  it("an un-dragged window centres in the space the chrome leaves, not the viewport", () => {
    // Centering on the viewport put a 1080px window straight under the docked panel the moment you
    // opened one — legible now that the panel is on top, but still overlapping for no reason.
    expect(pop).toContain("`calc(50% - ${ui.chromeW / 2}px)`");
  });

  it("a drag cannot park a window where its own title bar is unreachable", () => {
    expect(pop).toContain("const right = window.innerWidth - ui.chromeW;");
    expect(pop).toMatch(/Math\.min\(right - 100,/);
    expect(pop, "still clamping to the raw viewport width").not.toMatch(/Math\.min\(window\.innerWidth - 100,/);
  });
});
