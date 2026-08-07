// Persisted config must never let a STALE or corrupt payload change behaviour silently.
import { describe, it, expect } from "vitest";
import { read, write, clear, merge, loadConfig } from "./settings.js";

const fake = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
           removeItem: (k) => m.delete(k), _map: m };
};
const DEFAULTS = { threshold: 0.7, mode: "avg", checks: { anomaly: true, gmm: true, sam: false } };

describe("read/write round-trip", () => {
  it("stores and restores, namespaced + versioned", () => {
    const s = fake();
    expect(write("qc-config", { threshold: 0.4 }, s)).toBe(true);
    expect([...s._map.keys()][0]).toMatch(/^sleap-qc:v\d+:qc-config$/);
    expect(read("qc-config", s)).toEqual({ threshold: 0.4 });
    clear("qc-config", s);
    expect(read("qc-config", s)).toBeNull();
  });
  it("survives absent storage and corrupt JSON instead of throwing", () => {
    expect(read("x", null)).toBeNull();
    expect(write("x", { a: 1 }, null)).toBe(false);
    const s = fake();
    s.setItem("sleap-qc:v1:x", "{not json");
    expect(read("x", s)).toBeNull();
  });
  it("returns false rather than throwing when storage is full", () => {
    const s = { getItem: () => null, setItem: () => { throw new Error("QuotaExceeded"); }, removeItem: () => {} };
    expect(write("x", { a: 1 }, s)).toBe(false);
  });
  it("ignores a non-object payload (array / scalar)", () => {
    const s = fake();
    s.setItem("sleap-qc:v1:x", "[1,2,3]");
    expect(read("x", s)).toBeNull();
  });
});

describe("merge validation", () => {
  it("restores known keys and reports them", () => {
    const { config, restored, dropped } = merge(DEFAULTS, { threshold: 0.42, mode: "min" });
    expect(config.threshold).toBe(0.42);
    expect(config.mode).toBe("min");
    expect(restored.sort()).toEqual(["mode", "threshold"]);
    expect(dropped).toEqual([]);
  });
  it("DROPS keys that no longer exist (renamed/removed detector)", () => {
    const { config, dropped } = merge(DEFAULTS, { threshold: 0.4, oldDetector: true });
    expect(config).not.toHaveProperty("oldDetector");
    expect(dropped).toContain("oldDetector");
  });
  it("DROPS a key whose stored type changed", () => {
    const { config, dropped } = merge(DEFAULTS, { threshold: "0.4" }); // string, not number
    expect(config.threshold).toBe(0.7);                                 // default kept
    expect(dropped).toContain("threshold");
  });
  it("merges `checks` key-wise: a NEW detector keeps its default, a removed one is ignored", () => {
    const { config, dropped } = merge(DEFAULTS, { checks: { anomaly: false, retired: true } });
    expect(config.checks.anomaly).toBe(false); // user's choice honoured
    expect(config.checks.gmm).toBe(true);      // untouched default
    expect(config.checks.sam).toBe(false);     // NEW detector -> shipped default, not dropped
    expect(config.checks).not.toHaveProperty("retired");
    expect(dropped).toContain("checks.retired");
  });
  it("never mutates the defaults object", () => {
    const d = structuredClone(DEFAULTS);
    merge(d, { threshold: 0.1, checks: { anomaly: false } });
    expect(d).toEqual(DEFAULTS);
  });
  it("empty / null / garbage storage yields pristine defaults", () => {
    for (const bad of [null, undefined, {}, "nope", 5]) {
      expect(merge(DEFAULTS, bad).config).toEqual(DEFAULTS);
    }
  });
  it("loadConfig reads and merges in one step", () => {
    const s = fake();
    write("k", { mode: "min", bogus: 1 }, s);
    const { config, dropped } = loadConfig("k", DEFAULTS, s);
    expect(config.mode).toBe("min");
    expect(dropped).toEqual(["bogus"]);
  });
});
