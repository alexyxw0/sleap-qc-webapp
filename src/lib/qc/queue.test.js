import { describe, it, expect } from "vitest";
import { buildQueue, pendingQueue, nextPending } from "./queue.js";
import { keypointKey } from "./sidecar.js";

// Minimal keypoints; only the fields the queue needs.
const kp = (track_id, frame_idx, node_idx, p_error) => ({
  video_idx: 0,
  frame_idx,
  track_id,
  node_idx,
  node_name: `n${node_idx}`,
  p_error,
});

const KPS = [
  kp("track_0", 0, 0, 0.1),
  kp("track_0", 1, 0, 0.9),
  kp("track_1", 0, 0, 0.5),
  kp("track_1", 1, 0, 0.5), // tie with the one above
];

describe("buildQueue", () => {
  it("orders worst-first by p_error (descending)", () => {
    const q = buildQueue(KPS);
    expect(q.map((k) => k.p_error)).toEqual([0.9, 0.5, 0.5, 0.1]);
  });

  it("breaks ties deterministically by keypointKey", () => {
    const a = buildQueue(KPS).map(keypointKey);
    const b = buildQueue([...KPS].reverse()).map(keypointKey);
    expect(a).toEqual(b); // same order regardless of input order
  });

  it("does not mutate the input array", () => {
    const input = [...KPS];
    buildQueue(input);
    expect(input).toEqual(KPS);
  });
});

describe("pendingQueue / nextPending", () => {
  const stateMap = new Map();
  const stateOf = (key) => stateMap.get(key) ?? "unreviewed";

  it("excludes decided keypoints and keeps worst-first order", () => {
    stateMap.clear();
    stateMap.set(keypointKey(KPS[1]), "accepted"); // the 0.9 one
    const q = pendingQueue(KPS, stateOf);
    expect(q.map((k) => k.p_error)).toEqual([0.5, 0.5, 0.1]);
  });

  it("orders unreviewed before skipped", () => {
    stateMap.clear();
    stateMap.set(keypointKey(KPS[1]), "skipped"); // 0.9 skipped -> deprioritized
    const q = pendingQueue(KPS, stateOf);
    expect(q[q.length - 1].p_error).toBe(0.9); // skipped sinks to the back
    expect(q[0].p_error).toBe(0.5);
  });

  it("nextPending returns the top pending keypoint, null when all decided", () => {
    stateMap.clear();
    expect(nextPending(KPS, stateOf).p_error).toBe(0.9);
    for (const k of KPS) stateMap.set(keypointKey(k), "accepted");
    expect(nextPending(KPS, stateOf)).toBeNull();
  });
});
