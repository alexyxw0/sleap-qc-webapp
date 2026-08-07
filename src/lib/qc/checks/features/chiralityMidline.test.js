// Regression tests for the two bugs that made L/R flip undetectable on a 9-node mouse skeleton:
//   1. scoreInstance's hard ">=2 co-visible pairs" floor — that skeleton has exactly ONE pair
//      (ear_l/ear_r), so the check was structurally unreachable and returned 0 for every frame.
//   2. orderMidlineByPca averaged RAW projections. A 2x2 covariance is invariant under 180-degree
//      rotation and the eigenvector sign is arbitrary, so the same body projects nose-first in one frame
//      and tail-first in the next; the means cancelled and the midline came out SCRAMBLED
//      (tail_base, body_2, body_3, neck, body_1, nose, head). A zigzag "spine" makes the nearest-segment
//      tangent — and therefore every side sign — meaningless once postures vary.
import { describe, it, expect } from "vitest";
import { ChiralityModel, resolveChiralityInputs, inferSymmetryPairsByName } from "./chirality.js";

const NAMES = ["nose", "head", "neck", "ear_l", "ear_r", "body_1", "body_2", "body_3", "tail_base"];
const SPINE = [0, 1, 2, 5, 6, 7, 8]; // nose..tail_base, ears excluded
const BASE = { nose: [0, 0], head: [0, -8], neck: [0, -16], body_1: [0, -28], body_2: [0, -40],
               body_3: [0, -52], tail_base: [0, -62], ear_l: [-9, -12], ear_r: [9, -12] };

/** Rotate by `deg`; `curl` bends the spine sideways (quadratic in arclength) like a real mouse. */
function pose(deg, { flip = false, curl = 0 } = {}) {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const b = {};
  for (const [k, [x, y]] of Object.entries(BASE)) {
    const u = -y / 62;                       // 0 at nose -> 1 at tail
    b[k] = [x + curl * u * u * 62, y];       // bend
  }
  if (flip) { const l = b.ear_l; b.ear_l = b.ear_r; b.ear_r = l; }
  return NAMES.map((n) => [b[n][0] * c - b[n][1] * s, b[n][0] * s + b[n][1] * c]);
}

describe("chirality on a single-pair skeleton, PCA-derived midline", () => {
  const clean = [];
  for (let a = 0; a < 360; a += 15) for (const curl of [-0.35, 0, 0.35]) clean.push(pose(a, { curl }));
  const inputs = resolveChiralityInputs(null, NAMES, clean);

  it("infers exactly one symmetric pair", () => {
    expect(inferSymmetryPairsByName(NAMES)).toEqual([[3, 4]]);
  });

  it("orders the midline along the spine, not scrambled", () => {
    // either direction is acceptable (fit and score share the polyline) — but it must be monotone
    const seq = JSON.stringify(inputs.midlineIndices);
    expect([JSON.stringify(SPINE), JSON.stringify([...SPINE].reverse())]).toContain(seq);
  });

  it("flags a flipped pair at every orientation AND curl; never flags a clean one", () => {
    const m = new ChiralityModel().fit(clean, inputs);
    expect(m.nLearnedPairs).toBe(1);
    const missed = [], falsePos = [];
    for (let a = 0; a < 360; a += 15) {
      for (const curl of [-0.35, 0, 0.35]) {
        if (m.scoreInstance(pose(a, { flip: true, curl })).wrongFraction < 1) missed.push([a, curl]);
        if (m.scoreInstance(pose(a, { curl })).wrongFraction > 0) falsePos.push([a, curl]);
      }
    }
    expect(missed).toEqual([]);      // bug 1 + 2: previously every one of these scored 0
    expect(falsePos).toEqual([]);    // a curled-but-correct animal must not read as flipped
  });

  it("still abstains when the single pair lies along the midline (sign is noise)", () => {
    const m = new ChiralityModel().fit(clean, inputs);
    const amb = pose(0);
    amb[3] = [0.5, -14];
    amb[4] = [-0.5, -20];            // ears strung along the spine, not across it
    expect(m.scoreInstance(amb).wrongFraction).toBe(0);
  });
});

// Both REAL reported frames, pinned together so a future precision/recall tweak can't silently trade one
// for the other. Coordinates read off the two screenshots.
describe("the two reported frames", () => {
  const NM = ["nose", "head", "neck", "ear_l", "ear_r", "body_1", "body_2", "body_3", "tail_base"];
  const mk = (o) => NM.map((n) => o[n]);
  // frame 1: ears genuinely SWAPPED — pair straddles the spine cleanly (offsets -110 / +84)
  const SWAPPED = mk({ nose: [460, 730], head: [500, 627], neck: [465, 490], body_1: [392, 332],
    body_2: [307, 190], body_3: [195, 65], tail_base: [120, -10], ear_l: [362, 530], ear_r: [568, 553] });
  const CORRECT = mk({ ...Object.fromEntries(NM.map((n, i) => [n, SWAPPED[i]])), ear_l: [568, 553], ear_r: [362, 530] });
  // frame 2: CORRECT labels, but curled with the head turned — both ears end up on ONE side of the spine
  // (offsets -15 / -99, ear_l practically on the head->neck segment). Must ABSTAIN, not flip.
  const CURLED = mk({ nose: [730, 62], head: [850, 202], neck: [838, 365], body_1: [770, 492],
    body_2: [598, 543], body_3: [410, 455], tail_base: [267, 353], ear_l: [860, 277], ear_r: [935, 391] });

  const fit = (canonicalFrom) => new ChiralityModel().fit(
    Array.from({ length: 8 }, () => canonicalFrom),
    resolveChiralityInputs(null, NM, [canonicalFrom]));

  it("flags the swapped frame", () => {
    const m = fit(CORRECT);
    expect(m.scoreInstance(SWAPPED).wrongFraction).toBeCloseTo(1, 6);
  });
  it("does NOT flag the curled head-turned frame (pair does not straddle the midline)", () => {
    const m = fit(CORRECT);
    const r = m.scoreInstance(CURLED);
    expect(r.nPairs).toBe(0);          // abstained rather than guessed
    expect(r.wrongFraction).toBe(0);
  });
  it("an ambiguous pose contributes nothing to the learned canonical side either", () => {
    // fitting ONLY on degenerate poses must leave the model with no opinion, not a coin-flip one
    const m = new ChiralityModel().fit([CURLED, CURLED], resolveChiralityInputs(null, NM, [CURLED]));
    expect(m.nLearnedPairs).toBe(0);
    expect(m.scoreInstance(SWAPPED).wrongFraction).toBe(0);
  });
});
