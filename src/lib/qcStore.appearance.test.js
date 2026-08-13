import { describe, it, expect, vi } from "vitest";

// qcStore imports the labels store at module load; stub it so this stays a pure store-logic test
// (no sleap-io, no DOM). The appearance checks read FRESH embedding stores here, so every one is
// "unready" (no precomputed embeddings) — exactly the state where a bulk toggle must NOT pre-arm a
// check into a checked-but-inert row the locked per-row checkbox can't turn back off.
vi.mock("./labelsStore.svelte.js", () => ({
  // These fixtures are single-video, so index 0 is the whole story. The real derivation — and the
  // miss case that made the write and read sides disagree — is tested against the real module in
  // labelsStore.frameKey.test.js.
  frameKey: (f) => (f ? (f.fkey ?? `0:${f.frameIdx}`) : null),

  store: { labels: null, frames: [], rev: 0, fileName: "", index: 0 },
}));

const { qc } = await import("./qcStore.svelte.js");

describe("appearance checks: bulk toggles never pre-arm an unready backend", () => {
  it("group enable-all enables ordinary checks but leaves the unready appearance ones OFF", () => {
    qc.setChecks(["anomaly", "dino", "nodeDino"], true);
    expect(qc.checks.anomaly).toBe(true); // ordinary check still enables
    expect(qc.checks.dino).toBe(false); // no embeddings -> can't enable
    expect(qc.checks.nodeDino).toBe(false);
  });

  it("solo of an unready appearance check enables nothing (and still disables the rest)", () => {
    qc.soloChecks(["dino"]);
    expect(qc.checks.dino).toBe(false);
    expect(qc.checks.anomaly).toBe(false);
  });

  it("an unready appearance check is not-ready and never pending (so it can't block a Run QC)", () => {
    for (const k of ["dino", "nodeDino", "noseAppearance"]) {
      expect(qc.checkReady(k), k).toBe(false);
      expect(qc.checkPending(k), k).toBe(false);
    }
  });
});
