// Port of sleap/qc/config.py — QCConfig defaults + the "auto" feature toggles.

export function makeQCConfig(overrides = {}) {
  return {
    useGmm: true,
    useCurvature: "auto", // "auto" => enable for chains >= 5 nodes
    useSymmetry: "auto", // "auto" => enable when symmetry pairs exist
    useAnatomical: false,

    instanceThreshold: 0.7,
    frameThreshold: 0.5,
    duplicateIouThreshold: 0.5,
    duplicateNodeOverlapRatio: 0.8,
    duplicateNodeDistanceThreshold: 10.0,

    gmmNComponents: 5,
    gmmMinSamples: 50,
    gmmPercentileThreshold: 5.0,

    autoCalibrate: true, // reserved / unused, mirrors the Python dead field
    calibrationPercentile: 95.0,
    ...overrides,
  };
}

export const shouldUseCurvature = (config, maxChainLength) =>
  typeof config.useCurvature === "boolean" ? config.useCurvature : maxChainLength >= 5;

export const shouldUseSymmetry = (config, hasSymmetry) =>
  typeof config.useSymmetry === "boolean" ? config.useSymmetry : hasSymmetry;
