<script>
  import { store } from "../labelsStore.svelte.js";
  import { edit } from "../editStore.svelte.js";
  import { view } from "../viewStore.svelte.js";
  import { qc, heatColor, hasFrameIssue } from "../qcStore.svelte.js";
  import FrameGrid from "./FrameGrid.svelte";
  import SkeletonEditor from "./SkeletonEditor.svelte";
  import QcChecks from "./QcChecks.svelte";
  import { ui } from "../uiStore.svelte.js";

  // Drag-to-tab: each panel carries a grip; dragging it onto the tab strip docks it as a tab.
  const PANEL_TITLE = { frames: "Frames", checks: "Checks", file: "File" };
  let draggingPanel = $state(null); // the panel being dragged (drives the tab-strip highlight + ghost)
  let ghostX = $state(0), ghostY = $state(0); // floating drag-ghost position (follows the cursor)
  // Pointer-based drag — native HTML5 drag (draggable/dragstart) proved unreliable in this app.
  // Press a grip, move past a small threshold to begin, release over the tab strip to dock the panel.
  let dragId = null, dragSX = 0, dragSY = 0, dragMoved = false;
  function gripDown(e, pid) {
    if (e.button !== 0) return;
    dragId = pid; dragSX = e.clientX; dragSY = e.clientY; dragMoved = false;
    ghostX = e.clientX; ghostY = e.clientY;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function gripMove(e) {
    if (dragId === null) return;
    ghostX = e.clientX; ghostY = e.clientY;
    if (!dragMoved && Math.hypot(e.clientX - dragSX, e.clientY - dragSY) > 5) { dragMoved = true; draggingPanel = dragId; }
  }
  function gripUp(e) {
    const id = dragId, moved = dragMoved;
    dragId = null; dragMoved = false; draggingPanel = null;
    try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    if (id !== null && moved && document.elementFromPoint(e.clientX, e.clientY)?.closest(".sidebar-tabs")) ui.dockPanel(id);
  }

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

  const PALETTE = [
    "#f3c56c", "#7dd3fc", "#a7f3d0", "#fda4af", "#c4b5fd",
    "#fca5a5", "#93c5fd", "#86efac", "#f0abfc", "#fdba74",
  ];
  // Mirror of draw.js fallback coloring for the per-instance dot.
  const dotColor = (i) => PALETTE[i % PALETTE.length];

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
  let expanded = $state(new Set()); // manually expanded instance indices
  const isOpen = (i) => expanded.has(i) || edit.selInstance === i;
  function toggleOpen(i) {
    const s = new Set(expanded);
    if (s.has(i)) s.delete(i);
    else s.add(i);
    expanded = s;
  }
  // Collapse manual expansions when navigating to another frame.
  $effect(() => {
    void store.index;
    expanded = new Set();
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

<aside class="sidebar" style:width="{ui.railW}px" style:flex="0 0 {ui.railW}px">
  {#if draggingPanel}
    <div class="drag-ghost" style:left="{ghostX}px" style:top="{ghostY}px">⠿ {PANEL_TITLE[draggingPanel] ?? draggingPanel}</div>
  {/if}
  <div class="rz" onpointerdown={startResize} title="Drag to resize"></div>
  <div class="scroll">
  <header class="head">
    <span class="filedot"></span>
    <div class="title" title={store.fileName}>{store.fileName}</div>
    <button class="ghost" onclick={() => store.reset()} title="Close file">✕</button>
  </header>

  {#snippet grip(pid)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="panel-grip"
      onpointerdown={(e) => gripDown(e, pid)}
      onpointermove={gripMove}
      onpointerup={gripUp}
      title="Drag up to the tab strip to make {PANEL_TITLE[pid] ?? pid} a tab"
    ><span class="gdots">⠿</span><span class="ghint">drag {PANEL_TITLE[pid] ?? pid} to a tab</span></div>
  {/snippet}

  <!-- Tab strip: panels docked here show one at a time; drag a panel's grip up to dock it. -->
  {#if ui.sidebarDocked.length || draggingPanel}
    <div class="sidebar-tabs" class:armed={draggingPanel}>
      {#each ui.sidebarDocked as id (id)}
        <span class="stab" class:on={ui.sidebarActiveTab === id}>
          <button class="stab-lbl" onclick={() => ui.activateSidebarTab(id)}>{PANEL_TITLE[id] ?? id}</button>
          <button class="stab-x" onclick={() => ui.undockPanel(id)} title="Restore inline">×</button>
        </span>
      {/each}
      {#if draggingPanel && !ui.isDocked(draggingPanel)}<span class="th">＋ drop to tab</span>{/if}
    </div>
  {/if}

  {#if store.error}
    <p class="err side-section">{store.error}</p>
  {/if}

  <!-- Discrete frame selector -->
  <div class="panel" data-pid="frames" class:docked={ui.isDocked("frames")} class:active={ui.sidebarActiveTab === "frames"}>
    {@render grip("frames")}
    <FrameGrid />
  </div>

  <!-- QC results for the current frame — one verdict line + issues only when present -->
  {#if qc.hasResults}
    {@const fq = qc.frameQC(item)}
    {@const fs = qc.frameScore(item)}
    {@const ti = qc.frameTopIssue(item)}
    {@const flagged = qc.frameFlagged(item)}
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
              <span class="ftag" class:structural={f.score == null} title="Flagged by {f.label}{f.score != null ? ` · ${f.score.toFixed(2)}` : ' · structural (no threshold)'}">
                {f.label}{#if f.score != null}<i class="fscore">{f.score.toFixed(2)}</i>{/if}
              </span>
            {/each}
          </div>
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
    </section>
  {/if}

  <!-- Detection checks: toggle each technique; flagged set = union of the enabled ones -->
  <div class="panel" data-pid="checks" class:docked={ui.isDocked("checks")} class:active={ui.sidebarActiveTab === "checks"}>
    {@render grip("checks")}
    <QcChecks />
  </div>

  <!-- File panel: file stats + skeleton + this-frame instances, merged into one dockable panel -->
  <div class="panel panel-grow" data-pid="file" class:docked={ui.isDocked("file")} class:active={ui.sidebarActiveTab === "file"}>
    {@render grip("file")}
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

  <!-- Current-frame instances (interactive) -->
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
              <span class="dot" style:background={dotColor(inst.i)}></span>
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
  </div>
  </div>
</aside>

<style>
  /* Right rail: docked inspector, one tone above the well, resizable from its
     left edge. The handle sits outside the inner scroller so it never scrolls away. */
  .sidebar {
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border-left: 1px solid var(--border);
  }
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
  .filedot {
    width: 6px;
    height: 6px;
    background: var(--good);
    flex: none;
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
  }
  .more {
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
  .ihead {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    margin-bottom: 0.4rem;
  }
  .ihead .side-h {
    margin: 0;
    flex: 1;
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
  }
  .pxy {
    color: #d7dee8;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
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
  /* --- drag-to-tab: dock sidebar panels into a tab strip at the top --- */
  .head {
    order: -10; /* keep the file header pinned above the tab strip + any docked panel */
  }
  .sidebar-tabs {
    order: -2;
    position: sticky; /* stay reachable as a drop target while the panels scroll */
    top: 0;
    z-index: 6;
    background: var(--surface);
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end; /* browser-style: tabs sit on the bottom line */
    gap: 2px;
    padding: 0.32rem 0.4rem 0;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .drag-ghost {
    position: fixed;
    z-index: 1000;
    transform: translate(12px, 8px);
    pointer-events: none;
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: var(--r-xs);
    padding: 0.2rem 0.5rem;
    font-size: 0.72rem;
    letter-spacing: 0.04em;
    color: var(--text);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    white-space: nowrap;
  }
  .sidebar-tabs.armed {
    background: rgba(95, 217, 242, 0.08);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .stab {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 7px 7px 0 0; /* rounded top corners, like a browser tab */
    background: rgba(0, 0, 0, 0.22); /* inactive tabs sit recessed */
    margin-bottom: -1px; /* overlap the strip's bottom border → connect the active tab to its content */
    overflow: hidden;
    opacity: 0.7;
    transition: opacity 0.12s, background 0.12s;
  }
  .stab:hover {
    opacity: 1;
  }
  .stab.on {
    background: var(--surface); /* active tab matches the content area below it */
    border-top: 2px solid var(--accent);
    opacity: 1;
  }
  .stab-lbl {
    background: none;
    border: none;
    color: var(--muted);
    font-size: 0.72rem;
    padding: 0.3rem 0.12rem 0.3rem 0.55rem;
    cursor: pointer;
  }
  .stab.on .stab-lbl {
    color: var(--text);
  }
  .stab-x {
    background: none;
    border: none;
    color: var(--dim);
    font-size: 0.82rem;
    line-height: 1;
    padding: 0.2rem 0.34rem;
    cursor: pointer;
  }
  .stab-x:hover {
    color: #fb7185;
  }
  .th {
    font-size: 0.66rem;
    color: var(--accent);
    letter-spacing: 0.02em;
  }
  .panel {
    position: relative;
    display: flex;
    flex-direction: column;
    /* NO min-height:0 here — that let panels shrink below their content and overlap the next one. */
  }
  .panel-grow {
    flex: 1; /* the File panel fills leftover rail space */
  }
  .panel-grip {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    height: 16px;
    padding: 0 0.5rem;
    cursor: grab;
    color: var(--muted);
    font-size: 0.62rem;
    letter-spacing: 0.16em;
    background: rgba(255, 255, 255, 0.03);
    border-bottom: 1px dashed var(--border);
    user-select: none;
    flex: none;
  }
  .panel-grip .ghint {
    font-size: 0.56rem;
    letter-spacing: 0.02em;
    opacity: 0;
    transition: opacity 0.12s;
  }
  .panel-grip:hover {
    color: var(--accent);
    background: rgba(95, 217, 242, 0.09);
    border-bottom-style: solid;
  }
  .panel-grip:hover .ghint {
    opacity: 0.85;
  }
  .panel-grip:active {
    cursor: grabbing;
  }
  .panel.docked:not(.active) {
    display: none;
  }
  .panel.docked.active {
    order: -1; /* a docked-and-active panel sits right under the tab strip */
    flex: none; /* content height, so the inline panels below stay visible */
  }
</style>
