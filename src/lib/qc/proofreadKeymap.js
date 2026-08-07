// Keyboard map for proofreading — DECLARATIVE on purpose.
//
// The parse app proved the interaction (f = faulty, j = clean, digits toggle a keypoint, Tab = next
// unreviewed) but encoded it as a 40-case switch: the help text was written by hand and drifted, and
// nothing could be rebound. Here the map is DATA. The handler resolves against it, the help overlay
// renders from it, and the rebinding UI (keybinds.svelte.js, the Keybinds tab) only rewrites `key`.
//
// Conventions:
//   - Home row first. The two judgements sit under the index fingers (f / j) so a pass is one hand.
//   - `keys` lists every accepted key for one action (case is normalised; "Space"/"ArrowRight" are event
//     `key` values). One action, many keys — the legend shows the first.
//   - `when` gates an action on context so a binding never fires where it makes no sense.
//   - Nothing here duplicates a GLOBAL binding the viewer already owns (n/p seek-flagged, v visibility,
//     space play/pause, arrows). Proofreading REPLACES those while active — see `handled` — which is why
//     the mode is explicit rather than always-on.

export const PROOFREAD_KEYS = [
  { id: "faulty", keys: ["f"], label: "Mark faulty", group: "Judge",
    hint: "Record the targeted keypoint as wrong" },
  { id: "clean", keys: ["j", " "], label: "Mark clean", group: "Judge",
    hint: "Record the targeted keypoint as correct" },
  { id: "unset", keys: ["u"], label: "Un-review", group: "Judge",
    hint: "Drop this animal back to unjudged, as if you had never looked" },
  { id: "next", keys: ["n", "ArrowRight"], label: "Next in the queue", group: "Move",
    hint: "One step down the ranked frames — not the next frame number" },
  { id: "prev", keys: ["p", "ArrowLeft"], label: "Previous in the queue", group: "Move",
    hint: "One step back up the ranking" },
  { id: "nextUnreviewed", keys: ["Tab"], label: "Skip to next unjudged", group: "Move",
    hint: "Jump past anything already labelled, wrapping once" },
  { id: "first", keys: ["Home"], label: "First in the queue", group: "Move",
    hint: "Back to the frame the detectors distrust most" },
  { id: "last", keys: ["End"], label: "Last in the queue", group: "Move",
    hint: "The frame they are happiest with" },
  { id: "toggleKeypoint", keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"], digit: true, fixed: true,
    label: "Toggle keypoint 1–9", group: "Keypoint",
    hint: "Flip that keypoint of the targeted animal between faulty and fine, and target it" },
  { id: "cycleKeypoint", keys: ["k"], label: "Cycle the targeted keypoint", group: "Keypoint",
    hint: "Step through the skeleton — how you reach keypoints past the ninth" },
  { id: "cycleInstance", keys: ["i"], label: "Cycle the targeted animal", group: "Keypoint",
    hint: "Which animal in the frame the digits and f/j apply to" },
  { id: "budgetDown", keys: ["["], label: "Smaller candidate budget", group: "Guided pass",
    hint: "Guided pass only: how many of a trained model's top-ranked candidates it covers (10 / 20 / 40 / 100). No effect on the frame queue, which is the whole file." },
  { id: "budgetUp", keys: ["]"], label: "Larger candidate budget", group: "Guided pass",
    hint: "The same setting, one step up" },
  { id: "exportCsv", keys: ["e"], label: "Export labels (.csv)", group: "Session",
    hint: "Download everything judged so far as faulty_keypoints.csv" },
  { id: "zoom", keys: ["z"], label: "Zoom to the targeted keypoint", group: "View",
    hint: "Sends the MAIN viewer in close; this window always shows the whole frame" },
  { id: "exit", keys: ["Escape", "r"], label: "Leave proofreading", group: "View",
    hint: "Hands the keyboard back to the viewer's normal shortcuts" },
  { id: "help", keys: ["?", "/"], label: "Show / hide the cheatsheet", group: "View",
    hint: "The same list, as an overlay" },
];

/** Group blurbs for the editor, so a category header says what it covers. Order = declaration order. */
export const KEY_GROUP_HINTS = {
  Judge: "Recording what you decided about the targeted keypoint",
  Move: "Walking the ranked frame queue",
  Keypoint: "Choosing what a judgement applies to",
  "Guided pass": "The separate model-candidate loop, not the frame queue",
  Session: "The pass as a whole",
  View: "Mode and display",
  Global: "Works when proofreading is OFF",
};

/** Bindings that must work OUTSIDE proofreading — otherwise entering the mode needs the mouse, which
 *  defeats the point. Resolved by the viewer's normal key path; kept declarative so the help overlay and
 *  the rebinding UI see it alongside everything else. */
export const GLOBAL_KEYS = [
  { id: "enterProofread", keys: ["r"], label: "Enter proofreading", group: "Global",
    hint: "Turn the mode on without reaching for the mouse" },
];

/** The resolver's matching rule. Exported so a conflict check can never disagree with resolution. */
export const normKey = (k) => (k === " " ? " " : k.length === 1 ? k.toLowerCase() : k);
const norm = normKey;

/** Build a lookup once; exported for tests and for keybinds.svelte.js, which rebuilds it per override. */
export function buildKeymap(entries = PROOFREAD_KEYS) {
  const map = new Map();
  for (const e of entries) for (const k of e.keys) map.set(norm(k), e);
  return map;
}

const DEFAULT_MAP = buildKeymap();

/**
 * Resolve a KeyboardEvent to an action.
 * -> { id, digit? } or null when the key isn't bound (caller must let it through).
 *
 * Modifier chords are deliberately NOT swallowed: Cmd/Ctrl combinations belong to the browser and the
 * command palette, and eating them here would break copy/paste and ⌘K mid-review.
 */
export function resolveKey(event, map = DEFAULT_MAP) {
  if (!event || event.metaKey || event.ctrlKey || event.altKey) return null;
  const t = event.target;
  // never hijack typing
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return null;
  const entry = map.get(norm(event.key));
  if (!entry) return null;
  return entry.digit ? { id: entry.id, digit: Number(event.key) } : { id: entry.id };
}

const GLOBAL_MAP = buildKeymap(GLOBAL_KEYS);
/** Resolve a key that applies when proofreading is OFF. */
export function resolveGlobalKey(event) { return resolveKey(event, GLOBAL_MAP); }

/** Legend rows for the help overlay, grouped in declaration order. */
export function keymapLegend(entries = [...PROOFREAD_KEYS, ...GLOBAL_KEYS]) {
  const groups = [];
  for (const e of entries) {
    let g = groups.find((x) => x.group === e.group);
    if (!g) { g = { group: e.group, rows: [] }; groups.push(g); }
    g.rows.push({ keys: e.keys.map((k) => (k === " " ? "Space" : k)), label: e.label });
  }
  return groups;
}
