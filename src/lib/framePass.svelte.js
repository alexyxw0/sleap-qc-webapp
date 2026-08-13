// framePass.svelte.js
//
// The FRAME pass: walk qc.proofreadRanked one ANIMAL at a time, judging keypoints from the keyboard.
//
// The queue's unit is an instance, not a frame: a frame with two suspect animals appears twice, so the
// second one can't be skipped past. Consecutive rows often share a frame — that is expected, and the
// only thing that changes between them is which animal is targeted.
//
// Distinct from proofreadSession, which walks a queue of individual (frame, instance, node) CANDIDATES
// proposed by a trained keypoint model. Both are proofreading, but they answer different questions —
// "show me the frames the detectors distrust" versus "check the keypoints this model flags" — and only
// the first works before any model exists. They deliberately share the keymap and the label store, so a
// judgement made in either shows up in the other.
//
// Which one the keyboard drives is decided at the ONE key handler (Viewer.onKey) by `active`, so there is
// never a second listener to double-fire.
import { qc } from "./qcStore.svelte.js";
import { store } from "./labelsStore.svelte.js";
import { edit } from "./editStore.svelte.js";
import { view } from "./viewStore.svelte.js";
import { instancePointsBox } from "./qc/focusBox.js";
import { keypointLabels } from "./keypointLabels.svelte.js";
import { proofread } from "./proofreadSession.svelte.js";
import { proofreadWindow } from "./proofreadWindow.svelte.js";

const FOCUS_PAD = 90; // image px around a keypoint when zooming to it

class FramePass {
  cursor = $state(0); // position in qc.proofreadRanked (one row per animal)
  inst = $state(0); // which animal the digits apply to — normally the row's, but `i` can override
  /** Set when a gesture can't apply (no keypoint targeted, frame has no instances). Cleared on move. */
  hint = $state("");

  /** The pass owns the keyboard whenever its window is up and there is a ranking to walk — including
   *  while you are reading another pane. Gating on the frames tab looked tidier but meant a keystroke on
   *  the Keybinds tab fell through and judged an item in the OTHER pass's queue, which is worse than
   *  harmlessly advancing this one. (Rebinding is unaffected: that grabber runs in the capture phase.) */
  get active() {
    return proofreadWindow.open && qc.proofreadReady;
  }

  get queue() { return qc.proofreadRanked; }
  get length() { return this.queue.length; }
  get at() { return Math.max(0, Math.min(this.cursor, Math.max(this.length - 1, 0))); }
  get current() { return this.queue[this.at] ?? null; }
  get frameIndex() { return this.current?.i ?? -1; }
  /** How many rows this frame contributes, and which one we are on — "animal 2 of 3" in the queue. */
  get siblings() {
    const i = this.frameIndex;
    return i < 0 ? [] : this.queue.filter((r) => r.i === i);
  }
  get item() { return store.frames?.[this.frameIndex] ?? null; }
  get instances() { return this.item?.lf?.instances ?? []; }
  /** Clamped so a frame with fewer animals than the last one can't leave the digits pointing nowhere. */
  get instIdx() { return Math.max(0, Math.min(this.inst, Math.max(this.instances.length - 1, 0))); }
  /** The row's animal no longer exists — deleted mid-pass. The clamp keeps the window rendering, but a
   *  WRITE would silently land on its neighbour and mark the wrong animal reviewed. */
  get instStale() { return this.inst !== this.instIdx; }
  #staleGuard() {
    if (!this.instStale) return false;
    this.hint = "that animal was deleted — re-run QC to rebuild the queue";
    return true;
  }
  get nodeNames() { return store.skeleton?.nodeNames ?? []; }

  /** "videoIdx:frameIdx" — the key every label is stored under. */
  #fkey() {
    const it = this.item;
    if (!it) return null;
    return it.fkey ?? `${store.labels?.videos?.indexOf(it.video) ?? 0}:${it.frameIdx}`;
  }

  /** Has THIS animal been judged? Per-instance, because that is what a row is — a frame-level ✓ would
   *  mark the second animal done the moment you judged the first. */
  reviewedRow(row) {
    const f = store.frames?.[row?.i];
    if (!f) return false;
    const v = store.labels?.videos?.indexOf(f.video) ?? 0;
    return keypointLabels.isReviewed(v, f.frameIdx, row.inst);
  }
  /** Convenience for the current row. */
  get reviewedHere() { return this.current ? this.reviewedRow(this.current) : false; }

  /** Faulty keypoints of the CURRENT frame, as drawScene's `gtFaulty` set ("inst:node"). */
  get faultySet() {
    return keypointLabels.faultyKeySet(this.#fkey(), this.instances.length, this.nodeNames);
  }

  /** Move the main viewer with the pass, so the big canvas and the window never show different frames. */
  #sync() {
    const i = this.frameIndex;
    if (i < 0) return;
    store.setIndex(i);
    store.syncFrameImage?.();
    edit.select(this.instIdx, edit.selNode >= 0 ? edit.selNode : 0);
  }

  seek(i) {
    if (!this.length) return;
    this.cursor = Math.max(0, Math.min(this.length - 1, i));
    // Land on the animal the detectors actually flagged, not on instance 0 — on a two-animal frame
    // that was a coin flip, and every digit press then went to the wrong one.
    this.inst = this.current?.inst ?? 0;
    this.hint = "";
    this.#sync();
    this.#targetCulprit();
  }

  /** Pre-target the keypoint the driving signal blames, so f/j act on it without hunting. */
  #targetCulprit() {
    const it = this.item;
    if (!it) return;
    const ni = qc.proofreadNodeFor(it, this.instIdx, this.current?.by ?? "angle");
    edit.select(this.instIdx, ni >= 0 ? ni : Math.max(0, edit.selNode));
  }

  /** Padded bbox of the flagged animal — what the window shows instead of the whole frame. */
  get focusBox() {
    const pts = this.instances[this.instIdx]?.points;
    const box = instancePointsBox(pts);
    if (!box) return null;
    // A pose judged in isolation is hard to call; a margin of its own size gives back the context.
    const pad = Math.max(box.w, box.h) * 0.35 + 12;
    return { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
  }
  step(d) { this.seek(this.at + d); }

  /** Next ANIMAL nobody has judged yet, wrapping once — keeps a resumed pass moving. */
  nextUnreviewed() {
    if (!this.length) return;
    for (let k = 1; k <= this.length; k++) {
      const i = (this.at + k) % this.length;
      if (!this.reviewedRow(this.queue[i])) return this.seek(i);
    }
    this.hint = "every animal in the queue has been judged";
  }

  /** Toggle one keypoint of the targeted animal, by 1-based number (parse's digit gesture). */
  toggleKeypointNumber(n) {
    if (this.#staleGuard()) return;
    const fk = this.#fkey();
    const nm = this.nodeNames[n - 1];
    if (!fk || !nm) return;
    if (!this.instances.length) { this.hint = "this frame has no instances"; return; }
    keypointLabels.toggleAt(fk, this.instIdx, nm);
    edit.select(this.instIdx, n - 1); // targeting follows the digit, so f/j act on what you just touched
    this.hint = "";
  }

  /** Mark the TARGETED keypoint. Frame-based, so this does NOT advance — you judge several per frame. */
  /**
   * Record a verdict on the current candidate.
   *
   * The two verdicts have different requirements, and treating them the same is what produced "pick a
   * keypoint first" on a CLEAN marking. FAULTY has to name the keypoint that is wrong — that is the
   * whole content of the label. CLEAN does not: it asserts nothing is wrong with the instance, which
   * is precisely what the store records as "reviewed, with an empty faulty set". So a clean verdict
   * falls back to the whole instance when no keypoint is selected (or when the selection points past
   * this skeleton's node list, which is how the message appeared intermittently).
   */
  judge(faulty) {
    if (this.#staleGuard()) return;
    const fk = this.#fkey();
    if (!fk) { this.hint = "no frame to judge"; return; }
    const nm = this.nodeNames[edit.selNode];
    if (!faulty && !nm) {
      const cleared = keypointLabels.markInstanceCleanAt(fk, this.instIdx);
      this.hint = cleared ? `whole instance marked clean — cleared ${cleared} keypoint mark${cleared === 1 ? "" : "s"}` : "";
      return;
    }
    if (!nm) { this.hint = "pick a keypoint first — press 1-9 or k"; return; }
    keypointLabels.markAt(fk, this.instIdx, nm, faulty);
    this.hint = "";
  }

  unset() {
    if (this.#staleGuard()) return;
    const fk = this.#fkey();
    if (fk) keypointLabels.unreview(...this.#triple());
    this.hint = "";
  }
  #triple() {
    const it = this.item;
    return [store.labels?.videos?.indexOf(it?.video) ?? 0, it?.frameIdx ?? -1, this.instIdx];
  }

  cycleKeypoint() {
    const names = this.nodeNames;
    if (!names.length) return;
    edit.select(this.instIdx, (edit.selNode + 1 + names.length) % names.length);
  }
  /** Target an animal by MOVING THE CURSOR to its row. Every instance has its own row, so setting
   *  `inst` alone would leave the verdict, the score and the ✓ describing a different animal from the
   *  one the digits are hitting. Every path in (key, click, cycle) goes through here. */
  selectInstance(ii) {
    const at = this.queue.findIndex((r) => r.i === this.frameIndex && r.inst === ii);
    if (at >= 0) return this.seek(at);
    this.inst = ii; // not in the queue (shouldn't happen) — still let the digits move
    edit.select(this.instIdx, edit.selNode);
    this.hint = "";
  }
  cycleInstance() {
    const n = this.instances.length;
    if (n < 2) { this.hint = "only one animal on this frame"; return; }
    this.selectInstance((this.instIdx + 1) % n);
  }

  /** A re-run replaces the whole ranking; the cursor is only a number, so re-land on whatever row it
   *  now points at rather than leaving the viewer on the previous run's frame with a stale target. */
  resync() { if (this.length) this.seek(this.at); else this.reset(); }

  /** Which keypoint the detectors blame on the animal in view, for the caption. -1 when none. */
  get culpritNode() {
    const it = this.item;
    return it ? qc.proofreadNodeFor(it, this.instIdx, this.current?.by ?? "angle") : -1;
  }

  /** Zoom the main viewer onto the targeted keypoint (the window canvas always shows the whole frame). */
  zoom() {
    const xy = this.instances[this.instIdx]?.points?.[edit.selNode]?.xy;
    if (xy && Number.isFinite(xy[0])) {
      view.requestFocus({ x: xy[0] - FOCUS_PAD, y: xy[1] - FOCUS_PAD, w: FOCUS_PAD * 2, h: FOCUS_PAD * 2 });
    }
  }

  /** A new file re-ranks from scratch. */
  reset() { this.cursor = 0; this.inst = 0; this.hint = ""; }

  /** Moving through the queue is not labelling, so it works without the mode being on. */
  static MOVES = new Set(["next", "prev", "first", "last", "nextUnreviewed"]);
  isMove(id) { return FramePass.MOVES.has(id); }

  /** The rows after this one — lets the UI show that the queue is NOT in frame order. */
  upcoming(n = 6) { return this.queue.slice(this.at + 1, this.at + 1 + n); }

  /** Same action ids as proofreadSession, so one keymap serves both passes. */
  dispatch(action) {
    switch (action.id) {
      case "faulty": return this.judge(true);
      case "clean": return this.judge(false);
      case "unset": return this.unset();
      case "next": return this.step(1);
      case "prev": return this.step(-1);
      case "nextUnreviewed": return this.nextUnreviewed();
      case "first": return this.seek(0);
      case "last": return this.seek(this.length - 1);
      case "toggleKeypoint": return this.toggleKeypointNumber(action.digit);
      case "cycleKeypoint": return this.cycleKeypoint();
      case "cycleInstance": return this.cycleInstance();
      case "zoom": return this.zoom();
      // session-level actions (export, help, exit, budget) are the same in both passes
      default: return proofread.dispatch(action);
    }
  }
}

export const framePass = new FramePass();
