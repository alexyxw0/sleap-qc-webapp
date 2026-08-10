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
    req.onsuccess = () => {
      _db = req.result;
      // A memoized handle that is never invalidated is a cache that dies silently: once the browser
      // or another tab closes the connection, every later transaction() throws, the catch below turns
      // that into "no cached entries", and it stays that way until a reload. Drop the handle instead,
      // so the next call reopens.
      _db.onclose = () => { _db = null; _opening = null; };
      _db.onversionchange = () => { try { _db.close(); } finally { _db = null; _opening = null; } };
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  }).catch((e) => { _opening = null; throw e; });
  return _opening;
}

const rangeFor = (fileId) => IDBKeyRange.bound(`${fileId}::`, `${fileId}::\uffff`);

/**
 * How many crops are persisted for `fileId`. -1 if the cache cannot be read.
 *
 * Exists because the UI's "already cached" readout only ever wanted a NUMBER, and getting it via
 * loadAll meant structured-cloning every embedding and thumbnail out of IndexedDB — a quarter of a
 * gigabyte deserialized to render one integer. count() answers it in the database.
 */
export async function countFor(fileId) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).count(rangeFor(fileId));
      req.onsuccess = () => resolve(req.result ?? 0);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return -1;
  }
}

/** Ask the browser not to evict this origin. Best-effort and idempotent; safe to call repeatedly. */
export async function requestPersist() {
  try {
    if (!navigator?.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** All persisted crops for `fileId`, as a Map(cropKey -> { emb, thumb }). Empty Map on any failure. */
export async function loadAll(fileId) {
  const out = new Map();
  try {
    const db = await open();
    const prefix = `${fileId}::`;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).openCursor(rangeFor(fileId));
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

// One transaction per this many entries. A full per-keypoint run is ~58,000 crops at ~4 KB each; as a
// single transaction that is a ~240 MB all-or-nothing write, so one QuotaExceededError at the end
// discards a twenty-minute pass. Chunked, a quota wall costs the last chunk and keeps the rest.
const WRITE_CHUNK = 2000;

/**
 * Persist newly-embedded crops. `entries` = [[cropKey, { emb, thumb }], …].
 *
 * Returns { wrote, failed, error } instead of swallowing everything: a run that persisted nothing
 * because the origin hit its quota used to be indistinguishable from one that persisted fine, which is
 * exactly the "the cache disappeared" report this came from.
 */
export async function putMany(fileId, entries) {
  if (!entries?.length) return { wrote: 0, failed: 0, error: null };
  let wrote = 0, error = null;
  try {
    const db = await open();
    for (let i = 0; i < entries.length; i += WRITE_CHUNK) {
      const chunk = entries.slice(i, i + WRITE_CHUNK);
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          const store = tx.objectStore(STORE);
          for (const [key, val] of chunk) store.put(val, `${fileId}::${key}`);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error ?? new Error("aborted"));
        });
        wrote += chunk.length;
      } catch (e) {
        error = e;
        break; // a quota wall will not clear on the next chunk
      }
    }
  } catch (e) {
    error = e;
  }
  return { wrote, failed: entries.length - wrote, error: error ? (error.name || String(error)) : null };
}
