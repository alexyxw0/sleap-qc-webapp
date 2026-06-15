"""Seam A — wrap sleap.qc.LabelQCDetector into the sidecar precompute (TDD stub).

Reuses the existing detector (fit on trusted user_instances, score), and emits the
browser sidecar. The Parity-MVP sidecar is an instance-level rollup; later seams add the
per-keypoint columns. Keys are re-mapped onto track_id, NOT positional instance_idx.

This module needs the full `sleap` package installed; its test is skipped otherwise.
"""

from __future__ import annotations


def precompute_instance_sidecar(labels, config=None) -> dict:
    """Run LabelQCDetector.fit/score on `labels`; return a sidecar dict.

    Expected shape (see src/lib/qc/fixtures/sample-sidecar.json):
      { schemaVersion, video, skeleton, frames[], keypoints[] }
    where each keypoint is keyed by (video_idx, frame_idx, track_id, node_idx) and carries
    at least gmm_instance_score + p_error (rolled to the node from the instance for the MVP)
    and reason_codes drawn from the shared vocabulary.
    """
    raise NotImplementedError
