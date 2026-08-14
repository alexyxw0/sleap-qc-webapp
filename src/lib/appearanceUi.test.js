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

  it("the run window has no Backend axis — what to embed is the only first choice", () => {
    const w = read("src/lib/components/AppearanceWindow.svelte");
    expect(read("src/lib/qc/alFlow.js")).toContain("What should be embedded?");
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

  it("the whole-instance VIEWER still owns no scoring choice — that is the flow's question", () => {
    const s = code("src/lib/components/EmbeddingCheck.svelte");   // code, not comments: one records the removal
    expect(s).not.toMatch(/class="method"/);
    expect(s).not.toMatch(/setMethod\(/);   // including the old "trained" pin: see the test below
    expect(s).not.toMatch(/es\.method === "trained" \?/);
  });

  it("the scorer is selected in ONE place — the flow — however the store is reached", () => {
    // Two writers is how a viewer mounting on step ④ silently undid the answer given on step ③.
    const hits = sources()
      .filter((p) => p.includes("/components/"))
      .filter((p) => /\.setMethod\(|\.setScorer\(/.test(code(p)));
    expect(hits, `a component sets the scorer directly:\n${hits.join("\n")}`).toEqual([]);
    expect(read("src/lib/appearanceRun.svelte.js")).toMatch(/setScorer\?\.\(this\.unsupChoice\)/);
  });

  it("the scorer is ASKED now, at both granularities — it is no longer implied by the crop", () => {
    // The whole point of the scope/score split: granularity says what to embed, the score step says how
    // to score it, and whole instance is no longer stuck on the one model that shipped with the app.
    const s = read("src/lib/embeddingStore.svelte.js");
    expect(s).toMatch(/setScorer\(which\)/);
    expect(s).toMatch(/\["knn", "trained", "anomalyDino"\]\.includes\(m\)/);
    expect(read("src/lib/appearanceRun.svelte.js")).toMatch(/get scorer\(\)/);
  });

  it("the whole-instance viewer no longer re-pins the method when it mounts", () => {
    // It did, from when "trained" was the only option — and the viewer renders on the step directly
    // after the scorer is chosen, so mounting it silently undid the answer.
    const e = read("src/lib/components/EmbeddingCheck.svelte");
    expect(e).not.toMatch(/^\s*es\.setMethod\(/m);
  });

  it("the window explains the unsupervised route at both granularities", () => {
    const w = read("src/lib/components/AppearanceWindow.svelte");
    const ex = w.slice(w.indexOf("<Explain>"));
    expect(ex).toMatch(/<b>unsupervised<\/b>/i);      // whole instance
    expect(ex).toMatch(/AnomalyDINO/);
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
    expect(s).toContain("if (!this.onCompute || this.gran == null) return null;")
    expect(s).toMatch(/get onCompute\(\) \{ return this\.tab === "compute" \|\| this\.tab === "score" \|\| this\.tab === "use"; \}/);
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

  it("BOTH granularities get the score step, gated on the run having finished", () => {
    expect(w).toContain('id: "score"');
    expect(w).toMatch(/locked: !done/);
    expect(r).toMatch(/TABS = \[[^\]]*"score"[^\]]*\]/);
    // whole instance used to be a single "Embed & score" step because the bundled SVM was all it had
    expect(w).not.toMatch(/if \(appRun\.gran !== "node"\) return embed;/);
    expect(w).not.toMatch(/label: appRun\.gran === "node" \? "Embed" : "Embed & score"/);
  });

  it("and a third step for USING it — arming the check is not the same act as choosing a scorer", () => {
    expect(w).toContain('id: "use"');
    expect(r).toMatch(/TABS = \[[^\]]*"use"[^\]]*\]/);
  });

  it("names the live technique on the step, from the one label table", () => {
    expect(w).toContain("SCORE_LABEL[appRun.scoreChoice]");
    expect(w).toMatch(/SCORE_LABEL = \{[^}]*knn:[^}]*anomalyDino:[^}]*svm:/);
  });

  it("few-shot falls back to a nudge on faulty labels alone; the SVM needs both classes", () => {
    // enough is pos>0 && neg>0. The fit button appears only then; below it, the prototype nudge —
    // which needs only the faulty side — is offered instead of nothing.
    expect(w).toMatch(/\{#if sTrainable\?\.enough\}[\s\S]*?fit the SVM[\s\S]*?\{:else\}[\s\S]*?disabled=\{!sTrainable\?\.pos\}[\s\S]*?nudge instead/);
    expect(w).toContain("nudge(sNode)");
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
    expect(s).toMatch(/if \(this\.anyRunning \|\| this\.tab !== "compute" \|\| this\.gran == null\) return;/);
    const before = { tab: appRun.tab, gran: appRun.gran };
    appRun.gran = "node";
    appRun.tab = "score";
    let launched = false;
    const st = appRun.store;
    const real = st.run;
    st.run = () => { launched = true; };
    appRun.run();
    st.run = real;
    Object.assign(appRun, before);
    expect(launched, "the score tab restarted the run").toBe(false);
  });
});

describe("finishing the run asks the question", () => {
  const w = read("src/lib/components/AppearanceWindow.svelte");
  it("advances to Score on the transition, not on every open", () => {
    expect(w).toContain("let wasDone = $state(false);");
    expect(w).toMatch(/if \(done && !wasDone && appRun\.tab === "compute" && !appRun\.anyRunning\) appRun\.setTab\("score"\)/);
  });
  it("the step ticks on a scorer having been CHOSEN, which is the thing the step is for", () => {
    expect(w).toMatch(/done: !!appRun\.scoreChoice, locked: !done/);
    expect(w).toContain("SCORE_LABEL[appRun.scoreChoice]");
  });
});

// "The score tab should not have to be manually clicked" — the run's end is a branching QUESTION that
// asks itself, and each answer routes the next one. kNN | SVM -> upload | few-shot -> the proofreader.
describe("the scoring question asks itself and branches", () => {
  const w = read("src/lib/components/AppearanceWindow.svelte");
  const r = read("src/lib/appearanceRun.svelte.js");

  it("holds each answer in its own field, null until answered", () => {
    expect(r).toContain("scoreKind = $state(null);");
    expect(r).toContain("unsupChoice = $state(null);");
    expect(r).toContain("scoreNode = $state(null);");
    expect(r).toContain("svmSource = $state(null);");
    // ...and the old three-way answer is DERIVED from them, so there is no fourth field to disagree
    expect(r).toMatch(/get scoreChoice\(\) \{/);
    expect(r).not.toMatch(/scoreChoice = \$state/);
  });

  it("the technique is asked in two halves, so neither page carries three cards", () => {
    // Three techniques on one screen is three actions. Unsupervised-or-supervised, THEN which one.
    expect(w).toContain("appRun.setScoreKind(");
    expect(w).toContain("appRun.setUnsupChoice(");
    expect(w).toContain("appRun.setSvmSource(");
    const flow = read("src/lib/qc/alFlow.js");
    expect(flow).toContain('id: "score.kind"');
    expect(flow).toContain('id: "score.unsup"');
    expect(flow).toContain('id: "score.source"');
  });

  it("abandoning the supervised branch drops its answers, so re-entering asks again", async () => {
    const { appRun } = await import("./appearanceRun.svelte.js");
    appRun.setGran("node");
    appRun.setScoreKind("sup");
    appRun.setScoreNode(1);
    appRun.setSvmSource("fewshot");
    appRun.setScoreKind("unsup");
    expect(appRun.svmSource).toBeNull();
    expect(appRun.scoreNode).toBeNull();
    appRun.setScoreKind(null);
  });

  it("every branch has a way back — none is a dead end", async () => {
    const { appRun } = await import("./appearanceRun.svelte.js");
    const { allComputeStates, flowPage } = await import("./qc/alFlow.js");
    expect(r).toContain("unaskScore()");
    // Not "there is a back button somewhere" — replay every reachable page and demand that back
    // actually MOVES, and lands somewhere the model recognises.
    for (const st of allComputeStates()) {
      appRun.setRoute("compute");
      appRun.gran = st.gran; appRun.tab = st.step === "embed" ? "compute" : st.step;
      appRun.scoreKind = st.scoreKind; appRun.unsupChoice = st.unsupChoice;
      appRun.scoreNode = st.scoreNode; appRun.svmSource = st.svmSource;
      const from = appRun.flow.id;
      expect(appRun.canBack, from).toBe(true);
      appRun.back();
      // The first page's back leaves the route entirely — that is the fork, not a flow page.
      if (from === "scope") { expect(appRun.route, "scope did not step out to the fork").toBeNull(); continue; }
      expect(appRun.flow.id, `back from ${from} went nowhere`).not.toBe(from);
      expect(flowPage({ ...st, gran: appRun.gran, step: appRun.step, scoreKind: appRun.scoreKind,
        unsupChoice: appRun.unsupChoice, scoreNode: appRun.scoreNode, svmSource: appRun.svmSource }).id).toBeTruthy();
    }
    appRun.clearRoute();
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
    expect(r).toMatch(/this\.scoreKind = null; this\.unsupChoice = null; this\.scoreNode = null; this\.svmSource = null;\s*\n\s*this\.store\?\.run\(\);/);
  });
});

// Two things the flow got wrong once it existed: the question was below a fold of embed settings that
// step ① had already finished with, and having FIT a model there was no way to turn the detector on
// without leaving the window for the Appearance tab.
describe("the question is the pane, and it can arm the check itself", () => {
  const w = read("src/lib/components/AppearanceWindow.svelte");

  it("every pane is selected by the flow model's page id — not by re-deriving the state in markup", () => {
    // Two places deciding "which pane" is how the score pane once reported the bundle route's store.
    expect(w).toContain("{@const page = appRun.flow}");
    for (const id of ["scope", "embed", "score.kind", "score.unsup", "score.source",
                      "score.node", "score.done", "score.upload", "score.label", "score.keep", "use"]) {
      expect(w, id).toContain(`page.id === "${id}"`);
    }
  });

  it("no answer to a question is ever un-pickable", () => {
    // AnomalyDINO was rendered `disabled` when the run carried no patch features — which is exactly the
    // state a warm cache from before patch features puts you in, and the only way to GET them is the
    // recompute toggle behind that button: a locked door whose key is in the room. Answering is always
    // allowed; cost is explained after. The choice snippet has no disabled path at all now.
    const snip = w.slice(w.indexOf("{#snippet choice("), w.indexOf("{/snippet}"));
    expect(snip).toContain("class=\"sopt\"");
    expect(snip, "an option card was disabled").not.toMatch(/<button[^>]*\bdisabled=/);
  });

  it("the zero-patch-features state names itself and offers the recompute", () => {
    // Distinct from a PARTIAL shortfall: with none at all, every group silently falls back to kNN,
    // so the panel must say that rather than imply AnomalyDINO is running.
    expect(w).toContain("No patch features in this run");
    expect(w).toContain("recompute them on the next run");
    expect(w).toContain("bind:checked={es.requirePatches}");
  });

  it("picking the keypoint is its own page — it was a second question sharing one screen", () => {
    const flow = read("src/lib/qc/alFlow.js");
    expect(flow).toContain('id: "score.node"');
    expect(w).toContain("onclick={() => pickScoreNode(ch.node)}");
    // and the graph follows the keypoint being trained, so the inspector is not showing another one
    expect(w).toMatch(/function pickScoreNode\(ni\) \{[\s\S]{0,200}?es\.selectedNode = ni;/);
    expect(w).not.toContain("Pick a keypoint in the graph below");
    // a keypoint already scored by something other than the default kNN says so on its chip
    expect(w).toContain("SCORE_BADGE[ch.mode]");
    // ...and every non-default scorer has a badge, or a chip would silently claim to be kNN
    expect(w).toMatch(/SCORE_BADGE = \{[^}]*anomalyDino:[^}]*svm:[^}]*fewshot:/);
    expect(w).not.toMatch(/SCORE_BADGE = \{[^}]*\bknn:/); // kNN is the default: no badge
  });

  it("arming the check is its own terminal step, and appears exactly once", () => {
    // It used to be repeated at the foot of every scoring sub-page, which is what made each of those
    // pages three actions instead of two.
    expect(read("src/lib/qc/alFlow.js")).toContain("Use it as a detection check");
    expect(w).toContain("qc.toggleCheck(appRun.checkKey)");
    expect(w.match(/qc\.toggleCheck\(appRun\.checkKey\)/g)).toHaveLength(1);
    expect(w).toMatch(/page\.id === "use"[\s\S]{0,900}?checked=\{armed\}/);
    // and it arms the check for whichever granularity is loaded, rather than naming one
    expect(w).not.toContain('qc.toggleCheck("nodeDino")');
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

// The nav's back button must be wired to the one-step walker, not to the fork jump. The behaviour
// itself is in appearanceRun.test.js, where the store can actually be driven.
// Picking an unsupervised scorer settles the BASELINE; a trained boundary layers on top of it per
// keypoint. The UI has to say so, and — the bug — must not report the supervised route as already
// finished just because the baseline is no longer kNN.
describe("a fitted model can be taken back off", () => {
  const win = () => read("src/lib/components/AppearanceWindow.svelte");

  it("offers the revert wherever a model is applied", () => {
    const w = win();
    // both routes that apply one: fitting here, and uploading a model
    expect((w.match(/revert\(sNode, sName\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(w).toContain("es.clearTrainedModel(ni)");
  });

  it("names the baseline it returns to, rather than saying 'revert'", () => {
    const w = win();
    expect(w).toMatch(/revert to \{baselineLabel\}/);
    // and the label is derived from whichever unsupervised scorer is live, at either granularity
    expect(w).toMatch(/const baselineLabel = \$derived\([\s\S]{0,200}?"AnomalyDINO" : "kNN"\)/);
  });

  it("says the labels survive — reverting is not un-judging", () => {
    expect(win()).toMatch(/the model is gone, the labels are not/);
  });

  it("only shows it when there IS a model", async () => {
    // Now a property of the flow model rather than of a lookbehind in the markup: the revert action is
    // listed only on pages whose state has a model applied. An earlier version of this test matched a
    // nearby ternary instead of the guard, and passed with the guard deleted.
    const { allComputeStates, flowPage } = await import("./qc/alFlow.js");
    let withModel = 0;
    for (const st of allComputeStates()) {
      const ids = flowPage(st).actions.map((a) => a.id);
      if (ids.includes("revert")) { expect(st.trained, `revert offered on ${flowPage(st).id}`).toBe(true); withModel++; }
    }
    expect(withModel, "no page offers a revert at all").toBeGreaterThanOrEqual(2);
  });
});

describe("unsupervised and supervised compose", () => {
  const win = () => read("src/lib/components/AppearanceWindow.svelte");

  it("'trained' means a model was FITTED, not merely that the scorer is not kNN", () => {
    // `scoredMode !== "knn"` was true the moment a third unsupervised scorer existed, so choosing
    // AnomalyDINO read as "trained" and the supervised route looked closed. The store answers now.
    const r = read("src/lib/appearanceRun.svelte.js");
    expect(r).toMatch(/return m === "svm" \|\| m === "fewshot";/);
    expect(r, "still deciding 'trained' by exclusion").not.toMatch(/!== "knn"/);
  });

  it("the unsupervised confirmation offers the supervised layer directly", async () => {
    // Choosing kNN or AnomalyDINO settles the BASELINE, not the question: a trained boundary is a
    // per-keypoint override on top, so it stays one action away rather than a back-and-re-answer.
    const { flowPage } = await import("./qc/alFlow.js");
    const done = flowPage({ route: "compute", gran: "node", step: "score", scoreKind: "unsup",
      unsupChoice: "knn", scoreNode: null, svmSource: null, trained: false });
    expect(done.id).toBe("score.done");
    expect(done.actions.map((a) => a.id)).toContain("addSvm");
    expect(win()).toMatch(/stays the baseline for every keypoint you do not train/);
  });

  it("the SVM branch says it overrides one keypoint, not the file", () => {
    expect(win()).toMatch(/overrides <b>\{sName\}<\/b> only/);
  });
});

describe("the flow nav goes back one step", () => {
  it("is wired to back(), not clearRoute()", () => {
    const w = read("src/lib/components/AppearanceWindow.svelte");
    const nav = w.slice(w.indexOf('class="f-back"'), w.indexOf('class="f-back"') + 400);
    expect(nav).toContain("appRun.back()");
    expect(nav, "the nav back still jumps to the fork").not.toContain("clearRoute()");
    expect(nav, "the button does not say where it goes").toContain("appRun.backLabel");
  });
});

// Picking 3 of 13 keypoints was 13 clicks; dropping the rest was 10. Dragging across the chips
// selects or deselects a run of them.
describe("drag across the keypoint chips", () => {
  const win = () => read("src/lib/components/AppearanceWindow.svelte");

  it("the drag is a RANGE from its anchor, so sweeping back undoes it", () => {
    // The first chip decides the direction AND anchors the range; the selection is re-derived from
    // (anchor, current) on every move. Painting could only ADD to what it had touched, so a sweep
    // forward and back left everything selected — the reverse stroke was a no-op.
    const w = win();
    expect(w).toMatch(/function paintStart\(ni, isOn, e\) \{[\s\S]{0,240}?paint = !isOn;/);
    expect(w).toContain("anchor = ni;");
    expect(w).toMatch(/baseline = new Set\(picked \?\? allNodes\.map/);   // the PRE-drag state
    expect(w).toContain("rangeSelection(baseline, anchor, lastHit, paint)");
    expect(w).toMatch(/paintMove = \(e\) => \{ if \(paint !== null\) paintAt\(e\.clientX, e\.clientY\); \}/);
  });

  it("straying off the chips holds the range instead of collapsing it", () => {
    // A drag that dips below the row on its way across must not undo everything behind it.
    const w = win();
    expect(w).toContain("if (i >= 0) lastHit = Number(els[i].dataset.ni);");
    expect(w).toMatch(/if \(lastHit >= 0\) writeNodes\(/);
  });

  it("the drag state is fully reset when it ends", () => {
    // A stale anchor or baseline would make the NEXT drag re-derive from the wrong starting point.
    expect(win()).toContain("paintEnd = () => { paint = null; anchor = -1; baseline = null; lastHit = -1; };");
  });

  it("hit-tests with a tolerance instead of waiting to enter a chip", () => {
    // The chips are small and the gaps are real: relying on pointerenter meant a drag along the row
    // skipped whichever chip the pointer happened to pass between. It now takes the NEAREST chip
    // within a slop, which is what makes the drag forgiving.
    const w = win();
    expect(w).toContain("onpointerdown={(e) => paintStart(ni, on, e)}");
    expect(w).toContain("onpointermove={paintMove}");
    expect(w).toContain("nearestChip(");
    expect(w).toMatch(/data-ni=\{ni\}/);          // the hit test needs to map a rect back to a node
    expect(w).toMatch(/const SLOP = \d+;/);
  });

  it("captures on the ROW, so the drag keeps its events after leaving it", () => {
    // Capture on a CHIP would have been wrong when siblings had to receive enters. With hit-testing
    // the opposite is true: we want every move, including outside the row, and we decide what is hit.
    const w = win();
    expect(w).toMatch(/chipRow\?\.setPointerCapture\?\.\(e\.pointerId\)/);
    expect(w).toContain("onlostpointercapture={paintEnd}");
  });

  it("a drag released anywhere stops painting", () => {
    // Release outside the chips is the common case — the pointer leaves the row on the way out.
    expect(win()).toMatch(/<svelte:window onpointerup=\{paintEnd\} onpointercancel=\{paintEnd\} \/>/);
  });

  it("dragging paints instead of scrolling on touch", () => {
    expect(win()).toMatch(/class="chips"[^>]*style:touch-action="none"/);
  });

  it("the chips are big enough to aim at", () => {
    // 0.62rem text in 0.1rem padding is roughly a 10px-tall target — under any sane minimum, and the
    // reason the drag needed a 12px rescue at all. The tolerance treats the symptom; size treats the
    // cause, and the two are meant to work together.
    const w = win();
    const chip = w.slice(w.indexOf("  .kchip {"), w.indexOf("  .kchip.on"));
    const px = (m) => Number(m[1]);
    expect(px(chip.match(/font-size: ([\d.]+)rem/)), "chip text is still tiny").toBeGreaterThanOrEqual(0.7);
    expect(px(chip.match(/padding: ([\d.]+)rem/)), "chip padding is still hairline").toBeGreaterThanOrEqual(0.2);
    expect(chip, "no floor on the target height").toMatch(/min-height: [\d.]+rem/);
  });

  it("still works from the keyboard", () => {
    // The chips lost their onclick to pointerdown; without this a keyboard user could not toggle one.
    const w = win();
    expect(w).toMatch(/onkeydown=\{\(e\) => \{ if \(e\.key === " " \|\| e\.key === "Enter"\)/);
    expect(w).toContain("aria-pressed={on}");
  });
});
