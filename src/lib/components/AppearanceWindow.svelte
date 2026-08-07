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
  import { loadAll } from "../qc/embedding/embcache.js";

  const clf = classifierInfo();
  const es = $derived(appRun.store); // null for the pretrained (upload-only) route
  const running = $derived(appRun.running);
  const busy = $derived(appRun.anyRunning); // the two stores share one worker
  const ready = $derived(qc.checkReady(appRun.checkKey));

  // Every instance, always. Subsampling left frames unexamined, which is the same "not looked at vs
  // clean" ambiguity the keypoint coverage work exists to kill — and embeddings are cached, so the full
  // pass is a one-time cost. The keypoint selector is the cost lever that survives.

  // What a launch will actually chew through, so "all" is an informed choice rather than a shrug.
  const workload = $derived.by(() => {
    if (!es) return null;
    const n = es.instanceCount || 0;
    if (!n) return null;
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
    // null means "all" in the store; materialise it on the first deselect, and collapse back to null
    // when everything is on again so the config signature keeps one representation of the same pass.
    const cur = Array.isArray(es.nodes) ? es.nodes : allNodes.map((_, k) => k);
    const next = cur.includes(ni) ? cur.filter((k) => k !== ni) : [...cur, ni].sort((a, b) => a - b);
    es.nodes = next.length === allNodes.length ? null : next;
  }
  const covNote = $derived(appearanceCoverageNote(appRun.checkKey));

  // A warm IndexedDB cache is only discovered inside run(), after the model load — so the cost line
  // quoted a full pass and a 90 MB download to someone whose re-run would take seconds. Probe it here,
  // using the store's OWN key so the probe cannot miss by a format detail.
  let cached = $state(null); // entries already stored for this file, or null while unknown
  $effect(() => {
    const id = es?.cacheId;
    if (!id) { cached = null; return; }
    let stale = false;
    loadAll(id).then((m) => { if (!stale) cached = m?.size ?? 0; }).catch(() => { if (!stale) cached = null; });
    return () => { stale = true; };
  });
  // The weights download once; after that modelInfo is set and they are in memory for the session.
  const modelReady = $derived(!!es?.modelInfo);

  // THE ORDERED STEPS. A step is locked only when its prerequisite is genuinely unmet — a gate over an
  // action the app could already perform is a bug wearing a guide rail's clothing. `done` is always a
  // STORE fact, never "the user visited this", so a ✓ can never tick itself.
  const steps = $derived.by(() => {
    if (appRun.route === "bundle") {
      const pair = appRun.pairLoaded;
      return [
        { id: "upload", label: "Load bundles", done: appRun.bundleDone, locked: false,
          hint: "Upload each keypoint's embeddings + model. Either order.",
          note: appRun.bundleDone ? `${keypointModels.active.length} loaded`
            : keypointModels.slots.some((x) => x.store.info?.hasEmb && !x.store.info?.hasModel) ? "pick a model"
              : keypointModels.slots.some((x) => x.store.info?.hasModel && !x.store.info?.hasEmb) ? "add embeddings" : null },
        { id: "fewshot", label: "Adapt (few-shot)", done: appRun.adaptLive,
          locked: !appRun.canAdapt,
          why: !pair ? "Load a keypoint's embeddings AND its model first — there is nothing to adapt yet."
            : "No labels yet. Import a faulty_keypoints.csv, or proofread a few frames.",
          hint: "Optional. Nudges a transferred model toward this project using your labels.",
          note: appRun.canAdapt && !appRun.adaptLive ? "optional" : null },
      ];
    }
    return [
      { id: "compute", label: "Embed & score", done: appRun.computeDone, locked: false,
        hint: "Pick granularity and coverage, then run the DINOv2 pass over this file.",
        // A bare ✓ after the settings moved describes a run that no longer matches the controls above it.
        note: !appRun.computeDone ? null
          : es?.configDirty ? "settings changed — re-run"
            : noneSelected ? "selection empty"
              : (covNote ?? "ready") },
    ];
  });
  // The reason the CURRENT selection is unavailable, if it is — shown once, near the strip.
  const lockedNow = $derived(steps.find((x) => x.id === appRun.tab && x.locked)?.why ?? null);

  // Never strand the user on a locked pane: if the answer to an earlier step is undone, fall back to the
  // last step that is actually reachable. Suppressed while a bundle half is still loading, so an
  // in-flight fetch cannot bounce a deep link somewhere unexplained.
  $effect(() => {
    const loading = keypointModels.slots.some((x) => x.store.status === "loading");
    if (loading) return;
    const cur = steps.find((x) => x.id === appRun.tab);
    if (cur && cur.locked) {
      const open = [...steps].reverse().find((x) => !x.locked);
      if (open) appRun.setTab(open.id);
    }
  });

  const GRAN = [
    ["instance", "Whole instance", "One crop per animal — gross appearance problems"],
    ["node", "Per keypoint", "A patch per keypoint — names the keypoint responsible"],
  ];
  const _TABS_UNUSED = $derived([
    { id: "compute", label: "Compute", hint: "Embed this file's crops with DINOv2 in the browser" },
    { id: "upload", label: "Upload", hint: "Load precomputed keypoint bundles (embeddings + trained model)",
      badge: keypointModels.active.length || null },
    { id: "fewshot", label: "Few-shot", hint: "Adapt a transferred model to this project with a handful of your own labels",
      badge: keypointLabels.count || null },
  ]);
  void _TABS_UNUSED; // the peer-tab strip is replaced by the ordered flow below
</script>

{#if appRun.open}
  <PopoutWindow title="Appearance · DINOv2" width="820px" onclose={() => appRun.close()}>
    <div class="win">
      <!-- THE FORK. Asked first and answered by clicking, because the two routes are independent: a user
           with bundles must never be walked through a compute step, and vice versa. -->
      {#if appRun.route == null}
        <section class="fork">
          <p class="f-q">What are you starting from?</p>
          <div class="f-cards">
            <button class="fcard" onclick={() => appRun.setRoute("bundle")}>
              <span class="f-t">I have precomputed bundles</span>
              <span class="f-d">Embeddings + a trained model, exported offline by <code>export_nose.py</code>. Nothing is computed here.</span>
              <span class="f-s" class:on={appRun.bundleDone}>{appRun.bundleDone ? `✓ ${keypointModels.active.length} keypoint${keypointModels.active.length === 1 ? "" : "s"} loaded` : "○ nothing loaded yet"}</span>
            </button>
            <button class="fcard" disabled={!store.ready} onclick={() => appRun.setRoute("compute")}
                    title={store.ready ? "" : "Open a .pkg.slp first — this route embeds THIS file's crops"}>
              <span class="f-t">Compute embeddings from this file</span>
              <span class="f-d">A forward pass of a frozen DINOv2 over this file's crops. No training happens in the browser.</span>
              <span class="f-s" class:on={appRun.instanceDone || appRun.nodeDone}>
                {appRun.instanceDone ? "✓" : "○"} whole instance · {appRun.nodeDone ? "✓" : "○"} per keypoint
              </span>
            </button>
          </div>
        </section>
      {:else}
      <nav class="flow">
        <button class="f-back" onclick={() => appRun.clearRoute()} disabled={busy}
                title={busy ? "Not while a run is in flight" : "Back to the first question"}>‹ start</button>
        {#each steps as st, k (st.id)}
          <button class="node" class:on={appRun.tab === st.id} class:done={st.done} class:locked={st.locked}
                  disabled={st.locked || busy} onclick={() => appRun.setTab(st.id)}
                  title={st.locked ? st.why : st.hint}>
            <span class="n-i">{st.done ? "✓" : k + 1}</span>
            <span class="n-l">{st.label}</span>
            {#if st.note}<span class="n-n">{st.note}</span>{/if}
          </button>
          {#if k < steps.length - 1}<span class="n-arrow" aria-hidden="true">→</span>{/if}
        {/each}
      </nav>
      {#if lockedNow}<p class="lockmsg">🔒 {lockedNow}</p>{/if}

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
              : "Each patch vs the k nearest patches of the SAME keypoint (robust-z). No labels needed."}>
            {appRun.scorer}{#if appRun.gran === "instance" && clf}<small> · cv roc {clf.cv_roc.toFixed(2)}</small>{/if}
          </span>
          {#if appRun.gran === "node"}
            <!-- Per-keypoint SVMs exist and ship (nose, CV ROC 0.92-0.95) — they are just not usable on
                 patches cropped HERE, so the route rather than the scorer is what changes. Saying so
                 beats a Scorer row that looks like a dead end. -->
            <button class="xroute" onclick={() => appRun.setRoute("bundle")}
                    title="A trained per-keypoint SVM needs patches cropped the way its trainer cropped them — a fixed pixel size. This pass crops a fraction of each instance's bbox, so the two are not interchangeable. Bring precomputed bundles instead.">
              want a trained SVM? →
            </button>
          {/if}
        </div>

        {#if es}
        {/if}

        {#if es && appRun.gran === "node" && allNodes.length}
          <div class="row kprow">
            <span class="lbl">Keypoints</span>
            <div class="chips">
              {#each allNodes as nm, ni (nm)}
                {@const on = picked == null || picked.includes(ni)}
                <button type="button" class="kchip" class:on disabled={busy}
                        onclick={() => toggleNode(ni)}
                        title={on ? `${nm} will be embedded — click to skip it` : `${nm} will NOT be embedded, so nothing will be known about it`}>{nm}</button>
              {/each}
            </div>
            <span class="ksum">{nSel} of {allNodes.length}</span>
          </div>
        {/if}

        <Explain>
          {#if appRun.gran === "instance"}
            <p class="note">One whole-instance crop per animal, embedded with DINOv2 ViT-S/14 (384-d) and scored by an RBF-SVM trained on proofread labels{#if clf} — <b>{clf.dataset}</b>, CV ROC {clf.cv_roc.toFixed(3)} / PR {clf.cv_pr.toFixed(3)}{/if}. Flags by SVM decision (0 = the boundary).</p>
            <p class="note">Catches occlusion and appearance errors geometry misses, but not <i>which</i> keypoint is wrong — that is the per-keypoint granularity.</p>
          {:else}
            <p class="note">A patch around each keypoint, embedded with DINOv2 ViT-S/14 and scored <b>unsupervised</b>: robust-z of the distance to the k nearest patches of that <i>same</i> keypoint. No labels needed, and a flag names the keypoint responsible.</p>
            <p class="note">One forward pass per keypoint per instance — many more crops than whole-instance, so expect minutes at full coverage. Cached after the first run. For the <i>supervised</i> per-keypoint route, go back to <b>‹ start</b> and bring precomputed bundles.</p>
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
            <p class="dim">
              {#if !modelReady}The DINOv2 weights (~90 MB) download once, then embed.{:else}Weights already loaded.{/if}
              {#if cached}<b>{cached.toLocaleString()} patches already cached</b> — reused, not re-embedded.{/if}
              Results appear here.
            </p>
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
      {/if}
    </div>
  </PopoutWindow>
{/if}

<style>
  .win { display: flex; flex-direction: column; gap: 0.75rem; }

  /* ---- the fork ---- */
  .fork { display: flex; flex-direction: column; gap: 0.6rem; }
  .f-q { margin: 0; font-size: 0.86rem; font-weight: 600; color: var(--text); }
  .f-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
  .fcard {
    display: flex; flex-direction: column; gap: 0.3rem; text-align: left;
    padding: 0.75rem 0.8rem; cursor: pointer;
    border: 1px solid var(--border); border-radius: 9px;
    background: rgba(255, 255, 255, 0.02);
  }
  .fcard:hover:not(:disabled) { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .fcard:disabled { opacity: 0.45; cursor: default; }
  .f-t { font-size: 0.78rem; font-weight: 600; color: var(--text); }
  .f-d { font-size: 0.64rem; color: var(--dim); line-height: 1.45; }
  .f-d code { font-size: 0.6rem; }
  .f-s { font-size: 0.62rem; color: var(--dim); margin-top: 0.15rem; }
  .f-s.on { color: #6ee7a8; }

  /* ---- the ordered strip: numbers, arrows, and a lock you can read the reason for ---- */
  .flow { display: flex; align-items: center; gap: 0.3rem; flex-wrap: wrap; padding-bottom: 0.15rem; border-bottom: 1px solid var(--border); }
  .f-back { background: none; border: none; color: var(--dim); font-size: 0.62rem; cursor: pointer; padding: 0.2rem 0.3rem; }
  .f-back:hover:not(:disabled) { color: var(--accent); }
  .f-back:disabled { opacity: 0.4; cursor: default; }
  .node {
    display: inline-flex; align-items: center; gap: 0.35rem;
    padding: 0.3rem 0.6rem; cursor: pointer;
    background: none; border: 1px solid transparent; border-radius: 7px;
    color: var(--dim); font-size: 0.7rem;
  }
  .node:hover:not(:disabled) { color: var(--muted); }
  .node.on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .node.locked { opacity: 0.45; cursor: default; }
  .node:disabled { cursor: default; }
  .n-i {
    display: inline-grid; place-items: center; width: 1.05rem; height: 1.05rem; border-radius: 50%;
    font-size: 0.58rem; font-weight: 700;
    background: rgba(255, 255, 255, 0.08); color: var(--dim);
  }
  .node.on .n-i { background: var(--accent); color: #08131c; }
  .node.done .n-i { background: #6ee7a8; color: #08131c; }
  .n-n { font-size: 0.56rem; color: var(--dim); padding: 0.02rem 0.3rem; border-radius: 999px; background: rgba(255, 255, 255, 0.06); }
  .n-arrow { color: var(--border); font-size: 0.7rem; }
  .lockmsg { margin: 0; font-size: 0.64rem; color: #f0b47a; }

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
  .xroute {
    background: none; border: none; padding: 0.1rem 0.2rem; cursor: pointer;
    color: var(--accent); font-size: 0.62rem;
  }
  .xroute:hover { text-decoration: underline; }
  .note { margin: 0; font-size: 0.62rem; color: var(--dim); line-height: 1.4; }
  .kprow { align-items: flex-start; }
  .ksum { flex: none; font-size: 0.6rem; color: var(--dim); font-variant-numeric: tabular-nums; }
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
