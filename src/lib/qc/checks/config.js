// Port of sleap/qc/config.py — QCConfig defaults + the "auto" feature toggles.

export function makeQCConfig(overrides = {}) {
  return {
    useGmm: true,
    useCurvature: "auto", // "auto" => enable for chains >= 5 nodes
    useSymmetry: "auto", // "auto" => enable when symmetry pairs exist
    useChirality: "auto", // "auto" => enable when symmetry pairs exist (skeleton or name-inferred)

    instanceThreshold: 0.7,
    duplicateIouThreshold: 0.5,
    duplicateNodeOverlapRatio: 0.8,
    duplicateNodeDistanceThreshold: 10.0,

    gmmNComponents: 5,
    gmmMinSamples: 50,
    gmmPercentileThreshold: 5.0,

    // Which instances define the outlier "normal" reference: "all" labeled, or "user" (user-
    // annotated only — cleaner ground truth, so predictions are measured against it).
    baselineSource: "all",

    // User-declared ordered chains (node-name sequences) for the chain-ordering check;
    // empty => fall back to the auto curvature chains.
    orderedChains: [],
    ...overrides,
  };
}

export const shouldUseCurvature = (config, maxChainLength) =>
  typeof config.useCurvature === "boolean" ? config.useCurvature : maxChainLength >= 5;
