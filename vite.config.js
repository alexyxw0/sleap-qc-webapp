import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

const emptyStub = fileURLToPath(new URL("./src/stubs/empty.js", import.meta.url));

// Cross-origin isolation: gives the page SharedArrayBuffer, which onnxruntime-web (the DINO
// appearance backend) requires for its WASM thread pool — without these two headers it silently
// falls back to ONE thread (~3-4× slower inference, only a console warning). Safe with our
// cross-origin deps: jsDelivr sends `Cross-Origin-Resource-Policy: cross-origin` + `ACAO: *`, the
// HF hub echoes the request Origin (CORS), and the h5wasm/DINO workers are same-origin blob/module
// workers that inherit the policy. A production host must send the same two headers to keep
// multi-threaded inference (the app still works without them, just single-threaded).
const coi = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// Pure client-side SPA. sleap-io.js runs only in the browser (WASM h5wasm via a
// CDN-loaded Web Worker, WebCodecs for video). No SSR, so there is nothing to
// special-case for the server; we only nudge dep-optimization for the wasm/large deps.
export default defineConfig({
  plugins: [svelte()],
  server: { headers: coi },
  preview: { headers: coi },
  worker: {
    format: "es", // the DINO embed worker dynamic-imports transformers.js from the CDN — needs ESM output
  },
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
