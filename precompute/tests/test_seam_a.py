"""Seam-A wrapper spec — BLOCKED in this environment.

Needs the full `sleap` package (pulls sklearn, sleap_io, etc.); importing `sleap.qc`
triggers `sleap/__init__.py`. Skipped automatically when unavailable. To run:

    # in an env with sleap installed (and on a supported Python):
    uv run --with pytest pytest precompute/tests/test_seam_a.py -q
"""

import os

import pytest

pytest.importorskip("sleap.qc", reason="needs the full sleap install (sklearn, sleap_io)")
sio = pytest.importorskip("sleap_io")

from sleap.qc import LabelQCDetector  # noqa: E402
from qc_precompute.seam_a import precompute_instance_sidecar  # noqa: E402

FIXTURE = os.path.join(
    os.path.dirname(__file__), "..", "..", "src", "lib", "qc", "fixtures", "tracked-preds.slp"
)


@pytest.fixture(scope="module")
def labels():
    return sio.load_slp(FIXTURE)


def test_sidecar_has_expected_top_level_shape(labels):
    sc = precompute_instance_sidecar(labels)
    assert sc["schemaVersion"] == 1
    for key in ("video", "skeleton", "frames", "keypoints"):
        assert key in sc
    assert len(sc["keypoints"]) > 0


def test_keypoints_are_keyed_by_track_not_position(labels):
    sc = precompute_instance_sidecar(labels)
    kp = sc["keypoints"][0]
    assert "track_id" in kp and "instance_idx" not in kp
    for field in ("video_idx", "frame_idx", "node_idx", "p_error", "gmm_instance_score"):
        assert field in kp


def test_scores_are_finite_and_in_unit_range(labels):
    sc = precompute_instance_sidecar(labels)
    for kp in sc["keypoints"]:
        assert 0.0 <= kp["p_error"] <= 1.0


def test_reason_codes_use_shared_vocabulary(labels):
    vocab = {
        "isolated_miss", "gross_miss", "jitter", "visibility", "scale", "lr_swap",
        "duplicate", "temporal_jump", "track_swap", "reference_label_error",
    }
    sc = precompute_instance_sidecar(labels)
    for kp in sc["keypoints"]:
        assert set(kp.get("reason_codes", [])).issubset(vocab)
