import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Pure QC modules + node integration tests (sleap-io.js), PLUS runtime tests that drive the reactive
// stores. The svelte plugin compiles `.svelte.js` runes so those modules can be imported and their
// methods executed exactly as in the browser — catching runtime/scope/control-flow bugs that a
// production build and pure-function tests do NOT (e.g. an out-of-scope var that throws only at run
// time, or a run() path that never reaches a terminal status). DOM/model are mocked per-test.
export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: "node",
    include: ["src/lib/**/*.test.js"],
    testTimeout: 20000, // the corrections roundtrip loads/saves a real .slp via h5wasm
  },
});
