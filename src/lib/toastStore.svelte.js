// toastStore.svelte.js
//
// Minimal ephemeral notification queue. Components push with toast(); the Toasts
// component renders whatever is live. Each toast auto-expires.

let nextId = 1;

class ToastStore {
  items = $state([]);

  push(message, { kind = "info", ttl = 3800 } = {}) {
    const id = nextId++;
    this.items = [...this.items, { id, message, kind }];
    setTimeout(() => this.dismiss(id), ttl);
    return id;
  }

  dismiss(id) {
    this.items = this.items.filter((t) => t.id !== id);
  }
}

export const toasts = new ToastStore();
export const toast = (message, opts) => toasts.push(message, opts);
