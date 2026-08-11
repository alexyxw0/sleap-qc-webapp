# UI/UX — design and implementation

A detector that says "frame 4,312 is suspect" has handed the search problem back to the user. Almost
every decision below follows from taking that seriously: the interface's job is to get a reviewer to
the *thing that is wrong*, in as few actions as possible, without ever lying about how sure it is.

Stack: Svelte 5 (runes), canvas rendering, no UI framework. Compute lives in workers; the UI thread
stays free so arrow-key traversal keeps working during a 30-minute embedding run.

---

## Principles the code actually holds to

**Say what is wrong, not that something is wrong.** Every flag resolves to a shape on the canvas —
an edge, an angle, a node, or the instance box — matching the geometry the check measured. See
[METHODS §3](METHODS.md#3-attribution--turning-a-score-into-a-place-on-the-animal).

**Never a dead end.** Every question is answerable, and every branch has a way back. This was broken
twice and both were real bugs: the AnomalyDINO option was `disabled` when a run had no patch
features, with the *only* fix — the recompute toggle — sitting behind the button that was disabled;
and the flow's only backward move was "‹ start", so backing out of one answer discarded the route and
every step with it. Answering is always allowed; cost is explained afterwards.

**A button says where it goes.** Back reads "‹ Embed", "‹ technique", "‹ start" — the destination on
the face, not something you learn by pressing it.

**Empty and partial states are honest.** A check with no data shows no checkbox rather than an
unticked one. A run that reused a cache written before patch features existed says *"every keypoint is
still scored by kNN"* and prices the recompute, instead of implying AnomalyDINO ran. A score of 0
because nothing is known is never presented as "clean".

**Hedge in the copy, not in the ranking.** The QC card states plainly that an anomaly is
"geometrically unusual vs. the rest of this file — a review hint, not a certain error", so a high
score reads as *look here*, not *definitely wrong*.

---

## Layout

**`RailTabs` + `Sidebar`** — a hover rail selects, a docked panel holds the content, and they are two
separate components on purpose: the open tab persists while you hover elsewhere. Four tabs — frame,
checks, appearance, analysis. Docked and in-flow rather than overlaid, so opening a panel resizes the
viewer instead of covering the animal you are looking at. (`body { overflow: hidden }` is
load-bearing.)

**`Viewer`** — canvas. Instances, skeleton, per-instance colour, QC marks, selection, drag-to-edit.
One pass per instance resolves exactly one mark (angle > edge > node), because the three are mutually
exclusive and `instanceFlagged` used to be evaluated three times per instance per redraw.

**`FrameGrid` / `HeatTimeline`** — the file at a glance: per-frame heat bar (green→red) and issue
markers, so a reviewer can see where the problems cluster before opening any of them.

**Popouts** (`PopoutWindow`, `WinTabs`) — Appearance and Proofreading are draggable windows, not
routes. They are long-running jobs you want to watch while still navigating frames.

---

## Review mode (`QcReview`)

The correction loop. Steps through flagged frames **worst-first** and, on each, **zooms to the
instance that needs adjusting** — not to the whole scene, which on a 1000-px frame put the keypoint
you were sent to fix a few pixels across and made hand-zooming the first action on every frame.

The framing keeps the three things whole-scene framing was right about:

- a flag with no single culprit (instance count, negative frame) still frames everything — then the
  frame *is* the subject;
- a cross-instance flag pulls in the instance it is being compared against, because showing one of a
  duplicate pair is showing half the evidence;
- a tiny instance is padded to a floor (9% of the image's larger side) rather than framing to its own
  three pixels and returning a wall of interpolated grey — the box is expanded rather than the zoom
  capped, so the subject stays centred while it gains context.

Re-framing fires **only when the shown frame changes** — not on an edit, and deliberately not when
you select an instance by hand. Clicking a node on the other animal must not yank the view off the
one you were about to drag. `0` re-frames the culprit on demand (useful after a correction moves the
blame elsewhere); `shift-0` pulls back to the whole frame.

Ordering is switchable — severity, detector agreement, or chronological — and the queue is
**snapshotted on open**, so re-scoring after a correction doesn't reshuffle the list under you
mid-session. Verdicts still update live.

Session state is deliberately absolute (`scale` + image-space centre) rather than derived from the
live points, which is what stops a node-drag from re-framing the canvas.

---

## Making flags clickable

Every flagging indicator in the sidebar is a link to the instance it blames — the frame-level issue
list and the "all checks" list both. Rows for checks that are genuinely frame-wide stay plain text: a
link that goes nowhere is worse than no link.

A blame is only offered when the score clears that check's own threshold, so a row never points at an
instance the check did not flag.

---

## The Appearance workflow

The pane that took the most iteration, because it is a genuine decision tree and it used to be a set
of tabs you had to already understand.

```
What are you starting from?
├── precomputed bundles ──→ load ──→ score: as-is │ adapt (CSV │ proofread)
└── compute from this file ──→ 1 Embed (granularity, coverage, run)
                              └→ 2 Score (per keypoint):
                                   which technique?
                                   ├── kNN            (unsupervised, already applied)
                                   ├── AnomalyDINO    (unsupervised, patch-level)
                                   └── SVM            → upload a model │ few-shot here
```

Rules that make it work:

- **One question on screen at a time**, each answer routing the next. Nothing answers on the user's
  behalf — an unanswered question is the only thing that renders as a question.
- **The run doesn't just end.** Finishing the embedding pass used to leave you looking at a graph with
  no "what now". Scoring is now step 2, asked automatically.
- **Scoring is per keypoint**, so the keypoint picker lives *inside* the question rather than in the
  results graph below it — one decision, one place.
- **Back pops exactly one answer** (see above), and the step strip shows what is done, what is locked,
  and *why* it is locked.
- Each action reports its own outcome in the pane. A fit that silently did nothing, or an upload that
  silently failed, is the failure mode this flow exists to remove.

---

## Proofreading (`ProofreadWindow`, `proofreadSession`)

Where ground truth gets made. Presents the (instance, keypoint) candidates the detectors rank as most
suspect — **active learning**, because labelling from the top of a ranked queue is far cheaper than
labelling at random (offline: 10 targeted labels moved transfer PR 0.08 → 0.29). Keyboard-driven:
faulty / clean / unset, next-unreviewed, cycle keypoint, zoom.

Labels are keyed `"video:frame:instance"` throughout, so the in-app labeller, the few-shot matcher,
the SVM fitter and the CSV export all join without translation.

---

## Analysis tab

Detector overlap (which checks agree, and on what), comparison against a human review CSV, and
export. This is where you find out a check is redundant with another, or that your thresholds flag
600 frames nobody will ever look at.

---

## Performance

The app routinely holds ~4,700 frames and ~58,000 embedded patches, so several things that look like
premature optimisation are not:

- **Reactivity is scoped.** A store-wide `rev` bump on a node drag once triggered an O(all frames)
  rescan; the store exposes `structRev` / `dirtyRev` / `qc.rev` separately so a drag only redraws.
- **Frame decode is LRU-cached** (~54 ms/frame uncached). "Laggy" had two independent causes and
  fixing one alone did nothing perceptible.
- **Per-instance attribution is O(1).** Worst-node lookup was a scan of every embedded patch plus a
  `frames.indexOf` on the render path — 703 ms → 1.6 ms on a full pass once both became map lookups
  built in the same sweep as the frame maps.
- **Blame results are memoized per `rev`.** Thresholds decide which check speaks, and moving a slider
  bumps `rev` without re-running, so a cache that outlived a `rev` would keep painting the previous
  threshold's verdict.
- **Workers** for inference and scoring; the scoring pass falls back to the main thread when workers
  are unavailable (tests, restrictive CSP) with identical results.

---

## Testing the interface

Component tests that assert on rendered strings are weak evidence, and two shipped bugs proved it:
both were about a check's output never *reaching* the canvas, and every unit test was green.

What the suite does now:

- **Behaviour over the real pipeline.** `qcStore.blameCoverage.test.js` turns on **one check at a
  time**, runs the real detector over a real `.slp`, and for every frame it flags asserts there is an
  instance to go to *and* something to draw. Seven checks flag nothing at stock thresholds on the
  fixture, so each is tuned until it fires and asserted **non-vacuous** — an empty list fails rather
  than passes quietly. Where the fixture structurally cannot trip a check (no symmetry pairs, no chain
  ≥5, no video size, no overlapping animals), the *reason* is asserted, so it fails loudly if that
  changes.
- **Canvas assertions against a recording context.** `draw.test.js` runs `drawScene` against a fake
  2D context that records each paint with the style in force *at paint time*, then reads back what was
  actually painted.
- **SSR render probe.** `vite.ssrLoadModule` + `svelte/server`'s `render` across every component and
  state. A deleted identifier passes build *and* vitest and throws only on render; this is the only
  thing that catches it.
- **Mutation checking.** Every fix is verified by reverting it and confirming the right test fails.
  Where no test could distinguish a line, the line was deleted rather than left as coverage theatre.
