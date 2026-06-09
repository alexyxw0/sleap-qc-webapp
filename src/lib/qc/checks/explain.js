// Port of sleap/qc/results.py — turn raw feature contributions into a human-readable
// "what does QC think is wrong" (top issue), plus confidence + top contributors.

// Scale raw features to a comparable ~0-5 range before picking the dominant one.
const SCALE_FACTORS = {
  max_centroid_distance: 30.0,
  centroid_distance_std: 10.0,
  nn_distance: 10.0,
  max_curvature: 1.0,
  curvature_std: 1.0,
  visibility_rate: 0.3,
  visibility_pattern_score: 0.3,
  has_isolated_invisible: 0.3,
  min_symmetry_consistency: 5.0,
};

const ISSUE_MAP = {
  max_edge_zscore: "Unusual edge length",
  mean_edge_zscore: "Unusual proportions",
  max_angle_zscore: "Unusual joint angle",
  mean_angle_zscore: "Unusual pose structure",
  max_pairwise_zscore: "Unusual node spacing",
  mean_pairwise_zscore: "Unusual scale",
  bbox_area_zscore: "Unusual scale",
  max_centroid_distance: "Isolated node",
  centroid_distance_std: "Inconsistent spacing",
  min_symmetry_consistency: "Likely L/R swap",
  visibility_rate: "Unusual visibility",
  has_isolated_invisible: "Isolated invisible node",
  visibility_pattern_score: "Unusual visibility pattern",
  nn_distance: "Unusual pose shape",
  max_curvature: "Unusual curvature",
  hull_area_zscore: "Unusual pose extent",
};

/** The dominant feature -> issue label. Returns { feature, issue }. */
export function topIssue(contributions) {
  const entries = contributions ? Object.entries(contributions) : [];
  if (!entries.length) return { feature: null, issue: "Unknown" };
  let best = null;
  let bestVal = -Infinity;
  for (const [feat, val] of entries) {
    // min_symmetry_consistency = 1.0 means "no symmetry info" -> ignore.
    const norm = feat === "min_symmetry_consistency" && val === 1.0 ? 0 : val / (SCALE_FACTORS[feat] ?? 1.0);
    if (norm > bestVal) {
      bestVal = norm;
      best = feat;
    }
  }
  return { feature: best, issue: ISSUE_MAP[best] ?? `High ${best}` };
}

/** Confidence bucket from the anomaly score (mirrors Python). */
export const confidence = (score) => (score > 0.8 ? "high" : score > 0.5 ? "medium" : "low");

/** Top-k contributing features (name, value), highest first. */
export const topContributions = (contributions, k = 3) =>
  Object.entries(contributions ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, k);
