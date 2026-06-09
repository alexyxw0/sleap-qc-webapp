<script>
  import { store } from "./lib/labelsStore.svelte.js";
  import { edit } from "./lib/editStore.svelte.js";
  import FileUpload from "./lib/components/FileUpload.svelte";
  import Viewer from "./lib/components/Viewer.svelte";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import EditToolbar from "./lib/components/EditToolbar.svelte";

  // Reset the edit history whenever a different labels object is loaded (or closed).
  let lastLabels = null;
  $effect(() => {
    if (store.labels !== lastLabels) {
      lastLabels = store.labels;
      edit.resetForNewFile();
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
{:else}
  <FileUpload />
{/if}

<style>
  .app {
    height: 100vh;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem;
    box-sizing: border-box;
  }
  .row {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 1rem;
  }
</style>
