// DINOv2 ViT-S/14 embedding via transformers.js, pulled from a CDN on demand (mirrors how the app
// already loads h5wasm from jsDelivr — no build-time dependency, model cached by the browser).
//
// DINOv2 is a self-supervised vision transformer: it maps an image crop to a 384-d semantic
// appearance vector WITHOUT any pose/keypoint labels. That's exactly the signal geometry lacks —
// an occluded or mis-placed instance *looks* different, so it lands far from the rest in this space.

export const MODEL = {
  id: "Xenova/dinov2-small",
  name: "DINOv2 ViT-S/14",
  dim: 384,
  patch: 14,
  input: 224,
  backend: null, // set at load: which compute backend actually ran ("WebGPU" | "WASM (q8)" | "WASM (fp32)")
  note: "self-supervised image transformer · embeds appearance, not keypoints",
};

// transformers.js CDN ESM bundle (pinned; +esm makes jsDelivr serve a browser ESM build).
const TF_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm";

let _tf = null;
let _model = null;
let _processor = null;
let _ready = null;

/** Load transformers.js + the DINOv2 model (once). `onProgress` gets transformers.js download events.
 *  A ViT-S forward pass is ~4.5 GFLOPs, so the BACKEND decides whether each crop is ~50ms or ~500ms.
 *  We try, in order: WebGPU (GPU — typically 5-20× faster than CPU), a quantized WASM build (~2-4×
 *  faster than fp32), then plain fp32 WASM (always works). Each candidate is warmed up with one dummy
 *  inference so a backend that LOADS but can't actually run (e.g. an op WebGPU lacks) is rejected
 *  before we commit to it. First that runs wins; the choice is recorded in MODEL.backend. */
export async function ensureModel(onProgress) {
  if (_model) return MODEL;
  if (!_ready) {
    _ready = (async () => {
      _tf = await import(/* @vite-ignore */ TF_URL);
      _tf.env.allowLocalModels = false; // fetch from the HF hub
      _tf.env.useBrowserCache = true; // keep the weights across runs
      _processor = await _tf.AutoProcessor.from_pretrained(MODEL.id);

      const hasGPU = typeof navigator !== "undefined" && !!navigator.gpu;
      const attempts = [
        ...(hasGPU ? [{ device: "webgpu", dtype: "fp32", label: "WebGPU" }] : []),
        { device: "wasm", dtype: "q8", label: "WASM (q8)" },
        { device: "wasm", dtype: "fp32", label: "WASM (fp32)" }, // ≈ the previous default — guaranteed to load
      ];
      const dummy = new _tf.RawImage(new Uint8ClampedArray(MODEL.input * MODEL.input * 4), MODEL.input, MODEL.input, 4);
      let lastErr = null;
      for (const a of attempts) {
        try {
          if (onProgress) onProgress({ status: `init ${a.label}` });
          const model = await _tf.AutoModel.from_pretrained(MODEL.id, { device: a.device, dtype: a.dtype, progress_callback: onProgress });
          const inp = await _processor(dummy);
          await model(inp); // warmup + validation: rejects a backend that loads but can't run inference
          _model = model;
          MODEL.backend = a.label;
          break;
        } catch (e) { lastErr = e; }
      }
      if (!_model) throw lastErr ?? new Error("no usable inference backend");
    })().catch((e) => { _ready = null; throw e; });
  }
  await _ready;
  return MODEL;
}

export function isLoaded() {
  return !!_model;
}

/** Embed a square RGB canvas crop → the CLS-token appearance vector (Float32Array, length 384). */
export async function embed(canvas) {
  if (!_model) throw new Error("call ensureModel() first");
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const id = ctx.getImageData(0, 0, width, height);
  const image = new _tf.RawImage(id.data, width, height, 4); // processor handles resize + normalize
  const inputs = await _processor(image);
  const out = await _model(inputs);
  const t = out.last_hidden_state ?? out.pooler_output ?? out.logits;
  const dims = t.dims;
  const D = dims[dims.length - 1];
  const src = t.data;
  const cls = new Float32Array(D); // CLS token = the first token of last_hidden_state
  for (let d = 0; d < D; d++) cls[d] = src[d];
  return cls;
}
