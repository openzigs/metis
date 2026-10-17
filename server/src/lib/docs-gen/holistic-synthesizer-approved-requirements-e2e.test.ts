/**
 * Issue #1218 (end-to-end through synthesizeHolisticDocument) — a reader-layout
 * BRD reads the project's approved requirements, within the project, and lists
 * them; the catalogue layout and other document types never read them.
 *
 * Prisma and the provider are mocked; no DB, no network, no live model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatChunk, ChatMessage } from "../ai/types.js";

const mockPrisma = {
  project: { findUnique: vi.fn() },
  codeSymbol: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
  codeEdge: { findMany: vi.fn() },
  codeGraph: { findFirst: vi.fn(), findMany: vi.fn() },
  finding: { findMany: vi.fn() },
  repoConnection: { findFirst: vi.fn() },
  docsGenFactCache: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  requirement: { findMany: vi.fn() },
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
    requirement: { findMany: (...a: unknown[]) => mockPrisma.requirement.findMany(...a) },
  },
}));

const sectionGroups: string[] = [];

function makeProvider(): AIProvider {
  return {
    key: "bedrock-gateway",
    model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
    offline: false,
    chat: vi.fn(async () => ({ content: JSON.stringify({ claims: [] }) })),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue(["mock"]),
    ping: vi.fn().mockResolvedValue(true),
    async *stream(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const user = String(messages[messages.length - 1]?.content ?? "");
      if (user.includes("section group now")) {
        const label = /Section group: \*\*(.+?)\*\*/.exec(user)?.[1] ?? "Section";
        sectionGroups.push(label);
        yield { type: "delta", content: `## ${label}\n\nComplete prose.` };
        yield { type: "done", finishReason: "stop" };
        return;
      }
      yield { type: "delta", content: "PURPOSE\nmod." };
      yield { type: "done", finishReason: "stop" };
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
import { APPROVED_REQUIREMENTS_HEADING } from "./approved-requirements-section.js";

const file = (n: number) => `src/billing/file${n}.ts`;
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

const APPROVED = {
  id: "req-approved",
  title: "Refunds need a manager's approval",
  body: "A refund over 500 needs a manager's approval.",
  type: "feature",
  priority: "high",
  reviewStatus: "approved",
  verdict: null,
  acceptanceCriteria: JSON.stringify(["A 501 refund waits for a manager."]),
  version: 3,
  updatedAt: new Date("2026-10-01T00:00:00Z"),
  codeMappings: [],
  implementations: [],
};

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
  mockPrisma.codeSymbol.groupBy.mockResolvedValue([
    { filePath: file(1), _count: { _all: 1 } },
    { filePath: file(2), _count: { _all: 1 } },
  ] as never);
  mockPrisma.codeSymbol.findMany.mockResolvedValue([
    tsFn("s1", "charge", file(1)),
    tsFn("s2", "refund", file(2)),
  ] as never);
  mockPrisma.requirement.findMany.mockResolvedValue([APPROVED]);
}

describe("synthesizeHolisticDocument — #1218 approved requirements in a reader-layout BRD", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sectionGroups.length = 0;
    delete process.env.BEDROCK_GATEWAY_URL;
    delete process.env.BEDROCK_GATEWAY_BASE_URL;
    process.env.AI_OFFLINE = "0";
    seedPrisma();
  });

  afterEach(() => {
    process.env.AI_OFFLINE = "1";
    vi.unstubAllEnvs();
  });

  it("reads this project's approved requirements and lists them, with no model call for them", async () => {
    vi.stubEnv("DOCS_GEN_BRD_LAYOUT", "reader");
    const result = await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    expect(mockPrisma.requirement.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.requirement.findMany.mock.calls[0][0].where).toEqual({
      projectId: "p1",
      deletedAt: null,
      reviewStatus: "approved",
    });
    expect(result.markdown).toContain(`## ${APPROVED_REQUIREMENTS_HEADING}`);
    expect(result.markdown).toContain("### R1. Refunds need a manager's approval");
    expect(result.markdown).toContain("- A 501 refund waits for a manager.");
    expect(sectionGroups).not.toContain(APPROVED_REQUIREMENTS_HEADING);
    expect(sectionGroups).not.toContain("Requirements Reconstructed from the Code");
  });

  it("falls back to reconstructed requirements when the project has none approved", async () => {
    vi.stubEnv("DOCS_GEN_BRD_LAYOUT", "reader");
    mockPrisma.requirement.findMany.mockResolvedValue([]);
    const result = await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    expect(sectionGroups).toContain("Requirements Reconstructed from the Code");
    expect(result.markdown).toContain("Reconstructed from the code.");
    expect(result.markdown).not.toContain(`## ${APPROVED_REQUIREMENTS_HEADING}`);
  });

  it("never reads requirements for the catalogue layout or another document type", async () => {
    await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    vi.stubEnv("DOCS_GEN_BRD_LAYOUT", "reader");
    await synthesizeHolisticDocument("p1", "architecture", "Architecture");
    expect(mockPrisma.requirement.findMany).not.toHaveBeenCalled();
  });
});
