// The round trip is the whole reason "upload a fitted model" is offered: label once, apply everywhere.
// Its failure mode is silent — two 384-d models are shape-compatible and wholly incompatible, and a
// wrong pairing still produces numbers that look like scores. So the refusals matter more than the fit.
import { describe, it, expect } from "vitest";
import { exportModel, importModel, modelFilename, CROP_KIND, FORMAT } from "./svmIo.js";
import { fitSvm } from "./svmFit.js";
import { rbfDecision } from "./svm.js";

/** Deterministic separable blobs — same generator as svmFit.test.js, no RNG. */
function blobs(nPos, nNeg, dim = 12, sep = 2.5) {
  const rows = [], y = [];
  const rnd = (i, d) => (Math.sin(i * 12.9898 + d * 78.233) * 43758.5453) % 1;
  for (let i = 0; i < nPos + nNeg; i++) {
    const isPos = i < nPos;
    const v = new Float32Array(dim);
    for (let d = 0; d < dim; d++) v[d] = rnd(i + 1, d + 1) + (isPos && d === 0 ? sep : 0);
    rows.push(v); y.push(isPos ? 1 : -1);
  }
  return { rows, y };
}

const { rows, y } = blobs(12, 36);
const { clf } = fitSvm(rows, y);

describe("the round trip", () => {
  it("scores identically after a save and a load — not merely 'close'", () => {
    const { clf: back } = importModel(exportModel(clf, { node: "nose" }), { dim: 12, node: "nose" });
    const a = rbfDecision(rows, clf), b = rbfDecision(rows, back);
    // Float32 on the way out, so compare at that precision rather than demanding bit equality.
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 4);
  });

  it("carries the provenance the import UI reports back", () => {
    const j = JSON.parse(exportModel(clf, { node: "ear", source: "labels.slp", nLabels: 48, nPos: 12, cvRoc: 0.91 }));
    expect(j.format).toBe(FORMAT);
    expect(j.crop).toBe(CROP_KIND);
    expect(j).toMatchObject({ node: "ear", fitted_on: "labels.slp", n_labels: 48, n_pos: 12, cv_roc: 0.91 });
  });

  it("refuses to export something that is not a fitted model", () => {
    expect(() => exportModel(null)).toThrow(/not a fitted model/);
    expect(() => exportModel({ dim: 12 })).toThrow(/not a fitted model/);
  });
});

describe("what it refuses to load", () => {
  const good = exportModel(clf, { node: "nose" });

  it("a bundled export_nose.py model, by name, with somewhere to put it instead", () => {
    const foreign = JSON.stringify({ dim: 384, n_sv: 10, gamma: 0.1 });
    expect(() => importModel(foreign)).toThrow(/fixed-pixel crops/);
    expect(() => importModel(foreign)).toThrow(/precomputed bundles/);
  });

  it("a different crop convention — the failure a dim check cannot see", () => {
    const j = JSON.parse(good); j.crop = "node-min-48";
    expect(() => importModel(JSON.stringify(j))).toThrow(/node-min-48.*instance-frac|instance-frac/);
  });

  it("a dimension the embeddings cannot feed", () => {
    expect(() => importModel(good, { dim: 384 })).toThrow(/12-d; these embeddings are 384-d/);
  });

  it("a truncated or corrupt array, rather than reading past the end", () => {
    for (const f of ["mean", "scale", "dual", "sv"]) {
      const j = JSON.parse(good); j[f] = j[f].slice(0, -1);
      expect(() => importModel(JSON.stringify(j)), f).toThrow(`corrupt (${f})`);
    }
    const h = JSON.parse(good); h.gamma = null;
    expect(() => importModel(JSON.stringify(h))).toThrow(/corrupt \(header\)/);
  });

  it("a format from the future it would have to guess at", () => {
    const j = JSON.parse(good); j.version = 99;
    expect(() => importModel(JSON.stringify(j))).toThrow(/newer than this app understands/);
  });

  it("something that is not JSON at all", () => {
    expect(() => importModel("<html>nope")).toThrow(/Not a JSON model file/);
  });
});

describe("what it loads anyway, with a warning", () => {
  it("a model fitted on a DIFFERENT keypoint — a legitimate experiment, but say so", () => {
    const { clf: back, warning } = importModel(exportModel(clf, { node: "nose" }), { dim: 12, node: "tail" });
    expect(back.nSv).toBe(clf.nSv);
    expect(warning).toMatch(/"nose".*"tail"/);
  });

  it("no warning when it matches, and none when either side is anonymous", () => {
    const m = exportModel(clf, { node: "nose" });
    expect(importModel(m, { dim: 12, node: "nose" }).warning).toBeNull();
    expect(importModel(m, { dim: 12 }).warning).toBeNull();
    expect(importModel(exportModel(clf), { dim: 12, node: "nose" }).warning).toBeNull();
  });
});

describe("the filename says what it is", () => {
  it("names the keypoint and the file it was fitted on", () => {
    expect(modelFilename("nose", "gily_labels.slp")).toBe("keypoint-svm_nose_gily_labels.json");
  });
  it("survives a hostile name without producing a path", () => {
    const n = modelFilename("../../etc/passwd", "a b/c.slp");
    expect(n).not.toMatch(/[/\\]/);
    expect(n.endsWith(".json")).toBe(true);
  });
});
