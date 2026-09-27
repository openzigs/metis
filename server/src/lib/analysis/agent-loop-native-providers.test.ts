/**
 * #141 — the analysis agent loop on native tool calls, driven through the REAL
 * provider classes against a loopback HTTP server, multi-turn, for every
 * provider family the analysis path can run on:
 *
 *   • Anthropic (factory-built `AnthropicProvider`, official SDK);
 *   • Anthropic-compatible (`AnthropicProvider` on a custom base URL), served
 *     the RECORDED DeepSeek replies from `tests/fixtures/llm/provider-contract`;
 *   • OpenAI and Azure (factory-built OpenAI-compatible client);
 *   • the Bedrock gateway (factory-built) and Bedrock direct (the
 *     `BedrockDirectProvider` the analysis route constructs itself);
 *   • local (`local-gemma`), served the RECORDED Ollama replies.
 *
 * What is pinned, per family: tools go out as native definitions on every
 * turn; several calls in one reply run in order; every call id is answered
 * with its result on the next request and stays answered on the one after;
 * the loop ends on the model's answer. With the flag off the wire carries no
 * `tools` and the text protocol runs — and a model the catalog marks not
 * tool-capable produces those SAME request bytes with the flag on. A runtime
 * that rejects `tools` makes the loop fall back to the text protocol instead
 * of investigating with no tools at all.
 *
 * Nothing here reaches beyond 127.0.0.1: the server is started per file on an
 * ephemeral port.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  NATIVE_TOOL_PROTOCOL,
  resolveAnalysisNativeTools,
  runAgentLoop,
  type AgentLoopResult,
} from "./agent-loop.js";
import { buildAgenticPassPrompt } from "./agentic-pass-context.js";
import { FINAL_ANSWER_INSTRUCTION, isSchemaValidFinalAnswer } from "./agentic-degradation.js";
import type { AgentTool } from "./tools/types.js";
import type { AIConfig } from "../ai/config.js";
import type { AIProvider } from "../ai/types.js";
import { buildProvider } from "../ai/providers/factory.js";
import { AnthropicProvider } from "../ai/providers/anthropic-provider.js";
import { BedrockDirectProvider } from "../ai/providers/bedrock-direct-provider.js";
import { resetLocalConcurrencyLimitersForTests } from "../ai/providers/openai-compatible-provider.js";
import {
  RECORDED_FIXTURE_ROOT,
  viewRecordedContent,
  type RecordedFixture,
  type WireFormat,
} from "../../../tests/lib/ai/provider-contract/recorded.js";

// ── Loopback server ───────────────────────────────────────────────────────

interface Seen {
  path: string;
  body: Record<string, unknown>;
}
interface Reply {
  status?: number;
  json: unknown;
}
type Scripted = Reply | ((req: Seen) => Reply);

const seen: Seen[] = [];
let queue: Scripted[] = [];
let server: http.Server;
let origin = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString("utf8")));
    req.on("end", () => {
      const s: Seen = { path: req.url ?? "", body: data ? JSON.parse(data) : {} };
      seen.push(s);
      const next = queue.shift();
      const reply: Reply = !next
        ? { status: 400, json: { error: { message: "loopback script exhausted" } } }
        : typeof next === "function"
          ? next(s)
          : next;
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ENV = ["ANALYSIS_NATIVE_TOOL_CALLS", "AI_MODEL_CATALOG_OVERRIDES"] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  seen.length = 0;
  queue = [];
  executed.length = 0;
  for (const k of ENV) savedEnv[k] = process.env[k];
  resetLocalConcurrencyLimitersForTests();
});
afterEach(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── Wire replies ──────────────────────────────────────────────────────────

interface Call {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

function anthropicReply(text: string, calls: Call[] = []): Reply {
  return {
    json: {
      id: "msg_loopback",
      type: "message",
      role: "assistant",
      model: "loopback-model",
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args })),
      ],
      stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 10 },
    },
  };
}

function openAIReply(text: string, calls: Call[] = []): Reply {
  return {
    json: {
      id: "chatcmpl-loopback",
      object: "chat.completion",
      model: "loopback-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: calls.length > 0 && !text ? null : text,
            ...(calls.length > 0
              ? {
                  tool_calls: calls.map((c) => ({
                    id: c.id,
                    type: "function",
                    function: { name: c.name, arguments: JSON.stringify(c.args) },
                  })),
                }
              : {}),
          },
          finish_reason: calls.length > 0 ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    },
  };
}

function reply(wire: WireFormat, text: string, calls: Call[] = []): Reply {
  return wire === "anthropic-messages" ? anthropicReply(text, calls) : openAIReply(text, calls);
}

/** The recorded reply bytes of one committed provider-contract fixture. */
function recorded(runtime: string, scenario: string): { reply: Reply; fixture: RecordedFixture } {
  const file = path.join(RECORDED_FIXTURE_ROOT, runtime, `${scenario}.json`);
  const fixture = JSON.parse(fs.readFileSync(file, "utf8")) as RecordedFixture;
  return { reply: { json: fixture.exchanges[0]!.response.json }, fixture };
}

// ── Analysis tools ────────────────────────────────────────────────────────

const executed: string[] = [];
function tool(name: string, key: string): AgentTool {
  return {
    name,
    description: `${name} over the project`,
    parameters: {
      type: "object",
      properties: { [key]: { type: "string", description: key } },
      required: [key],
    },
    async execute(args) {
      const v = String((args as Record<string, unknown>)[key] ?? "");
      executed.push(`${name}:${v}`);
      return { content: `RESULT ${name}:${v}`, resultCount: 1 };
    },
  };
}
// The recorded fixtures call `search_code` then `read_file`; the analysis tools
// here carry the same names so the recorded bytes drive real executions.
const TOOLS = [tool("search_code", "query"), tool("read_file", "path")];
const loopInput = {
  systemMessage: "You are the code analyst.",
  userMessage: "Where is the interest rate defined?",
  tools: TOOLS,
  toolContext: { projectId: "p-141" },
};

/** Exactly what the orchestrator does for one agentic pass (#141). */
async function analysisPass(provider: AIProvider, model: string): Promise<AgentLoopResult> {
  const native = resolveAnalysisNativeTools(provider, model, TOOLS);
  return runAgentLoop(provider, loopInput, {
    ...(native ? { native } : {}),
    maxTurns: 5,
    model,
    promptCaching: { system: true, messages: true },
  });
}

// ── Families ──────────────────────────────────────────────────────────────

interface Family {
  name: string;
  wire: WireFormat;
  model: string;
  make: (origin: string) => AIProvider;
  /** Recorded replies replacing the scripted first/last turn (DeepSeek, Ollama). */
  recordedRuntime?: string;
  /** Extra per-request wire assertions for this family. */
  eachRequest?: (body: Record<string, unknown>) => void;
}

function config(over: Partial<AIConfig>): AIConfig {
  return {
    offline: false,
    rateLimit: { windowMs: 60_000, max: 100 },
    pingTimeoutMs: 1_000,
    ...over,
  } as AIConfig;
}

const FAMILIES: Family[] = [
  {
    name: "anthropic (factory)",
    wire: "anthropic-messages",
    model: "claude-sonnet-4-6",
    make: (o) =>
      buildProvider({
        config: config({
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          sdkProvider: { type: "anthropic", baseUrl: o, apiKey: "test-key" } as never,
        }),
      }),
  },
  {
    name: "anthropic-compatible (recorded DeepSeek replies)",
    wire: "anthropic-messages",
    model: "deepseek-v4-pro",
    recordedRuntime: "deepseek",
    make: (o) =>
      new AnthropicProvider({
        apiKey: "test-key",
        baseUrl: `${o}/anthropic`,
        model: "deepseek-v4-pro",
      }),
  },
  {
    name: "openai (factory)",
    wire: "openai-chat-completions",
    model: "gpt-4o",
    make: (o) =>
      buildProvider({
        config: config({
          provider: "openai",
          model: "gpt-4o",
          sdkProvider: { type: "openai", baseUrl: `${o}/v1`, apiKey: "test-key" } as never,
        }),
      }),
  },
  {
    name: "azure (factory)",
    wire: "openai-chat-completions",
    model: "gpt-4o",
    make: (o) =>
      buildProvider({
        config: config({
          provider: "azure",
          model: "gpt-4o",
          sdkProvider: {
            type: "azure",
            baseUrl: o,
            apiKey: "test-key",
            deployment: "gpt-4o",
          } as never,
        }),
      }),
  },
  {
    name: "bedrock-gateway (factory)",
    wire: "openai-chat-completions",
    model: "us.anthropic.claude-sonnet-5",
    make: (o) =>
      buildProvider({
        config: config({
          provider: "bedrock-gateway",
          model: "us.anthropic.claude-sonnet-5",
          sdkProvider: { type: "openai", baseUrl: `${o}/api/v1`, apiKey: "test-key" } as never,
        }),
      }),
  },
  {
    name: "bedrock direct (the analysis route's own construction)",
    wire: "openai-chat-completions",
    model: "us.anthropic.claude-sonnet-5",
    make: (o) =>
      new BedrockDirectProvider({
        baseUrl: `${o}/api/v1`,
        apiKey: "test-key",
        model: "us.anthropic.claude-sonnet-5",
        providerKey: "bedrock-gateway",
      }),
  },
  {
    name: "local (recorded Ollama replies)",
    wire: "openai-chat-completions",
    model: "laguna-s-2.1",
    recordedRuntime: "ollama",
    make: (o) =>
      new BedrockDirectProvider({
        baseUrl: `${o}/v1`,
        apiKey: "ollama",
        model: "laguna-s-2.1",
        providerKey: "local-gemma",
      }),
  },
  {
    name: "local, thinking off (recorded Ollama replies)",
    wire: "openai-chat-completions",
    model: "laguna-s-2.1",
    recordedRuntime: "ollama",
    make: (o) =>
      new BedrockDirectProvider({
        baseUrl: `${o}/v1`,
        apiKey: "ollama",
        model: "laguna-s-2.1",
        providerKey: "local-gemma",
        disableThinking: true,
      }),
    // Must-preserve: thinking stays off on the local provider with tools on the wire.
    eachRequest: (body) => {
      expect(body.think).toBe(false);
      expect(body.reasoning_effort).toBe("none");
    },
  },
];

const FINAL = '{"findings":[]}';

/** Turn 1 two calls, turn 2 one call, turn 3 the answer. */
function nativeScript(f: Family): { script: Scripted[]; firstIds: string[]; finalText: string } {
  const second: Call = { id: "call_second", name: "search_code", args: { query: "rate change" } };
  if (f.recordedRuntime) {
    const first = recorded(f.recordedRuntime, "tools-chat");
    const last = recorded(f.recordedRuntime, "tool-results");
    const firstCalls = (first.fixture.result as { response: { toolCalls: Call[] } }).response
      .toolCalls;
    return {
      script: [first.reply, reply(f.wire, "", [second]), last.reply],
      firstIds: firstCalls.map((c) => c.id),
      finalText: (last.fixture.result as { response: { content: string } }).response.content,
    };
  }
  const firstCalls: Call[] = [
    { id: "call_a", name: "search_code", args: { query: "interest rate" } },
    { id: "call_b", name: "read_file", args: { path: "src/Loan.java" } },
  ];
  return {
    script: [reply(f.wire, "", firstCalls), reply(f.wire, "", [second]), reply(f.wire, FINAL)],
    firstIds: firstCalls.map((c) => c.id),
    finalText: FINAL,
  };
}

function toolNames(wire: WireFormat, body: Record<string, unknown>): string[] {
  const tools = (body.tools as Array<Record<string, unknown>> | undefined) ?? [];
  return tools.map((t) =>
    wire === "anthropic-messages"
      ? String(t.name)
      : String((t.function as Record<string, unknown>).name),
  );
}

function toolChoice(wire: WireFormat, body: Record<string, unknown>): unknown {
  const c = body.tool_choice;
  return wire === "anthropic-messages" ? (c as { type?: string } | undefined)?.type : c;
}

describe.each(FAMILIES)("#141 native analysis loop over loopback — $name", (f) => {
  it("offers native tools every turn, runs calls in order, and round-trips every result", async () => {
    process.env.ANALYSIS_NATIVE_TOOL_CALLS = "true";
    const provider = f.make(origin);
    const { script, firstIds, finalText } = nativeScript(f);
    queue = script;

    const result = await analysisPass(provider, f.model);

    expect(result.toolProtocol).toBe("native");
    expect(executed).toEqual([
      "search_code:interest rate",
      "read_file:src/Loan.java",
      "search_code:rate change",
    ]);
    expect(result.finalResponse).toBe(finalText);
    expect(result.hasFinalAnswer).toBe(true);
    expect(result.turnsUsed).toBe(3);
    expect(result.toolCalls.map((c) => c.callId)).toEqual([...firstIds, "call_second"]);
    expect(seen).toHaveLength(3);

    for (const req of seen) {
      expect(toolNames(f.wire, req.body)).toEqual(["read_file", "search_code"]);
      expect(toolChoice(f.wire, req.body)).toBe("auto");
      f.eachRequest?.(req.body);
      const view = viewRecordedContent(f.wire, req.body);
      // The text-protocol manifest is not rendered; the native tail is.
      expect(view.system).toContain(NATIVE_TOOL_PROTOCOL.trim().split("\n")[2]);
      expect(view.system).not.toContain('{"tool":');
    }

    // Request 2 answers BOTH turn-1 calls, in order, with their own results.
    const second = viewRecordedContent(f.wire, seen[1]!.body).turns;
    const assistant1 = second.find((t) => t.role === "assistant" && t.toolCalls.length > 0)!;
    expect(assistant1.toolCalls.map((c) => c.id)).toEqual(firstIds);
    const results2 = second.flatMap((t) => t.toolResults);
    expect(results2.map((r) => r.id)).toEqual(firstIds);
    expect(results2[0]!.content).toContain("RESULT search_code:interest rate");
    expect(results2[0]!.content).toContain("===METIS-DATA-BOUNDARY===");
    expect(results2[1]!.content).toContain("RESULT read_file:src/Loan.java");

    // Request 3 carries the whole investigation: all three calls answered.
    const third = viewRecordedContent(f.wire, seen[2]!.body).turns;
    expect(third.flatMap((t) => t.toolCalls).map((c) => c.id)).toEqual([
      ...firstIds,
      "call_second",
    ]);
    const results3 = third.flatMap((t) => t.toolResults);
    expect(results3.map((r) => r.id)).toEqual([...firstIds, "call_second"]);
    expect(results3[2]!.content).toContain("RESULT search_code:rate change");
  });

  it("flag off: no tools on the wire, the text protocol runs, results come back as text", async () => {
    delete process.env.ANALYSIS_NATIVE_TOOL_CALLS;
    const provider = f.make(origin);
    queue = [
      reply(
        f.wire,
        '{"tool": "search_code", "args": {"query": "interest rate"}}\n' +
          '{"tool": "read_file", "args": {"path": "src/Loan.java"}}',
      ),
      reply(f.wire, FINAL),
    ];

    const result = await analysisPass(provider, f.model);

    expect(result.toolProtocol).toBeUndefined();
    // #15 — several text-protocol calls in one reply still run, in order.
    expect(executed).toEqual(["search_code:interest rate", "read_file:src/Loan.java"]);
    expect(result.finalResponse).toBe(FINAL);
    expect(seen).toHaveLength(2);
    for (const req of seen) {
      expect(req.body.tools).toBeUndefined();
      expect(req.body.tool_choice).toBeUndefined();
      f.eachRequest?.(req.body);
      expect(viewRecordedContent(f.wire, req.body).system).toContain('{"tool":');
    }
    const turns = viewRecordedContent(f.wire, seen[1]!.body).turns;
    expect(turns.at(-1)!.role).toBe("user");
    expect(turns.at(-1)!.text).toMatch(/^Tool result for search_code:\nRESULT search_code/);
    expect(turns.at(-1)!.text).toContain("Tool result for read_file:\nRESULT read_file");
  });

  it("a model the catalog marks not tool-capable sends the flag-off bytes with the flag on", async () => {
    const provider = f.make(origin);
    const script = () => [
      reply(f.wire, '{"tool": "search_code", "args": {"query": "q"}}'),
      reply(f.wire, FINAL),
    ];
    delete process.env.ANALYSIS_NATIVE_TOOL_CALLS;
    queue = script();
    await analysisPass(provider, f.model);
    const flagOff = seen.splice(0).map((s) => s.body);

    process.env.ANALYSIS_NATIVE_TOOL_CALLS = "true";
    const key = f.name.startsWith("anthropic") ? "anthropic" : (provider.key as string);
    process.env.AI_MODEL_CATALOG_OVERRIDES = JSON.stringify({
      [`${key}:${f.model}`]: { capabilities: { tools: false } },
    });
    queue = script();
    const result = await analysisPass(provider, f.model);

    expect(result.toolProtocol).toBeUndefined();
    expect(seen.map((s) => s.body)).toEqual(flagOff);
  });
});

describe("#141 runtime rejection of tools — fall back to the text protocol", () => {
  const NO_TOOLS_MODEL = "notools-model:1b";
  const rejectTools = (s: Seen): Reply =>
    s.body.tools
      ? {
          status: 400,
          json: { error: { message: `"${NO_TOOLS_MODEL}" does not support tools` } },
        }
      : openAIReply("I cannot call tools, so here is a guess.");

  it("local: a runtime that rejects tools gets the text protocol, and later passes start there", async () => {
    process.env.ANALYSIS_NATIVE_TOOL_CALLS = "true";
    const provider = new BedrockDirectProvider({
      baseUrl: `${origin}/v1`,
      apiKey: "ollama",
      model: NO_TOOLS_MODEL,
      providerKey: "local-gemma",
    });
    queue = [
      rejectTools, // native request with tools → 400
      rejectTools, // the adapter's retry without tools → a tool-less reply (discarded)
      openAIReply('{"tool": "search_code", "args": {"query": "interest rate"}}'),
      openAIReply(FINAL),
    ];

    const result = await analysisPass(provider, NO_TOOLS_MODEL);

    expect(result.toolProtocol).toBe("text-fallback");
    expect(executed).toEqual(["search_code:interest rate"]);
    expect(result.finalResponse).toBe(FINAL);
    expect(seen).toHaveLength(4);
    expect(seen[0]!.body.tools).toBeDefined();
    expect(seen[1]!.body.tools).toBeUndefined();
    // The fallback asks again WITH the text manifest, and never re-offers tools.
    for (const req of seen.slice(2)) {
      expect(req.body.tools).toBeUndefined();
      expect(viewRecordedContent("openai-chat-completions", req.body).system).toContain('{"tool":');
    }
    // The tool-less guess is not in the transcript the model reads next.
    const turns = viewRecordedContent("openai-chat-completions", seen[3]!.body).turns;
    expect(turns.map((t) => t.text).join("\n")).not.toContain("here is a guess");

    // The next agentic pass on the same provider starts on the text protocol.
    seen.length = 0;
    executed.length = 0;
    queue = [openAIReply(FINAL)];
    const next = await analysisPass(provider, NO_TOOLS_MODEL);
    expect(next.toolProtocol).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body.tools).toBeUndefined();
  });
});

// ── #214 — the final answer and the #769 retry after a native transcript ──

/**
 * The live #214 measurement (DeepSeek-flash, Anthropic-compatible) saw two
 * native passes hit the turn cap and then report the #769 retry as "returned
 * valid JSON, did not validate". The prompt was NOT the cause — the schema
 * guidance a native pass sees is the text protocol's, byte for byte (pinned
 * below). The cause was the retry gate: in native mode it rejected any retry
 * answer whose text EQUALLED the last tool-calling reply's text, so a model
 * that wrote its findings JSON next to a final tool call and then — asked to
 * answer — repeated that same JSON had a schema-valid answer thrown away.
 */
describe("#214 native final answer — same schema guidance, and an identical retry answer is accepted", () => {
  /** The real agentic pass prompt, so the real findings schema is on the wire. */
  const pass = buildAgenticPassPrompt({
    projectName: "loopback",
    projectDescription: "loopback project",
    requirements: [{ id: "REQ-1", text: "Interest rates are configurable." }],
    seeds: {
      fused: { block: "", tokens: 0 },
      affectedCode: { block: "", tokens: 0 },
      affectedSchema: { block: "", tokens: 0 },
    },
    fileToolsAvailable: true,
  });
  const passInput = { ...pass, tools: TOOLS, toolContext: { projectId: "p-214" } };
  /** Schema-valid under the #1314 gate the orchestrator uses. */
  const ANSWER = JSON.stringify({
    summary: "Rates are hard-coded; REQ-1 is a gap.",
    findings: [],
    notes: ["Investigation cut short by the turn cap."],
  });
  // Lines that exist only in the findings schema / output contract.
  const SCHEMA_GUIDANCE = [
    '"verdict": "implemented|gap-confirmed|could-not-verify"',
    '"requirementId": "<the REQ-xxx id this finding addresses>"',
    "### Output contract",
  ];

  async function turnCapPass(provider: AIProvider, model: string): Promise<AgentLoopResult> {
    const native = resolveAnalysisNativeTools(provider, model, TOOLS);
    return runAgentLoop(provider, passInput, {
      ...(native ? { native } : {}),
      maxTurns: 2,
      model,
      promptCaching: { system: true, messages: true },
      finalAnswerRetry: {
        instruction: FINAL_ANSWER_INSTRUCTION,
        isValidFinalAnswer: isSchemaValidFinalAnswer,
      },
    });
  }

  const PAIR = FAMILIES.filter((f) =>
    ["anthropic-compatible (recorded DeepSeek replies)", "openai (factory)"].includes(f.name),
  );
  expect(PAIR).toHaveLength(2);

  describe.each(PAIR)("$name", (f) => {
    it("native: a retry answer identical to the last tool-calling reply's text is the answer", async () => {
      process.env.ANALYSIS_NATIVE_TOOL_CALLS = "true";
      const provider = f.make(origin);
      const first = f.recordedRuntime
        ? recorded(f.recordedRuntime, "tools-chat").reply
        : reply(f.wire, "", [
            { id: "call_a", name: "search_code", args: { query: "interest rate" } },
          ]);
      queue = [
        first,
        // The last turn: the findings JSON AND one more tool call.
        reply(f.wire, ANSWER, [{ id: "call_last", name: "search_code", args: { query: "rate" } }]),
        // Asked to answer with no tools, the model repeats that JSON verbatim.
        reply(f.wire, ANSWER),
      ];

      const result = await turnCapPass(provider, f.model);

      expect(result.toolProtocol).toBe("native");
      expect(result.turnsUsed).toBe(2);
      expect(result.turnsExhausted).toBe(true);
      expect(result.finalAnswerRetry).toEqual({ attempted: true, succeeded: true });
      expect(result.hasFinalAnswer).toBe(true);
      expect(result.finalResponse).toBe(ANSWER);
      expect(result.salvageSource).toBeUndefined();
      expect(seen).toHaveLength(3);

      // Every turn, and the retry, carries the findings schema guidance.
      for (const req of seen) {
        const system = viewRecordedContent(f.wire, req.body).system;
        for (const line of SCHEMA_GUIDANCE) expect(system).toContain(line);
        expect(system).not.toContain('{"tool":');
      }
      // The retry: tool-free, no native-tools tail, the #769 instruction last.
      const retry = seen[2]!.body;
      expect(toolChoice(f.wire, retry)).toBe("none");
      const view = viewRecordedContent(f.wire, retry);
      expect(view.system).not.toContain(NATIVE_TOOL_PROTOCOL.trim().split("\n")[2]);
      expect(view.turns.at(-1)!.role).toBe("user");
      expect(view.turns.at(-1)!.text).toContain(FINAL_ANSWER_INSTRUCTION.split("\n")[0]);
    });

    it("native and text send the SAME answer-format guidance and the SAME retry prompt", async () => {
      const systems: Record<string, string[]> = {};
      for (const mode of ["text", "native"] as const) {
        seen.length = 0;
        process.env.ANALYSIS_NATIVE_TOOL_CALLS = mode === "native" ? "true" : "false";
        const provider = f.make(origin);
        queue =
          mode === "native"
            ? [
                reply(f.wire, "", [{ id: "c1", name: "search_code", args: { query: "a" } }]),
                reply(f.wire, "", [{ id: "c2", name: "search_code", args: { query: "b" } }]),
                reply(f.wire, ANSWER),
              ]
            : [
                reply(f.wire, '{"tool": "search_code", "args": {"query": "a"}}'),
                reply(f.wire, '{"tool": "search_code", "args": {"query": "b"}}'),
                reply(f.wire, ANSWER),
              ];
        const result = await turnCapPass(provider, f.model);
        expect(result.finalAnswerRetry).toEqual({ attempted: true, succeeded: true });
        expect(seen).toHaveLength(3);
        systems[mode] = seen.map((s) => viewRecordedContent(f.wire, s.body).system);
        const lastTurn = viewRecordedContent(f.wire, seen[2]!.body).turns.at(-1)!;
        expect(lastTurn.text).toContain(FINAL_ANSWER_INSTRUCTION);
      }
      // Turn prompts differ ONLY in the tool section: the text manifest vs the
      // native tail. Everything before it — protocol, role, schema — is shared.
      const lead = (s: string, marker: string) => s.slice(0, s.indexOf(marker));
      expect(lead(systems.native![0]!, NATIVE_TOOL_PROTOCOL)).toBe(
        lead(systems.text![0]!, "\n## Available tools (full definitions)"),
      );
      // The retry system prompt is byte-identical across the two protocols.
      expect(systems.native![2]).toBe(systems.text![2]);
    });
  });
});

// ── #298 — an over-long documentId / note no longer rejects the final answer ──

/**
 * #214 measured three of twelve DeepSeek passes lost to ONE over-long field —
 * a citation `documentId` that was a path, or a note over 512 characters — in
 * both tool protocols. Driven here through the real Anthropic-compatible
 * adapter to the #769 retry. Native mode's first turn is the RECORDED DeepSeek
 * tool-calling reply (`tools-chat.json`); every other turn — and all of text
 * mode, for which no recorded DeepSeek text-protocol tool call exists and none
 * can be recorded without a paid call — is synthesised in DeepSeek's wire
 * format. It asserts that the retry prompt in the REQUEST the real adapter
 * sent states the id format and the limits, and that an
 * answer whose only defects are those two fields is accepted (repaired later
 * by the orchestrator), while a genuinely malformed one is still rejected.
 */
describe("#298 over-long findings fields — DeepSeek adapter loopback, both protocols", () => {
  const deepseek = FAMILIES.find((f) => f.recordedRuntime === "deepseek")!;
  const pass = buildAgenticPassPrompt({
    projectName: "loopback",
    projectDescription: "loopback project",
    requirements: [{ id: "REQ-1", text: "Interest rates are configurable." }],
    seeds: {
      fused: { block: "", tokens: 0 },
      affectedCode: { block: "", tokens: 0 },
      affectedSchema: { block: "", tokens: 0 },
    },
    fileToolsAvailable: true,
  });
  const passInput = { ...pass, tools: TOOLS, toolContext: { projectId: "p-298" } };
  const finding = (title: unknown) => ({
    category: "architecture",
    severity: "medium",
    title,
    body: "Rates are read from a constant.",
    tags: [],
    citations: [
      {
        documentId: "src/main/java/com/example/lending/rates/InterestRateCalculator.java",
        chunkIndex: 0,
      },
    ],
  });
  const ANSWER_298 = JSON.stringify({
    summary: "Rates are hard-coded; REQ-1 is a gap.",
    findings: [finding("Interest rate is hard-coded")],
    notes: ["Investigated the rate calculator and its callers. ".repeat(12)],
  });
  const MALFORMED = JSON.stringify({
    summary: "Rates are hard-coded; REQ-1 is a gap.",
    findings: [finding(42)],
    notes: [],
  });
  const LIMIT_LINES = [
    "10-64 characters, or `code-graph:<symbolId>` (at most 320)",
    "at most 20 `notes` of at most 512 characters each",
  ];

  function script(mode: "text" | "native", retryAnswer: string): Scripted[] {
    const w = deepseek.wire;
    return mode === "native"
      ? [
          recorded("deepseek", "tools-chat").reply,
          reply(w, "", [{ id: "call_more", name: "search_code", args: { query: "rate" } }]),
          reply(w, retryAnswer),
        ]
      : [
          reply(w, '{"tool": "search_code", "args": {"query": "interest rate"}}'),
          reply(w, '{"tool": "search_code", "args": {"query": "rate"}}'),
          reply(w, retryAnswer),
        ];
  }

  async function run(mode: "text" | "native", retryAnswer: string): Promise<AgentLoopResult> {
    process.env.ANALYSIS_NATIVE_TOOL_CALLS = mode === "native" ? "true" : "false";
    const provider = deepseek.make(origin);
    queue = script(mode, retryAnswer);
    const native = resolveAnalysisNativeTools(provider, deepseek.model, TOOLS);
    return runAgentLoop(provider, passInput, {
      ...(native ? { native } : {}),
      maxTurns: 2,
      model: deepseek.model,
      promptCaching: { system: true, messages: true },
      finalAnswerRetry: {
        instruction: FINAL_ANSWER_INSTRUCTION,
        isValidFinalAnswer: isSchemaValidFinalAnswer,
      },
    });
  }

  it.each(["text", "native"] as const)(
    "%s: the retry states the limits, and the over-long answer is accepted",
    async (mode) => {
      const result = await run(mode, ANSWER_298);

      expect(result.toolProtocol).toBe(mode === "native" ? "native" : undefined);
      expect(result.turnsExhausted).toBe(true);
      expect(result.finalAnswerRetry).toEqual({ attempted: true, succeeded: true });
      expect(result.hasFinalAnswer).toBe(true);
      expect(result.finalResponse).toBe(ANSWER_298);
      expect(seen).toHaveLength(3);
      const retryTurn = viewRecordedContent(deepseek.wire, seen[2]!.body).turns.at(-1)!;
      expect(retryTurn.role).toBe("user");
      for (const line of LIMIT_LINES) expect(retryTurn.text).toContain(line);
    },
  );

  it.each(["text", "native"] as const)(
    "%s: a genuinely malformed retry answer is still rejected",
    async (mode) => {
      const result = await run(mode, MALFORMED);

      expect(result.finalAnswerRetry).toEqual({ attempted: true, succeeded: false });
      expect(result.hasFinalAnswer).toBe(false);
    },
  );
});
