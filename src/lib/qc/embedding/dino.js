// DINOv2 ViT-S/14 embedding via transformers.js, pulled from a CDN on demand (mirrors how the app
// already loads h5wasm from jsDelivr — no build-time dependency, model cached by the browser).
//
// DINOv2 is a self-supervised vision transformer: it maps an image crop to a 384-d semantic
// appearance vector WITHOUT any pose/keypoint labels. That's exactly the signal geometry lacks —
// an occluded or mis-placed instance *looks* different, so it lands far from the rest in this space.
//
// DOM-free on purpose: the normal path runs this module inside embedWorker.js (see dinoRemote.js),
// so crops arrive as raw RGBA buffers, not canvases.

export const MODEL = {
  id: "Xenova/dinov2-small",
  name: "DINOv2 ViT-S/14",
  dim: 384,
  patch: 14,
  input: 224,
  backend: null, // set at load: the compute config that actually ran, e.g. "WASM (q8) · SIMD · 6 threads"
  batch: 2, // crops per forward pass when running ON the calling thread (dinoRemote's worker path raises it)
  note: "self-supervised image transformer · embeds appearance, not keypoints",
};

// transformers.js CDN ESM bundle (pinned; +esm makes jsDelivr serve a browser ESM build).
const TF_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm";

// WASM capability probes — the exact WebAssembly.validate payloads onnxruntime-web runs internally.
// ORT ships ONLY fixed-SIMD binaries (ort-wasm-simd-threaded*.wasm), so SIMD can't silently fall back
// to scalar — a browser without it would fail to load outright. Relaxed-SIMD kernels are NOT in the
// shipped build (the flag `simd: "relaxed"` only validates support; the binary is the same), so that
// probe is diagnostic-only. THREADS are the config that really varies: without cross-origin isolation
// ORT caps the pool at 1 thread with nothing but a console warning — vite.config.js sets COOP/COEP
// exactly so this doesn't happen.
const SIMD_PROBE = [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 30, 1, 28, 0, 65, 0, 253, 15, 253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 253, 186, 1, 26, 11];
const RELAXED_PROBE = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 19, 1, 17, 0, 65, 1, 253, 15, 65, 2, 253, 15, 65, 3, 253, 15, 253, 147, 2, 11];

export function wasmCaps() {
  const val = (bytes) => { try { return WebAssembly.validate(new Uint8Array(bytes)); } catch { return false; } };
  return {
    simd: val(SIMD_PROBE),
    relaxedSimd: val(RELAXED_PROBE),
    isolated: typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated === true,
    cores: globalThis.navigator?.hardwareConcurrency || 4,
  };
}

let _tf = null;
let _model = null;
let _processor = null;
let _ready = null;

/** Load transformers.js + the DINOv2 model (once). `onProgress` gets transformers.js download events.
 *  A ViT-S forward pass is ~4.5 GFLOPs, so the BACKEND decides whether each crop is ~150ms or ~500ms.
 *  We embed small batches on a SMALL model — the regime where CPU beats GPU: WebGPU's per-call
 *  upload→dispatch→readback overhead exceeds its compute win here, AND it saturates the same GPU the
 *  browser composites the UI on, so it's both slower and makes the whole app stutter. So we stay on
 *  WASM and pick the fastest weights: quantized int8 (~2-4× faster than fp32 on CPU via SIMD), falling
 *  back to fp32. Each is warmed up with a dummy inference to reject a broken build. */
export async function ensureModel(onProgress) {
  if (_model) return MODEL;
  if (!_ready) {
    _ready = (async () => {
      _tf = await import(/* @vite-ignore */ TF_URL);
      _tf.env.allowLocalModels = false; // fetch from the HF hub
      _tf.env.useBrowserCache = true; // keep the weights across runs
      _processor = await _tf.AutoProcessor.from_pretrained(MODEL.id);

      // Size the ORT thread pool BEFORE the first session is created (the flags freeze after init).
      // Leave two cores of headroom for the UI thread and the video decoder; without isolation ORT
      // would force 1 anyway — set it explicitly so the intent is visible.
      const caps = wasmCaps();
      const wasmEnv = _tf.env.backends.onnx.wasm;
      wasmEnv.numThreads = caps.isolated ? Math.min(8, Math.max(2, caps.cores - 2)) : 1;

      const attempts = [
        { device: "wasm", dtype: "q8", label: "WASM (q8)" }, // int8 — ~2-4× faster than fp32 on CPU
        { device: "wasm", dtype: "fp32", label: "WASM (fp32)" }, // ≈ the original default — guaranteed to load
      ];
      const dummy = { data: new Uint8ClampedArray(MODEL.input * MODEL.input * 4), width: MODEL.input, height: MODEL.input };
      let lastErr = null;
      for (const a of attempts) {
        try {
          if (onProgress) onProgress({ status: `init ${a.label}` });
          _model = await _tf.AutoModel.from_pretrained(MODEL.id, { device: a.device, dtype: a.dtype, progress_callback: onProgress });
          await embedBatchImages([dummy]); // warmup + validation: rejects a backend that loads but can't run
          const threads = wasmEnv.numThreads ?? 1; // ORT rewrites this to the pool size it actually got
          MODEL.backend = `${a.label} · SIMD · ${threads} thread${threads === 1 ? "" : "s"}${caps.isolated ? "" : " — no cross-origin isolation"}`;
          console.info(`[dino] ${MODEL.backend} · relaxed-SIMD ${caps.relaxedSimd ? "in browser but not in the ORT build" : "unsupported"} · crossOriginIsolated=${caps.isolated}`);
          break;
        } catch (e) { _model = null; lastErr = e; }
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

/** Embed a batch of RGBA crops ({ data, width, height } — e.g. an ImageData) → one CLS appearance
 *  vector per crop (Float32Array, length MODEL.dim; caller normalizes). One forward pass for the whole
 *  batch: amortizes the JS↔WASM round-trip and keeps the thread pool fed between layers, which is
 *  markedly faster per crop than calling the model once per crop. */
export async function embedBatchImages(images) {
  if (!_model) throw new Error("call ensureModel() first");
  const raws = images.map((im) => new _tf.RawImage(im.data, im.width, im.height, 4)); // processor: resize + normalize
  const inputs = await _processor(raws);
  const out = await _model(inputs);
  const t = out.last_hidden_state ?? out.pooler_output ?? out.logits;
  const dims = t.dims;
  const D = dims[dims.length - 1];
  const stride = dims.length >= 3 ? dims[1] * D : D; // [B, tokens, D] → CLS = token 0 of each item
  return images.map((_, b) => t.data.slice(b * stride, b * stride + D));
}
