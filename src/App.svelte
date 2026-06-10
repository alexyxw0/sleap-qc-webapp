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
{:else}
  <FileUpload />
{/if}
<Toasts />

<style>
  .app {
    height: 100vh;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    padding: 0.85rem;
    box-sizing: border-box;
    animation: fade-up 0.4s var(--ease) both;
  }
  .row {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 1rem;
  }
</style>
