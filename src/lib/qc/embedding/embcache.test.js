// The embedding cache is the difference between a 20-minute re-run and a 5-second one, and every one
// of its failure modes is SILENT — a swallowed quota error, a dead connection handle, a probe that
// reads a stale number. Those showed up in use as "the cache sometimes disappears and comes back".
// These pin the four behaviours that fix.
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- a minimal in-memory IndexedDB, enough to exercise the real code paths ---------------------
function makeIDB({ quotaAfter = Infinity } = {}) {
  const data = new Map();
  const state = { closed: false, stored: data, txCount: 0, countCalls: 0, cursorCalls: 0 };
  const later = (fn) => queueMicrotask(fn);

  function request(run) {
    const req = { onsuccess: null, onerror: null, result: undefined, error: null };
    later(() => {
      try { req.result = run(); req.onsuccess?.(); }
      catch (e) { req.error = e; req.onerror?.(); }
    });
    return req;
  }

  const db = {
    objectStoreNames: { contains: () => true },
    onclose: null,
    onversionchange: null,
    close() { state.closed = true; },
    transaction(_name, mode) {
      if (state.closed) throw Object.assign(new Error("closing"), { name: "InvalidStateError" });
      state.txCount++;
      const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
      const writes = [];
      const store = {
        put(val, key) { writes.push([key, val]); },
        count(range) {
          state.countCalls++;
          return request(() => [...data.keys()].filter((k) => k >= range.lower && k <= range.upper).length);
        },
        openCursor(range) {
          state.cursorCalls++;
          const keys = [...data.keys()].filter((k) => k >= range.lower && k <= range.upper).sort();
          let i = 0;
          const req = { onsuccess: null, onerror: null, result: null };
          const step = () => {
            if (i >= keys.length) { req.result = null; req.onsuccess?.(); return; }
            const k = keys[i++];
            req.result = { key: k, value: data.get(k), continue: () => later(step) };
            req.onsuccess?.();
          };
          later(step);
          return req;
        },
      };
      if (mode === "readwrite") {
        later(() => {
          if (data.size + writes.length > quotaAfter) {
            tx.error = Object.assign(new Error("quota"), { name: "QuotaExceededError" });
            tx.onabort?.(tx.error);
            return;
          }
          for (const [k, v] of writes) data.set(k, v);
          tx.oncomplete?.();
        });
      }
      tx.objectStore = () => store;
      return tx;
    },
  };

  globalThis.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
  globalThis.indexedDB = {
    open() {
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result: db };
      later(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
      return req;
    },
  };
  return { db, state };
}

async function freshModule() {
  vi.resetModules();                       // the module memoizes its connection
  return import("./embcache.js");
}

const KEYS = (n, file = "f1") => Array.from({ length: n }, (_, i) => [`k${i}`, { emb: new Float32Array(4), thumb: "x" }]);

describe("counting does not deserialize the cache", () => {
  it("countFor asks the database, instead of reading every value out of it", async () => {
    const { state } = makeIDB();
    const { putMany, countFor, loadAll } = await freshModule();
    await putMany("f1", KEYS(50));

    state.cursorCalls = 0; state.countCalls = 0;
    expect(await countFor("f1")).toBe(50);
    // The point of the fix: no cursor, so no structured-clone of 50 (in production, 58,000) values.
    expect(state.countCalls).toBe(1);
    expect(state.cursorCalls).toBe(0);

    // loadAll still exists for the code that genuinely needs the values, and still uses a cursor.
    const m = await loadAll("f1");
    expect(m.size).toBe(50);
    expect(state.cursorCalls).toBeGreaterThan(0);
  });

  it("counts only the partition asked for", async () => {
    makeIDB();
    const { putMany, countFor } = await freshModule();
    await putMany("fileA", KEYS(3));
    await putMany("fileB", KEYS(7));
    expect(await countFor("fileA")).toBe(3);
    expect(await countFor("fileB")).toBe(7);
    expect(await countFor("nope")).toBe(0);
  });

  it("reports -1 rather than 0 when the cache cannot be read at all", async () => {
    globalThis.indexedDB = undefined;
    const { countFor } = await freshModule();
    // 0 would render as "nothing cached, expect a full re-run" — a lie when the truth is "unknown".
    expect(await countFor("f1")).toBe(-1);
  });
});

describe("a write that fails says so", () => {
  it("returns what it managed to persist and why it stopped", async () => {
    makeIDB({ quotaAfter: 2500 });          // fits one 2000-entry chunk, not two
    const { putMany } = await freshModule();
    const r = await putMany("f1", KEYS(5000));
    expect(r.error).toBe("QuotaExceededError");
    expect(r.wrote).toBe(2000);             // the first chunk survived
    expect(r.failed).toBe(3000);
  });

  it("chunks, so a quota wall costs the last chunk and not the whole run", async () => {
    const { state } = makeIDB();
    const { putMany, countFor } = await freshModule();
    const r = await putMany("f1", KEYS(5000));
    expect(r.error).toBeNull();
    expect(r.wrote).toBe(5000);
    expect(state.txCount, "one giant all-or-nothing transaction").toBeGreaterThan(1);
    expect(await countFor("f1")).toBe(5000);
  });

  it("an empty write is not an error", async () => {
    makeIDB();
    const { putMany } = await freshModule();
    expect(await putMany("f1", [])).toEqual({ wrote: 0, failed: 0, error: null });
  });
});

describe("a closed connection reopens instead of dying quietly", () => {
  it("drops the memoized handle on close, so the next call works", async () => {
    const { db, state } = makeIDB();
    const { putMany, countFor } = await freshModule();
    await putMany("f1", KEYS(4));
    expect(await countFor("f1")).toBe(4);

    // What the browser does when another tab forces a version change, or on its own under pressure.
    db.close();
    db.onclose?.();
    state.closed = false;                   // the reopened connection is usable again

    // Without invalidation this returns -1 forever: transaction() throws, the catch swallows it.
    expect(await countFor("f1")).toBe(4);
  });

  it("registers both close and versionchange handlers", async () => {
    const { db } = makeIDB();
    const { countFor } = await freshModule();
    await countFor("f1");
    expect(typeof db.onclose).toBe("function");
    expect(typeof db.onversionchange).toBe("function");
  });
});

describe("persistence is requested, not assumed", () => {
  beforeEach(() => { delete globalThis.navigator; });

  it("asks the browser once and reports the answer", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    globalThis.navigator = { storage: { persisted: vi.fn().mockResolvedValue(false), persist } };
    const { requestPersist } = await freshModule();
    expect(await requestPersist()).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("does not re-ask when already persistent", async () => {
    const persist = vi.fn();
    globalThis.navigator = { storage: { persisted: vi.fn().mockResolvedValue(true), persist } };
    const { requestPersist } = await freshModule();
    expect(await requestPersist()).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it("is harmless where the API does not exist", async () => {
    globalThis.navigator = {};
    const { requestPersist } = await freshModule();
    expect(await requestPersist()).toBe(false);
  });
});
