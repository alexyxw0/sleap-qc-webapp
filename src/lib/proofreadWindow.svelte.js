// proofreadWindow.svelte.js
//
// Window-chrome state for proofreading — which subtab is showing, and whether the window is up. It owns
// NOTHING about labelling itself: the labels live in keypointLabels, the guided loop lives in
// proofreadSession, and the models live in keypointModels. Same split as appearanceRun, for the same
// reason: the window is one view onto that state, not its home, so closing it can never lose work.
//
// The Frames pane is real (the ranked queue). Judge and Labels are still placeholders pending spec.

/** Subtabs, in the order you meet them: pick a frame off the queue, judge it, get the labels out. */
export const PROOFREAD_TABS = [
  { id: "frames", label: "Frames", hint: "Every frame ranked by how faulty the detectors think it is" },
  { id: "judge", label: "Judge", hint: "Judge the current frame — keyboard-driven" },
  { id: "labels", label: "Labels", hint: "Everything marked so far, and getting it in or out as CSV" },
  { id: "keys", label: "Keybinds", hint: "Remap any action to the keys you want — saved for next time" },
];

const IDS = new Set(PROOFREAD_TABS.map((t) => t.id));

class ProofreadWindow {
  open = $state(false);
  tab = $state("frames");

  setTab(t) { if (IDS.has(t)) this.tab = t; }
  show() { this.open = true; }
  close() { this.open = false; }
  toggle() { this.open = !this.open; }
  showTab(t) { this.setTab(t); this.open = true; }

  /** A new file invalidates the queue and the cursor, so the window starts closed on its default pane. */
  reset() { this.open = false; this.tab = "frames"; }
}

export const proofreadWindow = new ProofreadWindow();
