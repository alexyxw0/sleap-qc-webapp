// Persistent (IndexedDB) store for DINO crop embeddings, so re-running the appearance check on the
// SAME file — even after a full page reload — reuses prior work instead of re-embedding (the minutes-
// long part). The in-memory Map in embeddingStore is the hot cache; this just hydrates it on load and
// writes new crops back. Degrades gracefully: ANY IndexedDB failure (private mode, quota, no support)
// is swallowed and the caller falls back to the in-memory cache, so behaviour never regresses.
//
// Key = "<fileId>::<cropKey>"; value = { emb: Float32Array(384), thumb: dataURL string } (both survive
// the structured clone IndexedDB uses). fileId identifies the file; cropKey identifies the crop within
// it — a crop's embedding is fully determined by (file, video, frame, bbox), so the key is its identity.

const DB_NAME = "sleap-qc";
const STORE = "dino-emb";
const VERSION = 1;

let _db = null;
let _opening = null;

function open() {
  if (_db) return Promise.resolve(_db);
  if (_opening) return _opening;
  _opening = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no IndexedDB"));
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  }).catch((e) => { _opening = null; throw e; });
  return _opening;
}

/** All persisted crops for `fileId`, as a Map(cropKey -> { emb, thumb }). Empty Map on any failure. */
export async function loadAll(fileId) {
  const out = new Map();
  try {
    const db = await open();
    const prefix = `${fileId}::`;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).openCursor(IDBKeyRange.bound(prefix, prefix + "￿"));
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve();
        out.set(String(cur.key).slice(prefix.length), cur.value);
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch { /* no-op: caller falls back to the in-memory cache */ }
  return out;
}

/** Persist newly-embedded crops. `entries` = [[cropKey, { emb, thumb }], …]. Silent on failure. */
export async function putMany(fileId, entries) {
  if (!entries?.length) return;
  try {
    const db = await open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const [key, val] of entries) store.put(val, `${fileId}::${key}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* no-op */ }
}
