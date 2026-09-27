/**
 * Docs-gen grounding trust, end to end through the real synthesis loop:
 *
 *  - #246 — a section whose fact-check throws gets a `grounding-failed`
 *    document warning and the document is degraded; a check that drops once
 *    is retried and the section is verified with no warning.
 *  - #180 — claim-extraction and judge calls are recorded like section calls:
 *    on the usage dashboard (`recordUsage`) and in the run's cost estimate
 *    (`noteRunUsage`), once per call.
 *  - #247 — on the Anthropic provider, claim extraction and the judge send
 *    `thinking: {type: "disabled"}` while section synthesis is unchanged;
 *    `DOCS_GEN_ANTHROPIC_GROUNDING_THINKING=1` turns it back on. Asserted on
 *    the wire: the REAL `AnthropicProvider` talks to a loopback HTTP server.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AIProviderError } from "../ai/errors.js";
import { AnthropicProvider } from "../ai/providers/anthropic-provider.js";
import { __resetModelCatalogForTests } from "../ai/model-catalog.js";
import type { AIProvider, ChatChunk, ChatMessage, ChatOptions } from "../ai/types.js";
import type { GroundingContext } from "./grounding/grounding-context.js";
import { deriveDocStatus, summarizeWarnings } from "./grounding/degraded-warnings.js";
import {
  docsGenTuning,
  sectionGroupsFor,
  synthesizeFinalDocument,
  type DocsGenTuning,
  type ModuleFacts,
  type Phase2Router,
} from "./holistic-synthesizer.js";
import { RunUsage, withRunUsage } from "./run-cost.js";

const db = vi.hoisted(() => ({
  project: { findUnique: vi.fn() },
  codeGraph: { findMany: vi.fn() },
  codeSymbol: { findMany: vi.fn(), groupBy: vi.fn() },
  codeEdge: { findMany: vi.fn() },
  finding: { findMany: vi.fn() },
  docsGenFactCache: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
}));
vi.mock("../prisma.js", () => ({ prisma: db }));
const recordUsage = vi.hoisted(() => vi.fn());
vi.mock("../finops/index.js", () => ({ recordUsage }));

const CLAIM = "Source facts.";
const JUDGE_MARKER = "strict faithfulness judge";
const CLAIM_MARKER = "decompose generated documentation";

const meta = { name: "Project", language: "typescript", totalFiles: 1, totalSymbols: 3 };
const facts: ModuleFacts[] = [
  {
    modulePath: "src/orders",
    moduleName: "orders",
    classCount: 1,
    methodCount: 2,
    facts: "Validate orders.",
    formulas: [],
    topClasses: ["Order"],
  },
];
const groups = sectionGroupsFor("architecture");
const context: GroundingContext = {
  sources: [
    {
      sourceId: "rag:reference:1",
      kind: "rag",
      label: "Reference",
      text: CLAIM,
      documentId: "reference",
      chunkId: "1",
      evidenceClass: "project-reference",
    },
  ],
  sourceIds: new Set(["rag:reference:1"]),
  isEmpty: false,
};

function router(provider: AIProvider, tuning: DocsGenTuning): Phase2Router {
  return {
    primary: {
      kind: tuning.supportsCaching ? "anthropic" : "local",
      provider,
      tuning,
      factsCharCap: tuning.factsCharCap,
      supportsCaching: tuning.supportsCaching,
    },
    hybrid: null,
  };
}

const synth = (r: Phase2Router, reuse?: { effectiveConfigHash: string }) =>
  synthesizeFinalDocument(
    facts,
    meta,
    "architecture",
    "Architecture",
    r,
    "p",
    undefined,
    undefined,
    async () => context,
    undefined,
    reuse,
  );

beforeEach(() => {
  recordUsage.mockReset();
  vi.stubEnv("DOCS_GEN_JUDGE_ESCALATION", "0");
  vi.stubEnv("DOCS_GEN_HYBRID_ROUTING", "0");
  vi.stubEnv("DOCS_GEN_LOCAL_REFINE", "0");
  vi.stubEnv("DOCS_GEN_GROUNDING", "on");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ── #246 — scripted provider ──────────────────────────────────────────────

/** A local-kind provider whose judge call behaves as `judge` says. */
function scripted(judge: (callIndex: number) => Promise<unknown>) {
  let judgeCalls = 0;
  const chat = vi.fn(async (messages: ChatMessage[], _opts: ChatOptions = {}) => {
    if (String(messages[0].content).includes(JUDGE_MARKER)) {
      await judge(judgeCalls++);
      return {
        content: JSON.stringify({ verdicts: [{ claim: CLAIM, supported: true, sourceIds: [] }] }),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      };
    }
    return {
      content: JSON.stringify({ claims: [{ claim: CLAIM, sourceIds: [] }] }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    };
  });
  const provider = {
    key: "local-gemma",
    model: "gemma3:12b",
    offline: false,
    chat,
    async *stream(msgs: Array<{ content: unknown }>): AsyncGenerator<ChatChunk> {
      const prompt = String(msgs.at(-1)?.content);
      const label = /Section group: \*\*(.+?)\*\*/.exec(prompt)?.[1] ?? "Section";
      yield { type: "delta", content: `## ${label}\n\n${CLAIM}` };
      yield { type: "done", finishReason: "stop" };
    },
  } as unknown as AIProvider;
  return { provider, judgeCalls: () => judgeCalls };
}

describe("#246 — a section whose fact-check fails is never published as verified", () => {
  it("a judge that throws a non-transient error → grounding-failed warning, degraded", async () => {
    const { provider, judgeCalls } = scripted(async () => {
      throw new AIProviderError("anthropic chat failed (BadRequestError): invalid model", 400);
    });
    const result = await synth(router(provider, docsGenTuning("local", "gemma3:12b")));
    const failed = result.warnings.filter((w) => w.kind === "grounding-failed");
    // Before #246: no warning at all — the document read as a clean `ready`.
    expect(failed.map((w) => w.section).sort()).toEqual(groups.map((g) => g.label).sort());
    expect(failed[0].message).toContain("NOT fact-checked");
    expect(failed[0].message).toContain("HTTP 4xx");
    expect(failed[0].message).not.toContain("invalid model");
    expect(deriveDocStatus(result.warnings)).toBe("degraded");
    expect(summarizeWarnings(result.warnings)).toContain(
      `${groups.length} section(s) could not be fact-checked because the grounding check failed`,
    );
    // A 4xx is not retried: one judge call per section.
    expect(judgeCalls()).toBe(groups.length);
  });

  it("counts unverified sections apart from spot-checked ones in the summary", async () => {
    vi.stubEnv("DOCS_GEN_GROUNDING", "sample");
    const { provider } = scripted(async (i) => {
      if (i === 0) throw new AIProviderError("forbidden", 403);
    });
    const result = await synth(router(provider, docsGenTuning("local", "gemma3:12b")));
    const summary = summarizeWarnings(result.warnings);
    expect(summary).toContain("1 section(s) could not be fact-checked");
    expect(result.warnings.filter((w) => w.kind === "grounding-failed")).toHaveLength(1);
  });

  it("a section whose check failed is not recorded for reuse, so regenerating re-checks it", async () => {
    const failing = scripted(async () => {
      throw new AIProviderError("bad request", 400);
    });
    const failed = await synth(router(failing.provider, docsGenTuning("local", "gemma3:12b")), {
      effectiveConfigHash: "h",
    });
    expect(failed.sectionSynthesis).toBeUndefined();
    const passing = scripted(async () => {});
    const ok = await synth(router(passing.provider, docsGenTuning("local", "gemma3:12b")), {
      effectiveConfigHash: "h",
    });
    expect(ok.sectionSynthesis?.records).toHaveLength(groups.length);
  });

  it("a judge stream dropped once is retried → section verified, no warning", async () => {
    const { provider, judgeCalls } = scripted(async (i) => {
      if (i === 0) throw new AIProviderError("anthropic chat failed (TypeError): terminated", 502);
    });
    const result = await synth(router(provider, docsGenTuning("local", "gemma3:12b")));
    expect(result.warnings).toEqual([]);
    expect(deriveDocStatus(result.warnings)).toBe("ready");
    expect(judgeCalls()).toBe(groups.length + 1);
  });
});

// ── #247 / #180 — the real Anthropic provider on a loopback server ────────

type Body = Record<string, unknown>;
const systemText = (b: Body): string =>
  typeof b.system === "string"
    ? b.system
    : Array.isArray(b.system)
      ? (b.system as Array<{ text?: string }>).map((s) => s.text ?? "").join("\n")
      : "";
const kindOf = (b: Body): "claims" | "verdicts" | "section" => {
  const sys = systemText(b);
  if (sys.includes(JUDGE_MARKER)) return "verdicts";
  if (sys.includes(CLAIM_MARKER)) return "claims";
  return "section";
};

describe("#247 / #180 — grounding calls on the real Anthropic provider", () => {
  let server: Server;
  let base = "";
  const bodies: Body[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        const body = (raw ? JSON.parse(raw) : {}) as Body;
        bodies.push(body);
        const kind = kindOf(body);
        const usage = { input_tokens: 40, output_tokens: 9, cache_read_input_tokens: 5 };
        if (body.stream) {
          const firstUser = (body.messages as Array<{ content: unknown }>)[0]?.content;
          const prompt = typeof firstUser === "string" ? firstUser : JSON.stringify(firstUser);
          const label = /Section group: \*\*(.+?)\*\*/.exec(prompt)?.[1] ?? "Section";
          const events: Array<[string, unknown]> = [
            [
              "message_start",
              {
                type: "message_start",
                message: {
                  id: "msg_1",
                  type: "message",
                  role: "assistant",
                  model: body.model,
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 40, output_tokens: 0 },
                },
              },
            ],
            [
              "content_block_start",
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            ],
            [
              "content_block_delta",
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: `## ${label}\n\n${CLAIM}` },
              },
            ],
            ["content_block_stop", { type: "content_block_stop", index: 0 }],
            [
              "message_delta",
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 9 },
              },
            ],
            ["message_stop", { type: "message_stop" }],
          ];
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""));
          return;
        }
        const text =
          kind === "verdicts"
            ? JSON.stringify({ verdicts: [{ claim: CLAIM, supported: true, sourceIds: [] }] })
            : JSON.stringify({ claims: [{ claim: CLAIM, sourceIds: [] }] });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage,
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    bodies.length = 0;
    __resetModelCatalogForTests();
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-4-6");
  });

  const anthropicRouter = () =>
    router(
      new AnthropicProvider({ apiKey: "k", baseUrl: base, model: "claude-sonnet-4-6" }),
      docsGenTuning("anthropic", "claude-sonnet-4-6"),
    );

  it("claim extraction and the judge send thinking disabled; sections do not", async () => {
    const result = await synth(anthropicRouter());
    expect(result.warnings).toEqual([]);
    const claims = bodies.filter((b) => kindOf(b) === "claims");
    const verdicts = bodies.filter((b) => kindOf(b) === "verdicts");
    const sections = bodies.filter((b) => kindOf(b) === "section");
    // Every section group, over several turns of one provider instance.
    expect(claims).toHaveLength(groups.length);
    expect(verdicts).toHaveLength(groups.length);
    expect(sections.length).toBeGreaterThanOrEqual(groups.length);
    for (const b of [...claims, ...verdicts]) {
      expect(b.thinking).toEqual({ type: "disabled" });
      expect(b).not.toHaveProperty("output_config");
    }
    // Section synthesis is unchanged: no thinking field at all.
    for (const b of sections) expect(b).not.toHaveProperty("thinking");
  });

  it("DOCS_GEN_ANTHROPIC_GROUNDING_THINKING=1 keeps the model's default thinking", async () => {
    vi.stubEnv("DOCS_GEN_ANTHROPIC_GROUNDING_THINKING", "1");
    await synth(anthropicRouter());
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(b).not.toHaveProperty("thinking");
  });

  it("records every grounding call once — dashboard and run estimate (#180)", async () => {
    const usage = new RunUsage();
    await withRunUsage(usage, () => synth(anthropicRouter()));
    // One usage row per request the server answered: none missing, none twice.
    expect(recordUsage).toHaveBeenCalledTimes(bodies.length);
    const grounding = recordUsage.mock.calls
      .map(([row]) => row)
      .filter((row) => String(row.sessionId).startsWith("docs-grounding-"));
    expect(grounding).toHaveLength(groups.length * 2);
    // Billed to the model that answered (the claim model is Haiku by default).
    expect(new Set(grounding.map((r) => r.model))).toEqual(
      new Set(["claude-haiku-4-5", "claude-sonnet-4-6"]),
    );
    expect(grounding[0]).toMatchObject({
      projectId: "p",
      provider: "anthropic",
      inputTokens: 40,
      outputTokens: 9,
      cacheReadTokens: 5,
    });
    const lines = usage.lines();
    const calls = lines.reduce((n, l) => n + l.calls, 0);
    expect(calls).toBe(bodies.length);
    const haiku = lines.find((l) => l.model === "claude-haiku-4-5")!;
    expect(haiku).toMatchObject({ calls: groups.length, cacheReadTokens: 5 * groups.length });
  });

  it("leaves the local provider's grounding requests without a per-call thinking flag", () => {
    // Local thinking-off rides the provider's constructor flag (#183/#187),
    // and Bedrock is untouched: neither tuning asks the grounders for it.
    expect(docsGenTuning("local", "gemma3:12b").groundingDisableThinking).toBeUndefined();
    expect(docsGenTuning("bedrock", "x").groundingDisableThinking).toBeUndefined();
    expect(docsGenTuning("local", "gemma3:12b").disableThinking).toBe(true);
  });
});
