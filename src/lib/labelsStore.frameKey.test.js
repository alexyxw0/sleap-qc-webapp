// "videoIdx:frameIdx" is the key EVERY per-frame lookup joins on: QC scores, embedding caches, and —
// the one that broke — the proofreading labels. labelsStore stamps it once at load, and six other
// places re-derived it. The derivations agreed except on one case, and that case is the whole bug:
//
//   stamp:      `${vOrder.get(f.video) ?? 0}:${frameIdx}`      -> 0 when the video is not in the list
//   re-derive:  `${videos.indexOf(f.video) ?? 0}:${frameIdx}`  -> -1, because ?? does not catch -1
//
// So a label WRITTEN under "0:12:0" was READ back under "-1:12:0", found nothing, and the SVM fitter
// reported zero labels on a file that plainly had them.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { frameKey, store } from "./labelsStore.svelte.js";

const vidA = { filename: "a.mp4" };
const vidB = { filename: "b.mp4" };
const orphan = { filename: "gone.mp4" };   // a video object not in labels.videos

beforeEach(() => { store.labels = { videos: [vidA, vidB] }; });

describe("frameKey", () => {
  it("uses the stamped key when there is one — that is the authority", () => {
    expect(frameKey({ fkey: "1:42", video: vidA, frameIdx: 9 })).toBe("1:42");
  });

  it("derives videoIdx:frameIdx when nothing is stamped", () => {
    expect(frameKey({ video: vidA, frameIdx: 12 })).toBe("0:12");
    expect(frameKey({ video: vidB, frameIdx: 12 })).toBe("1:12");
  });

  it("falls back to video 0 for an unknown video — NOT -1", () => {
    // THE regression. `indexOf` returns -1 and `?? 0` does not catch it, so the read side used a key
    // the write side never wrote. Both sides now answer 0, whatever that video is.
    expect(frameKey({ video: orphan, frameIdx: 12 })).toBe("0:12");
    expect(frameKey({ video: orphan, frameIdx: 12 })).not.toContain("-1");
  });

  it("agrees with the stamp labelsStore writes, including on the miss", () => {
    // The stamp, verbatim from labelsStore: `${vOrder.get(f.video) ?? 0}:${f.frameIdx}`.
    const vOrder = new Map(store.labels.videos.map((v, i) => [v, i]));
    const stamp = (f) => `${vOrder.get(f.video) ?? 0}:${f.frameIdx}`;
    for (const v of [vidA, vidB, orphan]) {
      const f = { video: v, frameIdx: 7 };
      expect(frameKey(f), `video ${v.filename}`).toBe(stamp(f));
    }
  });

  it("survives a missing labels object rather than throwing into a render", () => {
    store.labels = null;
    expect(frameKey({ video: vidA, frameIdx: 3 })).toBe("0:3");
    expect(frameKey(null)).toBeNull();
    expect(frameKey(undefined)).toBeNull();
  });
});

describe("no module re-derives the label key any more", () => {
  it("the label read paths join on frameKey, not on their own indexOf", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
    for (const f of ["./nodeEmbeddingStore.svelte.js", "./framePass.svelte.js"]) {
      const src = read(f);
      // every keypointLabels lookup in these files goes through the At-form, which takes the key
      expect(src, `${f} still calls the (video, frame, inst) form`).not.toMatch(/keypointLabels\.is(Reviewed|Bad)\(/);
      // ...and the key handed to it is not re-derived on the spot. Passing a locally-built key to the
      // At-form is the SAME bug wearing the new API, so the derivation itself has to be absent.
      expect(src, `${f} re-derives the video index`).not.toMatch(/videos\??\.indexOf/);
      expect(src).toContain("frameKey(");
    }
  });
});
