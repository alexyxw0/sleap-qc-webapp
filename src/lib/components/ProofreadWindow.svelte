<script>
  // Proofreading: ONE frame at a time, in queue order, judged from the keyboard.
  //
  // The frame is drawn here rather than only in the main viewer because this window is where the pass
  // happens — you should not have to look somewhere else to see what you are judging. The keys are NOT
  // handled here: Viewer.onKey routes to framePass while this pane is up, so there is exactly one
  // listener and a keystroke can never fire twice.
  //
  // The queue is the point, so the window is GATED on it: with no run behind it there is no order to
  // present, and showing an arbitrary list of frames would quietly turn a targeted pass into a linear
  // read-through of the file. Until then the window shows only what to run.
  //
  // Ordering lives in qcStore.proofreadRanked (rank-normalized Anomaly / GMM / max_angle) — not here —
  // so the queue and the detector scores can't disagree.
  //
  // The Judge and Labels panes are still skeletons pending spec.
  import { store } from "../labelsStore.svelte.js";
  import { qc } from "../qcStore.svelte.js";
  import { keypointLabels } from "../keypointLabels.svelte.js";
  import { keypointModels } from "../keypointModels.svelte.js";
  import { proofread } from "../proofreadSession.svelte.js";
  import { proofreadWindow, PROOFREAD_TABS } from "../proofreadWindow.svelte.js";
  import { framePass } from "../framePass.svelte.js";
  import { edit } from "../editStore.svelte.js";
  import { drawScene, frameDims } from "../draw.js";
  import { fitScale, clampCenter, panForZoom, clampZoom } from "../qc/zoomView.js";
  import { keybinds, keyLabel } from "../keybinds.svelte.js";
  import { KEY_GROUP_HINTS } from "../qc/proofreadKeymap.js";
  import PopoutWindow from "./PopoutWindow.svelte";
  import WinTabs from "./WinTabs.svelte";

  const on = $derived(keypointLabels.proofreading);
  const ready = $derived(qc.proofreadReady);
  const ranked = $derived(ready ? qc.proofreadRanked : []);

  const cur = $derived(framePass.current);
  const item = $derived(framePass.item);
  const pos = $derived(framePass.at);
  const names = $derived(framePass.nodeNames);
  const faulty = $derived(framePass.faultySet);

  // Draw the queue's current frame at whatever size the window is.
  //
  // The auto-fit (whole frame, or the candidate's focus box) is the BASELINE; the user's zoom and pan
  // ride on top of it as a multiplier and an image-space offset. Keeping them separate is what lets
  // the view re-fit itself on every new candidate — which is the behaviour the pass needs, since each
  // one is a different animal in a different place — while still letting you lean in on the one in
  // front of you. Both reset when the candidate changes.
  let canvas = $state.raw(null);
  let uz = $state(1);        // user zoom, 1 = the auto-fit
  let upx = $state(0);       // user pan, image-space px
  let upy = $state(0);
  let drag = null;           // { sx, sy, px, py, moved }
  let lastFit = null;        // { s, view } from the most recent paint — pointer math needs it
  const MAX_UZ = 12;
  const resetView = () => { uz = 1; upx = 0; upy = 0; };
  let stage = $state.raw(null);
  let box = $state({ w: 0, h: 0 }); // measured, so the frame can CONTAIN-fit the space it is given
  let img = $state.raw(null);
  let imgFor = $state.raw(null); // the frame `img` is a picture OF
  let loading = $state(false);

  $effect(() => {
    const el = stage;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => { box = { w: el.clientWidth, h: el.clientHeight }; };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });

  // A new candidate is a new animal somewhere else in the frame: re-fit rather than leave the view
  // parked where the last one happened to be.
  $effect(() => { void framePass.at; void framePass.instIdx; void whole; resetView(); });

  $effect(() => {
    const it = item;
    if (!it) { img = null; imgFor = null; return; }
    let stale = false;
    loading = true;
    // Publish the picture and the frame it depicts TOGETHER — the draw effect refuses to paint a
    // mismatched pair, which is what stops the pose arriving before the image.
    // A FAILED decode must still publish the pair. The draw effect refuses to paint while imgFor !== it,
    // so an unsettled load strands the canvas on the previous frame with "decoding…" stuck on. A null
    // image is fine — drawScene falls back to its placeholder.
    store.getFrameImage(it).catch(() => null)
      .then((r) => { if (!stale) { img = r ?? null; imgFor = it; loading = false; } });
    // Warm the next frame while this one is being judged — traversal should not wait on a decode.
    const nxt = store.frames?.[framePass.queue[pos + 1]?.i];
    if (nxt) store.getFrameImage(nxt).catch(() => {});
    return () => { stale = true; };
  });

  $effect(() => {
    const c = canvas, it = item;
    if (!c || !it) return;
    // NOT our picture yet: leave the last complete paint on the canvas rather than repainting the new
    // pose over the previous frame. Canvas keeps its pixels until something draws, so skipping here
    // means the swap happens once, with both halves at the same time.
    if (imgFor !== it) return;
    void store.rev;            // an edited pose must redraw
    void keypointLabels.rev;  // a new label must redraw its ring
    const fset = faulty, sel = edit.selInstance, selN = edit.selNode, image = img;
    const { w, h } = frameDims(it, image);
    // Clamp the crop to the image: a pose near an edge would otherwise pan the view off the picture.
    const fb = whole ? null : framePass.focusBox;
    const view = fb
      ? { x: Math.max(0, fb.x), y: Math.max(0, fb.y),
          w: Math.min(w, fb.x + fb.w) - Math.max(0, fb.x), h: Math.min(h, fb.y + fb.h) - Math.max(0, fb.y) }
      : { x: 0, y: 0, w, h };
    if (!(view.w > 0 && view.h > 0)) { view.x = 0; view.y = 0; view.w = w; view.h = h; }
    // CONTAIN-fit the measured stage, then apply the user's zoom. The canvas now fills the stage
    // rather than being sized to the fitted crop: at zoom > 1 there is more picture than window, and a
    // canvas shaped to the crop would simply overflow it.
    const bw = box.w || 640, bh = box.h || 420;
    const fit = fitScale({ w: bw, h: bh }, view);
    const z = clampZoom(uz, MAX_UZ);
    const sc = fit * z;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    c.width = Math.max(1, Math.round(bw * dpr));
    c.height = Math.max(1, Math.round(bh * dpr));
    c.style.width = `${Math.round(bw)}px`;
    c.style.height = `${Math.round(bh)}px`;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);

    // Centre of the visible region, in image space: the fitted view's centre, panned, then clamped so
    // the picture cannot be dragged off the window.
    const bx = view.x + view.w / 2, by = view.y + view.h / 2;
    const cx = clampCenter(bx + upx, bw / sc / 2, w);
    const cy = clampCenter(by + upy, bh / sc / 2, h);
    const k = sc * dpr;
    // bx/by = the fitted centre BEFORE the user's pan; the pointer math needs it to set an exact
    // pan rather than accumulate drift through the clamp.
    lastFit = { s: sc, fit, dpr, cx, cy, bw, bh, w, h, bx, by };

    drawScene(ctx, image, it, store.skeleton, {
      transform: { s: k, offX: (c.width / 2) - cx * k, offY: (c.height / 2) - cy * k },
      dims: { w, h },
      scale: 1 / k,
      selInstance: sel,
      selNode: selN,
      gtFaulty: fset,
    });
  });

  /** Zoom about the POINTER, so the thing you are looking at stays under the cursor. */
  function onWheel(e) {
    if (!lastFit) return;
    e.preventDefault();
    const f = lastFit;
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left - f.bw / 2;   // pointer offset from the canvas centre, CSS px
    const my = e.clientY - r.top - f.bh / 2;
    const nz = clampZoom(uz * (e.deltaY < 0 ? 1.15 : 1 / 1.15), MAX_UZ);
    if (nz === uz) return;
    const ns = f.fit * nz;
    upx = panForZoom(f.cx, f.bx, mx, f.s, ns);
    upy = panForZoom(f.cy, f.by, my, f.s, ns);
    uz = nz;
  }
  function onPointerDown(e) {
    if (uz <= 1) return;                        // nothing to pan at fit
    drag = { sx: e.clientX, sy: e.clientY, px: upx, py: upy, moved: false };
    canvas.setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e) {
    if (!drag || !lastFit) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 3) return;
    drag.moved = true;
    upx = drag.px - (e.clientX - drag.sx) / lastFit.s;
    upy = drag.py - (e.clientY - drag.sy) / lastFit.s;
  }
  function onPointerUp(e) { drag = null; canvas.releasePointerCapture?.(e.pointerId); }
  const zoomBy = (f) => { uz = clampZoom(uz * f, MAX_UZ); };

  const isFaulty = (ni) => faulty.has(`${framePass.instIdx}:${ni}`);
  // Only THIS animal's marks — the ✓/count belongs to a row, and judging one animal must not tick the
  // other one off.
  const mine = $derived(new Set([...faulty].filter((k) => k.startsWith(`${framePass.instIdx}:`))));
  // The frame's OWN index in the video — not its position in store.frames, which is what "frame N"
  // used to show. Also the next few rows, so the ranking is checkable at a glance rather than taken
  // on trust: consecutive queue positions should NOT be consecutive frame numbers.
  const frameNo = $derived(item?.frameIdx ?? -1);
  const upcoming = $derived(framePass.upcoming(6));
  const dist = $derived(ready ? qc.proofreadFlagCounts : null);
  // A QC re-run replaces the ranking wholesale. The cursor is just a number, so without this the pass
  // keeps pointing at the old run's row — the viewer sits on one frame while the digits judge another.
  // Cheap: proofreadRanked is memoized on the fitted models, so the identity changes once per run.
  let lastQueue = null;
  $effect(() => {
    const q = ready ? qc.proofreadRanked : null;
    if (q && q !== lastQueue) { lastQueue = q; framePass.resync(); }
  });
  const distMax = $derived(dist ? Math.max(1, ...Object.values(dist.per)) : 1);
  // Banded, because a bare number says nothing about whether 43 is bad. Thresholds are on the combined
  // the row's PERCENTILE in the queue — so "hot" means near the front here, not against some absolute
  // idea of faulty.
  const band = $derived(!cur ? "" : cur.score >= 0.95 ? "hot" : cur.score >= 0.75 ? "warm" : "cool");

  // Frame the FLAGGED ANIMAL, not the whole video frame: at 1024 px a mouse is a smudge, and the
  // question is always about one pose. `whole` is the escape hatch for when you need the surroundings.
  let whole = $state(false);
  const culprit = $derived(framePass.culpritNode);
  const verdict = $derived(item ? qc.proofreadVerdict(item, framePass.instIdx, cur?.by ?? "angle") : null);
  // "also" means OTHER detectors — anomaly/gmm already have their own chip, and repeating them
  // reads as two independent opinions when it is one.
  const alsoFlagging = $derived(
    item ? qc.frameFlaggingChecks(item).filter((f) => f.key !== "anomaly" && f.key !== "gmm") : [],
  );
  // Angle signals first, because they are the ones that decide the order.
  const SIGNALS = [
    ["angle", "max_angle", (v) => `z ${v.toFixed(1)}`],
    ["meanAngle", "mean_angle", (v) => `z ${v.toFixed(1)}`],
    ["anomaly", "Anomaly", (v) => v.toFixed(2)],
    ["gmm", "GMM", (v) => v.toFixed(2)],
    // Present only when the per-keypoint pass ran AnomalyDINO; null everywhere otherwise, which the
    // row renders as "—" and the ranking treats as no evidence either way.
    ["nodeDino", "AnomalyDINO", (v) => v.toFixed(2)],
  ];
  // Only the four the pass runs on. The other six were a reference card printed under every frame —
  // and now that Keybinds is a tab, a reference card is what that tab IS. The space buys a QC readout
  // you can actually read at a glance, which is the thing you look at on every single candidate.
  // Mirrors PF_PRIORITY_SIGNALS in qcStore: the signals that promote an animal ahead of the rest.
  const PRIORITY = new Set(["angle", "meanAngle", "nodeDino"]);
  const LEGEND_IDS = ["faulty", "clean", "next", "prev"];
  const KEYS = $derived(LEGEND_IDS.map((id) => keybinds.allEntries.find((e) => e.id === id)).filter(Boolean));

  // ---- keybind editor ----------------------------------------------------------------------------
  // Capture phase, so a keystroke meant for a binding never reaches the viewer's proofreading handler.
  // { id, key } — `key` set means "replace this one" (you clicked the keycap), null means "add another".
  let capturing = $state(null);
  let bindMsg = $state("");
  const capturingHere = (id, key = null) => capturing?.id === id && (capturing?.key ?? null) === key;
  $effect(() => {
    // The grabber is PANE-scoped but this effect is component-scoped: leaving the tab or closing the
    // window unmounts the "press a key…" chip without unmounting us, so they have to disarm it — else
    // the capture listener stays installed and swallows the next keystroke anywhere in the app.
    if (!proofreadWindow.open || proofreadWindow.tab !== "keys") { capturing = null; bindMsg = ""; return; }
    if (!capturing) return;
    const { id, key } = capturing;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { capturing = null; bindMsg = ""; return; }
      bindMsg = (key ? keybinds.replaceKey(id, key, e.key) : keybinds.addKey(id, e.key)) ?? "";
      capturing = null;
    };
    globalThis.addEventListener("keydown", onKey, true);
    return () => globalThis.removeEventListener("keydown", onKey, true);
  });
  function grab(id, key = null) { bindMsg = ""; capturing = { id, key }; }
  // Grouped into categories rather than a flat 18-row table with the category repeated on every line:
  // you come here looking for "the move keys", not for row 7. Declaration order is meaningful (judge,
  // move, target, …), so it is preserved rather than sorted.
  const groups = $derived.by(() => {
    const out = [];
    for (const e of keybinds.allEntries) {
      let g = out.find((x) => x.name === e.group);
      if (!g) { g = { name: e.group, hint: KEY_GROUP_HINTS[e.group] ?? "", rows: [] }; out.push(g); }
      g.rows.push(e);
    }
    return out;
  });
  function drop(id, k) { bindMsg = keybinds.removeKey(id, k) ?? ""; }

  const TABS = $derived(
    PROOFREAD_TABS.map((t) => ({
      ...t,
      badge: t.id === "frames" ? (ranked.length ? ranked.length.toLocaleString() : null)
        : t.id === "labels" ? (keypointLabels.count || null)
          : null,
    })),
  );
</script>

{#if proofreadWindow.open}
  <!-- Sized like a workspace, not a palette: the frame is the content, so it gets the window. -->
  <PopoutWindow title="Proofreading" width="min(1080px, 92vw)" height={ready ? "min(840px, 86vh)" : null}
                fill={ready} resizable onclose={() => proofreadWindow.close()}>
    <div class="win">
      {#if !ready}
        <!-- Nothing to show, and saying so beats an empty list that looks like "no faults found". -->
        <div class="gate">
          <p class="g-h">Run the automatic QC first</p>
          <p class="g-b">
            Proofreading works down a queue of ANIMALS, ordered by how faulty the detectors think each
            one is. That order comes from <b>max_angle</b>, <b>mean_angle</b>, <b>Anomaly</b> and
            <b>GMM</b>, so there is nothing to rank until they have run once.
          </p>
          <p class="g-m">Still needed: {qc.proofreadMissing.join(" · ")}</p>
          <button class="g-run" disabled={qc.status === "running" || !store.ready} onclick={() => qc.run()}>
            {qc.status === "running" ? "Running QC…" : "Run QC"}
          </button>
          <p class="g-f">Tick Anomaly and GMM under <b>Detection checks</b> if they are off — the queue
            reads the detectors that ran, not the ones currently ticked.</p>
        </div>
      {:else}
        <div class="strip" class:live={on}>
          <span class="dot" class:on></span>
          <span class="s">{on ? "Proofreading is on" : "Proofreading is off"}</span>
          <span class="sep">·</span>
          <span class="s"><b>{keypointLabels.count}</b> reviewed</span>
          <span class="sep">·</span>
          <span class="s"><b>{keypointLabels.badCount}</b> faulty</span>
          <button class="toggle" onclick={() => (keypointLabels.proofreading = !keypointLabels.proofreading)}>
            {on ? "◉ on" : "○ off"} <kbd>r</kbd>
          </button>
        </div>

        <WinTabs tabs={TABS} active={proofreadWindow.tab} onpick={(t) => proofreadWindow.setTab(t)} />

        {#if proofreadWindow.tab === "frames"}
          <div class="nav">
            <button onclick={() => framePass.step(-1)} disabled={pos <= 0} title="Previous frame (p)">↑</button>
            {#if cur}
              <!-- The score is WHY this animal is in front of you, so it leads the row. -->
              <span class="score {band}"
                    title="More suspect than {Math.round(cur.score * 100)}% of the animals in this file. {cur.agree} of 4 detectors rate it in their own top 5%.{cur.anglePriority ? ' An angle check is alarmed, which sorts it ahead of everything else.' : ''}">
                <b>{Math.round(cur.score * 100)}</b>
                <span class="s-sub">
                  <i>score</i>
                  <em class:hot={cur.agree > 1}>{cur.agree}/4</em>
                </span>
              </span>
            {/if}
            <span class="npos">
              <b>#{pos + 1}</b> of {ranked.length.toLocaleString()} ·
              <span class="fno" title="This frame's index in the video. Queue position #{pos + 1} of {ranked.length} — the two are unrelated, because the queue is sorted by suspicion, not by frame.">frame {frameNo}</span>
              {#if cur?.anglePriority}
                <span class="apri" title="A priority check (an angle check, or AnomalyDINO) rates this animal in its top 5% — those sort ahead of everything else">∠ angle</span>
              {/if}
              {#if framePass.siblings.length > 1}
                <span class="sib" title="This frame puts {framePass.siblings.length} animals in the queue — each is judged separately">
                  animal {framePass.instIdx + 1}/{framePass.instances.length}
                </span>
              {/if}
              {#if mine.size}
                <span class="badcount" title="Keypoints you have marked faulty on this animal">
                  ● {mine.size} faulty
                </span>
              {:else if framePass.reviewedHere}
                <span class="seen">✓ judged, none faulty</span>
              {/if}
            </span>
            <button onclick={() => framePass.step(1)} disabled={pos >= ranked.length - 1} title="Next frame (n)">↓</button>
            <button class="skip" onclick={() => framePass.nextUnreviewed()} title="Skip to the next unjudged frame (Tab)">next unjudged</button>
            <button class="skip" class:on={whole} onclick={() => (whole = !whole)}
                    title={whole ? "Frame the flagged animal instead" : "Show the whole video frame for context"}>
              {whole ? "⛶ whole frame" : "⛶ animal"}
            </button>
          </div>

          {#if cur}
            <!-- What the automatic QC thinks is wrong, in the order you need it: the plain-language
                 verdict, then the numbers behind it, then anything else that agrees. -->
            <div class="verdict">
              <p class="v-head">
                {#if verdict}
                  <span class="v-issue">{verdict.issue}</span>
                  {#if verdict.nodeName}<span class="v-node">{verdict.nodeName}</span>{/if}
                {:else}
                  <span class="v-issue dim">No single culprit — the pose is unusual overall</span>
                {/if}
                <span class="v-where">
                  animal {framePass.instIdx + 1}{framePass.instances.length > 1 ? ` of ${framePass.instances.length}` : ""}
                  {#if !whole}· cropped to it{/if}
                </span>
              </p>
              <!-- One row per detector, with the PERCENTILE drawn. The percentile is the meaningful
                   quantity — "z 4.1" means nothing without knowing what the rest of the file looks
                   like — and a bar answers "is this extreme?" before you have finished reading the
                   number. The 95th is marked, because that is the line the ranking itself uses. -->
              <div class="sigs">
                {#each SIGNALS as [k, label, fmt] (k)}
                  {@const v = cur[k]}
                  {@const p = cur.pct?.[k]}
                  <div class="sig" class:hot={p != null && p >= 0.95} class:drove={cur.by === k} class:none={v == null}
                       title={v == null ? "not scored on this animal"
                         : `${label} = ${fmt(v)} — higher than ${Math.round((p ?? 0) * 100)}% of animals in this file${cur.by === k ? " · this is what put it here" : ""}${PRIORITY.has(k) ? " · a priority check — weighted heaviest, and sorts first" : ""}`}>
                    <span class="s-l">{label}{#if cur.by === k}<i class="s-drove" title="this is what put it here">◂</i>{/if}</span>
                    <span class="s-bar"><i style:width="{Math.round((p ?? 0) * 100)}%"></i><u></u></span>
                    <span class="s-v">{v == null ? "—" : fmt(v)}{#if p != null}&nbsp;<i class="s-p">{Math.round(p * 100)}%</i>{/if}</span>
                  </div>
                {/each}
              </div>
              {#if alsoFlagging.length}
                <p class="v-also">
                  also flagging: {#each alsoFlagging as f, k (f.key)}{k ? " · " : ""}{f.label}{#if f.score != null}&nbsp;{f.score.toFixed(2)}{/if}{/each}
                </p>
              {/if}
            </div>
          {/if}
          <div class="stage" class:idle={!on} bind:this={stage}>
            <!-- Auto-fits each candidate (focus box, or the whole frame), and zooms from there: wheel
                 about the pointer, drag to pan once past the fit. `z` still sends the main viewer in. -->
            <canvas
              bind:this={canvas}
              class="frame"
              style:cursor={uz > 1 ? (drag ? "grabbing" : "grab") : "default"}
              onwheel={onWheel}
              onpointerdown={onPointerDown}
              onpointermove={onPointerMove}
              onpointerup={onPointerUp}
              onpointercancel={onPointerUp}
            ></canvas>
            {#if on}
              <div class="zoomctl">
                <button type="button" onclick={() => zoomBy(1 / 1.25)} disabled={uz <= 1} title="Zoom out">−</button>
                <span class="zpct">{Math.round(uz * 100)}%</span>
                <button type="button" onclick={() => zoomBy(1.25)} disabled={uz >= MAX_UZ} title="Zoom in">＋</button>
                <button type="button" onclick={resetView} disabled={uz === 1 && !upx && !upy} title="Refit to this candidate">⤢</button>
              </div>
            {/if}
            {#if loading}<span class="wait">decoding…</span>{/if}
            {#if !on}
              <button class="arm" onclick={() => (keypointLabels.proofreading = true)}>
                Start proofreading <kbd>r</kbd>
              </button>
            {/if}
          </div>

          {#if framePass.instances.length > 1}
            <div class="insts" role="group" aria-label="Animal">
              <span class="ilbl">animal</span>
              {#each framePass.instances as _inst, ii (ii)}
                <button class:on={ii === framePass.instIdx} onclick={() => framePass.selectInstance(ii)}>{ii + 1}</button>
              {/each}
              <kbd>i</kbd>
            </div>
          {/if}

          <!-- Numbered so the digit keys are usable without memorising the skeleton. -->
          <ol class="kps">
            {#each names as nm, ni (nm)}
              <li>
                <button class="kp" class:bad={isFaulty(ni)} class:sel={edit.selNode === ni}
                        onclick={() => framePass.toggleKeypointNumber(ni + 1)}
                        title="Toggle {nm} faulty on animal {framePass.instIdx + 1}{ni < 9 ? ` (key ${ni + 1})` : ""}">
                  {#if ni < 9}<kbd>{ni + 1}</kbd>{/if}<span class="nm">{nm}</span>
                </button>
              </li>
            {/each}
          </ol>

          {#if framePass.hint}<p class="hint">{framePass.hint}</p>{/if}

          <div class="legend">
            {#each KEYS as k (k.id)}
              <span><kbd>{k.id === "toggleKeypoint" ? "1–9" : keyLabel(k.keys[0])}</kbd>{k.id === "toggleKeypoint" ? "toggle keypoint" : k.label.toLowerCase()}</span>
            {/each}
            <button class="edit" onclick={() => proofreadWindow.setTab("keys")}>all keys &amp; remap</button>
          </div>
          {#if upcoming.length}
            <p class="upnext">
              next: {#each upcoming as u, k (`${u.i}:${u.inst}`)}{k ? " · " : ""}<span
                class="un" title="queue #{pos + 2 + k} · score {Math.round(u.score * 100)} · {u.agree}/4"
                >{store.frames?.[u.i]?.frameIdx ?? u.i}{#if framePass.instances.length > 1 || u.inst > 0}<i>a{u.inst + 1}</i>{/if}</span>{/each}
            </p>
          {/if}
          <!-- The ranking explainer used to sit under every candidate. It does not change between
               them, so it belongs where you go to ask about the order, not in the pass. -->
          <details class="rank-note">
            <summary>How this order was built</summary>
            <p>
              One row per <b>animal</b>, worst first. Each detector is rank-normalized across every animal
              in the file, then combined as evidence — so detectors that agree outrank one that is merely
              extreme. <b>max_angle, mean_angle and AnomalyDINO carry 3× the weight, and any animal one of
              them rates in its own top 5% sorts ahead of everything else.</b> AnomalyDINO counts only
              when the per-keypoint pass actually ran it — a kNN pass is a weaker claim about the same
              patches. The <b>score</b> is this animal's percentile in that
              order. Fixed to the run behind it; re-run QC to rebuild.
            </p>
            {#if dist}
                <!-- How many animals each detector is alarmed about, by the same top-5% rule the ranking
                     uses — so the numbers explain the order rather than describing something else. -->
                <div class="dist" title="Animals each detector rates in its own top 5%, out of {dist.total}. {dist.priority} are promoted by a priority check (an angle check, or AnomalyDINO when it ran); {dist.agree[2] + dist.agree[3] + dist.agree[4]} have two or more detectors agreeing.">
                  {#each SIGNALS as [k, label] (k)}
                    <span class="d-item" class:angle={PRIORITY.has(k)}>
                      <span class="d-l">{label}</span>
                      <span class="d-bar"><i style:width="{(dist.per[k] / distMax) * 100}%"></i></span>
                      <b>{dist.per[k]}</b>
                    </span>
                  {/each}
                  <span class="d-item d-tot">{dist.priority} promoted · {dist.total} animals</span>
                </div>
              {/if}
            </details>
        {:else if proofreadWindow.tab === "keys"}
          <div class="keyspane">
            <p class="kp-h">
              <b>Click a key</b> and press the one you want in its place, or <b>+ key</b> to bind another
              to the same action. A key already in use is refused rather than silently stolen — two actions
              on one key means the second never fires. Saved for next time.
            </p>
            {#if bindMsg}<p class="kp-warn">{bindMsg}</p>{/if}
            <!-- ONE grid for every group, not a table per group: separate tables size their columns
                 independently, so the keys started at a different x in each section. -->
            <div class="kbgrid">
              {#each groups as g (g.name)}
                <div class="grp-h">
                  <span class="grp-n">{g.name}</span>
                  {#if g.hint}<span class="grp-d">{g.hint}</span>{/if}
                </div>
                {#each g.rows as e (e.id)}
                  <div class="krow" class:fixed={e.fixed}>
                    <div class="c-l">
                      <span class="kb-name">{e.label}</span>
                      {#if e.hint}<span class="kb-hint">{e.hint}</span>{/if}
                    </div>
                    <div class="c-k">
                      {#if e.fixed}
                        <span class="kb-fx"><kbd>1</kbd>–<kbd>9</kbd> fixed</span>
                      {:else}
                        {#each e.keys as k (k)}
                          {#if capturingHere(e.id, k)}
                            <span class="chip live">press a key… <kbd>Esc</kbd> to cancel</span>
                          {:else}
                            <span class="chip">
                              <!-- The keycap IS the control: click it, press the key you want. -->
                              <button class="cap" onclick={() => grab(e.id, k)}
                                      title="Click, then press the key that should replace {keyLabel(k)}">
                                <kbd>{keyLabel(k)}</kbd>
                              </button>
                              {#if e.keys.length > 1}
                                <button class="x" title="Remove this key" onclick={() => drop(e.id, k)}>×</button>
                              {/if}
                            </span>
                          {/if}
                        {/each}
                        {#if capturingHere(e.id)}
                          <span class="chip live">press a key… <kbd>Esc</kbd> to cancel</span>
                        {:else}
                          <button class="add" onclick={() => grab(e.id)} title="Bind an additional key to this action">+ key</button>
                        {/if}
                      {/if}
                    </div>
                    <div class="c-r">
                      {#if !e.fixed && !keybinds.isDefault(e.id)}
                        <button class="rst" title="Back to the shipped keys" onclick={() => keybinds.resetAction(e.id)}>reset</button>
                      {/if}
                    </div>
                  </div>
                {/each}
              {/each}
            </div>
            <div class="kb-foot">
              <button class="rst all" disabled={!keybinds.anyCustom} onclick={() => { keybinds.resetAll(); bindMsg = ""; }}>
                Reset all to defaults
              </button>
            </div>
          </div>
        {:else if proofreadWindow.tab === "judge"}
          <section class="pane">
            <p class="todo">Judging the current frame.</p>
            <p class="avail">
              Available: <code>proofread.current</code>, <code>proofread.judge(faulty)</code>,
              <code>proofread.toggleKeypointNumber(n)</code>, <code>proofread.cycleKeypoint()</code>,
              <code>proofread.unset()</code>, <code>proofread.nextUnreviewed()</code>
              ({proofread.queue.length} in the guided queue). Keys resolve through
              <code>qc/proofreadKeymap.js</code>.
            </p>
          </section>
        {:else}
          <section class="pane">
            <p class="todo">Everything labelled, in and out.</p>
            <p class="avail">
              Available: <code>keypointLabels.rows()</code>, <code>keypointLabels.nodes</code> (per-node
              tally), <code>keypointLabels.source</code>, <code>keypointLabels.toCsv()</code> /
              <code>proofread.exportCsv()</code>, <code>keypointLabels.ingest(rows, source)</code>,
              <code>keypointLabels.clear()</code>
              ({keypointModels.active.length} model{keypointModels.active.length === 1 ? "" : "s"} loaded).
            </p>
          </section>
        {/if}
      {/if}
    </div>
  </PopoutWindow>
{/if}

<style>
  .win { display: flex; flex-direction: column; gap: 0.55rem; flex: 1 1 auto; min-height: 0; }

  /* ---- keybind editor ---- */
  .keyspane { display: flex; flex-direction: column; gap: 0.9rem; flex: 1 1 auto; min-height: 0; overflow-y: auto; padding-right: 0.2rem; }
  /* This pane is READ and CLICKED, not glanced at like the in-pass legend, so it runs at a normal
     text size with real hit targets — the rest of the window is deliberately dense, this is not. */
  .kp-h { margin: 0; font-size: 0.74rem; color: var(--muted); line-height: 1.55; max-width: 66ch; }
  .kp-h b { color: var(--text); font-weight: 600; }
  .kp-warn {
    margin: 0; font-size: 0.74rem; color: #f0b47a;
    padding: 0.4rem 0.6rem; border-radius: 6px;
    background: rgba(240, 180, 122, 0.12);
    border: 1px solid rgba(240, 180, 122, 0.3);
  }
  /* Category blocks, echoing how the rest of the app groups things: a heading you can scan for, then its
     rows. All groups share ONE grid so the key column starts at the same x throughout — with a table per
     group each sized its own columns and the caps wandered from section to section. */
  .kbgrid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(13rem, max-content) 4.2rem;
    align-items: center;
    font-size: 0.82rem;
  }
  .grp-h {
    grid-column: 1 / -1;
    display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap;
    margin: 0.9rem 0 0.15rem;
    padding: 0 0.1rem 0.3rem;
    border-bottom: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
  }
  .grp-h:first-child { margin-top: 0; }
  .grp-n {
    font-size: 0.7rem; font-weight: 600; color: var(--accent);
    text-transform: uppercase; letter-spacing: 0.07em;
  }
  .grp-d { font-size: 0.66rem; color: var(--dim); }

  /* `display: contents` lets a row own hover/opacity while its three cells still line up on the parent
     grid — the alignment is the whole point, so the row must not become a column of its own. */
  .krow { display: contents; }
  .krow > * { padding: 0.5rem 0.4rem; border-bottom: 1px solid var(--border); }
  .krow:hover > * { background: rgba(255, 255, 255, 0.025); }
  .krow.fixed > * { opacity: 0.6; }
  .krow.fixed:hover > * { background: none; }
  .c-l { color: var(--text); padding-right: 0.8rem; }
  .kb-name { display: block; }
  .kb-hint { display: block; font-size: 0.68rem; color: var(--dim); line-height: 1.35; margin-top: 0.1rem; }
  .c-k { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
  .c-r { text-align: right; }
  .kb-fx { color: var(--dim); font-size: 0.74rem; white-space: nowrap; }

  /* A binding should look like a key you can press — and here it is also the button that rebinds it. */
  .chip { display: inline-flex; align-items: center; gap: 0.2rem; }
  .cap { background: none; border: none; padding: 0; cursor: pointer; }
  .cap:hover kbd { color: var(--accent); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .cap:focus-visible kbd { outline: 2px solid var(--accent); outline-offset: 2px; }
  .chip kbd, .kb-fx kbd {
    display: inline-block;
    min-width: 1.9rem;
    padding: 0.28rem 0.5rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.82rem;
    line-height: 1.1;
    text-align: center;
    color: var(--text);
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: 5px;
    transition: color 110ms ease, border-color 110ms ease, background 110ms ease;
  }
  @media (prefers-reduced-motion: reduce) { .chip kbd, .kb-fx kbd { transition: none; } }
  .chip.live {
    gap: 0.4rem;
    padding: 0.28rem 0.6rem;
    font-size: 0.78rem;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    border: 1px solid var(--accent);
    border-radius: 6px;
  }
  .chip.live kbd { min-width: 0; padding: 0.1rem 0.35rem; font-size: 0.68rem; }
  .chip .x {
    background: none; border: none; color: var(--dim);
    cursor: pointer; font-size: 1rem; line-height: 1;
    padding: 0.2rem 0.25rem; border-radius: 4px;
  }
  .chip .x:hover { color: #fca5a5; background: rgba(252, 165, 165, 0.14); }

  .add, .rst {
    background: none; border: 1px dashed var(--border); border-radius: 6px;
    color: var(--muted); font-size: 0.74rem; padding: 0.3rem 0.7rem; cursor: pointer;
  }
  .rst { border-style: solid; font-size: 0.7rem; }
  .add:hover, .rst:hover { color: var(--accent); border-color: var(--accent); }
  .rst:disabled { opacity: 0.4; cursor: default; }
  .edit {
    background: none; border: 1px solid var(--border); border-radius: var(--r-xs);
    color: var(--dim); font-size: 0.6rem; padding: 0.1rem 0.4rem; cursor: pointer;
  }
  .edit:hover { color: var(--accent); border-color: var(--accent); }
  .kb-foot { display: flex; justify-content: flex-end; padding-top: 0.2rem; }
  .rst.all { font-size: 0.76rem; padding: 0.4rem 0.9rem; }

  /* ---- gate ---- */
  .gate { display: flex; flex-direction: column; gap: 0.45rem; align-items: flex-start; padding: 0.4rem 0.2rem; }
  .g-h { margin: 0; font-size: 0.82rem; color: var(--text); font-weight: 600; }
  .g-b { margin: 0; font-size: 0.66rem; color: var(--dim); line-height: 1.5; max-width: 46ch; }
  .g-b b, .g-f b { color: var(--muted); font-weight: 600; }
  .g-m { margin: 0; font-size: 0.62rem; color: #f0b47a; }
  .g-run {
    padding: 0.45rem 1rem;
    font-size: 0.74rem;
    font-weight: 600;
    color: #08131c;
    background: var(--accent);
    border: none;
    border-radius: 7px;
    cursor: pointer;
  }
  .g-run:hover { filter: brightness(1.08); }
  .g-run:disabled { opacity: 0.45; cursor: default; filter: none; }
  .g-f { margin: 0; font-size: 0.58rem; color: var(--dim); line-height: 1.45; max-width: 52ch; }

  /* ---- status ---- */
  .strip {
    display: flex; align-items: center; gap: 0.35rem;
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--border); border-radius: 7px;
    background: rgba(255, 255, 255, 0.02);
  }
  .strip.live { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dim); flex: none; }
  .dot.on { background: var(--accent); }
  .s { font-size: 0.64rem; color: var(--dim); }
  .s b { color: var(--muted); font-weight: 600; }
  .sep { color: var(--border); font-size: 0.6rem; }
  .toggle {
    margin-left: auto; background: none;
    border: 1px solid var(--border); border-radius: var(--r-xs);
    color: var(--muted); font-size: 0.62rem; padding: 0.15rem 0.45rem; cursor: pointer;
  }
  .toggle:hover { color: var(--accent); border-color: var(--accent); }
  kbd { font-size: 0.62rem; padding: 0.05rem 0.28rem; border: 1px solid var(--border); border-radius: 4px; color: var(--dim); }

  /* ---- one frame at a time ---- */
  .nav { display: flex; align-items: center; gap: 0.4rem; }
  .nav button {
    background: transparent; border: 1px solid var(--border); border-radius: var(--r-xs);
    color: var(--muted); font-size: 0.66rem; padding: 0.15rem 0.5rem; cursor: pointer;
  }
  .nav button:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
  .nav button:disabled { opacity: 0.4; cursor: default; }
  .nav .skip { font-size: 0.58rem; }
  .nav .skip.on { color: var(--accent); border-color: var(--accent); }
  .verdict {
    display: flex; flex-direction: column; gap: 0.18rem;
    padding: 0.28rem 0.5rem;
    border: 1px solid var(--border);
    border-left: 2px solid color-mix(in srgb, var(--accent) 55%, var(--border));
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.02);
  }
  .v-head { margin: 0; display: flex; align-items: baseline; gap: 0.4rem; flex-wrap: wrap; }
  /* The headline answer. It earns the space the ten-key legend used to take. */
  .v-issue { font-size: 0.8rem; line-height: 1.25; color: var(--text); font-weight: 600; }
  .v-issue.dim { color: var(--dim); font-weight: 400; font-style: italic; }
  .v-node {
    font-size: 0.68rem; color: var(--accent);
    padding: 0.05rem 0.4rem; border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 16%, transparent);
  }
  .v-where { margin-left: auto; font-size: 0.62rem; color: var(--dim); }
  /* Four detectors ACROSS, not stacked. The canvas is contain-fitted into whatever is left, so every
     line here is picture the reviewer does not get — and the bar carries the meaning, so it does not
     need a row of its own. Wraps to 2x2 when the window is narrow. */
  .sigs {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
    gap: 0.1rem 0.7rem;
    margin-top: 0.1rem;
  }
  /* Every signal is shown, alarmed or not — "GMM is calm about this one" is information too. */
  .sig {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.35rem;
    padding: 0.05rem 0.2rem;
    border-radius: 4px;
    font-size: 0.63rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    min-width: 0;
  }
  .sig .s-l { color: var(--dim); white-space: nowrap; }
  .sig .s-drove { font-style: normal; margin-left: 0.2rem; color: var(--accent); }
  .sig .s-bar {
    position: relative;
    height: 0.32rem;
    min-width: 1.5rem;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.07);
    overflow: hidden;
  }
  .sig .s-bar i { position: absolute; inset: 0 auto 0 0; background: #6b7686; border-radius: 999px; }
  /* the 95th — the line the ranking itself uses, so the bar can be read against the rule */
  .sig .s-bar u { position: absolute; left: 95%; top: -1px; bottom: -1px; width: 1px; background: rgba(255,255,255,0.4); }
  .sig .s-v { text-align: right; color: var(--text); white-space: nowrap; }
  .sig .s-p { font-style: normal; font-size: 0.56rem; color: var(--dim); }
  .sig.none { opacity: 0.45; }
  .sig.hot .s-l, .sig.hot .s-v { color: #f0b47a; }
  .sig.hot .s-bar i { background: #f0b47a; }
  .sig.drove .s-l, .sig.drove .s-v { color: var(--accent); }
  .sig.drove .s-bar i { background: var(--accent); }
  .v-also { margin: 0; font-size: 0.6rem; color: var(--dim); }
  .npos { flex: 1 1 auto; font-size: 0.64rem; color: var(--dim); font-variant-numeric: tabular-nums; }
  .npos b { color: var(--text); font-weight: 600; }
  .seen { margin-left: 0.4rem; color: #6ee7a8; }
  .apri {
    margin-left: 0.4rem; padding: 0.05rem 0.4rem; border-radius: 999px;
    background: rgba(240, 180, 122, 0.18); color: #f0b47a; font-weight: 600;
  }
  .sib {
    margin-left: 0.4rem; padding: 0.05rem 0.4rem; border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent);
  }
  .badcount {
    margin-left: 0.4rem;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    color: #fff;
    background: rgba(255, 59, 48, 0.75);
    font-weight: 600;
  }

  /* The frame owns the leftover height; the bars above and below are as thin as they can be. */
  .stage {
    position: relative;
    flex: 1 1 auto;
    min-height: 12rem;
    display: grid;
    place-items: center;
    border-radius: 7px;
    overflow: hidden;
    background: #0b0e13;
  }
  .frame { display: block; max-width: 100%; max-height: 100%; }
  .stage.idle .frame { opacity: 0.5; }
  /* Sits over the canvas, bottom-right, out of the way of the pose. */
  .zoomctl {
    position: absolute;
    right: 0.5rem;
    bottom: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.15rem;
    padding: 0.15rem 0.25rem;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: color-mix(in srgb, var(--bg) 82%, transparent);
    backdrop-filter: blur(2px);
  }
  .zoomctl button {
    min-width: 1.35rem;
    padding: 0.1rem 0.25rem;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--fg);
    font-size: 0.8rem;
    cursor: pointer;
  }
  .zoomctl button:hover:not(:disabled) { background: var(--line); }
  .zoomctl button:disabled { opacity: 0.35; cursor: default; }
  .zpct {
    min-width: 2.6rem;
    text-align: center;
    font-size: 0.66rem;
    color: var(--dim);
    font-variant-numeric: tabular-nums;
  }
  .wait {
    position: absolute; inset: 0; display: grid; place-items: center;
    font-size: 0.62rem; color: var(--dim); pointer-events: none;
  }
  .arm {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    padding: 0.45rem 0.9rem; font-size: 0.72rem; font-weight: 600;
    color: #08131c; background: var(--accent); border: none; border-radius: 7px; cursor: pointer;
  }
  .arm:hover { filter: brightness(1.08); }

  .insts { display: flex; align-items: center; gap: 0.25rem; }
  .ilbl { font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--dim); }
  .insts button {
    background: transparent; border: 1px solid var(--border); border-radius: var(--r-xs);
    color: var(--muted); font-size: 0.62rem; padding: 0.05rem 0.4rem; cursor: pointer;
  }
  .insts button.on { color: var(--accent); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }

  .kps { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .kp {
    display: inline-flex; align-items: center; gap: 0.25rem;
    background: transparent; border: 1px solid var(--border); border-radius: var(--r-xs);
    color: var(--muted); font-size: 0.62rem; padding: 0.1rem 0.4rem; cursor: pointer;
  }
  .kp:hover { border-color: var(--accent); }
  .kp.sel { border-color: var(--accent); color: var(--accent); }
  /* Same red as the canvas mark, and filled rather than outlined — the chip and the keypoint are one
     indicator seen from two places, so they must not disagree about what "faulty" looks like. */
  .kp.bad {
    border-color: #ff3b30;
    color: #fff;
    background: rgba(255, 59, 48, 0.55);
    font-weight: 600;
  }
  .kp.bad kbd { color: #fff; border-color: rgba(255, 255, 255, 0.45); }
  .kp.bad:hover { background: rgba(255, 59, 48, 0.7); border-color: #ff3b30; }
  .kp .nm { font-size: 0.62rem; }

  .hint { margin: 0; font-size: 0.6rem; color: #f0b47a; }
  .legend { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.9rem; font-size: 0.68rem; color: var(--dim); }
  .legend span { display: inline-flex; align-items: center; gap: 0.3rem; }
  .fno { color: var(--text); }
  .score {
    flex: none;
    display: inline-flex; align-items: center; gap: 0.35rem;
    padding: 0.1rem 0.5rem 0.1rem 0.45rem;
    border-radius: 7px;
    border: 1px solid var(--border);
    background: rgba(255, 255, 255, 0.04);
    line-height: 1;
  }
  .score b { font-size: 1.15rem; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--muted); }
  .s-sub { display: flex; flex-direction: column; gap: 0.1rem; }
  .s-sub i {
    font-style: normal; font-size: 0.5rem; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--dim);
  }
  .s-sub em { font-style: normal; font-size: 0.55rem; color: var(--dim); }
  .s-sub em.hot { color: #f0b47a; }
  .score.hot { border-color: #ff6b5e; background: rgba(255, 107, 94, 0.16); }
  .score.hot b { color: #ff8a7e; }
  .score.warm { border-color: rgba(240, 180, 122, 0.6); background: rgba(240, 180, 122, 0.13); }
  .score.warm b { color: #f0b47a; }
  .score.cool b { color: var(--muted); }
  .upnext {
    margin: 0; font-size: 0.6rem; color: var(--dim);
    font-variant-numeric: tabular-nums;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .un { color: var(--muted); }
  .un i { font-style: normal; font-size: 0.52rem; color: var(--dim); }
  .dist { display: flex; align-items: center; gap: 0.55rem; flex-wrap: wrap; font-size: 0.56rem; color: var(--dim); }
  .d-item { display: inline-flex; align-items: center; gap: 0.25rem; font-variant-numeric: tabular-nums; }
  .d-l { color: var(--dim); }
  .d-bar { width: 2.6rem; height: 4px; border-radius: 2px; background: rgba(255, 255, 255, 0.07); overflow: hidden; }
  .d-bar i { display: block; height: 100%; background: var(--dim); }
  .d-item.angle .d-l, .d-item.angle b { color: #f0b47a; }
  .d-item.angle .d-bar i { background: #f0b47a; }
  .d-item b { color: var(--muted); font-weight: 600; }
  .d-tot { margin-left: auto; color: var(--dim); }
  .rank-note > summary {
    cursor: pointer;
    font-size: 0.64rem;
    color: var(--dim);
    list-style: none;
  }
  .rank-note > summary::-webkit-details-marker { display: none; }
  .rank-note > summary::before { content: "▸ "; }
  .rank-note[open] > summary::before { content: "▾ "; }
  .rank-note > p { margin: 0.3rem 0 0; }
  .rank-note { margin: 0; font-size: 0.58rem; color: var(--dim); line-height: 1.4; }
  .rank-note b { color: var(--muted); font-weight: 600; }
  .legend kbd { font-size: 0.66rem; padding: 0.08rem 0.32rem; color: var(--muted); }

  /* Placeholder panes: dashed, so nobody mistakes an empty pane for a finished one. */
  .pane {
    display: flex; flex-direction: column; gap: 0.4rem;
    min-height: 7rem; padding: 0.8rem;
    border: 1px dashed var(--border); border-radius: 7px;
  }
  .todo { margin: 0; font-size: 0.72rem; color: var(--muted); }
  .avail { margin: 0; font-size: 0.6rem; color: var(--dim); line-height: 1.55; }
  .avail code {
    font-size: 0.58rem; padding: 0.02rem 0.24rem; border-radius: 3px;
    background: rgba(255, 255, 255, 0.05); color: var(--muted);
  }
</style>
