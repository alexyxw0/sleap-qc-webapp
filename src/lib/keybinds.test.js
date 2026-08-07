// Rebindable keys are only safe if the invariants hold: no action can end up unreachable, no key can end
// up owned by two actions (the second would never fire), and a corrupt saved blob must degrade to the
// shipped defaults rather than leaving the keyboard dead.
import { describe, it, expect, beforeEach, vi } from "vitest";

function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _dump: () => [...m.entries()],
  };
}
const ls = memStore();
vi.stubGlobal("localStorage", ls);

const { keybinds, KEYBIND_DEFAULTS } = await import("./keybinds.svelte.js");
const { PROOFREAD_KEYS, GLOBAL_KEYS } = await import("./qc/proofreadKeymap.js");

const ev = (key) => ({ key, target: { tagName: "BODY" } });

beforeEach(() => keybinds.resetAll());

describe("defaults", () => {
  it("ships every action bound", () => {
    for (const e of [...PROOFREAD_KEYS, ...GLOBAL_KEYS]) {
      expect(keybinds.keysFor(e.id), e.id).toEqual(e.keys);
      expect(keybinds.isDefault(e.id)).toBe(true);
    }
    expect(keybinds.anyCustom).toBe(false);
  });

  it("resolves a shipped key to its action", () => {
    expect(keybinds.resolve(ev("f"))).toEqual({ id: "faulty" });
    expect(keybinds.resolve(ev("3"))).toEqual({ id: "toggleKeypoint", digit: 3 });
    expect(keybinds.resolveGlobal(ev("r"))).toEqual({ id: "enterProofread" });
    expect(keybinds.resolve(ev("Q"))).toBeNull();
  });
});

describe("rebinding", () => {
  it("a new key resolves to its action immediately", () => {
    expect(keybinds.addKey("faulty", "q")).toBeNull();
    expect(keybinds.resolve(ev("q"))).toEqual({ id: "faulty" });
    expect(keybinds.resolve(ev("f"))).toEqual({ id: "faulty" }); // the original still works
    expect(keybinds.isDefault("faulty")).toBe(false);
    expect(keybinds.anyCustom).toBe(true);
  });

  it("refuses a key another action already owns, and says which", () => {
    const why = keybinds.addKey("faulty", "j"); // j = clean
    expect(why).toMatch(/taken by/i);
    expect(why).toMatch(/clean/i);
    expect(keybinds.resolve(ev("j"))).toEqual({ id: "clean" }); // unchanged
  });

  it("refuses a key the action already has", () => {
    expect(keybinds.addKey("faulty", "f")).toMatch(/already bound/i);
    expect(keybinds.keysFor("faulty")).toEqual(["f"]);
  });

  it("refuses a bare modifier — it arrives with every chord", () => {
    for (const k of ["Shift", "Control", "Alt", "Meta"]) {
      expect(keybinds.addKey("faulty", k), k).toMatch(/can't be bound/i);
    }
  });

  it("removing a key works, but never the last one", () => {
    expect(keybinds.keysFor("clean")).toEqual(["j", " "]);
    expect(keybinds.removeKey("clean", " ")).toBeNull();
    expect(keybinds.keysFor("clean")).toEqual(["j"]);
    expect(keybinds.resolve(ev(" "))).toBeNull();
    expect(keybinds.removeKey("clean", "j")).toMatch(/at least one key/i);
    expect(keybinds.resolve(ev("j"))).toEqual({ id: "clean" }); // still reachable
  });

  it("the digit range is fixed — it is one action over nine keys", () => {
    expect(keybinds.addKey("toggleKeypoint", "q")).toMatch(/fixed/i);
    expect(keybinds.removeKey("toggleKeypoint", "1")).toMatch(/fixed/i);
    expect(keybinds.resolve(ev("5"))).toEqual({ id: "toggleKeypoint", digit: 5 });
  });

  it("a freed key can then be taken by someone else", () => {
    keybinds.removeKey("clean", " ");
    expect(keybinds.addKey("faulty", " ")).toBeNull();
    expect(keybinds.resolve(ev(" "))).toEqual({ id: "faulty" });
  });

  it("case does not create a second owner", () => {
    expect(keybinds.addKey("unset", "F")).toMatch(/taken by/i); // f is faulty
  });

  it("clicking a key and pressing another swaps it IN PLACE", () => {
    expect(keybinds.keysFor("next")).toEqual(["n", "ArrowRight"]);
    expect(keybinds.replaceKey("next", "n", "w")).toBeNull();
    expect(keybinds.keysFor("next")).toEqual(["w", "ArrowRight"]); // position kept — legends show [0]
    expect(keybinds.resolve(ev("w"))).toEqual({ id: "next" });
    expect(keybinds.resolve(ev("n"))).toBeNull(); // the old key is genuinely free now
  });

  it("a replacement obeys the same rules as an add", () => {
    expect(keybinds.replaceKey("next", "n", "j")).toMatch(/taken by/i); // j = clean
    expect(keybinds.replaceKey("next", "n", "Shift")).toMatch(/can't be bound/i);
    expect(keybinds.replaceKey("toggleKeypoint", "1", "q")).toMatch(/fixed/i);
    expect(keybinds.keysFor("next")).toEqual(["n", "ArrowRight"]); // nothing changed
  });

  it("pressing the same key is a no-op, not an error", () => {
    expect(keybinds.replaceKey("next", "n", "n")).toBeNull();
    expect(keybinds.keysFor("next")).toEqual(["n", "ArrowRight"]);
  });

  it("replacing a key that is no longer bound says so instead of appending", () => {
    expect(keybinds.replaceKey("next", "zzz", "w")).toMatch(/no longer bound/i);
    expect(keybinds.keysFor("next")).toEqual(["n", "ArrowRight"]);
  });

  it("a replaced key frees up for another action", () => {
    keybinds.replaceKey("next", "n", "w");
    expect(keybinds.addKey("unset", "n")).toBeNull();
    expect(keybinds.resolve(ev("n"))).toEqual({ id: "unset" });
  });

  it("reset restores one action, resetAll restores everything", () => {
    keybinds.addKey("faulty", "q");
    keybinds.addKey("unset", "w");
    keybinds.resetAction("faulty");
    expect(keybinds.isDefault("faulty")).toBe(true);
    expect(keybinds.isDefault("unset")).toBe(false);
    keybinds.resetAll();
    expect(keybinds.anyCustom).toBe(false);
    expect(keybinds.resolve(ev("q"))).toBeNull();
  });
});

describe("resetting a default reclaims it", () => {
  it("takes the key back from whoever was given it while this action was off it", () => {
    keybinds.replaceKey("faulty", "f", "q");   // faulty gives up f
    expect(keybinds.addKey("unset", "f")).toBeNull(); // unset takes it
    expect(keybinds.resolve(ev("f"))).toEqual({ id: "unset" });
    keybinds.resetAction("faulty");            // faulty wants f back
    expect(keybinds.resolve(ev("f"))).toEqual({ id: "faulty" }); // one owner, not two
    expect(keybinds.keysFor("unset")).not.toContain("f");
  });

  it("never leaves the loser unreachable", () => {
    keybinds.replaceKey("faulty", "f", "q");
    keybinds.replaceKey("unset", "u", "f");    // unset's ONLY key is now f
    keybinds.resetAction("faulty");
    expect(keybinds.keysFor("unset").length, "unset was stranded").toBeGreaterThan(0);
    expect(keybinds.resolve(ev(keybinds.keysFor("unset")[0]))).toEqual({ id: "unset" });
  });

  it("exit and enterProofread may share r — they resolve against different maps", () => {
    // The reclaim is scoped per keymap precisely so this shipped default survives it.
    expect(keybinds.keysFor("exit")).toContain("r");
    expect(keybinds.keysFor("enterProofread")).toContain("r");
    keybinds.resetAction("exit");
    expect(keybinds.keysFor("enterProofread")).toContain("r");
    expect(keybinds.resolveGlobal(ev("r"))).toEqual({ id: "enterProofread" });
    expect(keybinds.resolve(ev("r"))).toEqual({ id: "exit" });
  });
});

describe("everything that shows keys reads the live map", () => {
  it("no component resolves or legends from the static defaults", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = "src/lib/components";
    const bad = readdirSync(dir).filter((f) => {
      if (!f.endsWith(".svelte")) return false;
      const src = readFileSync(`${dir}/${f}`, "utf8");
      // a legend built from the defaults would drift the moment anything is rebound
      return /keymapLegend\(\s*\)/.test(src) || /\bresolveKey\(/.test(src) || /resolveGlobalKey\(/.test(src);
    });
    expect(bad, `reads the shipped defaults: ${bad.join(", ")}`).toEqual([]);
  });
});

describe("persistence", () => {
  it("a change is written, and a fresh load picks it up", async () => {
    keybinds.addKey("faulty", "q");
    expect(ls._dump().some(([k, v]) => k.includes("keybinds") && v.includes('"q"'))).toBe(true);
    vi.resetModules();
    const { keybinds: reloaded } = await import("./keybinds.svelte.js");
    expect(reloaded.keysFor("faulty")).toEqual(["f", "q"]);
    expect(reloaded.resolve(ev("q"))).toEqual({ id: "faulty" });
  });

  it("resetAll clears the stored copy, so next launch is defaults", async () => {
    keybinds.addKey("faulty", "q");
    keybinds.resetAll();
    vi.resetModules();
    const { keybinds: reloaded } = await import("./keybinds.svelte.js");
    expect(reloaded.keysFor("faulty")).toEqual(["f"]);
  });

  it("a corrupt or hostile payload degrades to defaults instead of killing the keyboard", async () => {
    const key = ls._dump().find(([k]) => k.includes("keybinds"))?.[0]
      ?? (keybinds.addKey("faulty", "q"), ls._dump().find(([k]) => k.includes("keybinds"))[0]);
    ls.setItem(key, JSON.stringify({ faulty: [1, 2, 3], clean: "j", unset: [], bogusAction: ["z"] }));
    vi.resetModules();
    const { keybinds: reloaded } = await import("./keybinds.svelte.js");
    expect(reloaded.keysFor("faulty")).toEqual(KEYBIND_DEFAULTS.faulty); // non-strings dropped
    expect(reloaded.keysFor("clean")).toEqual(KEYBIND_DEFAULTS.clean); // wrong shape rejected
    expect(reloaded.keysFor("unset")).toEqual(KEYBIND_DEFAULTS.unset); // empty is unreachable
    expect(reloaded.resolve(ev("f"))).toEqual({ id: "faulty" }); // still usable
  });

  it("an action added after the config was saved gets its default", async () => {
    const key = ls._dump().find(([k]) => k.includes("keybinds"))?.[0];
    ls.setItem(key ?? "sleap-qc:v1:keybinds", JSON.stringify({ faulty: ["q"] })); // an old, partial blob
    vi.resetModules();
    const { keybinds: reloaded } = await import("./keybinds.svelte.js");
    expect(reloaded.keysFor("faulty")).toEqual(["q"]);
    expect(reloaded.keysFor("cycleInstance")).toEqual(KEYBIND_DEFAULTS.cycleInstance);
  });
});
