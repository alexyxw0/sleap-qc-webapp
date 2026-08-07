import { describe, it, expect } from "vitest";
import { qc } from "./qcStore.svelte.js";
import { read } from "./settings.js";

describe("qcStore config persistence (integration)", () => {
  it("snapshot covers every persisted field and nothing volatile", () => {
    const snap = qc.configSnapshot();
    expect(Object.keys(snap).sort()).toEqual([
      "baselineSource", "checks", "chiralityThreshold", "confidenceMode", "confidenceThreshold",
      "featureChecks", "gmmThreshold", "instConfidenceThreshold", "orderingThreshold",
      "poseSplitThreshold", "reviewOrder", "sparseFraction", "threshold",
    ]);
    // results / transient state must NOT be persisted
    for (const k of ["status", "error", "rev"]) expect(snap).not.toHaveProperty(k);
    expect(snap.checks).toHaveProperty("outOfFrame"); // newest detector is covered
  });

  it("applyConfig round-trips through a snapshot", () => {
    qc.resetConfig();
    const before = qc.configSnapshot();
    qc.threshold = 0.11;
    qc.confidenceMode = "min";
    qc.checks.outOfFrame = false;
    const changed = qc.configSnapshot();
    expect(changed.threshold).toBe(0.11);
    expect(changed.checks.outOfFrame).toBe(false);
    qc.applyConfig(before);
    expect(qc.configSnapshot()).toEqual(before);
  });

  it("resetConfig restores shipped defaults and clears storage", () => {
    qc.threshold = 0.01;
    qc.checks.anomaly = false;
    qc.resetConfig();
    expect(qc.threshold).toBe(0.7);
    expect(qc.checks.anomaly).toBe(true);
    expect(qc.checks.outOfFrame).toBe(true);
    expect(read("qc-config")).toBeNull();
    expect(qc.configRestored).toBeNull();
  });

  it("custom per-feature checks survive a round-trip, minus their session-local id", () => {
    qc.resetConfig();
    qc.addFeatureCheck("max_edge_zscore");
    qc.addFeatureCheck("hull_area_zscore");
    qc.featureChecks[0].threshold = 2.25;                 // direct set, as the slider does
    const snap = qc.configSnapshot();
    expect(snap.featureChecks).toEqual([
      { feature: "max_edge_zscore", threshold: 2.25, on: true },
      { feature: "hull_area_zscore", threshold: 3.0, on: true },
    ]);
    expect(snap.featureChecks[0]).not.toHaveProperty("id"); // id is session-local
    qc.resetConfig();
    expect(qc.featureChecks).toEqual([]);
    qc.applyConfig(snap);
    expect(qc.featureChecks.map((f) => f.feature)).toEqual(["max_edge_zscore", "hull_area_zscore"]);
    expect(qc.featureChecks[0].threshold).toBe(2.25);
    expect(new Set(qc.featureChecks.map((f) => f.id)).size).toBe(2); // fresh, unique ids
  });

  it("rejects malformed / duplicate stored feature checks instead of trusting them", () => {
    qc.resetConfig();
    qc.applyConfig({ featureChecks: [
      { feature: "a", threshold: 2, on: true },
      { feature: "a", threshold: 9, on: true },   // duplicate feature -> collapsed
      { feature: "", threshold: 1, on: true },    // empty name -> dropped
      { threshold: 1, on: true },                 // no feature -> dropped
      { feature: "b", threshold: "x", on: "yes" },// bad types -> coerced to defaults
      null,
    ] });
    expect(qc.featureChecks.map((f) => f.feature)).toEqual(["a", "b"]);
    expect(qc.featureChecks[1].threshold).toBe(3.0);  // non-numeric -> default
    expect(qc.featureChecks[1].on).toBe(false);       // non-boolean -> false, not truthy-coerced
  });

  it("hydrateConfig is safe with nothing stored (fresh browser)", () => {
    qc.resetConfig();
    const r = qc.hydrateConfig();
    expect(r.restored).toEqual([]);
    expect(qc.threshold).toBe(0.7);
  });
});
