/**
 * #1225 — transcript compaction wired into `runAgentLoop`, measured end to end.
 *
 * The BEFORE/AFTER numbers this file prints are the acceptance criterion of
 * #1225 ("a number, not 'it feels better'"). They are a real measurement, not a
 * simulation of the model: `promptTokens` billed on a turn is a deterministic
 * function of the message array the provider receives, so a provider stub that
 * charges `estimateTokens` over exactly those bytes is billed the same shape a
 * real provider is. What is stubbed is the model's *choice* of tool, never the
 * accounting.
 *
 * Fixed workload — "21-turn search-heavy analysis pass":
 *   - a 6,000-character system prompt (the #398 cached prefix, unchanged by
 *     compaction and therefore identical in both arms),
 *   - a 4,000-character task turn carrying the volatile RAG block,
 *   - 21 turns, each returning a 7,200-character tool result (≈1,800 estimated
 *     tokens — the profile #1225 reports: ~35–40k tokens of real content across
 *     the run, all of it re-billed every turn).
 *
 * To SEE the numbers, vitest must be told not to swallow the stdout of a passing
 * test:
 *
 *   npx vitest run --disable-console-intercept \
 *     src/lib/analysis/transcript-compaction-loop.test.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../ai/types.js";
import type { AgentTool, ToolContext } from "./tools/types.js";
import { runAgentLoop } from "./agent-loop.js";
import { estimateTokens, TRANSCRIPT_ELISION_MARKER } from "./context-window-manager.js";
import { collectToolProvenance } from "./code-citations.js";

const WORKLOAD_TURNS = 21;
const SYSTEM_CHARS = 6_000;
const TASK_CHARS = 4_000;
const RESULT_CHARS = 7_200;

/** One search hit line per 60 chars, with a citable locator on the first line. */
function toolOutput(turn: number): string {
  const head = `server/src/module${turn}/service.ts:${turn * 10}-${turn * 10 + 8} handler${turn}\n`;
  const unit = `context line for turn ${turn} `;
  const filler = unit.repeat(Math.ceil(RESULT_CHARS / unit.length));
  return head + filler.slice(0, RESULT_CHARS - head.length);
}

interface Billed {
  promptTokens: number;
  turn: number;
}

/**
 * A provider that bills `estimateTokens` over the exact system + messages it is
 * handed, then plays the scripted workload: a tool call on every turn but the
 * last, and the findings JSON at the end.
 */
function makeMeteredProvider(billed: Billed[]): AIProvider {
  let turn = 0;
  return {
    key: "bedrock-gateway",
    model: "test-model",
    offline: false,
    chat: vi.fn(async (messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> => {
      const promptTokens =
        estimateTokens(opts?.systemMessage ?? "") +
        messages.reduce((sum, m) => sum + estimateTokens(String(m.content)), 0);
      billed.push({ promptTokens, turn });
      const isLast = turn >= WORKLOAD_TURNS - 1;
      turn++;
      const content = isLast
        ? JSON.stringify({
            findings: [{ title: "f", body: "b", severity: "info", category: "other" }],
          })
        : JSON.stringify({ tool: "search_code_symbols", args: { query: `q${turn}` } });
      return {
        content,
        usage: { promptTokens, completionTokens: 40, totalTokens: promptTokens + 40 },
        model: "test-model",
        provider: "bedrock-gateway",
      };
    }),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(),
    ping: vi.fn(),
  } as unknown as AIProvider;
}

function makeInput() {
  let call = 0;
  const tool: AgentTool = {
    name: "search_code_symbols",
    description: "search",
    parameters: { type: "object", properties: { query: { type: "string" } } },
    execute: async () => ({ content: toolOutput(call++), isError: false, resultCount: 30 }),
  } as unknown as AgentTool;
  return {
    systemMessage: "S".repeat(SYSTEM_CHARS),
    userMessage: "T".repeat(TASK_CHARS),
    tools: [tool],
    toolContext: {} as ToolContext,
  };
}

async function runWorkload(compaction: false | Record<string, number> | undefined) {
  const billed: Billed[] = [];
  const provider = makeMeteredProvider(billed);
  const result = await runAgentLoop(provider, makeInput(), {
    maxTurns: WORKLOAD_TURNS,
    ...(compaction === undefined ? {} : { transcriptCompaction: compaction }),
  });
  const cumulativePromptTokens = billed.reduce((s, b) => s + b.promptTokens, 0);
  return { result, billed, cumulativePromptTokens };
}

describe("runAgentLoop transcript compaction — measured (#1225)", () => {
  afterEach(() => {
    delete process.env.ANALYSIS_TRANSCRIPT_COMPACTION;
  });

  it("cuts cumulative prompt tokens on the 21-turn workload", async () => {
    const before = await runWorkload(false);
    const after = await runWorkload(undefined); // defaults, i.e. compaction ON

    const reduction =
      (before.cumulativePromptTokens - after.cumulativePromptTokens) /
      before.cumulativePromptTokens;

    // Printed so the PR body's number is reproducible from a test run.
    // eslint-disable-next-line no-console
    console.log(
      `[#1225] 21-turn workload — cumulative promptTokens: ` +
        `before=${before.cumulativePromptTokens} after=${after.cumulativePromptTokens} ` +
        `reduction=${(reduction * 100).toFixed(1)}% | ` +
        `final-turn promptTokens: before=${before.billed.at(-1)!.promptTokens} ` +
        `after=${after.billed.at(-1)!.promptTokens} | ` +
        `compaction events=${after.result.transcriptCompaction?.events}`,
    );

    // Measured at the shipped defaults: 453,582 → 276,592 cumulative (39.0%),
    // final turn 39,837 → 15,702 (60.6%), in 3 compaction events. The cumulative
    // figure is bounded below by design — the first ~9 turns sit under the
    // ceiling and are not touched at all — so the FINAL-TURN drop is the sharper
    // read on the quadratic→linear change. Thresholds sit clear of the measured
    // values so a re-tuned default fails loudly rather than drifting.
    expect(before.cumulativePromptTokens).toBeGreaterThan(400_000);
    expect(reduction).toBeGreaterThan(0.35);
    const finalTurnDrop =
      (before.billed.at(-1)!.promptTokens - after.billed.at(-1)!.promptTokens) /
      before.billed.at(-1)!.promptTokens;
    expect(finalTurnDrop).toBeGreaterThan(0.5);
    // Hysteresis keeps compaction rare: one event per turn would be one
    // message-cache invalidation per turn (#385/#652).
    expect(after.result.transcriptCompaction?.events).toBeGreaterThan(0);
    expect(after.result.transcriptCompaction?.events).toBeLessThan(6);
  });

  it("bounds the per-turn prompt instead of letting it grow every turn", async () => {
    const before = await runWorkload(false);
    const after = await runWorkload(undefined);

    // BEFORE: strictly monotonic growth — the whole transcript re-billed.
    for (let i = 1; i < before.billed.length; i++) {
      expect(before.billed[i].promptTokens).toBeGreaterThan(before.billed[i - 1].promptTokens);
    }

    // AFTER: the last turn costs no more than the ceiling plus the fixed lead
    // (system + task), i.e. the curve flattens rather than compounding.
    const fixedLead =
      estimateTokens("S".repeat(SYSTEM_CHARS)) + estimateTokens("T".repeat(TASK_CHARS));
    const last = after.billed.at(-1)!.promptTokens;
    expect(last).toBeLessThan(16_000 + fixedLead + 5_000);
    expect(last).toBeLessThan(before.billed.at(-1)!.promptTokens);
  });

  it("keeps every toolCalls[].result full and untruncated — #734 grounding", async () => {
    const after = await runWorkload(undefined);

    expect(after.result.toolCalls).toHaveLength(WORKLOAD_TURNS - 1);
    after.result.toolCalls.forEach((call, i) => {
      expect(call.result).toBe(toolOutput(i));
      expect(call.result).toHaveLength(RESULT_CHARS);
      expect(call.result).not.toContain(TRANSCRIPT_ELISION_MARKER);
    });
  });

  it("harvests the identical citation locator set with and without compaction", async () => {
    const before = await runWorkload(false);
    const after = await runWorkload(undefined);

    const beforePaths = collectToolProvenance(before.result.toolCalls);
    const afterPaths = collectToolProvenance(after.result.toolCalls);

    expect(afterPaths.length).toBe(WORKLOAD_TURNS - 1);
    expect([...afterPaths].sort()).toEqual([...beforePaths].sort());
  });

  it("returns the same final answer either way", async () => {
    const before = await runWorkload(false);
    const after = await runWorkload(undefined);

    expect(after.result.finalResponse).toBe(before.result.finalResponse);
    expect(after.result.hasFinalAnswer).toBe(true);
    expect(after.result.turnsUsed).toBe(before.result.turnsUsed);
  });

  it("leaves the caller-seeded lead and the system prompt byte-identical (#385/#652)", async () => {
    const billed: Billed[] = [];
    const provider = makeMeteredProvider(billed);
    const seen: Array<{ system?: string; lead: string }> = [];
    const spy = provider.chat as unknown as ReturnType<typeof vi.fn>;
    const inner = spy.getMockImplementation()!;
    spy.mockImplementation(async (messages: ChatMessage[], opts?: ChatOptions) => {
      seen.push({ system: opts?.systemMessage, lead: String(messages[0].content) });
      return inner(messages, opts);
    });

    await runAgentLoop(provider, makeInput(), { maxTurns: WORKLOAD_TURNS });

    expect(seen.length).toBeGreaterThan(1);
    for (const call of seen) {
      expect(call.system).toBe(seen[0].system);
      expect(call.lead).toBe(seen[0].lead);
    }
  });

  it("rewrites each message at most once, so the compacted prefix stays stable", async () => {
    const transcripts: string[][] = [];
    const billed: Billed[] = [];
    const provider = makeMeteredProvider(billed);
    const spy = provider.chat as unknown as ReturnType<typeof vi.fn>;
    const inner = spy.getMockImplementation()!;
    spy.mockImplementation(async (messages: ChatMessage[], opts?: ChatOptions) => {
      transcripts.push(messages.map((m) => String(m.content)));
      return inner(messages, opts);
    });

    await runAgentLoop(provider, makeInput(), { maxTurns: WORKLOAD_TURNS });

    // Count, per message index, how many times its content CHANGED between
    // consecutive turns. Appending is not a change; a rewrite is.
    const rewrites = new Map<number, number>();
    for (let t = 1; t < transcripts.length; t++) {
      const prev = transcripts[t - 1];
      const curr = transcripts[t];
      for (let i = 0; i < prev.length; i++) {
        if (curr[i] !== prev[i]) rewrites.set(i, (rewrites.get(i) ?? 0) + 1);
      }
    }
    for (const [, count] of rewrites) {
      expect(count).toBe(1);
    }
    expect([...rewrites.keys()].every((i) => i > 0)).toBe(true);
  });

  it("honours ANALYSIS_TRANSCRIPT_COMPACTION=off", async () => {
    process.env.ANALYSIS_TRANSCRIPT_COMPACTION = "off";
    const off = await runWorkload(undefined);
    const explicitlyOff = await runWorkload(false);

    expect(off.result.transcriptCompaction).toBeUndefined();
    expect(off.cumulativePromptTokens).toBe(explicitlyOff.cumulativePromptTokens);
  });

  it("leaves a short run byte-for-byte unchanged", async () => {
    const billed: Billed[] = [];
    const provider = makeMeteredProvider(billed);
    const result = await runAgentLoop(provider, makeInput(), { maxTurns: 3 });

    expect(result.transcriptCompaction).toEqual({
      events: 0,
      messagesCompacted: 0,
      tokensSaved: 0,
    });
    expect(result.toolCalls.every((c) => c.result?.length === RESULT_CHARS)).toBe(true);
  });
});
