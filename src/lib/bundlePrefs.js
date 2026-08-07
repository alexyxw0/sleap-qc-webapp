// Per-dataset memory of which appearance bundles were used, so reopening the SAME file auto-loads the
// SERVED selections (SAM bundle, nose model) and reminds you to re-pick any UPLOADED ones — browsers
// can't silently re-read a local file. Selection-only: we persist small references in localStorage,
// never the bundle bytes.
//
// Dataset identity = filename + video count + per-video shape (the same scheme the DINO embedding cache
// uses, minus the frame count, which labelsStore sets a tick after `labels` — so it may be stale when the
// file-open effect fires). Distinctive without reading pixels.
import { store } from "./labelsStore.svelte.js";
import { keypointModels } from "./keypointModels.svelte.js";
import { toast } from "./toastStore.svelte.js";

const LS = "sleap-qc:appearance-prefs";
const MODEL_BASE = `${import.meta.env.BASE_URL}nose_models/`;

export function datasetKey() {
  const L = store.labels;
  if (!L || !store.fileName) return null;
  const vids = L.videos ?? [];
  const shapes = vids.map((v) => (Array.isArray(v?.shape) ? v.shape.join("x") : "?")).join(",");
  return `${store.fileName}|${vids.length}|${shapes}`;
}

function readAll() {
  try { return JSON.parse(localStorage.getItem(LS) || "{}"); } catch { return {}; }
}
function writeAll(o) {
  try { localStorage.setItem(LS, JSON.stringify(o)); } catch { /* quota / private mode: ignore */ }
}

/** Remember that `kind` ("nose-emb" | "nose-model") was loaded for the current dataset.
 *  pref = { source: "served"|"upload", ref?: <servedFileName>, name: <label> }. */
export function remember(kind, pref) {
  const k = datasetKey();
  if (!k) return;
  const all = readAll();
  (all[k] ??= {})[kind] = { ...pref, at: Date.now() };
  writeAll(all);
}

function recall() {
  const k = datasetKey();
  return k ? readAll()[k] || {} : {};
}

/** On opening a file: auto-load remembered SERVED selections; toast a reminder for UPLOADED ones. */
export function autoLoadForCurrentFile() {
  const p = recall();
  if (p["nose-model"]?.source === "served") {
    keypointModels.loadModelFromUrl(MODEL_BASE + p["nose-model"].ref);
  }
  const noseUploads = [
    p["nose-emb"] && `embeddings “${p["nose-emb"].name}”`,
    p["nose-model"]?.source === "upload" && `model “${p["nose-model"].name}”`,
  ].filter(Boolean);
  if (noseUploads.length) toast(`Nose check used ${noseUploads.join(" + ")} here — re-select to load`);
}
