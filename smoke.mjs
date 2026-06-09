// Node smoke test: verify the data-model fields the UI relies on actually exist on
// real fixtures. Node uses h5wasm/node so this genuinely parses the files.
import { loadSlp } from "@talmolab/sleap-io.js";

const FIXTURES = {
  "pkg.slp (embedded)": "../sleap-io.js/tests/data/slp/minimal_instance.pkg.slp",
  "plain .slp (preds)": "../sleap-io.js/demo/assets/demo-flies13-preds.slp",
};

for (const [label, path] of Object.entries(FIXTURES)) {
  console.log(`\n===== ${label} =====`);
  try {
    const labels = await loadSlp(path, { openVideos: true });
    const v = labels.videos?.[0];
    console.log("videos:", labels.videos?.length, "| shape:", v?.shape,
      "| embedded:", v?.hasEmbeddedImages);
    console.log("labeledFrames:", labels.labeledFrames?.length,
      "| tracks:", labels.tracks?.length, "| skeletons:", labels.skeletons?.length);

    const sk = labels.skeletons?.[0];
    console.log("skeleton.nodeNames:", sk?.nodeNames?.slice(0, 6),
      "| #edges:", sk?.edges?.length);
    if (sk?.edges?.[0]) {
      const e = sk.edges[0];
      console.log("  edge[0] source/dest -> index:",
        e.source?.name, "->", sk.index(e.source?.name),
        ",", e.destination?.name, "->", sk.index(e.destination?.name));
    }

    const lfs = [...labels.labeledFrames].sort((a, b) => a.frameIdx - b.frameIdx);
    const lf = lfs[0];
    console.log("frame[0] frameIdx:", lf?.frameIdx, "| instances:", lf?.instances?.length);
    const inst = lf?.instances?.[0];
    if (inst) {
      const p = inst.points?.[0];
      console.log("  inst[0] points:", inst.points?.length,
        "| track:", inst.track?.name ?? null, "| score:", inst.score);
      console.log("  point[0] xy:", p?.xy, "| visible:", p?.visible);
    }

    // Try pulling a frame image (embedded path)
    if (v?.hasEmbeddedImages) {
      const img = await v.getFrame(lf.frameIdx);
      console.log("  embedded getFrame ->",
        img?.constructor?.name,
        img instanceof Uint8Array ? `(${img.length} bytes)` :
          img?.width ? `(${img.width}x${img.height})` : "");
    }
    console.log("OK ✓");
  } catch (e) {
    console.log("FAILED ✗", e?.message ?? e);
  }
}
