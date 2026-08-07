// Per-keypoint NOSE appearance QC check (the validated dino_probe detector: CV ROC ~0.92 / PR ~0.62).
//
// In-browser DINO is too slow, so this scores PRECOMPUTED nose embeddings with a ported calibrated RBF-SVM
// (RBF + Platt). EMBEDDINGS and MODEL are loaded SEPARATELY so you can score one project's embeddings with
// ANOTHER project's model — a transfer test:
//   EMBEDDINGS  precomputed/nose_emb_<ds>__p<N>.bin   (uploaded — ~9 MB)   header: dataset,dim,n,video/frame_idx/inst
//   MODEL       public/nose_models/nose_model_<ds>__p<N>.bin (fetched from a dropdown) header: model params
// Both are produced by dino_probe/export_nose.py --split. The legacy self-contained welded bundle
// (nose_bundle_<ds>.bin) still loads via loadPrecomputed(). Duck-types the appearance-store interface qcStore
// expects (see APPEARANCE_CHECKS).
//
// file layout (all): [uint32 LE hlen][utf8 json header, 4B-padded][f32 payload]
//   model payload:  mean|scale|dual|support_vectors      emb payload: n*dim embeddings
import { parseClassifier, rbfProbability } from "./qc/embedding/svm.js";
import { prototypeDirection, prototypeScores, blendByRank } from "./qc/embedding/fewshot.js";
import { keypointLabels } from "./keypointLabels.svelte.js";

function readHeader(buf) {
  const hlen = new DataView(buf).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hlen)));
  return { header, f32Start: 4 + hlen };
}

export class NoseEmbeddingStore {
  threshold = $state(0.5);   // probability cutoff; set from the model's operating point on load
  fewShot = $state(0);       // 0 = transferred model as-is; >0 blends in a prototype direction learned
                             // from the target-domain keypoint labels (see qc/embedding/fewshot.js)
  fewShotInfo = $state(null); // { nPos, nNeg, usedGlobal } for the UI, or null when not adapting
  resultRev = $state(0);     // bumps when scored frame-flags change — the cheap reactive dep
  status = $state("idle");   // idle | loading | done | error
  message = $state("");
  #frameZ = new Map();        // "videoIdx:frameIdx" -> max nose fault-probability over the frame's instances
  #instProb = new Map();      // "videoIdx:frameIdx:inst" -> nose fault-probability (per-instance attribution)
  #embHeader = $state(null);  // loaded embeddings header (dataset, dim, n, video/frame_idx/inst)
  #modelInfo = $state(null);  // loaded model header (dataset, dim, cv_roc, threshold, …)
  #embs = null;               // Array<Float32Array(dim)> — the patches to score
  #clf = null;                // parsed RBF-SVM
  #n = 0;

  get hasResults() { this.resultRev; return this.#frameZ.size > 0; }
  get count() { this.resultRev; return this.#n; }

  /** Combined state for the UI: which embeddings + which model, and whether that's a transfer pairing. */
  get info() {
    this.resultRev;
    const e = this.#embHeader, m = this.#modelInfo;
    if (!e && !m) return null;
    return {
      dataset: e?.dataset ?? null,               // embeddings project (what NoseCheck's sub line reads)
      model_dataset: m?.dataset ?? null,         // model project
      transfer: !!(e && m && e.dataset !== m.dataset),
      cv_roc: m?.cv_roc ?? null, cv_pr: m?.cv_pr ?? null, confidence: m?.confidence ?? null,
      dim: e?.dim ?? m?.dim ?? null, node_min: e?.node_min ?? m?.node_min ?? null,
      hasEmb: !!e, hasModel: !!m,
    };
  }
  get embDataset() { this.resultRev; return this.#embHeader?.dataset ?? null; }
  get modelDataset() { this.resultRev; return this.#modelInfo?.dataset ?? null; }
  /** Which keypoint this trained bundle targets (per-keypoint generalization; legacy bundles → "nose"). */
  get node() { this.resultRev; return this.#embHeader?.node ?? this.#modelInfo?.node ?? "nose"; }

  frameZByKey(key) { this.resultRev; return this.#frameZ.get(key) ?? null; }
  instProbByKey(key) { this.resultRev; return this.#instProb.get(key) ?? null; }
  /** Every scored instance as ["videoIdx:frameIdx:inst", prob] — the registry ranks the review queue. */
  instProbEntries() { this.resultRev; return this.#instProb.entries(); }

  get flaggedFrameCount() {
    this.resultRev;
    let n = 0;
    for (const z of this.#frameZ.values()) if (z >= this.threshold) n++;
    return n;
  }
  flaggedFrameKeys() { return this.flaggedFrameKeysAt(this.threshold); }
  /** Same, judged against an EXTERNAL cutoff — the registry applies one shared threshold across keypoints
   *  (calibrated probabilities are comparable, so a per-slot cutoff would make the union incoherent). */
  flaggedFrameKeysAt(thr) {
    this.resultRev;
    const out = [];
    for (const [k, z] of this.#frameZ) if (z >= thr) out.push(k);
    return out;
  }
  flaggedCountAt(thr) {
    this.resultRev;
    let n = 0;
    for (const z of this.#instProb.values()) if (z >= thr) n++;
    return n;
  }
  get flaggedCount() {
    this.resultRev;
    let n = 0;
    for (const z of this.#instProb.values()) if (z >= this.threshold) n++;
    return n;
  }

  /** Re-run scoring — call after the few-shot slider or the label set changes (cheap: no re-embed). */
  rescore() { this.#score(); }

  reset() {
    this.#frameZ = new Map();
    this.#instProb = new Map();
    this.#embHeader = null;
    this.#modelInfo = null;
    this.#embs = null;
    this.#clf = null;
    this.#n = 0;
    // The few-shot state is per-FILE too: leaving it set made a brand-new file show "adapting · nose
    // α=0.35" against a slot with nothing loaded in it.
    this.fewShot = 0;
    this.fewShotInfo = null;
    this.status = "idle";
    this.message = "";
    this.resultRev++;
  }

  // ---- EMBEDDINGS (uploaded) ----
  async loadEmbeddings(file) {
    this.status = "loading";
    this.message = "Reading embeddings…";
    this.resultRev++;
    try {
      const buf = await file.arrayBuffer();
      const { header, f32Start } = readHeader(buf);
      const { dim, n } = header;
      const flat = new Float32Array(buf, f32Start, n * dim);
      const embs = new Array(n);
      for (let i = 0; i < n; i++) embs[i] = flat.subarray(i * dim, i * dim + dim);
      this.#embs = embs;
      this.#embHeader = header;
      this.#n = n;
      this.#score();
    } catch (e) {
      this.status = "error";
      this.message = `Embeddings load failed — ${e?.message ?? e}`;
      this.resultRev++;
    }
  }

  // ---- MODEL (fetched from the served dropdown, or uploaded) ----
  async loadModelFromUrl(url) {
    this.status = "loading";
    this.message = "Loading model…";
    this.resultRev++;
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      this.#ingestModel(await resp.arrayBuffer());
    } catch (e) {
      this.status = "error";
      this.message = `Model load failed — ${e?.message ?? e}`;
      this.resultRev++;
    }
  }

  async loadModelFile(file) {
    this.status = "loading";
    this.message = "Reading model…";
    this.resultRev++;
    try {
      this.#ingestModel(await file.arrayBuffer());
    } catch (e) {
      this.status = "error";
      this.message = `Model load failed — ${e?.message ?? e}`;
      this.resultRev++;
    }
  }

  #ingestModel(buf) {
    const { header, f32Start } = readHeader(buf);
    const modelFloats = header.dim + header.dim + header.n_sv + header.n_sv * header.dim; // mean|scale|dual|sv
    this.#clf = parseClassifier(header, buf.slice(f32Start, f32Start + modelFloats * 4));
    this.#modelInfo = header;
    if (header.threshold != null) this.threshold = header.threshold;
    this.#score();
  }

  /** Score once both EMBEDDINGS and MODEL are present (guards a dim mismatch). */
  #score() {
    const e = this.#embHeader, m = this.#modelInfo;
    if (!this.#embs || !this.#clf) {
      this.status = "idle";
      this.message = !e ? "Load embeddings (.bin) to begin." : "Pick a model to score these embeddings.";
      this.resultRev++;
      return;
    }
    if (e.dim !== m.dim) {
      this.status = "error";
      this.message = `Dim mismatch: embeddings ${e.dim} vs model ${m.dim} — use matching embed model/patch size.`;
      this.resultRev++;
      return;
    }
    let prob = rbfProbability(this.#embs, this.#clf); // calibrated fault probabilities

    // ---- few-shot adaptation (optional) ------------------------------------------------------------
    // A transferred model ranks the target domain poorly (center→gily nose: PR 0.08). A handful of
    // target labels fixes most of that offline. Recalibration can't help (monotone ⇒ same ranking), so we
    // learn a prototype DIRECTION from the labelled patches and blend it into the ranking.
    this.fewShotInfo = null;
    if (this.fewShot > 0 && keypointLabels.hasLabels) {
      const { pos, neg } = keypointLabels.forNode(this.node);
      const posIdx = [], negIdx = [];
      for (let i = 0; i < this.#n; i++) {
        const k = `${e.video[i]}:${e.frame_idx[i]}:${e.inst[i]}`;
        if (pos.has(k)) posIdx.push(i);
        else if (neg.has(k)) negIdx.push(i);
      }
      const proto = prototypeDirection(this.#embs, posIdx, negIdx);
      if (proto) {
        prob = blendByRank(prob, prototypeScores(this.#embs, proto.w), this.fewShot);
        this.fewShotInfo = { nPos: proto.nPos, nNeg: proto.nNeg, usedGlobal: proto.usedGlobal };
      }
    }
    const fz = new Map();
    const iz = new Map();
    for (let i = 0; i < this.#n; i++) {
      const fkey = `${e.video[i]}:${e.frame_idx[i]}`;    // matches store.frames fkey (videoIdx:frameIdx)
      if (prob[i] > (fz.get(fkey) ?? -Infinity)) fz.set(fkey, prob[i]);
      iz.set(`${fkey}:${e.inst[i]}`, prob[i]);
    }
    this.#frameZ = fz;
    this.#instProb = iz;
    this.status = "done";
    const how = e.dataset === m.dataset ? "own model" : `model ← ${m.dataset} (transfer)`;
    // dim alone can't separate patch sizes (p48 and p64 are both 384-d), so check node_min explicitly.
    const pm = e.node_min != null && m.node_min != null && e.node_min !== m.node_min
      ? ` · ⚠ patch mismatch: embeddings p${e.node_min} vs model p${m.node_min}`
      : "";
    const fs = this.fewShotInfo
      ? ` · few-shot α=${this.fewShot.toFixed(2)} (${this.fewShotInfo.nPos} labelled ${this.node})`
      : "";
    this.message = `${e.dataset} · ${how}: ${this.#n} ${this.node} patches · ${fz.size} frames · ${this.flaggedFrameCount} flagged${fs}${pm}`;
    this.resultRev++;
  }

  // ---- LEGACY: self-contained welded bundle (model + embeddings in one file) ----
  async loadPrecomputed(file) {
    this.status = "loading";
    this.message = "Reading bundle…";
    this.resultRev++;
    try {
      const buf = await file.arrayBuffer();
      const { header, f32Start } = readHeader(buf);
      const { dim, n_sv: nSv, n } = header;
      const modelFloats = dim + dim + nSv + nSv * dim;
      this.#clf = parseClassifier(header, buf.slice(f32Start, f32Start + modelFloats * 4));
      const embFlat = new Float32Array(buf, f32Start + modelFloats * 4, n * dim);
      const embs = new Array(n);
      for (let i = 0; i < n; i++) embs[i] = embFlat.subarray(i * dim, i * dim + dim);
      this.#embs = embs;
      this.#embHeader = header;    // welded header carries the emb index (video/frame_idx/inst)
      this.#modelInfo = header;    // …and the model params
      this.#n = n;
      this.#score();
    } catch (e) {
      this.status = "error";
      this.message = `Load failed — ${e?.message ?? e}`;
      this.resultRev++;
    }
  }
}

export const noseEmbedding = new NoseEmbeddingStore();
