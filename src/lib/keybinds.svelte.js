// keybinds.svelte.js
//
// The LIVE keyboard map, and the only thing that should resolve a proofreading keystroke.
//
// proofreadKeymap.js stays what it always was: the shipped defaults plus pure helpers. This layer adds
// the user's overrides on top, persists them, and hands out a resolver — which is why the comment in that
// file said "a future rebinding UI only has to rewrite `key`".
//
// Persisted as the FULL binding table rather than a diff: settings.merge() validates key-by-key against
// the current defaults, so an action that no longer exists is dropped and a newly-added one picks up its
// default instead of being missing. A stored value that isn't a usable list of keys falls back too — a
// corrupt blob must not leave an action unreachable.
import { PROOFREAD_KEYS, GLOBAL_KEYS, buildKeymap, resolveKey, normKey } from "./qc/proofreadKeymap.js";
import { loadConfig, write as writeSetting, clear as clearSetting } from "./settings.js";

const CONFIG_KEY = "keybinds";
const ALL = [...PROOFREAD_KEYS, ...GLOBAL_KEYS];
const BY_ID = new Map(ALL.map((e) => [e.id, e]));
const DEFAULTS = Object.fromEntries(ALL.map((e) => [e.id, [...e.keys]]));
// Which keymap an action resolves against. `r` is deliberately BOTH exit and enterProofread, so a
// collision only matters inside one scope.
const PROOFREAD_IDS = new Set(PROOFREAD_KEYS.map((e) => e.id));

/** Keys that can never be a binding: they arrive with every chord and would swallow everything. */
const UNBINDABLE = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead", "Unidentified"]);

const clean = (v) =>
  Array.isArray(v) ? [...new Set(v.filter((k) => typeof k === "string" && k.length > 0))] : [];

/** Display form: the event `key` value is right for matching, wrong for reading. */
export function keyLabel(k) {
  if (k === " ") return "Space";
  if (k === "ArrowLeft") return "←";
  if (k === "ArrowRight") return "→";
  if (k === "ArrowUp") return "↑";
  if (k === "ArrowDown") return "↓";
  return k.length === 1 ? k.toUpperCase() : k;
}

class Keybinds {
  /** actionId -> keys[]. Seeded from defaults, overlaid with whatever survived validation. */
  bindings = $state({ ...DEFAULTS });

  constructor() {
    const { config } = loadConfig(CONFIG_KEY, DEFAULTS);
    for (const id of Object.keys(DEFAULTS)) {
      const c = clean(config[id]);
      this.bindings[id] = c.length ? c : [...DEFAULTS[id]];
    }
  }

  #save() { writeSetting(CONFIG_KEY, { ...this.bindings }); }

  keysFor(id) { return this.bindings[id] ?? BY_ID.get(id)?.keys ?? []; }
  isDefault(id) {
    const a = this.keysFor(id), b = DEFAULTS[id] ?? [];
    return a.length === b.length && a.every((k, i) => k === b[i]);
  }
  get anyCustom() { return Object.keys(DEFAULTS).some((id) => !this.isDefault(id)); }

  /** The shipped entries with the user's keys substituted — what the resolver and the legend read. */
  get entries() { return PROOFREAD_KEYS.map((e) => ({ ...e, keys: this.keysFor(e.id) })); }
  get globalEntries() { return GLOBAL_KEYS.map((e) => ({ ...e, keys: this.keysFor(e.id) })); }
  /** Everything, for the editor. */
  get allEntries() { return [...this.entries, ...this.globalEntries]; }

  #map = $derived(buildKeymap(this.entries));
  #globalMap = $derived(buildKeymap(this.globalEntries));

  /** Resolve a keystroke while proofreading. */
  resolve(event) { return resolveKey(event, this.#map); }
  /** Resolve a keystroke when proofreading is OFF (entering the mode). */
  resolveGlobal(event) { return resolveKey(event, this.#globalMap); }

  /** Which action currently owns this key, if any. Two actions on one key = the second never fires. */
  ownerOf(key, exceptId = null) {
    const want = normKey(key);
    for (const e of this.allEntries) {
      if (e.id === exceptId) continue;
      if (e.keys.some((k) => normKey(k) === want)) return e;
    }
    return null;
  }

  /** Can this key be bound at all? `replacing` is the key being swapped out, if any.
   *  -> null when fine, else why not. */
  rejectReason(id, key, replacing = null) {
    if (BY_ID.get(id)?.fixed) return "this action's keys are fixed";
    if (!key || UNBINDABLE.has(key)) return "that key can't be bound on its own";
    if (replacing != null && key === replacing) return null; // pressed the same key — a no-op, not an error
    if (this.keysFor(id).includes(key)) return `already bound to ${BY_ID.get(id)?.label ?? id}`;
    const owner = this.ownerOf(key, id);
    if (owner) return `${keyLabel(key)} is taken by "${owner.label}"`;
    return null;
  }

  /** Add a key to an action. -> null on success, else the reason it was refused. */
  addKey(id, key) {
    const why = this.rejectReason(id, key);
    if (why) return why;
    this.bindings[id] = [...this.keysFor(id), key];
    this.#save();
    return null;
  }

  /** Swap one binding for another IN PLACE — clicking a key and pressing a new one. Keeping the position
   *  matters: the first key in the list is the one legends show, so a rebind must not silently demote it. */
  replaceKey(id, oldKey, newKey) {
    const why = this.rejectReason(id, newKey, oldKey);
    if (why) return why;
    if (newKey === oldKey) return null;
    const keys = this.keysFor(id);
    const at = keys.indexOf(oldKey);
    if (at < 0) return "that key is no longer bound";
    const next = [...keys];
    next[at] = newKey;
    this.bindings[id] = next;
    this.#save();
    return null;
  }

  /** Remove one key. Refuses to leave an action unreachable. */
  removeKey(id, key) {
    if (BY_ID.get(id)?.fixed) return "this action's keys are fixed";
    const next = this.keysFor(id).filter((k) => k !== key);
    if (!next.length) return "an action needs at least one key";
    this.bindings[id] = next;
    this.#save();
    return null;
  }

  /** Restoring a default can COLLIDE: the key may have been handed to someone else while this action
   *  was off it. The default owner wins and takes it back — but only within its own keymap, and never
   *  by leaving the loser with nothing. */
  resetAction(id) {
    this.bindings[id] = [...(DEFAULTS[id] ?? [])];
    const scope = PROOFREAD_IDS.has(id) ? PROOFREAD_KEYS : GLOBAL_KEYS;
    const mine = new Set(this.keysFor(id).map(normKey));
    for (const e of scope) {
      if (e.id === id || e.fixed) continue;
      const cur = this.keysFor(e.id);
      const next = cur.filter((k) => !mine.has(normKey(k)));
      if (next.length === cur.length) continue;
      // Never strand an action: if reclaiming took its last key, fall back to whatever of its own
      // defaults is still free.
      this.bindings[e.id] = next.length ? next : DEFAULTS[e.id].filter((k) => !mine.has(normKey(k)));
    }
    this.#save();
  }
  resetAll() {
    for (const id of Object.keys(DEFAULTS)) this.bindings[id] = [...DEFAULTS[id]];
    clearSetting(CONFIG_KEY);
  }
}

export const keybinds = new Keybinds();
export { DEFAULTS as KEYBIND_DEFAULTS, UNBINDABLE };
