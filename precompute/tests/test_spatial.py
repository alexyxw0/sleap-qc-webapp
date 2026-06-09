"""Runnable seam test (numpy only):
    uv run --with numpy --with pytest pytest precompute/tests/test_spatial.py -q
"""

import numpy as np
import pytest

from qc_precompute.spatial import normalize_pose, fit_node_priors, node_mahalanobis


def test_normalize_pose_is_translation_and_scale_invariant():
    pose = np.array([[0.0, 0.0], [10.0, 0.0], [5.0, 8.0]])
    moved = pose * 3.0 + np.array([100.0, -50.0])  # scale + translate
    a = normalize_pose(pose)
    b = normalize_pose(moved)
    assert np.allclose(a, b, atol=1e-6)


def test_normalize_pose_preserves_invisible_nan():
    pose = np.array([[0.0, 0.0], [np.nan, np.nan], [5.0, 8.0]])
    out = normalize_pose(pose)
    assert np.isnan(out[1]).all()
    assert not np.isnan(out[0]).any()


def test_per_node_mahalanobis_flags_the_outlier_node():
    rng = np.random.default_rng(0)
    means = np.array([[0.0, 0.0], [10.0, 0.0], [5.0, 8.0]])
    # 200 reference poses: each node a tight Gaussian around its mean.
    ref = means[None, :, :] + rng.normal(0, 0.3, size=(200, 3, 2))
    priors = fit_node_priors(np.stack([normalize_pose(p) for p in ref]))

    # Query: a typical pose, but node 2 yanked far away.
    query = means.copy()
    query[2] = [5.0, 40.0]
    d = node_mahalanobis(priors, normalize_pose(query))

    assert d.shape == (3,)
    assert np.argmax(d) == 2  # the moved node is the most anomalous
    assert d[2] > 5 * max(d[0], d[1])  # and by a wide margin


def test_invisible_query_node_scores_nan():
    rng = np.random.default_rng(1)
    means = np.array([[0.0, 0.0], [10.0, 0.0], [5.0, 8.0]])
    ref = means[None, :, :] + rng.normal(0, 0.3, size=(100, 3, 2))
    priors = fit_node_priors(np.stack([normalize_pose(p) for p in ref]))

    query = means.copy().astype(float)
    query[1] = [np.nan, np.nan]
    d = node_mahalanobis(priors, normalize_pose(query))
    assert np.isnan(d[1])
    assert not np.isnan(d[0])
