<script>
  // The validated PER-KEYPOINT trained check. In-browser DINO is too slow, so this scores PRECOMPUTED
  // keypoint embeddings (dino_probe/export_nose.py --split) with the ported calibrated RBF-SVM.
  // EMBEDDINGS and MODEL load SEPARATELY: upload this project's embeddings, then pick which trained model
  // scores them — its own (default) or ANOTHER dataset's (transfer test). Once scored, "Keypoint (trained)"
  // unlocks in the list above.
  //
  // MULTIPLE keypoints at once: one SLOT per keypoint, each an independent (embeddings + model) pair.
  // The target keypoint comes from each BUNDLE, never from this component. The registry aggregates the
  // slots (max calibrated probability) and names the winning keypoint, which is what makes running
  // several worthwhile — the flag says WHICH keypoint is wrong.
  import { onMount } from "svelte";
  import { keypointModels } from "../keypointModels.svelte.js";
  import { keypointLabels } from "../keypointLabels.svelte.js";
  import { remember } from "../bundlePrefs.js";
  import { proofread } from "../proofreadSession.svelte.js";
  import { appRun } from "../appearanceRun.svelte.js";
  import { keymapLegend } from "../qc/proofreadKeymap.js";
  import { keybinds } from "../keybinds.svelte.js";
  import Explain from "./Explain.svelte";

  const MODELS_BASE = `${import.meta.env.BASE_URL}nose_models/`;
  // One SLOT per keypoint. Each holds its own embeddings + model; the registry aggregates them
  // (max calibrated probability) and names the winning keypoint for attribution.
  let embInput, modelInput, target = null;   // `target` = the slot a file dialog is acting on
  let models = $state([]);           // manifest of precomputed, fetchable models
  let selected = $state({});         // slot id -> chosen model filename

  onMount(async () => {
    try {
      const r = await fetch(`${MODELS_BASE}index.json`);
      if (r.ok) models = (await r.json()).models ?? [];
    } catch { /* no served models — the upload option still works */ }
  });

  async function onEmb(e) {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    const slot = target;
    if (!f || !slot) return;
    await slot.store.loadEmbeddings(f);
    if (slot.store.status !== "error") remember("nose-emb", { source: "upload", name: f.name });
    // Auto-pick the model matching these embeddings (the "default associated with the embeddings").
    if (!selected[slot.id] && models.length) {
      const m = models.find((x) => x.dataset === slot.store.embDataset) ?? null;
      if (m) selectModel(slot, m.file);
    }
  }

  async function selectModel(slot, file) {
    selected = { ...selected, [slot.id]: file };
    if (file && file !== "__upload") {
      await slot.store.loadModelFromUrl(MODELS_BASE + file);
      if (slot.store.status !== "error") remember("nose-model", { source: "served", ref: file, name: file });
    }
  }
  function onModelChange(slot, e) {
    const v = e.currentTarget.value;
    if (v === "__upload") { selected = { ...selected, [slot.id]: v }; target = slot; modelInput.click(); }
    else selectModel(slot, v);
  }
  async function onModelFile(e) {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    const slot = target;
    if (f && slot) {
      await slot.store.loadModelFile(f);
      if (slot.store.status !== "error") remember("nose-model", { source: "upload", name: f.name });
    }
  }

  // --- few-shot: target-domain labels adapt a TRANSFERRED model. Source-agnostic (keypointLabels), so
  //     the Phase-2 in-app "click a keypoint to mark it" path will feed the exact same store.
  function addKeypoint() { target = keypointModels.addSlot(); }

  // --- guided labelling: the loop lives in proofreadSession so the KEYBOARD and these buttons drive
  //     the same cursor. A pass is meant to run hands-on-home-row; the buttons are the discoverable
  //     equivalent, never a second source of truth.
  const queue = $derived(keypointLabels.proofreading ? proofread.queue : []);
  const cand = $derived(keypointLabels.proofreading ? proofread.current : null);
  const doneCount = $derived(keypointLabels.proofreading ? proofread.reviewedCount : 0);
  const legend = $derived(keymapLegend(keybinds.allEntries)); // live bindings, not the shipped ones

  // --- proofreading: make your OWN ground truth in-app, then adapt/retrain on it ---------------------

  function label(m) {
    return `${m.dataset} · p${m.node_min} · ROC ${m.cv_roc.toFixed(2)}`;
  }
  const nodes = $derived(keypointModels.nodes);
</script>

<div class="det">
  <div class="head">
    <span class="ttl">Keypoint (trained){#if nodes.length}<span class="node"> · {nodes.join(", ")}</span>{/if}</span>
    <span class="meta">{keypointModels.active.length}/{keypointModels.slots.length} loaded</span>
  </div>
  <Explain label="Bundle format & transfer">
    <p class="note">
      Scores <b>precomputed keypoint bundles</b> (<code>export_nose.py --split</code>) with calibrated
      RBF-SVMs. Add a slot per keypoint — each needs its own <b>embeddings</b> + <b>model</b>. A frame's
      score is the highest probability across keypoints, and the flag names the keypoint responsible.
    </p>
    <p class="note">
      Embeddings are computed offline because in-browser DINO is far too slow at this volume; a model
      exported from one dataset can score another (transfer), and few-shot blends your own labels in.
    </p>
  </Explain>

  {#each keypointModels.slots as slot (slot.id)}
    {@const st = slot.store}
    {@const info = st.info}
    <div class="slot">
      <div class="head">
        <span class="sname">{info?.hasEmb ? st.node : "new keypoint"}</span>
        <span class="meta">
          {#if info?.hasEmb && info?.hasModel}
            {info.dataset}{info.transfer ? ` ← ${info.model_dataset}` : ""} · ROC {info.cv_roc.toFixed(2)}
          {:else if info?.hasEmb}pick a model{:else}no embeddings{/if}
        </span>
        {#if keypointModels.slots.length > 1 || info?.hasEmb}
          <button type="button" class="rm" title="Remove this keypoint"
            onclick={() => keypointModels.removeSlot(slot.id)}>✕</button>
        {/if}
      </div>

      <div class="row">
        <span class="k">Embeddings</span>
        <button class="load" onclick={() => { target = slot; embInput.click(); }}>
          ⇪ {info?.hasEmb ? info.dataset : "Load embeddings (.bin)"}</button>
      </div>
      <div class="row">
        <span class="k">Model</span>
        <select value={selected[slot.id] ?? ""} onchange={(e) => onModelChange(slot, e)}
                disabled={!models.length && !info?.hasModel}>
          <option value="" disabled>{models.length ? "— choose model —" : "no served models"}</option>
          {#each models as m}<option value={m.file}>{label(m)}</option>{/each}
          <option value="__upload">Upload model (.bin)…</option>
        </select>
      </div>

      {#if info?.transfer}
        <p class="xfer">🔀 Transfer: scoring <b>{info.dataset}</b> with <b>{info.model_dataset}</b>'s model.</p>
      {/if}
      {#if st.status !== "idle"}<p class="status {st.status}">{st.message}</p>{/if}

    </div>
  {/each}

  <input bind:this={embInput} type="file" accept=".bin" style="display:none" onchange={onEmb} />
  <input bind:this={modelInput} type="file" accept=".bin" style="display:none" onchange={onModelFile} />
  <button type="button" class="add" onclick={addKeypoint}>＋ Add keypoint</button>

  <div class="fs">
    <div class="row">
      <span class="k">Few-shot</span>
      <button class="load" onclick={() => appRun.showTab("fewshot")}
        title="Adapting a transferred model with your own labels is step 2 of this route">→ step 2 · Adapt</button>
    </div>

    <div class="row">
      <span class="k">Proofread</span>
      <button class="load" class:on={keypointLabels.proofreading}
        onclick={() => (keypointLabels.proofreading = !keypointLabels.proofreading)}
        title="Click keypoints in the viewer to mark them faulty. Builds your own ground truth for few-shot adaptation or offline retraining.">
        {keypointLabels.proofreading ? "◉ Proofreading" : "○ Enter proofreading"} <kbd>r</kbd>
      </button>
    </div>
    {#if keypointLabels.proofreading}
      <p class="note">
        Fully keyboard-driven — <kbd>f</kbd>/<kbd>j</kbd> judge, <kbd>1</kbd>–<kbd>9</kbd> pick a keypoint,
        <kbd>?</kbd> for all keys. Clicking a keypoint also toggles it; dragging is suppressed so labelling
        can't nudge coordinates. Models re-score after every label.
      </p>
    {/if}
    {#if keypointLabels.proofreading && keypointModels.hasResults}
      <div class="guide">
        <div class="row">
          <span class="k">Top <kbd>[</kbd><kbd>]</kbd></span>
          <select value={keypointLabels.budget}
                  onchange={(e) => { keypointLabels.budget = +e.currentTarget.value; keypointLabels.cursor = 0; }}>
            {#each [10, 20, 40, 100] as n}<option value={n}>{n}</option>{/each}
          </select>
          <span class="val">{doneCount}/{queue.length}</span>
          <button class="load" onclick={() => (keypointLabels.helpOpen = !keypointLabels.helpOpen)} title="Keyboard help (?)">?</button>
        </div>

        {#if cand}
          <p class="note">
            <b>#{proofread.cursor + 1}</b> · frame {cand.frameIdx} · inst {cand.inst} ·
            <i>{cand.node}</i> · p={cand.prob.toFixed(3)}
            {#if cand.labelled}· <span class="seen">judged</span>{/if}
          </p>
          <div class="row keys">
            <button class="load" onclick={() => proofread.dispatch({ id: "prev" })}>‹ <kbd>p</kbd></button>
            <button class="load bad" onclick={() => proofread.dispatch({ id: "faulty" })}>✗ Faulty <kbd>f</kbd></button>
            <button class="load good" onclick={() => proofread.dispatch({ id: "clean" })}>✓ Clean <kbd>j</kbd></button>
            <button class="load" onclick={() => proofread.dispatch({ id: "next" })}><kbd>n</kbd> ›</button>
          </div>
          <p class="note">
            Hands on the home row: <kbd>f</kbd>/<kbd>j</kbd> judge and auto-advance to the next unjudged,
            <kbd>1</kbd>–<kbd>9</kbd> toggle a specific keypoint, <kbd>u</kbd> undo, <kbd>?</kbd> help.
            Judging re-scores the models, so what's left re-ranks.
          </p>
        {:else}
          <p class="note">No candidates — load a model, or every candidate in this budget is judged.</p>
        {/if}

        {#if keypointLabels.helpOpen}
          <div class="help">
            {#each legend as g (g.group)}
              <p class="hgroup">{g.group}</p>
              {#each g.rows as r (r.label)}
                <div class="hrow">
                  <span class="hkeys">{#each r.keys as k}<kbd>{k}</kbd>{/each}</span>
                  <span class="hlabel">{r.label}</span>
                </div>
              {/each}
            {/each}
          </div>
        {/if}
      </div>
    {/if}
    {#if keypointLabels.hasLabels}
      {@const tally = keypointLabels.nodes}
      <p class="note">
        <b>{keypointLabels.count}</b> reviewed instances · <b>{keypointLabels.badCount}</b> faulty keypoints
        {#if tally.length}· {tally.map((t) => `${t.node} ×${t.n}`).join(", ")}{/if}
        {#if keypointLabels.source}· <i>{keypointLabels.source}</i>{/if}
      </p>
      <div class="row">
        <button class="load" onclick={() => proofread.exportCsv()}
          title="Download as faulty_keypoints.csv — the schema the Python trainer reads, so you can retrain offline">⤓ Export (.csv) <kbd>e</kbd></button>
        <button class="load" onclick={() => { keypointLabels.clear(); for (const sl of keypointModels.slots) sl.store.rescore(); }}
          title="Discard all labels made here">✕ Clear</button>
      </div>
    {/if}
  </div>

  {#if keypointModels.hasResults}
    <label class="thr">
      <span class="k">Flag if prob ≥</span>
      <input type="range" min="0" max="1" step="0.01" value={keypointModels.threshold}
             oninput={(e) => (keypointModels.threshold = +e.currentTarget.value)} />
      <span class="val">{keypointModels.threshold.toFixed(2)}</span>
    </label>
    <p class="note">
      Shared cutoff — the models emit calibrated probabilities, so one threshold is comparable across
      keypoints. {keypointModels.flaggedFrameCount} frames flagged · {keypointModels.count} patches.
    </p>
  {/if}
</div>

<style>
  /* Matches EmbeddingCheck / NodeEmbeddingCheck: rem type scale + design tokens, no hardcoded hex. */
  .det { display: flex; flex-direction: column; gap: 0.4rem; }
  .slot { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.4rem 0.45rem;
          border: 1px solid var(--border); border-radius: var(--r-xs); }
  .sname { font-size: 0.66rem; color: var(--accent); flex: 1 1 auto; }
  .rm { background: none; border: none; color: var(--dim); cursor: pointer; font-size: 0.7rem; padding: 0 0.2rem; }
  .rm:hover { color: #fca5a5; }
  .add { align-self: flex-start; background: none; border: 1px dashed var(--border); border-radius: var(--r-xs);
         color: var(--muted); font-size: 0.62rem; padding: 0.2rem 0.5rem; cursor: pointer; }
  .add:hover { border-color: var(--accent); color: var(--accent); }
  .load.on { border-color: #f472b6; color: #f472b6; }
  .guide { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.4rem 0.45rem; margin-top: 0.35rem;
           border: 1px solid #f472b6; border-radius: var(--r-xs); background: rgba(244,114,182,0.05); }
  .load.bad:hover { border-color: #fca5a5; color: #fca5a5; }
  .load.good:hover { border-color: #6ee7a8; color: #6ee7a8; }
  .seen { color: var(--dim); font-style: italic; }
  kbd { font-family: ui-monospace, Menlo, monospace; font-size: 0.54rem; padding: 0 0.22rem; margin-left: 0.15rem;
        border: 1px solid var(--border); border-radius: 2px; color: var(--muted); background: rgba(0,0,0,0.25); }
  .keys .load { flex: 1 1 auto; }
  .help { margin-top: 0.3rem; padding-top: 0.3rem; border-top: 1px solid var(--border); }
  .hgroup { margin: 0.3rem 0 0.15rem; font-size: 0.52rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); }
  .hrow { display: flex; gap: 0.4rem; align-items: baseline; font-size: 0.58rem; color: var(--dim); }
  .hkeys { flex: none; min-width: 4.2rem; }
  .hlabel { flex: 1 1 auto; }
  .head { display: flex; align-items: baseline; gap: 0.4rem; }
  .ttl { font-size: 0.74rem; color: var(--text); flex: 1 1 auto; min-width: 0; }
  .node { color: var(--accent); }
  .meta { font-size: 0.58rem; color: var(--dim); text-align: right; flex: none; }
  .note { margin: 0; font-size: 0.62rem; color: var(--dim); line-height: 1.35; }
  .note b { color: var(--muted); font-weight: 600; }
  .row { display: flex; align-items: center; gap: 0.4rem; }
  .k { font-size: 0.64rem; color: var(--muted); flex: none; }
  .row .k { width: 4.6rem; }
  .load, .row select {
    flex: 1 1 auto; min-width: 0; font-size: 0.64rem; color: var(--text);
    background: transparent; border: 1px solid var(--border); border-radius: var(--r-xs);
    padding: 0.24rem 0.4rem; cursor: pointer;
  }
  .load:hover, .row select:hover { border-color: var(--accent); }
  .row select:disabled { cursor: default; opacity: 0.55; }
  .xfer { margin: 0; font-size: 0.62rem; color: var(--accent); }
  .status { margin: 0; font-size: 0.62rem; color: var(--dim); }
  .status.error { color: #fca5a5; }
  .status.done { color: #6ee7a8; }
  .fs { margin-top: 0.2rem; padding-top: 0.4rem; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 0.4rem; }
  .thr { display: flex; align-items: center; gap: 0.4rem; }
  .thr input { flex: 1 1 auto; min-width: 0; }
  .val { font-size: 0.64rem; color: var(--accent); font-variant-numeric: tabular-nums; }
</style>
