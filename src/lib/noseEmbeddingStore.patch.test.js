// p48 and p64 models now ship for the SAME datasets. Both are 384-d, so the existing `dim` guard cannot
// tell them apart — scoring p48 embeddings with a p64 model would pass silently and quietly degrade the
// result. This pins the explicit node_min check.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";

describe("model / embedding patch-size guard", () => {
  const src = readFileSync("src/lib/noseEmbeddingStore.svelte.js", "utf8");

  it("compares node_min, not just dim", () => {
    expect(src).toMatch(/e\.node_min\s*!==\s*m\.node_min/);
    expect(src).toMatch(/patch mismatch/);
  });

  it("only warns when BOTH sides declare a patch size (legacy bundles omit it)", () => {
    expect(src).toMatch(/e\.node_min\s*!=\s*null\s*&&\s*m\.node_min\s*!=\s*null/);
  });

  it("warns rather than blocking — cross-patch scoring is a legitimate experiment", () => {
    // the dim guard sets status "error" and returns; the patch guard must NOT
    const dimGuard = src.slice(src.indexOf("Dim mismatch") - 200, src.indexOf("Dim mismatch") + 200);
    expect(dimGuard).toMatch(/status\s*=\s*"error"/);
    const patchGuard = src.slice(src.indexOf("patch mismatch") - 300, src.indexOf("patch mismatch") + 200);
    expect(patchGuard).not.toMatch(/status\s*=\s*"error"/);
  });
});

// The manifest is a REGENERABLE artifact (gitignored — rebuilt by dino_probe/export_nose.py), so it is
// absent in a fresh clone. Reading it unguarded made this suite fail for anyone who had not run the
// exporter — a broken checkout reported as a broken app. Same guard as noseSplit.test.js.
const MANIFEST = "public/nose_models/index.json";
const haveManifest = existsSync(MANIFEST);
// The read must be guarded too, not just the suite: describe.skip still EXECUTES the suite body, so a
// bare readFileSync in here throws at collection time and fails the whole file rather than skipping it.
// A slot that fails to load must go QUIET. Leaving the previous bundle's scores in place while the
// header already reports the new keypoint is worse than an error: worstNodeAt/candidates then attribute
// the old model's verdicts to a keypoint it never saw.
describe("a failed or mismatched load leaves no verdicts behind", () => {
  const src2 = readFileSync("src/lib/noseEmbeddingStore.svelte.js", "utf8");

  it("#score() drops the previous scores BEFORE any of its early returns", () => {
    const body = src2.slice(src2.indexOf("#score() {"), src2.indexOf("rbfProbability("));
    const clearZ = body.indexOf("this.#frameZ = new Map();");
    const firstReturn = body.indexOf("return;");
    expect(clearZ, "#score never clears #frameZ").toBeGreaterThan(-1);
    expect(clearZ, "an early return can escape before the clear").toBeLessThan(firstReturn);
    expect(body.indexOf("this.#instProb = new Map();")).toBeLessThan(firstReturn);
  });

  it("every load catch clears them too", () => {
    for (const m of ["Embeddings load failed", "Model load failed"]) {
      let at = src2.indexOf(m);
      while (at > -1) {
        expect(src2.slice(Math.max(0, at - 280), at), `${m} does not clear #frameZ`)
          .toContain("this.#frameZ = new Map();");
        at = src2.indexOf(m, at + 1);
      }
    }
  });

  it("the few-shot annotation goes with them — it describes a blend that no longer exists", () => {
    const body = src2.slice(src2.indexOf("#score() {"), src2.indexOf("rbfProbability("));
    expect(body).toContain("this.fewShotInfo = null;");
  });
});

(haveManifest ? describe : describe.skip)("served model manifest", () => {
  const idx = haveManifest ? JSON.parse(readFileSync(MANIFEST, "utf8")) : { models: [] };
  it("every model declares the fields the UI labels with", () => {
    for (const m of idx.models) {
      expect(typeof m.dataset).toBe("string");
      expect(Number.isFinite(m.node_min)).toBe(true);   // the label disambiguates on this
      expect(Number.isFinite(m.cv_roc)).toBe(true);
      expect(m.dim).toBe(384);
    }
  });
  it("dataset+patch is unique, so no two dropdown entries can read identically", () => {
    const keys = idx.models.map((m) => `${m.dataset}__p${m.node_min}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
