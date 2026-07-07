// Export QC results as CSV, matching the columns/order of the reference `qc_results.csv`:
// one row per scored instance — identity + anomaly score/confidence/top-issue + the 18 raw
// feature contributions. Kept pure (string in/out) so it's unit-testable; the store gathers
// the records and the download lives in qcStore.downloadCsv.

import { topIssue, confidence } from "./checks/explain.js";

// The 18 feature columns in `qc_results.csv` order. Values come from each instance's raw
// `contributions`; every column name equals the contribution key EXCEPT `hull_area`, which the
// reference CSV uses for the `hull_area_zscore` contribution (the value is the z-score either way).
const FEATURE_COLS = [
  "max_edge_zscore", "mean_edge_zscore", "max_angle_zscore", "mean_angle_zscore",
  "max_pairwise_zscore", "mean_pairwise_zscore", "bbox_area_zscore",
  "max_centroid_distance", "centroid_distance_std", "min_symmetry_consistency",
  "visibility_rate", "has_isolated_invisible",
  "max_curvature", "curvature_std", "visibility_pattern_score", "nn_distance",
  "hull_area", "hull_compactness",
];
const CONTRIB_KEY = { hull_area: "hull_area_zscore" }; // CSV column -> contributions key (only this differs)

// Chain-ordering metrics (come from the ordering unit, not the feature `contributions`). Appended
// last, matching the desktop's V3 feature order; 0 when the ordering check wasn't computed.
const ORDERING_COLS = ["order_inversion_rate", "chain_intersection_count"];

export const QC_CSV_HEADER = [
  "video_idx", "frame_idx", "instance_idx", "score", "confidence", "top_issue", ...FEATURE_COLS, ...ORDERING_COLS,
  "frame_flagged", // whether the instance's frame was ultimately flagged (with the active checks/thresholds)
];

// RFC-4180 minimal quoting: wrap in quotes (and double internal quotes) only when needed.
const csvField = (v) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const num = (v) => (Number.isFinite(v) ? v : 0); // missing / NaN / Inf -> 0 (matches the reference)
// Render like the reference's numpy floats: full precision, but a whole number keeps a ".0"
// (1 -> "1.0") so score + feature columns read as floats. Indices stay plain integers.
const fnum = (v) => {
  const n = num(v);
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
};

/**
 * records: `[{ videoIdx, frameIdx, instIdx, score, contributions }]` -> CSV string (header + rows).
 * `confidence` and `top_issue` are derived from `score` / `contributions` exactly as the UI does.
 */
export function qcResultsCsv(records) {
  const lines = [QC_CSV_HEADER.join(",")];
  for (const r of records) {
    const c = r.contributions ?? {};
    const s = num(r.score);
    lines.push([
      r.videoIdx, r.frameIdx, r.instIdx,
      fnum(s), confidence(s), csvField(topIssue(c).issue),
      ...FEATURE_COLS.map((col) => fnum(c[CONTRIB_KEY[col] ?? col])),
      fnum(r.orderInversion), fnum(r.chainIntersection),
      r.frameFlagged ? "True" : "False",
    ].join(","));
  }
  return lines.join("\n");
}
