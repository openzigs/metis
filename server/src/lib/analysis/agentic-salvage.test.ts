/**
 * #1217 — the agentic loop discarded an entire investigation on a token-budget
 * stop. Four defects produced one symptom (`salvagedFindings: 0` on every run):
 *
 *   D1 the brace-free `buildBudgetExhaustedMessage` overwrote `finalResponse`
 *      BEFORE the orchestrator salvaged from it, so salvage could never match;
 *   D2 a retry answer that did not fully validate was dropped on the floor;
 *   D3 the retry inherited the provider's 4096-token OUTPUT cap, so a full
 *      findings payload was truncated — deterministically, every run;
 *   D4 the logs could not tell prose from truncated from malformed.
 *
 * These drive the REAL `runAgentLoop` against provider stubs, then the real
 * orchestrator-side salvage helper, so the whole repaired data path is covered.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../ai/types.js";
import type { AgentTool } from "./tools/types.js";

const { logInfo, logWarn } = vi.hoisted(() => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    debug: vi.fn(),
    info: logInfo,
    warn: logWarn,
    error: vi.fn(),
  }),
}));

const { runAgentLoop, classifyFinalAnswer, DEFAULT_FINAL_ANSWER_MAX_OUTPUT_TOKENS } =
  await import("./agent-loop.js");
const {
  FINAL_ANSWER_INSTRUCTION,
  isJsonFinalAnswer,
  isSchemaValidFinalAnswer,
  salvageFindings,
  salvageWithRepair,
  selectSalvageSource,
} = await import("./agentic-degradation.js");
const { DEFAULT_REPAIR_MAX_OUTPUT_TOKENS, repairMaxOutputTokens } =
  await import("./agent-runner.js");

const reply = (content: string): ChatResponse => ({
  content,
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  model: "stub",
  provider: "offline-stub",
});

const TOOL_CALL = JSON.stringify({ tool: "search_code_graph", args: { query: "auth" } });

const finding = (title: string) => ({
  category: "architecture",
  severity: "medium",
  title,
  body: "body",
  tags: [],
  citations: [],
});

/** A complete, schema-valid agent payload. */
const VALID_JSON = JSON.stringify({
  agentKey: "code",
  summary: "code summary",
  findings: [finding("A")],
  notes: [],
});

/**
 * The D3 signature: the model was cut off mid-`findings` array by the output
 * cap. `extractJsonObject` cannot recover it (first `{` to last `}` is
 * unbalanced), so plain `salvageFindings` yields nothing — repair is the only
 * route back to the investigation.
 */
const TRUNCATED_JSON =
  '{"agentKey":"code","summary":"code summary","findings":[' +
  JSON.stringify(finding("A")) +
  ',{"category":"architecture","severity":"med';

/** Balanced braces, still unparseable — a different failure from truncation. */
const MALFORMED_JSON = '{"agentKey":"code",,"summary":"code summary","findings":[]}';

const PROSE = "I ran out of room before I could finish. Sorry.";

const searchTool: AgentTool = {
  name: "search_code_graph",
  description: "search the code graph",
  parameters: { type: "object", properties: { query: { type: "string" } } },
  async execute() {
    return { content: "symbol: createSession at server/src/auth/session.ts:10-42" };
  },
} as unknown as AgentTool;

/**
 * Always answers with a tool call so the loop can only end by exhausting its
 * turn cap or token budget — unless the turn carries the tool-free final-answer
 * instruction, in which case it answers with `finalAnswer`.
 */
function makeLoopProvider(finalAnswer: string | null): AIProvider & {
  calls: ChatMessage[][];
  opts: ChatOptions[];
} {
  const calls: ChatMessage[][] = [];
  const opts: ChatOptions[] = [];
  const provider = {
    key: "offline-stub" as const,
    model: "stub",
    offline: true,
    calls,
    opts,
    async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
      calls.push([...messages]);
      opts.push(options);
      const asked = messages.some(
        (m) => typeof m.content === "string" && m.content.includes("STOP INVESTIGATING"),
      );
      if (asked) return reply(finalAnswer ?? PROSE);
      return reply(TOOL_CALL);
    },
    async *stream() {
      yield { type: "done" } as const;
    },
    async embed() {
      return { vectors: [], dimension: 0, model: "stub" };
    },
    async models() {
      return ["stub"];
    },
    async ping() {
      return true;
    },
  };
  return provider as unknown as AIProvider & { calls: ChatMessage[][]; opts: ChatOptions[] };
}

const loopInput = {
  systemMessage: "You are Winston.",
  userMessage: "Investigate REQ-001.",
  tools: [searchTool],
  toolContext: { projectId: "proj-1" },
} as Parameters<typeof runAgentLoop>[1];

const RETRY_OPTS = {
  finalAnswerRetry: {
    instruction: FINAL_ANSWER_INSTRUCTION,
    isValidFinalAnswer: isJsonFinalAnswer,
  },
} as const;

/**
 * The #1314 signature, taken from analysis `cmsnhaaxo00029wwhrr7bw4lc`: the
 * model nested its payload one level too deep. It parses, so the shape-only
 * retry gate waved it through, and it carries no top-level `findings` array, so
 * the salvage that ran instead had nothing to recover.
 */
const SCHEMA_INVALID_JSON = JSON.stringify({
  agentKey: "code",
  summary: "code summary",
  result: { findings: [finding("A")] },
  notes: [],
});

const SCHEMA_RETRY_OPTS = {
  finalAnswerRetry: {
    instruction: FINAL_ANSWER_INSTRUCTION,
    isValidFinalAnswer: isSchemaValidFinalAnswer,
  },
} as const;

/** Ends the loop on a schema-invalid answer, then serves `retryAnswer`. */
function makeSchemaInvalidProvider(retryAnswer: string) {
  const opts: ChatOptions[] = [];
  const provider = {
    key: "offline-stub" as const,
    model: "stub",
    offline: true,
    opts,
    async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
      opts.push(options);
      const asked = messages.some(
        (m) => typeof m.content === "string" && m.content.includes("STOP INVESTIGATING"),
      );
      return reply(asked ? retryAnswer : SCHEMA_INVALID_JSON);
    },
    async *stream() {
      yield { type: "done" } as const;
    },
    async embed() {
      return { vectors: [], dimension: 0, model: "stub" };
    },
    async models() {
      return ["stub"];
    },
    async ping() {
      return true;
    },
  };
  return provider as unknown as AIProvider & { opts: ChatOptions[] };
}

/** Reproduce the exact D1 sequence: token-budget stop on a pending tool call. */
async function runBudgetStop(retryAnswer: string | null) {
  const provider = makeLoopProvider(retryAnswer);
  const result = await runAgentLoop(provider, loopInput, {
    maxTurns: 10,
    maxTokens: 20, // one 15-token turn blows it
    ...RETRY_OPTS,
  });
  return { provider, result };
}

beforeEach(() => {
  logInfo.mockClear();
  logWarn.mockClear();
});

describe("#1217 classifyFinalAnswer", () => {
  it("distinguishes every final-answer failure mode", () => {
    expect(classifyFinalAnswer(VALID_JSON)).toBe("valid-json");
    expect(classifyFinalAnswer(TRUNCATED_JSON)).toBe("truncated-json");
    expect(classifyFinalAnswer(MALFORMED_JSON)).toBe("malformed-json");
    expect(classifyFinalAnswer(PROSE)).toBe("prose");
    expect(classifyFinalAnswer(TOOL_CALL)).toBe("tool-call");
    expect(classifyFinalAnswer("   ")).toBe("empty");
  });

  it("accepts a fenced JSON object as valid", () => {
    expect(classifyFinalAnswer("```json\n" + VALID_JSON + "\n```")).toBe("valid-json");
  });

  it("#1218 — does not count braces that live inside string values", () => {
    // Structurally balanced; unparseable only because of the double comma. The
    // `{` inside the summary used to tip the balance check into `truncated-json`
    // and send the repair triage down the wrong branch.
    expect(classifyFinalAnswer('{"summary":"config uses { here",,"findings":[]}')).toBe(
      "malformed-json",
    );
    // The truncation signature survives the strip: a cut-off payload ends in an
    // UNTERMINATED string, which has no closing quote to match on.
    expect(classifyFinalAnswer(TRUNCATED_JSON)).toBe("truncated-json");
  });
});

describe("#1314 — a JSON-shaped but schema-invalid answer must still get the retry", () => {
  it("reproduces the production signature: valid-json, yet salvage recovers nothing", () => {
    // Exactly what the degraded-run log reported: sourceKind=valid-json,
    // repairAttempted=false, salvagedFindings=0.
    expect(classifyFinalAnswer(SCHEMA_INVALID_JSON)).toBe("valid-json");
    expect(salvageFindings(SCHEMA_INVALID_JSON)).toEqual([]);
  });

  it("the old shape-only gate accepts it; the schema gate does not", () => {
    expect(isJsonFinalAnswer(SCHEMA_INVALID_JSON)).toBe(true);
    expect(isSchemaValidFinalAnswer(SCHEMA_INVALID_JSON)).toBe(false);
    expect(isSchemaValidFinalAnswer(VALID_JSON)).toBe(true);
  });

  it("does not reject a payload merely for carrying the wrong agentKey", () => {
    // The orchestrator stamps the real key AFTER the loop returns, so the gate
    // must not decide on it.
    expect(
      isSchemaValidFinalAnswer(JSON.stringify({ ...JSON.parse(VALID_JSON), agentKey: "x" })),
    ).toBe(true);
  });

  it("shows the shape-only gate skipping the retry — the defect itself", async () => {
    const provider = makeSchemaInvalidProvider(VALID_JSON);
    const result = await runAgentLoop(provider, loopInput, { maxTurns: 4, ...RETRY_OPTS });
    // The bug: the one call built to repair a bad answer never happens.
    expect(result.finalAnswerRetry).toBeUndefined();
    expect(result.hasFinalAnswer).toBe(true);
    expect(salvageFindings(selectSalvageSource(result))).toEqual([]);
  });

  it("fires the retry under the schema gate and accepts the corrected answer", async () => {
    const provider = makeSchemaInvalidProvider(VALID_JSON);
    const result = await runAgentLoop(provider, loopInput, { maxTurns: 4, ...SCHEMA_RETRY_OPTS });
    expect(result.finalAnswerRetry).toEqual({ attempted: true, succeeded: true });
    expect(result.hasFinalAnswer).toBe(true);
    expect(result.finalResponse).toBe(VALID_JSON);
    // The investigation is recovered rather than discarded.
    expect(salvageFindings(result.finalResponse)).toHaveLength(1);
  });

  it("spends the retry at most once when the retry is also schema-invalid", async () => {
    const provider = makeSchemaInvalidProvider(SCHEMA_INVALID_JSON);
    const result = await runAgentLoop(provider, loopInput, { maxTurns: 4, ...SCHEMA_RETRY_OPTS });
    expect(result.finalAnswerRetry).toEqual({ attempted: true, succeeded: false });
    expect(result.hasFinalAnswer).toBe(false);
    // Preserved for the caller's salvage pass rather than dropped (#1217 AC2).
    expect(result.salvageSource).toBe(SCHEMA_INVALID_JSON);
    expect(provider.opts.filter((o) => o.maxTokens !== undefined)).toHaveLength(1);
  });

  it("makes no extra provider call when the loop answers schema-validly", async () => {
    const provider = makeSchemaInvalidProvider(VALID_JSON);
    // A loop whose FIRST answer already validates must not pay for a retry.
    const result = await runAgentLoop(
      {
        ...provider,
        async chat() {
          return reply(VALID_JSON);
        },
      } as unknown as AIProvider,
      loopInput,
      { maxTurns: 4, ...SCHEMA_RETRY_OPTS },
    );
    expect(result.finalAnswerRetry).toBeUndefined();
    expect(result.hasFinalAnswer).toBe(true);
  });
});

describe("#1217 AC1 — the retry gets an explicit OUTPUT cap, not the token budget", () => {
  it("sends maxTokens above the provider's 4096 default on the retry call", async () => {
    const { provider } = await runBudgetStop(VALID_JSON);
    const retryOpts = provider.opts.at(-1)!;
    expect(retryOpts.maxTokens).toBe(DEFAULT_FINAL_ANSWER_MAX_OUTPUT_TOKENS);
    expect(retryOpts.maxTokens!).toBeGreaterThan(4096);
    // D3's naming trap: this is the OUTPUT cap, never the loop's token BUDGET
    // (20 above), and never derived from it.
    expect(retryOpts.maxTokens).not.toBe(20);
  });

  it("does not cap the ordinary investigation turns", async () => {
    const { provider } = await runBudgetStop(VALID_JSON);
    expect(provider.opts[0]!.maxTokens).toBeUndefined();
  });

  it("honours an explicit maxOutputTokens override", async () => {
    const provider = makeLoopProvider(VALID_JSON);
    await runAgentLoop(provider, loopInput, {
      maxTurns: 2,
      finalAnswerRetry: { ...RETRY_OPTS.finalAnswerRetry, maxOutputTokens: 9001 },
    });
    expect(provider.opts.at(-1)!.maxTokens).toBe(9001);
  });
});

describe("#1217 AC2 — an invalid retry answer is preserved, not discarded", () => {
  it("keeps a truncated-mid-array retry response as the salvage source", async () => {
    const { result } = await runBudgetStop(TRUNCATED_JSON);
    expect(result.finalAnswerRetry).toEqual({ attempted: true, succeeded: false });
    expect(result.hasFinalAnswer).toBe(false);
    // The prose fallback still guards the caller-visible field (#718)...
    expect(result.finalResponse).toContain("tool-call limit");
    // ...but the model's actual words survive for salvage.
    expect(result.salvageSource).toBe(TRUNCATED_JSON);
  });

  it("falls back to the pre-overwrite response when the retry itself threw", async () => {
    let n = 0;
    const provider = {
      key: "offline-stub" as const,
      model: "stub",
      offline: true,
      async chat(): Promise<ChatResponse> {
        n += 1;
        if (n > 1) throw new Error("gateway 500");
        return reply(TOOL_CALL);
      },
      async *stream() {
        yield { type: "done" } as const;
      },
      async embed() {
        return { vectors: [], dimension: 0, model: "stub" };
      },
      async models() {
        return ["stub"];
      },
      async ping() {
        return true;
      },
    } as unknown as AIProvider;
    const result = await runAgentLoop(provider, loopInput, { maxTurns: 1, ...RETRY_OPTS });
    expect(result.salvageSource).toBe(TOOL_CALL);
    expect(result.finalResponse).toContain("tool-call limit");
  });
});

describe("#1217 AC3 — the token-budget path can now yield salvaged findings", () => {
  it("recovers findings from the D1 sequence that previously always yielded 0", async () => {
    const { result } = await runBudgetStop(TRUNCATED_JSON);

    // What the orchestrator used to salvage from: the brace-free prose. Always 0.
    expect(salvageFindings(result.finalResponse)).toHaveLength(0);

    // What it salvages from now, through the same helper the orchestrator calls.
    const repairProvider = makeRepairProvider(VALID_JSON);
    const salvage = await salvageWithRepair(
      repairProvider.provider,
      result.salvageSource ?? result.finalResponse,
      { agentKey: "code" },
    );
    expect(salvage.findings.length).toBeGreaterThan(0);
    expect(salvage.findings[0]!.title).toBe("A");
    expect(salvage.sourceKind).toBe("truncated-json");
    expect(salvage.repairSucceeded).toBe(true);
  });

  it("salvages without any repair call when the preserved source already parses", async () => {
    // A retry that IS a tool call is invalid, so `finalResponse` is overwritten —
    // but a complete-yet-schema-invalid payload salvages directly.
    const partial = JSON.stringify({ agentKey: "code", findings: [finding("A")] });
    const repairProvider = makeRepairProvider(VALID_JSON);
    const salvage = await salvageWithRepair(repairProvider.provider, partial, { agentKey: "code" });
    expect(salvage.findings).toHaveLength(1);
    expect(salvage.repairAttempted).toBe(false);
    expect(repairProvider.calls).toBe(0);
  });
});

describe("#1217 AC4 — bounded, one-shot JSON repair outside runAgentLoop", () => {
  it("leaves runAgentLoop's provider-call count unchanged (#769)", async () => {
    const provider = makeLoopProvider(TRUNCATED_JSON);
    await runAgentLoop(provider, loopInput, { maxTurns: 3, ...RETRY_OPTS });
    // 3 investigation turns + exactly ONE retry. Repair happens in the caller.
    expect(provider.calls).toHaveLength(4);
  });

  it("attempts repair exactly once and never retries it", async () => {
    const repairProvider = makeRepairProvider(VALID_JSON);
    const salvage = await salvageWithRepair(repairProvider.provider, TRUNCATED_JSON, {
      agentKey: "code",
    });
    expect(repairProvider.calls).toBe(1);
    expect(salvage.repairAttempted).toBe(true);
    expect(salvage.findings).toHaveLength(1);
  });

  it("does not repeat the repair when the repair itself comes back unusable", async () => {
    const repairProvider = makeRepairProvider("still not json");
    const salvage = await salvageWithRepair(repairProvider.provider, MALFORMED_JSON, {
      agentKey: "code",
    });
    expect(repairProvider.calls).toBe(1);
    expect(salvage.repairAttempted).toBe(true);
    expect(salvage.repairSucceeded).toBe(false);
    // #1218 F6 — the repair never parsed at all. A MODEL or cap problem.
    expect(salvage.repairParsed).toBe(false);
    expect(salvage.findings).toEqual([]);
  });

  it("does not spend a repair call on prose, an empty answer or a tool call", async () => {
    for (const raw of [PROSE, "", TOOL_CALL]) {
      const repairProvider = makeRepairProvider(VALID_JSON);
      const salvage = await salvageWithRepair(repairProvider.provider, raw, { agentKey: "code" });
      expect(repairProvider.calls).toBe(0);
      expect(salvage.repairAttempted).toBe(false);
      expect(salvage.findings).toEqual([]);
    }
  });

  it("never throws when the repair provider errors", async () => {
    const provider = {
      key: "offline-stub" as const,
      model: "stub",
      offline: true,
      async chat(): Promise<ChatResponse> {
        throw new Error("gateway 500");
      },
      async *stream() {
        yield { type: "done" } as const;
      },
      async embed() {
        return { vectors: [], dimension: 0, model: "stub" };
      },
      async models() {
        return ["stub"];
      },
      async ping() {
        return true;
      },
    } as unknown as AIProvider;
    const salvage = await salvageWithRepair(provider, TRUNCATED_JSON, { agentKey: "code" });
    expect(salvage.repairSucceeded).toBe(false);
    expect(salvage.findings).toEqual([]);
  });

  it("drops a repaired finding that does not validate — repair is not a hallucination channel", async () => {
    // The repair returns well-formed JSON whose finding is missing required
    // fields. Salvage validates every candidate, so nothing gets through.
    const repairProvider = makeRepairProvider(
      JSON.stringify({ agentKey: "code", findings: [{ title: "invented" }] }),
    );
    const salvage = await salvageWithRepair(repairProvider.provider, TRUNCATED_JSON, {
      agentKey: "code",
    });
    expect(salvage.findings).toEqual([]);
    expect(salvage.repairSucceeded).toBe(false);
    // #1218 F6 — and it says so for the RIGHT reason: the repair parsed fine,
    // the guard rejected what it invented. Distinguishable in the log from the
    // unparseable case above, which needs a completely different fix.
    expect(salvage.repairParsed).toBe(true);
  });
});

describe("#1218 — the repair call carries its OWN output cap, or it reproduces D3", () => {
  it("pins an explicit maxTokens above the provider's 4096 default", async () => {
    const repairProvider = makeRepairProvider(VALID_JSON);
    await salvageWithRepair(repairProvider.provider, TRUNCATED_JSON, { agentKey: "code" });

    const opts = repairProvider.opts.at(-1)!;
    expect(opts.maxTokens).toBe(DEFAULT_REPAIR_MAX_OUTPUT_TOKENS);
    // Repair is an ECHO. Unset, it inherited `defaultMaxTokens = 4096` and
    // truncated its own output on any payload the 16384-capped retry produced —
    // reproducing the exact defect it exists to undo.
    expect(opts.maxTokens!).toBeGreaterThanOrEqual(DEFAULT_FINAL_ANSWER_MAX_OUTPUT_TOKENS);
    expect(opts.maxTokens!).toBeGreaterThan(4096);
  });

  it("scales the cap off the cap that bounded the text it must echo back", () => {
    // Headroom, because a syntax fix ADDS characters (a closing bracket, an
    // escaped quote) — the repair is never shorter than its input.
    expect(repairMaxOutputTokens(8192)).toBeGreaterThan(8192);
    expect(Number.isInteger(repairMaxOutputTokens(8192))).toBe(true);
    expect(repairMaxOutputTokens(DEFAULT_FINAL_ANSWER_MAX_OUTPUT_TOKENS)).toBe(
      DEFAULT_REPAIR_MAX_OUTPUT_TOKENS,
    );
  });

  it("honours a caller-supplied cap, so an 8192-ceiling model stays serviceable", async () => {
    const repairProvider = makeRepairProvider(VALID_JSON);
    await salvageWithRepair(repairProvider.provider, TRUNCATED_JSON, {
      agentKey: "code",
      maxOutputTokens: 10240,
    });
    expect(repairProvider.opts.at(-1)!.maxTokens).toBe(10240);
  });
});

describe("#1218 — selectSalvageSource, the orchestrator's salvage-source seam", () => {
  it("prefers the preserved source over the overwritten finalResponse", async () => {
    const { result } = await runBudgetStop(TRUNCATED_JSON);
    // Both are present and they DIFFER — the whole point of D1.
    expect(result.salvageSource).toBe(TRUNCATED_JSON);
    expect(result.finalResponse).not.toBe(TRUNCATED_JSON);
    expect(selectSalvageSource(result)).toBe(TRUNCATED_JSON);
    // Reading finalResponse instead is D1 exactly: 0 findings, every run.
    expect(salvageFindings(result.finalResponse)).toHaveLength(0);
  });

  it("falls back to finalResponse when no retry ran", () => {
    expect(selectSalvageSource({ finalResponse: VALID_JSON })).toBe(VALID_JSON);
  });
});

describe("#1217 AC5 — diagnostics distinguish the failure modes", () => {
  const retryWarn = () =>
    logWarn.mock.calls.find(([msg]) => String(msg).includes("Final-answer retry did not validate"));

  it("warns on a returned-but-invalid retry, recording kind, length, finish reason and preview", async () => {
    await runBudgetStop(TRUNCATED_JSON);
    const warn = retryWarn();
    expect(warn).toBeDefined();
    const fields = warn![1] as Record<string, unknown>;
    expect(fields.retryOutcome).toBe("truncated-json");
    expect(fields.responseLength).toBe(TRUNCATED_JSON.length);
    expect(fields.finishReason).toBe("unknown");
    expect(String(fields.preview)).toContain('"agentKey":"code"');
    // The preview is bounded — a full findings payload must never land in a log.
    expect(String(fields.preview).length).toBeLessThanOrEqual(320);
  });

  it("#1218 F4 — keeps the model's words off the info line, which fires on every retry", async () => {
    await runBudgetStop(TRUNCATED_JSON);
    const info = logInfo.mock.calls.find(([msg]) =>
      String(msg).includes("Final-answer retry completed"),
    );
    expect(info).toBeDefined();
    const fields = info![1] as Record<string, unknown>;
    // Same diagnosis, none of the model-authored source commentary: the info
    // line still says what happened.
    expect(fields.retryOutcome).toBe("truncated-json");
    expect(fields.responseLength).toBe(TRUNCATED_JSON.length);
    expect(fields).not.toHaveProperty("preview");
    expect(JSON.stringify(fields)).not.toContain("agentKey");
  });

  it("reports prose, truncated JSON and malformed JSON as different outcomes", async () => {
    const outcomes: unknown[] = [];
    for (const answer of [PROSE, TRUNCATED_JSON, MALFORMED_JSON]) {
      logWarn.mockClear();
      await runBudgetStop(answer);
      outcomes.push((retryWarn()![1] as Record<string, unknown>).retryOutcome);
    }
    expect(outcomes).toEqual(["prose", "truncated-json", "malformed-json"]);
  });

  it("does not warn when the retry produced a usable answer", async () => {
    await runBudgetStop(VALID_JSON);
    expect(retryWarn()).toBeUndefined();
    const info = logInfo.mock.calls.find(([msg]) =>
      String(msg).includes("Final-answer retry completed"),
    );
    expect((info![1] as Record<string, unknown>).succeeded).toBe(true);
    expect((info![1] as Record<string, unknown>).retryOutcome).toBe("valid-json");
  });
});

describe("#1217 AC6 — no regression on the passing paths", () => {
  it("makes no retry call and sets no salvage source when the loop answers cleanly", async () => {
    let n = 0;
    const opts: ChatOptions[] = [];
    const provider = {
      key: "offline-stub" as const,
      model: "stub",
      offline: true,
      async chat(_m: ChatMessage[], o: ChatOptions = {}): Promise<ChatResponse> {
        n += 1;
        opts.push(o);
        return reply(VALID_JSON);
      },
      async *stream() {
        yield { type: "done" } as const;
      },
      async embed() {
        return { vectors: [], dimension: 0, model: "stub" };
      },
      async models() {
        return ["stub"];
      },
      async ping() {
        return true;
      },
    } as unknown as AIProvider;
    const result = await runAgentLoop(provider, loopInput, { maxTurns: 5, ...RETRY_OPTS });
    expect(n).toBe(1);
    expect(opts[0]!.maxTokens).toBeUndefined();
    expect(result.finalAnswerRetry).toBeUndefined();
    expect(result.salvageSource).toBeUndefined();
    expect(result.hasFinalAnswer).toBe(true);
  });

  it("leaves the #713 chat-reuse path byte-identical (no finalAnswerRetry)", async () => {
    const provider = makeLoopProvider(VALID_JSON);
    const result = await runAgentLoop(provider, loopInput, { maxTurns: 2 });
    expect(provider.calls).toHaveLength(2);
    expect(provider.opts.every((o) => o.maxTokens === undefined)).toBe(true);
    expect(result.finalAnswerRetry).toBeUndefined();
    expect(result.finalResponse).toContain("tool-call limit");
    // No retry ran, so there is nothing preserved to salvage from beyond the
    // pre-overwrite response — which chat never reads.
    expect(result.salvageSource).toBe(TOOL_CALL);
    expect(result.hasFinalAnswer).toBe(false);
  });
});

/** Provider stub for the orchestrator-side repair call. */
function makeRepairProvider(repaired: string): {
  provider: AIProvider;
  calls: number;
  opts: ChatOptions[];
} {
  const state = { calls: 0 };
  const opts: ChatOptions[] = [];
  const provider = {
    key: "offline-stub" as const,
    model: "stub",
    offline: true,
    async chat(_m: ChatMessage[], o: ChatOptions = {}): Promise<ChatResponse> {
      state.calls += 1;
      opts.push(o);
      return reply(repaired);
    },
    async *stream() {
      yield { type: "done" } as const;
    },
    async embed() {
      return { vectors: [], dimension: 0, model: "stub" };
    },
    async models() {
      return ["stub"];
    },
    async ping() {
      return true;
    },
  } as unknown as AIProvider;
  return {
    provider,
    opts,
    get calls() {
      return state.calls;
    },
  };
}
