// A check that is enabled but has NO entry in UNIT_OF can never become "ready": checkReady resolves
// #computed[undefined] -> false, so checkPending stays true, and App.svelte's auto-rerun effect
// (`if (pendingCount > 0 && status === "done") run()`) calls run() after every completion — an INFINITE
// QC LOOP. That is exactly what adding `outOfFrame` to `checks` without registering its unit did.
// This test makes the wiring invariant explicit for every future check.
import { describe, it, expect, vi } from "vitest";

vi.mock("./labelsStore.svelte.js", () => ({
  // These fixtures are single-video, so index 0 is the whole story. The real derivation — and the
  // miss case that made the write and read sides disagree — is tested against the real module in
  // labelsStore.frameKey.test.js.
  frameKey: (f) => (f ? (f.fkey ?? `0:${f.frameIdx}`) : null),
 store: { frames: [], labels: null } }));
const { qc } = await import("./qcStore.svelte.js");

describe("check wiring invariants", () => {
  const APPEARANCE = ["dino", "nodeDino", "noseAppearance"];
  const PRODUCED_BY_RUN = new Set(["anomaly", "gmm", "chirality", "ordering", "poseSplit", "frame"]);

  it("every non-appearance check maps to a unit the runner actually produces", () => {
    const bad = Object.keys(qc.checks)
      .filter((k) => !APPEARANCE.includes(k))
      .map((k) => [k, qc.unitOf(k)])
      .filter(([, unit]) => !PRODUCED_BY_RUN.has(unit));
    // A check listed here can never become ready -> checkPending stays true -> the auto-rerun effect
    // in App.svelte calls run() after every completion, forever.
    expect(bad).toEqual([]);
  });

  it("appearance checks intentionally have NO unit (precomputed in their own panel)", () => {
    for (const k of APPEARANCE) expect(qc.unitOf(k)).toBeUndefined();
  });

  it("outOfFrame is satisfied by the frame unit (regression: it had no UNIT_OF entry)", () => {
    expect(qc.unitOf("outOfFrame")).toBe("frame");
    expect(Object.keys(qc.checks)).toContain("outOfFrame");
  });
});
