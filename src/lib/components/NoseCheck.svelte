<script>
  // The validated NOSE per-keypoint check. In-browser DINO is too slow, so this scores PRECOMPUTED nose
  // embeddings (dino_probe/export_nose.py --split) with the ported calibrated RBF-SVM. EMBEDDINGS and MODEL
  // load SEPARATELY: upload this project's embeddings, then pick which trained model scores them — its own
  // (default) or ANOTHER dataset's (transfer test). Once scored, "Nose (trained)" unlocks in the list above.
  import { onMount } from "svelte";
  import { noseEmbedding } from "../noseEmbeddingStore.svelte.js";

  const MODELS_BASE = `${import.meta.env.BASE_URL}nose_models/`;
  let embInput, modelInput;
  let models = $state([]);           // manifest of precomputed, fetchable models
  let selected = $state("");         // selected model filename ("" none, "__upload" = pick a file)

  onMount(async () => {
    try {
      const r = await fetch(`${MODELS_BASE}index.json`);
      if (r.ok) models = (await r.json()).models ?? [];
    } catch { /* no served models — the upload option still works */ }
  });

  async function onEmb(e) {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (!f) return;
    await noseEmbedding.loadEmbeddings(f);
    // Auto-pick the model that matches these embeddings (the "default associated with the embeddings").
    if (!selected && models.length) {
      const m = models.find((x) => x.dataset === noseEmbedding.embDataset) ?? null;
      if (m) selectModel(m.file);
    }
  }

  function selectModel(file) {
    selected = file;
    if (file && file !== "__upload") noseEmbedding.loadModelFromUrl(MODELS_BASE + file);
  }
  function onModelChange(e) {
    const v = e.currentTarget.value;
    if (v === "__upload") { selected = v; modelInput.click(); }
    else selectModel(v);
  }
  async function onModelFile(e) {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (f) await noseEmbedding.loadModelFile(f);
  }

  const info = $derived(noseEmbedding.info);
  function label(m) {
    const tag = m.dataset === noseEmbedding.embDataset ? "default" : "transfer";
    return `${m.dataset} · ROC ${m.cv_roc.toFixed(2)} (${tag})`;
  }
</script>

<div class="nose">
  <div class="hdr">
    <b>Nose (trained)</b>
    <span class="sub">
      {#if info?.hasEmb && info?.hasModel}
        {info.dataset}{info.transfer ? ` ← ${info.model_dataset}` : ""} · CV ROC {info.cv_roc.toFixed(2)}
      {:else if info?.hasEmb}
        embeddings loaded — pick a model
      {:else}
        no embeddings loaded
      {/if}
    </span>
  </div>
  <p class="hint">
    In-browser DINO is slow, so this scores a <b>precomputed nose bundle</b> (<code>export_nose.py --split</code>).
    Load this project's <b>embeddings</b>, then choose which trained <b>model</b> scores them — its own, or
    another dataset's to test <b>transfer</b>.
  </p>

  <div class="row">
    <span class="k">Embeddings</span>
    <button class="load" onclick={() => embInput.click()}>⇪ {info?.hasEmb ? info.dataset : "Load nose embeddings (.bin)"}</button>
    <input bind:this={embInput} type="file" accept=".bin" style="display:none" onchange={onEmb} />
  </div>

  <div class="row">
    <span class="k">Model</span>
    <select value={selected} onchange={onModelChange} disabled={!models.length && !info?.hasModel}>
      <option value="" disabled>{models.length ? "— choose model —" : "no served models"}</option>
      {#each models as m}
        <option value={m.file}>{label(m)}</option>
      {/each}
      <option value="__upload">Upload model (.bin)…</option>
    </select>
    <input bind:this={modelInput} type="file" accept=".bin" style="display:none" onchange={onModelFile} />
  </div>

  {#if info?.transfer}
    <p class="xfer">🔀 Transfer: scoring <b>{info.dataset}</b> with <b>{info.model_dataset}</b>'s model.</p>
  {/if}

  {#if noseEmbedding.status !== "idle"}
    <p class="status {noseEmbedding.status}">{noseEmbedding.message}</p>
  {/if}
  {#if noseEmbedding.hasResults}
    <label class="thr">
      Flag if prob ≥
      <input type="range" min="0" max="1" step="0.01" value={noseEmbedding.threshold}
             oninput={(e) => (noseEmbedding.threshold = +e.currentTarget.value)} />
      <span>{noseEmbedding.threshold.toFixed(2)}</span>
    </label>
    <p class="flagged">{noseEmbedding.flaggedFrameCount} frames flagged · {noseEmbedding.count} nose patches</p>
  {/if}
</div>

<style>
  .nose { border: 1px solid var(--border, #2a2f3a); border-radius: 6px; padding: 8px 10px; margin-top: 6px; }
  .hdr { display: flex; justify-content: space-between; align-items: baseline; }
  .sub { font-size: 11px; opacity: 0.7; }
  .hint { font-size: 11px; opacity: 0.75; margin: 4px 0; }
  .row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .row .k { font-size: 11px; opacity: 0.7; width: 68px; flex: none; }
  .load { flex: 1; padding: 6px; cursor: pointer; }
  .row select { flex: 1; padding: 5px; background: var(--bg, #14181d); color: inherit;
                 border: 1px solid var(--border, #2a2f3a); border-radius: 4px; }
  .xfer { font-size: 11px; margin: 6px 0 0; color: #5fd9f2; }
  .status { font-size: 11px; margin: 4px 0; }
  .status.error { color: #fb6e6e; }
  .status.done { color: #39d353; }
  .thr { display: flex; align-items: center; gap: 6px; font-size: 11px; margin-top: 6px; }
  .thr input { flex: 1; }
  .flagged { font-size: 11px; opacity: 0.8; margin: 4px 0 0; }
</style>
