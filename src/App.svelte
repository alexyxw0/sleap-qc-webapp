<script>
  import { store } from "./lib/labelsStore.svelte.js";
  import FileUpload from "./lib/components/FileUpload.svelte";
  import Viewer from "./lib/components/Viewer.svelte";
  import Sidebar from "./lib/components/Sidebar.svelte";
</script>

{#if store.ready}
  <main class="app">
    <Viewer />
    <Sidebar />
  </main>
{:else}
  <FileUpload />
{/if}

<style>
  .app {
    height: 100vh;
    display: flex;
    gap: 1rem;
    padding: 1rem;
    box-sizing: border-box;
  }
</style>
