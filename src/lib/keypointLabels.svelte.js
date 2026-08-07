// Per-KEYPOINT ground-truth labels, kept SOURCE-AGNOSTIC on purpose.
//
// Today they arrive from a reviewed `faulty_keypoints.csv` (the parse app's export). That app is an
// intermediary that will be retired, so nothing here knows about CSVs: a label is just
// (video, frame_idx, instance, node) -> faulty?, and any producer can call `mark()`. Phase 2
// (click a keypoint in review mode to mark it) plugs into the SAME store with no changes downstream.
//
// Semantics, matching the reviewed export: an instance is "reviewed" once we have ANY statement about it.
// For a reviewed instance, a node NOT listed as bad is a genuine NEGATIVE for that node — that's what makes
// a handful of reviewed frames enough for few-shot adaptation.

const keyOf = (video, frameIdx, inst) => `${video}:${frameIdx}:${inst}`;

class KeypointLabels {
  rev = $state(0); // bump on any change — the cheap reactive dep for consumers
  proofreading = $state(false); // PROOFREADING MODE: clicking a keypoint in the viewer labels it
  cursor = $state(0);           // position in the guided queue — shared by the panel and the viewer
  budget = $state(20);          // how many top-ranked candidates the pass covers
  helpOpen = $state(false);     // the "?" cheatsheet
  source = $state(null); // "review csv" | "in-app" | null — shown in the UI so provenance is obvious
  #bad = new Map(); // "v:f:i" -> Set(node names marked faulty)
  #reviewed = new Set(); // "v:f:i" seen by a reviewer (absence of a node ⇒ that node is clean)

  get count() {
    this.rev;
    return this.#reviewed.size;
  }
  get badCount() {
    this.rev;
    let n = 0;
    for (const s of this.#bad.values()) n += s.size;
    return n;
  }
  get hasLabels() {
    this.rev;
    return this.#reviewed.size > 0;
  }

  /** Node names that appear as faulty at least once — the nodes few-shot can actually adapt. */
  get nodes() {
    this.rev;
    const c = new Map();
    for (const s of this.#bad.values()) for (const n of s) c.set(n, (c.get(n) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([node, n]) => ({ node, n }));
  }

  /** Bulk ingest: [{ video, frameIdx, inst, bad: [nodeNames] }] — one row per REVIEWED instance. */
  ingest(rows, source = "review csv") {
    for (const r of rows) {
      const k = keyOf(r.video, r.frameIdx, r.inst);
      this.#reviewed.add(k);
      const set = this.#bad.get(k) ?? new Set();
      for (const n of r.bad ?? []) set.add(n);
      if (set.size) this.#bad.set(k, set);
    }
    this.source = source;
    this.rev++;
  }

  /** Single label — the Phase-2 entry point (click a keypoint in review mode). */
  mark(video, frameIdx, inst, node, faulty, source = "in-app") {
    const k = keyOf(video, frameIdx, inst);
    this.#reviewed.add(k);
    const set = this.#bad.get(k) ?? new Set();
    if (faulty) set.add(node);
    else set.delete(node);
    if (set.size) this.#bad.set(k, set);
    else this.#bad.delete(k);
    this.source = source;
    this.rev++;
  }

  /** Labels for ONE node: { pos, neg } as Sets of "v:f:i". A reviewed instance without this node is a
   *  negative — which is why a few reviewed frames yield many usable negatives. */
  forNode(node) {
    this.rev;
    const pos = new Set(), neg = new Set();
    for (const k of this.#reviewed) {
      if (this.#bad.get(k)?.has(node)) pos.add(k);
      else neg.add(k);
    }
    return { pos, neg };
  }

  /** Has this INSTANCE been judged at all? Distinct from isBad: a reviewed-clean instance is a real
   *  negative, so the guided loop must count it as done rather than re-serving it forever. */
  isReviewed(video, frameIdx, inst) {
    this.rev;
    return this.#reviewed.has(keyOf(video, frameIdx, inst));
  }

  // ---- fkey variants -------------------------------------------------------------------------------
  // labelsStore stamps every frame with `fkey` = "<videoIdx>:<frameIdx>" and that numeric form is what
  // EVERY other consumer uses (bundle keys, candidates, CSV export, the few-shot matcher). A frame item's
  // `.video` is the video OBJECT, so building a key from it yields "[object Object]:412:0" — self-
  // consistent but invisible to all of them. These take the fkey directly so the question can't arise.
  markAt(fkey, inst, node, faulty, source = "in-app") {
    const [v, f] = String(fkey).split(":");
    this.mark(Number(v), Number(f), inst, node, faulty, source);
  }
  toggleAt(fkey, inst, node) {
    const [v, f] = String(fkey).split(":");
    return this.toggle(Number(v), Number(f), inst, node);
  }
  /** Every faulty keypoint on one frame as drawScene's `gtFaulty` set ("inst:node"). Built once here so
   *  the viewer and the proofreading window cannot disagree about what is marked. */
  faultyKeySet(fkey, nInstances, nodeNames) {
    this.rev;
    const out = new Set();
    if (!fkey) return out;
    for (let ii = 0; ii < nInstances; ii++) {
      (nodeNames ?? []).forEach((nm, ni) => { if (this.isBadAt(fkey, ii, nm)) out.add(`${ii}:${ni}`); });
    }
    return out;
  }

  isBadAt(fkey, inst, node) {
    this.rev;
    return this.#bad.get(`${fkey}:${inst}`)?.has(node) ?? false;
  }

  isBad(video, frameIdx, inst, node) {
    this.rev;
    return this.#bad.get(keyOf(video, frameIdx, inst))?.has(node) ?? false;
  }

  /** Flip a single keypoint's label (the in-app proofreading gesture). Returns the new state. */
  toggle(video, frameIdx, inst, node) {
    const now = !this.isBad(video, frameIdx, inst, node);
    this.mark(video, frameIdx, inst, node, now, "in-app");
    return now;
  }

  /** Drop an instance back to UNJUDGED — removes it from both the positives and the negatives.
   *  Distinct from marking clean: this says "I have no opinion", so the guided loop re-serves it and
   *  few-shot stops using it as a negative. Without it a mis-click would be permanent. */
  unreview(video, frameIdx, inst) {
    const k = keyOf(video, frameIdx, inst);
    this.#reviewed.delete(k);
    this.#bad.delete(k);
    this.rev++;
  }

  /** Everything labelled, as `{key, video, frameIdx, inst, bad[]}` rows. */
  rows() {
    this.rev;
    const out = [];
    for (const k of this.#reviewed) {
      const [video, frameIdx, inst] = k.split(":").map(Number);
      out.push({ key: k, video, frameIdx, inst, bad: [...(this.#bad.get(k) ?? [])] });
    }
    return out.sort((a, b) => a.video - b.video || a.frameIdx - b.frameIdx || a.inst - b.inst);
  }

  /** Export in the SAME schema the Python side reads (`faulty_keypoints.csv`), so labels made here can
   *  retrain a model offline — closing the loop rather than trapping them in the browser. */
  toCsv() {
    const head = "frame_index,frame_idx,video,instance,n_bad_keypoints,bad_keypoints";
    const lines = this.rows().map((r, i) =>
      [i, r.frameIdx, r.video, r.inst, r.bad.length, r.bad.join(";")].join(","));
    return [head, ...lines].join("\n");
  }

  clear() {
    this.#bad = new Map();
    this.#reviewed = new Set();
    this.source = null;
    this.rev++;
  }
}

export const keypointLabels = new KeypointLabels();
export { keyOf as keypointKey };
