<script>
  // FEW-SHOT adaptation: nudge a transferred keypoint model toward THIS project using a handful of your
  // own labels. Its own tab because it is a distinct job from the two next to it — Compute makes
  // embeddings, Upload brings a model in, and this one CHANGES how a loaded model scores. It also has a
  // real prerequisite chain (a bundle, then labels), which reads badly buried at the bottom of another
  // panel where the controls appeared and vanished depending on what was loaded.
  import { keypointLabels } from "../keypointLabels.svelte.js";
  import { keypointModels } from "../keypointModels.svelte.js";
  import { proofreadWindow } from "../proofreadWindow.svelte.js";
  import { parseKeypointLabels } from "../manualCheck.js";
  import Explain from "./Explain.svelte";

  let labelInput;
  let labelMsg = $state("");

  const slots = $derived(keypointModels.slots.filter((s) => s.store.info?.hasEmb && s.store.info?.hasModel));
  const hasLabels = $derived(keypointLabels.hasLabels);

  async function onLabels(ev) {
    const f = ev.currentTarget.files?.[0];
    ev.currentTarget.value = "";
    if (!f) return;
    const r = parseKeypointLabels(await f.text());
    if (r.error) { labelMsg = r.error; return; }
    keypointLabels.ingest(r.rows, "review csv");
    labelMsg = `${r.rows.length} reviewed instances · nodes: ${r.nodes.join(", ") || "none faulty"}`;
    for (const sl of keypointModels.slots) sl.store.rescore(); // labels can adapt every keypoint
  }
  function setAlpha(slot, v) { slot.store.fewShot = v; slot.store.rescore(); }
  function clearLabels() {
    keypointLabels.clear();
    labelMsg = "";
    for (const sl of keypointModels.slots) sl.store.rescore();
  }
</script>

<div class="fs">
  <Explain>
    <p class="note">
      A model exported from another dataset already knows what a bad keypoint looks like in general; it
      does not know <i>this</i> rig. Few-shot blends a prototype built from your labelled patches into
      the transferred decision, so a handful of examples shifts it toward this project without retraining.
    </p>
    <p class="note">
      <b>Adapt</b> is the blend weight: 0 leaves the transferred model untouched, 1 leans entirely on your
      prototype. Scores update the moment you move it — no recompute, the embeddings are already here.
    </p>
    <p class="note">
      This does <b>not</b> retrain anything, and nothing in this app can: it averages the patches you
      marked faulty and nudges the ranking toward them. For a genuinely retrained model, export your
      labels with <b>⤓ Export (.csv)</b>, run the offline trainer (<code>dino_probe/export_nose.py</code>),
      and load the result under step&nbsp;1.
    </p>
  </Explain>

  <!-- 1 — the labels ------------------------------------------------------------------------- -->
  <section class="step">
    <header class="s-h"><span class="s-n">1</span> Your labels</header>
    <div class="row">
      <button class="load" onclick={() => labelInput.click()}
              title="Reviewed per-keypoint labels for THIS project (faulty_keypoints.csv). Adapts every loaded keypoint.">
        ⇪ Load keypoint labels (.csv)
      </button>
      <button class="load" onclick={() => proofreadWindow.showTab("frames")}
              title="Make your own labels here instead of importing them">◉ Proofread instead</button>
      <input bind:this={labelInput} type="file" accept=".csv" style="display:none" onchange={onLabels} />
    </div>
    {#if hasLabels}
      <p class="tally">
        <b>{keypointLabels.count}</b> reviewed · <b>{keypointLabels.badCount}</b> faulty
        {#if keypointLabels.nodes.length}· {keypointLabels.nodes.map((t) => `${t.node} ×${t.n}`).join(", ")}{/if}
        {#if keypointLabels.source}· <i>{keypointLabels.source}</i>{/if}
        <button class="link" onclick={clearLabels}>clear</button>
      </p>
    {:else}
      <p class="note dim">Nothing labelled yet — import a CSV or proofread a few frames.</p>
    {/if}
    {#if labelMsg}<p class="note">{labelMsg}</p>{/if}
  </section>

  <!-- 2 — the blend -------------------------------------------------------------------------- -->
  <section class="step">
    <header class="s-h"><span class="s-n">2</span> Adapt each keypoint</header>
    {#if !slots.length}
      <p class="note dim">
        No keypoint has both its embeddings and a model loaded yet — do that under <b>Upload</b> first.
      </p>
    {:else if !hasLabels}
      <p class="note dim">Load or make labels above, then the blend becomes available.</p>
    {:else}
      {#each slots as slot (slot.id)}
        {@const st = slot.store}
        {@const nl = keypointLabels.forNode(st.node)}
        <div class="kp">
          <div class="row">
            <span class="kp-n">{st.node}</span>
            <input type="range" min="0" max="1" step="0.05" value={st.fewShot}
                   oninput={(e) => setAlpha(slot, +e.currentTarget.value)} />
            <span class="val">{st.fewShot.toFixed(2)}</span>
          </div>
          <p class="note">
            {#if st.fewShot === 0}
              transferred model unchanged · <b>{nl.pos.size}</b> faulty / <b>{nl.neg.size}</b> clean
              labelled <i>{st.node}</i> available
            {:else if st.fewShotInfo}
              blending a prototype from <b>{st.fewShotInfo.nPos}</b> faulty{st.fewShotInfo.usedGlobal
                ? " vs the global mean" : ` / ${st.fewShotInfo.nNeg} clean`} <i>{st.node}</i> patches
            {:else}
              no labelled <i>{st.node}</i> patches matched these embeddings
            {/if}
          </p>
        </div>
      {/each}
    {/if}
  </section>
</div>

<style>
  .fs { display: flex; flex-direction: column; gap: 0.7rem; }
  .step { display: flex; flex-direction: column; gap: 0.35rem; }
  .s-h {
    display: flex; align-items: center; gap: 0.4rem;
    font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim);
  }
  .s-n {
    display: inline-grid; place-items: center;
    width: 1.05rem; height: 1.05rem; border-radius: 50%;
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    color: var(--accent); font-size: 0.6rem; font-weight: 700;
  }
  .row { display: flex; align-items: center; gap: 0.45rem; flex-wrap: wrap; }
  .load {
    background: transparent; border: 1px solid var(--border); border-radius: var(--r-xs);
    color: var(--muted); font-size: 0.68rem; padding: 0.25rem 0.55rem; cursor: pointer;
  }
  .load:hover { color: var(--accent); border-color: var(--accent); }
  .note { margin: 0; font-size: 0.66rem; color: var(--dim); line-height: 1.45; }
  .note b { color: var(--muted); font-weight: 600; }
  .note.dim { font-style: italic; }
  .tally { margin: 0; font-size: 0.68rem; color: var(--dim); }
  .tally b { color: var(--text); font-weight: 600; }
  .link { background: none; border: none; color: var(--accent); font-size: 0.64rem; cursor: pointer; padding: 0 0.2rem; }
  .link:hover { text-decoration: underline; }

  .kp {
    display: flex; flex-direction: column; gap: 0.2rem;
    padding: 0.4rem 0.5rem; border: 1px solid var(--border); border-radius: 6px;
  }
  .kp-n { flex: 0 0 5rem; font-size: 0.7rem; color: var(--text); }
  .kp input[type="range"] { flex: 1 1 auto; min-width: 6rem; }
  .val { flex: none; font-size: 0.68rem; color: var(--muted); font-variant-numeric: tabular-nums; }
</style>
