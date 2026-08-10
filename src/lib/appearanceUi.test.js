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
    const order = qs.slice(qs.indexOf("const DETECTOR_ORDER ="), qs.indexOf("\n", qs.indexOf("const DETECTOR_ORDER =")));
    for (const k of ["dino", "noseAppearance"]) expect(order, k).toContain(k);
    // The labels the overlap chart and the manual comparison read now come from ONE map, so the three
    // appearance keys are present by construction rather than by three hand-copied strings.
    expect(qs).toMatch(/DETECTOR_LABELS = \{[^\n]*\.\.\.Object\.fromEntries\(Object\.entries\(APPEARANCE_LABELS\)/);
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

  it("the adapt controls left NoseCheck for good", () => {
    const n = read("src/lib/components/NoseCheck.svelte");
    expect(n).not.toMatch(/setAlpha/); // the blend slider moved
    expect(n).not.toMatch(/parseKeypointLabels/); // and so did the label import
    // ...and so did the shortcut INTO the adapt step: step 2 asks the question itself now, so a link
    // that lands mid-question was a second, worse entry into it.
    expect(n).not.toContain('appRun.showTab("fewshot")');
    const f = read("src/lib/components/FewShotPanel.svelte");
    expect(f).toContain("setAlpha");
    // The CSV import moved to a shared ingest — the bundle route's scoring prompt offers it too, and a
    // second copy of "parse, ingest, rescore" is a second place to forget the rescore.
    expect(f).toContain("ingestLabelCsv");
    expect(read("src/lib/keypointModels.svelte.js")).toContain("export async function ingestLabelCsv");
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

  it("names both techniques and reports which is live", () => {
    for (const t of ["kNN · unsupervised", "SVM · supervised"]) expect(w, t).toContain(t);
    expect(w).toContain("es.scoringOf(ni)");
    expect(w).toContain("SCORE_LABEL[scoredMode]");
  });

  it("few-shot falls back to a nudge on faulty labels alone; the SVM needs both classes", () => {
    // t.enough is pos>0 && neg>0. The fit button appears only then; below it, the prototype nudge —
    // which needs only the faulty side — is offered instead of nothing.
    expect(w).toMatch(/\{#if t\.enough\}[\s\S]*?fit the SVM[\s\S]*?\{:else\}[\s\S]*?disabled=\{!t\.pos\}[\s\S]*?nudge instead/);
    expect(w).toContain("nudge(ni)");
  });

  it("says plainly that a foreign .bin cannot score these patches", () => {
    expect(w).toMatch(/Only a model exported here fits/);
    expect(w).toMatch(/fixed pixel box/);
    // and the parser refuses one rather than scoring with it
    expect(read("src/lib/qc/embedding/svmIo.js")).toMatch(/cannot score these patches/);
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
    expect(s).toMatch(/if \(this\.anyRunning \|\| this\.tab !== "compute"\) return;/);
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

// "The score tab should not have to be manually clicked" — the run's end is a branching QUESTION that
// asks itself, and each answer routes the next one. kNN | SVM -> upload | few-shot -> the proofreader.
describe("the scoring question asks itself and branches", () => {
  const w = read("src/lib/components/AppearanceWindow.svelte");
  const r = read("src/lib/appearanceRun.svelte.js");

  it("holds two levels of answer, each null until answered", () => {
    expect(r).toContain("scoreChoice = $state(null);");
    expect(r).toContain("svmSource = $state(null);");
  });

  it("Q1 is the technique; Q2 only exists under SVM", () => {
    expect(w).toContain("Which detection technique");
    expect(w).toMatch(/appRun\.setScoreChoice\("knn"\)/);
    expect(w).toMatch(/appRun\.setScoreChoice\("svm"\)/);
    // Q2 renders only after "svm" — it sits in the {:else if} chain past the knn branch
    expect(w.indexOf('appRun.scoreChoice === "knn"')).toBeLessThan(w.indexOf("Where does the boundary come from"));
    expect(w).toMatch(/appRun\.setSvmSource\("upload"\)/);
    expect(w).toMatch(/appRun\.setSvmSource\("fewshot"\)/);
  });

  it("abandoning the SVM branch drops its answer, so re-entering asks again", async () => {
    const { appRun } = await import("./appearanceRun.svelte.js");
    appRun.setScoreChoice("svm");
    appRun.setSvmSource("fewshot");
    appRun.setScoreChoice("knn");
    expect(appRun.svmSource).toBeNull();
    appRun.setScoreChoice(null);
  });

  it("every branch has a way back — none is a dead end", () => {
    expect(r).toContain("unaskScore()");
    expect(w.match(/appRun\.unaskScore\(\)/g).length).toBeGreaterThanOrEqual(4);
  });

  it("few-shot opens the proofreader that produces the labels it needs", () => {
    expect(w).toContain("keypointLabels.proofreading = true;");
    expect(w).toContain('proofreadWindow.showTab("frames")');
    // ...and refuses when the ranking it would show does not exist yet
    expect(w).toContain("disabled={!qc.proofreadReady}");
  });

  it("the few-shot branch ends in a fit and an export, not just labelling", () => {
    expect(w).toContain("es.trainFor(ni)");
    expect(w).toContain("es.applyTrainedModel(ni, clf)");
    expect(w).toContain("exportModel(clf,");
    expect(w).toContain("importModel(await f.text()");
  });

  it("a new run re-asks — the answers described the patches it replaced", () => {
    expect(r).toMatch(/this\.scoreChoice = null; this\.svmSource = null;\s*\n\s*this\.store\?\.run\(\);/);
  });
});

// Two things the flow got wrong once it existed: the question was below a fold of embed settings that
// step ① had already finished with, and having FIT a model there was no way to turn the detector on
// without leaving the window for the Appearance tab.
describe("the question is the pane, and it can arm the check itself", () => {
  const w = read("src/lib/components/AppearanceWindow.svelte");

  it("the score pane is its own tab branch — no embed config above it", () => {
    expect(w).toContain('{:else if appRun.tab === "score" && appRun.gran === "node"}');
    // ...and it comes BEFORE the config section in the chain, so it is the first thing rendered
    expect(w.indexOf('appRun.tab === "score"')).toBeLessThan(w.indexOf("1 — WHAT TO EMBED"));
  });

  it("picking the keypoint happens in the question, not in the graph below it", () => {
    expect(w).toContain('<span class="kp-l">Keypoint</span>');
    expect(w).toContain("(es.selectedNode = ch.node)");
    expect(w).not.toContain("Pick a keypoint in the graph below");
    // a keypoint already scored by something other than kNN says so on its chip
    expect(w).toMatch(/ch\.mode === "svm" \? "SVM" : "FS"/);
  });

  it("a settled answer offers the check itself", () => {
    expect(w).toContain("Use as a detection check");
    expect(w).toContain('qc.toggleCheck("nodeDino")');
    expect(w).toContain("checked={qc.checks.nodeDino}");
    // shown once a technique is chosen — not before there is anything to arm
    expect(w).toMatch(/\{#if appRun\.scoreChoice\}[\s\S]{0,400}Use as a detection check/);
  });

  it("toggleCheck really flips that check", async () => {
    const { qc } = await import("./qcStore.svelte.js");
    const before = qc.checks.nodeDino;
    qc.toggleCheck("nodeDino");
    expect(qc.checks.nodeDino).toBe(!before);
    qc.toggleCheck("nodeDino");
    expect(qc.checks.nodeDino).toBe(before);
  });

  it("the fit lives in ONE place — the results panel no longer has its own", () => {
    const n = read("src/lib/components/NodeEmbeddingCheck.svelte");
    expect(n).not.toContain("es.trainFor(");
    expect(n).not.toMatch(/class="t-go"/);
    expect(n).not.toMatch(/Train an SVM on/);
    expect(n).not.toContain("keypointLabels"); // its only reason to be imported went with it
  });

  it("the check row reports what is actually scoring it, not a fixed word", () => {
    const q = read("src/lib/components/QcChecks.svelte");
    // the hint used to open with "Unsupervised kNN:" — untrue of a keypoint the user trained
    expect(q).not.toMatch(/hint: "Unsupervised kNN/);
    expect(q).toContain("const nodeScoring = $derived.by");
    expect(q).toContain("es.scoringOf(ns.node)");
    expect(q).toMatch(/\{#if c\.key === "nodeDino" && nodeScoring\}/);
  });
});

// The three appearance rows read as three overlapping detectors because each carried four hand-written
// names — a checkbox label, a registry label, a frame chip and an overlap label — and no two agreed.
// They are three GRANULARITIES of one idea, and they now say so in one place.
describe("the appearance checks are named once", () => {
  const qs = read("src/lib/qcStore.svelte.js");
  const qcc2 = read("src/lib/components/QcChecks.svelte");

  it("one exported map is the only place the names live", () => {
    expect(qs).toContain("export const APPEARANCE_LABELS");
    for (const k of ["dino", "nodeDino", "noseAppearance"]) expect(qs, k).toMatch(new RegExp(`${k}: \\{ short:`));
    // the registry derives its label rather than repeating it
    expect(qs).toMatch(/label: APPEARANCE_LABELS\[a\.key\]\.full/);
  });

  it("no component hand-writes one of the old names", () => {
    const stale = ["Appearance · whole instance", "Per-node · DINO", "Keypoint (trained)", "Per-node (DINO)", "DINO appearance"];
    const hits = sources()
      .filter((p) => !p.endsWith(".test.js"))
      .filter((p) => stale.some((n) => code(p).includes(n)));
    expect(hits, `a hand-written appearance label survives in:\n${hits.join("\n")}`).toEqual([]);
  });

  it("short inside the Appearance group, qualified outside it", () => {
    // in the group the heading already supplies the word; in the overlap chart it sits beside Chirality
    for (const k of ["dino", "nodeDino", "noseAppearance"]) expect(qcc2, k).toContain(`APPEARANCE_LABELS.${k}.short`);
    expect(qs).toMatch(/short: "Whole instance", full: "Appearance · instance"/);
  });

  it("each hint says only what distinguishes it — the rest is in the ⓘ", () => {
    const hints = [...qcc2.matchAll(/hint: "([^"]+)"/g)].map((m) => m[1]);
    const app = hints.filter((h) => /Run DINO →/.test(h));
    expect(app.length, "each appearance hint names the pass that unlocks it").toBe(3);
    for (const h of app) expect(h.length, h).toBeLessThan(110);
  });
});


// Two gaps the flow left once it existed: the Appearance tab advertised three checks that could not be
// ticked, and the BUNDLE route ended at "loaded" with an Adapt tab you had to know to open.
describe("checks appear as they become available", () => {
  const q = read("src/lib/components/QcChecks.svelte");

  it("an appearance row renders only once its own data exists", () => {
    expect(q).toMatch(/\.filter\(\(c\) => !isAppearance\(c\.key\) \|\| qc\.checkReady\(c\.key\)\)/);
  });

  it("and the empty tab explains itself rather than showing nothing", () => {
    expect(q).toMatch(/isAppearMode && !APPEARANCE_KEYS\.some\(\(k\) => qc\.checkReady\(k\)\)/);
    expect(q).toContain("No appearance checks yet");
  });
});

describe("the bundle route is gated like the compute route", () => {
  const w = read("src/lib/components/AppearanceWindow.svelte");
  const r = read("src/lib/appearanceRun.svelte.js");

  it("holds two levels of answer, each null until answered", () => {
    expect(r).toContain("adaptChoice = $state(null);");
    expect(r).toContain("labelSource = $state(null);");
  });

  it("step ② is Score, unlocked by the PAIR — not by labels, since as-is needs none", () => {
    expect(w).toMatch(/id: "fewshot", label: "Score"[\s\S]{0,120}locked: !pair/);
  });

  it("Q1 is as-shipped vs adapt; Q2 only exists under adapt", () => {
    expect(w).toContain("Use it as shipped");
    expect(w).toContain("Adapt it to this project (few-shot)");
    expect(w).toMatch(/appRun\.setAdaptChoice\("as-is"\)/);
    expect(w).toMatch(/appRun\.setAdaptChoice\("adapt"\)/);
    expect(w.indexOf('appRun.adaptChoice === "as-is"')).toBeLessThan(w.indexOf("Few-shot needs labels"));
  });

  it("the label question routes to a CSV or to the proofreader", () => {
    expect(w).toContain("Import a faulty_keypoints.csv");
    expect(w).toContain("onchange={onAdaptCsv}");
    expect(w).toMatch(/appRun\.setLabelSource\("proofread"\); openProofreader\(\)/);
    expect(w).toContain("disabled={!qc.proofreadReady}");
  });

  it("abandoning the adapt branch drops its answer", async () => {
    const { appRun } = await import("./appearanceRun.svelte.js");
    appRun.setAdaptChoice("adapt");
    appRun.setLabelSource("csv");
    appRun.setAdaptChoice("as-is");
    expect(appRun.labelSource).toBeNull();
    appRun.setAdaptChoice(null);
  });

  it("an answer cannot outlive the bundle it describes", () => {
    expect(w).toMatch(/if \(!appRun\.pairLoaded && appRun\.adaptChoice\) appRun\.setAdaptChoice\(null\)/);
  });

  it("and it ends where the compute route does — arming the check", () => {
    expect(w).toMatch(/qc\.toggleCheck\("noseAppearance"\)/);
    expect(w).toContain("checked={qc.checks.noseAppearance}");
  });

  it("every branch that HAS somewhere to go back to offers it", () => {
    // Three: as-shipped, the label question, and the blend. The fourth branch — no pair loaded — has
    // no earlier answer to undo; it points at step ① instead, which is where the work actually is.
    expect(w.match(/appRun\.unaskAdapt\(\)/g).length).toBe(3);
    expect(w).toContain("go back to ① Load bundles");
  });
});

// The upload tab used to carry a "Few-shot → step 2 · Adapt" shortcut. Step 2 now ASKS the question —
// as-shipped or adapt, then where the labels come from — so a link that lands mid-question is a second,
// worse entry into it. And loading a bundle should carry you to that question, not leave you on a
// finished upload form.
describe("the bundle route hands off to its own question", () => {
  const nose = read("src/lib/components/NoseCheck.svelte");
  const w = read("src/lib/components/AppearanceWindow.svelte");

  it("the upload panel no longer shortcuts into step 2", () => {
    expect(nose).not.toContain('showTab("fewshot")');
    expect(nose).not.toMatch(/step 2 · Adapt/);
    expect(nose).not.toMatch(/<span class="k">Few-shot<\/span>/);
  });

  it("but it keeps the label tally and CSV export — the only working ones", () => {
    // ProofreadWindow's Labels tab is still a placeholder, so removing these would delete the only
    // path to a faulty_keypoints.csv.
    expect(nose).toContain("proofread.exportCsv()");
    expect(nose).toContain("keypointLabels.badCount");
    expect(nose).toMatch(/keypointLabels\.proofreading = !keypointLabels\.proofreading/);
  });

  it("a loaded pair advances to the scoring question, on the transition only", () => {
    expect(w).toContain("let wasPaired = $state(false);");
    expect(w).toMatch(/if \(paired && !wasPaired && appRun\.tab === "upload"\) appRun\.setTab\("fewshot"\)/);
  });

  it("which is the same shape as the compute route's advance", () => {
    expect(w).toMatch(/if \(done && !wasDone && appRun\.tab === "compute"[^)]*\) appRun\.setTab\("score"\)/);
  });
});
