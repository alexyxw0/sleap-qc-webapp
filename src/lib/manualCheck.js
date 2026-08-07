// Parse a "manual check" CSV (a human review of each frame: faulty / not-faulty + notes) and
// compare it against the QC checker's per-frame verdict. Pure + testable — the Svelte component
// supplies the QC flags. Frames are matched by `<video>:<frame_idx>`.

/** Split one CSV line, honoring double-quoted fields (notes may contain commas). */
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const findCol = (header, ...names) => {
  for (const n of names) {
    const i = header.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
};

/**
 * Parse a manual-check CSV, matching frames by `<video>:<frame_idx>`. FRAME-LEVEL only (keypoint-level
 * detail is ignored). Handles two schemas:
 *   - per-frame (faulty_labels.csv): lists ALL reviewed frames; faulty is read from `status`
 *     (faulty | not_faulty) or `n_faulty` (>0).
 *   - faulty_keypoints.csv: lists ONLY reviewed-FAULTY frames, one row per instance (a clean-instance row,
 *     n_bad_keypoints=0, still means its FRAME was flagged faulty). So every PRESENT frame is faulty.
 * Rows are aggregated to FRAME level (OR); notes merged. Returns `{ byKey: Map<"v:f", {faulty, notes}>,
 * faulty, total }` or `{ error }`.
 */
export function parseManualCheck(text) {
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return { error: "CSV is empty or has no data rows." };
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const vi = findCol(header, "video", "video_idx");
  const fi = findCol(header, "frame_idx", "frameidx", "frame_index");
  const si = findCol(header, "status");
  const nfi = findCol(header, "n_faulty"); // per-FRAME faulty count (all-frames schema)
  const kpSchema = findCol(header, "n_bad_keypoints") >= 0 || findCol(header, "bad_keypoints") >= 0;
  const noi = findCol(header, "notes", "note", "comment", "comments");
  if (fi < 0) return { error: "No frame_idx / frame_index column found." };
  if (si < 0 && nfi < 0 && !kpSchema)
    return { error: "No status, n_faulty, or bad-keypoint column found." };

  const byKey = new Map();
  for (let r = 1; r < lines.length; r++) {
    const cells = splitCsvLine(lines[r]);
    const frameIdx = parseInt(cells[fi], 10);
    if (!Number.isFinite(frameIdx)) continue;
    const video = vi >= 0 ? parseInt(cells[vi], 10) || 0 : 0;
    // keypoint schema lists only faulty frames -> presence ⇒ faulty; else read the per-frame verdict.
    const rowFaulty = si >= 0 ? (cells[si] ?? "").trim().toLowerCase() === "faulty"
      : nfi >= 0 ? (parseInt(cells[nfi], 10) || 0) > 0
      : true;
    const note = noi >= 0 ? (cells[noi] ?? "").trim() : "";
    const key = `${video}:${frameIdx}`;
    const prev = byKey.get(key);
    byKey.set(key, {
      faulty: (prev?.faulty ?? false) || rowFaulty, // OR across a frame's instance-rows
      notes: [prev?.notes, note].filter(Boolean).join("; "),
    });
  }
  let faulty = 0;
  for (const v of byKey.values()) if (v.faulty) faulty++;
  // faultyOnly ⇒ the file enumerates only faulty frames (keypoint schema, no status/n_faulty), so any frame
  // NOT listed was reviewed-clean — the comparison can treat unmatched frames as clean true-negatives.
  return { byKey, faulty, total: byKey.size, faultyOnly: si < 0 && nfi < 0 };
}

/** Agreement metrics from the 2x2 counts (QC flagged vs manual faulty). */
export function metrics({ both, qcOnly, manualOnly, neither }) {
  const n = both + qcOnly + manualOnly + neither;
  const qcFlagged = both + qcOnly;
  const manualFaulty = both + manualOnly;
  const precision = qcFlagged ? both / qcFlagged : 0; // of QC's flags, fraction the human agrees are faulty
  const recall = manualFaulty ? both / manualFaulty : 0; // of human-faulty, fraction QC caught
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const accuracy = n ? (both + neither) / n : 0;
  // Cohen's kappa — agreement beyond chance.
  const pe = n ? (qcFlagged / n) * (manualFaulty / n) + ((n - qcFlagged) / n) * ((n - manualFaulty) / n) : 0;
  const kappa = pe < 1 ? (accuracy - pe) / (1 - pe) : 0;
  return { both, qcOnly, manualOnly, neither, n, qcFlagged, manualFaulty, precision, recall, f1, accuracy, kappa };
}

/**
 * Confusion of two boolean sets over matched frames.
 * `pairs`: `[{ qc: boolean, manual: boolean }]`. Returns counts + agreement metrics.
 */
export function confusion(pairs) {
  let both = 0, qcOnly = 0, manualOnly = 0, neither = 0;
  for (const p of pairs) {
    if (p.qc && p.manual) both++;
    else if (p.qc) qcOnly++;
    else if (p.manual) manualOnly++;
    else neither++;
  }
  return metrics({ both, qcOnly, manualOnly, neither });
}

/**
 * Parse the PER-KEYPOINT rows of a reviewed `faulty_keypoints.csv` into the source-agnostic shape
 * `keypointLabels.ingest()` wants: `[{ video, frameIdx, inst, bad: [nodeNames] }]`, one row per REVIEWED
 * instance.
 *
 * `parseManualCheck` above is deliberately frame-level (it answers "is this frame faulty?"). This keeps the
 * `bad_keypoints` column that one discards, which is what per-keypoint few-shot adaptation needs.
 *
 * Schema notes: `bad_keypoints` is a `;`-separated list of node NAMES ("" / absent = this instance was
 * reviewed and found clean). Every row is a reviewed instance, so a node missing from `bad` is a genuine
 * NEGATIVE for that node. Returns { rows, nodes, error? }.
 */
export function parseKeypointLabels(text) {
  const lines = String(text ?? "").split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { error: "Empty file.", rows: [], nodes: [] };
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/^﻿/, ""));
  const vi = findCol(header, "video", "video_idx");
  const fi = findCol(header, "frame_idx", "frameidx");
  const ii = findCol(header, "instance", "instance_idx", "inst");
  const bi = findCol(header, "bad_keypoints", "bad_nodes");
  if (bi < 0) return { error: "No bad_keypoints column — this isn't a per-keypoint review export.", rows: [], nodes: [] };
  if (fi < 0 || ii < 0) return { error: "Need frame_idx and instance columns.", rows: [], nodes: [] };

  const rows = [];
  const nodes = new Set();
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    const frameIdx = parseInt(c[fi], 10);
    const inst = parseInt(c[ii], 10);
    if (!Number.isFinite(frameIdx) || !Number.isFinite(inst)) continue;
    const video = vi >= 0 ? parseInt(c[vi], 10) || 0 : 0;
    const bad = String(c[bi] ?? "").split(";").map((s) => s.trim()).filter(Boolean);
    for (const n of bad) nodes.add(n);
    rows.push({ video, frameIdx, inst, bad });
  }
  return { rows, nodes: [...nodes] };
}
