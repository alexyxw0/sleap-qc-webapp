# QC precompute (Python) — TDD scaffold

The Python precompute service that wraps `sleap.qc` and adds the new analysis seams
(spatial / temporal / calibration), emitting the browser **sidecar**. See
`scratch/QC Context.md` and `scratch/2026-06-09-qc-webapp-goal/`.

> Status: **test scaffold only** (red). Implementations are `NotImplementedError` stubs.

## Run the tests

Runnable seam (numpy only — no `sleap` needed):
```bash
uv run --with numpy --with pytest --python 3.12 pytest precompute/tests/test_spatial.py -q
```

Seam-A wrapper (BLOCKED here — needs the full `sleap` install; auto-skips otherwise):
```bash
# in an environment with sleap installed, on a supported Python:
uv run --with pytest pytest precompute/tests/test_seam_a.py -q
```

## Layout
- `qc_precompute/spatial.py` — Seam B per-node spatial prior (Mahalanobis). **Runnable.**
- `qc_precompute/seam_a.py`  — Seam A wrapper over `LabelQCDetector`. **Blocked** (needs sleap).
- `tests/` — pytest specs. `conftest.py` puts `qc_precompute` on the path.
