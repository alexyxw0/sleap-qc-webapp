import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keypointKey, parseSidecar, SUPPORTED_SCHEMA } from "./sidecar.js";

const sample = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/sample-sidecar.json", import.meta.url)), "utf8"),
);
const clone = () => structuredClone(sample);

describe("keypointKey", () => {
  it("is stable and unique per (video, frame, track, node)", () => {
    const a = { video_idx: 0, frame_idx: 7, track_id: "track_0", node_idx: 3 };
    expect(keypointKey(a)).toBe(keypointKey({ ...a }));
    expect(keypointKey(a)).not.toBe(keypointKey({ ...a, node_idx: 2 }));
    expect(keypointKey(a)).not.toBe(keypointKey({ ...a, track_id: "track_1" }));
  });
});

describe("parseSidecar", () => {
  it("parses a valid sidecar and exposes keypoints + skeleton", () => {
    const sc = parseSidecar(clone());
    expect(sc.schemaVersion).toBe(SUPPORTED_SCHEMA);
    expect(sc.keypoints).toHaveLength(sample.keypoints.length);
    expect(sc.skeleton.nodeNames).toEqual(["head", "thorax", "abdomen", "tailtip"]);
  });

  it("defaults missing review_state to 'unreviewed' and preserves explicit ones", () => {
    const sc = parseSidecar(clone());
    const byNode = (name) => sc.keypoints.find((k) => k.node_name === name);
    expect(byNode("tailtip").review_state).toBe("unreviewed"); // absent in fixture
    expect(byNode("thorax").review_state).toBe("accepted"); // explicit in fixture
  });

  it("throws on unsupported / missing schema version", () => {
    const bad = clone();
    delete bad.schemaVersion;
    expect(() => parseSidecar(bad)).toThrow();
    expect(() => parseSidecar({ ...clone(), schemaVersion: 999 })).toThrow();
  });

  it("throws when a keypoint is missing a required field (track_id / p_error)", () => {
    const noTrack = clone();
    delete noTrack.keypoints[0].track_id;
    expect(() => parseSidecar(noTrack)).toThrow();

    const noScore = clone();
    delete noScore.keypoints[0].p_error;
    expect(() => parseSidecar(noScore)).toThrow();
  });

  it("rejects an unknown review_state value", () => {
    const bad = clone();
    bad.keypoints[0].review_state = "bogus";
    expect(() => parseSidecar(bad)).toThrow();
  });
});
