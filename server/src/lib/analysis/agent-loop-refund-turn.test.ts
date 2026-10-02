/**
 * #736 — `refundTurn`: a turn the caller refunds does not count against
 * `maxTurns`, on both the text protocol and the native channel.
 */
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "./agent-loop.js";
import { OfflineStubProvider } from "../ai/providers/offline-stub-provider.js";
import type { AgentTool } from "./tools/types.js";

const probe: AgentTool = {
  name: "probe",
  description: "probe",
  parameters: { type: "object" },
  execute: async () => ({ content: "ok" }),
};

const TEXT_CALL = '{"tool":"probe","args":{"q":"x"}}';

function run(native: boolean, refundTurn?: () => boolean) {
  const provider = new OfflineStubProvider({
    script: native
      ? [{ toolCalls: [{ id: "c1", name: "probe", args: { q: "x" } }] }, { content: "answer" }]
      : [{ content: TEXT_CALL }, { content: "answer" }],
  });
  return runAgentLoop(
    provider,
    { systemMessage: "", userMessage: "", tools: [probe], toolContext: { projectId: "p1" } },
    {
      maxTurns: 1,
      systemPrompt: "",
      initialMessages: [{ role: "user", content: "q" }],
      ...(native
        ? { native: { tools: [{ name: "probe", description: "probe", parameters: {} }] } }
        : {}),
      ...(refundTurn ? { refundTurn } : {}),
    },
  );
}

describe("runAgentLoop refundTurn (#736)", () => {
  for (const native of [false, true]) {
    const mode = native ? "native" : "text";

    it(`${mode}: a refunded turn leaves room for the answer`, async () => {
      let asked = 0;
      const out = await run(native, () => ++asked === 1);
      expect(asked).toBe(1);
      expect(out.finalResponse).toBe("answer");
      expect(out.turnsUsed).toBe(2);
    });

    it(`${mode}: without a refund the one turn is spent on the call`, async () => {
      const out = await run(native, () => false);
      expect(out.turnsUsed).toBe(1);
      expect(out.turnsExhausted).toBe(true);
    });
  }
});
