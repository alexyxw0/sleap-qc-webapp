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
  import { keypointModels, ingestLabelCsv } from "../keypointModels.svelte.js";
  import { keypointLabels } from "../keypointLabels.svelte.js";
  import { nearestChip, rangeSelection } from "../qc/chipHit.js";
  import { appearanceCoverageNote, APPEARANCE_LABELS } from "../qcStore.svelte.js";
  import { countFor } from "../qc/embedding/embcache.js";
  import { proofreadWindow } from "../proofreadWindow.svelte.js";
  import { importModel, exportModel, modelFilename } from "../qc/embedding/svmIo.js";

  const clf = classifierInfo();
  const es = $derived(appRun.store); // null for the pretrained (upload-only) route
  const SCORE_LABEL = { knn: "unsupervised kNN", anomalyDino: "AnomalyDINO", svm: "trained SVM", fewshot: "few-shot" };
  const SCORE_BADGE = { anomalyDino: "AD", svm: "SVM", fewshot: "FS" };
  // ---- the scoring branch's actions. Each one reports its own outcome in the pane: a fit that silently
  // did nothing, or an upload that silently failed, is the failure mode this whole flow exists to remove.
  // The keypoint picker lives IN the question now. Scoring is chosen per keypoint, so sending the user
  // down to the results graph to pick one and back up to answer split one decision across two places.
  /** Keypoints already carrying a trained override — proof, in the pane, that a supervised layer and
   *  an unsupervised baseline coexist rather than replacing each other. */
  const trainedNodes = $derived.by(() => {
    void es?.resultRev;
    const names = store.skeleton?.nodeNames ?? [];
    return (es?.nodeStats ?? [])
      .map((n) => n.node)
      .filter((ni) => es?.scoringOf?.(ni) === "svm" || es?.scoringOf?.(ni) === "fewshot")
      .map((ni) => names[ni] ?? `node ${ni}`);
  });

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

  // The bundle route's CSV import. Routed through the shared ingest so the rescore can't be forgotten.
  let csvMsg = $state(""), csvErr = $state(false);
  async function onAdaptCsv(e) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const r = await ingestLabelCsv(f);
    csvErr = !r.ok; csvMsg = r.msg;
    if (r.ok) appRun.setLabelSource("csv");
  }

  // An answer about a bundle that is no longer loaded describes nothing. Clearing it here rather than
  // in the store keeps the store's job to facts, and the pane's job to the question it is asking.
  $effect(() => {
    if (!appRun.pairLoaded && appRun.adaptChoice) appRun.setAdaptChoice(null);
  });

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

  /** Take the trained model off this keypoint and put it back on the unsupervised baseline. */
  async function revert(ni, nodeName) {
    const back = es.scorer === "anomalyDino" ? "AnomalyDINO" : "kNN";
    await es.clearTrainedModel(ni);
    lastFit.delete(ni);
    fitMsg = `${nodeName} is back on ${back} — the model is gone, the labels are not.`;
  }

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

  // ---- the supervised branch's target. `appRun.scoreNode` is the flow's ANSWER; es.selectedNode is
  // the graph's cursor. They are kept in step so the inspector shows the keypoint you are training.
  const sNode = $derived(appRun.scoreNode);
  const sName = $derived(sNode == null ? "" : (store.skeleton?.nodeNames?.[sNode] ?? `node ${sNode}`));
  const sMode = $derived.by(() => {
    void es?.resultRev;
    return sNode == null || !es?.scoringOf ? null : es.scoringOf(sNode);
  });
  const sTrainable = $derived.by(() => {
    void es?.resultRev;
    return sNode == null || !es?.trainableFor ? null : es.trainableFor(sNode);
  });
  function pickScoreNode(ni) {
    appRun.setScoreNode(ni);
    if (es) es.selectedNode = ni; // the graph in ④ follows the keypoint being trained
  }
  /** What the unsupervised baseline is called right now — the thing a revert goes back to. */
  const baselineLabel = $derived(
    (appRun.gran === "instance" ? es?.method : es?.scorer) === "anomalyDino" ? "AnomalyDINO" : "kNN");
  /** What is scoring the current selection, for the confirmation page. */
  const appliedLabel = $derived(
    appRun.scoreKind === "sup" && appRun.gran === "instance" ? "the bundled SVM"
      : appRun.unsupChoice === "anomalyDino" ? "AnomalyDINO" : "kNN");

  const running = $derived(appRun.running);
  const busy = $derived(appRun.anyRunning); // the two stores share one worker
  const ready = $derived(appRun.checkKey ? qc.checkReady(appRun.checkKey) : false);
  const armed = $derived(appRun.checkKey ? !!qc.checks[appRun.checkKey] : false);

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
  /** Set one keypoint's membership. `on === null` toggles. */
  function setNode(ni, on = null) {
    if (!es) return;
    // null means "all" in the store; materialise it on the first deselect, and collapse back to null
    // when everything is on again so the config signature keeps one representation of the same pass.
    const cur = Array.isArray(es.nodes) ? es.nodes : allNodes.map((_, k) => k);
    const has = cur.includes(ni);
    const want = on ?? !has;
    if (want === has) return;
    const next = want ? [...cur, ni].sort((a, b) => a - b) : cur.filter((k) => k !== ni);
    es.nodes = next.length === allNodes.length ? null : next;
  }
  const toggleNode = (ni) => setNode(ni);

  // ---- drag across the chips to select or deselect a run of them --------------------------------
  // A 13-keypoint skeleton meant 13 clicks to pick 3, or 10 to drop the rest. The drag PAINTS one
  // state rather than toggling each chip it crosses: the first chip decides the direction (it was on,
  // so this is a deselect), and every chip the pointer enters is set to that same state. Toggling per
  // chip would make a drag that doubles back undo itself, which is not what a drag means anywhere
  // else — spreadsheets, file managers and checkbox lists all paint.
  let paint = $state(null);   // the direction the drag is applying, or null when not dragging
  let anchor = -1;            // the chip the drag started on
  let baseline = null;        // the selection BEFORE the drag, so a reverse stroke can restore it
  let lastHit = -1;           // last chip the pointer was near; kept when it strays off the row
  let chipRow = $state.raw(null);
  // The chips are small and the gaps between them are real: a drag along a row kept skipping one
  // because the pointer passed through the gap, or drifted a few pixels above the row. So the drag
  // does not rely on entering a chip — it hit-tests every chip against the pointer and takes the
  // NEAREST one within SLOP px. Zero distance means inside, so a straight pass still behaves exactly
  // as before; the tolerance only rescues the near-misses.
  const SLOP = 12;
  /** Write a selection Set back to the store, collapsing "everything" to null as the store expects. */
  function writeNodes(set) {
    if (!es) return;
    const next = [...set].sort((a, b) => a - b);
    es.nodes = next.length === allNodes.length ? null : next;
  }

  function paintAt(x, y) {
    if (paint === null || !chipRow) return;
    const els = [...chipRow.querySelectorAll("[data-ni]")];
    const i = nearestChip(els.map((el) => el.getBoundingClientRect()), x, y, SLOP);
    // Straying off the chips holds the range where it was rather than collapsing it — a drag that
    // dips below the row on its way across should not undo everything behind it.
    if (i >= 0) lastHit = Number(els[i].dataset.ni);
    if (lastHit >= 0) writeNodes(rangeSelection(baseline, anchor, lastHit, paint));
  }

  function paintStart(ni, isOn, e) {
    if (busy) return;
    paint = !isOn;
    anchor = ni;
    lastHit = ni;
    baseline = new Set(picked ?? allNodes.map((_, k) => k));
    writeNodes(rangeSelection(baseline, anchor, ni, paint));
    // Capture on the ROW, not the chip. Hit-testing means we no longer need a sibling to receive the
    // event — we need to keep receiving them ourselves, including once the pointer leaves the row.
    chipRow?.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }
  const paintMove = (e) => { if (paint !== null) paintAt(e.clientX, e.clientY); };
  const paintEnd = () => { paint = null; anchor = -1; baseline = null; lastHit = -1; };
  const covNote = $derived(appearanceCoverageNote(appRun.checkKey));

  // A warm IndexedDB cache is only discovered inside run(), after the model load — so the cost line
  // quoted a full pass and a 90 MB download to someone whose re-run would take seconds. Probe it here,
  // using the store's OWN key so the probe cannot miss by a format detail.
  let cached = $state(null); // entries already stored for this file, or null while unknown
  $effect(() => {
    const id = es?.cacheId;
    // Depend on the RESULT revision too: a finished run writes tens of thousands of entries, and
    // without this the readout kept showing the pre-run count until something unrelated re-ran the
    // effect — which is what "the cache disappeared and came back later" actually was.
    void es?.resultRev;
    if (!id) { cached = null; return; }
    let stale = false;
    // countFor, not loadAll: this only ever wanted a number, and loadAll deserializes every
    // embedding and thumbnail in the partition to produce it.
    countFor(id).then((n) => { if (!stale) cached = n < 0 ? null : n; }).catch(() => { if (!stale) cached = null; });
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
        // The bundle route gets the SAME second step as the compute route, and for the same reason:
        // a loaded model still leaves a real choice — score with it as shipped, or bend it toward this
        // project — and that choice was previously a tab you had to know to open. It unlocks on the
        // pair being loaded, NOT on labels: "as-is" is a legitimate answer that needs none.
        { id: "fewshot", label: "Score", done: appRun.adaptChoice != null,
          locked: !pair,
          why: "Load a keypoint's embeddings AND its model first — there is nothing to score with yet.",
          hint: "Use the bundled boundary as-is, or adapt it to this project with your labels.",
          note: appRun.adaptChoice === "as-is" ? "as shipped"
            : appRun.adaptLive ? "few-shot applied"
              : appRun.adaptChoice === "adapt" ? (appRun.hasLabels ? "set the blend" : "needs labels")
                : pair ? "choose" : null },
      ];
    }
    // THREE steps on both granularities now. Whole instance used to be one — "Embed & score" — because
    // the bundled SVM was its only scorer; it has the same unsupervised pair as per-keypoint now, so it
    // has the same question to answer and the same commitment to make.
    const done = appRun.computeDone;
    return [
      { id: "compute", label: "Embed", done, locked: false,
        hint: "Choose what to embed, then run the DINOv2 pass over this file.",
        // A bare ✓ after the settings moved describes a run that no longer matches the controls above it.
        note: !done ? null
          : es?.configDirty ? "settings changed — re-run"
            : noneSelected ? "selection empty"
              : (covNote ?? "ready") },
      { id: "score", label: "Score",
        // Ticked when a scorer has been CHOSEN, not merely when scores exist: the whole point of the
        // step is that the default is now an answer someone gave.
        done: !!appRun.scoreChoice, locked: !done,
        why: "Embed first — there is nothing to score yet.",
        hint: "Unsupervised (kNN or AnomalyDINO), or a trained boundary.",
        note: appRun.scoreChoice ? SCORE_LABEL[appRun.scoreChoice] : null },
      { id: "use", label: "Use", done: armed, locked: !done,
        why: "Embed first — a check with nothing behind it flags nothing.",
        hint: "Arm the detection check, and inspect the scores it will flag on.",
        note: armed ? "armed" : ready ? "not armed" : null },
    ];
  });
  // The reason the CURRENT selection is unavailable, if it is — shown once, near the strip.
  const lockedNow = $derived(steps.find((x) => x.id === appRun.tab && x.locked)?.why ?? null);

  // "The run finished" is the moment the scoring question becomes answerable, so that is when it gets
  // asked. Only on the TRANSITION — re-opening the window on old results leaves you where you were, and
  // clicking back to Embed to re-run does not get bounced forward again.
  let wasDone = $state(false);
  $effect(() => {
    const done = appRun.computeDone;
    if (done && !wasDone && appRun.tab === "compute" && !appRun.anyRunning) appRun.setTab("score");
    wasDone = done;
  });

  // The bundle route's equivalent. A loaded pair is exactly when "score it as shipped, or adapt it?"
  // becomes answerable, so loading one carries you to the question instead of leaving you on a finished
  // upload form. Transition-only, for the same reasons: re-opening the window on an already-loaded
  // bundle leaves you where you were, and going back to ① to add another keypoint does not bounce you
  // forward mid-edit.
  let wasPaired = $state(false);
  $effect(() => {
    const paired = appRun.pairLoaded;
    if (paired && !wasPaired && appRun.tab === "upload") appRun.setTab("fewshot");
    wasPaired = paired;
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

</script>

<!-- A drag can end anywhere: releasing outside the chips must still stop painting. -->
<svelte:window onpointerup={paintEnd} onpointercancel={paintEnd} />

<!-- EVERY pure choice in the flow renders through here, straight from the model's action list. That is
     what makes the two-action rule structural: a page cannot draw a third card this markup was not
     handed, and the model is where the test counts them. -->
{#snippet choice(actions, pick)}
  <div class="s-opts">
    {#each actions as a (a.id)}
      <button class="sopt" onclick={() => pick(a.id)}>
        <span class="so-t">{a.label}</span>
        <span class="so-d">{a.desc}</span>
      </button>
    {/each}
  </div>
{/snippet}

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
        <!-- One step, not all the way out. The destination is on the button face: backing out of a
             question should not require pressing it to find out where you land. -->
        <button class="f-back" onclick={() => appRun.back()} disabled={busy || !appRun.canBack}
                title={busy ? "Not while a run is in flight" : `Back to ${appRun.backLabel}`}>‹ {appRun.backLabel}</button>
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
        <!-- The bundle route's second step, mirroring the compute route's: one question at a time,
             each answer routing the next, and every branch with a way back. -->
        <section class="score">
          {#if !appRun.pairLoaded}
            <p class="s-q">How should the loaded model score this project?</p>
            <p class="dim">Load a keypoint's embeddings <b>and</b> its model first — go back to ① Load bundles.</p>

          <!-- Q1 ------------------------------------------------------------------------------ -->
          {:else if !appRun.adaptChoice}
            <p class="s-q">How should the loaded model score this project?</p>
            <div class="s-opts">
              <button class="sopt" onclick={() => appRun.setAdaptChoice("as-is")}>
                <span class="so-t">Use it as shipped</span>
                <span class="so-d">
                  The bundle's own calibrated boundary, unchanged. Needs nothing from you — but transfer
                  onto a new project is data-limited, and it is already scoring: this answer just says so.
                </span>
              </button>
              <button class="sopt" onclick={() => appRun.setAdaptChoice("adapt")}>
                <span class="so-t">Adapt it to this project (few-shot)</span>
                <span class="so-d">
                  Blend the boundary toward the patches marked faulty <i>here</i>. A handful of labels is
                  enough — this is the cheap fix for a model that transferred imperfectly.
                </span>
              </button>
            </div>

          <!-- as-is: nothing to do, so say that rather than showing controls ------------------- -->
          {:else if appRun.adaptChoice === "as-is"}
            <p class="s-q">✓ Scoring with the bundle as shipped</p>
            <p class="s-note dim">
              {keypointModels.active.length} keypoint{keypointModels.active.length === 1 ? "" : "s"} scored by
              their own bundled model. Thresholds and per-frame verdicts are live in the results below.
            </p>
            <button class="back" onclick={() => appRun.unaskAdapt()}>‹ adapt it instead</button>

          <!-- Q2: where do the labels come from? ---------------------------------------------- -->
          {:else if !appRun.hasLabels && !appRun.labelSource}
            <p class="s-q">Few-shot needs labels — where from?</p>
            <div class="s-opts">
              <label class="sopt as-label">
                <span class="so-t">Import a faulty_keypoints.csv</span>
                <span class="so-d">A review you already did, in or out of this app.</span>
                <input type="file" accept=".csv,text/csv" onchange={onAdaptCsv} />
              </label>
              <button class="sopt" disabled={!qc.proofreadReady} onclick={() => { appRun.setLabelSource("proofread"); openProofreader(); }}>
                <span class="so-t">Proofread here</span>
                <span class="so-d">
                  {qc.proofreadReady
                    ? "Walk the ranked queue and mark keypoints — the labels land straight back here."
                    : "Run the automatic QC first — the queue is its ranking."}
                </span>
              </button>
            </div>
            {#if csvMsg}<p class="s-note" class:s-err={csvErr}>{csvMsg}</p>{/if}
            <button class="back" onclick={() => appRun.unaskAdapt()}>‹ back</button>

          <!-- The blend itself ---------------------------------------------------------------- -->
          {:else}
            <p class="s-q">Blend the bundled boundary toward your labels</p>
            {#if !appRun.hasLabels}
              <p class="s-note dim">
                Waiting on labels{appRun.labelSource === "proofread" ? " from the proofreader" : ""} — the
                sliders below arm themselves the moment any arrive.
              </p>
            {/if}
            <FewShotPanel />
            <button class="back" onclick={() => appRun.unaskAdapt()}>‹ back</button>
          {/if}

          <!-- Same commitment step the compute route ends on: fitting/choosing is not using. -->
          {#if appRun.pairLoaded && appRun.adaptChoice}
            <label class="arm-row" class:on={qc.checks.noseAppearance}>
              <input type="checkbox" checked={qc.checks.noseAppearance}
                     onchange={() => qc.toggleCheck("noseAppearance")} />
              <span class="ar-b">
                <b>Use as a detection check</b> — <b>{APPEARANCE_LABELS.noseAppearance.full}</b>
                {#if qc.checks.noseAppearance}<span class="ar-on">on</span>{/if}
                <br />
                <span class="dim">
                  {keypointModels.active.map((s) => s.store.info?.node ?? "?").join(", ") || "no keypoint"}
                  · scored by {appRun.adaptLive ? "the adapted boundary" : "the bundled boundary"}.
                </span>
              </span>
            </label>
          {/if}
        </section>
      {:else}
      <!-- THE COMPUTE ROUTE, one page at a time. Every page below renders `page.actions` and nothing
           else that acts, so the two-action rule is a property of qc/alFlow.js rather than of this
           markup's discipline — a third action has to be added to the MODEL, where the test sees it. -->
      {@const page = appRun.flow}

      {#if page.id === "scope"}
        <!-- ① What to embed. Promoted out of an inline segmented control on the old settings page: it
             decides the store, the cost, the check and which scorers exist, so it is the first question,
             not a toggle sitting above the run button. -->
        <section class="score">
          <p class="s-q">{page.question}</p>
          {@render choice(page.actions, (id) => appRun.setGran(id.slice(5)))}
          <p class="s-note dim">
            Both granularities offer the same unsupervised pair (kNN and AnomalyDINO) and a supervised
            boundary. They differ in what a flag can name.
          </p>
        </section>

      {:else if page.id === "embed"}
        <!-- ② The pass itself: pick keypoints (one selection, however many chips), then run. -->
        <section class="cfg">
          <p class="s-q">{page.question}</p>
          {#if es && appRun.gran === "node" && allNodes.length}
            <div class="row kprow">
              <span class="lbl">Keypoints</span>
              <!-- touch-action: none so a drag across the chips selects instead of scrolling the pane. -->
              <!-- data-action-group: this row is ONE selection however many chips it draws, the way a
                   multi-select is one control. The two-action test reads this rather than guessing. -->
              <div class="chips" role="group" data-action-group="keypoints" style:touch-action="none"
                   bind:this={chipRow} onpointermove={paintMove} onlostpointercapture={paintEnd}>
                {#each allNodes as nm, ni (nm)}
                  {@const on = picked == null || picked.includes(ni)}
                  <button type="button" class="kchip" class:on disabled={busy} data-ni={ni}
                          onpointerdown={(e) => paintStart(ni, on, e)}
                          onkeydown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleNode(ni); } }}
                          aria-pressed={on}
                          title={on ? `${nm} will be embedded — click to skip it, or drag across to skip several` : `${nm} will NOT be embedded, so nothing will be known about it`}>{nm}</button>
                {/each}
              </div>
              <span class="ksum" title="Click a keypoint to toggle it, or drag across several">{nSel} of {allNodes.length}</span>
            </div>
          {/if}

          {#if es}
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
              <p class="dim">{es.message} {es.hasResults ? "Partial results are kept — go to ③ Score." : ""}</p>
            {:else if !running && !es.hasResults}
              <p class="dim">
                {#if !modelReady}The DINOv2 weights (~90 MB) download once, then embed.{:else}Weights already loaded.{/if}
                {#if cached}<b>{cached.toLocaleString()} crops already cached</b> — reused, not re-embedded.{/if}
              </p>
            {/if}
            {#if es?.cacheNote}<p class="cachewarn">⚠ {es.cacheNote}</p>{/if}
          {/if}

          <Explain>
            {#if appRun.gran === "instance"}
              <p class="note">One whole-instance crop per animal, embedded with DINOv2 ViT-S/14 (384-d). Scored either <b>unsupervised</b> — kNN on the crop vector, or AnomalyDINO on its patch tokens — or by the bundled RBF-SVM{#if clf} (<b>{clf.dataset}</b>, CV ROC {clf.cv_roc.toFixed(3)} / PR {clf.cv_pr.toFixed(3)}){/if}. Catches occlusion and appearance errors geometry misses, but not <i>which</i> keypoint is wrong.</p>
            {:else}
              <p class="note">A patch around each selected keypoint, embedded with DINOv2 ViT-S/14. One forward pass per keypoint per instance — many more crops than whole-instance, so expect minutes at full coverage. Cached after the first run, so choosing a scorer afterwards never re-embeds.</p>
            {/if}
          </Explain>
        </section>

      {:else if page.id === "score.kind" || page.id === "score.unsup" || page.id === "score.source"}
        <!-- The three pure choices. Two cards each, rendered from the model. -->
        <section class="score">
          <p class="s-q">{page.question}</p>
          {#if page.id === "score.kind"}
            <p class="s-note dim">
              {#if appRun.gran === "instance"}
                Whole-animal crops: the bundled SVM was fitted on proofread ones and scores {clf ? `CV ROC ${clf.cv_roc.toFixed(2)}` : "well"} on that
                dataset, while unsupervised kNN scored about chance there. AnomalyDINO reads the same
                crops patch-by-patch and is the unsupervised option worth trying at this granularity.
              {:else}
                Unsupervised applies to every embedded keypoint at once. Supervised overrides ONE
                keypoint and leaves the rest on the unsupervised baseline.
              {/if}
            </p>
          {:else if page.id === "score.unsup" && appRun.gran === "node"}
            <p class="s-note dim">Applies to every embedded keypoint. Either can be overridden per keypoint later.</p>
          {:else if page.id === "score.source"}
            <p class="s-note dim">
              This overrides <b>{sName}</b> only.
              {#if sTrainable}{sTrainable.n} patches of {sName} judged so far.{/if}
            </p>
          {/if}
          {@render choice(page.actions, (id) =>
            page.id === "score.kind" ? appRun.setScoreKind(id.slice(5))
              : page.id === "score.unsup" ? appRun.setUnsupChoice(id.slice(6))
                : appRun.setSvmSource(id.slice(4)))}
        </section>

      {:else if page.id === "score.node"}
        <!-- Which keypoint the trained boundary is for. Its own page: picking a keypoint and picking a
             technique were two questions sharing one screen, and the keypoint one only exists here. -->
        <section class="score">
          <p class="s-q">{page.question}</p>
          <div class="kp-chips" role="group" data-action-group="keypoint">
            {#each nodeChips as ch (ch.node)}
              <button class="kp-c" class:sel={appRun.scoreNode === ch.node} class:absent={ch.state === "absent"}
                      disabled={ch.state !== "scored"} onclick={() => pickScoreNode(ch.node)}
                      title={ch.state === "scored" ? `scored by ${SCORE_LABEL[ch.mode]}`
                        : ch.state === "few" ? "embedded, too few patches to score"
                          : "not embedded in this run — nothing is known about it"}>
                {ch.name}{#if ch.state === "scored" && SCORE_BADGE[ch.mode]}<span class="kp-b">{SCORE_BADGE[ch.mode]}</span>{/if}
              </button>
            {/each}
          </div>
          <p class="s-note dim">
            Only a scored keypoint can be answered about. Every other keypoint keeps the unsupervised
            baseline{#if trainedNodes.length}; already trained: {trainedNodes.join(", ")}{/if}.
          </p>
        </section>

      {:else if page.id === "score.done"}
        <!-- The confirmation. Choosing an unsupervised scorer APPLIED it, so this reports rather than asks. -->
        {@const ad = appRun.unsupChoice === "anomalyDino"}
        {@const cov = es?.patchCoverage}
        <section class="score">
          <p class="s-q">✓ Scoring {appRun.gran === "node" ? "every embedded keypoint" : "every instance"} with <b>{appliedLabel}</b></p>
          <p class="s-note dim">
            {#if ad}Each crop is {cov?.tokens} pooled DINOv2 patch tokens ({cov?.dim}-d) against a memory bank drawn
              from this file's reference crops, scored by its worst quarter.
            {:else if appRun.scoreKind === "sup"}The bundled boundary, unchanged{#if clf} — fitted on <b>{clf.dataset}</b>{/if}.
            {:else}Distance to the k most similar crops of the same kind in this file, as a robust z.
            {/if}
            The graph and the threshold are in <b>④ Use</b>.
          </p>
          <!-- Partial coverage is the one thing that must not be quiet: those crops score 0 — perfectly
               clean — for a bookkeeping reason and not an appearance one. -->
          {#if ad && cov && cov.have === 0}
            <p class="s-warn">
              <b>No patch features in this run — everything fell back to kNN.</b>
              These embeddings came from a cache written before patch features existed. Computing them
              means embedding {cov.total.toLocaleString()} crops again.
              <label class="s-req"><input type="checkbox" bind:checked={es.requirePatches} /> recompute them on the next run</label>
            </p>
          {:else if ad && cov && !cov.full}
            <p class="s-warn">
              {(cov.total - cov.have).toLocaleString()} of {cov.total.toLocaleString()} crops came from a cache
              written before patch features existed. <b>They score 0 — clean — because nothing is known
              about them</b>, not because they look right.
              <label class="s-req"><input type="checkbox" bind:checked={es.requirePatches} /> re-embed those on the next run</label>
            </p>
          {/if}
          {#if page.actions.length}
            <div class="s-row">
              {#each page.actions as a (a.id)}
                <button class="sopt-sm" onclick={() => appRun.setScoreKind("sup")}>+ {a.label}</button>
              {/each}
            </div>
            <p class="s-note dim">{appliedLabel} stays the baseline for every keypoint you do not train.</p>
          {/if}
        </section>

      {:else if page.id === "score.upload"}
        <section class="score">
          <p class="s-q">{page.question} for <b>{sName}</b></p>
          <label class="drop">
            <input type="file" accept=".json,application/json" onchange={(e) => onUpload(e, sNode, sName)} />
            <span>Choose a <code>keypoint-svm_*.json</code></span>
          </label>
          {#if upErr}<p class="s-err">{upErr}</p>{/if}
          {#if upWarn}<p class="s-warn">⚠ {upWarn}</p>{/if}
          {#if sMode === "svm"}
            <p class="s-note">✓ applied — {es.patchCount(sNode).toLocaleString()} patches re-scored by the model.</p>
            <button class="fs-undo" onclick={() => revert(sNode, sName)}
                    title="Drop this model and score {sName} with the unsupervised baseline again">
              revert to {baselineLabel}
            </button>
          {/if}
          <p class="s-note dim">
            Only a model exported here fits: this pass crops a fraction of each instance's bbox, while the
            bundled models (<code>export_nose.py</code>) crop a fixed pixel box. Those load under
            <b>‹ start → precomputed bundles</b>, with their own embeddings.
          </p>
        </section>

      {:else if page.id === "score.label"}
        <!-- Label, then fit. Two actions, and the export moved to its own page so this one is not three. -->
        <section class="score">
          <p class="s-q">{page.question} for <b>{sName}</b></p>
          <p class="s-note dim">
            The queue is ranked by how faulty every detector thinks each instance is, so the labels land
            where they are worth most.
            {#if sTrainable}<br />{sTrainable.n} judged · {sTrainable.pos} faulty / {sTrainable.neg} clean.{/if}
            {#if !qc.proofreadReady}<br /><span class="warn">Run the automatic QC first — the queue is its ranking.</span>{/if}
            {#if sTrainable && !sTrainable.enough && sTrainable.pos}
              <br />An SVM needs both classes; you have {sTrainable.pos} faulty and no clean ones yet. The
              few-shot nudge works from the faulty side alone in the meantime.
            {/if}
            {#if sTrainable?.enough && sTrainable.pos < sTrainable.floor}
              <br /><span class="warn">Only {sTrainable.pos} faulty — below {sTrainable.floor}, the CV score is noise, not a measurement.</span>
            {/if}
            {#if fitMsg}<br /><span class="fs-msg">{fitMsg}</span>{/if}
          </p>
          <div class="s-row">
            <button class="fs-go" disabled={!qc.proofreadReady} onclick={() => openProofreader()}>
              {sTrainable?.n ? "keep labelling" : "open proofreader"}
            </button>
            {#if sTrainable?.enough}
              <button class="fs-go" disabled={fitting} onclick={() => doFit(sNode, sName)}>
                {fitting ? "fitting…" : "fit the SVM"}
              </button>
            {:else}
              <button class="fs-go" disabled={!sTrainable?.pos} onclick={() => nudge(sNode)}>
                {sMode === "fewshot" ? "re-nudge" : "nudge instead"}
              </button>
            {/if}
          </div>
        </section>

      {:else if page.id === "score.keep"}
        <section class="score">
          <p class="s-q">✓ <b>{sName}</b> is scored by your boundary</p>
          <p class="s-note dim">
            Export it and upload it on the next file instead of labelling again. Reverting drops the
            model and puts {sName} back on {baselineLabel} — your labels stay either way.
            {#if fitMsg}<br /><span class="fs-msg">{fitMsg}</span>{/if}
            {#if es?.fewShotInfoFor?.(sNode)}
              {@const fs = es.fewShotInfoFor(sNode)}
              <br />few-shot applied · prototype from <b>{fs.nPos}</b> faulty{fs.usedGlobal ? " vs the file mean" : ` / ${fs.nNeg} clean`}
            {/if}
          </p>
          <div class="s-row">
            <button class="fs-go" onclick={() => doExport(sNode, sName)}>export the boundary</button>
            <button class="fs-undo" onclick={() => revert(sNode, sName)}>revert to {baselineLabel}</button>
          </div>
        </section>

      {:else if page.id === "use"}
        <!-- ④ The commitment, and the only page the inspector lives on. Fitting or choosing a scorer is
             not USING it: the detector still has to be armed, and that used to be a checkbox repeated at
             the foot of every scoring sub-page. -->
        <section class="score">
          <p class="s-q">{page.question}</p>
          <label class="arm-row" class:on={armed}>
            <input type="checkbox" checked={armed} disabled={!appRun.checkKey}
                   onchange={() => appRun.checkKey && qc.toggleCheck(appRun.checkKey)} />
            <span class="ar-b">
              <b>{appRun.checkKey ? APPEARANCE_LABELS[appRun.checkKey].full : "—"}</b>
              {#if armed}<span class="ar-on">on</span>{/if}
              <br />
              <span class="dim">
                {#if appRun.gran === "node"}
                  Flags every embedded keypoint, each by whatever is scoring it —
                  {#each nodeChips.filter((c) => c.state === "scored") as c, i (c.node)}{i ? ", " : ""}<b>{c.name}</b> {SCORE_LABEL[c.mode]}{:else}nothing scored yet{/each}.
                {:else}
                  Flags every instance by {appliedLabel}.
                {/if}
                {#if covNote} · <b>{covNote}</b>{/if}
              </span>
            </span>
          </label>
          {#if !ready}<p class="dim">This unlocks once the pass has results.</p>{/if}
        </section>

        <!-- THE INSPECTOR. Deliberately not on a question page: its threshold and graph read the run,
             they do not answer anything, and mixing them into a step made every page look like five. -->
        <section class="results">
          {#if appRun.gran === "instance"}<EmbeddingCheck />{:else}<NodeEmbeddingCheck />{/if}
        </section>
      {/if}
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
  /* A failed cache write used to be silent; it shows up much later as "my embeddings vanished". */
  .cachewarn { margin: 0; font-size: 0.65rem; color: #f0b47a; line-height: 1.5; }
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
  .sopt:disabled { opacity: 0.5; cursor: default; }
  .sopt:disabled:hover { border-color: var(--border); background: var(--bg); }
  /* One option opens a file picker rather than answering — same card, so the two read as one choice. */
  .as-label input { display: none; }
  .so-t { font-size: 0.86rem; font-weight: 600; color: var(--text); }
  .so-d { font-size: 0.7rem; color: var(--dim); line-height: 1.55; }

  /* Which keypoint — the other half of the same decision, so it sits inside the panel, above it. */
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
  .s-warn {
    margin: 0.5rem 0 0;
    padding: 0.5rem 0.6rem;
    border: 1px solid #7a5a20;
    border-radius: 5px;
    background: #2a2113;
    color: #e7c08a;
    font-size: 0.76rem;
    line-height: 1.5;
  }
  .s-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .sopt-sm {
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--accent);
    border-radius: 5px;
    background: transparent;
    color: var(--accent);
    font-size: 0.76rem;
    cursor: pointer;
  }
  .sopt-sm:hover {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .fs-undo {
    padding: 0.16rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: transparent;
    color: var(--dim);
    font-size: 0.68rem;
    cursor: pointer;
  }
  .fs-undo:hover { color: var(--text); border-color: var(--muted); }
  .s-req {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-top: 0.4rem;
    cursor: pointer;
  }
  .s-note { margin: 0; font-size: 0.68rem; color: #6ee7a8; line-height: 1.5; }
  .s-note.dim { color: var(--dim); }
  .s-err { margin: 0; font-size: 0.65rem; color: #ff6b6b; line-height: 1.5; }
  .s-warn { margin: 0; font-size: 0.65rem; color: #f0b47a; line-height: 1.5; }
  .warn { color: #f0b47a; }
  /* The three moves of the few-shot branch, numbered — the order is the point. */
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
  .note { margin: 0; font-size: 0.62rem; color: var(--dim); line-height: 1.4; }
  .kprow { align-items: flex-start; }
  .ksum { flex: none; font-size: 0.66rem; color: var(--dim); font-variant-numeric: tabular-nums; }
  .chips { display: flex; flex-wrap: wrap; gap: 0.3rem; flex: 1 1 14rem; }
  /* Off is the LOUD state here: an un-embedded keypoint is one nothing will be known about, which is
     easier to miss than an extra one selected. */
  .kchip {
    font-size: 0.72rem; padding: 0.28rem 0.6rem; min-height: 1.6rem; cursor: pointer;
    border: 1px dashed var(--border); border-radius: 5px;
    background: transparent; color: var(--dim); text-decoration: line-through;
  }
  .kchip.on {
    border-style: solid; text-decoration: none;
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
    background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent);
  }
  .kchip:disabled { opacity: 0.5; cursor: default; }
  .note b { color: var(--muted); font-weight: 600; }

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

  .results { border-top: 1px solid var(--border); padding-top: 0.7rem; }
  .pane { display: flex; flex-direction: column; gap: 0.5rem; }
</style>
