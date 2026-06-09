"""Seam B — egocentric per-node spatial prior (TDD stub; see tests/test_spatial.py).

Per-keypoint spatial anomaly: normalize poses to a canonical frame, fit a per-node 2D
Gaussian from the trusted reference set, then score a query node by its Mahalanobis
distance. This turns the instance-level signal into a per-keypoint one (which node is wrong).

Pure NumPy so it is testable without the full sleap stack; the real service will reuse
``sleap.qc.features.reference.normalize_pose`` for exact parity.
"""

from __future__ import annotations

import numpy as np


def normalize_pose(points: np.ndarray) -> np.ndarray:
    """Center a pose at its visible centroid and scale by its bbox diagonal.

    points: (n_nodes, 2), NaN for invisible nodes (which must be preserved). Returns a
    translation- and scale-invariant copy.
    """
    raise NotImplementedError


def fit_node_priors(reference_poses: np.ndarray) -> list:
    """Fit a 2D Gaussian per node from normalized reference poses.

    reference_poses: (N, n_nodes, 2). Returns a per-node list of (mean(2,), precision(2,2))
    estimated over visible (non-NaN) reference points only.
    """
    raise NotImplementedError


def node_mahalanobis(priors: list, pose: np.ndarray) -> np.ndarray:
    """Per-node Mahalanobis distance of `pose` (n_nodes, 2) under `priors`.

    Returns (n_nodes,) with NaN where the queried node is invisible.
    """
    raise NotImplementedError
