/**
 * #141 / #214 — the native-vs-text comparison harness, driven with a scripted
 * provider (no model, no network). What must hold for #214's numbers to mean
 * anything: each mode really runs the protocol it names (decided by the same
 * function the orchestrator uses), the flag is restored, and validity,
 * degradation, tool errors and tokens are counted from what the loop returned.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../../ai/types.js";
import type { AgentTool } from "../../analysis/tools/types.js";
import {
  formatProtocolComparison,
  parseProtocolCases,
  runToolProtocolComparison,
  summarizeMode,
  type ProtocolCase,
  type ProtocolPassInput,
} from "./harness.js";

const VALID = JSON.stringify({
  summary: "s",
  findings: [
    { category: "architecture", severity: "low", title: "t", body: "b", tags: [], citations: [] },
  ],
  notes: [],
});

const tools: AgentTool[] = [
  {
    name: "search_code_graph",
    description: "graph",
    parameters: { type: "object", properties: { query: { type: "string" } } },
    execute: async (args) =>
      (args as { query?: string }).query === "boom"
        ? { content: "Error: no graph", isError: true }
        : { content: "found" },
  },
];

const CASES: ProtocolCase[] = [{ id: "c1", requirements: [{ id: "R1", text: "rates" }] }];
const pass = (): ProtocolPassInput => ({
  systemMessage: "ROLE",
  userMessage: "TASK",
  tools,
  toolContext: { projectId: "p" },
});

/**
 * Answers per protocol: on the native channel it calls one tool natively, on
 * the text protocol it writes the call as JSON; then it answers `answer`.
 */
function provider(opts: { toolCapable: boolean; answer?: string; failNative?: boolean }) {
  const seen: Array<{ messages: ChatMessage[]; opts: ChatOptions }> = [];
  const r = (content: string, extra: Partial<ChatResponse> = {}): ChatResponse => ({
    content,
    usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
    model: "m",
    provider: "local-gemma",
    ...extra,
  });
  const caps = { responseFormat: false, nativeToolCalls: opts.toolCapable };
  const p = {
    key: "local-gemma",
    model: "m",
    capabilities: caps,
    capabilitiesFor: () => caps,
    async chat(messages: ChatMessage[], o: ChatOptions = {}): Promise<ChatResponse> {
      seen.push({ messages: [...messages], opts: o });
      if (o.tools && opts.failNative) throw new Error("upstream 500");
      const investigated = messages.some(
        (m) => m.role === "tool" || /^Tool result/.test(String(m.content)),
      );
      if (investigated) return r(opts.answer ?? VALID);
      if (o.tools) {
        return r("", {
          toolCalls: [{ id: "t1", name: "search_code_graph", args: { query: "boom" } }],
        });
      }
      return r(JSON.stringify({ tool: "search_code_graph", args: { query: "boom" } }));
    },
  };
  return { provider: p as unknown as AIProvider, seen };
}

afterEach(() => {
  delete process.env.ANALYSIS_NATIVE_TOOL_CALLS;
});

describe("runToolProtocolComparison", () => {
  it("runs each mode on the protocol it names, interleaved, and counts what the loop returned", async () => {
    const { provider: p, seen } = provider({ toolCapable: true });
    let t = 0;
    const cmp = await runToolProtocolComparison({
      provider: p,
      cases: CASES,
      buildPass: pass,
      runsPerCase: 2,
      now: () => (t += 5),
    });

    expect(cmp.records.map((r) => `${r.mode}:${r.run}:${r.protocol}`)).toEqual([
      "text:1:text",
      "native:1:native",
      "text:2:text",
      "native:2:native",
    ]);
    // Text runs never put tools on the wire; native runs always do.
    const firstOfEach = seen.filter((s) => s.messages.length === 1);
    expect(firstOfEach.map((s) => s.opts.tools !== undefined)).toEqual([false, true, false, true]);
    for (const r of cmp.records) {
      expect(r).toMatchObject({
        findingsValid: true,
        findingsCount: 1,
        degraded: false,
        turnsUsed: 2,
        toolCalls: 1,
        toolErrors: 1,
        usage: { promptTokens: 200, completionTokens: 20, totalTokens: 220 },
        durationMs: 5,
      });
    }
    const [text, native] = cmp.summaries;
    expect(text).toMatchObject({ mode: "text", runs: 2, nativeRuns: 0, findingsValidRate: 1 });
    expect(native).toMatchObject({ mode: "native", runs: 2, nativeRuns: 2, toolErrors: 2 });
    expect(native!.meanTotalTokens).toBe(220);
  });

  it("restores the operator's flag afterwards", async () => {
    process.env.ANALYSIS_NATIVE_TOOL_CALLS = "on";
    await runToolProtocolComparison({
      provider: provider({ toolCapable: true }).provider,
      cases: CASES,
      buildPass: pass,
    });
    expect(process.env.ANALYSIS_NATIVE_TOOL_CALLS).toBe("on");
    delete process.env.ANALYSIS_NATIVE_TOOL_CALLS;
    await runToolProtocolComparison({
      provider: provider({ toolCapable: true }).provider,
      cases: CASES,
      buildPass: pass,
    });
    expect(process.env.ANALYSIS_NATIVE_TOOL_CALLS).toBeUndefined();
  });

  it("a model that is not tool-capable reports `text` in native mode, and the report says so", async () => {
    const cmp = await runToolProtocolComparison({
      provider: provider({ toolCapable: false }).provider,
      cases: CASES,
      buildPass: pass,
      modes: ["native"],
    });
    expect(cmp.records[0]!.protocol).toBe("text");
    expect(cmp.summaries[0]!.nativeRuns).toBe(0);
    expect(formatProtocolComparison(cmp)).toMatch(/Native mode never ran natively/);
  });

  it("counts an unusable answer as degraded and a thrown pass as an error", async () => {
    const bad = await runToolProtocolComparison({
      provider: provider({ toolCapable: true, answer: "prose, not JSON" }).provider,
      cases: CASES,
      buildPass: pass,
      modes: ["text"],
    });
    expect(bad.records[0]).toMatchObject({
      findingsValid: false,
      findingsCount: 0,
      degraded: true,
      degradedReason: "no-valid-answer",
      finalAnswerRetry: true,
    });

    const failing = await runToolProtocolComparison({
      provider: provider({ toolCapable: true, failNative: true }).provider,
      cases: CASES,
      buildPass: pass,
    });
    const nativeRun = failing.records.find((r) => r.mode === "native")!;
    expect(nativeRun).toMatchObject({ degraded: true, error: "upstream 500", protocol: "native" });
    expect(failing.summaries[1]).toMatchObject({ errors: 1, degradedRate: 1 });
    expect(failing.records.find((r) => r.mode === "text")!.error).toBeUndefined();
  });

  it("names the turn limit when the pass ran out of turns mid-investigation", async () => {
    const cmp = await runToolProtocolComparison({
      provider: provider({ toolCapable: true, answer: "prose" }).provider,
      cases: CASES,
      buildPass: pass,
      modes: ["native"],
      maxTurns: 1,
    });
    expect(cmp.records[0]).toMatchObject({ degraded: true, degradedReason: "turn-limit" });
  });

  it("names the token budget when the pass ran out of tokens", async () => {
    const cmp = await runToolProtocolComparison({
      provider: provider({ toolCapable: true, answer: "prose" }).provider,
      cases: CASES,
      buildPass: pass,
      modes: ["text"],
      maxTokens: 50,
    });
    expect(cmp.records[0]).toMatchObject({ degraded: true, degradedReason: "token-budget" });
  });
});

describe("summaries, report and corpus parsing", () => {
  it("summarises an empty mode as zeros", () => {
    expect(summarizeMode("native", [])).toMatchObject({
      runs: 0,
      findingsValidRate: 0,
      degradedRate: 0,
      meanTotalTokens: 0,
    });
  });

  it("formats one row per mode with rates as percentages", async () => {
    const cmp = await runToolProtocolComparison({
      provider: provider({ toolCapable: true }).provider,
      model: "m",
      cases: CASES,
      buildPass: pass,
    });
    const md = formatProtocolComparison(cmp);
    expect(md).toContain("### Analysis tool protocol — local-gemma / m");
    expect(md).toContain(
      "| text | 1 | 0 | 0 | 100.0% | 0.0% | 0 | 1 | 1 | 2 | 200 | 20 | 220 | 1 |",
    );
    expect(md).toContain("| native | 1 | 1 | 0 | 100.0% |");
    expect(md).not.toMatch(/never ran natively/);
  });

  it("parses a corpus and rejects bad shapes and duplicate ids", () => {
    expect(parseProtocolCases(CASES)).toEqual(CASES);
    expect(() => parseProtocolCases([])).toThrow();
    expect(() => parseProtocolCases([{ id: "x", requirements: [] }])).toThrow();
    expect(() => parseProtocolCases([...CASES, ...CASES])).toThrow(/duplicate case id "c1"/);
  });
});
