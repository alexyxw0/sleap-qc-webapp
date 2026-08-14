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
import { flowPage, backTargetField } from "./qc/alFlow.js";

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
  // Asked in two halves — unsupervised-or-supervised, THEN which one — because three techniques on one
  // screen is three actions, and the flow's rule is two. See qc/alFlow.js.
  //   scoreKind   "unsup" -> which unsupervised scorer?
  //               "sup"   -> a trained boundary: which keypoint, then where from?
  //   unsupChoice "knn" | "anomalyDino" — applied on selection, so choosing IS doing
  //   svmSource   "upload"  -> a model fitted in an earlier session (svmIo.js)
  //               "fewshot" -> label ground truth here, in the proofreader, then fit
  scoreKind = $state(null);   // null | "unsup" | "sup"
  unsupChoice = $state(null); // null | "knn" | "anomalyDino"
  scoreNode = $state(null);   // which keypoint a trained boundary targets (per-keypoint granularity)
  svmSource = $state(null);   // null | "upload" | "fewshot"
  /** The old three-way answer, now DERIVED: every call site that asked "which technique" still gets one
   *  value, and there is no second field that can disagree with the two that are actually answered. */
  get scoreChoice() {
    if (this.scoreKind === "sup") return "svm";
    return this.unsupChoice;
  }
  // null until the scope question is answered — the same rule `route` follows, and for the same reason:
  // nothing may answer on the user's behalf. It was "instance", which meant the window opened already
  // committed to a granularity that the user had not picked and that no page ever asked about.
  gran = $state(null); // null | "instance" (one crop per animal) | "node" (a patch per keypoint)

  /** Which ROUTE the open pane belongs to. The three getters below describe a route, not a pane, and
   *  `tab === "compute"` stopped being the same thing the moment the compute route grew a second step:
   *  on "score" it would have reported the bundle route's store, check and scorer. */
  get onCompute() { return this.tab === "compute" || this.tab === "score" || this.tab === "use"; }

  /** The embedding store the current selection would run. Null on the bundle route — nothing to launch —
   *  and null before the scope question is answered, which is the honest answer rather than a default. */
  get store() {
    if (!this.onCompute || this.gran == null) return null;
    return this.gran === "instance" ? embeddingStores.dino : nodeEmbeddingStores.dino;
  }

  /** The detection check this selection feeds, so the window can report whether it is armed yet. */
  get checkKey() {
    if (!this.onCompute) return "noseAppearance";
    if (this.gran == null) return null;
    return this.gran === "instance" ? "dino" : "nodeDino";
  }

  /** Which of the three compute steps the flow model should read. `tab` carries the bundle route too. */
  get step() { return this.tab === "score" ? "score" : this.tab === "use" ? "use" : "embed"; }

  /** The current page: its id, its question, and the (at most two) actions it offers. */
  get flow() {
    return flowPage({
      route: this.route, gran: this.gran, step: this.step, scoreKind: this.scoreKind,
      unsupChoice: this.unsupChoice, scoreNode: this.scoreNode, svmSource: this.svmSource,
      trained: this.targetTrained,
    });
  }

  /** Is a trained model applied to whatever the supervised branch is currently pointed at? */
  get targetTrained() {
    if (this.gran !== "node" || this.scoreNode == null) return false;
    const st = nodeEmbeddingStores.dino;
    const m = st.scoringOf?.(this.scoreNode);
    return m === "svm" || m === "fewshot";
  }

  /** How the selection is scored. One scorer per granularity, so this is a label, not a choice. */
  get scorer() {
    if (!this.onCompute) return "Calibrated RBF-SVM bundles";
    if (this.gran == null) return "—";
    if (this.gran === "instance") {
      // No longer "whatever the granularity implies": whole instance has all three scorers now, so this
      // has to report the one that is actually set.
      return { trained: "Bundled RBF-SVM", knn: "kNN · unsupervised", anomalyDino: "AnomalyDINO · unsupervised" }[
        embeddingStores.dino.method] ?? "Bundled RBF-SVM";
    }
    return { knn: "kNN · unsupervised", anomalyDino: "AnomalyDINO · unsupervised",
             svm: "Trained SVM · your labels", fewshot: "kNN + few-shot" }[
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

  /** Answering the scope question. Also the deep link from the checks list, which is why it must land
   *  on the step AFTER scope rather than leaving you on a question you just answered elsewhere. */
  setGran(g) {
    this.gran = g === "node" ? "node" : g === "instance" ? "instance" : null;
    // The scoring answers describe a granularity; carrying them across would leave "AnomalyDINO on
    // keypoints" ticked on a whole-instance run that never scored a keypoint.
    this.scoreKind = null; this.unsupChoice = null; this.scoreNode = null; this.svmSource = null;
  }
  /** Un-answer scope, back to the first question. */
  clearGran() { this.setGran(null); }
  static TABS = ["compute", "score", "use", "upload", "fewshot"];
  setTab(t) {
    this.tab = AppearanceRun.TABS.includes(t) ? t : "compute";
    // A deep link from the checks list is an answer to the fork: someone clicking "Run DINO → Upload"
    // has chosen the bundle route by clicking. Keeps every existing showTab() call site working.
    this.route = this.onCompute ? "compute" : "bundle";
  }
  /** Answering the fork also lands you on that route's FIRST step: `tab` doubles as "which node is
   *  expanded", so leaving it behind would let route and tab describe different routes — and `store` /
   *  `checkKey` key off tab, so that contradiction reaches the QC layer. */
  setRoute(r) {
    if (r !== "bundle" && r !== "compute") { this.route = null; return; }
    this.route = r;
    this.tab = r === "bundle" ? "upload" : "compute";
  }
  /** Back to the fork. Clears the SCOPE answer too — it belongs to the compute route, and leaving it set
   *  would skip the first question on the way back in. Results are never discarded. */
  clearRoute() { this.route = null; this.setGran(null); }

  /**
   * ONE step back, undoing the last answer given rather than the whole session.
   *
   * The nav offered only "‹ start", so backing out of a sub-question on step 2 threw away the route
   * and both steps with it. The flow is a stack of answers — route, then step, then question, then
   * sub-question — so back should pop exactly one, whichever was answered last.
   *
   * -> { kind: "unask" | "tab" | "route", to?, label } — `label` names the DESTINATION, so the button
   * can say where it goes instead of making you find out by pressing it. null at the fork.
   */
  get backTarget() {
    if (this.route === "bundle") {
      if (this.labelSource) return { kind: "unask", label: "labels" };
      if (this.adaptChoice) return { kind: "unask", label: "scoring" };
      if (this.tab === "fewshot") return { kind: "tab", to: "upload", label: "Load bundles" };
      return { kind: "route", label: "start" };
    }
    if (this.route === "compute") {
      // ONE source for the order of the answers — the flow model — so the button and the pages cannot
      // disagree about which one is on top of the stack.
      const field = backTargetField({
        route: this.route, gran: this.gran, step: this.step, scoreKind: this.scoreKind,
        unsupChoice: this.unsupChoice, scoreNode: this.scoreNode, svmSource: this.svmSource,
      });
      const LABEL = { svmSource: "boundary", scoreNode: "keypoint", unsupChoice: "scorer", scoreKind: "technique" };
      if (field === "route") return { kind: "route", label: "start" };
      if (field === "gran") return { kind: "unask", field: "gran", label: "what to embed" };
      if (field === "step") {
        return this.tab === "use" ? { kind: "tab", to: "score", label: "Score" }
                                  : { kind: "tab", to: "compute", label: "Embed" };
      }
      return { kind: "unask", field, label: LABEL[field] ?? "back" };
    }
    return null; // already at the fork — there is nothing behind it
  }
  get canBack() { return this.backTarget != null; }
  /** Short destination name for the button face. */
  get backLabel() { return this.backTarget?.label ?? ""; }

  back() {
    const t = this.backTarget;
    if (!t) return;
    if (t.kind === "tab") this.setTab(t.to);
    else if (t.kind === "route") this.clearRoute();
    else if (this.route === "bundle") this.unaskAdapt();
    else if (t.field === "gran") this.clearGran();
    else this[t.field] = null;   // pop exactly the one answer the model named
  }
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

  setScoreKind(k) {
    this.scoreKind = k === "unsup" || k === "sup" ? k : null;
    if (this.scoreKind !== "unsup") this.unsupChoice = null;   // an abandoned branch keeps no answer
    if (this.scoreKind !== "sup") { this.scoreNode = null; this.svmSource = null; }
    // Whole-instance supervised IS the bundled SVM and nothing else, so answering "supervised" there is
    // the whole act — there is no second question to route to, and leaving the store on an unsupervised
    // scorer would make the confirmation page a lie.
    if (this.scoreKind === "sup" && this.gran === "instance") embeddingStores.dino.setMethod("trained");
  }
  setUnsupChoice(c) {
    this.unsupChoice = c === "knn" || c === "anomalyDino" ? c : null;
    // Not just a label — picking one IS applying it. Re-scoring reuses the embeddings, so it is
    // arithmetic where re-embedding would be another half-hour of inference.
    if (this.unsupChoice) this.store?.setScorer?.(this.unsupChoice);
  }
  setScoreNode(ni) { this.scoreNode = Number.isInteger(ni) && ni >= 0 ? ni : null; }
  setSvmSource(s) { this.svmSource = s === "upload" || s === "fewshot" ? s : null; }
  /** Back up one question. The only way out of a branch, so it is never a dead end. */
  unaskScore() {
    if (this.svmSource) this.svmSource = null;
    else if (this.scoreNode != null) this.scoreNode = null;
    else if (this.unsupChoice) this.unsupChoice = null;
    else this.scoreKind = null;
  }

  /** Launching is a COMPUTE-TAB action: "score" reads a finished run and must not restart it. */
  run() {
    if (this.anyRunning || this.tab !== "compute" || this.gran == null) return;
    // The answers describe patches that are about to be replaced, exactly as the store's own trained
    // models and few-shot blends are — so the questions get asked again, unanswered, about the new ones.
    this.scoreKind = null; this.unsupChoice = null; this.scoreNode = null; this.svmSource = null;
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
