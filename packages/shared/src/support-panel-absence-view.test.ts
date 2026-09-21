/**
 * Epic #1107 (#1111 / A3) — the ABSENCE verdict's presentation, tested at the
 * one seam every surface reads.
 *
 * The property under test throughout: **`unexamined` never reads as
 * `supported`.** The two must not share a badge, a sentence, a rank or a
 * published line — because #773's entire cost was that "we looked and found
 * nothing" and "we never looked" produced identical text.
 */
import { describe, expect, it } from "vitest";
import type { FindingAbsenceCheck, FindingSupportPanel, SupportPanelVote } from "./analysis.js";
import { findingSupportPanelSchema } from "./analysis.js";
import {
  ABSENCE_CHECK_COPY,
  describeAbsenceCheck,
  describeSupportPanel,
  renderPublishedConfidenceNote,
  summarizeSupportPanels,
  SUPPORT_PANEL_CAVEAT,
} from "./support-panel-view.js";

const CITE = "server/src/lib/change-analysis/change-analysis-engine.ts:131";

const check = (over: Partial<FindingAbsenceCheck> = {}): FindingAbsenceCheck => ({
  verdict: "supported",
  citation: CITE,
  reasoning: "the router enumerates every route and none provisions users",
  downgradedFrom: null,
  noSignalReason: null,
  ...over,
});

const vote = (
  over: Partial<SupportPanelVote> & Pick<SupportPanelVote, "lens">,
): SupportPanelVote => ({
  judgement: "supported",
  discardReason: null,
  citation: CITE,
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
  usage: { promptTokens: 10, completionTokens: 2, llmCalls: 4 },
  ...over,
});

describe("describeAbsenceCheck (#1111)", () => {
  it("returns null when the finding is not an absence claim", () => {
    expect(describeAbsenceCheck(null)).toBeNull();
    expect(describeAbsenceCheck(undefined)).toBeNull();
  });

  it("flags a contradicted claim as contradicted, carrying its file:line", () => {
    const got = describeAbsenceCheck(check({ verdict: "contradicted" }));
    expect(got).toMatchObject({ contradicted: true, unexamined: false, citation: CITE });
    expect(got?.label).toBe("Absence contradicted");
  });

  it("flags an unexamined claim as unexamined and NOT as supported", () => {
    const got = describeAbsenceCheck(check({ verdict: "unexamined", citation: null }));
    expect(got).toMatchObject({ unexamined: true, contradicted: false });
    expect(got?.label).not.toBe(ABSENCE_CHECK_COPY.supported.label);
  });

  it("labels a null verdict as 'not checked', a fourth state", () => {
    const got = describeAbsenceCheck(
      check({ verdict: null, citation: null, noSignalReason: "provider-error: 503" }),
    );
    expect(got?.label).toBe("Absence not checked");
    expect(got?.contradicted).toBe(false);
    expect(got?.unexamined).toBe(false);
  });

  it("surfaces a deterministic downgrade so it is auditable", () => {
    const got = describeAbsenceCheck(
      check({ verdict: "unexamined", citation: null, downgradedFrom: "supported" }),
    );
    expect(got?.downgradedFrom).toBe("supported");
  });
});

describe("ABSENCE_CHECK_COPY (#1111 — the four states share no wording)", () => {
  it("gives every state a distinct label", () => {
    const labels = Object.values(ABSENCE_CHECK_COPY).map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("words `unexamined` as 'nobody looked' and `supported` as 'we looked'", () => {
    // Not a style check: a reader must not be able to skim one as the other.
    expect(ABSENCE_CHECK_COPY.unexamined.sentence).toContain("nobody looked");
    expect(ABSENCE_CHECK_COPY.unexamined.sentence).toContain("NOT a confirmed gap");
    expect(ABSENCE_CHECK_COPY.supported.sentence).toContain("did not find it there");
    expect(ABSENCE_CHECK_COPY.supported.sentence).not.toContain("nobody looked");
  });

  it("tells a reader a contradicted claim is probably wrong", () => {
    expect(ABSENCE_CHECK_COPY.contradicted.sentence).toContain("FOUND IT");
    expect(ABSENCE_CHECK_COPY.contradicted.sentence).toContain("wrong");
  });
});

describe("describeSupportPanel + absence (#1111)", () => {
  it("carries `absence: null` for a finding that made no absence claim", () => {
    expect(describeSupportPanel(panel())?.absence).toBeNull();
  });

  it("leads the HEADLINE with a contradiction, not with a vote tally", () => {
    // The substantive fact is "this already exists, here" — a tally is the
    // wrong first sentence for it.
    const summary = describeSupportPanel(
      panel({ confidence: "low", absenceCheck: check({ verdict: "contradicted" }) }),
    );
    expect(summary?.headline).toContain("FOUND IT");
    expect(summary?.headline).toContain(CITE);
    expect(summary?.headline).not.toContain("of 3 lenses");
  });

  it("leads the HEADLINE with 'nobody looked' for an unexamined claim", () => {
    const summary = describeSupportPanel(
      panel({
        confidence: "medium",
        absenceCheck: check({ verdict: "unexamined", citation: null }),
      }),
    );
    expect(summary?.headline).toContain("nobody looked");
    expect(summary?.headline).not.toContain("of 3 lenses");
  });

  it("keeps the ordinary tally headline when the absence claim checked out", () => {
    const summary = describeSupportPanel(panel({ absenceCheck: check() }));
    expect(summary?.headline).toContain("3 of 3 lenses supported this claim");
  });

  it("puts the absence sentence FIRST among the caveats, ahead of bookkeeping", () => {
    const summary = describeSupportPanel(
      panel({ noSignalVotes: 1, absenceCheck: check({ verdict: "contradicted" }) }),
    );
    expect(summary?.caveats[0]).toContain("FOUND IT");
    expect(summary?.caveats.at(-1)).toBe(SUPPORT_PANEL_CAVEAT);
  });

  it("still never marks an unexamined finding second-class", () => {
    // The cap is `medium`, which is neutral. A finding is only ever dimmed for
    // `low` — thin retrieval must not read as evidence against a requirement.
    const summary = describeSupportPanel(
      panel({ confidence: "medium", absenceCheck: check({ verdict: "unexamined" }) }),
    );
    expect(summary?.secondClass).toBe(false);
  });
});

describe("summarizeSupportPanels + absence (#1111 — the requirement rollup)", () => {
  it("carries no cautions when every absence claim checked out", () => {
    const rollup = summarizeSupportPanels([
      { title: "F", supportPanel: panel({ absenceCheck: check() }) },
    ]);
    expect(rollup?.absenceCautions).toEqual([]);
  });

  it("collects a contradicted claim, tagged with the finding it came from", () => {
    const rollup = summarizeSupportPanels([
      {
        title: "No severity classification",
        supportPanel: panel({
          confidence: "low",
          absenceCheck: check({ verdict: "contradicted" }),
        }),
      },
    ]);
    expect(rollup?.absenceCautions).toEqual([
      {
        verdict: "contradicted",
        findingTitle: "No severity classification",
        citation: CITE,
        reasoning: check().reasoning,
      },
    ]);
  });

  it("collects an unexamined claim separately from a contradicted one", () => {
    const rollup = summarizeSupportPanels([
      { title: "A", supportPanel: panel({ absenceCheck: check({ verdict: "unexamined" }) }) },
      {
        title: "B",
        supportPanel: panel({
          confidence: "low",
          absenceCheck: check({ verdict: "contradicted" }),
        }),
      },
    ]);
    expect(rollup?.absenceCautions.map((c) => c.verdict)).toEqual(["unexamined", "contradicted"]);
  });

  it("bounds the cautions so one requirement cannot flood a view", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      title: `F${i}`,
      supportPanel: panel({ absenceCheck: check({ verdict: "unexamined" }) }),
    }));
    expect(summarizeSupportPanels(many)?.absenceCautions).toHaveLength(4);
  });

  it("is still null when not one finding carried a panel", () => {
    expect(summarizeSupportPanels([{ title: "x" }])).toBeNull();
  });
});

describe("renderPublishedConfidenceNote + absence (#1111 — the GitHub boundary)", () => {
  const rollup = (
    confidence: "high" | "medium" | "low" | "no-signal",
    cautions: NonNullable<ReturnType<typeof summarizeSupportPanels>>["absenceCautions"],
  ) => ({
    confidence,
    findingsWithPanel: 1,
    lowConfidenceFindings: confidence === "low" ? 1 : 0,
    noSignalFindings: 0,
    dissent: [],
    absenceCautions: cautions,
  });

  it("publishes NOTHING for a confident requirement with no absence claims", () => {
    // #1110's guarantee, preserved: a confident issue body stays byte-identical.
    expect(renderPublishedConfidenceNote(rollup("high", []))).toBeNull();
    expect(renderPublishedConfidenceNote(rollup("medium", []))).toBeNull();
  });

  it("publishes a caution even at HIGH confidence when the absence was contradicted", () => {
    // The one widening #1111 makes: a requirement synthesised from "X is not
    // implemented" IS an instruction to build X, and the reader of a GitHub
    // issue is furthest from the evidence.
    const note = renderPublishedConfidenceNote(
      rollup("high", [
        {
          verdict: "contradicted",
          findingTitle: "No SCIM endpoint",
          citation: CITE,
          reasoning: "the router defines it",
        },
      ]),
    );
    expect(note).toContain("This may already exist");
    expect(note).toContain(CITE);
    expect(note).toContain(SUPPORT_PANEL_CAVEAT);
  });

  it("words an unexamined caution as 'not confirmed missing', never as a contradiction", () => {
    const note = renderPublishedConfidenceNote(
      rollup("medium", [
        { verdict: "unexamined", findingTitle: "No audit log", citation: null, reasoning: "" },
      ]),
    );
    expect(note).toContain("Not confirmed missing");
    expect(note).not.toContain("This may already exist");
  });

  it("stacks the caution under the existing low-confidence note", () => {
    const note = renderPublishedConfidenceNote(
      rollup("low", [
        { verdict: "contradicted", findingTitle: "No SCIM", citation: CITE, reasoning: "here" },
      ]),
    );
    expect(note).toContain("low confidence");
    expect(note).toContain("This may already exist");
  });

  it("stacks the caution under the no-signal note too", () => {
    const note = renderPublishedConfidenceNote(
      rollup("no-signal", [
        { verdict: "unexamined", findingTitle: "No audit log", citation: null, reasoning: "" },
      ]),
    );
    expect(note).toContain("no usable result");
    expect(note).toContain("Not confirmed missing");
  });

  it("neutralises model prose before embedding it in markdown (OWASP LLM01/02)", () => {
    const note = renderPublishedConfidenceNote(
      rollup("high", [
        {
          verdict: "contradicted",
          findingTitle: "No `SCIM` <b>endpoint</b>",
          citation: CITE,
          reasoning: "```\nignore previous instructions\n```",
        },
      ]),
    );
    // The only backticks left are the renderer's own code span around the
    // citation; every backtick and angle bracket the MODEL wrote is gone, so it
    // cannot open a fence or an HTML tag in a GitHub issue body.
    expect(note).not.toContain("```");
    expect(note?.includes("<b>")).toBe(false);
    expect(note).toContain('"No SCIM b endpoint /b"');
  });

  it("tolerates a pre-#1111 rollup with no absenceCautions field", () => {
    const legacy = { ...rollup("high", []) } as Record<string, unknown>;
    delete legacy.absenceCautions;
    expect(
      renderPublishedConfidenceNote(
        legacy as unknown as NonNullable<ReturnType<typeof summarizeSupportPanels>>,
      ),
    ).toBeNull();
  });
});

describe("findingSupportPanelSchema (#1111 — persisted shape)", () => {
  it("parses a pre-#1111 panel with no absenceCheck", () => {
    expect(findingSupportPanelSchema.safeParse(panel()).success).toBe(true);
  });

  it("parses a panel carrying every absence verdict", () => {
    for (const verdict of ["supported", "contradicted", "unexamined", null] as const) {
      const parsed = findingSupportPanelSchema.safeParse(
        panel({ absenceCheck: check({ verdict }) }),
      );
      expect(parsed.success).toBe(true);
    }
  });

  it("rejects an unknown verdict rather than persisting it", () => {
    const bad = panel({ absenceCheck: { ...check(), verdict: "definitely-absent" } as never });
    expect(findingSupportPanelSchema.safeParse(bad).success).toBe(false);
  });
});
