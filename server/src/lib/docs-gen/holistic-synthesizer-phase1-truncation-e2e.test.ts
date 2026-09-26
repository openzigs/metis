/**
 * #156 end-to-end through synthesizeHolisticDocument — a module whose Phase-1
 * reply is still cut off by the output cap after the retry surfaces as a
 * `facts-truncated` document warning NAMING the module, and is never cached.
 *
 * Same harness as the #330 source-unavailable e2e test: prisma and the provider
 * are mocked; every Phase-1 reply ends with finish_reason "length".
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

let phase1FinishReason = "length";
let phase1Throws = false;

function makeProvider(): AIProvider {
  return {
    key: "bedrock-gateway",
    model: "mock",
    offline: false,
    chat: vi.fn(async () => ({ content: JSON.stringify({ claims: [] }) })),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue(["mock"]),
    ping: vi.fn().mockResolvedValue(true),
    async *stream(messages): AsyncGenerator<ChatChunk> {
      const user = String(messages[messages.length - 1]?.content ?? "");
      if (user.includes("section group now")) {
        yield { type: "delta", content: `## Section\n\nProse.` };
        yield { type: "done" };
        return;
      }
      if (phase1Throws) throw new Error("400 bad request");
      yield { type: "delta", content: "PURPOSE\nmod.\n\nRULES\n- cut off mid-" };
      yield { type: "done", finishReason: phase1FinishReason };
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

const tsFn = (id: string, name: string, filePath: string) => ({
  id,
  codeGraphId: "graph-a",
  qualifiedName: `${filePath}::${name}`,
  kind: "function" as const,
  language: "ts",
  filePath,
  startLine: 1,
  endLine: 40,
});

// A real TS dir with ≥3 function symbols → qualifies as a documentable module.
const SRC = "src/billing";
const file = (n: number) => `${SRC}/file${n}.ts`;

function seedPrisma(): void {
  mockPrisma.project.findUnique.mockResolvedValue({ name: "proj" });
  mockPrisma.codeGraph.findFirst.mockResolvedValue(null);
  mockPrisma.codeGraph.findMany.mockResolvedValue([{ id: "graph-a", repoConnection: null }]);
  mockPrisma.codeEdge.findMany.mockResolvedValue([]);
  mockPrisma.finding.findMany.mockResolvedValue([]);
  // No graph connector → null root → fail closed, never read cwd source.
  mockPrisma.repoConnection.findFirst.mockResolvedValue(null);
  mockPrisma.docsGenFactCache.findUnique.mockResolvedValue(null);
  mockPrisma.docsGenFactCache.upsert.mockResolvedValue({});
  // ≥4 function symbols in one dir → qualifies as a documentable module.
  mockPrisma.codeSymbol.groupBy.mockResolvedValue([
    { filePath: file(1), _count: { _all: 1 } },
    { filePath: file(2), _count: { _all: 1 } },
    { filePath: file(3), _count: { _all: 1 } },
    { filePath: file(4), _count: { _all: 1 } },
  ] as never);
  mockPrisma.codeSymbol.findMany.mockResolvedValue([
    tsFn("s1", "charge", file(1)),
    tsFn("s2", "refund", file(2)),
    tsFn("s3", "invoice", file(3)),
    tsFn("s4", "credit", file(4)),
  ] as never);
}

describe("synthesizeHolisticDocument — #156 truncated Phase-1 facts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.BEDROCK_GATEWAY_URL;
    delete process.env.BEDROCK_GATEWAY_BASE_URL;
    process.env.AI_OFFLINE = "0";
    phase1FinishReason = "length";
    phase1Throws = false;
    seedPrisma();
  });

  afterEach(() => {
    process.env.AI_OFFLINE = "1";
  });

  it("raises a facts-truncated warning naming the module", async () => {
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch");
    const w = result.warnings.find(
      (x) => x.kind === "facts-truncated" && x.section === "Phase 1 facts",
    );
    expect(w).toBeDefined();
    expect(w!.message).toContain("src/billing");
    expect(w!.message).toContain("DOCS_GEN_FACTS_MAX_OUTPUT_TOKENS");
    expect(mockPrisma.docsGenFactCache.upsert).not.toHaveBeenCalled();
  });

  it("raises no Phase-1 truncation warning for complete replies", async () => {
    phase1FinishReason = "stop";
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch");
    expect(result.warnings.some((x) => x.section === "Phase 1 facts")).toBe(false);
  });

  it("names a module whose chunks ALL failed in a document warning", async () => {
    phase1Throws = true;
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch");
    const w = result.warnings.find(
      (x) => x.section === "Phase 1 facts" && x.kind === "section-failed",
    );
    expect(w).toBeDefined();
    expect(w!.message).toContain("src/billing");
    expect(mockPrisma.docsGenFactCache.upsert).not.toHaveBeenCalled();
  });

  it("names a module whose extraction threw (rejected) in a document warning", async () => {
    phase1FinishReason = "stop";
    mockPrisma.finding.findMany.mockRejectedValue(new Error("db exploded"));
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch");
    const w = result.warnings.find(
      (x) => x.section === "Phase 1 facts" && x.kind === "section-failed",
    );
    expect(w).toBeDefined();
    expect(w!.message).toContain("src/billing");
    expect(w!.message).not.toContain("db exploded");
  });
});
