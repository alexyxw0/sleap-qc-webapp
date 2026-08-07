// The Appearance tab is a checklist; the embedding pass is a job you configure and launch. appearanceRun
// is the state both halves share, so the tab's button and the window can never disagree about what is
// selected or what is running — and it is where the "which check does this arm?" mapping lives.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./labelsStore.svelte.js", () => ({
  store: { labels: null, frames: [], rev: 0, fileName: "", index: 0, skeleton: null },
}));

const { appRun, fmtEta, fmtRate } = await import("./appearanceRun.svelte.js");
const { embeddingStores } = await import("./embeddingStore.svelte.js");
const { nodeEmbeddingStores } = await import("./nodeEmbeddingStore.svelte.js");

describe("appearance run selection", () => {
  beforeEach(() => { appRun.setTab("compute"); appRun.setGran("instance"); appRun.close(); });

  it("whole instance runs the instance store and arms the whole-instance check", () => {
    expect(appRun.store).toBe(embeddingStores.dino);
    expect(appRun.checkKey).toBe("dino");
    expect(appRun.scorer).toBe("Trained SVM");
  });

  it("per keypoint runs the per-node store, scored unsupervised", () => {
    appRun.setGran("node");
    expect(appRun.store).toBe(nodeEmbeddingStores.dino);
    expect(appRun.checkKey).toBe("nodeDino");
    expect(appRun.scorer).toMatch(/kNN/);
  });

  it("the Upload tab has nothing to launch — those bundles are made offline", () => {
    appRun.setTab("upload");
    expect(appRun.store).toBeNull();
    expect(appRun.checkKey).toBe("noseAppearance");
    expect(() => appRun.run()).not.toThrow(); // must no-op, not blow up on a null store
  });

  it("Upload wins over granularity — it is a different job, not a third way to compute", () => {
    appRun.setGran("node");
    appRun.setTab("upload");
    expect(appRun.checkKey).toBe("noseAppearance");
    appRun.setTab("compute");
    expect(appRun.checkKey).toBe("nodeDino"); // granularity was remembered
  });

  it("unknown values fall back rather than producing an unresolvable selection", () => {
    appRun.setGran("nonsense");
    appRun.setTab("nonsense");
    expect(appRun.gran).toBe("instance");
    expect(appRun.tab).toBe("compute");
  });

  it("showTab raises the window on the pane asked for", () => {
    appRun.close();
    appRun.showTab("upload");
    expect(appRun.open).toBe(true);
    expect(appRun.tab).toBe("upload");
    appRun.setTab("compute");
  });

  it("the window opens and closes without touching the selection", () => {
    appRun.setGran("node");
    appRun.show();
    expect(appRun.open).toBe(true);
    appRun.close();
    expect(appRun.open).toBe(false);
    expect(appRun.gran).toBe("node");
  });
});

// One DINO worker serves both stores, so a second launch has to be refused, not queued.
describe("only one run at a time", () => {
  beforeEach(() => {
    appRun.setTab("compute"); appRun.setGran("instance");
    embeddingStores.dino.status = "idle";
    nodeEmbeddingStores.dino.status = "idle";
  });

  it("reports the running store whichever granularity started it", () => {
    expect(appRun.anyRunning).toBe(false);
    expect(appRun.activeStore).toBeNull();
    nodeEmbeddingStores.dino.status = "running";
    expect(appRun.anyRunning).toBe(true);
    expect(appRun.activeStore).toBe(nodeEmbeddingStores.dino); // even though gran is "instance"
    nodeEmbeddingStores.dino.status = "idle";
  });

  it("run() refuses while the other store is busy", () => {
    const spy = vi.spyOn(embeddingStores.dino, "run").mockResolvedValue();
    nodeEmbeddingStores.dino.status = "scoring";
    appRun.run();
    expect(spy).not.toHaveBeenCalled();
    nodeEmbeddingStores.dino.status = "idle";
    appRun.run();
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("model download counts as running — it is the slow part", () => {
    embeddingStores.dino.status = "loading-model";
    expect(appRun.running).toBe(true);
    embeddingStores.dino.status = "idle";
  });
});

// A progress bar without a rate is a spinner with extra steps. The numbers have to be real.
describe("throughput + ETA", () => {
  const es = embeddingStores.dino;

  it("derives rate and ETA from what has actually completed", () => {
    es.progress = { done: 100, total: 400, startedAt: performance.now() - 2000 };
    const p = es.pace;
    expect(p.rate).toBeGreaterThan(45);
    expect(p.rate).toBeLessThan(55); // 100 items in ~2 s
    expect(p.etaSec).toBeGreaterThan(4); // 300 left at ~50/s
    expect(p.etaSec).toBeLessThan(8);
    expect(p.frac).toBeCloseTo(0.25, 5);
  });

  it("says nothing until there is something to average", () => {
    es.progress = { done: 0, total: 400, startedAt: performance.now() };
    expect(es.pace).toBeNull(); // nothing done yet
    es.progress = { done: 5, total: 400, startedAt: performance.now() };
    expect(es.pace).toBeNull(); // elapsed < 0.75 s — a rate here would be noise
    es.progress = { done: 5, total: 0, startedAt: performance.now() - 5000 };
    expect(es.pace).toBeNull(); // no total => no ETA to give
  });

  it("ETA hits zero on the last item rather than going negative", () => {
    es.progress = { done: 400, total: 400, startedAt: performance.now() - 4000 };
    expect(es.pace.etaSec).toBe(0);
    es.progress = { done: 0, total: 0, startedAt: 0 };
  });

  it("both stores report pace the same way", () => {
    nodeEmbeddingStores.dino.progress = { done: 50, total: 200, startedAt: performance.now() - 1000 };
    expect(nodeEmbeddingStores.dino.pace.rate).toBeGreaterThan(0);
    nodeEmbeddingStores.dino.progress = { done: 0, total: 0, startedAt: 0 };
  });
});

describe("formatting", () => {
  it("ETA reads as a clock, and grows an hours field only when needed", () => {
    expect(fmtEta(0)).toBe("0:00");
    expect(fmtEta(9)).toBe("0:09");
    expect(fmtEta(75)).toBe("1:15");
    expect(fmtEta(3725)).toBe("1:02:05");
    expect(fmtEta(NaN)).toBe("—");
    expect(fmtEta(-1)).toBe("—");
  });

  it("rate keeps precision where it matters and drops it where it doesn't", () => {
    expect(fmtRate(42.7)).toBe("43/s"); // fast: decimals are noise
    expect(fmtRate(2.35)).toBe("2.4/s");
    expect(fmtRate(0.42)).toBe("0.42/s"); // slow: decimals are the whole story
    expect(fmtRate(0)).toBe("—");
    expect(fmtRate(Infinity)).toBe("—");
  });
});
