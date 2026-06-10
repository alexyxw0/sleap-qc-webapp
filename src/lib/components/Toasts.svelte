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
    bottom: 4.4rem; /* above the playback bar, so toasts never cover the timeline */
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.45rem;
    z-index: 50;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    background: linear-gradient(180deg, rgba(24, 31, 44, 0.96), rgba(13, 18, 27, 0.96));
    border: 1px solid #2a3850;
    color: #dfe7f1;
    font: inherit;
    font-size: 0.84rem;
    border-radius: 999px;
    padding: 0.5rem 1rem;
    cursor: pointer;
    box-shadow: 0 14px 40px -12px rgba(0, 0, 0, 0.8);
    backdrop-filter: blur(10px);
    animation: toast-in 0.22s var(--ease) both;
  }
  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateY(12px) scale(0.97);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  .toast i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
    background: var(--accent);
    box-shadow: 0 0 10px 1px rgba(125, 211, 252, 0.5);
  }
  .toast.good i {
    background: var(--good);
    box-shadow: 0 0 10px 1px rgba(134, 239, 172, 0.5);
  }
  .toast.warn i {
    background: var(--warn);
    box-shadow: 0 0 10px 1px rgba(251, 191, 36, 0.5);
  }
  .toast.bad i {
    background: var(--danger);
    box-shadow: 0 0 10px 1px rgba(251, 113, 133, 0.5);
  }
</style>
