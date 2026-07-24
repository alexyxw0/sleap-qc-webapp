# SLEAP QC Web

A **Svelte 5 + Vite** web app that loads a SLEAP labels file (`.slp` or `.pkg.slp`)
entirely in the browser using
[`@talmolab/sleap-io.js`](https://www.npmjs.com/package/@talmolab/sleap-io.js): scrub
frames with the pose overlay, **edit** poses/skeletons, and run **quality-control checks**
(a JS port of `sleap.qc`) to surface anomalous frames — all client-side, no server.

> **Provenance.** This is the standalone, stable baseline extracted at the point where the
> `sleap.qc` detection pipeline had been ported and wired into the editor (deterministic
> ZScore path). Later experimental QC work — the **ECOD** scorer + per-node spatial prior
> (de-saturation), a confidence/uncertainty channel, and calibration — continues in a
> separate experimental repository and is intentionally **not** included here.

## Run

```bash
npm install
npm run dev      # open the printed http://localhost:5173
npm run build    # production build to dist/ (verified green)
```

## What it does

- **Upload** a `.slp` / `.pkg.slp` (drag-drop or file picker). Loads in-browser via
  `loadSlp()` (streaming Web Worker; h5wasm from CDN).
- **Navigate frames** of the uploaded video / sampled frames two ways:
  - **Frame grid** (sidebar) — each frame is a discrete clickable tile; the selected one
    is highlighted, labeled frames are tinted, and a "go to #" box jumps directly. The
    grid is **virtualized** (only on-screen rows mount), so it stays smooth at 180k frames.
  - **Timeline** (under the canvas) — slider, ◀ ▶ buttons, **←/→** or **A/D** keys,
    **Space** to play/pause, first/last jumps. All inputs stay in sync.
- **Pose overlay**: skeleton edges + nodes drawn on a canvas, colored per track.
- **Info panels** (like the SLEAP GUI): video resolution/frames/embedded flag, label
  counts (frames, instances, tracks, videos), skeleton (nodes + edges), and a per-frame
  list of instances with each point's name / x,y / visibility.

### Two source modes
- **`.pkg.slp`** — frames are embedded in the file; the viewer opens directly.
- **`.slp`** — has no pixels of its own, so the upload becomes a **2-step flow**: after the
  labels load, the app **requires** the matching video file before opening the viewer
  (frames overlay onto the uploaded video). This is enforced in `labelsStore` via a
  `needs-video` state between load and `ready`.

## Try it with the bundled samples (`samples/`)
- `minimal_instance.pkg.slp` — embedded single frame (demonstrates the embedded path).
- `demo-flies13-preds.slp` — **1350 frames, 2700 instances** (great for navigation);
  then add `demo-flies13-preds.mp4` to see the fly video under the poses.

## Architecture

- `src/lib/labelsStore.svelte.js` — the **reactivity bridge**. sleap-io.js objects are
  plain classes (not deep-proxied by Svelte), so the model lives in `$state.raw` and a
  `rev` counter signals redraws. Single source of truth, shared as an ESM singleton.
- `src/lib/draw.js` — **imperative** canvas draw (one canvas, one `drawScene`); Svelte
  only decides *when* to draw.
- `src/lib/components/Viewer.svelte` — canvas + nav controls; `$effect` redraws on
  `index`/`rev` change with an AbortController/`cancelled` guard so fast scrubbing never
  paints a stale async frame.
- `src/lib/components/FrameGrid.svelte` — virtualized grid of clickable frame tiles
  (discrete frame selector); only visible rows are mounted.
- `src/lib/components/Sidebar.svelte` — frame grid + metadata + per-frame instance/point
  panels.
- `vite.config.js` — stubs node-only optional deps (`skia-canvas`, `tiff`) out of the
  client bundle; leaves `h5wasm` unbundled.

`smoke.mjs` is a Node check that the data-model fields the UI relies on exist on real
fixtures (`node smoke.mjs`).

## Editing

Edit the labels/nodes/skeleton of individual frames and save the result as a new file.
Every operation was validated to survive `saveSlpToBytes` → reload before the UI was built.

- **Move keypoints** — click a point on the canvas to select it, drag to reposition.
- **Show/hide a point** — `V`, or double-click the point row in the sidebar.
- **Add / delete instances** — toolbar buttons or `Del`; a new instance drops its nodes in
  a ring at frame center for easy dragging.
- **Place unplaced points** — select a hidden/unset node, then click on the image to place
  it (used after adding a skeleton node).
- **Edit the skeleton** (sidebar, applies to all frames): rename / add / remove nodes
  (points are kept aligned across every instance), add / remove edges.
- **Undo / redo** — `⌘/Ctrl+Z` undoes any recent change (move/visibility/add/delete/
  skeleton edit); `⇧⌘/Ctrl+Z` (or `Ctrl+Y`) redoes. Also on the toolbar (↺ / ↻).
- **Modified-frame indicators** — frames you edit get an amber dot in the **frame grid**
  (per-frame label edits: move/visibility/add/delete). A frame is marked iff it differs
  from how it was loaded: each edit increments a per-frame counter and **undo decrements
  it**, so undoing a frame back to its original state clears the badge (redo restores
  it). Selecting a node never counts. Cleared on new file. (Badges persist through a save
  — they mean "differs from the loaded file" — while the toolbar's unsaved-changes dot
  clears on save.)
- **Node labels** — each keypoint is labelled with its body-part name on the canvas.
  Labels are half-transparent by default (so overlapping ones stay legible) and the
  **focused** node's label becomes fully opaque and is drawn on top. The overlay is
  scale-aware so it's a consistent on-screen size at any video resolution.
- **Hidden points stay editable** — toggling a point off (`V`) makes it very transparent
  instead of removing it; it can still be selected and dragged, and stays hidden while
  moved. (Edges to a hidden node also fade rather than vanish.)
- **Zoom & pan** — mouse wheel or the on-canvas −/＋ controls to zoom (also `+`/`-`,
  `0` to reset); drag empty space to pan when zoomed in. Helpful for small/dense
  skeletons. Implemented as a reusable `viewStore` (zoom + pan).
  The zoom/pan transform is applied **inside the canvas** (and the canvas is sized to
  the viewport × devicePixelRatio), so node markers and labels **re-rasterize crisply
  at any zoom** instead of being CSS-upscaled. The frame photo still softens when
  magnified (it's raster), but the overlay stays sharp. Cost is one `drawImage` + a few
  shapes per frame — negligible.
- **Save** — `⤓ Save .slp` downloads edited labels; `⤓ .pkg.slp` re-embeds frames when the
  source had them. A dirty dot and an unload warning track unsaved changes.

Architecture: `src/lib/editStore.svelte.js` holds selection + mutations + undo/redo + save,
mutating the sleap-io.js model in place and bumping `store.rev`. The canvas splits
image-fetch from overlay-draw into two `$effect`s so dragging redraws the overlay without
re-decoding the frame. `EditToolbar` / `SkeletonEditor` are the new components.

## QC checks

A JS port of the `sleap.qc` detection pipeline (`src/lib/qc/checks/`) is wired into the UI:

- **Run QC** button (toolbar) runs the **deterministic** path on demand — geometric/visibility
  features + frame-level checks + the ZScore anomaly scorer (`useGmm:false`; the GMM is
  seed-unstable even in sklearn, so it's excluded from the UI). Shows a flagged-frame count
  and a "stale" flag once you edit.
- **Frame grid**: each tile gets a green→red **anomaly heat bar** (per-frame max score) and a
  red triangle for **frame-level issues** (incomplete count, duplicates, negative-with-instances).
- **Sidebar**: a **QC card** for the current frame — the anomaly score + confidence, the
  **likely issue** (what the check thinks is wrong, e.g. "Unusual edge length", "Isolated
  node"; ported from `sleap.qc`'s `_infer_top_issue`), instance count vs. expected, and any
  frame-level issues — plus a per-instance **anomaly chip + issue** in the instance panel.
  The card states plainly that the anomaly is "geometrically unusual vs. the rest of this
  file (a review hint, not a certain error)" so a high score is read as *look here*, not
  *definitely wrong* — and the issue label lets you verify/dismiss it quickly.

The detector port is validated against the real Python `sleap.qc` (Python 3.13): 17/18
features bit-exact, ZScore ~1e-8, GMM scoring exact. The deterministic **ZScore** path is
used in the UI (the GMM is seed-unstable even in sklearn, so it's excluded). Heavy compute
runs on the main thread for now (fine for typical files; a Web Worker is the next step for
very large ones).

## Scope (still not the full GUI)

**Not yet**: track creation/reassignment, prediction-review workflow, suggestions,
multi-instance copy/interpolate. The data model supports these; they're UI work.

## Notes / known edges
- Pure client-side SPA — no server. Production: `@sveltejs/adapter-static` under SvelteKit
  or this plain Vite build behind any static host.
- The host should send `Cross-Origin-Opener-Policy: same-origin` +
  `Cross-Origin-Embedder-Policy: require-corp` (the dev/preview servers already do — see
  `vite.config.js`): cross-origin isolation is what lets the DINO appearance backend run
  multi-threaded WASM (~2× on typical machines). Without the headers everything still works,
  just single-threaded — the appearance panel's backend label tells you which you got.
  On a host that can't set headers (e.g. GitHub Pages), the `coi-serviceworker` shim is the
  usual workaround. Perf harness: `/bench/` and `/bench/e2e.html` under `npm run dev`.
- Needs network at runtime: the h5wasm WASM is pulled from jsDelivr by the streaming
  worker. (Can be self-hosted later via `h5wasmUrl`.)
- External-video decode uses WebCodecs (modern browsers).
