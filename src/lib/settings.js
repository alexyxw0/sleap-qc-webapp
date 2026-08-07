// Persist user configuration across sessions (localStorage). PURE + testable — no Svelte, no globals
// beyond `localStorage`, which is injectable for tests.
//
// The whole risk of persisted config is a STALE or HOSTILE payload silently changing behaviour: a key that
// no longer exists, a threshold that is now a string, a `checks` entry for a detector that was renamed.
// So nothing is trusted verbatim — `merge()` keeps only keys present in the CURRENT defaults and only when
// the stored value has the same shape, and every restore is reported so a partial load is visible rather
// than mysterious. A corrupt blob degrades to defaults instead of throwing on boot.

const PREFIX = "sleap-qc:";
const VERSION = 1; // bump to invalidate every stored config after an incompatible change

function storage(inject) {
  if (inject) return inject;
  try {
    // absent under SSR; throws in some privacy modes merely on ACCESS, hence the try
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

const fullKey = (key) => `${PREFIX}v${VERSION}:${key}`;

/** Read a stored object. Returns null when absent, unreadable, or not a JSON object. */
export function read(key, inject) {
  const s = storage(inject);
  if (!s) return null;
  try {
    const raw = s.getItem(fullKey(key));
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null; // corrupt / unparseable -> behave as if nothing was saved
  }
}

/** Write an object. Returns false when storage is unavailable or full — never throws. */
export function write(key, value, inject) {
  const s = storage(inject);
  if (!s) return false;
  try {
    s.setItem(fullKey(key), JSON.stringify(value));
    return true;
  } catch {
    return false; // quota exceeded / privacy mode
  }
}

export function clear(key, inject) {
  const s = storage(inject);
  if (!s) return false;
  try {
    s.removeItem(fullKey(key));
    return true;
  } catch {
    return false;
  }
}

/** Same primitive shape? Objects compare loosely (plain object vs plain object) — values are merged
 *  key-wise one level down by `merge`, so a per-key type check there does the real work. */
function sameShape(a, b) {
  if (a === null || b === null) return a === b;
  const ta = Array.isArray(a) ? "array" : typeof a;
  const tb = Array.isArray(b) ? "array" : typeof b;
  return ta === tb;
}

/**
 * Merge a stored config over defaults, keeping ONLY keys that still exist in `defaults` and whose stored
 * value has the same shape. One level of nesting is merged key-wise (that's `checks`), so adding a NEW
 * detector picks up its default rather than being dropped, and a REMOVED detector in an old payload is
 * ignored rather than resurrected.
 *
 * -> { config, restored: [keys], dropped: [keys] }  (`dropped` = present in storage but rejected)
 */
export function merge(defaults, stored) {
  const config = { ...defaults };
  const restored = [], dropped = [];
  if (!stored || typeof stored !== "object") return { config, restored, dropped };
  for (const [k, v] of Object.entries(stored)) {
    if (!(k in defaults)) { dropped.push(k); continue; }
    const d = defaults[k];
    if (!sameShape(d, v)) { dropped.push(k); continue; }
    if (d && typeof d === "object" && !Array.isArray(d)) {
      const sub = { ...d };
      let touched = false;
      for (const [sk, sv] of Object.entries(v)) {
        if (!(sk in d) || !sameShape(d[sk], sv)) { dropped.push(`${k}.${sk}`); continue; }
        sub[sk] = sv;
        touched = true;
      }
      config[k] = sub;
      if (touched) restored.push(k);
    } else {
      config[k] = v;
      restored.push(k);
    }
  }
  return { config, restored, dropped };
}

/** Convenience: read + merge in one call. */
export function loadConfig(key, defaults, inject) {
  return merge(defaults, read(key, inject));
}
