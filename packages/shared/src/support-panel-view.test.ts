/**
 * Epic #1107 (#1110 / A2) — the presentation seam's tests.
 *
 * Every rule that decides what a reader SEES lives in `support-panel-view.ts`
 * and is exercised here with no provider, no DOM and no database, so the two
 * #1109 invariants — `no-signal` never collapses into `low`, and nothing ever
 * removes a finding — are asserted structurally rather than promised in prose.
 */
import { describe, expect, it } from "vitest";
import type { FindingSupportPanel, SupportPanelVote } from "./analysis.js";
import {
  SUPPORT_PANEL_CAVEAT,
  describeSupportPanel,
  formatDissent,
  orderByPanelConfidence,
  renderPublishedConfidenceNote,
  sanitizePanelText,
  summarizeSupportPanels,
  supportPanelRankWeight,
} from "./support-panel-view.js";

const vote = (
  over: Partial<SupportPanelVote> & Pick<SupportPanelVote, "lens">,
): SupportPanelVote => ({
  judgement: "supported",
  discardReason: null,
  citation: "server/src/a.ts:10",
  reasoning: "the excerpt states it",
  counted: true,
  ...over,
});

const panel = (over: Partial<FindingSupportPanel> = {}): FindingSupportPanel => ({
  confidence: "high",
  votes: [vote({ lens: "support" }), vote({ lens: "scope" }), vote({ lens: "currency" })],
  countedVotes: 3,
  supportedVotes: 3,
  unsupportedVotes: 0,
  uncertainVotes: 0,
  noSignalVotes: 0,
  uncitedVotes: 0,
  usage: { promptTokens: 10, completionTokens: 2, llmCalls: 3 },
  ...over,
});

/** 1 supported / 2 unsupported ⇒ the tally's `low`. */
const lowPanel = (): FindingSupportPanel =>
  panel({
    confidence: "low",
    votes: [
      vote({ lens: "support" }),
      vote({
        lens: "scope",
        judgement: "unsupported",
        citation: "server/src/b.ts:4-9",
        reasoning: "one handler is not the whole system",
      }),
      vote({
        lens: "currency",
        judgement: "unsupported",
        citation: "server/src/c.ts:70",
        reasoning: "a later excerpt supersedes this one",
      }),
    ],
    countedVotes: 3,
    supportedVotes: 1,
    unsupportedVotes: 2,
  });

const noSignalPanel = (): FindingSupportPanel =>
  panel({
    confidence: "no-signal",
    votes: [
      vote({
        lens: "support",
        judgement: null,
        discardReason: "no-signal",
        citation: null,
        reasoning: "unparseable: the model returned prose",
        counted: false,
      }),
      vote({
        lens: "scope",
        judgement: null,
        discardReason: "no-signal",
        citation: null,
        reasoning: "unparseable: the model returned prose",
        counted: false,
      }),
      vote({
        lens: "currency",
        judgement: null,
        discardReason: "no-signal",
        citation: null,
        reasoning: "unparseable: the model returned prose",
        counted: false,
      }),
    ],
    countedVotes: 0,
    supportedVotes: 0,
    noSignalVotes: 3,
  });

describe("supportPanelRankWeight", () => {
  it("ranks high above the neutral band and low below it", () => {
    expect(supportPanelRankWeight("high")).toBeGreaterThan(supportPanelRankWeight("medium"));
    expect(supportPanelRankWeight("medium")).toBeGreaterThan(supportPanelRankWeight("low"));
  });

  it("treats `no-signal` and 'no panel ran' as the SAME neutral rank — never as `low`", () => {
    // The #1109 invariant, expressed as a ranking rule: a panel that learned
    // nothing must not push a finding below one it merely doubted.
    expect(supportPanelRankWeight("no-signal")).toBe(supportPanelRankWeight(null));
    expect(supportPanelRankWeight("no-signal")).toBe(supportPanelRankWeight(undefined));
    expect(supportPanelRankWeight("no-signal")).toBeGreaterThan(supportPanelRankWeight("low"));
  });
});

describe("orderByPanelConfidence", () => {
  const item = (id: string, confidence: FindingSupportPanel["confidence"] | null) => ({
    id,
    supportPanel: confidence ? panel({ confidence }) : null,
  });

  it("shifts ORDER: high first, low last", () => {
    const input = [
      item("low-1", "low"),
      item("med-1", "medium"),
      item("high-1", "high"),
      item("nosig-1", "no-signal"),
    ];
    expect(orderByPanelConfidence(input, (i) => i.supportPanel).map((i) => i.id)).toEqual([
      "high-1",
      "med-1",
      "nosig-1",
      "low-1",
    ]);
  });

  it("never drops anything — the output is a permutation of the input", () => {
    const input = [item("a", "low"), item("b", null), item("c", "high"), item("d", "low")];
    const out = orderByPanelConfidence(input, (i) => i.supportPanel);
    expect(out).toHaveLength(input.length);
    expect([...out.map((i) => i.id)].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("is a NO-OP when no finding carries a panel (the flag-off case)", () => {
    const input = [item("a", null), item("b", null), item("c", null)];
    expect(orderByPanelConfidence(input, (i) => i.supportPanel).map((i) => i.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("is stable within a rank, so equal-confidence findings keep their original order", () => {
    const input = [item("x", "medium"), item("y", "medium"), item("z", "medium")];
    expect(orderByPanelConfidence(input, (i) => i.supportPanel).map((i) => i.id)).toEqual([
      "x",
      "y",
      "z",
    ]);
  });

  it("does not mutate the caller's array", () => {
    const input = [item("low-1", "low"), item("high-1", "high")];
    orderByPanelConfidence(input, (i) => i.supportPanel);
    expect(input.map((i) => i.id)).toEqual(["low-1", "high-1"]);
  });
});

describe("describeSupportPanel", () => {
  it("returns null when no panel ran", () => {
    expect(describeSupportPanel(null)).toBeNull();
    expect(describeSupportPanel(undefined)).toBeNull();
  });

  it("names the DISSENTING lens and carries its reason — not just a percentage", () => {
    const summary = describeSupportPanel(lowPanel());
    expect(summary?.headline).toContain("1 of 3 lenses supported this claim");
    expect(summary?.headline).toContain("scope");
    expect(summary?.dissent.map((d) => d.lens)).toEqual(["scope", "currency"]);
    expect(summary?.dissent[0].reasoning).toBe("one handler is not the whole system");
    expect(summary?.dissent[0].citation).toBe("server/src/b.ts:4-9");
  });

  it("marks `low` as second-class but NOT as no-signal", () => {
    const summary = describeSupportPanel(lowPanel());
    expect(summary?.secondClass).toBe(true);
    expect(summary?.noSignal).toBe(false);
  });

  it("renders `no-signal` distinctly from `low`: not second-class, and worded as absent information", () => {
    const summary = describeSupportPanel(noSignalPanel());
    expect(summary?.noSignal).toBe(true);
    expect(summary?.secondClass).toBe(false);
    expect(summary?.headline).toMatch(/could not judge/i);
    expect(summary?.headline).not.toMatch(/dissent/i);
    // The two labels must never produce the same sentence.
    expect(summary?.headline).not.toBe(describeSupportPanel(lowPanel())?.headline);
  });

  it("says a no-signal vote is missing information, never a vote against the finding", () => {
    const summary = describeSupportPanel(
      panel({
        confidence: "medium",
        votes: [
          vote({ lens: "support" }),
          vote({ lens: "scope", judgement: "uncertain", reasoning: "too thin to tell" }),
          vote({
            lens: "currency",
            judgement: null,
            discardReason: "no-signal",
            citation: null,
            reasoning: "degraded",
            counted: false,
          }),
        ],
        countedVotes: 2,
        supportedVotes: 1,
        uncertainVotes: 1,
        noSignalVotes: 1,
      }),
    );
    expect(summary?.caveats.join(" ")).toMatch(/not a vote against/i);
    expect(summary?.discarded.map((d) => d.lens)).toEqual(["currency"]);
  });

  it("reports an uncited verdict as discarded, in either direction", () => {
    const summary = describeSupportPanel(
      panel({
        confidence: "high",
        votes: [
          vote({ lens: "support" }),
          vote({ lens: "scope" }),
          vote({
            lens: "currency",
            judgement: null,
            discardReason: "missing-citation",
            citation: null,
            reasoning: "I just know",
            counted: false,
          }),
        ],
        countedVotes: 2,
        supportedVotes: 2,
        uncitedVotes: 1,
      }),
    );
    expect(summary?.discarded).toEqual([
      { lens: "currency", reason: "missing-citation", detail: "I just know" },
    ]);
    expect(summary?.caveats.join(" ")).toMatch(/without citing/i);
  });

  it("always carries the retrieval caveat, including on `high`", () => {
    expect(describeSupportPanel(panel())?.caveats).toContain(SUPPORT_PANEL_CAVEAT);
    expect(describeSupportPanel(panel())?.headline).toBe("3 of 3 lenses supported this claim.");
  });

  it("uses singular wording for a one-lens panel", () => {
    const summary = describeSupportPanel(
      panel({
        confidence: "high",
        votes: [vote({ lens: "support" })],
        countedVotes: 1,
        supportedVotes: 1,
      }),
    );
    expect(summary?.headline).toBe("1 of 1 lens supported this claim.");
  });

  it("phrases an uncertain lens as uncertain, never as dissent", () => {
    const summary = describeSupportPanel(
      panel({
        confidence: "medium",
        votes: [
          vote({ lens: "support" }),
          vote({ lens: "scope" }),
          vote({ lens: "currency", judgement: "uncertain", reasoning: "cannot tell" }),
        ],
        countedVotes: 3,
        supportedVotes: 2,
        uncertainVotes: 1,
      }),
    );
    expect(summary?.headline).toContain("the currency lens was uncertain");
    expect(summary?.headline).not.toContain("dissented");
  });
});

describe("formatDissent", () => {
  it("renders lens, reason and the grounding locator on one line", () => {
    const d = describeSupportPanel(lowPanel())!.dissent[0];
    expect(formatDissent(d)).toBe(
      "scope lens: one handler is not the whole system (server/src/b.ts:4-9)",
    );
  });

  it("prefixes the finding title when the dissent came from a rollup", () => {
    expect(
      formatDissent({
        lens: "scope",
        judgement: "unsupported",
        citation: "a.ts:1",
        reasoning: "no",
        findingTitle: "Refunds are blocked",
      }),
    ).toBe('scope lens on "Refunds are blocked": no (a.ts:1)');
  });
});

describe("summarizeSupportPanels", () => {
  it("returns null when not one linked finding carries a panel", () => {
    expect(summarizeSupportPanels([{ title: "a" }, { title: "b", supportPanel: null }])).toBeNull();
  });

  it("rolls up to the WORST judged label across the requirement's findings", () => {
    const rollup = summarizeSupportPanels([
      { title: "a", supportPanel: panel({ confidence: "high" }) },
      { title: "b", supportPanel: lowPanel() },
    ]);
    expect(rollup?.confidence).toBe("low");
    expect(rollup?.findingsWithPanel).toBe(2);
    expect(rollup?.lowConfidenceFindings).toBe(1);
  });

  it("does NOT let a no-signal finding outweigh a judged one — absent information is not a verdict", () => {
    const rollup = summarizeSupportPanels([
      { title: "a", supportPanel: panel({ confidence: "high" }) },
      { title: "b", supportPanel: noSignalPanel() },
    ]);
    expect(rollup?.confidence).toBe("high");
    expect(rollup?.noSignalFindings).toBe(1);
  });

  it("rolls up to `no-signal` only when EVERY panel learned nothing", () => {
    const rollup = summarizeSupportPanels([
      { title: "a", supportPanel: noSignalPanel() },
      { title: "b", supportPanel: noSignalPanel() },
    ]);
    expect(rollup?.confidence).toBe("no-signal");
    expect(rollup?.noSignalFindings).toBe(2);
  });

  it("collects dissent across findings, tagged with the finding it came from", () => {
    const rollup = summarizeSupportPanels([
      { title: "Refunds are blocked", supportPanel: lowPanel() },
      { title: "quiet one", supportPanel: panel({ confidence: "high" }) },
    ]);
    expect(rollup?.dissent).toHaveLength(2);
    expect(rollup?.dissent[0].findingTitle).toBe("Refunds are blocked");
  });

  it("caps the collected dissent so a rollup cannot grow without bound", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      title: `f${i}`,
      supportPanel: lowPanel(),
    }));
    expect(summarizeSupportPanels(many)?.dissent.length).toBeLessThanOrEqual(6);
  });

  it("prefers medium over high when both are present", () => {
    const rollup = summarizeSupportPanels([
      { title: "a", supportPanel: panel({ confidence: "high" }) },
      { title: "b", supportPanel: panel({ confidence: "medium" }) },
    ]);
    expect(rollup?.confidence).toBe("medium");
  });
});

describe("renderPublishedConfidenceNote", () => {
  it("publishes NOTHING when the panel did not run — a flag-off issue body is unchanged", () => {
    expect(renderPublishedConfidenceNote(null)).toBeNull();
  });

  it("publishes NOTHING for high or medium confidence — only doubt crosses the boundary", () => {
    const high = summarizeSupportPanels([{ title: "a", supportPanel: panel() }]);
    const medium = summarizeSupportPanels([
      { title: "a", supportPanel: panel({ confidence: "medium" }) },
    ]);
    expect(renderPublishedConfidenceNote(high)).toBeNull();
    expect(renderPublishedConfidenceNote(medium)).toBeNull();
  });

  it("publishes the dissenting check and its reason for a low-confidence requirement", () => {
    const rollup = summarizeSupportPanels([
      { title: "Refunds are blocked", supportPanel: lowPanel() },
    ]);
    const note = renderPublishedConfidenceNote(rollup)!;
    expect(note).toContain("## Confidence");
    expect(note).toContain("low confidence");
    expect(note).toContain("scope check");
    expect(note).toContain("one handler is not the whole system");
    expect(note).toContain("server/src/b.ts:4-9");
    expect(note).toContain(SUPPORT_PANEL_CAVEAT);
  });

  it("publishes a distinct, shorter note when the panel could not judge at all", () => {
    const rollup = summarizeSupportPanels([{ title: "a", supportPanel: noSignalPanel() }]);
    const note = renderPublishedConfidenceNote(rollup)!;
    expect(note).toMatch(/could not/i);
    expect(note).not.toMatch(/low confidence/i);
    expect(note).not.toMatch(/disagree/i);
  });

  it("does not say 'lens' — a work-tracking artefact gets plain language, not internals", () => {
    const rollup = summarizeSupportPanels([{ title: "a", supportPanel: lowPanel() }]);
    expect(renderPublishedConfidenceNote(rollup)).not.toMatch(/\blens\b/i);
  });
});

describe("sanitizePanelText", () => {
  it("collapses newlines so model prose cannot break the markdown block it is embedded in", () => {
    expect(sanitizePanelText("line one\n\n- line two")).toBe("line one - line two");
  });

  it("neutralises backticks and angle brackets", () => {
    expect(sanitizePanelText("`rm -rf` <script>x</script>")).toBe("rm -rf script x /script");
  });

  it("truncates run-away reasoning", () => {
    expect(sanitizePanelText("a".repeat(500)).length).toBeLessThanOrEqual(300);
  });

  it("is empty-safe", () => {
    expect(sanitizePanelText("")).toBe("");
    expect(sanitizePanelText(undefined)).toBe("");
  });
});
