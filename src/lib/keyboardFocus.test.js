// One keypress must not move two windows. Every keyboard surface used to guard only on its OWN open
// flag, so nothing arbitrated between them — with the QC review popup open, an arrow key stepped the
// review AND seeked the viewer underneath it. ui.keyOwner is the single answer to "who is typing".
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("./labelsStore.svelte.js", () => ({ store: { frames: [], labels: null, skeleton: null } }));
const { ui, isTypingTarget } = await import("./uiStore.svelte.js");

const read = (p) => readFileSync(p, "utf8");
const HANDLERS = {
  "Viewer.svelte": "viewer",
  "QcReview.svelte": "review",
  "CommandPalette.svelte": "palette",
};

describe("exactly one surface owns the keyboard", () => {
  beforeEach(() => { ui.paletteOpen = false; ui.helpOpen = false; ui.reviewOpen = false; });

  it("falls back to the viewer when nothing is layered over it", () => {
    expect(ui.keyOwner).toBe("viewer");
    expect(ui.ownsKeys("viewer")).toBe(true);
  });

  it("is ordered by what is visually on top", () => {
    ui.reviewOpen = true;
    expect(ui.keyOwner).toBe("review");
    ui.helpOpen = true;                       // help opens over the review
    expect(ui.keyOwner).toBe("help");
    ui.paletteOpen = true;                    // the palette over everything
    expect(ui.keyOwner).toBe("palette");
    ui.paletteOpen = false;
    expect(ui.keyOwner).toBe("help");          // ...and it hands back down in order
  });

  it("never returns two owners — that is the whole point", () => {
    for (const combo of [[1,1,1],[1,1,0],[1,0,1],[0,1,1],[1,0,0],[0,1,0],[0,0,1],[0,0,0]]) {
      [ui.paletteOpen, ui.helpOpen, ui.reviewOpen] = combo.map(Boolean);
      const owner = ui.keyOwner;
      const owners = ui.constructor.KEY_LAYERS.filter((l) => ui.ownsKeys(l));
      expect(owners, `combo ${combo}`).toEqual([owner]);
    }
  });

  it("the review popup stops receiving keys the moment the palette opens over it", () => {
    ui.reviewOpen = true;
    expect(ui.ownsKeys("review")).toBe(true);
    ui.paletteOpen = true;
    expect(ui.ownsKeys("review"), "the review would still be stepping under the palette").toBe(false);
  });
});

describe("every keyboard handler asks the arbiter", () => {
  for (const [file, layer] of Object.entries(HANDLERS)) {
    it(`${file} acts only as "${layer}"`, () => {
      const src = read(`src/lib/components/${file}`);
      const fn = src.slice(src.indexOf("function onKey(e)"));
      const body = fn.slice(0, fn.indexOf("\n  }"));
      expect(body, `${file} does not consult ui.ownsKeys`).toContain(`ui.ownsKeys("${layer}")`);
    });
  }

  it("nothing guards on a raw open flag any more", () => {
    // `if (!ui.reviewOpen) return` is true while the palette sits on top of the review.
    const qr = read("src/lib/components/QcReview.svelte");
    const fn = qr.slice(qr.indexOf("function onKey(e)"));
    expect(fn.slice(0, 200)).not.toMatch(/if \(!ui\.reviewOpen\) return;/);
  });

  it("the viewer — which owns the base layer — also ignores keys typed into a field", () => {
    const v = read("src/lib/components/Viewer.svelte");
    expect(v).toMatch(/if \(!ui\.ownsKeys\("viewer"\) \|\| isTypingTarget\(e\)\) return;/);
  });

  it("help opens from the base layer only, so \"?\" in the palette is a character", () => {
    const h = read("src/lib/components/ShortcutsHelp.svelte");
    expect(h).toMatch(/e\.key === "\?"[^\n]*ui\.ownsKeys\("viewer"\)/);
    expect(h).toMatch(/e\.key === "Escape" && ui\.ownsKeys\("help"\)/);
  });

  it("the proofreading rebind grabber preempts everything by capture + stopPropagation", () => {
    // It is deliberately not a keyOwner layer: while you are pressing the key you want to bind,
    // NOTHING else may see it, including the layer that would otherwise own the keyboard.
    const pw = read("src/lib/components/ProofreadWindow.svelte");
    expect(pw).toMatch(/addEventListener\("keydown", onKey, true\)/);
    const fn = pw.slice(pw.indexOf("const onKey = (e) =>"));
    expect(fn.slice(0, 200)).toContain("e.stopPropagation()");
  });
});

describe("the guards are in KEY HANDLERS, not in effects", () => {
  // I put one in QcReview's re-framing $effect by mistake, where `e` does not exist. Neither the build
  // nor the SSR probe catches that: it is a runtime ReferenceError, and effects do not run under SSR.
  // It would have thrown on every frame change with the review open.
  for (const file of ["Viewer.svelte", "QcReview.svelte", "ShortcutsHelp.svelte"]) {
    it(`${file} references the event only where an event exists`, () => {
      const src = read(`src/lib/components/${file}`);
      for (const m of [...src.matchAll(/isTypingTarget\(e\)/g)]) {
        const before = src.slice(0, m.index);
        const lastHandler = Math.max(before.lastIndexOf("function onKey(e)"), before.lastIndexOf("(e) =>"));
        const lastEffect = before.lastIndexOf("$effect(");
        expect(lastHandler, `${file}: isTypingTarget(e) is not inside a handler`).toBeGreaterThan(-1);
        expect(lastHandler, `${file}: isTypingTarget(e) sits inside an $effect — there is no \`e\` there`)
          .toBeGreaterThan(lastEffect);
      }
    });
  }
});

describe("isTypingTarget", () => {
  // Plain objects on purpose: the helper must not depend on DOM constructors, which are per-realm
  // (false for an iframe's node) and absent entirely outside a browser.
  const ev = (target) => ({ target });
  it("claims the key for text entry, whatever layer is on top", () => {
    for (const tag of ["INPUT", "input", "TextArea", "SELECT"]) {
      expect(isTypingTarget(ev({ tagName: tag })), tag).toBe(true);
    }
    expect(isTypingTarget(ev({ tagName: "DIV", isContentEditable: true }))).toBe(true);
  });
  it("leaves ordinary targets alone", () => {
    for (const tag of ["BUTTON", "CANVAS", "DIV", "BODY"]) {
      expect(isTypingTarget(ev({ tagName: tag })), tag).toBe(false);
    }
    expect(isTypingTarget(ev(null))).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
    expect(isTypingTarget({})).toBe(false);
  });
  it("does not throw where the DOM globals do not exist", () => {
    expect(typeof globalThis.HTMLInputElement).toBe("undefined");   // this test env
    expect(() => isTypingTarget(ev({ tagName: "INPUT" }))).not.toThrow();
  });
});
