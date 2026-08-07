// svmIo.js — getting a locally-fitted per-keypoint SVM out of the browser and back into another session.
//
// The point of the round trip is the ONE thing the in-browser trainer could not do on its own: label a
// few frames of file A, fit there, then apply that boundary to file B without re-labelling. Uploading is
// only worth offering because this exists — before it, the only .bin a user could bring was
// export_nose.py's, which is fitted on fixed-pixel crops and cannot score patches this app cropped as a
// fraction of the instance bbox.
//
// So the file carries its CROP CONVENTION, not just its weights. Two 384-d models are not
// interchangeable; a dim check alone would let a silently-wrong pairing through, which is worse than a
// refusal because the scores still look like scores.

/** What this app's per-keypoint pass crops. A file tagged anything else was fitted on different pixels. */
export const CROP_KIND = "instance-frac";
export const FORMAT = "sleap-qc/keypoint-svm";
export const VERSION = 1;

const arr = (a) => Array.from(a ?? []);

/**
 * Serialize a fitted classifier to a self-describing JSON string.
 * `meta` records what it was fitted ON — keypoint name, file, label counts, CV score — because a boundary
 * with no provenance is unauditable six months later, and those are the fields the import UI reports back.
 */
export function exportModel(clf, meta = {}) {
  if (!clf || !Number.isFinite(clf.dim) || !Number.isFinite(clf.nSv)) throw new Error("not a fitted model");
  return JSON.stringify({
    format: FORMAT,
    version: VERSION,
    crop: meta.crop ?? CROP_KIND,
    node: meta.node ?? null,
    backend: meta.backend ?? "dino",
    fitted_on: meta.source ?? null,
    n_labels: meta.nLabels ?? null,
    n_pos: meta.nPos ?? null,
    cv_roc: meta.cvRoc ?? null,
    cv_ap: meta.cvAp ?? null,
    dim: clf.dim,
    n_sv: clf.nSv,
    gamma: clf.gamma,
    intercept: clf.intercept,
    threshold: clf.threshold ?? 0,
    platt_a: clf.plattA ?? null,
    platt_b: clf.plattB ?? null,
    mean: arr(clf.mean),
    scale: arr(clf.scale),
    dual: arr(clf.dual),
    sv: arr(clf.sv),
  });
}

/**
 * Parse a file produced by exportModel. Returns { clf, meta, warning }.
 *
 * Throws on anything that would score WRONG — a foreign format, a dimension mismatch, a different crop
 * convention, truncated arrays. Warns (and still loads) on a keypoint-name mismatch: applying a nose
 * model to an ear is a legitimate experiment, and the user can see which one they picked.
 */
export function importModel(text, { dim = null, node = null } = {}) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error("Not a JSON model file."); }
  if (j?.format !== FORMAT) {
    throw new Error(
      j?.dim === 384
        ? "That looks like a bundled appearance model (export_nose.py). It was fitted on fixed-pixel crops and cannot score these patches — load it under ‹ start → precomputed bundles instead."
        : "Not a keypoint SVM exported from this app.",
    );
  }
  if (j.version > VERSION) throw new Error(`Model format v${j.version} is newer than this app understands.`);
  if (j.crop !== CROP_KIND) throw new Error(`Fitted on "${j.crop}" crops; this pass produces "${CROP_KIND}".`);
  if (dim != null && j.dim !== dim) throw new Error(`Model is ${j.dim}-d; these embeddings are ${dim}-d.`);

  const n = j.dim, k = j.n_sv;
  const sized = { mean: n, scale: n, dual: k, sv: k * n };
  for (const [f, want] of Object.entries(sized)) {
    if (!Array.isArray(j[f]) || j[f].length !== want) throw new Error(`Model file is corrupt (${f}).`);
  }
  if (!Number.isFinite(j.gamma) || !Number.isFinite(j.intercept)) throw new Error("Model file is corrupt (header).");

  const clf = {
    dim: n, nSv: k, gamma: j.gamma, intercept: j.intercept, threshold: j.threshold ?? 0,
    plattA: j.platt_a ?? null, plattB: j.platt_b ?? null,
    mean: Float32Array.from(j.mean), scale: Float32Array.from(j.scale),
    dual: Float32Array.from(j.dual), sv: Float32Array.from(j.sv),
  };
  const warning = node && j.node && j.node !== node
    ? `Fitted on "${j.node}", applying to "${node}" — the appearance of a different keypoint.`
    : null;
  return { clf, meta: j, warning };
}

/** A filename that says what the model is without opening it. */
export function modelFilename(node, source) {
  const clean = (s) => String(s ?? "").replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_").slice(0, 40);
  return `keypoint-svm_${clean(node) || "node"}${source ? `_${clean(source)}` : ""}.json`;
}
