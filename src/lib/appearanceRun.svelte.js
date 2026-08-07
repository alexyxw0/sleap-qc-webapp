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

const RUNNING = new Set(["loading-model", "running", "scoring"]);

class AppearanceRun {
  open = $state(false); // the configuration/run window
  // Uploading a precomputed bundle is not a run — nothing launches, nothing has a rate, and it arms a
  // different check. Burying it under gran=node + model=pretrained made it look like a third way to
  // compute. It is a SUBTAB: "compute something here" vs "bring something you computed elsewhere".
  tab = $state("compute"); // "compute" | "upload" | "fewshot"
  gran = $state("instance"); // compute only: "instance" (one crop per animal) | "node" (a patch per keypoint)

  /** The embedding store the current selection would run. Null on the upload tab — nothing to launch. */
  get store() {
    if (this.tab !== "compute") return null;
    return this.gran === "instance" ? embeddingStores.dino : nodeEmbeddingStores.dino;
  }

  /** The detection check this selection feeds, so the window can report whether it is armed yet. */
  get checkKey() {
    if (this.tab !== "compute") return "noseAppearance";
    return this.gran === "instance" ? "dino" : "nodeDino";
  }

  /** How the selection is scored. One scorer per granularity, so this is a label, not a choice. */
  get scorer() {
    if (this.tab !== "compute") return "Calibrated RBF-SVM bundles";
    return this.gran === "instance" ? "Trained SVM" : "kNN · unsupervised";
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
  static TABS = ["compute", "upload", "fewshot"];
  setTab(t) { this.tab = AppearanceRun.TABS.includes(t) ? t : "compute"; }
  /** Jump straight to a pane — the tab's locked-check hints link here. */
  showTab(t) { this.setTab(t); this.open = true; }

  show() { this.open = true; }
  close() { this.open = false; }
  toggle() { this.open = !this.open; }

  run() { if (!this.anyRunning) this.store?.run(); }
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
