import { describe, it, expect } from "vitest";
import { manualCheck } from "./manualCheckStore.svelte.js";

describe("manualCheckStore", () => {
  it("reset() clears the upload — App calls it on file load so a stale CSV can't score a new file", () => {
    manualCheck.manual = { byKey: new Map(), faulty: 3, total: 10 };
    manualCheck.fileName = "review-A.csv";
    manualCheck.reset();
    expect(manualCheck.manual).toBeNull();
    expect(manualCheck.fileName).toBe("");
  });
});
