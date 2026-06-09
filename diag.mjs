import { loadSlp } from "@talmolab/sleap-io.js";
import { readdirSync } from "node:fs";

const dirs = ["../sleap-io.js/tests/data/slp", "../sleap-io/tests/data/slp"];
const seen = new Set();
for (const d of dirs) {
  for (const f of readdirSync(d).filter(x => x.endsWith(".pkg.slp"))) {
    if (seen.has(f)) continue; seen.add(f);
    const path = d + "/" + f;
    try {
      const L = await loadSlp(path, { openVideos: true });
      const v = L.videos?.[0];
      const lfs = [...L.labeledFrames];
      console.log(`\n${f}`);
      console.log(`  labeledFrames=${lfs.length}  videos=${L.videos.length}`);
      console.log(`  video.shape=${JSON.stringify(v?.shape)}  hasEmbedded=${v?.hasEmbeddedImages}`);
      console.log(`  embeddedFrameIndices=${JSON.stringify(v?.embeddedFrameIndices)}`);
      console.log(`  labeledFrame.frameIdx values=${JSON.stringify(lfs.map(x=>x.frameIdx).slice(0,12))}`);
    } catch (e) {
      console.log(`\n${f}  -> LOAD FAILED: ${e.message}`);
    }
  }
}
