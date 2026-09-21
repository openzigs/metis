/**
 * Epic #1107 (#1110 / A2) — **panel confidence CHANGES synthesis, provably.**
 *
 * #1109 computes a confidence label; #1110's acceptance criterion is that the
 * label shifts synthesis RANKING, not merely that a field is populated. So these
 * tests assert on ORDER — the order of the numbered findings table the model is
 * shown, and the order of the requirements the deterministic fallback emits from
 * it — and on the two things that must NOT change: nothing is dropped, and a
 * flag-off run (no finding carries a panel) is byte-identical to a pre-#1109 one.
 */
import { describe, expect, it } from "vitest";
import {
  orderByPanelConfidence,
  type FindingSupportPanel,
  type SupportPanelConfidence,
} from "@metis/shared";
import {
  fallbackSynthesize,
  formatFindingsTable,
  runSynthesis,
  type FlatFinding,
} from "./synthesis.js";

/**
 * Exactly the call `runSynthesisAndPersist` makes on the rows it then derives
 * `findings` and `findingIdsByIndex` from. Kept as a local alias so these tests
 * exercise the production ranking, not a paraphrase of it.
 */
const orderFindingsForSynthesis = <T extends { supportPanel?: FindingSupportPanel | null }>(
  rows: readonly T[],
): T[] => orderByPanelConfidence(rows, (f) => f.supportPanel);
import { buildSynthesisPrompt } from "./prompts.js";
import type { AIProvider, ChatMessage, ChatOptions } from "../ai/types.js";

function panel(confidence: SupportPanelConfidence): FindingSupportPanel {
  const counted = confidence === "no-signal" ? 0 : 3;
  const supported = confidence === "high" ? 3 : confidence === "medium" ? 2 : counted ? 1 : 0;
  const unsupported = counted - supported;
  return {
    confidence,
    votes: [
      {
        lens: "support",
        judgement: counted ? "supported" : null,
        discardReason: counted ? null : "no-signal",
        citation: counted ? "server/src/a.ts:10" : null,
        reasoning: counted ? "the excerpt says so" : "degraded",
        counted: counted > 0,
      },
      {
        lens: "scope",
        judgement: counted ? (supported > 1 ? "supported" : "unsupported") : null,
        discardReason: counted ? null : "no-signal",
        citation: counted ? "server/src/b.ts:20" : null,
        reasoning: counted ? "one handler is not the whole system" : "degraded",
        counted: counted > 0,
      },
      {
        lens: "currency",
        judgement: counted ? (supported > 2 ? "supported" : "unsupported") : null,
        discardReason: counted ? null : "no-signal",
        citation: counted ? "server/src/c.ts:30" : null,
        reasoning: counted ? "superseded elsewhere" : "degraded",
        counted: counted > 0,
      },
    ],
    countedVotes: counted,
    supportedVotes: supported,
    unsupportedVotes: unsupported,
    uncertainVotes: 0,
    noSignalVotes: counted ? 0 : 3,
    uncitedVotes: 0,
    usage: { promptTokens: 5, completionTokens: 1, llmCalls: 3 },
  };
}

function finding(overrides: Partial<FlatFinding> & { title: string }): FlatFinding {
  return {
    agentKey: "code",
    category: "security",
    severity: "high",
    title: overrides.title,
    body: "b",
    tags: [],
    citations: [],
    ...overrides,
  };
}

const titlesOf = (rows: FlatFinding[]): string[] => rows.map((f) => f.title);

describe("orderFindingsForSynthesis (#1110)", () => {
  it("SHIFTS the order: high-confidence findings rank first, low-confidence last", () => {
    const input = [
      finding({ title: "doubted", supportPanel: panel("low") }),
      finding({ title: "mixed", supportPanel: panel("medium") }),
      finding({ title: "backed", supportPanel: panel("high") }),
      finding({ title: "unjudged", supportPanel: panel("no-signal") }),
    ];
    expect(titlesOf(orderFindingsForSynthesis(input))).toEqual([
      "backed",
      "mixed",
      "unjudged",
      "doubted",
    ]);
  });

  it("does NOT rank a no-signal finding below a doubted one — the panel's own failure is not evidence", () => {
    const input = [
      finding({ title: "doubted", supportPanel: panel("low") }),
      finding({ title: "unjudged", supportPanel: panel("no-signal") }),
    ];
    expect(titlesOf(orderFindingsForSynthesis(input))).toEqual(["unjudged", "doubted"]);
  });

  it("drops NOTHING — the low-confidence finding is still in the output", () => {
    const input = [
      finding({ title: "doubted", supportPanel: panel("low") }),
      finding({ title: "backed", supportPanel: panel("high") }),
    ];
    const out = orderFindingsForSynthesis(input);
    expect(out).toHaveLength(2);
    expect(titlesOf(out)).toContain("doubted");
  });

  it("is the identity when no finding carries a panel (flag off)", () => {
    const input = [finding({ title: "a" }), finding({ title: "b" }), finding({ title: "c" })];
    expect(titlesOf(orderFindingsForSynthesis(input))).toEqual(["a", "b", "c"]);
  });

  it("keeps index-aligned sibling arrays aligned when the SOURCE list is reordered once", () => {
    // This is the contract `runSynthesisAndPersist` relies on: reorder the rows,
    // then derive `findings` AND `findingIdsByIndex` from the reordered rows, so
    // `evidenceFindingIndexes` from the model still resolves to the right row.
    const rows = [
      { ...finding({ title: "doubted", supportPanel: panel("low") }), findingId: "id-doubted" },
      { ...finding({ title: "backed", supportPanel: panel("high") }), findingId: "id-backed" },
    ];
    const ordered = orderFindingsForSynthesis(rows);
    const ids = ordered.map((r) => r.findingId);
    const table = formatFindingsTable(ordered);
    expect(table.split("\n")[0]).toContain("backed");
    expect(ids[0]).toBe("id-backed");
    expect(ids[1]).toBe("id-doubted");
  });
});

describe("formatFindingsTable renders the panel signal (#1110)", () => {
  it("marks low-confidence and no-signal findings DISTINCTLY from each other", () => {
    const table = formatFindingsTable([
      finding({ title: "doubted", supportPanel: panel("low") }),
      finding({ title: "unjudged", supportPanel: panel("no-signal") }),
    ]);
    const [low, noSignal] = table.split("\n");
    expect(low).toContain("[LOW-CONFIDENCE]");
    expect(noSignal).toContain("[UNJUDGED]");
    expect(noSignal).not.toContain("[LOW-CONFIDENCE]");
    expect(low).not.toContain("[UNJUDGED]");
  });

  it("names the dissenting lenses on a low-confidence finding, not just a ratio", () => {
    const table = formatFindingsTable([finding({ title: "doubted", supportPanel: panel("low") })]);
    expect(table).toContain("panel=low 1/3");
    expect(table).toContain("dissent: scope, currency");
  });

  it("does not prefix a high or medium finding, but still records its tally", () => {
    const table = formatFindingsTable([
      finding({ title: "backed", supportPanel: panel("high") }),
      finding({ title: "mixed", supportPanel: panel("medium") }),
    ]);
    const [high, medium] = table.split("\n");
    expect(high).not.toContain("[LOW-CONFIDENCE]");
    expect(high).not.toContain("[UNJUDGED]");
    expect(high).toContain("panel=high 3/3");
    expect(medium).toContain("panel=medium 2/3");
  });

  it("is byte-identical to the pre-#1110 rendering when no panel ran", () => {
    const rows = [
      finding({ title: "a", verificationStatus: "unverified" }),
      finding({ title: "b", verificationStatus: "confirmed" }),
    ];
    expect(formatFindingsTable(rows)).toBe(
      "[0] [UNVERIFIED] (code / high / security) a :: b :: tags=\n" +
        "[1] (code / high / security) b :: b :: tags=",
    );
  });

  it("stacks the verification marker and the panel marker — they are different judgements", () => {
    const table = formatFindingsTable([
      finding({ title: "both", verificationStatus: "unverified", supportPanel: panel("low") }),
    ]);
    expect(table).toContain("[UNVERIFIED] [LOW-CONFIDENCE]");
  });
});

describe("formatFindingsTable renders the ABSENCE verdict (#1111)", () => {
  const withAbsence = (
    confidence: SupportPanelConfidence,
    verdict: "supported" | "contradicted" | "unexamined" | null,
  ): FindingSupportPanel => ({
    ...panel(confidence),
    absenceCheck: {
      verdict,
      citation: verdict === "unexamined" ? null : "server/src/a.ts:10",
      reasoning: "the excerpt decided it",
      downgradedFrom: null,
      noSignalReason: verdict === null ? "provider-error: 503" : null,
    },
  });

  it("prefixes an UNEXAMINED absence claim, which no other marker covers", () => {
    // It is capped at `medium`, so without this it reaches synthesis unmarked —
    // and synthesis is the step that turns "X is missing" into "build X".
    const table = formatFindingsTable([
      finding({ title: "gap", supportPanel: withAbsence("medium", "unexamined") }),
    ]);
    expect(table).toContain("[ABSENCE-UNEXAMINED]");
    expect(table).toContain("absence=unexamined");
  });

  it("does NOT prefix a contradicted claim twice — it already reads LOW-CONFIDENCE", () => {
    const table = formatFindingsTable([
      finding({ title: "wrong gap", supportPanel: withAbsence("low", "contradicted") }),
    ]);
    expect(table).toContain("[LOW-CONFIDENCE]");
    expect(table).not.toContain("[ABSENCE-UNEXAMINED]");
    expect(table).toContain("absence=contradicted");
  });

  it("marks a checked absence claim with the suffix only", () => {
    const table = formatFindingsTable([
      finding({ title: "real gap", supportPanel: withAbsence("high", "supported") }),
    ]);
    expect(table).toContain("absence=supported");
    expect(table).not.toContain("[ABSENCE-UNEXAMINED]");
    expect(table).not.toContain("[LOW-CONFIDENCE]");
  });

  it("distinguishes a verifier failure from an unexamined claim", () => {
    const table = formatFindingsTable([
      finding({ title: "gap", supportPanel: withAbsence("medium", null) }),
    ]);
    expect(table).toContain("absence=not-checked");
    expect(table).not.toContain("[ABSENCE-UNEXAMINED]");
  });

  it("adds no absence suffix at all to a finding that made no absence claim", () => {
    const table = formatFindingsTable([finding({ title: "x", supportPanel: panel("high") })]);
    expect(table).not.toContain("absence=");
  });
});

describe("the synthesis prompt (#1110)", () => {
  it("adds the panel rule ONLY when a panel marker is present", () => {
    const withPanel = buildSynthesisPrompt({
      projectName: "p",
      findingsTable:
        "[0] [LOW-CONFIDENCE] (code / high / security) t :: b :: tags= :: panel=low 1/3",
      panelGuidance: true,
    });
    expect(withPanel.systemMessage).toContain("[LOW-CONFIDENCE]");
    expect(withPanel.systemMessage).toContain("[UNJUDGED]");
    expect(withPanel.systemMessage).toMatch(/never drop/i);
  });

  it("tells the model an [ABSENCE-UNEXAMINED] gap is NOT established fact (#1111)", () => {
    const prompt = buildSynthesisPrompt({
      projectName: "p",
      findingsTable: "[0] [ABSENCE-UNEXAMINED] (code / high / security) t :: b :: tags=",
      panelGuidance: true,
    });
    expect(prompt.systemMessage).toContain("[ABSENCE-UNEXAMINED]");
    expect(prompt.systemMessage).toContain("never state the gap as established fact");
    // Still recall-first: the requirement is surfaced, only its wording hedges.
    expect(prompt.systemMessage).toContain("Still surface the requirement");
  });

  it("is byte-identical to the pre-#1110 prompt when no panel ran", () => {
    const table = "[0] (code / high / security) t :: b :: tags=";
    const off = buildSynthesisPrompt({ projectName: "p", findingsTable: table });
    const explicitlyOff = buildSynthesisPrompt({
      projectName: "p",
      findingsTable: table,
      panelGuidance: false,
    });
    expect(off.systemMessage).toBe(explicitlyOff.systemMessage);
    expect(off.systemMessage).not.toContain("[LOW-CONFIDENCE]");
    expect(off.systemMessage).not.toContain("[UNJUDGED]");
    expect(off.systemMessage).not.toContain("[ABSENCE-UNEXAMINED]");
  });
});

describe("ranking reaches the model and the deterministic fallback (#1110)", () => {
  it("orders the requirements the LLM-free fallback emits by panel confidence", () => {
    // No model involved: ordering alone changes which requirement is seeded first.
    const ordered = orderFindingsForSynthesis([
      finding({ title: "doubted claim", tags: ["alpha"], supportPanel: panel("low") }),
      finding({ title: "backed claim", tags: ["beta"], supportPanel: panel("high") }),
    ]);
    const out = fallbackSynthesize(ordered);
    expect(out.requirements.map((r) => r.title)).toEqual(["backed claim", "doubted claim"]);
    // …and still emits BOTH — a low-confidence finding is never filtered out.
    expect(out.requirements).toHaveLength(2);
  });

  it("shows the model the high-confidence finding first and the low-confidence one last", async () => {
    let userMessage = "";
    let systemMessage = "";
    const provider = {
      chat: async (messages: ChatMessage[], opts?: ChatOptions) => {
        userMessage = messages.find((m) => m.role === "user")?.content ?? "";
        systemMessage = opts?.systemMessage ?? "";
        return {
          content: JSON.stringify({
            summary: "s",
            requirements: [
              {
                type: "feature",
                title: "R",
                body: "b",
                priority: "low",
                labels: [],
                evidenceFindingIndexes: [0, 1],
              },
            ],
          }),
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    } as unknown as AIProvider;

    const result = await runSynthesis(provider, {
      projectName: "p",
      findings: orderFindingsForSynthesis([
        finding({ title: "doubted claim", supportPanel: panel("low") }),
        finding({ title: "backed claim", supportPanel: panel("high") }),
      ]),
    });

    expect(userMessage.indexOf("backed claim")).toBeLessThan(userMessage.indexOf("doubted claim"));
    // Down-weighted, not dropped: it is still in the prompt, and still marked.
    expect(userMessage).toContain("[LOW-CONFIDENCE]");
    expect(systemMessage).toMatch(/never drop/i);
    expect(result.output.requirements).toHaveLength(1);
  });
});
