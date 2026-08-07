// The proofreading LOOP — one controller shared by the keyboard (Viewer) and the panel buttons, so both
// drive the same cursor and can never disagree about which candidate is current.
//
// Separated from the components because the interesting behaviour is a state machine over the ranked
// queue (advance, skip-to-unjudged, wrap, re-rank after each judgement) and that deserves to be testable
// without mounting Svelte. Components stay thin: keys in, `dispatch()`, done.
import { keypointLabels } from "./keypointLabels.svelte.js";
import { keypointModels } from "./keypointModels.svelte.js";
import { store } from "./labelsStore.svelte.js";
import { edit } from "./editStore.svelte.js";
import { view } from "./viewStore.svelte.js";

const FOCUS_PAD = 90; // image px around the keypoint when zooming to it

class ProofreadSession {
  /** Ranked candidates for the current budget, reviewed ones included so progress stays visible. */
  get queue() {
    return keypointModels.candidates({
      limit: keypointLabels.budget,
      includeLabelled: true,
      isLabelled: (v, f, i) => keypointLabels.isReviewed(v, f, i),
    });
  }
  get cursor() {
    const q = this.queue;
    return Math.max(0, Math.min(keypointLabels.cursor, Math.max(q.length - 1, 0)));
  }
  get current() { return this.queue[this.cursor] ?? null; }
  get reviewedCount() { return this.queue.filter((c) => c.labelled).length; }

  /** Move the viewer to a candidate: frame, selection, and a zoom onto the keypoint itself. */
  focus(c) {
    if (!c) return;
    const frames = store.frames ?? [];
    // fkey is stamped at load; the fallback must convert the video OBJECT to its index, or focus()
    // silently no-ops (findIndex never matches "[object Object]:412").
    const vIdx = (v) => store.labels?.videos?.indexOf(v) ?? 0;
    const want = `${c.video}:${c.frameIdx}`;
    const idx = frames.findIndex((f) => (f.fkey ?? `${vIdx(f.video)}:${f.frameIdx}`) === want);
    if (idx < 0) return;
    store.setIndex(idx);
    store.syncFrameImage?.();
    const ni = store.skeleton?.nodeNames?.indexOf(c.node) ?? -1;
    edit.select(c.inst, ni);
    const xy = store.current?.lf?.instances?.[c.inst]?.points?.[ni]?.xy;
    if (xy && Number.isFinite(xy[0])) {
      view.requestFocus({ x: xy[0] - FOCUS_PAD, y: xy[1] - FOCUS_PAD, w: FOCUS_PAD * 2, h: FOCUS_PAD * 2 });
    }
  }

  seek(i) {
    const q = this.queue;
    if (!q.length) return;
    keypointLabels.cursor = Math.max(0, Math.min(q.length - 1, i));
    this.focus(q[keypointLabels.cursor]);
  }
  step(d) { this.seek(this.cursor + d); }

  /** Next candidate NOT yet judged, wrapping once. Keeps a pass moving when some were done earlier. */
  nextUnreviewed() {
    const q = this.queue;
    if (!q.length) return;
    for (let k = 1; k <= q.length; k++) {
      const i = (this.cursor + k) % q.length;
      if (!q[i].labelled) return this.seek(i);
    }
    this.seek(this.cursor); // everything judged — stay put rather than jumping to an arbitrary frame
  }

  /** Record a judgement on the current candidate's keypoint, re-score, advance. */
  judge(faulty) {
    const c = this.current;
    if (!c) return;
    keypointLabels.mark(c.video, c.frameIdx, c.inst, c.node, faulty, "in-app");
    this.rescore();
    this.nextUnreviewed();
  }

  /** Toggle one keypoint of the CURRENT instance by 1-based number (parse's digit gesture). */
  toggleKeypointNumber(n) {
    const c = this.current;
    const names = store.skeleton?.nodeNames ?? [];
    const nm = names[n - 1];
    if (!c || !nm) return;
    keypointLabels.toggle(c.video, c.frameIdx, c.inst, nm);
    this.rescore();
  }

  /** Cycle which keypoint of this instance is targeted — for judging a node the ranking didn't pick. */
  cycleKeypoint() {
    const names = store.skeleton?.nodeNames ?? [];
    if (!names.length || edit.selInstance < 0) return;
    const next = (edit.selNode + 1 + names.length) % names.length;
    edit.select(edit.selInstance, next);
  }

  /** Drop the current instance back to unjudged (parse's `u`). */
  unset() {
    const c = this.current;
    if (!c) return;
    keypointLabels.unreview(c.video, c.frameIdx, c.inst);
    this.rescore();
  }

  rescore() { for (const sl of keypointModels.slots) sl.store.rescore(); }

  /** Budget steps, so the pass length is reachable without the dropdown. */
  setBudget(d) {
    const steps = [10, 20, 40, 100];
    const i = steps.indexOf(keypointLabels.budget);
    const next = steps[Math.max(0, Math.min(steps.length - 1, (i < 0 ? 1 : i) + d))];
    keypointLabels.budget = next;
    keypointLabels.cursor = Math.min(keypointLabels.cursor, Math.max(next - 1, 0));
  }

  /** Download the labels. Returns the CSV so it stays testable headlessly. */
  exportCsv() {
    const csv = keypointLabels.toCsv();
    if (typeof document === "undefined" || typeof URL?.createObjectURL !== "function") return csv;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "faulty_keypoints.csv";
    a.click();
    URL.revokeObjectURL(a.href);
    return csv;
  }

  /** Single entry point for both the keymap and the panel buttons. */
  dispatch(action) {
    switch (action.id) {
      case "faulty": return this.judge(true);
      case "clean": return this.judge(false);
      case "unset": return this.unset();
      case "next": return this.step(1);
      case "prev": return this.step(-1);
      case "nextUnreviewed": return this.nextUnreviewed();
      case "first": return this.seek(0);
      case "last": return this.seek(this.queue.length - 1);
      case "toggleKeypoint": return this.toggleKeypointNumber(action.digit);
      case "cycleKeypoint": return this.cycleKeypoint();
      case "budgetDown": return this.setBudget(-1);
      case "budgetUp": return this.setBudget(1);
      case "exportCsv": this.exportCsv(); return;
      case "zoom": return this.focus(this.current);
      case "help": keypointLabels.helpOpen = !keypointLabels.helpOpen; return;
      case "exit": keypointLabels.proofreading = false; keypointLabels.helpOpen = false; return;
      case "enterProofread":
        keypointLabels.proofreading = true;
        this.focus(this.current);   // jump straight to the top candidate — no click needed to start
        return;
    }
  }
}

export const proofread = new ProofreadSession();
