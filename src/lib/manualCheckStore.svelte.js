// Holds the uploaded manual-check CSV OUTSIDE the ManualCheckCompare component, so it survives the
// panel being collapsed (the collapsible unmounts the component, which would otherwise drop the upload).
class ManualCheckState {
  manual = $state(null); // parseManualCheck result: { byKey, faulty, total } | { error } | null
  fileName = $state(""); // uploaded file name (for the header chip)

  // MUST be called on file load: the CSV is matched to frames by "videoIdx:frameIdx", so a stale upload
  // from a previously-loaded file would silently score the wrong file. (App.svelte's file-change effect
  // clears this alongside qc.reset(); component-local state used to be dropped on unmount, this isn't.)
  reset() { this.manual = null; this.fileName = ""; }
}

export const manualCheck = new ManualCheckState();
