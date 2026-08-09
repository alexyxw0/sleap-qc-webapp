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
  import { appearanceCoverageNote, APPEARANCE_LABELS } from "../qcStore.svelte.js";
  import { loadAll } from "../qc/embedding/embcache.js";
  import { proofreadWindow } from "../proofreadWindow.svelte.js";
  import { importModel, exportModel, modelFilename } from "../qc/embedding/svmIo.js";

  const clf = classifierInfo();
  const es = $derived(appRun.store); // null for the pretrained (upload-only) route
  const SCORE_LABEL = { knn: "unsupervised", svm: "trained SVM", fewshot: "few-shot" };
  /** What is scoring the inspected keypoint right now — kNN unless the user chose otherwise. */
  const scoredMode = $derived.by(() => {
    void es?.resultRev;
    const ni = es?.selectedNode;
    return ni == null || !es?.scoringOf ? "knn" : es.scoringOf(ni);
  });
  // ---- the scoring branch's actions. Each one reports its own outcome in the pane: a fit that silently
  // did nothing, or an upload that silently failed, is the failure mode this whole flow exists to remove.
  // The keypoint picker lives IN the question now. Scoring is chosen per keypoint, so sending the user
  // down to the results graph to pick one and back up to answer split one decision across two places.
  const nodeChips = $derived.by(() => {
    void es?.resultRev;
    if (!es?.hasResults) return [];
    const names = store.skeleton?.nodeNames ?? [];
    const by = new Map(es.nodeStats.map((n) => [n.node, n]));
    const rows = names.length ? names.map((_, i) => i) : es.nodeStats.map((n) => n.node);
    return rows.map((ni) => ({
      node: ni,
      name: names[ni] ?? `node ${ni}`,
      // Only a SCORED keypoint can be answered about; embedded-but-too-few and never-embedded are shown
      // rather than omitted, because an absent chip reads as "this skeleton has 3 keypoints".
      state: !by.get(ni) ? "absent" : by.get(ni).scored ? "scored" : "few",
      mode: es.scoringOf(ni),
    }));
  });

  let upErr = $state(null), upWarn = $state(null);
  let fitting = $state(false), fitMsg = $state(null);
  const lastFit = new Map(); // node -> { cv } from this session's fit, for the export header

  /** Straight into the ranked queue — the labels this branch needs are exactly what it produces. */
  function openProofreader() {
    keypointLabels.proofreading = true;
    proofreadWindow.showTab("frames");
  }

  async function onUpload(e, ni, nodeName) {
    upErr = upWarn = null;
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const { clf, warning } = importModel(await f.text(), { dim: es.dim ?? null, node: nodeName });
      es.applyTrainedModel(ni, clf);
      upWarn = warning;
    } catch (err) {
      upErr = err.message;
    }
    e.target.value = ""; // so re-picking the same file after a fix still fires
  }

  async function doFit(ni, nodeName) {
    fitting = true; fitMsg = null;
    try {
      // Yield once so the button repaints as "fitting…" — the SMO solve blocks the main thread.
      await new Promise((r) => setTimeout(r, 0));
      const { clf, cv, warning } = es.trainFor(ni);
      es.applyTrainedModel(ni, clf);
      lastFit.set(ni, { cv, node: nodeName });
      fitMsg = `${cv.roc == null ? "no held-out ROC" : `held-out ROC ${cv.roc.toFixed(3)}`} · AP ${cv.pr?.toFixed?.(3) ?? "—"} · ${cv.folds}-fold on ${cv.nPos}/${cv.nPos + cv.nNeg}${warning ? ` — ${warning}` : ""}`;
    } catch (err) {
      fitMsg = `fit failed — ${err.message}`;
    }
    fitting = false;
  }

  function nudge(ni) { es.applyFewShot(ni, 0.5); }

  function doExport(ni, nodeName) {
    const clf = es.trainedModelFor(ni);
    if (!clf) return;
    const t = es.trainableFor(ni);
    const cv = lastFit.get(ni)?.cv ?? null;
    const blob = new Blob([exportModel(clf, {
      node: nodeName, source: store.fileName ?? null,
      nLabels: t.n, nPos: t.pos, cvRoc: cv?.roc ?? null, cvAp: cv?.pr ?? null,
    })], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = modelFilename(nodeName, store.fileName);
    a.click();
    URL.revokeObjectURL(a.href);
  }

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
    // Per keypoint gets a SECOND step: once the embeddings exist there is a real choice about how to
    // score them, and burying it in the results panel meant the run just ended with no "what now".
    // Whole instance has no such choice — the bundled SVM is the only scorer — so it stays one step.
    const embed = [
      { id: "compute", label: appRun.gran === "node" ? "Embed" : "Embed & score", done: appRun.computeDone, locked: false,
        hint: "Pick granularity and coverage, then run the DINOv2 pass over this file.",
        // A bare ✓ after the settings moved describes a run that no longer matches the controls above it.
        note: !appRun.computeDone ? null
          : es?.configDirty ? "settings changed — re-run"
            : noneSelected ? "selection empty"
              : (covNote ?? "ready") },
    ];
    if (appRun.gran !== "node") return embed;
    return [...embed, {
      id: "score", label: "Score",
      // Ticked as soon as scores EXIST: kNN is a real answer, not a skipped step, and a ✓ withheld
      // until you train something would nag about a choice the default already made. The note carries
      // which one is live, which is the part that actually varies.
      done: appRun.nodeDone, locked: !appRun.nodeDone,
      why: "Embed the patches first — there is nothing to score yet.",
      hint: "Unsupervised by default. Fit an SVM on your labels, or nudge the ranking with few-shot.",
      note: appRun.nodeDone ? SCORE_LABEL[scoredMode] : null,
    }];
  });
  // The reason the CURRENT selection is unavailable, if it is — shown once, near the strip.
  const lockedNow = $derived(steps.find((x) => x.id === appRun.tab && x.locked)?.why ?? null);

  // "The run finished" is the moment the scoring question becomes answerable, so that is when it gets
  // asked. Only on the TRANSITION — re-opening the window on old results leaves you where you were, and
  // clicking back to Embed to re-run does not get bounced forward again.
  let wasDone = $state(false);
  $effect(() => {
    const done = appRun.gran === "node" && appRun.nodeDone;
    if (done && !wasDone && appRun.tab === "compute" && !appRun.anyRunning) appRun.setTab("score");
    wasDone = done;
  });

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
      {:else if appRun.tab === "score" && appRun.gran === "node"}
        <!-- The run used to just end. This is the rest of the workflow, asked as questions rather than
             left as tabs to discover: technique, then where the boundary comes from, then how to get the
             labels that boundary needs. One question on screen at a time, each answer routing the next. -->
        <section class="score">
          <!-- Which keypoint, then what to do about it — the two halves of one decision, together. -->
          <div class="kp">
            <span class="kp-l">Keypoint</span>
            <div class="kp-chips">
              {#each nodeChips as ch (ch.node)}
                <button class="kp-c" class:sel={es.selectedNode === ch.node} class:absent={ch.state === "absent"}
                        disabled={ch.state !== "scored"} onclick={() => (es.selectedNode = ch.node)}
                        title={ch.state === "scored" ? `scored by ${SCORE_LABEL[ch.mode]}`
                          : ch.state === "few" ? "embedded, too few patches to score"
                            : "not embedded in this run — nothing is known about it"}>
                  {ch.name}{#if ch.state === "scored" && ch.mode !== "knn"}<span class="kp-b">{ch.mode === "svm" ? "SVM" : "FS"}</span>{/if}
                </button>
              {/each}
            </div>
          </div>
          {#if es?.selectedNode == null}
            <p class="s-q">How should these patches be scored?</p>
            <p class="dim">Pick a keypoint above — scoring is chosen per keypoint.</p>
          {:else}
            {@const ni = es.selectedNode}
            {@const t = es.trainableFor(ni)}
            {@const nodeName = store.skeleton?.nodeNames?.[ni] ?? `node ${ni}`}

            <!-- Q1 ------------------------------------------------------------------------------ -->
            {#if !appRun.scoreChoice}
              <p class="s-q">Which detection technique for <b>{nodeName}</b>?</p>
              <div class="s-opts">
                <button class="sopt" onclick={() => appRun.setScoreChoice("knn")}>
                  <span class="so-t">kNN · unsupervised</span>
                  <span class="so-d">Each patch against the k most similar patches of this keypoint elsewhere in the file. No labels, already applied — choose this to keep it.</span>
                </button>
                <button class="sopt" onclick={() => appRun.setScoreChoice("svm")}>
                  <span class="so-t">SVM · supervised</span>
                  <span class="so-d">A fitted boundary between faulty and clean appearance. Needs labels — bring a model you fitted before, or make them here.</span>
                </button>
              </div>

            <!-- kNN: the default, so this confirms rather than acts ------------------------------ -->
            {:else if appRun.scoreChoice === "knn"}
              <p class="s-q">✓ Scoring <b>{nodeName}</b> with kNN</p>
              <p class="s-note dim">
                Already applied to all {es.patchCount(ni).toLocaleString()} patches — the graph below is it.
                Threshold and per-frame verdicts are live in the <b>{APPEARANCE_LABELS.nodeDino.full}</b> check.
              </p>
              <button class="back" onclick={() => appRun.unaskScore()}>‹ use a different technique</button>

            <!-- Q2 ------------------------------------------------------------------------------ -->
            {:else if !appRun.svmSource}
              <p class="s-q">Where does the boundary come from?</p>
              <div class="s-opts">
                <button class="sopt" onclick={() => appRun.setSvmSource("upload")}>
                  <span class="so-t">Upload a fitted model</span>
                  <span class="so-d">A <code>.json</code> exported from this app in an earlier session — label once, apply to every file after.</span>
                </button>
                <button class="sopt" onclick={() => appRun.setSvmSource("fewshot")}>
                  <span class="so-t">Few-shot — label some frames here</span>
                  <span class="so-d">
                    Proofread the frames the detectors already rank as suspect, then fit on what you marked.
                    {t.n ? `${t.n} patches of ${nodeName} judged so far.` : "Nothing judged yet."}
                  </span>
                </button>
              </div>
              <button class="back" onclick={() => appRun.unaskScore()}>‹ back</button>

            <!-- Upload --------------------------------------------------------------------------- -->
            {:else if appRun.svmSource === "upload"}
              <p class="s-q">Upload a boundary for <b>{nodeName}</b></p>
              <label class="drop">
                <input type="file" accept=".json,application/json" onchange={(e) => onUpload(e, ni, nodeName)} />
                <span>Choose a <code>keypoint-svm_*.json</code></span>
              </label>
              {#if upErr}<p class="s-err">{upErr}</p>{/if}
              {#if upWarn}<p class="s-warn">⚠ {upWarn}</p>{/if}
              {#if scoredMode === "svm"}
                <p class="s-note">✓ applied — {es.patchCount(ni).toLocaleString()} patches re-scored by the model.</p>
              {/if}
              <p class="s-note dim">
                Only a model exported here fits: this pass crops a fraction of each instance's bbox, while the
                bundled models (<code>export_nose.py</code>) crop a fixed pixel box. Those load under
                <b>‹ start → precomputed bundles</b>, with their own embeddings.
              </p>
              <button class="back" onclick={() => appRun.unaskScore()}>‹ back</button>

            <!-- Few-shot: label here, then fit --------------------------------------------------- -->
            {:else}
              <p class="s-q">Label ground truth for <b>{nodeName}</b></p>
              <ol class="fs-steps">
                <li class:done={t.n > 0}>
                  <span class="fs-n">1</span>
                  <span class="fs-b">
                    <b>Proofread.</b> The queue is already ranked by how faulty every detector thinks each
                    instance is, so the labels land where they are worth most.
                    {#if t.n}<br /><span class="dim">{t.n} judged · {t.pos} faulty / {t.neg} clean</span>{/if}
                    <!-- The queue IS the QC output, so with no QC run there is nothing to proofread. Say
                         it here rather than letting the button open an empty window. -->
                    {#if !qc.proofreadReady}<br /><span class="warn">Run the automatic QC first — the queue is its ranking.</span>{/if}
                  </span>
                  <button class="fs-go" disabled={!qc.proofreadReady} onclick={() => openProofreader()}>
                    {t.n ? "keep labelling" : "open proofreader"}
                  </button>
                </li>
                <li class:done={scoredMode !== "knn"} class:locked={!t.pos}>
                  <span class="fs-n">2</span>
                  <span class="fs-b">
                    <b>Fit.</b>
                    {#if t.enough}
                      A cross-validated RBF-SVM on all {t.n} labelled patches.
                      {#if t.pos < t.floor}<br /><span class="warn">Only {t.pos} faulty — below {t.floor}, the CV score is noise, not a measurement.</span>{/if}
                    {:else if t.pos}
                      An SVM needs both classes; you have {t.pos} faulty and no clean ones yet. The few-shot
                      nudge works from the faulty side alone in the meantime.
                    {:else}
                      Nothing marked faulty yet.
                    {/if}
                    {#if fitMsg}<br /><span class="fs-msg">{fitMsg}</span>{/if}
                  </span>
                  {#if t.enough}
                    <button class="fs-go" disabled={fitting} onclick={() => doFit(ni, nodeName)}>
                      {fitting ? "fitting…" : scoredMode === "svm" ? "re-fit" : "fit the SVM"}
                    </button>
                  {:else}
                    <button class="fs-go" disabled={!t.pos} onclick={() => nudge(ni)}>
                      {scoredMode === "fewshot" ? "re-nudge" : "nudge instead"}
                    </button>
                  {/if}
                </li>
                <li class:done={scoredMode === "svm"} class:locked={scoredMode !== "svm"}>
                  <span class="fs-n">3</span>
                  <span class="fs-b">
                    <b>Keep it.</b> Export the boundary and upload it on the next file instead of labelling again.
                  </span>
                  <button class="fs-go" disabled={scoredMode !== "svm"} onclick={() => doExport(ni, nodeName)}>export</button>
                </li>
              </ol>
              {#if es.fewShotInfoFor(ni)}
                {@const fs = es.fewShotInfoFor(ni)}
                <p class="s-note">✓ few-shot applied · prototype from <b>{fs.nPos}</b> faulty{fs.usedGlobal ? " vs the file mean" : ` / ${fs.nNeg} clean`}</p>
              {/if}
              <button class="back" onclick={() => appRun.unaskScore()}>‹ back</button>
            {/if}

            <!-- Fitting a model and USING it are different acts, and the second one had no control here:
                 the only way to arm the detector was to leave the window for the Appearance tab. -->
            {#if appRun.scoreChoice}
              <label class="arm-row" class:on={qc.checks.nodeDino}>
                <input type="checkbox" checked={qc.checks.nodeDino} onchange={() => qc.toggleCheck("nodeDino")} />
                <span class="ar-b">
                  <b>Use as a detection check</b> — <b>{APPEARANCE_LABELS.nodeDino.full}</b>
                  {#if qc.checks.nodeDino}<span class="ar-on">on</span>{/if}
                  <br />
                  <span class="dim">
                    Flags every embedded keypoint, each by whatever is scoring it —
                    {#each nodeChips.filter((c) => c.state === "scored") as c, i (c.node)}{i ? ", " : ""}<b>{c.name}</b> {SCORE_LABEL[c.mode]}{:else}nothing scored yet{/each}.
                    Its threshold and per-frame counts live in the graph below.
                  </span>
                </span>
              </label>
            {/if}
          {/if}
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
            <!-- The SVM is now trained HERE, from these embeddings and your labels — so this must not
                 send anyone to the upload route, which is only for models fitted elsewhere. -->
            <span class="xnote" title="Run this pass, judge some keypoints in the proofreading window, then fit an SVM on them under the keypoint's graph below. It trains on the patches this run computed, so no upload and no crop-geometry mismatch.">
              or fit an SVM on your labels — under the graph, after the run
            </span>
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
            <p class="note">One forward pass per keypoint per instance — many more crops than whole-instance, so expect minutes at full coverage. Cached after the first run. For a <i>supervised</i> per-keypoint score, judge some keypoints and fit an SVM on them under the graph below — it trains on these same patches. Bringing a bundle fitted elsewhere is the other option, back at <b>‹ start</b>.</p>
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
            {ready ? "✓" : "○"} the <b>{APPEARANCE_LABELS[appRun.checkKey].full}</b> check
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
  /* This is the top of the pane and the thing to read first, so it gets the room: a panel with its own
     surface, sized to fill rather than to fit, instead of a paragraph competing with the results graph. */
  .score {
    display: flex; flex-direction: column; gap: 0.7rem;
    min-height: 19rem; padding: 0.9rem 1rem 1rem;
    border: 1px solid var(--border); border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 4%, transparent);
  }
  .s-q { margin: 0; font-size: 1rem; font-weight: 650; color: var(--text); letter-spacing: -0.01em; }
  .s-opts { display: flex; flex-direction: column; gap: 0.55rem; }
  /* Answering is a click, so an option is a button — not a div you have to discover is clickable. */
  .sopt {
    display: flex; flex-direction: column; gap: 0.3rem; text-align: left;
    padding: 0.85rem 1rem; border: 1px solid var(--border); border-radius: 9px;
    background: var(--bg); cursor: pointer; font: inherit;
    transition: border-color 0.12s, background 0.12s;
  }
  .sopt:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 9%, var(--bg)); }
  .so-t { font-size: 0.86rem; font-weight: 600; color: var(--text); }
  .so-d { font-size: 0.7rem; color: var(--dim); line-height: 1.55; }

  /* Which keypoint — the other half of the same decision, so it sits inside the panel, above it. */
  .kp { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
  .kp-l { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); }
  .kp-chips { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .kp-c {
    display: inline-flex; align-items: center; gap: 0.25rem;
    background: transparent; border: 1px solid var(--border); border-radius: 999px;
    color: var(--dim); font-size: 0.65rem; padding: 0.1rem 0.5rem; cursor: pointer;
  }
  .kp-c:hover:not(:disabled) { border-color: var(--accent); color: var(--text); }
  .kp-c.sel { border-color: var(--accent); background: var(--accent); color: #06281a; font-weight: 600; }
  .kp-c:disabled { opacity: 0.45; cursor: default; }
  .kp-c.absent { text-decoration: line-through; border-style: dashed; }
  .kp-b { font-size: 0.52rem; font-weight: 700; letter-spacing: 0.04em; opacity: 0.85; }

  /* Arming the detector is the last act of the flow, so it reads as a commitment, not a footnote. */
  .arm-row {
    display: grid; grid-template-columns: auto 1fr; gap: 0.55rem; align-items: start;
    margin-top: auto; padding: 0.6rem 0.7rem;
    border: 1px solid var(--border); border-radius: 8px; background: var(--bg); cursor: pointer;
  }
  .arm-row:hover { border-color: var(--accent); }
  .arm-row.on { border-color: color-mix(in srgb, #6ee7a8 55%, var(--border)); }
  .arm-row input { margin-top: 0.15rem; accent-color: var(--accent); }
  .ar-b { font-size: 0.7rem; color: var(--text); line-height: 1.55; }
  .ar-b .dim { font-size: 0.63rem; color: var(--dim); }
  .ar-on { color: #6ee7a8; font-size: 0.6rem; font-weight: 700; text-transform: uppercase; }
  .back {
    align-self: flex-start; background: transparent; border: 0; padding: 0.1rem 0;
    color: var(--dim); font-size: 0.68rem; cursor: pointer;
  }
  .back:hover { color: var(--accent); }
  .drop {
    display: block; padding: 1.4rem 0.7rem; border: 1px dashed var(--border); border-radius: 8px;
    text-align: center; font-size: 0.74rem; color: var(--dim); cursor: pointer;
  }
  .drop:hover { border-color: var(--accent); color: var(--accent); }
  .drop input { display: none; }
  .s-note { margin: 0; font-size: 0.68rem; color: #6ee7a8; line-height: 1.5; }
  .s-note.dim { color: var(--dim); }
  .s-err { margin: 0; font-size: 0.65rem; color: #ff6b6b; line-height: 1.5; }
  .s-warn { margin: 0; font-size: 0.65rem; color: #f0b47a; line-height: 1.5; }
  .warn { color: #f0b47a; }
  .fs-msg { color: var(--accent); }
  /* The three moves of the few-shot branch, numbered — the order is the point. */
  .fs-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .fs-steps li {
    display: grid; grid-template-columns: auto 1fr auto; align-items: start; gap: 0.6rem;
    padding: 0.65rem 0.75rem; border: 1px solid var(--border); border-radius: 8px;
  }
  .fs-steps li.locked { opacity: 0.5; }
  .fs-steps li.done { border-color: color-mix(in srgb, #6ee7a8 45%, var(--border)); }
  .fs-n {
    display: grid; place-items: center; width: 1.35rem; height: 1.35rem; border-radius: 50%;
    background: var(--border); color: var(--dim); font-size: 0.68rem; font-weight: 700;
  }
  .fs-steps li.done .fs-n { background: #6ee7a8; color: #06281a; }
  .fs-b { font-size: 0.7rem; color: var(--dim); line-height: 1.55; }
  .fs-b b { color: var(--text); }
  .fs-go {
    background: transparent; border: 1px solid var(--accent); border-radius: var(--r-xs);
    color: var(--accent); font-size: 0.68rem; padding: 0.28rem 0.7rem; cursor: pointer; white-space: nowrap;
  }
  .fs-go:disabled { opacity: 0.4; border-color: var(--border); color: var(--dim); cursor: default; }

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
  .xnote { font-size: 0.62rem; color: var(--dim); cursor: help; }
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
