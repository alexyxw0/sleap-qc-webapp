import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseClassifier, rbfDecision, rbfProbability } from "./svm.js";

// PARITY: the JS RBF decision must match the Python sklearn pipeline.decision_function on the exported
// samples (dino_probe/export_to_webapp.py writes appearance_clf.{json,bin,samples.json}). Guards the port:
// a wrong scaler/gamma/sign would blow this up.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const header = JSON.parse(fs.readFileSync(path.join(HERE, "appearance_clf.json"), "utf8"));
const binBuf = fs.readFileSync(path.join(HERE, "appearance_clf.bin"));
const ab = binBuf.buffer.slice(binBuf.byteOffset, binBuf.byteOffset + binBuf.byteLength); // 4-byte aligned copy
const samples = JSON.parse(fs.readFileSync(path.join(HERE, "appearance_clf.samples.json"), "utf8")).samples;

describe("RBF-SVM JS port parity with Python", () => {
  const clf = parseClassifier(header, ab);

  it("loads the expected shape", () => {
    expect(clf.dim).toBe(384);
    expect(clf.nSv).toBeGreaterThan(1000);
    expect(clf.sv.length).toBe(clf.nSv * clf.dim);
    expect(clf.mean.length).toBe(clf.dim);
  });

  it("matches Python decision_function within float32 tolerance", () => {
    const embs = samples.map((s) => Float32Array.from(s.x));
    const dec = rbfDecision(embs, clf);
    let maxErr = 0;
    for (let i = 0; i < samples.length; i++) maxErr = Math.max(maxErr, Math.abs(dec[i] - samples[i].decision));
    expect(maxErr).toBeLessThan(1e-2); // float32 quantization of 2741 SVs; well under it in practice
  });

  it("threshold sign convention: higher decision = more faulty", () => {
    expect(typeof clf.threshold).toBe("number");
    // the 8 exported samples are clean instances (negative decisions, below threshold)
    const dec = rbfDecision(samples.map((s) => Float32Array.from(s.x)), clf);
    expect([...dec].every((d) => d < clf.threshold + 1)).toBe(true);
  });
});

// Nose per-keypoint model (dino_probe/export_nose.py): RBF-SVM + Platt calibration. Verifies both the
// decision parity AND the probability path sigmoid(plattA·decision + plattB) against Python.
const nHeader = JSON.parse(fs.readFileSync(path.join(HERE, "nose_clf.json"), "utf8"));
const nBin = fs.readFileSync(path.join(HERE, "nose_clf.bin"));
const nAb = nBin.buffer.slice(nBin.byteOffset, nBin.byteOffset + nBin.byteLength);
const nSamples = JSON.parse(fs.readFileSync(path.join(HERE, "nose_clf.samples.json"), "utf8")).samples;

describe("Nose RBF-SVM + Platt calibration parity", () => {
  const clf = parseClassifier(nHeader, nAb);

  it("carries the Platt coefficients + probability threshold", () => {
    expect(clf.dim).toBe(384);
    expect(typeof clf.plattA).toBe("number");
    expect(typeof clf.plattB).toBe("number");
    expect(clf.threshold).toBeGreaterThan(0);
    expect(clf.threshold).toBeLessThan(1); // a probability cutoff
  });

  it("decision matches Python", () => {
    const dec = rbfDecision(nSamples.map((s) => Float32Array.from(s.x)), clf);
    let e = 0;
    for (let i = 0; i < nSamples.length; i++) e = Math.max(e, Math.abs(dec[i] - nSamples[i].decision));
    expect(e).toBeLessThan(1e-2);
  });

  it("probability matches Python sigmoid(platt) and stays in [0,1]", () => {
    const p = rbfProbability(nSamples.map((s) => Float32Array.from(s.x)), clf);
    let e = 0;
    for (let i = 0; i < nSamples.length; i++) e = Math.max(e, Math.abs(p[i] - nSamples[i].prob));
    expect(e).toBeLessThan(1e-2);
    expect([...p].every((v) => v >= 0 && v <= 1)).toBe(true);
  });
});
