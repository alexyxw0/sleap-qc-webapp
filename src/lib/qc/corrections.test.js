import { describe, it, expect } from "vitest";
import { loadSlp, saveSlpToBytes } from "@talmolab/sleap-io.js";
import { fileURLToPath } from "node:url";
import { findInstance, applyCorrection } from "./corrections.js";

// Real tracked predictions fixture (2 tracks: track_0 / track_1).
const FIX = fileURLToPath(new URL("./fixtures/tracked-preds.slp", import.meta.url));
const load = (src) => loadSlp(src, { openVideos: false });
const firstFrame = (labels) => [...labels.labeledFrames].sort((a, b) => a.frameIdx - b.frameIdx)[0];

describe("corrections (sleap-io.js integration, keyed by track)", () => {
  it("findInstance matches the instance with the given track", async () => {
    const labels = await load(FIX);
    const lf = firstFrame(labels);
    const track_id = lf.instances[0].track.name;
    const inst = findInstance(labels, { video_idx: 0, frame_idx: lf.frameIdx, track_id });
    expect(inst).toBe(lf.instances[0]);
    expect(findInstance(labels, { video_idx: 0, frame_idx: lf.frameIdx, track_id: "nope" })).toBeNull();
  });

  it("applyCorrection moves the keypoint and it survives save → reload", async () => {
    const labels = await load(FIX);
    const lf = firstFrame(labels);
    const track_id = lf.instances[0].track.name;
    const correction = { video_idx: 0, frame_idx: lf.frameIdx, track_id, node_idx: 0, xy: [123.5, 67.25] };

    expect(applyCorrection(labels, correction)).toBe(true);
    const moved = findInstance(labels, correction).points[0];
    expect(moved.xy[0]).toBeCloseTo(123.5, 3);
    expect(moved.xy[1]).toBeCloseTo(67.25, 3);
    expect(moved.visible).toBe(true);

    const bytes = await saveSlpToBytes(labels);
    const reloaded = await load(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    const rinst = findInstance(reloaded, {
      video_idx: 0,
      frame_idx: firstFrame(reloaded).frameIdx,
      track_id,
    });
    expect(rinst.points[0].xy[0]).toBeCloseTo(123.5, 3);
  });

  it("returns false for an unknown track", async () => {
    const labels = await load(FIX);
    const lf = firstFrame(labels);
    const ok = applyCorrection(labels, {
      video_idx: 0,
      frame_idx: lf.frameIdx,
      track_id: "nope",
      node_idx: 0,
      xy: [0, 0],
    });
    expect(ok).toBe(false);
  });
});
