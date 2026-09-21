/**
 * Epic #1107 (#1109) — the aggregation is PURE and unit-tested with NO model
 * involved. That is an acceptance criterion, not a convenience: an aggregate
 * that is itself an LLM judgement is a fourth opinion, not a tally.
 *
 * Nothing in this file constructs a provider, and nothing it exercises can drop
 * a finding — the tally's whole output is counts plus a label.
 */
import { describe, expect, it } from "vitest";
import { SUPPORT_PANEL_LENSES, type SupportPanelVote } from "@metis/shared";
import {
  aggregatePanelVotes,
  extractGroundedLocator,
  MAX_VOTE_REASONING_CHARS,
  noSignalVote,
  orderVotesByLens,
  toVote,
} from "./support-panel-tally.js";

const EVIDENCE = ["server/src/lib/change-analysis/change-analysis-engine.ts"];

const counted = (
  lens: SupportPanelVote["lens"],
  judgement: NonNullable<SupportPanelVote["judgement"]>,
): SupportPanelVote => ({
  lens,
  judgement,
  discardReason: null,
  citation: "a.ts:1",
  reasoning: "because a.ts:1",
  counted: true,
});

describe("extractGroundedLocator (#1109 — a verdict without a file:line is not counted)", () => {
  it("reads a plain file:line from the citation field", () => {
    expect(extractGroundedLocator(`${EVIDENCE[0]}:131`, null, EVIDENCE)).toBe(`${EVIDENCE[0]}:131`);
  });

  it("reads a file:start-end range", () => {
    expect(extractGroundedLocator(`${EVIDENCE[0]}:128-146`, null, EVIDENCE)).toBe(
      `${EVIDENCE[0]}:128-146`,
    );
  });

  it("falls back to the reasoning when the model put the locator in prose", () => {
    expect(
      extractGroundedLocator(
        null,
        `The function is defined at ${EVIDENCE[0]}:131 already.`,
        EVIDENCE,
      ),
    ).toBe(`${EVIDENCE[0]}:131`);
  });

  it("normalises a ./-prefixed path against the evidence set", () => {
    expect(extractGroundedLocator(`./${EVIDENCE[0]}:9`, null, EVIDENCE)).toBe(`${EVIDENCE[0]}:9`);
  });

  it("rejects a locator naming a file the lens was never shown", () => {
    // The verifier's own citation is grounded the same way the #734 gate grounds
    // an agent's: cite what you were given, or you cited nothing.
    expect(extractGroundedLocator("some/other/file.ts:12", null, EVIDENCE)).toBeNull();
  });

  it("skips an ungrounded locator and keeps looking for a grounded one", () => {
    expect(
      extractGroundedLocator(`nope/other.ts:1 and also ${EVIDENCE[0]}:200`, null, EVIDENCE),
    ).toBe(`${EVIDENCE[0]}:200`);
  });

  it("returns null when there is no locator at all", () => {
    expect(extractGroundedLocator("it obviously does not do this", null, EVIDENCE)).toBeNull();
  });

  it("returns null when the panel was shown no evidence", () => {
    expect(extractGroundedLocator("a.ts:1", null, [])).toBeNull();
  });

  it("ignores a bare filename with no line number", () => {
    expect(extractGroundedLocator(EVIDENCE[0], null, EVIDENCE)).toBeNull();
  });

  it("accepts a DOCUMENT chunk locator, whose '#' the file pattern rejects", () => {
    // Regression: `billing-brd.md#chunk-13:1-2` matched no file pattern, so a
    // lens citing exactly what it was shown had its verdict discarded for a
    // punctuation reason — silencing the panel on every doc-grounded finding.
    const docs = ["billing-brd.md#chunk-13"];
    expect(extractGroundedLocator("billing-brd.md#chunk-13:1-2", null, docs)).toBe(
      "billing-brd.md#chunk-13:1-2",
    );
    expect(
      extractGroundedLocator(null, "clause at billing-brd.md#chunk-13:1 says otherwise", docs),
    ).toBe("billing-brd.md#chunk-13:1");
  });

  it("still rejects a document locator for a chunk it was never shown", () => {
    expect(
      extractGroundedLocator("other.md#chunk-9:1", null, ["billing-brd.md#chunk-13"]),
    ).toBeNull();
  });
});

describe("toVote (#1109 — the citation rule cuts BOTH ways)", () => {
  it("counts a cited verdict and keeps the grounded locator", () => {
    const v = toVote(
      { lens: "support", judgement: "unsupported", citation: `${EVIDENCE[0]}:131`, reasoning: "r" },
      EVIDENCE,
    );
    expect(v).toMatchObject({
      lens: "support",
      judgement: "unsupported",
      counted: true,
      discardReason: null,
      citation: `${EVIDENCE[0]}:131`,
    });
  });

  it("discards an UNCITED unsupported verdict — the rule is not a back door to down-weight", () => {
    const v = toVote(
      { lens: "support", judgement: "unsupported", reasoning: "trust me" },
      EVIDENCE,
    );
    expect(v.counted).toBe(false);
    expect(v.judgement).toBeNull();
    expect(v.discardReason).toBe("missing-citation");
  });

  it("discards an UNCITED supported verdict identically", () => {
    const v = toVote({ lens: "scope", judgement: "supported", reasoning: "looks fine" }, EVIDENCE);
    expect(v.counted).toBe(false);
    expect(v.discardReason).toBe("missing-citation");
  });

  it("truncates runaway reasoning rather than persisting it whole", () => {
    const v = toVote(
      {
        lens: "currency",
        judgement: "supported",
        citation: `${EVIDENCE[0]}:1`,
        reasoning: "x".repeat(9_000),
      },
      EVIDENCE,
    );
    expect(v.reasoning).toHaveLength(MAX_VOTE_REASONING_CHARS);
  });
});

describe("noSignalVote (#1114 — absence of evidence, never evidence of absence)", () => {
  it("records the lens and the cause but casts no judgement", () => {
    const v = noSignalVote("support", "schema-invalid: judgement: required");
    expect(v).toMatchObject({
      lens: "support",
      judgement: null,
      discardReason: "no-signal",
      counted: false,
    });
  });
});

describe("aggregatePanelVotes (#1109 — PURE tally, no model)", () => {
  it("all three lenses support ⇒ high", () => {
    const t = aggregatePanelVotes([
      counted("support", "supported"),
      counted("scope", "supported"),
      counted("currency", "supported"),
    ]);
    expect(t.confidence).toBe("high");
    expect(t).toMatchObject({ countedVotes: 3, supportedVotes: 3, unsupportedVotes: 0 });
  });

  it("2-of-3 unsupported ⇒ low (the dissent outweighs the defence)", () => {
    const t = aggregatePanelVotes([
      counted("support", "unsupported"),
      counted("scope", "unsupported"),
      counted("currency", "supported"),
    ]);
    expect(t.confidence).toBe("low");
    expect(t.unsupportedVotes).toBe(2);
  });

  it("1-of-3 unsupported ⇒ medium — real dissent, outvoted, NOT silenced", () => {
    const t = aggregatePanelVotes([
      counted("support", "unsupported"),
      counted("scope", "supported"),
      counted("currency", "supported"),
    ]);
    expect(t.confidence).toBe("medium");
  });

  it("no dissent but an uncertain lens ⇒ medium", () => {
    const t = aggregatePanelVotes([
      counted("support", "supported"),
      counted("scope", "uncertain"),
      counted("currency", "supported"),
    ]);
    expect(t.confidence).toBe("medium");
    expect(t.uncertainVotes).toBe(1);
  });

  it("a lone counted unsupported vote outweighs zero defenders ⇒ low", () => {
    const t = aggregatePanelVotes([
      counted("support", "unsupported"),
      noSignalVote("scope", "provider-error"),
      noSignalVote("currency", "provider-error"),
    ]);
    expect(t.confidence).toBe("low");
    expect(t).toMatchObject({ countedVotes: 1, noSignalVotes: 2 });
  });

  it("EVERY lens no-signal ⇒ 'no-signal', NEVER 'low'", () => {
    // The load-bearing #1114 distinction: a panel that failed has told us nothing
    // about the finding, and must not look like a panel that judged it weak.
    const t = aggregatePanelVotes(SUPPORT_PANEL_LENSES.map((l) => noSignalVote(l, "unparseable")));
    expect(t.confidence).toBe("no-signal");
    expect(t).toMatchObject({ countedVotes: 0, noSignalVotes: 3, unsupportedVotes: 0 });
  });

  it("every lens judged but none cited ⇒ 'no-signal', not 'low'", () => {
    const t = aggregatePanelVotes(
      SUPPORT_PANEL_LENSES.map((lens) => toVote({ lens, judgement: "unsupported" }, EVIDENCE)),
    );
    expect(t.confidence).toBe("no-signal");
    expect(t).toMatchObject({ countedVotes: 0, uncitedVotes: 3, unsupportedVotes: 0 });
  });

  it("an empty panel is 'no-signal'", () => {
    expect(aggregatePanelVotes([]).confidence).toBe("no-signal");
  });

  it("is a pure function of its input — same votes, same tally, repeatedly", () => {
    const votes = [counted("support", "unsupported"), counted("scope", "supported")];
    expect(aggregatePanelVotes(votes)).toEqual(aggregatePanelVotes(votes));
  });

  it("never returns anything that could remove a finding", () => {
    // Guard for the epic's central constraint: the tally's entire surface is
    // counts plus a label. There is no `drop`, `suppress` or `filtered` field a
    // consumer could act on, under any vote combination.
    const t = aggregatePanelVotes([
      counted("support", "unsupported"),
      counted("scope", "unsupported"),
      counted("currency", "unsupported"),
    ]);
    expect(Object.keys(t).sort()).toEqual(
      [
        "confidence",
        "countedVotes",
        "noSignalVotes",
        "supportedVotes",
        "uncertainVotes",
        "uncitedVotes",
        "unsupportedVotes",
      ].sort(),
    );
  });
});

describe("orderVotesByLens", () => {
  it("restores canonical lens order regardless of settle order", () => {
    const shuffled = [
      counted("currency", "supported"),
      counted("support", "supported"),
      counted("scope", "supported"),
    ];
    expect(orderVotesByLens(shuffled).map((v) => v.lens)).toEqual([...SUPPORT_PANEL_LENSES]);
  });

  it("does not mutate the input array", () => {
    const input = [counted("currency", "supported"), counted("support", "supported")];
    orderVotesByLens(input);
    expect(input[0].lens).toBe("currency");
  });
});
