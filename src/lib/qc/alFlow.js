// THE ACTIVE-LEARNING FLOW, AS DATA.
//
// One page, one question, AT MOST TWO actions. That is the rule the whole module exists to make
// enforceable rather than aspirational: the pages are a table, the actions are a list, and a test
// walks every reachable state and fails if any page grows a third. Before this the scoring pane asked
// three questions at once — pick a keypoint, pick one of three techniques, and tick the arm checkbox —
// on one screen, with the result viewer's own controls underneath. Everything was reachable and
// nothing was a sequence.
//
// The shape is a stack of answers, deepest last:
//
//   route → gran → (embed) → scoreKind → unsupChoice | scoreNode → svmSource
//
// `back` pops exactly one. A page is a pure function of the stack, so there is no "which pane is
// showing" state to fall out of sync with the answers — the answers ARE the position.
//
// Two things deliberately do NOT count as actions:
//   - NAVIGATION: the step strip and the single back button. They move you between pages; they answer
//     nothing. A flow whose back button counted against its own budget would be a worse flow.
//   - The INSPECTOR: the result viewer's threshold slider, graph and frame grid. Those read the run,
//     they do not advance the flow, and they live on their own terminal step for exactly that reason.

export const MAX_ACTIONS = 2;

/** Granularity — the first question, and the one this whole file was reorganised around. */
export const GRAN_ACTIONS = [
  {
    id: "gran:instance",
    label: "Whole instance",
    desc: "One crop per animal. Catches occlusion and gross appearance faults — but names the animal, not the keypoint.",
  },
  {
    id: "gran:node",
    label: "Specific keypoints",
    desc: "A patch around each keypoint you pick. Many more forward passes, and a flag names the keypoint responsible.",
  },
];

/** Unsupervised or supervised. Asked before WHICH, so neither page carries three cards. */
const KIND_ACTIONS = (gran) => [
  {
    id: "kind:unsup",
    label: "Unsupervised — no labels",
    desc: gran === "node"
      ? "Score every patch against the other patches of the same keypoint in this file. Nothing to label, nothing to train."
      : "Score every animal against the other animals in this file. Nothing to label, nothing to train.",
  },
  {
    id: "kind:sup",
    label: gran === "node" ? "Supervised — a trained boundary" : "Supervised — the bundled model",
    desc: gran === "node"
      ? "Fit a boundary between faulty and clean, on one keypoint, from labels you bring or make here."
      : "The RBF-SVM shipped with the app, fitted offline on proofread whole-animal crops.",
  },
];

/** Which unsupervised scorer. Both read the SAME embeddings — switching is arithmetic, not inference. */
const UNSUP_ACTIONS = [
  {
    id: "unsup:knn",
    label: "kNN",
    desc: "Distance to the k most similar crops of the same kind elsewhere in the file, as a robust z. Asks whether the crop as a whole is unusual.",
  },
  {
    id: "unsup:anomalyDino",
    label: "AnomalyDINO",
    desc: "The crop's own DINOv2 patch tokens against a memory bank of normal ones, averaged over its worst quarter (Damm et al., WACV 2025). Asks whether any PART of it is unusual — which is what kNN's single averaged vector cannot see.",
  },
];

/** Where a trained boundary comes from. */
const SOURCE_ACTIONS = [
  {
    id: "src:upload",
    label: "Upload a fitted model",
    desc: "A .json exported from this app in an earlier session — label once, apply to every file after.",
  },
  {
    id: "src:fewshot",
    label: "Label some frames here",
    desc: "Proofread the instances the detectors already rank as suspect, then fit on what you marked.",
  },
];

/**
 * The page for a flow state.
 *
 * @param {object} s
 * @param {"compute"|"bundle"|null} s.route
 * @param {"instance"|"node"|null} s.gran        null until the scope question is answered
 * @param {"embed"|"score"|"use"} s.step         which of the three compute steps is open
 * @param {"unsup"|"sup"|null} s.scoreKind
 * @param {"knn"|"anomalyDino"|null} s.unsupChoice
 * @param {number|null} s.scoreNode              the keypoint a trained boundary targets (node gran)
 * @param {"upload"|"fewshot"|null} s.svmSource
 * @param {boolean} s.trained                    a model is applied to the current target
 * @returns {{id: string, question: string, actions: object[]}}
 */
export function flowPage(s) {
  const gran = s.gran ?? null;
  // The scope question outranks the step: `gran` decides which store a step would even act on, so a
  // step cannot meaningfully be open before it is answered.
  if (gran == null) {
    return { id: "scope", question: "What should be embedded?", actions: GRAN_ACTIONS };
  }
  if (s.step === "embed") {
    return {
      id: "embed",
      question: gran === "node" ? "Which keypoints, and run the pass" : "Run the pass",
      // The keypoint picker is ONE action however many chips it draws — it is a single selection over a
      // homogeneous list, the way a multi-select is one control.
      actions: gran === "node"
        ? [{ id: "keypoints", label: "Choose keypoints" }, { id: "run", label: "Run DINOv2" }]
        : [{ id: "run", label: "Run DINOv2" }],
    };
  }
  if (s.step === "use") {
    return {
      id: "use",
      question: "Use it as a detection check",
      actions: [{ id: "arm", label: "Arm the check" }],
    };
  }
  // ---- the scoring step ------------------------------------------------------------------------
  if (!s.scoreKind) {
    return { id: "score.kind", question: "How should these be scored?", actions: KIND_ACTIONS(gran) };
  }
  if (s.scoreKind === "unsup") {
    if (!s.unsupChoice) {
      return { id: "score.unsup", question: "Which unsupervised scorer?", actions: UNSUP_ACTIONS };
    }
    return {
      id: "score.done",
      question: "Scoring is applied",
      // Choosing an unsupervised scorer settles the BASELINE, not the question: a trained boundary is a
      // per-keypoint override on top of it, so it stays one action away rather than something you reach
      // by backing out and re-answering. Whole instance has no per-keypoint override to add.
      actions: gran === "node" ? [{ id: "addSvm", label: "Add a trained boundary for one keypoint" }] : [],
    };
  }
  // supervised
  if (gran === "instance") {
    // The bundled SVM is the only whole-animal model there is; it applies on selection, so there is
    // nothing left to choose here.
    return { id: "score.done", question: "Scoring is applied", actions: [] };
  }
  if (s.scoreNode == null) {
    return {
      id: "score.node",
      question: "Which keypoint gets the trained boundary?",
      actions: [{ id: "keypoint", label: "Choose a keypoint" }],
    };
  }
  if (!s.svmSource) {
    return { id: "score.source", question: "Where does the boundary come from?", actions: SOURCE_ACTIONS };
  }
  if (s.svmSource === "upload") {
    return {
      id: "score.upload",
      question: "Upload a boundary",
      actions: s.trained
        ? [{ id: "upload", label: "Choose a .json" }, { id: "revert", label: "Revert to the baseline" }]
        : [{ id: "upload", label: "Choose a .json" }],
    };
  }
  if (s.trained) {
    return {
      id: "score.keep",
      question: "Keep it",
      actions: [{ id: "export", label: "Export the boundary" }, { id: "revert", label: "Revert to the baseline" }],
    };
  }
  return {
    id: "score.label",
    question: "Label ground truth, then fit",
    actions: [{ id: "proofread", label: "Open the proofreader" }, { id: "fit", label: "Fit" }],
  };
}

/**
 * Which single answer `back` should undo, as a field name — or "step"/"route" for the two moves that
 * are not a field. Deepest answer first, so back is always exactly one step of the way you came.
 */
export function backTargetField(s) {
  if (s.route !== "compute") return null;
  if (s.step === "use") return "step";
  if (s.step === "score") {
    // Whole instance never asks either of these, so a leftover value from a per-keypoint session must
    // not be what back tries to pop — it would pop something no page is showing, and back would appear
    // to do nothing.
    const perKeypoint = s.gran === "node";
    if (perKeypoint && s.svmSource) return "svmSource";
    if (perKeypoint && s.scoreNode != null) return "scoreNode";
    if (s.unsupChoice) return "unsupChoice";
    if (s.scoreKind) return "scoreKind";
    return "step";
  }
  if (s.gran != null) return "gran";
  return "route";
}

/** Every page the compute route can reach, for the test that enforces the two-action rule. */
export function allComputeStates() {
  const out = [];
  const base = {
    route: "compute", gran: null, step: "embed", scoreKind: null,
    unsupChoice: null, scoreNode: null, svmSource: null, trained: false,
  };
  out.push({ ...base });
  for (const gran of ["instance", "node"]) {
    out.push({ ...base, gran });
    out.push({ ...base, gran, step: "use" });
    out.push({ ...base, gran, step: "score" });
    out.push({ ...base, gran, step: "score", scoreKind: "unsup" });
    for (const unsupChoice of ["knn", "anomalyDino"]) {
      out.push({ ...base, gran, step: "score", scoreKind: "unsup", unsupChoice });
    }
    out.push({ ...base, gran, step: "score", scoreKind: "sup" });
    // Whole instance's supervised answer IS the bundled model — there is no keypoint to pick and no
    // boundary to source, so those pages exist only per keypoint.
    if (gran !== "node") continue;
    out.push({ ...base, gran, step: "score", scoreKind: "sup", scoreNode: 0 });
    for (const svmSource of ["upload", "fewshot"]) {
      for (const trained of [false, true]) {
        out.push({ ...base, gran, step: "score", scoreKind: "sup", scoreNode: 0, svmSource, trained });
      }
    }
  }
  return out;
}
