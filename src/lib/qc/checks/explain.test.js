import { describe, it, expect } from "vitest";
import { topIssue, confidence, topContributions } from "./explain.js";

describe("topIssue", () => {
  it("maps the dominant feature to a readable issue", () => {
    expect(topIssue({ max_edge_zscore: 7.2, max_angle_zscore: 1.0 })).toMatchObject({
      feature: "max_edge_zscore",
      issue: "Unusual edge length",
    });
  });

  it("normalizes raw-distance features before comparing (scale factors)", () => {
    // raw 40 / 30 = 1.33 beats a 1.0σ z-score after scaling
    expect(topIssue({ max_centroid_distance: 40, max_edge_zscore: 1.0 }).issue).toBe("Isolated node");
    // but a 2σ z-score (2/1) beats 40/30 = 1.33
    expect(topIssue({ max_centroid_distance: 40, max_edge_zscore: 2.0 }).feature).toBe("max_edge_zscore");
  });

  it("ignores the no-symmetry sentinel (min_symmetry_consistency == 1.0)", () => {
    expect(topIssue({ min_symmetry_consistency: 1.0, max_edge_zscore: 0.5 }).feature).toBe("max_edge_zscore");
  });

  it("falls back to 'High <feature>' for unmapped features and 'Unknown' when empty", () => {
    expect(topIssue({ hull_compactness: 9 }).issue).toBe("High hull_compactness");
    expect(topIssue({}).issue).toBe("Unknown");
  });
});

describe("confidence", () => {
  it("buckets the score", () => {
    expect(confidence(0.99)).toBe("high");
    expect(confidence(0.6)).toBe("medium");
    expect(confidence(0.2)).toBe("low");
  });
});

describe("topContributions", () => {
  it("returns the top-k features highest-first", () => {
    expect(topContributions({ a: 1, b: 5, c: 3 }, 2)).toEqual([["b", 5], ["c", 3]]);
  });
});
