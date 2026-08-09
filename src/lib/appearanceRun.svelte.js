// appearanceRun.svelte.js
//
// The Appearance tab used to carry its whole computation UI inline: a granularity switch, a model switch,
// coverage controls, a reference-fraction box, a run button, a progress line, and three result panels —
// all stacked in a 312 px rail. The tab is a CHECKLIST; the computation is a job you configure and launch.
// Those are different activities, so they now live in different places: the tab keeps the detector rows
// and one button, and everything about configuring/launching/watching a run happens in a floating window.
//
// This module is the state both halves read, so the button and the window can never disagree about what
// is selected or what is running.
import { embeddingStores } from "./embeddingStore.svelte.js";
import { nodeEmbeddingStores } from "./nodeEmbeddingStore.svelte.js";
import { keypointModels } from "./keypointModels.svelte.js";
import { keypointLabels } from "./keypointLabels.svelte.js";

const RUNNING = new Set(["loading-model", "running", "scoring"]);

class AppearanceRun {
  open = $state(false); // the configuration/run window

  // THE FORK. null = unanswered, which is the only value that renders the question — so no code path can
  // auto-answer it on the user's behalf. The two routes are genuinely INDEPENDENT: bringing bundles needs
  // no file and no compute, and computing needs no bundle. Neither is ever gated on the other; the only
  // real prerequisites are inside a route, and those are the ones the steps lock on.
  route = $state(null); // null | "bundle" | "compute"
  // THE BUNDLE ROUTE'S SCORING QUESTION — the same shape as the compute route's, for the same reason:
  // loading a bundle used to just end, with an "Adapt (few-shot)" tab you had to know to open.
  //   adaptChoice "as-is"  -> the bundle's own calibrated boundary, unchanged
  //               "adapt"  -> blend it toward this project, which needs labels…
  //   labelSource "csv"    -> …imported from a faulty_keypoints.csv
  //               "proofread" -> …made here, in the ranked queue
  // "asked and declined" is not derivable from the stores, so each answer needs its own field.
  adaptChoice = $state(null); // null | "as-is" | "adapt"
  labelSource = $state(null); // null | "csv" | "proofread"
  // Uploading a precomputed bundle is not a run — nothing launches, nothing has a rate, and it arms a
  // different check. Burying it under gran=node + model=pretrained made it look like a third way to
  // compute. It is a SUBTAB: "compute something here" vs "bring something you computed elsewhere".
  tab = $state("compute"); // "compute" | "upload" | "fewshot"
  // THE SCORING QUESTION, asked the moment a run finishes rather than left as a tab to discover. Two
  // levels, each null until answered, for the same reason `route` is: nothing may answer on the user's
  // behalf, and an unanswered question is the only state that renders as a question.
  //   scoreChoice "knn"    -> already applied, nothing more to do
  //                "svm"   -> where does the boundary come from?
  //   svmSource   "upload" -> a model fitted in an earlier session (svmIo.js)
  //                "fewshot" -> label ground truth here, in the proofreader, then fit
  scoreChoice = $state(null); // null | "knn" | "svm"
  svmSource = $state(null);   // null | "upload" | "fewshot"
  gran = $state("instance"); // compute only: "instance" (one crop per animal) | "node" (a patch per keypoint)

  /** Which ROUTE the open pane belongs to. The three getters below describe a route, not a pane, and
   *  `tab === "compute"` stopped being the same thing the moment the compute route grew a second step:
   *  on "score" it would have reported the bundle route's store, check and scorer. */
  get onCompute() { return this.tab === "compute" || this.tab === "score"; }

  /** The embedding store the current selection would run. Null on the bundle route — nothing to launch. */
  get store() {
    if (!this.onCompute) return null;
    return this.gran === "instance" ? embeddingStores.dino : nodeEmbeddingStores.dino;
  }

  /** The detection check this selection feeds, so the window can report whether it is armed yet. */
  get checkKey() {
    if (!this.onCompute) return "noseAppearance";
    return this.gran === "instance" ? "dino" : "nodeDino";
  }

  /** How the selection is scored. One scorer per granularity, so this is a label, not a choice. */
  get scorer() {
    if (!this.onCompute) return "Calibrated RBF-SVM bundles";
    if (this.gran === "instance") return "Trained SVM";
    return { knn: "kNN · unsupervised", svm: "Trained SVM · your labels", fewshot: "kNN + few-shot" }[
      nodeEmbeddingStores.dino.scoringOf(nodeEmbeddingStores.dino.selectedNode)
    ] ?? "kNN · unsupervised";
  }

  get running() { return RUNNING.has(this.store?.status); }
  /** Either store running: both share the DINO worker, so a second launch must be blocked, not queued. */
  get anyRunning() {
    return RUNNING.has(embeddingStores.dino.status) || RUNNING.has(nodeEmbeddingStores.dino.status);
  }
  /** Whichever store is mid-run — the button in the tab tracks it even when the window is closed. */
  get activeStore() {
    if (RUNNING.has(embeddingStores.dino.status)) return embeddingStores.dino;
    if (RUNNING.has(nodeEmbeddingStores.dino.status)) return nodeEmbeddingStores.dino;
    return null;
  }

  setGran(g) { this.gran = g === "node" ? "node" : "instance"; }
  static TABS = ["compute", "score", "upload", "fewshot"];
  setTab(t) {
    this.tab = AppearanceRun.TABS.includes(t) ? t : "compute";
    // A deep link from the checks list is an answer to the fork: someone clicking "Run DINO → Upload"
    // has chosen the bundle route by clicking. Keeps every existing showTab() call site working.
    this.route = this.tab === "compute" || this.tab === "score" ? "compute" : "bundle";
  }
  /** Answering the fork also lands you on that route's FIRST step: `tab` doubles as "which node is
   *  expanded", so leaving it behind would let route and tab describe different routes — and `store` /
   *  `checkKey` key off tab, so that contradiction reaches the QC layer. */
  setRoute(r) {
    if (r !== "bundle" && r !== "compute") { this.route = null; return; }
    this.route = r;
    this.tab = r === "bundle" ? "upload" : "compute";
  }
  /** Back to the fork. Clears nothing — the routes are independent and results are never discarded. */
  clearRoute() { this.route = null; }
  /** Jump straight to a pane — the tab's locked-check hints link here. */
  showTab(t) { this.setTab(t); this.open = true; }

  show() { this.open = true; }
  close() { this.open = false; }
  toggle() { this.open = !this.open; }

  // ---- step completion. Every one of these is a STORE fact, never a click the user made: a ✓ that can
  // tick itself (e.g. "a file is open") is exactly the false signal a gated flow exists to prevent.
  get instanceDone() { return embeddingStores.dino.hasResults; }
  get nodeDone() { return nodeEmbeddingStores.dino.hasResults; }
  get computeDone() { return this.gran === "node" ? this.nodeDone : this.instanceDone; }
  /** Both halves of at least one keypoint slot are in — the real precondition for scoring OR adapting. */
  get pairLoaded() {
    return keypointModels.slots.some((s) => s.store.info?.hasEmb && s.store.info?.hasModel);
  }
  get bundleDone() { return keypointModels.hasResults; }
  get hasLabels() { return keypointLabels.hasLabels; }
  /** Few-shot is genuinely two-part: a loaded pair AND labels. Blocking on either alone would be wrong. */
  get canAdapt() { return this.pairLoaded && this.hasLabels; }
  /** In effect, not merely available — a slider at 0 is not an adaptation. */
  get adaptLive() {
    return keypointModels.slots.some((s) => s.store.hasResults && s.store.fewShotInfo != null);
  }

  setAdaptChoice(c) {
    this.adaptChoice = c === "as-is" || c === "adapt" ? c : null;
    if (this.adaptChoice !== "adapt") this.labelSource = null; // an abandoned branch keeps no answer
  }
  setLabelSource(v) { this.labelSource = v === "csv" || v === "proofread" ? v : null; }
  /** Back up one question on the bundle route. */
  unaskAdapt() { if (this.labelSource) this.labelSource = null; else this.adaptChoice = null; }

  setScoreChoice(c) {
    this.scoreChoice = c === "knn" || c === "svm" ? c : null;
    if (this.scoreChoice !== "svm") this.svmSource = null; // an abandoned branch keeps no answer
  }
  setSvmSource(s) { this.svmSource = s === "upload" || s === "fewshot" ? s : null; }
  /** Back up one question. The only way out of a branch, so it is never a dead end. */
  unaskScore() { if (this.svmSource) this.svmSource = null; else this.scoreChoice = null; }

  /** Launching is a COMPUTE-TAB action: "score" reads a finished run and must not restart it. */
  run() {
    if (this.anyRunning || this.tab !== "compute") return;
    // The answers describe patches that are about to be replaced, exactly as the store's own trained
    // models and few-shot blends are — so the question gets asked again, unanswered, about the new ones.
    this.scoreChoice = null; this.svmSource = null;
    this.store?.run();
  }
  abort() { this.activeStore?.abort(); }
}

export const appRun = new AppearanceRun();

/** mm:ss for an ETA; hours only appear when they exist. */
export function fmtEta(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${m}:${String(ss).padStart(2, "0")}`;
}

/** Throughput, rounded to something readable rather than 0.0416666/s. */
export function fmtRate(rate) {
  if (!Number.isFinite(rate) || rate <= 0) return "—";
  if (rate >= 10) return `${Math.round(rate)}/s`;
  if (rate >= 1) return `${rate.toFixed(1)}/s`;
  return `${rate.toFixed(2)}/s`;
}
