/**
 * #25 (end-to-end through synthesizeHolisticDocument) — documentation
 * generation on a THINKING-BY-DEFAULT model.
 *
 * On `deepseek-v4-pro` three section groups truncated at 8,192 output tokens
 * (the unknown-model default, with the model's reasoning drawn from the same
 * budget), and Phase 1 walked 174 modules in fixed batches. This drives the
 * real synthesizer with a mocked provider and asserts what it ASKS the provider
 * for — the section cap, and how many Phase-1 extractions it keeps in flight.
 *
 * Prisma and the provider are mocked; no DB, no network, no live model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatChunk } from "../ai/types.js";

const mockPrisma = {
  project: { findUnique: vi.fn() },
  codeSymbol: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
  codeEdge: { findMany: vi.fn() },
  codeGraph: { findFirst: vi.fn(), findMany: vi.fn() },
  finding: { findMany: vi.fn() },
  repoConnection: { findFirst: vi.fn() },
  docsGenFactCache: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
};

vi.mock("../prisma.js", () => ({
  prisma: {
    project: { findUnique: (...a: unknown[]) => mockPrisma.project.findUnique(...a) },
    codeSymbol: {
      count: (...a: unknown[]) => mockPrisma.codeSymbol.count(...a),
      groupBy: (...a: unknown[]) => mockPrisma.codeSymbol.groupBy(...a),
      findMany: (...a: unknown[]) => mockPrisma.codeSymbol.findMany(...a),
    },
    codeEdge: { findMany: (...a: unknown[]) => mockPrisma.codeEdge.findMany(...a) },
    codeGraph: {
      findFirst: (...a: unknown[]) => mockPrisma.codeGraph.findFirst(...a),
      findMany: (...a: unknown[]) => mockPrisma.codeGraph.findMany(...a),
    },
    finding: { findMany: (...a: unknown[]) => mockPrisma.finding.findMany(...a) },
    repoConnection: { findFirst: (...a: unknown[]) => mockPrisma.repoConnection.findFirst(...a) },
    docsGenFactCache: {
      findUnique: (...a: unknown[]) => mockPrisma.docsGenFactCache.findUnique(...a),
      upsert: (...a: unknown[]) => mockPrisma.docsGenFactCache.upsert(...a),
      update: (...a: unknown[]) => mockPrisma.docsGenFactCache.update(...a),
    },
  },
}));

const DEEPSEEK = "deepseek-v4-pro";
/** The model the mocked provider reports (#25 follow-up switches it). */
let providerModel = DEEPSEEK;
/** Records the `maxTokens` the synthesizer asked each section call for. */
const sectionMaxTokens: number[] = [];
/** #25 follow-up — the reasoning options each call was sent. */
type ReasoningSeen = { reasoningEffort?: string; disableThinking?: boolean };
const phase1Reasoning: ReasoningSeen[] = [];
const sectionReasoning: ReasoningSeen[] = [];
function reasoningOf(opts: unknown): ReasoningSeen {
  const o = (opts ?? {}) as ReasoningSeen;
  return {
    ...(o.reasoningEffort !== undefined ? { reasoningEffort: o.reasoningEffort } : {}),
    ...(o.disableThinking !== undefined ? { disableThinking: o.disableThinking } : {}),
  };
}
/** Phase-1 bookkeeping. */
let phase1InFlight = 0;
let phase1Peak = 0;
let phase1Started = 0;
/** Released once every OTHER module's Phase-1 call has started (or on timeout). */
let releaseFirst: (() => void) | null = null;
let startedWhileFirstPending = 0;
let firstPending = false;

function makeProvider(): AIProvider {
  return {
    key: "bedrock-gateway",
    get model() {
      return providerModel;
    },
    offline: false,
    chat: vi.fn(async () => ({ content: JSON.stringify({ claims: [] }) })),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue(["mock"]),
    ping: vi.fn().mockResolvedValue(true),
    async *stream(messages, opts): AsyncGenerator<ChatChunk> {
      const user = String(messages[messages.length - 1]?.content ?? "");
      if (user.includes("section group now")) {
        sectionMaxTokens.push((opts as { maxTokens?: number } | undefined)?.maxTokens ?? -1);
        sectionReasoning.push(reasoningOf(opts));
        const label = /Section group: \*\*(.+?)\*\*/.exec(user)?.[1] ?? "Section";
        yield { type: "delta", content: `## ${label}\n\nComplete prose.` };
        yield { type: "done", finishReason: "stop" };
        return;
      }
      // Phase 1 fact extraction.
      phase1Reasoning.push(reasoningOf(opts));
      const me = phase1Started++;
      if (firstPending) startedWhileFirstPending += 1;
      phase1InFlight += 1;
      phase1Peak = Math.max(phase1Peak, phase1InFlight);
      try {
        if (me === 0) {
          // Hold the FIRST module open: a pool keeps the other slots busy with
          // the remaining modules; a fixed batch would wait on this one.
          firstPending = true;
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
            setTimeout(resolve, 1_500);
          });
          firstPending = false;
        } else {
          await new Promise<void>((r) => setImmediate(r));
          if (phase1Started >= MODULES && releaseFirst) releaseFirst();
        }
        yield { type: "delta", content: "PURPOSE\nmod." };
        yield { type: "done", finishReason: "stop" };
      } finally {
        phase1InFlight -= 1;
      }
    },
  } as unknown as AIProvider;
}

vi.mock("../ai/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai/index.js")>();
  return {
    ...actual,
    buildProvider: () => makeProvider(),
    loadAIConfig: () => ({ provider: "bedrock-gateway", model: "mock" }),
  };
});

import { synthesizeHolisticDocument } from "./holistic-synthesizer.js";
import {
  DEFAULT_REASONING_ALLOWANCE_TOKENS,
  DEFAULT_SECTION_MAX_OUTPUT_TOKENS,
} from "./output-caps.js";

const MODULES = 6;
/** Files per module directory — a module needs a few symbols to qualify. */
const FILES_PER_MODULE = 4;
const files = Array.from({ length: MODULES * FILES_PER_MODULE }, (_, i) => ({
  path: `src/mod${Math.floor(i / FILES_PER_MODULE)}/file${i % FILES_PER_MODULE}.ts`,
  i,
}));

function seedPrisma(): void {
  mockPrisma.project.findUnique.mockResolvedValue({ name: "proj" });
  mockPrisma.codeGraph.findFirst.mockResolvedValue(null);
  mockPrisma.codeGraph.findMany.mockResolvedValue([
    { id: "graph-a", repoConnection: { id: "a", projectId: "p1", deletedAt: null } },
  ]);
  mockPrisma.codeEdge.findMany.mockResolvedValue([]);
  mockPrisma.finding.findMany.mockResolvedValue([]);
  mockPrisma.repoConnection.findFirst.mockResolvedValue(null);
  mockPrisma.docsGenFactCache.findUnique.mockResolvedValue(null);
  mockPrisma.docsGenFactCache.upsert.mockResolvedValue({});
  mockPrisma.codeSymbol.groupBy.mockResolvedValue(
    files.map((f) => ({ filePath: f.path, _count: { _all: 1 } })) as never,
  );
  mockPrisma.codeSymbol.findMany.mockResolvedValue(
    files.map((f) => ({
      id: `s${f.i}`,
      codeGraphId: "graph-a",
      qualifiedName: `${f.path}::fn${f.i}`,
      kind: "function" as const,
      language: "ts",
      filePath: f.path,
      startLine: 1,
      endLine: 40,
    })) as never,
  );
}

describe("synthesizeHolisticDocument — #25 thinking-by-default model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sectionMaxTokens.length = 0;
    phase1Reasoning.length = 0;
    sectionReasoning.length = 0;
    providerModel = DEEPSEEK;
    phase1InFlight = 0;
    phase1Peak = 0;
    phase1Started = 0;
    startedWhileFirstPending = 0;
    firstPending = false;
    releaseFirst = null;
    delete process.env.BEDROCK_GATEWAY_URL;
    delete process.env.BEDROCK_GATEWAY_BASE_URL;
    process.env.AI_OFFLINE = "0";
    seedPrisma();
  });

  afterEach(() => {
    process.env.AI_OFFLINE = "1";
    vi.unstubAllEnvs();
  });

  it("asks for the answer budget PLUS reasoning headroom, not the 8,192 cap #25 hit", async () => {
    await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    expect(sectionMaxTokens.length).toBeGreaterThan(0);
    for (const cap of sectionMaxTokens) {
      expect(cap).toBe(DEFAULT_SECTION_MAX_OUTPUT_TOKENS + DEFAULT_REASONING_ALLOWANCE_TOKENS);
    }
  });

  it("keeps DOCS_GEN_PHASE1_CONCURRENCY Phase-1 extractions in flight as a pool", async () => {
    vi.stubEnv("DOCS_GEN_PHASE1_CONCURRENCY", "2");
    await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    expect(phase1Started).toBe(MODULES);
    expect(phase1Peak).toBe(2);
    // While module 0 was held open, EVERY other module ran through the second
    // slot. Fixed batches of 2 would have started only module 1.
    expect(startedWhileFirstPending).toBe(MODULES - 1);
  });

  it("runs up to the configured limit at once", async () => {
    vi.stubEnv("DOCS_GEN_PHASE1_CONCURRENCY", "6");
    await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    expect(phase1Peak).toBe(MODULES);
  });

  it("bounds Phase-1 reasoning to low effort on a thinking-by-default model", async () => {
    await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    expect(phase1Reasoning).toHaveLength(MODULES);
    for (const seen of phase1Reasoning) expect(seen).toEqual({ reasoningEffort: "low" });
    // Only Phase 1 is bounded — section synthesis keeps the provider default.
    expect(sectionReasoning.length).toBeGreaterThan(0);
    for (const seen of sectionReasoning) expect(seen).toEqual({});
  });

  it("sends Phase 1 no reasoning options for a Claude model", async () => {
    providerModel = "claude-sonnet-4-6";
    await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    expect(phase1Reasoning).toHaveLength(MODULES);
    for (const seen of phase1Reasoning) expect(seen).toEqual({});
  });

  it("DOCS_GEN_PHASE1_REASONING=off disables Phase-1 thinking", async () => {
    vi.stubEnv("DOCS_GEN_PHASE1_REASONING", "off");
    await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    for (const seen of phase1Reasoning) expect(seen).toEqual({ disableThinking: true });
  });

  it("keys the Phase-1 fact cache on the reasoning setting", async () => {
    const keys = async (): Promise<string[]> => {
      mockPrisma.docsGenFactCache.findUnique.mockClear();
      await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
      return mockPrisma.docsGenFactCache.findUnique.mock.calls
        .map((c) => (c[0] as { where: { projectId_cacheKey: { cacheKey: string } } }).where)
        .map((w) => w.projectId_cacheKey.cacheKey)
        .sort();
    };
    // Class-only modules expect no readable source, so the cache is consulted
    // (a module whose source is unavailable skips the cache, #330).
    mockPrisma.codeSymbol.findMany.mockResolvedValue(
      files.map((f) => ({
        id: `s${f.i}`,
        codeGraphId: "graph-a",
        qualifiedName: `${f.path}::Cls${f.i}`,
        kind: "class" as const,
        language: "ts",
        filePath: f.path,
        startLine: 1,
        endLine: 40,
      })) as never,
    );
    const auto = await keys();
    vi.stubEnv("DOCS_GEN_PHASE1_REASONING", "off");
    const off = await keys();
    expect(auto).toHaveLength(MODULES);
    // Facts extracted with thinking off are never served for a low-effort run.
    expect(off.filter((k) => auto.includes(k))).toEqual([]);
  });
});
