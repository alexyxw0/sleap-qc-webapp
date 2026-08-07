// Two properties of the Appearance tab, both easy to half-undo by editing one file of several.
//
// 1. The CLASSICAL backend is gone — whole-instance and per-keypoint alike. It was wired through eight
//    files (two store registries, the backend maps, the check registry, config defaults, the variant
//    resolver, two panels' switches, the badge list), so "removed" has to mean removed everywhere: a
//    leftover key resurrects a check the UI can no longer enable, or a detector row the overlap chart
//    lists but nothing ever fills.
// 2. Each computation panel's methodology is a DROPDOWN, not always-on prose.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const SELF = "appearanceUi.test.js";
function sources(dir = "src", out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(js|svelte)$/.test(e) && e !== SELF) out.push(p);
  }
  return out;
}
const read = (p) => readFileSync(p, "utf8");
// Comments may still discuss the removed backend — one deliberately records why it went. Only CODE
// counts: a surviving string literal or object key is a live reference.
const code = (p) =>
  read(p)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const qcc = read("src/lib/components/QcChecks.svelte");

describe("the classical backend is gone", () => {
  it("no source file mentions it, and its module is deleted", () => {
    expect(existsSync("src/lib/qc/embedding/classical.js")).toBe(false);
    const hits = sources().filter((p) => /classical/i.test(code(p)));
    expect(hits, `stale classical reference in:\n${hits.join("\n")}`).toEqual([]);
  });

  it("both store registries expose DINO only", () => {
    for (const f of ["embeddingStore", "nodeEmbeddingStore"]) {
      const s = read(`src/lib/${f}.svelte.js`);
      expect(s, f).toContain("const BACKENDS = { dino: dinoBackend };");
      const reg = s.slice(Math.max(s.indexOf("export const embeddingStores"), s.indexOf("export const nodeEmbeddingStores")));
      expect(reg, f).toMatch(/dino:\s*new \w*EmbeddingStore\("dino"\)/);
    }
  });

  it("neither appearance panel offers a backend switch", () => {
    for (const n of ["EmbeddingCheck", "NodeEmbeddingCheck"]) {
      const s = read(`src/lib/components/${n}.svelte`);
      expect(s, n).not.toMatch(/class="backend"/);
      expect(s, n).toMatch(/const es = \w*[eE]mbeddingStores\.dino;/);
    }
  });

  it("the run window has no Backend axis — granularity is the only choice", () => {
    const w = read("src/lib/components/AppearanceWindow.svelte");
    expect(w).toMatch(/>Granularity</);
    expect(w).not.toMatch(/>Backend</);
  });

  it("the appearance check list has the three surviving detectors", () => {
    expect(qcc).toContain('keys: ["dino", "nodeDino", "noseAppearance"]');
    expect(read("src/lib/components/RailTabs.svelte")).toContain('["dino", "nodeDino", "noseAppearance"]');
    // the overlap chart / manual comparison read from these two — a stale key here is a phantom row
    const qs = read("src/lib/qcStore.svelte.js");
    for (const list of ["DETECTOR_LABELS", "DETECTOR_ORDER"]) {
      const line = qs.slice(qs.indexOf(`const ${list} =`), qs.indexOf("\n", qs.indexOf(`const ${list} =`)));
      expect(line, list).toContain("dino");
      expect(line, list).toContain("noseAppearance");
    }
  });
});

// The unsupervised kNN route moved: it scored ~chance on whole-animal crops, so whole-instance is
// trained-SVM only, and kNN is offered where the patch is small enough for it to discriminate.
describe("kNN is a per-keypoint option, not a whole-instance one", () => {
  it("the whole-instance store scores with the trained SVM by default", () => {
    const s = read("src/lib/embeddingStore.svelte.js");
    expect(s).toContain('method = $state("trained");');
    // the threshold default has to follow the method, or the first render flags on a kNN cutoff
    expect(s).toMatch(/threshold = \$state\(classifierInfo\(\)\?\.threshold/);
  });

  it("the whole-instance viewer offers no scoring-method choice", () => {
    const s = read("src/lib/components/EmbeddingCheck.svelte");
    expect(s).not.toMatch(/class="method"/);
    expect(s).not.toMatch(/setMethod\("knn"\)/);
    expect(s).toContain('es.setMethod("trained")'); // pinned even when opened directly / popped out
    // no leftover branch that would render kNN copy
    expect(s).not.toMatch(/es\.method === "trained" \?/);
  });

  it("nothing in the UI can select kNN for whole instance", () => {
    const hits = sources()
      .filter((p) => p.includes("/components/"))
      .filter((p) => /setMethod\(\s*["']knn["']\s*\)/.test(code(p)));
    expect(hits, `a component still selects kNN:\n${hits.join("\n")}`).toEqual([]);
    expect(read("src/lib/components/EmbeddingCheck.svelte")).toContain('es.setMethod("trained");');
  });

  it("the scorer is stated per granularity, not offered as a choice", () => {
    const w = read("src/lib/components/AppearanceWindow.svelte");
    expect(w).toMatch(/>Scorer</);
    expect(w).toMatch(/class="fixed"/);
    expect(w).not.toMatch(/setModel\(/); // no model toggle left to drift out of sync
    expect(read("src/lib/appearanceRun.svelte.js")).toMatch(/get scorer\(\)/);
  });

  it("the window explains the unsupervised route where kNN now lives", () => {
    const w = read("src/lib/components/AppearanceWindow.svelte");
    const knn = w.slice(w.indexOf("{:else}", w.indexOf("<Explain>")));
    expect(knn).toMatch(/<b>unsupervised<\/b>/i);
    expect(knn).toMatch(/k nearest patches/);
  });
});

// The Appearance TAB is a checklist. Configuring and launching a run is a job, and it belongs in its own
// window — a 312 px rail was never going to hold a granularity switch, coverage controls, a progress bar
// and three result viewers without becoming the wall of controls this replaced.
describe("the computation lives in a window, not the tab", () => {
  it("the tab has exactly one run affordance and no inline computation panels", () => {
    for (const c of ["EmbeddingCheck", "NodeEmbeddingCheck", "NoseCheck"]) {
      expect(qcc, c).not.toContain(`<${c} />`);
    }
    expect(qcc).toContain("appRun.show()");
    expect(qcc).toMatch(/class="run-dino"/);
    expect(qcc.split("class=\"run-dino\"").length - 1).toBe(1); // one button, not one per state
  });

  it("the window is mounted at App level so a run outlives the tab that launched it", () => {
    const app = read("src/App.svelte");
    expect(app).toContain("<AppearanceWindow />");
    expect(app).toContain('import AppearanceWindow from "./lib/components/AppearanceWindow.svelte"');
    // ...and not from inside the panel, which unmounts on a tab switch
    expect(read("src/lib/components/Sidebar.svelte")).not.toContain("AppearanceWindow");
  });

  it("the tab still shows progress while the window is closed", () => {
    expect(qcc).toContain("<RunProgress store={appRun.activeStore} compact />");
    expect(qcc).toContain("appRun.anyRunning");
    expect(qcc).toContain("appRun.abort()"); // stoppable without reopening the window
  });

  it("the run window shows a determinate bar with speed and ETA", () => {
    const rp = read("src/lib/components/RunProgress.svelte");
    expect(rp).toMatch(/role="progressbar"/);
    expect(rp).toMatch(/fmtRate\(pace\.rate\)/);
    expect(rp).toMatch(/fmtEta\(pace\.etaSec\)/);
    expect(rp).toMatch(/class:indet=\{!p\.total\}/); // no fake 0% before the total is known
    expect(read("src/lib/components/AppearanceWindow.svelte")).toContain("<RunProgress store={es} />");
  });

  it("both stores stamp a start time so the rate excludes the model download", () => {
    for (const f of ["embeddingStore", "nodeEmbeddingStore"]) {
      const s = read(`src/lib/${f}.svelte.js`);
      expect(s, f).toMatch(/startedAt: performance\.now\(\)/);
      expect(s, f).toContain("get pace()");
    }
  });
});

// Few-shot changes how a LOADED model scores — neither computing nor uploading, so it is its own tab.
describe("few-shot is its own tab", () => {
  it("the window offers all three panes and routes each one", () => {
    const w = read("src/lib/components/AppearanceWindow.svelte");
    for (const t of ["compute", "upload", "fewshot"]) expect(w, t).toContain(`id: "${t}"`);
    expect(w).toContain('{#if appRun.tab === "upload"}');
    expect(w).toContain('{:else if appRun.tab === "fewshot"}');
    expect(w).toContain("<FewShotPanel />");
  });

  it("only the compute tab has something to launch", () => {
    const s = read("src/lib/appearanceRun.svelte.js");
    // The bundle-route panes have nothing to launch — but "score" is on the COMPUTE route and must
    // still see its store, so this keys off the route rather than the literal tab name.
    expect(s).toContain("if (!this.onCompute) return null;")
    expect(s).toMatch(/get onCompute\(\) \{ return this\.tab === "compute" \|\| this\.tab === "score"; \}/);
    // "score" is a real pane and must be routable, but it reads a finished run rather than starting one.
    expect(s).toMatch(/TABS = \[[^\]]*"compute"[^\]]*"score"[^\]]*"upload"[^\]]*"fewshot"[^\]]*\]/);
  });

  it("the adapt controls left NoseCheck and point at the new tab", () => {
    const n = read("src/lib/components/NoseCheck.svelte");
    expect(n).not.toMatch(/setAlpha/); // the blend slider moved
    expect(n).not.toMatch(/parseKeypointLabels/); // and so did the label import
    expect(n).toContain('appRun.showTab("fewshot")');
    const f = read("src/lib/components/FewShotPanel.svelte");
    expect(f).toContain("setAlpha");
    expect(f).toContain("parseKeypointLabels");
  });

  it("the panel states its prerequisites instead of hiding the controls", () => {
    const f = read("src/lib/components/FewShotPanel.svelte");
    expect(f).toMatch(/No keypoint has both its embeddings and a model loaded/);
    expect(f).toMatch(/Load or make labels above/);
  });
});

// Panels open to their controls and results; the "how it works" prose sits behind one line.
describe("computation descriptions are dropdowns", () => {
  // The two embedding viewers no longer describe anything — the window owns the methodology now.
  const PANELS = ["AppearanceWindow", "NoseCheck"];

  it("the run window and the precomputed panel disclose their methodology through Explain", () => {
    for (const n of PANELS) {
      const s = read(`src/lib/components/${n}.svelte`);
      expect(s, n).toContain('import Explain from "./Explain.svelte"');
      expect(s, n).toMatch(/<Explain[ >]/);
    }
  });

  it("the disclosure is collapsed until asked for", () => {
    const s = read("src/lib/components/Explain.svelte");
    expect(s).toMatch(/let \{ label = "[^"]+", open = false, children \} = \$props\(\)/);
    expect(s).toMatch(/let show = \$state\(open\)/);
    expect(s).toMatch(/\{#if show\}/); // body is not in the DOM while collapsed
  });

  it("the prose really moved inside — the methodology is behind the disclosure", () => {
    // Each panel's identifying methodology sentence must sit INSIDE its Explain. Live status lines
    // (counts, thresholds, key hints) share the same .note class and legitimately stay outside, so
    // match the sentence rather than the class.
    const SIGNATURE = {
      AppearanceWindow: "DINOv2 ViT-S/14",
      NoseCheck: "precomputed keypoint bundles",
    };
    for (const n of PANELS) {
      const s = read(`src/lib/components/${n}.svelte`);
      const open = s.indexOf("<Explain>"), close = s.lastIndexOf("</Explain>");
      expect(close, n).toBeGreaterThan(open);
      const at = s.indexOf(SIGNATURE[n]);
      expect(at, `${n}: "${SIGNATURE[n]}" not found`).toBeGreaterThan(-1);
      expect(at > open && at < close, `${n}: methodology rendered outside Explain`).toBe(true);
    }
  });
});

// The compute route used to just... end. Embeddings existed, kNN had scored them, and nothing on screen
// said that a trained SVM or a few-shot nudge were the next thing to do — so they were never found.
describe("the run ends with a scoring choice, not a dead end", () => {
  const w = read("src/lib/components/AppearanceWindow.svelte");
  const r = read("src/lib/appearanceRun.svelte.js");

  it("per-keypoint gets a second step, gated on the run having finished", () => {
    expect(w).toContain('id: "score"');
    expect(w).toMatch(/locked: !appRun\.nodeDone/);
    expect(r).toMatch(/TABS = \[[^\]]*"score"[^\]]*\]/);
  });

  it("whole-instance does NOT — the bundled model is its only scorer", () => {
    expect(w).toMatch(/if \(appRun\.gran !== "node"\) return embed;/);
  });

  it("offers all three scorers and marks the live one", () => {
    for (const s of ["Unsupervised (kNN)", "Train an SVM on my labels", "Few-shot nudge"]) expect(w, s).toContain(s);
    expect(w).toContain("es.scoringOf(ni)");
    expect(w).toMatch(/class:on=\{scoredMode === "fewshot"\}/);
  });

  it("few-shot unlocks on faulty labels alone; the SVM needs both classes", () => {
    // t.enough is pos>0 && neg>0. Gating few-shot on it would hide the only option that works early.
    expect(w).toMatch(/class:locked=\{!t\.pos\}/);
    expect(w).toContain("disabled={!t.pos}");
    expect(w).toMatch(/\{t\.enough \?/); // the SVM row still reports both counts
  });

  it("says plainly that a foreign .bin cannot score these patches", () => {
    expect(w).toMatch(/cannot score these/);
    expect(w).toMatch(/fixed-pixel crops/);
  });
});

// `store`, `checkKey` and `scorer` all answer "which route is open". They were written when the compute
// route had exactly one tab, so they tested `tab === "compute"` — and the moment it grew a second step
// the score pane reported the BUNDLE route's store: a null `es`, so the pane rendered its empty state
// forever. Caught by an SSR render probe, not by a build or by these files.
describe("route-scoped getters follow the route, not one tab name", () => {
  it("the score tab still resolves the compute route's store and check", async () => {
    const { appRun } = await import("./appearanceRun.svelte.js");
    const { nodeEmbeddingStores } = await import("./nodeEmbeddingStore.svelte.js");
    const before = { tab: appRun.tab, gran: appRun.gran };
    appRun.gran = "node";
    for (const t of ["compute", "score"]) {
      appRun.tab = t;
      expect(appRun.store, t).toBe(nodeEmbeddingStores.dino);
      expect(appRun.checkKey, t).toBe("nodeDino");
    }
    for (const t of ["upload", "fewshot"]) {
      appRun.tab = t;
      expect(appRun.store, t).toBeNull();
      expect(appRun.checkKey, t).toBe("noseAppearance");
    }
    Object.assign(appRun, before);
  });

  it("but only the compute tab can launch — score reads a finished run", async () => {
    const { appRun } = await import("./appearanceRun.svelte.js");
    const s = read("src/lib/appearanceRun.svelte.js");
    expect(s).toMatch(/run\(\) \{ if \(!this\.anyRunning && this\.tab === "compute"\)/);
    const before = appRun.tab;
    appRun.tab = "score";
    let launched = false;
    const st = appRun.store;
    const real = st.run;
    st.run = () => { launched = true; };
    appRun.run();
    st.run = real;
    appRun.tab = before;
    expect(launched, "the score tab restarted the run").toBe(false);
  });
});

describe("finishing the run asks the question", () => {
  const w = read("src/lib/components/AppearanceWindow.svelte");
  it("advances to Score on the transition, not on every open", () => {
    expect(w).toContain("let wasDone = $state(false);");
    expect(w).toMatch(/if \(done && !wasDone && appRun\.tab === "compute" && !appRun\.anyRunning\) appRun\.setTab\("score"\)/);
  });
  it("the step ticks on scores existing — kNN is an answer, not a skipped step", () => {
    expect(w).toMatch(/done: appRun\.nodeDone, locked: !appRun\.nodeDone/);
    expect(w).toContain("SCORE_LABEL[scoredMode]");
  });
});
