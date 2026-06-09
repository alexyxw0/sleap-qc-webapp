import { describe, it, expect } from "vitest";
import { ReviewSession } from "./review.js";

// 10 keypoints: 6 tailtip + 4 head (distinct frames -> distinct identity).
const mk = (i, node_name) => ({
  video_idx: 0, frame_idx: i, track_id: "t", node_idx: 0, node_name, p_error: 0.5,
});
const KPS = [
  ...Array.from({ length: 6 }, (_, i) => mk(i, "tailtip")),
  ...Array.from({ length: 4 }, (_, i) => mk(10 + i, "head")),
];

describe("ReviewSession basics", () => {
  it("starts all unreviewed", () => {
    const s = new ReviewSession(KPS);
    expect(s.total).toBe(10);
    expect(s.stateOf(KPS[0])).toBe("unreviewed");
    expect(s.counts).toMatchObject({ unreviewed: 10, accepted: 0, rejected: 0, done: 0 });
  });

  it("records accept/reject/correct and counts 'done' (skip is not done)", () => {
    const s = new ReviewSession(KPS);
    s.accept(KPS[0]);
    s.reject(KPS[1]);
    s.correct(KPS[2]);
    s.skip(KPS[3]);
    expect(s.stateOf(KPS[0])).toBe("accepted");
    expect(s.stateOf(KPS[1])).toBe("rejected");
    expect(s.stateOf(KPS[2])).toBe("corrected");
    expect(s.stateOf(KPS[3])).toBe("skipped");
    expect(s.counts).toMatchObject({ accepted: 1, rejected: 1, corrected: 1, skipped: 1, done: 3 });
    expect(s.progress).toMatchObject({ done: 3, total: 10, remaining: 7 });
    expect(s.progress.fraction).toBeCloseTo(0.3, 5);
  });
});

describe("ReviewSession undo", () => {
  it("reverts only the most recent decision", () => {
    const s = new ReviewSession(KPS);
    s.accept(KPS[0]);
    s.reject(KPS[1]);
    s.undo();
    expect(s.stateOf(KPS[1])).toBe("unreviewed");
    expect(s.stateOf(KPS[0])).toBe("accepted");
    expect(s.counts.done).toBe(1);
    s.undo();
    expect(s.stateOf(KPS[0])).toBe("unreviewed");
    expect(s.counts.done).toBe(0);
  });

  it("is a no-op with empty history", () => {
    const s = new ReviewSession(KPS);
    expect(() => s.undo()).not.toThrow();
    expect(s.counts.done).toBe(0);
  });
});

describe("ReviewSession ETA", () => {
  it("estimates remaining time from decision pace", () => {
    let t = 0;
    const s = new ReviewSession(KPS, { now: () => t });
    expect(s.etaSeconds()).toBeNull(); // need >= 2 decisions
    t = 0;
    s.accept(KPS[0]);
    t = 10_000; // +10s
    s.accept(KPS[1]);
    // avg 10 s/decision, 8 remaining -> 80 s
    expect(s.etaSeconds()).toBe(80);
  });
});

describe("ReviewSession summary + systematic issues", () => {
  it("rolls up decisions per node type with reject rate", () => {
    const s = new ReviewSession(KPS);
    s.reject(KPS[0]);
    s.reject(KPS[1]);
    s.accept(KPS[2]);
    const sum = s.summary();
    expect(sum.tailtip).toMatchObject({ rejected: 2, accepted: 1, decided: 3 });
    expect(sum.tailtip.rejectRate).toBeCloseTo(2 / 3, 5);
  });

  it("flags a node type as systematic when reject-rate and count clear thresholds", () => {
    const s = new ReviewSession(KPS);
    for (let i = 0; i < 5; i++) s.reject(KPS[i]); // 5 of 6 tailtip wrong
    s.accept(KPS[5]);
    for (let i = 6; i < 10; i++) s.accept(KPS[i]); // heads fine
    const flagged = s.systematicIssues({ minCount: 5, rejectRateThreshold: 0.3 });
    const nodes = flagged.map((f) => f.node);
    expect(nodes).toContain("tailtip");
    expect(nodes).not.toContain("head");
  });
});
