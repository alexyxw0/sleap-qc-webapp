<script>
  // THE appearance computation. Everything about configuring, launching and watching an embedding run
  // lives here, in one floating window, instead of being spread down the Appearance tab in a 312 px rail.
  //
  // Three subtabs, because they are three different jobs: COMPUTE embeddings here, UPLOAD ones computed
  // elsewhere, or few-shot ADAPT a model you already loaded. Upload used to hide behind gran=node +
  // model=pretrained, which made it read as a third way to compute — it launches nothing, has no rate,
  // and arms a different check.
  //
  // Within Compute the layout is linear — pick what to embed, see what it will cost, launch, watch,
  // inspect — because that is the order you do it in. The result viewers (EmbeddingCheck /
  // NodeEmbeddingCheck / NoseCheck) render inside; they are pure viewers and own no run controls.
  import { store } from "../labelsStore.svelte.js";
  import { qc } from "../qcStore.svelte.js";
  import { appRun } from "../appearanceRun.svelte.js";
  import { classifierInfo } from "../qc/embedding/appearanceClf.js";
  import PopoutWindow from "./PopoutWindow.svelte";
  import WinTabs from "./WinTabs.svelte";
  import RunProgress from "./RunProgress.svelte";
  import Explain from "./Explain.svelte";
  import EmbeddingCheck from "./EmbeddingCheck.svelte";
  import NodeEmbeddingCheck from "./NodeEmbeddingCheck.svelte";
  import NoseCheck from "./NoseCheck.svelte";
  import FewShotPanel from "./FewShotPanel.svelte";
  import { keypointModels } from "../keypointModels.svelte.js";
  import { keypointLabels } from "../keypointLabels.svelte.js";
  import { appearanceCoverageNote } from "../qcStore.svelte.js";

  const clf = classifierInfo();
  const es = $derived(appRun.store); // null for the pretrained (upload-only) route
  const running = $derived(appRun.running);
  const busy = $derived(appRun.anyRunning); // the two stores share one worker
  const ready = $derived(qc.checkReady(appRun.checkKey));

  // Coverage: default is EVERY instance (sampleCap null) — the sampling gap is exactly how a real outlier
  // goes unscored. capVal remembers the last numeric cap across toggles of the "all" checkbox.
  let capVal = $state(2000);
  const capOn = $derived(es ? es.sampleCap != null && es.sampleCap > 0 : false);
  function setCapOn(on) { if (es) es.sampleCap = on ? capVal : null; }
  function setCapVal(v) { capVal = Math.max(100, Math.round(v) || 100); if (es) es.sampleCap = capVal; }
  function setRef(v) {
    if (es) es.referenceFraction = Math.min(1, Math.max(0.05, (+v || 20) / 100));
  }

  // What a launch will actually chew through, so "all" is an informed choice rather than a shrug.
  const workload = $derived.by(() => {
    if (!es) return null;
    const inst = es.instanceCount || 0;
    const n = capOn ? Math.min(inst || Infinity, capVal) : inst;
    if (!n || !Number.isFinite(n)) return null;
    if (appRun.gran !== "node") return { units: n, label: `${n.toLocaleString()} instance crops` };
    const nodes = store.skeleton?.nodeNames?.length ?? 0;
    // Without a node count the pass count is unknowable — say nothing rather than understate it.
    if (!nodes) return { units: null, label: `${n.toLocaleString()} instances` };
    // Multiply by the SELECTED count, or the estimate ignores the one control that changes it. Name both
    // numbers so a subset is never mistaken for the whole skeleton.
    const sel = Array.isArray(es.nodes) ? es.nodes.length : nodes;
    const of = sel === nodes ? `${nodes} keypoints` : `${sel} of ${nodes} keypoints`;
    return { units: n * sel, label: `${n.toLocaleString()} instances × ${of}` };
  });

  // ---- keypoint subset (per-keypoint only) --------------------------------------------------------
  // Per-keypoint is instances x nodes forward passes, so choosing 3 of 13 keypoints is the single
  // biggest cost lever in the app. null = all; [] is invalid and blocks the run rather than widening.
  const allNodes = $derived(store.skeleton?.nodeNames ?? []);
  const picked = $derived(appRun.gran === "node" && Array.isArray(es?.nodes) ? es.nodes : null);
  const nSel = $derived(picked ? picked.length : allNodes.length);
  const noneSelected = $derived(picked != null && picked.length === 0);
  function toggleNode(ni) {
    if (!es) return;
    const cur = Array.isArray(es.nodes) ? es.nodes : allNodes.map((_, k) => k);
    es.nodes = cur.includes(ni) ? cur.filter((k) => k !== ni) : [...cur, ni].sort((a, b) => a - b);
  }
  const covNote = $derived(appearanceCoverageNote(appRun.checkKey));

  const GRAN = [
    ["instance", "Whole instance", "One crop per animal — gross appearance problems"],
    ["node", "Per keypoint", "A patch per keypoint — names the keypoint responsible"],
  ];
  const TABS = $derived([
    { id: "compute", label: "Compute", hint: "Embed this file's crops with DINOv2 in the browser" },
    { id: "upload", label: "Upload", hint: "Load precomputed keypoint bundles (embeddings + trained model)",
      badge: keypointModels.active.length || null },
    { id: "fewshot", label: "Few-shot", hint: "Adapt a transferred model to this project with a handful of your own labels",
      badge: keypointLabels.count || null },
  ]);
</script>

{#if appRun.open}
  <PopoutWindow title="Appearance · DINOv2" width="820px" onclose={() => appRun.close()}>
    <div class="win">
      <WinTabs tabs={TABS} active={appRun.tab} disabled={busy} onpick={(t) => appRun.setTab(t)} />

      {#if appRun.tab === "upload"}
        <!-- Nothing to configure or launch: these bundles were made offline by export_nose.py. -->
        <section class="pane">
          <NoseCheck />
        </section>
      {:else if appRun.tab === "fewshot"}
        <section class="pane">
          <FewShotPanel />
        </section>
      {:else}
      <!-- 1 — WHAT TO EMBED ------------------------------------------------------------------ -->
      <section class="cfg">
        <div class="row">
          <span class="lbl">Granularity</span>
          <div class="seg">
            {#each GRAN as [k, label, hint] (k)}
              <button type="button" class:on={appRun.gran === k} disabled={busy}
                      onclick={() => appRun.setGran(k)} title={hint}>{label}</button>
            {/each}
          </div>
        </div>

        <div class="row">
          <span class="lbl">Scorer</span>
          <!-- One scorer per granularity, so this states what will happen rather than asking. Whole
               instance is the trained SVM (kNN was ~chance on a whole-animal crop); per keypoint is
               unsupervised kNN, where the patch is small enough for it to discriminate. -->
          <span class="fixed" title={appRun.gran === "instance"
              ? "Bundled RBF-SVM trained on proofread labels. Unsupervised kNN at this granularity scored ~chance, so it is not offered."
              : "Each patch vs the k nearest patches of the SAME keypoint (robust-z). No labels needed. For the supervised per-keypoint route, use the Upload tab."}>
            {appRun.scorer}{#if appRun.gran === "instance" && clf}<small> · cv roc {clf.cv_roc.toFixed(2)}</small>{/if}
          </span>
        </div>

        {#if es}
          <div class="row">
            <span class="lbl">Coverage</span>
            <label class="chk" title="Embed EVERY instance — no frame is skipped. Embeddings are cached, so this is a one-time cost per file.">
              <input type="checkbox" checked={!capOn} disabled={busy}
                     onchange={(e) => setCapOn(!e.currentTarget.checked)} />
              all{es.instanceCount ? ` (${es.instanceCount.toLocaleString()})` : ""}
            </label>
            {#if capOn}
              <label class="num" title="Evenly subsample this many instances instead of embedding all of them">
                cap
                <input type="number" min="100" max={es.instanceCount || 100000} step="100"
                       value={capVal} disabled={busy} oninput={(e) => setCapVal(+e.currentTarget.value)} />
              </label>
            {/if}
            <!-- Reference only exists for the kNN route. Whole-instance is trained-SVM only, so showing
                 this there is a control that changes nothing. -->
            {#if appRun.gran === "node"}
              <label class="num" title="Every patch is SCORED, but the 'normal' yardstick is an even, per-video subsample of this size — decorrelated so near-duplicate frames don't mask each other.">
                reference
                <input type="number" min="5" max="100" step="5" disabled={busy}
                       value={Math.round(es.referenceFraction * 100)} oninput={(e) => setRef(e.currentTarget.value)} />%
              </label>
            {/if}
          </div>
        {/if}

        {#if es && appRun.gran === "node" && allNodes.length}
          <div class="row kprow">
            <span class="lbl">Keypoints</span>
            <label class="chk" title="Embed a patch for every keypoint. Untick to choose a subset — this pass is instances × keypoints, so it is the biggest thing you control.">
              <input type="checkbox" checked={picked == null} disabled={busy}
                     onchange={(e) => (es.nodes = e.currentTarget.checked ? null : allNodes.map((_, k) => k))} />
              all ({allNodes.length})
            </label>
            {#if picked}
              <div class="chips">
                {#each allNodes as nm, ni (nm)}
                  <button type="button" class="kchip" class:on={picked.includes(ni)} disabled={busy}
                          onclick={() => toggleNode(ni)}
                          title={picked.includes(ni) ? `Embed ${nm}` : `${nm} will NOT be embedded — nothing will be known about it`}>{nm}</button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        <Explain>
          {#if appRun.gran === "instance"}
            <p class="note">One whole-instance crop per animal, embedded with DINOv2 ViT-S/14 (384-d) and scored by an RBF-SVM trained on proofread labels{#if clf} — <b>{clf.dataset}</b>, CV ROC {clf.cv_roc.toFixed(3)} / PR {clf.cv_pr.toFixed(3)}{/if}. Flags by SVM decision (0 = the boundary).</p>
            <p class="note">Catches occlusion and appearance errors geometry misses, but not <i>which</i> keypoint is wrong — that is the per-keypoint granularity.</p>
          {:else}
            <p class="note">A patch around each keypoint, embedded with DINOv2 ViT-S/14 and scored <b>unsupervised</b>: robust-z of the distance to the k nearest patches of that <i>same</i> keypoint. No labels needed, and a flag names the keypoint responsible.</p>
            <p class="note">One forward pass per keypoint per instance — many more crops than whole-instance, so expect minutes at full coverage. Cached after the first run. For the <i>supervised</i> per-keypoint route, use the <b>Upload</b> tab.</p>
          {/if}
        </Explain>
      </section>

      <!-- 2 — LAUNCH + WATCH ------------------------------------------------------------------ -->
      {#if es}
        <section class="launch">
          <div class="go">
            {#if running}
              <button class="big stop" onclick={() => appRun.abort()}>■ Stop</button>
            {:else}
              <button class="big" disabled={busy || !store.ready || noneSelected} onclick={() => appRun.run()}>
                {es.hasResults ? "Re-run" : "Run"} DINO
              </button>
            {/if}
            <div class="cost">
              {#if running}
                <RunProgress store={es} />
              {:else if busy}
                <span class="dim">The other granularity is running — they share one worker.</span>
              {:else if noneSelected}
                <span class="dim">Select at least one keypoint — an empty selection embeds nothing.</span>
              {:else if workload}
                <span class="dim">{workload.label}{workload.units ? ` · ${workload.units.toLocaleString()} forward passes` : ""}</span>
              {:else}
                <span class="dim">Load a file to see the workload.</span>
              {/if}
            </div>
          </div>

          {#if !running && es.status === "error"}
            <p class="err">{es.message}</p>
          {:else if !running && es.status === "aborted"}
            <p class="dim">{es.message} {es.hasResults ? "Partial results are shown below." : ""}</p>
          {:else if !running && !es.hasResults}
            <p class="dim">First run downloads the ~90 MB DINOv2 weights, then embeds. Results appear here.</p>
          {/if}

          <p class="armed" class:on={ready}>
            {ready ? "✓" : "○"} the <b>{appRun.checkKey === "dino" ? "Appearance · whole instance" : appRun.checkKey === "nodeDino" ? "Per-node · DINO" : "Keypoint (trained)"}</b> check
            {ready ? "is armed" : "unlocks once this has results"}{#if ready && covNote} · <b>{covNote}</b>{/if}{ready ? " — tick it in the Appearance tab" : ""}
          </p>
        </section>
      {/if}

      <!-- 3 — INSPECT -------------------------------------------------------------------------- -->
      <section class="results">
        {#if appRun.gran === "instance"}<EmbeddingCheck />{:else}<NodeEmbeddingCheck />{/if}
      </section>
      {/if}
    </div>
  </PopoutWindow>
{/if}

<style>
  .win { display: flex; flex-direction: column; gap: 0.75rem; }

  .cfg { display: flex; flex-direction: column; gap: 0.5rem; }
  .row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .lbl {
    flex: 0 0 5.2rem;
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--dim);
  }
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--r-xs); overflow: hidden; }
  .seg button {
    font-size: 0.68rem;
    color: var(--muted);
    background: transparent;
    border: none;
    border-right: 1px solid var(--border);
    padding: 0.25rem 0.6rem;
    cursor: pointer;
  }
  .seg button:last-child { border-right: none; }
  .seg button.on { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
  .seg button:disabled { cursor: default; opacity: 0.5; }
  .fixed {
    font-size: 0.66rem;
    color: var(--muted);
    padding: 0.2rem 0.5rem;
    border-radius: var(--r-xs);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .fixed small { color: var(--dim); font-size: 0.55rem; }
  .chk, .num {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.66rem;
    color: var(--muted);
  }
  .num input {
    width: 4.4rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    color: var(--text);
    font-size: 0.66rem;
    padding: 0.15rem 0.3rem;
  }
  .note { margin: 0; font-size: 0.62rem; color: var(--dim); line-height: 1.4; }
  .kprow { align-items: flex-start; }
  .chips { display: flex; flex-wrap: wrap; gap: 0.22rem; flex: 1 1 14rem; }
  /* Off is the LOUD state here: an un-embedded keypoint is one nothing will be known about, which is
     easier to miss than an extra one selected. */
  .kchip {
    font-size: 0.62rem; padding: 0.1rem 0.4rem; cursor: pointer;
    border: 1px dashed var(--border); border-radius: var(--r-xs);
    background: transparent; color: var(--dim); text-decoration: line-through;
  }
  .kchip.on {
    border-style: solid; text-decoration: none;
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
    background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent);
  }
  .kchip:disabled { opacity: 0.5; cursor: default; }
  .note b { color: var(--muted); font-weight: 600; }

  .launch {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    padding: 0.65rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.02);
  }
  .go { display: flex; align-items: center; gap: 0.75rem; }
  .big {
    flex: none;
    min-width: 8.5rem;
    padding: 0.5rem 0.9rem;
    font-size: 0.76rem;
    font-weight: 600;
    color: #08131c;
    background: var(--accent);
    border: none;
    border-radius: 7px;
    cursor: pointer;
  }
  .big:hover { filter: brightness(1.08); }
  .big:disabled { opacity: 0.45; cursor: default; filter: none; }
  .big.stop { background: #fca5a5; }
  .cost { flex: 1 1 auto; min-width: 0; }
  .dim { font-size: 0.62rem; color: var(--dim); }
  .err { margin: 0; font-size: 0.66rem; color: #fca5a5; }
  .armed { margin: 0; font-size: 0.6rem; color: var(--dim); }
  .armed.on { color: #6ee7a8; }
  .armed b { color: var(--muted); font-weight: 600; }

  .results { border-top: 1px solid var(--border); padding-top: 0.7rem; }
  .pane { display: flex; flex-direction: column; gap: 0.5rem; }
</style>
