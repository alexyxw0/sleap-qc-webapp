<script>
  import { colorFor } from "../draw.js";
  import { store } from "../labelsStore.svelte.js";
  import { edit } from "../editStore.svelte.js";
  import { view } from "../viewStore.svelte.js";
  import { qc, heatColor, hasFrameIssue } from "../qcStore.svelte.js";
  import FrameGrid from "./FrameGrid.svelte";
  import SkeletonEditor from "./SkeletonEditor.svelte";
  import QcChecks from "./QcChecks.svelte";
  import { ui } from "../uiStore.svelte.js";
  import { untrack } from "svelte";

  // THE CONTENT PANEL. Deliberately separate from the tab SELECTOR (RailTabs.svelte): the selector is a
  // hover strip that comes and goes, while this panel stays docked for as long as a section is open. It
  // knows nothing about hovering — only which block is active.
  const TITLE = Object.fromEntries(ui.constructor.BLOCKS.map((b) => [b.id, b.title]));

  // Click a flagged problem -> select its faulty node(s) and zoom the canvas to them.
  function focusFaulty(instIdx) {
    const item = store.current;
    const t = qc.faultyTarget(item, instIdx);
    if (!t) return;
    edit.select(instIdx, t.primary >= 0 ? t.primary : 0); // -1 = no standout node (GMM density flag)
    view.requestFocus(t.box);
  }

  // Left-edge resize: drag changes the rail width (clamped in the store).
  function startResize(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const w0 = ui.railW;
    const move = (ev) => ui.setRailW(w0 + (sx - ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }


  // Reactive summaries — recomputed when the model revision changes.
  const labels = $derived(store.labels);
  const skeleton = $derived(store.skeleton);
  const item = $derived(store.current);

  const totals = $derived.by(() => {
    edit.structRev; // recompute on add/remove instance + file load (store.labels) — NOT on node-drags
    const L = store.labels;
    if (!L) return null;
    let instances = 0;
    for (const lf of L.labeledFrames) instances += lf.instances?.length ?? 0;
    return {
      videos: L.videos?.length ?? 0,
      skeletons: L.skeletons?.length ?? 0,
      tracks: L.tracks?.length ?? 0,
      labeledFrames: L.labeledFrames?.length ?? 0,
      instances,
    };
  });

  const videoShape = $derived.by(() => {
    const v = item?.video ?? store.labels?.videos?.[0];
    const s = v?.shape;
    return Array.isArray(s) ? { n: s[0], h: s[1], w: s[2], c: s[3] } : null;
  });

  // Minimal by default: the full stats table and per-instance point lists are opt-in.
  let moreStats = $state(false);
  let featDetailOpen = $state(false); // expand the statistical flag chips → top driving features
  let allChecksOpen = $state(false); // opt-in "all checks" detail — every enabled detector's status
  let expanded = $state(new Set()); // expanded instance indices — the chevron is the source of truth
  const isOpen = (i) => expanded.has(i);
  function toggleOpen(i) {
    const s = new Set(expanded);
    if (s.has(i)) s.delete(i);
    else s.add(i);
    expanded = s;
  }
  // Collapse expansions when navigating to another frame.
  $effect(() => {
    void store.index;
    expanded = new Set();
  });
  // Auto-expand the selected instance so its points show on select — but re-seed ONLY when the
  // selection changes (untracked read of `expanded`), so the chevron can still collapse it after.
  $effect(() => {
    const sel = edit.selInstance;
    untrack(() => {
      if (sel >= 0 && !expanded.has(sel)) expanded = new Set(expanded).add(sel);
    });
  });

  // Reactive snapshot of the current frame's instances/points — recomputes on every
  // edit (store.rev) so coordinates/visibility update live, without re-mounting the DOM.
  const panel = $derived.by(() => {
    store.rev;
    const lf = store.current?.lf;
    const names = store.skeleton?.nodeNames ?? [];
    if (!lf) return [];
    return lf.instances.map((inst, i) => ({
      i,
      // Ask draw.js rather than mirroring its palette: it colours by TRACK, so a copied
      // index-based fallback made the sidebar dot disagree with the canvas on any tracked file.
      color: colorFor(inst, i),
      track: inst.track?.name ?? null,
      score: inst.score,
      points: (inst.points ?? []).map((p, j) => ({
        j,
        name: names[j] ?? j,
        x: p.xy?.[0],
        y: p.xy?.[1],
        score: typeof p.score === "number" ? p.score : null, // per-keypoint confidence (predicted only)
        visible: p.visible,
        placed: p.xy?.[0] != null && !Number.isNaN(p.xy?.[0]),
      })),
    }));
  });
</script>

{#if ui.activeBlock}
<!-- Docked, in-flow: opening a section resizes the viewer rather than covering it, and it PERSISTS after
     the selector hides. Closing is explicit (this header's ✕, or the tab again). -->
<aside class="panel" style:width="{ui.railW}px" style:flex="0 0 {ui.railW}px">
  <div class="rz" onpointerdown={startResize} title="Drag to resize"></div>
  <div class="scroll">
  <header class="head">
    <div class="title">{TITLE[ui.activeBlock] ?? ""}</div>
    <button class="ghost" onclick={() => ui.collapseAll()} title="Close this panel">✕</button>
  </header>



  
  <!-- Tab strip: panels docked here show one at a time; drag a panel's grip up to dock it. -->
  {#if store.error}
    <p class="err side-section">{store.error}</p>
  {/if}

  <!-- Discrete frame selector — part of the Main view: not draggable, never its own tab,
       and only shown on Main (not stacked on top of every docked tab). -->

<!-- Block CONTENT lives in snippets so the tab stack renders first and exactly ONE body is
     rendered into the slate below. Not accordions: expanding several in place is what made the
     old rail a scroll-forever wall. -->
{#snippet frameBody()}
    <FrameGrid />

  <!-- QC results for the current frame — one verdict line + issues only when present -->
  {#if qc.hasResults}
    {@const fq = qc.frameQC(item)}
    {@const fs = qc.frameScore(item)}
    {@const ti = qc.frameTopIssue(item)}
    {@const flagged = qc.frameFlagged(item)}
    {@const dets = qc.frameDetectorDetails(item)}
    <section
      class="side-section"
      title="Anomaly = geometrically unusual vs. the rest of this file. Confidence = the model's own per-keypoint certainty. Both are review hints, not certain errors."
    >
      <div class="qcrow">
        <span class="qframe-lbl">frame{qc.stale ? " · stale" : ""}</span>
        {#if fs != null}
          <span class="qchip" style:background={heatColor(fs)}>{fs.toFixed(2)}</span>
        {/if}
        {#if flagged && ti?.worstNode >= 0}
          <button
            class="verdict flagged faulty"
            onclick={() => focusFaulty(qc.frameWorstInstance(item))}
            title="Zoom to the faulty node"
          >
            {ti.issue ?? "frame issue"} · {ti.worstNodeName}<span class="zico">⤢</span>
          </button>
        {:else}
          <span class="verdict" class:flagged>
            {#if flagged}
              {ti?.issue ?? "frame issue"}{ti?.worstNodeName ? ` · ${ti.worstNodeName}` : ""}
            {:else}
              looks ok
            {/if}
          </span>
        {/if}
      </div>
      {#if flagged}
        {@const flaggers = qc.frameFlaggingChecks(item)}
        {#if flaggers.length}
          <div class="flaggers">
            {#each flaggers as f (f.key)}
              {#if f.key === "anomaly" || f.key === "gmm"}
                <button type="button" class="ftag stat" class:open={featDetailOpen} onclick={() => (featDetailOpen = !featDetailOpen)} title="Show the features driving this flag">
                  {f.label}{#if f.score != null}<i class="fscore">{f.score.toFixed(2)}</i>{/if}<span class="fchev" class:open={featDetailOpen}>▸</span>
                </button>
              {:else}
                <span class="ftag" class:structural={f.score == null} title="Flagged by {f.label}{f.score != null ? ` · ${f.score.toFixed(2)}` : ' · structural (no threshold)'}">
                  {f.label}{#if f.score != null}<i class="fscore">{f.score.toFixed(2)}</i>{/if}
                </span>
              {/if}
            {/each}
          </div>
          {#if featDetailOpen}
            {@const top = qc.frameTopFeatures(item, 5)}
            {#if top.length}
              <ul class="fdrivers">
                {#each top as t (t.feature)}
                  <li>
                    <span class="fdname" title={t.feature}>{t.feature.replace(/_zscore$/, "").replace(/_/g, " ")}</span>
                    <span class="fdz" class:hi={t.z > 0} title="{t.z.toFixed(2)} std deviations {t.z > 0 ? 'above' : 'below'} the norm">{t.z > 0 ? "↑" : "↓"} {Math.abs(t.z).toFixed(1)}σ</span>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="fdnote">Feature breakdown needs the Anomaly check on.</p>
            {/if}
          {/if}
        {/if}
      {/if}
      {#if hasFrameIssue(fq)}
        <ul class="issues">
          {#if fq.isWrongCount}<li>{fq.isEmpty ? "empty frame — no instances" : `${fq.actualInstanceCount} / ${fq.expectedInstanceCount} expected instances (${fq.isOvercount ? "extra" : "missing"})`}</li>{/if}
          {#if fq.isSparse}<li>sparse instance — only {fq.minVisibleNodeCount} visible node{fq.minVisibleNodeCount === 1 ? "" : "s"}</li>{/if}
          {#if fq.isLowConf}<li>low keypoint confidence — {qc.confidenceMode === "avg" ? `mean ${fq.avgPointScore.toFixed(2)}` : `weakest ${fq.minPointScore.toFixed(2)}`}</li>{/if}
          {#if fq.isLowInstConf}<li>low instance confidence — score {fq.minInstScore.toFixed(2)}</li>{/if}
          {#if fq.isNegativeWithInstances}<li>negative frame has instances</li>{/if}
          {#if fq.duplicatePairs?.length}<li>{fq.duplicatePairs.length} duplicate pair(s): {fq.duplicateReasons.join(", ")}</li>{/if}
        </ul>
      {/if}
      {#if dets.length}
        <button type="button" class="allchk-btn" onclick={() => (allChecksOpen = !allChecksOpen)} aria-expanded={allChecksOpen} title="Per-frame status of every enabled check">
          <span class="achev" class:open={allChecksOpen}>▸</span> all checks · {dets.length}
        </button>
        {#if allChecksOpen}
          <ul class="allchk">
            {#each dets as d (d.key)}
              <li class:on={d.flagged} title="{d.flagged ? 'flagged' : 'passed'}{d.score != null ? ` · ${d.score.toFixed(2)} vs ${d.lowerIsWorse ? 'min' : 'max'} ${d.threshold.toFixed(2)}` : d.detail ? ` · ${d.detail}` : ''}">
                <span class="ac-dot" class:on={d.flagged}></span>
                <span class="ac-name">{d.label}</span>
                <span class="ac-val">{#if d.score != null}<b>{d.score.toFixed(2)}{d.unit ?? ""}</b><span class="ac-thr">· {d.threshold.toFixed(2)}</span>{:else}{d.detail ?? ""}{/if}</span>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </section>
  {/if}

{/snippet}

{#snippet checksBody()}
    <QcChecks mode="geometry" />
{/snippet}

{#snippet appearanceBody()}
    <QcChecks mode="appearance" />
{/snippet}

{#snippet analysisBody()}
    <QcChecks mode="analysis" />
{/snippet}

{#snippet fileBody()}
    <section class="side-section">
    <div class="fhead">
      <h3 class="side-h">File</h3>
      <button class="more" onclick={() => (moreStats = !moreStats)}>{moreStats ? "less" : "more"}</button>
    </div>
    {#if totals}
      <p class="fsummary">{totals.labeledFrames} frames · {totals.instances} instances</p>
    {/if}
    {#if moreStats}
      <dl>
        {#if videoShape}
          <dt>Resolution</dt>
          <dd>{videoShape.w} × {videoShape.h}</dd>
          <dt>Video frames</dt>
          <dd>{videoShape.n ?? "—"}</dd>
        {/if}
        {#if totals}
          <dt>Tracks</dt>
          <dd>{totals.tracks}</dd>
          <dt>Videos</dt>
          <dd>{totals.videos}</dd>
          <dt>Skeletons</dt>
          <dd>{totals.skeletons}</dd>
        {/if}
        <dt>Source</dt>
        <dd>{store.hasEmbedded ? "embedded (.pkg.slp)" : store.videoModel ? store.videoName : "external video"}</dd>
      </dl>
    {/if}
  </section>

  <!-- Skeleton editor (nodes + edges) -->
  {#if skeleton}
    <SkeletonEditor />
  {/if}
{/snippet}

{#snippet instancesBody()}
  <section class="side-section grow">
    <div class="ihead">
      <h3 class="side-h">This frame · {panel.length} instance{panel.length === 1 ? "" : "s"}</h3>
      <button class="addbtn" onclick={() => edit.addInstance()}>＋ Instance</button>
    </div>
    {#if panel.length}
      {#each panel as inst (inst.i)}
        {@const qs = qc.hasResults ? qc.instanceScore(item, inst.i) : null}
        {@const gs = qc.hasResults && qc.checks.gmm ? qc.gmmScore(item, inst.i) : null}
        {@const open = isOpen(inst.i)}
        <div class="inst" class:sel={inst.i === edit.selInstance}>
          <div class="inst-head">
            <button class="chev" class:open onclick={() => toggleOpen(inst.i)} title={open ? "Hide points" : "Show points"}>
              ▸
            </button>
            <button class="selbtn" onclick={() => edit.select(inst.i, 0)} title="Select instance">
              <span class="dot" style:background={inst.color}></span>
              #{inst.i}
              {inst.track ? `· ${inst.track}` : "· untracked"}
            </button>
            {#if qs != null}
              <span class="qchip sm" style:background={heatColor(qs)} title="QC anomaly score">{qs.toFixed(2)}</span>
            {/if}
            {#if gs != null && gs >= qc.gmmThreshold}
              <span class="qchip sm" style:background={heatColor(gs)} title="GMM probability anomaly">G {gs.toFixed(2)}</span>
            {/if}
            {#if inst.score != null}
              <span class="qchip sm" style:background={heatColor(1 - inst.score)} title="Instance confidence (PredictedInstance.score)">c {inst.score.toFixed(2)}</span>
            {/if}
            <button class="del" onclick={() => edit.deleteInstance(inst.i)} title="Delete instance">×</button>
          </div>
          {#if qc.instanceFlagged(item, inst.i)}
            {@const ii = qc.instanceIssue(item, inst.i)}
            {#if ii?.worstNode >= 0}
              <button class="qcissue faulty" onclick={() => focusFaulty(inst.i)} title="Zoom to the faulty node">
                {ii.issue} · {ii.worstNodeName}<span class="zico">⤢</span>
              </button>
            {:else}
              <div class="qcissue">{ii?.issue}{ii?.worstNodeName ? ` · ${ii.worstNodeName}` : ""}</div>
            {/if}
          {/if}
          {#if open}
            <div class="pts">
              {#each inst.points as p (p.j)}
                <button
                  class="pt"
                  class:hidden={!p.visible}
                  class:psel={inst.i === edit.selInstance && p.j === edit.selNode}
                  onclick={() => edit.select(inst.i, p.j)}
                  ondblclick={() => edit.toggleVisible(inst.i, p.j)}
                  title="{p.placed ? `(${p.x.toFixed(0)}, ${p.y.toFixed(0)}) · ` : ''}click to select · double-click to show/hide"
                >
                  <span class="pname">{p.name}</span>
                  <span class="pxy" title="Keypoint confidence">
                    {p.score != null ? p.score.toFixed(2) : "—"}
                    <i class="vis" class:on={p.visible}></i>
                  </span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    {:else}
      <p class="muted">No instances on this frame. Use ＋ Instance to add one.</p>
    {/if}
  </section>
{/snippet}


  <!-- The slate: one body at a time, or nothing. -->
  <div class="slate">
    {#if ui.activeBlock === "frame"}{@render frameBody()}{@render instancesBody()}{@render fileBody()}
    {:else if ui.activeBlock === "checks"}{@render checksBody()}
    {:else if ui.activeBlock === "appearance"}{@render appearanceBody()}
    {:else if ui.activeBlock === "analysis"}{@render analysisBody()}
    {/if}
  </div>
</aside>
{/if}

<style>
  /* ---- docked content panel -----------------------------------------------------------------------
     In-flow (not fixed): opening a section resizes the viewer rather than covering it, and the panel
     PERSISTS after the hover selector hides. The selector (RailTabs) overlays this at a higher z-index. */
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--panel, #12161b);
    border-left: 1px solid var(--border);
    position: relative;
  }
  /* The slate holds exactly one section body — the {#if}/{:else if} chain makes that structural. */
  .slate { flex: 1 1 auto; min-height: 0; }

  /* Right rail: docked inspector, one tone above the well, resizable from its
     left edge. The handle sits outside the inner scroller so it never scrolls away. */
  .scroll {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .rz {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 7px;
    cursor: ew-resize;
    z-index: 3;
  }
  .rz::after {
    content: "";
    position: absolute;
    left: 2px;
    top: 50%;
    height: 44px;
    width: 3px;
    transform: translateY(-50%);
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.18);
    opacity: 0;
    transition: opacity 0.15s;
  }
  .rz:hover::after {
    opacity: 1;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.85rem 1.1rem;
  }
  .title {
    flex: 1;
    font-weight: 600;
    font-size: 0.8rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    letter-spacing: 0.02em;
  }
  .ghost {
    background: none;
    border: none;
    color: var(--dim);
    border-radius: var(--r-xs);
    width: 1.6rem;
    height: 1.6rem;
    font-size: 0.75rem;
    cursor: pointer;
    transition: color 0.12s, background 0.12s;
  }
  .ghost:hover {
    color: var(--danger);
    background: rgba(251, 113, 133, 0.08);
  }
  .grow {
    flex: 1;
    min-height: 120px;
  }
  dl {
    margin: 0;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.18rem 0.85rem;
    font-size: 0.8rem;
  }
  dt {
    color: var(--dim);
  }
  dd {
    margin: 0;
    text-align: right;
    color: #c3cedb;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .muted {
    color: var(--muted);
    font-size: 0.82rem;
    margin: 0.25rem 0 0;
  }
  .fhead {
    display: flex;
    align-items: baseline;
    gap: 0.55rem;
  }
  .fhead .side-h {
    margin: 0;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .more {
    flex: none;
    background: none;
    border: none;
    padding: 0;
    font-size: 0.7rem;
    color: var(--dim);
    cursor: pointer;
    transition: color 0.12s;
  }
  .more:hover {
    color: var(--accent);
  }
  .fsummary {
    margin: 0.35rem 0 0;
    font-size: 0.8rem;
    color: #c3cedb;
    font-variant-numeric: tabular-nums;
  }
  .fsummary + dl {
    margin-top: 0.45rem;
  }
  .chev {
    background: none;
    border: none;
    padding: 0 0.1rem;
    color: var(--dim);
    font-size: 0.66rem;
    cursor: pointer;
    flex: none;
    transition: transform 0.15s var(--ease), color 0.12s;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .chev:hover {
    color: var(--text);
  }
  .err {
    color: #fda4af;
    font-size: 0.82rem;
    margin: 0;
  }
  .qcrow {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  /* compact inline cue replacing the old "QC — this frame" header */
  .qframe-lbl {
    flex: none;
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--dim);
  }
  .verdict {
    flex: 1;
    min-width: 0;
    font-size: 0.82rem;
    line-height: 1.45;
    color: #9cb8a6;
  }
  .verdict.flagged {
    color: #e7c08a;
    font-weight: 600;
  }
  .qchip {
    color: #04181d;
    font-weight: 700;
    border-radius: var(--r-xs);
    padding: 0.06rem 0.4rem;
    font-size: 0.72rem;
    flex: none; /* score badges keep their size; never shrink/clip the number */
  }
  .qchip.sm {
    font-size: 0.66rem;
    padding: 0.02rem 0.28rem;
  }
  .issues {
    margin: 0.45rem 0 0;
    padding-left: 1rem;
    font-size: 0.76rem;
    color: #d9b25c;
    line-height: 1.5;
  }
  /* "what's flagging this frame": one badge per enabled check that fired. */
  .flaggers {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-top: 0.45rem;
  }
  .ftag {
    display: inline-flex;
    align-items: center;
    gap: 0.28rem;
    font-size: 0.68rem;
    color: #e7c08a; /* score-based checks (tunable via a threshold) */
    border: 1px solid rgba(231, 192, 138, 0.4);
    border-radius: var(--r-xs);
    padding: 0.04rem 0.36rem;
    letter-spacing: 0.01em;
    white-space: nowrap;
  }
  /* threshold-less structural checks (count / negative / duplicates) — distinct cool hue. */
  .ftag.structural {
    color: #a5b4fc;
    border-color: rgba(165, 180, 252, 0.4);
  }
  .ftag .fscore {
    color: var(--dim);
    font-style: normal;
    font-variant-numeric: tabular-nums;
  }
  button.ftag {
    background: none;
    cursor: pointer;
    font-family: inherit;
  }
  button.ftag:hover {
    border-color: var(--accent);
  }
  .fchev {
    font-size: 0.5rem;
    color: var(--dim);
    transition: transform 0.15s var(--ease);
  }
  .fchev.open {
    transform: rotate(90deg);
  }
  .fdrivers {
    list-style: none;
    margin: 0.4rem 0 0;
    padding: 0;
    display: grid;
    gap: 0.14rem;
  }
  .fdrivers li {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.7rem;
  }
  .fdname {
    color: var(--muted);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fdz {
    color: #93c5fd; /* below the fitted norm */
    font-variant-numeric: tabular-nums;
    flex: none;
  }
  .fdz.hi {
    color: #fca5a5; /* above the fitted norm */
  }
  .fdnote {
    margin: 0.35rem 0 0;
    font-size: 0.68rem;
    color: var(--dim);
  }
  .allchk-btn {
    background: none;
    border: none;
    margin: 0.5rem 0 0;
    padding: 0;
    color: var(--dim);
    font-size: 0.68rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.28rem;
  }
  .allchk-btn:hover {
    color: var(--accent);
  }
  .achev {
    font-size: 0.5rem;
    transition: transform 0.15s var(--ease);
  }
  .achev.open {
    transform: rotate(90deg);
  }
  .allchk {
    list-style: none;
    margin: 0.3rem 0 0;
    padding: 0;
    display: grid;
    gap: 0.16rem;
  }
  .allchk li {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.42rem;
    font-size: 0.7rem;
    color: var(--muted);
  }
  .allchk li.on {
    color: #e7c08a;
  }
  .ac-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #39414f; /* passed */
    flex: none;
  }
  .ac-dot.on {
    background: #fb7185; /* flagged */
  }
  .ac-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ac-val {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .ac-val .ac-thr {
    color: var(--dim);
    margin-left: 0.25rem;
    font-weight: 400;
  }
  .ihead {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    margin-bottom: 0.4rem;
  }
  .ihead .side-h {
    margin: 0;
    flex: 1;
    min-width: 0; /* shrink + ellipsize instead of shoving the +Instance button off-edge */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .addbtn {
    background: none;
    border: 1px solid var(--border);
    color: var(--accent);
    border-radius: var(--r-xs);
    padding: 0.16rem 0.5rem;
    font-size: 0.7rem;
    cursor: pointer;
    white-space: nowrap;
    flex: none; /* never shrink the button */
    transition: background 0.12s, border-color 0.12s;
  }
  .addbtn:hover {
    background: rgba(95, 217, 242, 0.07);
    border-color: rgba(95, 217, 242, 0.4);
  }
  .inst {
    border-top: 1px solid var(--border-soft);
    padding: 0.45rem 0.3rem 0.3rem;
    border-radius: 6px;
  }
  .inst:first-of-type {
    border-top: none;
  }
  .inst.sel {
    background: rgba(95, 217, 242, 0.05);
    box-shadow: inset 0 0 0 1px rgba(95, 217, 242, 0.3);
  }
  .inst-head {
    font-size: 0.8rem;
    color: #cdd7e3;
    margin-bottom: 0.35rem;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .selbtn {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    padding: 0.1rem;
    border-radius: 5px;
  }
  .selbtn:hover {
    color: #fff;
  }
  .del {
    background: none;
    border: none;
    color: var(--dim);
    border-radius: 5px;
    padding: 0 0.4rem;
    cursor: pointer;
    line-height: 1.4;
  }
  .del:hover {
    color: #fda4af;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    display: inline-block;
    flex: none;
  }
  .qcissue {
    font-size: 0.72rem;
    color: #9fb0c3;
    margin: -0.1rem 0 0.2rem 1.3rem;
  }
  /* a flagged problem that is clickable to zoom in on its faulty node(s).
     Inline text flow (not inline-flex) so a long "issue · node" wraps to a second
     line instead of clipping mid-word against the rail edge. */
  .faulty {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .faulty:hover {
    text-decoration: underline;
  }
  .zico {
    margin-left: 0.3rem;
    opacity: 0.5;
    font-size: 0.85em;
    white-space: nowrap;
  }
  .faulty:hover .zico {
    opacity: 1;
    color: var(--accent);
  }
  .pts {
    display: grid;
    gap: 0.1rem;
  }
  .pt {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
    background: none;
    border: 1px solid transparent;
    border-radius: 5px;
    color: inherit;
    padding: 0.12rem 0.35rem;
    cursor: pointer;
    text-align: left;
  }
  .pt:hover {
    background: rgba(255, 255, 255, 0.03);
  }
  .pt.hidden {
    opacity: 0.45;
  }
  .pt.psel {
    border-color: var(--accent);
    background: rgba(95, 217, 242, 0.07);
  }
  .pname {
    color: var(--muted);
    min-width: 0; /* a long node name ellipsizes instead of pushing the score off-row */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pxy {
    color: #d7dee8;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    flex: none;
  }
  .vis {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: 1px solid #45526a;
    display: inline-block;
  }
  .vis.on {
    background: #86efac;
    border-color: #86efac;
  }
  .head {
    order: -10; /* the file header stays pinned above the blocks */
  }
</style>
