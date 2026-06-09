// QC sidecar contract (TDD stub — intentionally unimplemented; see sidecar.test.js).
//
// The sidecar is the precompute → browser handoff (QC Context.md §6): per-keypoint QC
// records keyed by (video_idx, frame_idx, track_id, node_idx) — track_id, NOT positional
// instance_idx.

const NOT_IMPL = () => {
  throw new Error("not implemented");
};

export const SUPPORTED_SCHEMA = 1;

export const REVIEW_STATES = ["unreviewed", "accepted", "rejected", "corrected", "skipped"];

// Shared reason-code vocabulary (must match the desktop sleap.qc module — QC Context §8).
export const REASON_CODES = [
  "isolated_miss", "gross_miss", "jitter", "visibility", "scale", "lr_swap",
  "duplicate", "temporal_jump", "track_swap", "reference_label_error",
];

/** Stable string key for a per-keypoint record. */
export function keypointKey(_kp) {
  return NOT_IMPL();
}

/** Parse + validate a sidecar object; fills review_state defaults; throws on invalid. */
export function parseSidecar(_obj) {
  return NOT_IMPL();
}
