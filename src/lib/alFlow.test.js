// THE TWO-ACTION RULE, enforced twice: once on the model, and once on what the model actually renders.
//
// The model half is cheap and total — every reachable page, every action counted. The render half is
// the one that matters, because a page could always grow a third button in markup the model never
// heard of. Svelte's server renderer runs the same $derived chain the browser does, so rendering the
// component in each state and counting the interactive elements is the real question being asked.
//
// What counts as an action: anything that changes state when you use it — a button, a file input, a
// checkbox. What does not:
//   - the step strip and the single back button (navigation: they move you, they answer nothing),
//   - the Explain disclosure (it reveals prose),
//   - the result viewer on the terminal step (it reads the run; it does not advance the flow).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { render } from "svelte/server";
import { MAX_ACTIONS, flowPage, backTargetField, allComputeStates, GRAN_ACTIONS } from "./qc/alFlow.js";

/** More steps than the answer stack is deep — a loop would blow past this. */
const ORDER_MAX = 12;

describe("the flow model", () => {
  it("never offers more than two actions on a page", () => {
    for (const s of allComputeStates()) {
      const p = flowPage(s);
      expect(p.actions.length, `${p.id} offers ${p.actions.map((a) => a.id).join(", ")}`)
        .toBeLessThanOrEqual(MAX_ACTIONS);
    }
  });

  it("asks exactly one question per page, and every page has an id and a question", () => {
    for (const s of allComputeStates()) {
      const p = flowPage(s);
      expect(typeof p.id, JSON.stringify(s)).toBe("string");
      expect(p.question.length, p.id).toBeGreaterThan(0);
      expect(p.question.split("?").length - 1, `${p.id} asks more than one question`).toBeLessThanOrEqual(1);
    }
  });

  it("gives every action a distinct id, so a page cannot render the same one twice", () => {
    for (const s of allComputeStates()) {
      const p = flowPage(s);
      expect(new Set(p.actions.map((a) => a.id)).size, p.id).toBe(p.actions.length);
    }
  });

  it("reaches every page of the flow from some state — none is unreachable code", () => {
    const seen = new Set(allComputeStates().map((s) => flowPage(s).id));
    for (const id of ["scope", "embed", "use", "score.kind", "score.unsup", "score.done",
                      "score.node", "score.source", "score.upload", "score.label", "score.keep"]) {
      expect(seen, `${id} is unreachable`).toContain(id);
    }
  });

  it("back pops the DEEPEST answer — not merely some answer", () => {
    // "Exactly one field changed" is too weak: jumping from the upload page straight back to the
    // technique question also changes exactly one field, and skips two questions on the way.
    const ORDER = ["route", "gran", "step", "scoreKind", "unsupChoice", "scoreNode", "svmSource"];
    const isSet = (s, k) =>
      k === "step" ? s.step !== "embed"
        : k === "scoreNode" ? s.gran === "node" && s.scoreNode != null
          : k === "svmSource" ? s.gran === "node" && s.svmSource != null
            : s[k] != null;
    for (const s of allComputeStates()) {
      const deepest = [...ORDER].reverse().find((k) => isSet(s, k));
      expect(backTargetField(s), `back from ${flowPage(s).id} skipped past ${deepest}`).toBe(deepest);
    }
  });

  it("back applied repeatedly walks out of the route rather than looping", () => {
    for (const start of allComputeStates()) {
      let s = { ...start };
      for (let i = 0; i < ORDER_MAX; i++) {
        const field = backTargetField(s);
        if (field == null) break;
        if (field === "route") { s.route = null; break; }
        else if (field === "step") s.step = s.step === "use" ? "score" : "embed";
        else if (field === "gran") s.gran = null;
        else s[field] = null;
      }
      expect(s.route, `back looped from ${flowPage(start).id}`).toBeNull();
    }
  });

  it("the scope question is the granularity question — the two are not separate any more", () => {
    expect(flowPage({ gran: null, step: "embed" }).id).toBe("scope");
    expect(GRAN_ACTIONS.map((a) => a.id)).toEqual(["gran:instance", "gran:node"]);
  });

  it("whole instance reaches the unsupervised scorers, which used to be per-keypoint only", () => {
    const st = { route: "compute", gran: "instance", step: "score", scoreKind: "unsup",
                 unsupChoice: null, scoreNode: null, svmSource: null, trained: false };
    expect(flowPage(st).id).toBe("score.unsup");
    expect(flowPage(st).actions.map((a) => a.id)).toEqual(["unsup:knn", "unsup:anomalyDino"]);
  });
});

// ---------------------------------------------------------------------------------------------------
// The render half. This is what the model claims, checked against what the component draws.

vi.mock("./qc/embedding/dinoRemote.js", () => ({
  MODEL: { name: "test", input: 224, batch: 8 },
  ensureModel: async () => ({ name: "test" }),
  embedBatch: async () => ({ embs: [], patches: [] }),
}));

const { appRun } = await import("./appearanceRun.svelte.js");
const { store } = await import("./labelsStore.svelte.js");
const AppearanceWindow = (await import("./components/AppearanceWindow.svelte")).default;

/** Interactive elements in the flow pane — the inspector and the nav are not the flow's actions. */
function actionsIn(html) {
  // Drop the parts that are deliberately exempt, by the class the markup marks them with. The window's
  // own title bar goes too: its ✕ closes the window rather than answering anything, exactly like the
  // step strip and the back button beneath it.
  const flow = html.replace(/<div class="bar[\s\S]*?<\/div>/g, "")
    .replace(/<nav class="flow[\s\S]*?<\/nav>/g, "")
    .replace(/<section class="results[\s\S]*$/g, "")
    // A container the markup declares as one selection over a homogeneous list collapses to a single
    // action, however many chips it draws — thirteen keypoint chips are one multi-select, not thirteen
    // decisions. The markup says so with data-action-group; this does not infer it from a class name.
    .replace(/<div [^>]*data-action-group="([^"]+)"[\s\S]*?<\/div>/g, "<button data-group=\"$1\">");
  const found = [];
  for (const m of flow.matchAll(/<(button|input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2];
    if (/class="[^"]*\bex-h\b/.test(attrs)) continue;         // the Explain disclosure
    if (/type="(hidden)"/.test(attrs)) continue;
    found.push(m[0].slice(0, 90));
  }
  return found;
}

describe("what the flow actually renders", () => {
  beforeEach(() => {
    appRun.open = true;
    // A skeleton, or the keypoint chips render nothing and the embed page passes this test by drawing
    // less than it does in the app. The fixture has to be at least as rich as the state being asserted
    // about, otherwise the count is measuring the fixture. (store.skeleton is derived from labels.)
    store.labels = { videos: [], skeletons: [{ nodeNames: ["nose", "ear_l", "ear_r", "tail_base", "tail_tip"] }] };
    store.frames = [];
  });

  /** Put the flow into a state and render it. */
  function at(s) {
    appRun.route = "compute";
    appRun.gran = s.gran;
    appRun.tab = s.step === "embed" ? "compute" : s.step;
    appRun.scoreKind = s.scoreKind;
    appRun.unsupChoice = s.unsupChoice;
    appRun.scoreNode = s.scoreNode;
    appRun.svmSource = s.svmSource;
    return { page: appRun.flow, body: render(AppearanceWindow, { props: {} }).body };
  }

  it("draws at most two actions on every page it can reach", () => {
    for (const s of allComputeStates()) {
      const { page, body } = at(s);
      const acts = actionsIn(body);
      expect(acts.length, `${page.id} drew ${acts.length}:\n  ${acts.join("\n  ")}`)
        .toBeLessThanOrEqual(MAX_ACTIONS);
    }
  });

  it("...and the count is measuring the PAGE, not an empty fixture", () => {
    // A test that only ever sees zero or one control would pass with the rule deleted. The keypoint
    // page draws its chips and the embed page draws chips AND the run button, so the ceiling is
    // actually being approached somewhere.
    const counts = allComputeStates().map((s) => actionsIn(at(s).body).length);
    expect(Math.max(...counts), "no page draws two — the fixture is too thin to be testing anything")
      .toBe(MAX_ACTIONS);
  });

  it("renders SOMETHING on every page — an empty pane is not linear, it is broken", () => {
    const blank = [];
    for (const s of allComputeStates()) {
      const { page, body } = at(s);
      // the question is what identifies the page to the reader; every pane must print one
      if (!body.includes("s-q")) blank.push(page.id);
    }
    expect(blank, `pages with no question rendered: ${[...new Set(blank)].join(", ")}`).toEqual([]);
  });

  it("the fork itself is two cards and nothing else", () => {
    appRun.route = null;
    const { body } = render(AppearanceWindow, { props: {} });
    expect(actionsIn(body)).toHaveLength(2);
  });
});

describe("the rule is written down where the next person will look", () => {
  it("alFlow.js states the limit and what is exempt from it", () => {
    const src = readFileSync("src/lib/qc/alFlow.js", "utf8");
    expect(src).toMatch(/AT MOST TWO actions/);
    expect(src).toMatch(/NAVIGATION/);
    expect(src).toMatch(/INSPECTOR/);
    expect(MAX_ACTIONS).toBe(2);
  });
});
