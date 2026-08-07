import { describe, it, expect } from "vitest";
import { PROOFREAD_KEYS, GLOBAL_KEYS, buildKeymap, resolveKey, keymapLegend } from "./proofreadKeymap.js";

const ev = (key, o = {}) => ({ key, target: { tagName: "CANVAS" }, ...o });

describe("proofreading keymap", () => {
  it("judgements sit on the home row under the index fingers", () => {
    expect(resolveKey(ev("f"))).toEqual({ id: "faulty" });
    expect(resolveKey(ev("j"))).toEqual({ id: "clean" });
    expect(resolveKey(ev(" "))).toEqual({ id: "clean" });   // space is the fast repeat
  });
  it("is case-insensitive for letters", () => {
    expect(resolveKey(ev("F"))).toEqual({ id: "faulty" });
    expect(resolveKey(ev("J"))).toEqual({ id: "clean" });
  });
  it("digits carry which keypoint was pressed", () => {
    expect(resolveKey(ev("3"))).toEqual({ id: "toggleKeypoint", digit: 3 });
    expect(resolveKey(ev("9"))).toEqual({ id: "toggleKeypoint", digit: 9 });
    expect(resolveKey(ev("0"))).toBeNull();                 // 0 is not a keypoint
  });
  it("named keys resolve", () => {
    expect(resolveKey(ev("Tab"))).toEqual({ id: "nextUnreviewed" });
    expect(resolveKey(ev("ArrowRight"))).toEqual({ id: "next" });
    expect(resolveKey(ev("Escape"))).toEqual({ id: "exit" });
  });
  it("unbound keys pass through", () => {
    for (const k of ["q", "w", "F5", "Shift"]) expect(resolveKey(ev(k))).toBeNull();
  });

  it("never swallows modifier chords — ⌘K and copy/paste must survive a review pass", () => {
    for (const mod of ["metaKey", "ctrlKey", "altKey"]) {
      expect(resolveKey(ev("f", { [mod]: true }))).toBeNull();
      expect(resolveKey(ev("k", { [mod]: true }))).toBeNull();
    }
  });
  it("never fires while typing", () => {
    for (const t of [{ tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "DIV", isContentEditable: true }]) {
      expect(resolveKey(ev("f", { target: t }))).toBeNull();
    }
  });

  it("no key is bound twice — a silent override would be untraceable", () => {
    const seen = new Map();
    for (const e of PROOFREAD_KEYS) {
      for (const k of e.keys) {
        const n = k.length === 1 ? k.toLowerCase() : k;
        expect(seen.has(n), `"${k}" bound by both ${seen.get(n)} and ${e.id}`).toBe(false);
        seen.set(n, e.id);
      }
    }
  });
  it("every entry is renderable in the legend (id, label, group)", () => {
    for (const e of PROOFREAD_KEYS) {
      expect(typeof e.id).toBe("string");
      expect(e.label.length).toBeGreaterThan(3);
      expect(typeof e.group).toBe("string");
    }
    const legend = keymapLegend();
    expect(legend.map((g) => g.group))
      .toEqual(["Judge", "Move", "Keypoint", "Guided pass", "Session", "View", "Global"]);
    expect(legend[0].rows[1].keys).toEqual(["j", "Space"]);  // Space rendered, not a bare " "
  });

  it("every action explains itself, and every group is described", async () => {
    // The editor shows these; an unexplained action is one the user has to guess at (the "budget" case).
    const { KEY_GROUP_HINTS } = await import("./proofreadKeymap.js");
    for (const e of [...PROOFREAD_KEYS, ...GLOBAL_KEYS]) {
      expect(e.hint, `${e.id} has no hint`).toBeTruthy();
      expect(e.hint.length, e.id).toBeGreaterThan(12);
      expect(KEY_GROUP_HINTS[e.group], `group "${e.group}" has no blurb`).toBeTruthy();
    }
  });
  it("buildKeymap is pure — a custom map doesn't touch the default", () => {
    const custom = buildKeymap([{ id: "x", keys: ["f"], label: "custom", group: "g" }]);
    expect(resolveKey(ev("f"), custom)).toEqual({ id: "x" });
    expect(resolveKey(ev("f"))).toEqual({ id: "faulty" });
  });
});

describe("keyboard-only reachability", () => {
  const ev = (key, o = {}) => ({ key, target: { tagName: "CANVAS" }, ...o });

  it("the mode itself is reachable without the cursor", async () => {
    const { resolveGlobalKey } = await import("./proofreadKeymap.js");
    expect(resolveGlobalKey(ev("r"))).toEqual({ id: "enterProofread" });
    expect(resolveGlobalKey(ev("f"))).toBeNull();   // judge keys don't leak outside the mode
  });

  it("r also exits from inside, so the toggle is symmetric", () => {
    expect(resolveKey(ev("r"))).toEqual({ id: "exit" });
    expect(resolveKey(ev("Escape"))).toEqual({ id: "exit" });
  });

  it("every cursor-only control has a key: budget, export, help", () => {
    expect(resolveKey(ev("["))).toEqual({ id: "budgetDown" });
    expect(resolveKey(ev("]"))).toEqual({ id: "budgetUp" });
    expect(resolveKey(ev("e"))).toEqual({ id: "exportCsv" });
    expect(resolveKey(ev("?"))).toEqual({ id: "help" });
  });

  it("does not collide with the viewer's existing global bindings", async () => {
    const { GLOBAL_KEYS } = await import("./proofreadKeymap.js");
    // keys the viewer/editor already own OUTSIDE proofreading
    const taken = new Set(["n", "p", "v", " ", "a", "d", "h", "y", "z", "k", "0", "+", "-", "=", "_"]);
    for (const e of GLOBAL_KEYS) for (const k of e.keys) {
      expect(taken.has(k), `global "${k}" collides with an existing binding`).toBe(false);
    }
  });

  it("the legend covers the global group, so entering is discoverable in help", () => {
    const groups = keymapLegend();
    expect(groups.map((g) => g.group)).toContain("Global");
    expect(groups.map((g) => g.group)).toContain("Session");
  });
});
