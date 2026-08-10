// The descriptor is a lossy compression of DINOv2's patch grid, and every one of its steps can be
// wrong in a way that still produces plausible-looking bytes. What has to survive compression is
// exactly one property: two crops that LOOK alike must stay close, and a crop with a locally-wrong
// region must stay far. These check that, plus the determinism the cache depends on — a descriptor
// written to IndexedDB today is compared against a fresh one next week, and a projection matrix that
// drifted between sessions would silently make every cached crop an outlier.
import { describe, it, expect } from "vitest";
import { packPatchTokens, unpackPatchTokens, projectionMatrix, tokenCount, PATCH } from "./patchTokens.js";

const D = 32;
const SIDE = 8;            // an 8×8 patch grid
const T = SIDE * SIDE;
const CFG = { grid: 4, dim: 16, seed: 7 };

/** A grid whose tokens are a smooth function of position — a stand-in for "ordinary texture". */
function grid(f = (r, c, d) => Math.sin(r * 0.7 + c * 0.3 + d * 0.11)) {
  const out = new Float32Array(T * D);
  for (let r = 0; r < SIDE; r++) {
    for (let c = 0; c < SIDE; c++) {
      for (let d = 0; d < D; d++) out[(r * SIDE + c) * D + d] = f(r, c, d);
    }
  }
  return out;
}
const cos = (a, b, off = 0) => {
  let dot = 0;
  for (let i = 0; i < b.length; i++) dot += a[off + i] * b[i];
  return dot;
};

describe("packPatchTokens", () => {
  it("emits one token per cell of the requested grid", () => {
    const d = packPatchTokens(grid(), T, D, CFG);
    expect(d).toBeInstanceOf(Int8Array);
    expect(d.length).toBe(CFG.grid * CFG.grid * CFG.dim);
    expect(tokenCount(CFG)).toBe(16);
  });

  it("is deterministic — the cache compares descriptors across sessions", () => {
    const g = grid();
    expect(Array.from(packPatchTokens(g, T, D, CFG))).toEqual(Array.from(packPatchTokens(g, T, D, CFG)));
  });

  it("refuses anything that is not a square token grid, rather than guessing", () => {
    // A wrong token count means the caller handed us something other than a ViT patch grid; binning
    // it anyway would produce confident nonsense that nothing downstream could detect.
    expect(packPatchTokens(grid(), T - 1, D, CFG)).toBeNull();
    expect(packPatchTokens(grid(), 0, D, CFG)).toBeNull();
  });

  it("bins evenly even when the output grid does not divide the input", () => {
    const d = packPatchTokens(grid(), T, D, { ...CFG, grid: 3 }); // 8 does not divide by 3
    expect(d.length).toBe(3 * 3 * CFG.dim);
    expect(Array.from(d).some((v) => v !== 0)).toBe(true);
  });

  it("never asks for a finer grid than the model gave it", () => {
    const d = packPatchTokens(grid(), T, D, { ...CFG, grid: 64 });
    expect(d.length).toBe(SIDE * SIDE * CFG.dim);
  });
});

describe("unpackPatchTokens", () => {
  it("returns unit vectors — the scorer reads a dot product AS a cosine", () => {
    const toks = unpackPatchTokens(packPatchTokens(grid(), T, D, CFG), CFG.dim);
    for (let t = 0; t < 16; t++) {
      let s = 0;
      for (let p = 0; p < CFG.dim; p++) { const v = toks[t * CFG.dim + p]; s += v * v; }
      expect(Math.sqrt(s)).toBeCloseTo(1, 5);
    }
  });
});

describe("what the compression has to preserve", () => {
  const at = (toks, t, dim) => toks.subarray(t * dim, (t + 1) * dim);

  it("two similar crops stay similar; a crop with a locally-wrong region does not", () => {
    const base = grid();
    // Same scene, slightly different — the frame-to-frame variation of a normal patch.
    const jitter = grid((r, c, d) => Math.sin(r * 0.7 + c * 0.3 + d * 0.11) + 0.02 * Math.cos(d));
    // Same scene, except the bottom-right quadrant is replaced — a keypoint landing on the wrong thing.
    const local = grid();
    for (let r = 4; r < SIDE; r++) {
      for (let c = 4; c < SIDE; c++) {
        for (let d = 0; d < D; d++) local[(r * SIDE + c) * D + d] = Math.cos(d * 2.3 + r);
      }
    }
    const [A, B, C] = [base, jitter, local].map((g) => unpackPatchTokens(packPatchTokens(g, T, D, CFG), CFG.dim));

    // The corrupted quadrant is tokens 10, 11, 14, 15 of the 4×4 grid.
    const corrupted = [10, 11, 14, 15];
    for (const t of corrupted) {
      expect(cos(A, at(C, t, CFG.dim), t * CFG.dim), `token ${t} should have moved`).toBeLessThan(0.9);
    }
    // ...and only there: the untouched half must survive compression essentially unchanged, or the
    // scorer would find "anomalies" all over a crop with one wrong corner.
    for (const t of [0, 1, 4, 5]) {
      expect(cos(A, at(C, t, CFG.dim), t * CFG.dim), `token ${t} should be intact`).toBeGreaterThan(0.99);
    }
    // Ordinary jitter must not look like a fault anywhere.
    for (let t = 0; t < 16; t++) {
      expect(cos(A, at(B, t, CFG.dim), t * CFG.dim), `jitter moved token ${t}`).toBeGreaterThan(0.98);
    }
  });

  it("keeps LOCATION — the whole point of not using the CLS token", () => {
    // Two crops with the same content in different corners must not compress to the same descriptor.
    const mk = (qr, qc) => grid((r, c, d) =>
      (r >= qr && r < qr + 4 && c >= qc && c < qc + 4) ? Math.cos(d * 2.3) : Math.sin(d * 0.11));
    const A = unpackPatchTokens(packPatchTokens(mk(0, 0), T, D, CFG), CFG.dim);
    const B = unpackPatchTokens(packPatchTokens(mk(4, 4), T, D, CFG), CFG.dim);
    expect(cos(A, at(B, 0, CFG.dim), 0)).toBeLessThan(0.9);
  });
});

describe("the projection matrix", () => {
  it("is cached and identical for the same (D, P, seed)", () => {
    expect(projectionMatrix(8, 4, 1)).toBe(projectionMatrix(8, 4, 1)); // same object: cached
    expect(Array.from(projectionMatrix(8, 4, 1))).not.toEqual(Array.from(projectionMatrix(8, 4, 2)));
  });

  it("is not degenerate — no all-zero or constant column", () => {
    const M = projectionMatrix(64, 8, PATCH.seed);
    for (let p = 0; p < 8; p++) {
      const col = [];
      for (let d = 0; d < 64; d++) col.push(M[d * 8 + p]);
      expect(new Set(col).size, `column ${p} is constant`).toBeGreaterThan(1);
    }
  });

  it("approximately preserves cosine similarity — the reason a random projection is allowed here", () => {
    const rnd = (() => { let a = 99; return () => ((a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1; })();
    const M = projectionMatrix(256, 64, PATCH.seed);
    const unit = () => {
      const v = Float32Array.from({ length: 256 }, rnd);
      let s = 0; for (const x of v) s += x * x;
      const inv = 1 / Math.sqrt(s); for (let i = 0; i < v.length; i++) v[i] *= inv;
      return v;
    };
    const proj = (v) => {
      const o = new Float32Array(64);
      for (let d = 0; d < 256; d++) for (let p = 0; p < 64; p++) o[p] += v[d] * M[d * 64 + p];
      let s = 0; for (const x of o) s += x * x;
      const inv = 1 / Math.sqrt(s); for (let i = 0; i < 64; i++) o[i] *= inv;
      return o;
    };
    let worst = 0;
    for (let trial = 0; trial < 30; trial++) {
      const a = unit(), b = unit();
      let before = 0; for (let i = 0; i < 256; i++) before += a[i] * b[i];
      const pa = proj(a), pb = proj(b);
      let after = 0; for (let i = 0; i < 64; i++) after += pa[i] * pb[i];
      worst = Math.max(worst, Math.abs(after - before));
    }
    // Johnson-Lindenstrauss at 256 -> 64: distortion of this size is expected and tolerable, because
    // the scorer only needs the RANKING of distances. A broken projection blows well past it.
    expect(worst).toBeLessThan(0.35);
  });
});
