/**
 * Epic #727 (#740) — verification CHANGES synthesis behaviour.
 *
 * The point of #740 is not merely to compute a status but to make it alter the
 * output: `unverified` findings must reach synthesis DOWN-WEIGHTED, not with
 * equal weight. These tests exercise the REAL `formatFindingsTable` +
 * `buildSynthesisPrompt` + `runSynthesis` (with a capturing mock provider), and
 * assert that flipping a finding's verificationStatus demonstrably changes what
 * the synthesis model is asked to do — while confirmed findings are untouched and
 * nothing is dropped.
 */
import { describe, expect, it } from "vitest";
import type { FlatFinding } from "./synthesis.js";
import { formatFindingsTable, runSynthesis } from "./synthesis.js";
import { buildSynthesisPrompt } from "./prompts.js";
import type { AIProvider, ChatMessage, ChatOptions } from "../ai/types.js";

function finding(overrides: Partial<FlatFinding>): FlatFinding {
  return {
    agentKey: "code",
    category: "security",
    severity: "high",
    title: "t",
    body: "b",
    tags: [],
    citations: [],
    ...overrides,
  };
}

describe("verification changes synthesis behaviour (#740)", () => {
  it("marks only unverified findings with [UNVERIFIED] in the findings table", () => {
    const table = formatFindingsTable([
      finding({ title: "Confirmed one", verificationStatus: "confirmed" }),
      finding({ title: "Unverified one", verificationStatus: "unverified" }),
      finding({ title: "Neutral one", verificationStatus: null }),
    ]);
    const lines = table.split("\n");
    expect(lines[0]).toContain("Confirmed one");
    expect(lines[0]).not.toContain("[UNVERIFIED]");
    expect(lines[1]).toContain("[UNVERIFIED]");
    expect(lines[1]).toContain("Unverified one");
    expect(lines[2]).not.toContain("[UNVERIFIED]");
  });

  it("the SAME finding renders differently based only on its verificationStatus", () => {
    const asConfirmed = formatFindingsTable([finding({ verificationStatus: "confirmed" })]);
    const asUnverified = formatFindingsTable([finding({ verificationStatus: "unverified" })]);
    // Behaviour change is observable: verdict is the only difference in the input.
    expect(asConfirmed).not.toEqual(asUnverified);
    expect(asUnverified).toContain("[UNVERIFIED]");
    expect(asConfirmed).not.toContain("[UNVERIFIED]");
  });

  it("the synthesis system prompt instructs the model to down-weight [UNVERIFIED] findings", () => {
    const { systemMessage } = buildSynthesisPrompt({
      projectName: "p",
      findingsTable: "[0] [UNVERIFIED] (code / high / security) t :: b :: tags=",
    });
    expect(systemMessage).toContain("[UNVERIFIED]");
    expect(systemMessage).toMatch(/weaker evidence/i);
    // Never silently dropped solely for being unverified.
    expect(systemMessage).toMatch(/never silently drop/i);
  });

  it("passes the [UNVERIFIED] marker through runSynthesis to the provider (still visible, not dropped)", async () => {
    const captured: { messages: ChatMessage[]; systemMessage?: string } = {
      messages: [],
    };
    const provider: AIProvider = {
      chat: async (messages: ChatMessage[], opts?: ChatOptions) => {
        captured.messages = messages;
        captured.systemMessage = opts?.systemMessage;
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
      findings: [
        finding({ title: "Confirmed one", verificationStatus: "confirmed" }),
        finding({ title: "Unverified one", verificationStatus: "unverified" }),
      ],
    });

    const userMsg = captured.messages.find((m) => m.role === "user")?.content ?? "";
    // The unverified finding reached synthesis (visible), flagged for down-weight.
    expect(userMsg).toContain("Unverified one");
    expect(userMsg).toContain("[UNVERIFIED]");
    // The confirmed finding is untouched.
    expect(userMsg).toContain("Confirmed one");
    expect(userMsg.split("Confirmed one")[0]).not.toContain("[UNVERIFIED]");
    // The rule reached the model too.
    expect(captured.systemMessage).toMatch(/weaker evidence/i);
    // Synthesis still produced output (unverified findings are not dropped).
    expect(result.output.requirements).toHaveLength(1);
  });
});
