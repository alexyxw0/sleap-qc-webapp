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
 * Parse a manual-check CSV. Recognizes columns `video`, `frame_idx`, `status`
 * (faulty | not_faulty) and/or `n_faulty`, and `notes`. Returns
 * `{ byKey: Map<"v:f", {faulty, notes}>, faulty, total }` or `{ error }`.
 */
export function parseManualCheck(text) {
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return { error: "CSV is empty or has no data rows." };
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const vi = findCol(header, "video", "video_idx");
  const fi = findCol(header, "frame_idx", "frameidx", "frame_index");
  const si = findCol(header, "status");
  const nfi = findCol(header, "n_faulty");
  const noi = findCol(header, "notes", "comment", "comments");
  if (fi < 0) return { error: "No frame_idx / frame_index column found." };
  if (si < 0 && nfi < 0) return { error: "No status or n_faulty column found." };

  const byKey = new Map();
  let faulty = 0;
  for (let r = 1; r < lines.length; r++) {
    const cells = splitCsvLine(lines[r]);
    const frameIdx = parseInt(cells[fi], 10);
    if (!Number.isFinite(frameIdx)) continue;
    const video = vi >= 0 ? parseInt(cells[vi], 10) || 0 : 0;
    const status = si >= 0 ? (cells[si] ?? "").trim().toLowerCase() : "";
    const isFaulty = si >= 0 ? status === "faulty" : (parseInt(cells[nfi], 10) || 0) > 0;
    const notes = noi >= 0 ? (cells[noi] ?? "").trim() : "";
    byKey.set(`${video}:${frameIdx}`, { faulty: isFaulty, notes });
    if (isFaulty) faulty++;
  }
  return { byKey, faulty, total: byKey.size };
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
