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
