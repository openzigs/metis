/**
 * Issue #1226 (end-to-end through synthesizeHolisticDocument) — a section that
 * the model was CUT OFF from finishing must not ship as a clean document.
 *
 * Two independent truncation signals are exercised here, because in production
 * only one of them is usually available:
 *
 *   1. The provider's own stop signal (`finish_reason: "length"` /
 *      `stop_reason: "max_tokens"`), forwarded on the terminal `done` chunk.
 *   2. The bedrock-access-gateway's placeholder text — when the gateway hits
 *      the cap it emits "[No response text was returned by the model
 *      (stopReason=max_tokens)...]" as ORDINARY CONTENT, which previously
 *      landed verbatim in `generated_documents.content` while the document was
 *      still marked `ready`.
 *
 * The synthesizer must emit a `section-truncated` warning (severity `error`, so
 * `deriveDocStatus` returns `degraded`) and must strip the placeholder from the
 * markdown it persists.
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

/** Exactly what bedrock-access-gateway emits when it hits the output cap. */
const GATEWAY_PLACEHOLDER =
  "[No response text was returned by the model (stopReason=max_tokens). " +
  "The model's output was silently suppressed.]";

type SectionBehaviour = "clean" | "finish-reason" | "placeholder";

let sectionBehaviour: SectionBehaviour = "clean";
/** Records the `maxTokens` the synthesizer asked each section call for. */
const requestedMaxTokens: number[] = [];

function makeProvider(): AIProvider {
  return {
    key: "bedrock-gateway",
    model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
    offline: false,
    chat: vi.fn(async () => ({ content: JSON.stringify({ claims: [] }) })),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue(["mock"]),
    ping: vi.fn().mockResolvedValue(true),
    async *stream(messages, opts): AsyncGenerator<ChatChunk> {
      const user = String(messages[messages.length - 1]?.content ?? "");
      if (user.includes("section group now")) {
        requestedMaxTokens.push((opts as { maxTokens?: number } | undefined)?.maxTokens ?? -1);
        // Each group leads with its OWN heading, as a real model would — a
        // shared heading would be collapsed by `dedupeH2Sections` and show up
        // as a `section-missing` warning, muddying these assertions.
        const label = /Section group: \*\*(.+?)\*\*/.exec(user)?.[1] ?? "Section";
        if (sectionBehaviour === "placeholder") {
          yield { type: "delta", content: `## ${label}\n\nProse cut off mid-\n\n` };
          yield { type: "delta", content: GATEWAY_PLACEHOLDER };
          // The gateway reports a NORMAL stop alongside the placeholder, which
          // is precisely why the placeholder must be detected on its own.
          yield { type: "done", finishReason: "stop" };
          return;
        }
        if (sectionBehaviour === "finish-reason") {
          yield { type: "delta", content: `## ${label}\n\nProse cut off mid-` };
          yield { type: "done", finishReason: "length" };
          return;
        }
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
import { deriveDocStatus } from "./grounding/degraded-warnings.js";

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

const SRC = "src/billing";
const file = (n: number) => `${SRC}/file${n}.ts`;

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

describe("synthesizeHolisticDocument — #1226 output-cap truncation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestedMaxTokens.length = 0;
    sectionBehaviour = "clean";
    delete process.env.BEDROCK_GATEWAY_URL;
    delete process.env.BEDROCK_GATEWAY_BASE_URL;
    process.env.AI_OFFLINE = "0";
    seedPrisma();
  });

  afterEach(() => {
    process.env.AI_OFFLINE = "1";
  });

  it("asks for far more than the old hardcoded 8192-token section cap", async () => {
    await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    expect(requestedMaxTokens.length).toBeGreaterThan(0);
    for (const cap of requestedMaxTokens) expect(cap).toBeGreaterThan(8192);
  });

  it("emits no truncation or missing-section warning when sections complete", async () => {
    const result = await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    // The fixture's source files don't exist on disk, so the pre-existing #330
    // `source-unavailable` warning is expected; nothing from #1226 should fire.
    expect(
      result.warnings.filter((w) => w.kind === "section-truncated" || w.kind === "section-missing"),
    ).toEqual([]);
  });

  it("degrades the document when the provider reports a length stop", async () => {
    sectionBehaviour = "finish-reason";
    const result = await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    const truncated = result.warnings.filter((w) => w.kind === "section-truncated");
    expect(truncated.length).toBeGreaterThan(0);
    expect(truncated[0].severity).toBe("error");
    expect(deriveDocStatus(result.warnings)).toBe("degraded");
  });

  it("names the tunable so an operator knows how to raise the cap", async () => {
    sectionBehaviour = "finish-reason";
    const result = await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    const truncated = result.warnings.find((w) => w.kind === "section-truncated");
    expect(truncated!.message).toContain("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS");
  });

  it("degrades the document on the gateway placeholder alone (normal stop)", async () => {
    sectionBehaviour = "placeholder";
    const result = await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    const truncated = result.warnings.filter((w) => w.kind === "section-truncated");
    expect(truncated.length).toBeGreaterThan(0);
    expect(deriveDocStatus(result.warnings)).toBe("degraded");
  });

  it("strips the gateway placeholder out of the persisted markdown", async () => {
    sectionBehaviour = "placeholder";
    const result = await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    expect(result.markdown).not.toContain("stopReason=max_tokens");
    expect(result.markdown).not.toContain("No response text was returned by the model");
    // The prose the model DID produce is still kept — a truncated section is
    // degraded, not discarded.
    expect(result.markdown).toContain("Prose cut off mid-");
  });
});
