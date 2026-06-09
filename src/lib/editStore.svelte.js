// editStore.svelte.js
//
// The editing layer. It mutates the sleap-io.js model in place (which the Node spike
// confirmed survives saveSlpToBytes -> reload for every op below), bumps store.rev so
// the canvas/UI redraw, and keeps a command-based undo/redo history. Kept separate from
// labelsStore so the load/navigation concerns stay clean.
//
// All edits go through #commit(label, undo, redo): undo/redo are closures that capture
// the affected objects by reference, so they work regardless of index shifts.

import { Instance, Node, saveSlpToBytes } from "@talmolab/sleap-io.js";
import { store } from "./labelsStore.svelte.js";

class EditStore {
  // selection within the current frame
  selInstance = $state(-1);
  selNode = $state(-1);

  dirty = $state(false);
  saving = $state(false);
  histRev = $state(0); // bump on any history change so canUndo/canRedo stay reactive
  dirtyRev = $state(0); // bump when the set of modified frames changes

  #undo = [];
  #redo = [];
  // Count of currently-applied per-frame edits, keyed by LabeledFrame. A frame is
  // "modified" iff its count > 0, so undoing edits back to the original (count -> 0)
  // clears the badge; redo brings it back. (Skeleton edits are global and tracked by
  // `dirty`, not per-frame.)
  #frameEdits = new Map();

  #incFrame(lf) {
    if (!lf) return;
    this.#frameEdits.set(lf, (this.#frameEdits.get(lf) ?? 0) + 1);
    this.dirtyRev++;
  }
  #decFrame(lf) {
    if (!lf) return;
    const n = (this.#frameEdits.get(lf) ?? 0) - 1;
    if (n > 0) this.#frameEdits.set(lf, n);
    else this.#frameEdits.delete(lf);
    this.dirtyRev++;
  }
  isFrameModified(lf) {
    this.dirtyRev; // reactive dependency
    return lf != null && (this.#frameEdits.get(lf) ?? 0) > 0;
  }

  get canUndo() {
    this.histRev;
    return this.#undo.length > 0;
  }
  get canRedo() {
    this.histRev;
    return this.#redo.length > 0;
  }
  get undoLabel() {
    this.histRev;
    return this.#undo.at(-1)?.label ?? null;
  }
  get redoLabel() {
    this.histRev;
    return this.#redo.at(-1)?.label ?? null;
  }

  get #lf() {
    return store.current?.lf ?? null;
  }

  #bump() {
    store.rev++;
  }

  // `frame` is the LabeledFrame a per-frame edit touched (null for global/skeleton
  // edits), used to keep the modified-frame badges in sync with undo/redo.
  #commit(label, undoFn, redoFn, frame = null) {
    this.#undo.push({ label, undo: undoFn, redo: redoFn, frame });
    if (this.#undo.length > 300) this.#undo.shift();
    this.#redo = []; // discarded redo commands are already un-applied; no count change
    if (frame) this.#incFrame(frame);
    this.dirty = true;
    this.histRev++;
  }

  undo() {
    const c = this.#undo.pop();
    if (!c) return;
    c.undo();
    if (c.frame) this.#decFrame(c.frame); // reverted -> one fewer applied edit on that frame
    this.#redo.push(c);
    this.dirty = true;
    this.histRev++;
  }
  redo() {
    const c = this.#redo.pop();
    if (!c) return;
    c.redo();
    if (c.frame) this.#incFrame(c.frame);
    this.#undo.push(c);
    this.dirty = true;
    this.histRev++;
  }

  // ---- selection ----
  select(instIdx, nodeIdx = -1) {
    this.selInstance = instIdx;
    this.selNode = nodeIdx;
  }
  clearSelection() {
    this.selInstance = -1;
    this.selNode = -1;
  }
  get selectedInstance() {
    return this.#lf?.instances?.[this.selInstance] ?? null;
  }

  // ---- point editing ----
  // During a drag the caller mutates live via setPoint (responsive), then calls
  // commitMove once with the pre-drag state so a single history entry covers the drag.
  setPoint(instIdx, nodeIdx, x, y, visible = true) {
    const p = this.#lf?.instances?.[instIdx]?.points?.[nodeIdx];
    if (!p) return;
    p.xy = [x, y];
    p.visible = visible;
    this.#bump();
  }

  commitMove(instIdx, nodeIdx, from) {
    const lf = this.#lf;
    const inst = lf?.instances?.[instIdx];
    const p = inst?.points?.[nodeIdx];
    if (!p) return;
    const to = { xy: [...p.xy], visible: p.visible };
    if (from.xy[0] === to.xy[0] && from.xy[1] === to.xy[1] && from.visible === to.visible) return;
    this.#commit(
      "Move point",
      () => {
        p.xy = [...from.xy];
        p.visible = from.visible;
        this.#bump();
      },
      () => {
        p.xy = [...to.xy];
        p.visible = to.visible;
        this.#bump();
      },
      lf,
    );
  }

  toggleVisible(instIdx, nodeIdx) {
    const lf = this.#lf;
    const p = lf?.instances?.[instIdx]?.points?.[nodeIdx];
    if (!p) return;
    const before = p.visible;
    const after = !before;
    p.visible = after;
    this.#bump();
    this.#commit(
      after ? "Show point" : "Hide point",
      () => {
        p.visible = before;
        this.#bump();
      },
      () => {
        p.visible = after;
        this.#bump();
      },
      lf,
    );
  }

  // ---- instance editing ----
  addInstance() {
    const lf = this.#lf;
    const sk = store.skeleton;
    if (!lf || !sk) return;
    const inst = Instance.empty({ skeleton: sk });
    // Spread points in a ring at frame center so they're immediately grabbable.
    const shape = store.current?.video?.shape;
    const w = shape?.[2] ?? 512;
    const h = shape?.[1] ?? 512;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) * 0.15;
    const n = Math.max(1, inst.points.length);
    inst.points.forEach((p, i) => {
      const a = (i / n) * Math.PI * 2;
      p.xy = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      p.visible = true;
    });
    lf.instances.push(inst);
    this.#bump();
    this.select(lf.instances.indexOf(inst), 0);
    this.#commit(
      "Add instance",
      () => {
        const i = lf.instances.indexOf(inst);
        if (i >= 0) lf.instances.splice(i, 1);
        this.clearSelection();
        this.#bump();
      },
      () => {
        if (!lf.instances.includes(inst)) lf.instances.push(inst);
        this.#bump();
      },
      lf,
    );
  }

  deleteInstance(instIdx = this.selInstance) {
    const lf = this.#lf;
    const inst = lf?.instances?.[instIdx];
    if (!inst) return;
    lf.instances.splice(instIdx, 1);
    this.clearSelection();
    this.#bump();
    this.#commit(
      "Delete instance",
      () => {
        lf.instances.splice(Math.min(instIdx, lf.instances.length), 0, inst);
        this.#bump();
      },
      () => {
        const i = lf.instances.indexOf(inst);
        if (i >= 0) lf.instances.splice(i, 1);
        this.#bump();
      },
      lf,
    );
  }

  // ---- skeleton editing (global: affects every instance in every frame) ----
  #eachInstance(fn) {
    for (const lf of store.labels.labeledFrames) for (const inst of lf.instances) fn(inst);
  }

  renameNode(idx, name) {
    const sk = store.skeleton;
    const node = sk?.nodes?.[idx];
    if (!node || !name || node.name === name) return;
    const before = node.name;
    const apply = (nm) => {
      node.name = nm;
      this.#eachInstance((inst) => {
        if (inst.points[idx]) inst.points[idx].name = nm;
      });
      sk.rebuildCache();
      this.#bump();
    };
    apply(name);
    this.#commit("Rename node", () => apply(before), () => apply(name));
  }

  addNode(name) {
    const sk = store.skeleton;
    if (!sk || !name) return;
    if (sk.nodes.some((nd) => nd.name === name)) return;
    const node = new Node(name);
    const idx = sk.nodes.length;
    const apply = () => {
      sk.nodes.push(node);
      sk.rebuildCache();
      this.#eachInstance((inst) =>
        inst.points.push({ xy: [Number.NaN, Number.NaN], visible: false, complete: false, name }),
      );
      this.#bump();
    };
    const revert = () => {
      const i = sk.nodes.indexOf(node);
      if (i >= 0) sk.nodes.splice(i, 1);
      sk.edges = sk.edges.filter((e) => e.source !== node && e.destination !== node);
      sk.rebuildCache();
      this.#eachInstance((inst) => inst.points.splice(idx, 1));
      this.#bump();
    };
    apply();
    this.#commit("Add node", revert, apply);
  }

  removeNode(idx) {
    const sk = store.skeleton;
    const node = sk?.nodes?.[idx];
    if (!node || sk.nodes.length <= 1) return;
    const removedEdges = sk.edges.filter((e) => e.source === node || e.destination === node);
    let removedPoints = [];
    const apply = () => {
      sk.nodes.splice(idx, 1);
      sk.edges = sk.edges.filter((e) => e.source !== node && e.destination !== node);
      sk.rebuildCache();
      removedPoints = [];
      this.#eachInstance((inst) => {
        removedPoints.push(inst.points[idx]);
        inst.points.splice(idx, 1);
      });
      this.clearSelection();
      this.#bump();
    };
    const revert = () => {
      sk.nodes.splice(idx, 0, node);
      for (const e of removedEdges) sk.edges.push(e);
      sk.rebuildCache();
      let k = 0;
      this.#eachInstance((inst) => inst.points.splice(idx, 0, removedPoints[k++]));
      this.#bump();
    };
    apply();
    this.#commit("Remove node", revert, apply);
  }

  addEdge(srcIdx, dstIdx) {
    const sk = store.skeleton;
    const src = sk?.nodes?.[srcIdx];
    const dst = sk?.nodes?.[dstIdx];
    if (!src || !dst || src === dst) return;
    if (sk.edges.some((e) => e.source === src && e.destination === dst)) return;
    sk.addEdge(srcIdx, dstIdx);
    this.#bump();
    const edge = sk.edges.at(-1);
    this.#commit(
      "Add edge",
      () => {
        const i = sk.edges.indexOf(edge);
        if (i >= 0) sk.edges.splice(i, 1);
        this.#bump();
      },
      () => {
        if (!sk.edges.includes(edge)) sk.edges.push(edge);
        this.#bump();
      },
    );
  }

  removeEdge(edgeIdx) {
    const sk = store.skeleton;
    const edge = sk?.edges?.[edgeIdx];
    if (!edge) return;
    sk.edges.splice(edgeIdx, 1);
    this.#bump();
    this.#commit(
      "Remove edge",
      () => {
        sk.edges.splice(Math.min(edgeIdx, sk.edges.length), 0, edge);
        this.#bump();
      },
      () => {
        const i = sk.edges.indexOf(edge);
        if (i >= 0) sk.edges.splice(i, 1);
        this.#bump();
      },
    );
  }

  // ---- save ----
  async save({ embed = false } = {}) {
    if (!store.labels) return;
    this.saving = true;
    store.error = null;
    try {
      const bytes = await saveSlpToBytes(store.labels, embed ? { embed: "all" } : undefined);
      const base = (store.fileName || "labels").replace(/\.(pkg\.)?slp$/i, "");
      const name = embed ? `${base}.edited.pkg.slp` : `${base}.edited.slp`;
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      this.dirty = false;
      // Per-frame badges are NOT cleared here: they track "differs from the file as
      // loaded" so they stay in sync with undo/redo (a frame is modified iff it has
      // applied edits). Clearing them on save would desync from the undo stack.
    } catch (e) {
      console.error("[sleap-web] save failed:", e);
      store.error = `Save failed: ${String(e?.message ?? e)}`;
    } finally {
      this.saving = false;
    }
  }

  resetForNewFile() {
    this.clearSelection();
    this.#undo = [];
    this.#redo = [];
    this.#frameEdits.clear();
    this.dirty = false;
    this.histRev++;
    this.dirtyRev++;
  }
}

export const edit = new EditStore();
