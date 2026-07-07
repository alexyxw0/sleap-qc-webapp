import { defineConfig } from "vitest/config";

// QC logic is framework-agnostic pure modules + a couple of node integration tests that
// use sleap-io.js. Node environment (no DOM) keeps it fast; Svelte components are not
// unit-tested here.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/lib/**/*.test.js"],
    testTimeout: 20000, // the corrections roundtrip loads/saves a real .slp via h5wasm
  },
});
