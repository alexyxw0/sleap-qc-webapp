<script>
  import { store } from "./lib/labelsStore.svelte.js";
  import { edit } from "./lib/editStore.svelte.js";
  import { view } from "./lib/viewStore.svelte.js";
  import { qc } from "./lib/qcStore.svelte.js";
  import FileUpload from "./lib/components/FileUpload.svelte";
  import Viewer from "./lib/components/Viewer.svelte";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import RailTabs from "./lib/components/RailTabs.svelte";
  import EditToolbar from "./lib/components/EditToolbar.svelte";
  import CommandPalette from "./lib/components/CommandPalette.svelte";
  import ShortcutsHelp from "./lib/components/ShortcutsHelp.svelte";
  import QcReview from "./lib/components/QcReview.svelte";
  import AppearanceWindow from "./lib/components/AppearanceWindow.svelte";
  import ProofreadWindow from "./lib/components/ProofreadWindow.svelte";
  import Toasts from "./lib/components/Toasts.svelte";
  import { ui } from "./lib/uiStore.svelte.js";
  import { manualCheck } from "./lib/manualCheckStore.svelte.js";
  import { keypointModels } from "./lib/keypointModels.svelte.js";
  import { appRun } from "./lib/appearanceRun.svelte.js";
  import { proofreadWindow } from "./lib/proofreadWindow.svelte.js";
  import { framePass } from "./lib/framePass.svelte.js";
  import { keypointLabels } from "./lib/keypointLabels.svelte.js";
  import { autoLoadForCurrentFile } from "./lib/bundlePrefs.js";

  // Reset edit history + view whenever a different labels object is loaded (or closed).
  let lastLabels = null;
  $effect(() => {
    if (store.labels !== lastLabels) {
      lastLabels = store.labels;
      edit.resetForNewFile();
      view.reset();
      qc.reset();
      ui.closeAll();
      appRun.close(); // a floating run window over a different file is just confusing
      proofreadWindow.reset();
      framePass.reset();
      manualCheck.reset(); // else a stale CSV would score against the new file's frames
      // Same hazard, worse: keypoint labels are keyed "videoIdx:frameIdx:inst" — a key EVERY file has —
      // so the last file's verdicts would paint red rings and "✓ judged" onto this one's frames, and
      // toCsv() would export two datasets under one schema. The mode and the budget are preferences; keep them.
      keypointLabels.clear();
      keypointLabels.cursor = 0;
      // Clear the previous file's appearance bundles (their scores are keyed to that file's instances),
      // then auto-load whatever SAM/DINO selection was remembered for THIS dataset (bundlePrefs).
      keypointModels.reset();
      if (store.labels) autoLoadForCurrentFile();
    }
  });

  // Proofreading is a MODE, and its window is that mode's home — so entering the mode raises it, from
  // whichever entry point (the `r` key, the toggle in the panel, the command palette). Leaving the mode
  // does NOT close it: you may still want to read the tally or export what you just labelled.
  let wasProofreading = false;
  $effect(() => {
    const on = keypointLabels.proofreading;
    if (on && !wasProofreading) proofreadWindow.show();
    wasProofreading = on;
  });

  // Auto-rerun QC when the detection selection adds an uncomputed check, so the flagged set
  // always reflects the current checks without a manual Run. Gated on status "done": the
  // FIRST run stays manual (heavy units like GMM remain opt-in), and a failed run won't loop.
  // Converges because run() computes the pending units, driving pendingCount back to 0.
  $effect(() => {
    if (qc.pendingCount > 0 && qc.status === "done") qc.run();
  });

  // Warn before leaving with unsaved edits.
  function onBeforeUnload(e) {
    if (edit.dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  }
</script>

<svelte:window onbeforeunload={onBeforeUnload} />

{#if store.ready}
  <main class="app">
    <EditToolbar />
    <div class="row">
      <Viewer />
      <Sidebar />
    </div>
    <RailTabs />
  </main>
  <CommandPalette />
  <ShortcutsHelp />
  <QcReview />
  <!-- Floating, so it outlives the tab that launched it: a run keeps going while you browse frames. -->
  <AppearanceWindow />
  <ProofreadWindow />
{:else}
  <FileUpload />
{/if}
<Toasts />

<style>
  /* One fused instrument face: the video is framed in its own region, panels meet
     at hairlines, nothing floats over the footage except the HUD readouts and the
     review panel. */
  .app {
    height: 100vh;
    display: flex;
    flex-direction: column;
    /* The tab strip is fixed to the right edge and always visible, so the shell gives up exactly its
       width. Without this the strip would sit ON TOP of whatever is rightmost — usually the docked
       panel's scrollbar, occasionally a control. */
    padding-right: var(--rail-mini);
    /* `backwards`, NOT `both`. `both` keeps the last keyframe applied forever, and that keyframe
       sets `transform: translateY(0)` — a transform other than `none`, which makes this element a
       STACKING CONTEXT permanently. Every z-index inside the shell was then trapped below it, so a
       floating window (z 300, a sibling of this element) painted over the tab strip and the docked
       panel no matter how high their z-index went: with the proofreading window open you could not
       see Detection checks or Appearance at all. The final keyframe is identical to the element's
       own style, so dropping the forwards half changes nothing visually. */
    animation: fade-up 0.3s var(--ease) backwards;
  }
  .row {
    flex: 1;
    min-height: 0;
    display: flex;
  }
</style>
