// Proofreading is a MODE with its own window. The panes are still a skeleton, but the chrome around them
// is real and worth pinning: a typo'd tab id renders a blank window, and a window that survives a file
// change shows a queue built from frames that no longer exist.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { proofreadWindow, PROOFREAD_TABS } from "./proofreadWindow.svelte.js";

const read = (p) => readFileSync(p, "utf8");

describe("proofread window chrome", () => {
  beforeEach(() => proofreadWindow.reset());

  it("starts closed on its first pane", () => {
    expect(proofreadWindow.open).toBe(false);
    expect(proofreadWindow.tab).toBe(PROOFREAD_TABS[0].id);
  });

  it("only accepts a tab it actually renders", () => {
    proofreadWindow.setTab("judge");
    expect(proofreadWindow.tab).toBe("judge");
    proofreadWindow.setTab("nope");
    expect(proofreadWindow.tab).toBe("judge"); // unchanged, not blanked
  });

  it("showTab raises the window on the pane asked for", () => {
    proofreadWindow.showTab("labels");
    expect(proofreadWindow.open).toBe(true);
    expect(proofreadWindow.tab).toBe("labels");
  });

  it("reset returns it to the launch state — a new file invalidates the queue", () => {
    proofreadWindow.showTab("judge");
    proofreadWindow.reset();
    expect(proofreadWindow.open).toBe(false);
    expect(proofreadWindow.tab).toBe("frames");
  });

  it("every declared tab has an id, a label and a hint", () => {
    const ids = PROOFREAD_TABS.map((t) => t.id);
    expect(ids).toEqual(["frames", "judge", "labels", "keys"]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of PROOFREAD_TABS) {
      expect(typeof t.label).toBe("string");
      expect(t.hint.length).toBeGreaterThan(8);
    }
  });
});

describe("proofread window wiring", () => {
  const app = read("src/App.svelte");
  const win = read("src/lib/components/ProofreadWindow.svelte");

  it("is mounted at App level, like the appearance window", () => {
    expect(app).toContain("<ProofreadWindow />");
    expect(app).toContain('import ProofreadWindow from "./lib/components/ProofreadWindow.svelte"');
  });

  it("entering proofreading mode raises it, from any entry point", () => {
    // an $effect on the mode itself, rather than a call bolted onto one button
    expect(app).toContain("keypointLabels.proofreading");
    expect(app).toContain("proofreadWindow.show()");
    expect(app).toMatch(/if \(on && !wasProofreading\)/);
  });

  it("leaving the mode does NOT close it — the tally is still worth reading", () => {
    expect(app).not.toMatch(/proofreadWindow\.close\(\)/);
  });

  it("a new file resets it — including the LABELS, which are keyed on a key every file has", () => {
    expect(app).toContain("proofreadWindow.reset()");
    expect(app).toContain("framePass.reset()");
    // "videoIdx:frameIdx:inst" collides across files, so the previous file's verdicts would paint red
    // rings onto this one's frames and toCsv() would export two datasets under one schema.
    expect(app).toContain("keypointLabels.clear()");
  });

  it("renders a pane for every declared tab", () => {
    // every tab needs an explicit branch except exactly one, which the final {:else} covers — a tab
    // with neither renders a blank window
    const explicit = PROOFREAD_TABS.filter((t) => win.includes(`proofreadWindow.tab === "${t.id}"`));
    const missing = PROOFREAD_TABS.filter((t) => !explicit.includes(t)).map((t) => t.id);
    expect(missing.length, `tabs with no pane: ${missing.join(", ")}`).toBe(1);
    expect(win).toMatch(/\{:else\}/);
    expect(win).toContain("<WinTabs");
    expect(win).toContain("PROOFREAD_TABS");
  });

  it("the panes still pending spec are visibly placeholders", () => {
    expect(win).toMatch(/border: 1px dashed/); // nobody should mistake an empty pane for a finished one
    expect(win).toMatch(/pending spec/);
  });

  it("the window is gated on the automatic QC and says what to run", () => {
    expect(win).toContain("{#if !ready}");
    expect(win).toContain("qc.proofreadReady");
    expect(win).toContain("qc.proofreadMissing");
    expect(win).toContain("qc.run()"); // the advice comes with the button
    // the queue itself must sit on the ready side of that gate
    const gateEnd = win.indexOf("{:else}", win.indexOf("{#if !ready}"));
    expect(win.indexOf("qc.proofreadRanked")).toBeLessThan(gateEnd); // derived above, fine
    expect(win.indexOf('class="stage"')).toBeGreaterThan(gateEnd);
  });

  it("shows ONE frame at a time, drawn with the same drawer as the viewer", () => {
    expect(win).toMatch(/<canvas\s[\s\S]{0,400}?bind:this=\{canvas\}/);  // one canvas, however it wraps
    expect((win.match(/<canvas/g) ?? []).length, "more than one canvas").toBe(1);
    expect(win).toContain("drawScene(");
    expect(win).toContain("store.getFrameImage(it)");
    expect(win).not.toMatch(/class="grid"/); // the thumbnail grid is gone
    expect(win).not.toMatch(/thumbWhenVisible/);
  });

  it("the frame can be zoomed and panned, not just looked at", () => {
    // It used to be a static contain-fit. The pass is about spotting a wrong pose, but judging a
    // borderline one means leaning in, and sending it to the main viewer to do that loses your place
    // in the queue.
    expect(win).toContain("onwheel={onWheel}");
    expect(win).toContain("onpointerdown={onPointerDown}");
    expect(win).toContain('from "../qc/zoomView.js"');
    expect(win).toContain("panForZoom(");
  });

  it("the view re-fits on every new candidate", () => {
    // Each candidate is a different animal somewhere else in the frame; a view parked where the last
    // one happened to be would open on empty background.
    expect(win).toMatch(/void framePass\.at;[\s\S]{0,120}resetView\(\)/);
  });

  it("no keyboard zoom bindings — digits already toggle keypoints here", () => {
    // A `0` or `+` binding would collide with the labelling keys this window exists for.
    expect(win).not.toMatch(/title="Zoom (in|out) \([+\-0]\)"/);
  });

  it("the pass is keyboard-driven through the ONE existing handler", () => {
    // The window must never dispatch a pass action from a key event — that is the viewer's job, and a
    // second dispatcher would fire every keystroke twice.
    expect(win).not.toMatch(/onkeydown/);
    expect(win).not.toMatch(/(framePass|proofread)\.dispatch/);
    const viewer = read("src/lib/components/Viewer.svelte");
    expect(viewer).toContain("framePass.active ? framePass : proofread");
    expect(viewer).toContain("keybinds.resolve(e)");
  });

  it("a key can be rebound by clicking it, not just by adding another", () => {
    expect(win).toContain("keybinds.replaceKey(id, key, e.key)");
    expect(win).toMatch(/class="cap"[\s\S]{0,120}grab\(e\.id, k\)/); // the keycap IS the button
    expect(win).toContain("grab(e.id)"); // and + key still adds an extra binding
    // the prompt replaces the key you clicked, so you can see which one you are changing
    expect(win).toContain("capturingHere(e.id, k)");
  });

  it("the ONE listener it does add is the rebind grabber: capture-phase, and it swallows the key", () => {
    // Otherwise pressing "f" to rebind something would also mark a keypoint faulty on the way past.
    const at = win.indexOf('addEventListener("keydown"');
    expect(at).toBeGreaterThan(-1);
    expect(win.slice(at, at + 60)).toMatch(/, true\)/); // capture phase — ahead of the viewer
    const eff = win.slice(win.indexOf("if (!capturing) return;"), at);
    expect(eff).toContain("e.stopPropagation()");
    expect(eff).toContain("e.preventDefault()");
    expect(win).toContain("removeEventListener"); // and only while a rebind is pending
  });

  it("digits are usable without memorising the skeleton", () => {
    expect(win).toMatch(/\{#each names as nm, ni/); // a numbered keypoint list
    expect(win).toContain("framePass.toggleKeypointNumber(ni + 1)");
    expect(win).toMatch(/<kbd>\{ni \+ 1\}<\/kbd>/);
    expect(win).toContain("KEYS"); // and a key legend
  });

  it("a multi-animal frame lets you pick which one the digits hit", () => {
    expect(win).toContain("framePass.instances.length > 1");
    expect(win).toContain("framePass.instIdx");
  });

  it("what YOU labelled is shaded red on the frame, distinctly from a detector guess", () => {
    expect(win).toContain("gtFaulty: fset");
    const d = read("src/lib/draw.js");
    expect(d).toMatch(/const GT_FAULTY = "#ff3b30"/);
    expect(d).toMatch(/gtBad = !!gtFaulty\?\.has/);
    // three layers: halo, a red-SHADED dot (not just an outline), and a solid ring
    expect(d).toMatch(/fillStyle = gtBad \? GT_FAULTY : color/);
    expect((d.match(/GT_FAULTY/g) || []).length).toBeGreaterThanOrEqual(4);
    // the detector's guess stays a DASHED ring, so a fact and a guess never look the same
    expect(d).toMatch(/setLineDash\(\[5 \* s, 4 \* s\]\)/);
  });

  it("the chip and the on-canvas mark agree about what faulty looks like", () => {
    expect(win).toMatch(/\.kp\.bad \{[^}]*#ff3b30/); // same red as GT_FAULTY in draw.js
    expect(win).toMatch(/class="badcount"/); // and a per-frame count in the nav
    expect(win).toContain("mine.size"); // this animal's marks, not the whole frame's
  });

  it("the next frame is warmed while you judge this one", () => {
    expect(win).toMatch(/framePass\.queue\[pos \+ 1\]/);
  });

  it("owns no labelling state of its own — the stores keep the work", () => {
    // the comment explains the split, so match imports rather than the word
    const src = read("src/lib/proofreadWindow.svelte.js");
    expect(src).not.toMatch(/^import .*(keypointLabels|proofreadSession|keypointModels)/m);
    expect(src.match(/\$state\(/g).length).toBe(2); // open + tab, nothing else
  });
});

// The pass strip had grown a ten-key reference card, a queue preview, a detector histogram and a
// paragraph explaining the ranking — all under the one thing you actually look at on every candidate.
// Now that Keybinds is a tab, a reference card is what that tab IS.
describe("the pass shows the verdict, not a reference card", () => {
  const win = read("src/lib/components/ProofreadWindow.svelte");

  it("keeps only the four keys the pass runs on", () => {
    const ids = win.match(/const LEGEND_IDS = \[([^\]]*)\]/)[1];
    expect(ids).toContain('"faulty"');
    expect(ids).toContain('"clean"');
    expect(ids).toContain('"next"');
    expect(ids).toContain('"prev"');
    for (const gone of ["toggleKeypoint", "cycleInstance", "nextUnreviewed", "unset", "zoom", "help"]) {
      expect(ids, `${gone} is still printed under every frame`).not.toContain(`"${gone}"`);
    }
    // ...and the full set is one click away, not lost
    expect(win).toContain('proofreadWindow.setTab("keys")');
  });

  it("draws each detector's PERCENTILE, not just its number", () => {
    // "z 4.1" means nothing without knowing what the rest of the file looks like; the bar answers
    // "is this extreme?" before you have finished reading the value.
    expect(win).toContain('class="s-bar"');
    expect(win).toMatch(/style:width="\{Math\.round\(\(p \?\? 0\) \* 100\)\}%"/);
    expect(win).toMatch(/\.s-bar u \{[^}]*left: 95%/s);   // the line the ranking itself uses
  });

  it("still shows every detector, including the calm ones", () => {
    // "GMM is not alarmed about this one" is information; dropping quiet rows would hide it.
    expect(win).toContain("{#each SIGNALS as [k, label, fmt] (k)}");
    expect(win).toContain("class:none={v == null}");
  });

  it("the ranking explainer is collapsed, not printed under every candidate", () => {
    expect(win).toMatch(/<details class="rank-note">/);
    expect(win).toContain("How this order was built");
  });
});
