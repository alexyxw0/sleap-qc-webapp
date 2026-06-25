<script>
  import { store } from "./lib/labelsStore.svelte.js";
  import { edit } from "./lib/editStore.svelte.js";
  import { view } from "./lib/viewStore.svelte.js";
  import { qc } from "./lib/qcStore.svelte.js";
  import FileUpload from "./lib/components/FileUpload.svelte";
  import Viewer from "./lib/components/Viewer.svelte";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import EditToolbar from "./lib/components/EditToolbar.svelte";
  import CommandPalette from "./lib/components/CommandPalette.svelte";
  import ShortcutsHelp from "./lib/components/ShortcutsHelp.svelte";
  import QcReview from "./lib/components/QcReview.svelte";
  import Toasts from "./lib/components/Toasts.svelte";
  import { ui } from "./lib/uiStore.svelte.js";

  // Reset edit history + view whenever a different labels object is loaded (or closed).
  let lastLabels = null;
  $effect(() => {
    if (store.labels !== lastLabels) {
      lastLabels = store.labels;
      edit.resetForNewFile();
      view.reset();
      qc.reset();
      ui.closeAll();
    }
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
  </main>
  <CommandPalette />
  <ShortcutsHelp />
  <QcReview />
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
    animation: fade-up 0.3s var(--ease) both;
  }
  .row {
    flex: 1;
    min-height: 0;
    display: flex;
  }
</style>
