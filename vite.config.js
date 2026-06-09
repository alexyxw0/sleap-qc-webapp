import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

const emptyStub = fileURLToPath(new URL("./src/stubs/empty.js", import.meta.url));

// Pure client-side SPA. sleap-io.js runs only in the browser (WASM h5wasm via a
// CDN-loaded Web Worker, WebCodecs for video). No SSR, so there is nothing to
// special-case for the server; we only nudge dep-optimization for the wasm/large deps.
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      // Node-only optional deps that sleap-io.js dynamically imports for server-side
      // rendering. They never run in the browser; stub them out of the client bundle
      // (skia-canvas otherwise drags in jszip and fails to resolve).
      "skia-canvas": emptyStub,
      tiff: emptyStub,
    },
  },
  optimizeDeps: {
    // h5wasm ships a .wasm + dynamic import; let it load as-is instead of being
    // pre-bundled. The primary load path uses the library's own worker (which pulls
    // h5wasm from jsDelivr), so this only matters for the main-thread fallback.
    exclude: ["h5wasm"],
  },
  build: {
    target: "esnext", // top-level await + modern features used by the deps
  },
});
