/**
 * Holistic synthesizer — macOS / archive junk-path filter (SAS doc-gen fix).
 *
 * The `risk` SAS project was uploaded as a Finder-created .zip whose `__MACOSX/`
 * AppleDouble resource-fork stubs survived extraction: 91 of 182 ingested
 * "files" were `__MACOSX/.../._*.sas` stubs that parse to empty module symbols.
 * They inflated the file/symbol counts the model sees ("the majority of 182
 * files had empty method bodies") and added noise modules.
 *
 * These tests drive the ONLINE synthesis path (prisma + provider mocked) and
 * assert that junk symbols are dropped in BOTH `loadProjectMeta` (the rendered
 * file/symbol counts) and `loadModules` (the documentable module set + the
 * raw-symbol degraded-warning gate), so EXISTING ingested data produces clean
 * docs without a re-ingest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatChunk } from "../ai/types.js";

// ── prisma mock ─────────────────────────────────────────────────────────
const mockPrisma = {
  project: { findUnique: vi.fn() },
  codeSymbol: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
  codeEdge: { findMany: vi.fn() },
  codeGraph: { findFirst: vi.fn(), findMany: vi.fn() },
  finding: { findMany: vi.fn() },
  repoConnection: { findFirst: vi.fn() },
  docsGenFactCache: { findUnique: vi.fn(), upsert: vi.fn() },
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
    },
  },
}));

// ── provider mock ───────────────────────────────────────────────────────
function makeProvider(): AIProvider {
  return {
    key: "bedrock-gateway",
    model: "mock",
    offline: false,
    chat: vi.fn(async () => ({ content: JSON.stringify({ claims: [] }) })),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue(["mock"]),
    ping: vi.fn().mockResolvedValue(true),
    async *stream(messages, _opts): AsyncGenerator<ChatChunk> {
      const user = String(messages[messages.length - 1]?.content ?? "");
      if (user.includes("section group now")) {
        yield { type: "delta", content: `## Section\n\nSAS prose.` };
        yield { type: "done" };
        return;
      }
      yield { type: "delta", content: "PURPOSE\nmod." };
      yield { type: "done" };
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

const JUNK_FILE = "__MACOSX/RISK_CALC_SAS/src/._load.sas";
const REAL_FILE = "RISK_CALC_SAS/src/load.sas";

const sasFn = (id: string, name: string, filePath: string) => ({
  id,
  codeGraphId: "graph-a",
  qualifiedName: `${filePath}::${name}`,
  kind: "function" as const,
  language: "sas",
  filePath,
  startLine: 1,
  endLine: 40,
});

/** A junk "module" symbol — exactly what an empty `._*.sas` stub ingests as. */
const junkModule = (id: string, filePath: string) => ({
  id,
  codeGraphId: "graph-a",
  qualifiedName: filePath,
  kind: "module" as const,
  language: "sas",
  filePath,
  startLine: 1,
  endLine: 1,
});

function seedMetaPrisma(): void {
  mockPrisma.project.findUnique.mockResolvedValue({ name: "risk" });
  mockPrisma.codeGraph.findFirst.mockResolvedValue(null);
  mockPrisma.codeGraph.findMany.mockResolvedValue([
    { id: "graph-a", repoConnection: { id: "a", projectId: "p1", deletedAt: null } },
  ]);
  mockPrisma.codeEdge.findMany.mockResolvedValue([]);
  mockPrisma.finding.findMany.mockResolvedValue([]);
  mockPrisma.repoConnection.findFirst.mockResolvedValue(null);
  mockPrisma.docsGenFactCache.findUnique.mockResolvedValue(null);
  mockPrisma.docsGenFactCache.upsert.mockResolvedValue({});
}

describe("holistic synthesizer — junk-path filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.BEDROCK_GATEWAY_URL;
    delete process.env.BEDROCK_GATEWAY_BASE_URL;
    process.env.AI_OFFLINE = "0";
    seedMetaPrisma();
  });

  afterEach(() => {
    process.env.AI_OFFLINE = "1";
  });

  it("loadProjectMeta: file + symbol counts EXCLUDE __MACOSX/AppleDouble entries", async () => {
    // 1 real file (3 symbols) + 2 junk files (1 symbol each). groupBy returns
    // per-file counts via _count._all, mirroring the real prisma call.
    mockPrisma.codeSymbol.groupBy.mockResolvedValue([
      { filePath: REAL_FILE, _count: { _all: 3 } },
      { filePath: JUNK_FILE, _count: { _all: 1 } },
      { filePath: "__MACOSX/RISK_CALC_SAS/src/._other.sas", _count: { _all: 1 } },
    ] as never);
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      sasFn("s1", "macroClean", REAL_FILE),
      sasFn("s2", "dataLoad", REAL_FILE),
      sasFn("s3", "procSql", REAL_FILE),
    ] as never);

    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch");
    // Header reads "across N source files (M code symbols)". Junk excluded:
    // 1 real source file, 3 real symbols — NOT 3 files / 5 symbols.
    expect(result.markdown).toContain("across 1 source files");
    expect(result.markdown).toContain("(3 code symbols)");
    expect(result.markdown).not.toContain("across 3 source files");
  });

  it("loadModules: junk symbols never form a documentable module", async () => {
    // Real SAS dir qualifies (≥3 SAS functions); junk stubs must not add modules
    // or pollute the set. Document is non-empty from the REAL dir only.
    mockPrisma.codeSymbol.groupBy.mockResolvedValue([
      { filePath: REAL_FILE, _count: { _all: 3 } },
    ] as never);
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      sasFn("s1", "macroClean", REAL_FILE),
      sasFn("s2", "dataLoad", REAL_FILE),
      sasFn("s3", "procSql", REAL_FILE),
      junkModule("j1", JUNK_FILE),
      junkModule("j2", "__MACOSX/RISK_CALC_SAS/src/._other.sas"),
    ] as never);

    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch");
    expect(result.markdown).not.toContain("No documentable modules");
    expect(result.markdown).toContain("SAS prose.");
  });

  it("a project of ONLY junk symbols is a CLEAN empty doc (no false degraded warning)", async () => {
    // No source-bearing repository: this fixture tests junk filtering, not a missing checkout.
    mockPrisma.codeGraph.findMany.mockResolvedValue([]);
    // Before the fix, junk inflated rawSymbolCount → the "indexed but no
    // modules" degraded warning fired even though there is no real source.
    // After filtering, rawSymbolCount is 0 → clean empty doc, NO warnings.
    mockPrisma.codeSymbol.groupBy.mockResolvedValue([
      { filePath: JUNK_FILE, _count: { _all: 1 } },
      { filePath: "__MACOSX/RISK_CALC_SAS/src/._other.sas", _count: { _all: 1 } },
    ] as never);
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      junkModule("j1", JUNK_FILE),
      junkModule("j2", "__MACOSX/RISK_CALC_SAS/src/._other.sas"),
    ] as never);

    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch");
    expect(result.markdown).toContain("No documentable modules");
    expect(result.warnings).toHaveLength(0);
  });
});
