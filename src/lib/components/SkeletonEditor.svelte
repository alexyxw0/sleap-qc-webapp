<script>
  import { store } from "../labelsStore.svelte.js";
  import { edit } from "../editStore.svelte.js";

  let open = $state(false);
  let newNode = $state("");
  let edgeSrc = $state(0);
  let edgeDst = $state(1);

  const sk = $derived(store.skeleton);
  const nodeNames = $derived.by(() => {
    store.rev;
    return sk?.nodeNames ?? [];
  });
  const edges = $derived.by(() => {
    store.rev;
    return (sk?.edges ?? []).map((e, i) => ({
      i,
      s: e.source?.name ?? e.source,
      d: e.destination?.name ?? e.destination,
    }));
  });

  function renameNode(i, e) {
    const v = e.target.value.trim();
    if (v) edit.renameNode(i, v);
  }
  function addNode() {
    const v = newNode.trim();
    if (v) {
      edit.addNode(v);
      newNode = "";
    }
  }
  function addEdge() {
    edit.addEdge(edgeSrc, edgeDst);
  }
</script>

<section class="card">
  <button class="head" onclick={() => (open = !open)} aria-expanded={open}>
    <h3>Skeleton{sk?.name ? ` · ${sk.name}` : ""}</h3>
    <span class="meta">{nodeNames.length} nodes · {edges.length} edges {open ? "▾" : "▸"}</span>
  </button>

  {#if open}
    <div class="body">
      <div class="sub">Nodes</div>
      <div class="nodes">
        {#each nodeNames as name, i (i)}
          <div class="node">
            <input value={name} onchange={(e) => renameNode(i, e)} aria-label="Node name" />
            <button class="x" onclick={() => edit.removeNode(i)} disabled={nodeNames.length <= 1} title="Remove node">×</button>
          </div>
        {/each}
      </div>
      <div class="add">
        <input placeholder="new node name" bind:value={newNode} onkeydown={(e) => e.key === "Enter" && addNode()} />
        <button onclick={addNode} disabled={!newNode.trim()}>＋ Add</button>
      </div>

      <div class="sub">Edges</div>
      <div class="edges">
        {#each edges as e (e.i)}
          <div class="edge">
            <span>{e.s} → {e.d}</span>
            <button class="x" onclick={() => edit.removeEdge(e.i)} title="Remove edge">×</button>
          </div>
        {:else}
          <p class="muted">No edges.</p>
        {/each}
      </div>
      <div class="add">
        <select bind:value={edgeSrc}>
          {#each nodeNames as name, i}<option value={i}>{name}</option>{/each}
        </select>
        <span class="arrow">→</span>
        <select bind:value={edgeDst}>
          {#each nodeNames as name, i}<option value={i}>{name}</option>{/each}
        </select>
        <button onclick={addEdge} disabled={edgeSrc === edgeDst}>＋</button>
      </div>

      <p class="warn">Node/edge edits apply to the whole skeleton (all frames).</p>
    </div>
  {/if}
</section>

<style>
  .card {
    background: linear-gradient(180deg, rgba(20, 26, 37, 0.55), rgba(13, 18, 27, 0.55));
    border: 1px solid var(--border);
    border-radius: var(--r);
    padding: 0.85rem 0.9rem;
    box-shadow: var(--shadow-sm), inset 0 1px 0 rgba(255, 255, 255, 0.025);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: inherit;
    gap: 0.5rem;
  }
  h3 {
    margin: 0;
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.09em;
    color: #9fb0c3;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  h3::before {
    content: "";
    width: 3px;
    height: 11px;
    border-radius: 2px;
    background: var(--accent-grad);
  }
  .meta {
    font-size: 0.72rem;
    color: var(--muted);
    white-space: nowrap;
  }
  .body {
    margin-top: 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .sub {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #7c8a9c;
    margin-top: 0.3rem;
  }
  .nodes,
  .edges {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-height: 160px;
    overflow-y: auto;
  }
  .node,
  .add {
    display: flex;
    gap: 0.3rem;
    align-items: center;
  }
  .edge {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.8rem;
    background: #141b25;
    border: 1px solid #1d2632;
    border-radius: 6px;
    padding: 0.15rem 0.45rem;
  }
  input,
  select {
    flex: 1;
    min-width: 0;
    background: #0c1118;
    border: 1px solid #2a3442;
    color: #e7edf4;
    border-radius: 6px;
    padding: 0.25rem 0.4rem;
    font-size: 0.8rem;
  }
  button {
    background: #1a212c;
    color: #cdd7e3;
    border: 1px solid #2a3442;
    border-radius: 6px;
    padding: 0.25rem 0.5rem;
    font-size: 0.78rem;
    cursor: pointer;
    white-space: nowrap;
  }
  button:hover:not(:disabled) {
    background: #222b38;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .x {
    padding: 0.1rem 0.45rem;
    color: #9fb0c3;
  }
  .x:hover:not(:disabled) {
    color: #fda4af;
    border-color: #5a3540;
  }
  .arrow {
    color: var(--muted);
  }
  .muted {
    color: var(--muted);
    font-size: 0.8rem;
    margin: 0;
  }
  .warn {
    font-size: 0.72rem;
    color: #7c8a9c;
    margin: 0.3rem 0 0;
  }
</style>
