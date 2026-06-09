// Review session: the keyboard-driven accept/reject/correct/skip loop, progress/ETA, and
// per-session summary (TDD stub — see review.test.js). Pure (no Svelte) for testability;
// a thin .svelte.js store will wrap it later.

const NOT_IMPL = () => {
  throw new Error("not implemented");
};

export class ReviewSession {
  /**
   * @param keypoints array of per-keypoint records (need keypointKey + node_name; may
   *        carry an initial review_state).
   * @param opts.now injectable clock returning ms (for deterministic ETA tests).
   */
  constructor(_keypoints, _opts) {
    NOT_IMPL();
  }

  get total() {
    return NOT_IMPL();
  }

  /** Review state for a keypoint key ("unreviewed" by default). */
  stateOf(_key) {
    return NOT_IMPL();
  }

  accept(_key) {
    return NOT_IMPL();
  }
  reject(_key) {
    return NOT_IMPL();
  }
  correct(_key) {
    return NOT_IMPL();
  }
  skip(_key) {
    return NOT_IMPL();
  }

  /** Revert the most recent decision. */
  undo() {
    return NOT_IMPL();
  }

  /** { unreviewed, accepted, rejected, corrected, skipped, done }. */
  get counts() {
    return NOT_IMPL();
  }

  /** { done, total, remaining, fraction }. done = accepted+rejected+corrected. */
  get progress() {
    return NOT_IMPL();
  }

  /** Estimated seconds remaining from rolling decision pace; null with <2 decisions. */
  etaSeconds() {
    return NOT_IMPL();
  }

  /** Per node_name rollup: { [node]: {accepted,rejected,corrected,skipped,decided,rejectRate} }. */
  summary() {
    return NOT_IMPL();
  }

  /** Node types whose reject-rate ≥ threshold over ≥ minCount decisions (systematic issues). */
  systematicIssues(_opts) {
    return NOT_IMPL();
  }
}
