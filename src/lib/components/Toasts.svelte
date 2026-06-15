<script>
  import { toasts, toast } from "../toastStore.svelte.js";
  import { qc } from "../qcStore.svelte.js";
  import { edit } from "../editStore.svelte.js";
  import { store } from "../labelsStore.svelte.js";

  // Watch store transitions and narrate them. Kept here (not in the stores) so the
  // domain stores stay UI-free.
  let lastQC = qc.status;
  $effect(() => {
    const s = qc.status;
    if (s === lastQC) return;
    const was = lastQC;
    lastQC = s;
    if (was === "running" && s === "done") {
      toast(
        qc.flaggedFrameCount > 0
          ? `QC complete — ${qc.flaggedFrameCount} frame${qc.flaggedFrameCount === 1 ? "" : "s"} flagged. Press N to review.`
          : "QC complete — nothing flagged 🎉",
        { kind: qc.flaggedFrameCount > 0 ? "warn" : "good" },
      );
    } else if (s === "error") {
      toast(`QC failed: ${qc.error}`, { kind: "bad" });
    }
  });

  let lastSaving = edit.saving;
  $effect(() => {
    const s = edit.saving;
    if (s === lastSaving) return;
    const was = lastSaving;
    lastSaving = s;
    if (was && !s) {
      if (store.error?.startsWith("Save failed")) toast(store.error, { kind: "bad" });
      else toast("Download started", { kind: "good" });
    }
  });
</script>

<div class="stack" aria-live="polite">
  {#each toasts.items as t (t.id)}
    <button class="toast {t.kind}" onclick={() => toasts.dismiss(t.id)}>
      <i></i>
      {t.message}
    </button>
  {/each}
</div>

<style>
  .stack {
    position: fixed;
    bottom: 4.6rem; /* above the floating transport capsule */
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.45rem;
    z-index: 500; /* above everything, including raised islands and overlays */
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    background: rgba(13, 15, 18, 0.92);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
    border: 1px solid var(--border);
    color: var(--text);
    font: inherit;
    font-size: 0.76rem;
    border-radius: var(--r-xs);
    padding: 0.45rem 0.9rem;
    cursor: pointer;
    box-shadow: var(--shadow-sm);
    animation: toast-in 0.18s var(--ease) both;
  }
  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  .toast i {
    width: 6px;
    height: 6px;
    flex: none;
    background: var(--accent);
  }
  .toast.good i {
    background: var(--good);
  }
  .toast.warn i {
    background: var(--warn);
  }
  .toast.bad i {
    background: var(--danger);
  }
</style>
