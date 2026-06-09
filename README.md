# SLEAP Web — viewer skeleton

A minimal **Svelte 5 + Vite** web app that loads a SLEAP labels file
(`.slp` or `.pkg.slp`) entirely in the browser using
[`@talmolab/sleap-io.js`](https://www.npmjs.com/package/@talmolab/sleap-io.js), and lets
you scrub through its frames with the pose overlay — the read/navigate core of the SLEAP
GUI.

Built as the validation spike for the investigation in
`../2026-06-09-sleap-io-js-web-backend/` (backend = sleap-io.js, frontend = Svelte).

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

## Architecture (maps to the investigation)

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

## Scope (skeleton, not the full GUI)

Implemented: load, frame navigation, pose visualization, metadata. **Not yet**: editing
(drag points, add/remove instances), tracks/skeleton editing, prediction review,
undo/redo, suggestions, save. The data model supports the edits; they're UI work — see the
investigation's gap analysis and design questions (DQ-F1…F5).

## Notes / known edges
- Pure client-side SPA — no server. Production: `@sveltejs/adapter-static` under SvelteKit
  (recommended in the investigation) or this plain Vite build behind any static host.
- Needs network at runtime: the h5wasm WASM is pulled from jsDelivr by the streaming
  worker. (Can be self-hosted later via `h5wasmUrl`.)
- External-video decode uses WebCodecs (modern browsers).
