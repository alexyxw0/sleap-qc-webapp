import { describe, it, expect, vi } from "vitest";

// qcStore imports the labels store at module load; stub it so this stays a pure store-logic test
// (no sleap-io, no DOM). The two appearance checks (classical/dino) read FRESH embedding stores here,
// so both are "unready" (no precomputed embeddings) — exactly the state where a bulk toggle must NOT
// pre-arm a check into a checked-but-inert row the locked per-row checkbox can't turn back off.
vi.mock("./labelsStore.svelte.js", () => ({
  store: { labels: null, frames: [], rev: 0, fileName: "", index: 0 },
}));

const { qc } = await import("./qcStore.svelte.js");

describe("appearance checks: bulk toggles never pre-arm an unready backend", () => {
  it("group enable-all enables ordinary checks but leaves an unready classical/dino OFF", () => {
    qc.setChecks(["anomaly", "classical", "dino"], true);
    expect(qc.checks.anomaly).toBe(true); // ordinary check still enables
    expect(qc.checks.classical).toBe(false); // no embeddings -> can't enable
    expect(qc.checks.dino).toBe(false);
  });

  it("solo of an unready appearance check enables nothing (and still disables the rest)", () => {
    qc.soloChecks(["dino"]);
    expect(qc.checks.dino).toBe(false);
    expect(qc.checks.anomaly).toBe(false);
  });

  it("an unready appearance check is not-ready and never pending (so it can't block a Run QC)", () => {
    expect(qc.checkReady("classical")).toBe(false);
    expect(qc.checkReady("dino")).toBe(false);
    expect(qc.checkPending("classical")).toBe(false);
    expect(qc.checkPending("dino")).toBe(false);
  });
});
