/**
 * Holistic synthesizer — path scope.
 *
 * Drives the ONLINE synthesis path (prisma + provider mocked, as in the
 * junk-filter test) with `pathPrefixes` and asserts that out-of-scope modules
 * reach neither Phase 1 nor any Phase-2 section prompt, that the document and
 * its provenance record the scope, and that a scope matching nothing fails
 * instead of producing an empty document.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatChunk, ChatMessage } from "../ai/types.js";

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

/** When set, graph-a is backed by this checkout (source readable, SQL scan runs). */
let repoRoot: string | null = null;
vi.mock("./repository-sources.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./repository-sources.js")>();
  return {
    ...actual,
    loadRepositorySources: async () =>
      new Map(
        repoRoot
          ? [
              [
                "graph-a",
                {
                  codeGraphId: "graph-a",
                  repoConnectorId: "repo-a",
                  root: repoRoot,
                  commitSha: null,
                },
              ],
            ]
          : [],
      ),
  };
});

/** Every user message streamed to the model, in order. */
const streamed: string[] = [];

function makeProvider(): AIProvider {
  return {
    key: "bedrock-gateway",
    model: "mock",
    offline: false,
    chat: vi.fn(async () => ({ content: JSON.stringify({ claims: [] }) })),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue(["mock"]),
    ping: vi.fn().mockResolvedValue(true),
    async *stream(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const user = String(messages[messages.length - 1]?.content ?? "");
      streamed.push(user);
      if (user.includes("section group now")) {
        yield { type: "delta", content: `## Section\n\nProse.` };
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
import { parseGeneratedDocVersionManifest } from "./generated-doc-provenance.js";
import { PathScopeEmptyError } from "./path-scope.js";

const IN_DIR = "packages/fit/src";
const OUT_DIR = "apps/web/src/renderer";
// Module names are shortened in prompts (`graph-a / web/src/renderer`), so
// match on the tail of each directory.
const IN_MARK = "fit/src";
const OUT_MARK = "src/renderer";

const fn = (id: string, name: string, filePath: string) => ({
  id,
  codeGraphId: "graph-a",
  qualifiedName: `${filePath}::${name}`,
  kind: "function" as const,
  language: "typescript",
  filePath,
  startLine: 1,
  endLine: 10,
  contentHash: `h-${id}`,
});

const symbols = [
  fn("i1", "encodeFitRecord", `${IN_DIR}/encode.ts`),
  fn("i2", "decodeFitRecord", `${IN_DIR}/encode.ts`),
  fn("i3", "crcFitHeader", `${IN_DIR}/crc.ts`),
  fn("i4", "validateFitFile", `${IN_DIR}/crc.ts`),
  fn("o1", "drawTerrainMesh", `${OUT_DIR}/mesh.ts`),
  fn("o2", "drawSkyboxLayer", `${OUT_DIR}/mesh.ts`),
  fn("o3", "animateRiderSprite", `${OUT_DIR}/sprite.ts`),
  fn("o4", "renderHudOverlay", `${OUT_DIR}/sprite.ts`),
];

describe("holistic synthesizer — path scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamed.length = 0;
    delete process.env.BEDROCK_GATEWAY_URL;
    delete process.env.BEDROCK_GATEWAY_BASE_URL;
    process.env.AI_OFFLINE = "0";
    mockPrisma.project.findUnique.mockResolvedValue({ name: "onyourleft" });
    mockPrisma.codeGraph.findFirst.mockResolvedValue(null);
    mockPrisma.codeGraph.findMany.mockResolvedValue([]);
    mockPrisma.codeEdge.findMany.mockResolvedValue([]);
    mockPrisma.finding.findMany.mockResolvedValue([]);
    mockPrisma.repoConnection.findFirst.mockResolvedValue(null);
    mockPrisma.docsGenFactCache.findUnique.mockResolvedValue(null);
    mockPrisma.docsGenFactCache.upsert.mockResolvedValue({});
    mockPrisma.codeSymbol.groupBy.mockResolvedValue([
      { filePath: `${IN_DIR}/encode.ts`, _count: { _all: 2 } },
      { filePath: `${IN_DIR}/crc.ts`, _count: { _all: 2 } },
      { filePath: `${OUT_DIR}/mesh.ts`, _count: { _all: 2 } },
      { filePath: `${OUT_DIR}/sprite.ts`, _count: { _all: 2 } },
    ] as never);
    mockPrisma.codeSymbol.findMany.mockResolvedValue(symbols as never);
  });

  afterEach(async () => {
    process.env.AI_OFFLINE = "1";
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
    repoRoot = null;
  });

  it("control: unscoped, both modules reach the model", async () => {
    await synthesizeHolisticDocument("p1", "business-requirements", "BR");
    const all = streamed.join("\n");
    expect(all).toContain(IN_MARK);
    expect(all).toContain(OUT_MARK);
  });

  it("only in-scope modules reach Phase 1 and every Phase-2 section", async () => {
    const result = await synthesizeHolisticDocument("p1", "business-requirements", "BR", {
      pathPrefixes: ["packages/fit"],
    });
    const phase2 = streamed.filter((u) => u.includes("section group now"));
    const phase1 = streamed.filter((u) => !u.includes("section group now"));
    expect(phase1.length).toBeGreaterThan(0);
    expect(phase2.length).toBeGreaterThan(0);
    for (const u of streamed) {
      expect(u).not.toContain(OUT_MARK);
      expect(u).not.toContain("drawTerrainMesh");
    }
    expect(phase1.some((u) => u.includes(IN_MARK))).toBe(true);
    expect(phase2.some((u) => u.includes(IN_MARK))).toBe(true);
    // The header counts the scoped files and symbols, not the whole project.
    expect(result.markdown).toContain("across 2 source files (4 code symbols)");
  });

  it("records the scope in the banner and the provenance manifest", async () => {
    const result = await synthesizeHolisticDocument("p1", "business-requirements", "BR", {
      pathPrefixes: ["packages/fit"],
    });
    expect(result.markdown).toMatch(/^# BR\n\n> \*\*Scoped document — not a full-project document/);
    expect(result.markdown).toContain("`packages/fit/`");
    const manifest = parseGeneratedDocVersionManifest(result.provenanceManifest!);
    expect(manifest.document.pathPrefixes).toEqual(["packages/fit"]);
  });

  it("an unscoped manifest carries no pathPrefixes", async () => {
    const result = await synthesizeHolisticDocument("p1", "business-requirements", "BR");
    expect(result.markdown).not.toContain("Scoped document");
    const manifest = parseGeneratedDocVersionManifest(result.provenanceManifest!);
    expect(manifest.document.pathPrefixes).toBeUndefined();
  });

  it("a scope matching nothing throws before any model call", async () => {
    await expect(
      synthesizeHolisticDocument("p1", "business-requirements", "BR", {
        pathPrefixes: ["packages/nope"],
      }),
    ).rejects.toBeInstanceOf(PathScopeEmptyError);
    expect(streamed).toHaveLength(0);
  });

  // DOCS_GEN_GROUNDING rides the same provenance manifest as the path scope.
  it("records DOCS_GEN_GROUNDING in the provenance manifest only when it is not `on`", async () => {
    const grounding = async (mode?: string) => {
      vi.stubEnv("DOCS_GEN_GROUNDING", mode ?? "");
      vi.stubEnv("DOCS_GEN_GROUNDING_SAMPLE_RATE", mode === "sample" ? "0.4" : "");
      try {
        const result = await synthesizeHolisticDocument("p1", "business-requirements", "BR");
        return parseGeneratedDocVersionManifest(result.provenanceManifest!).generation.grounding;
      } finally {
        vi.unstubAllEnvs();
      }
    };
    expect(await grounding()).toBeUndefined();
    expect(await grounding("on")).toBeUndefined();
    expect(await grounding("off")).toEqual({ mode: "off" });
    expect(await grounding("sample")).toEqual({ mode: "sample", sampleRate: 0.4, minClaims: 10 });
  });

  it("an SQL-only directory outside the scope is not mined; one inside it is", async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "path-scope-"));
    const put = async (rel: string, text: string) => {
      await mkdir(path.dirname(path.join(repoRoot!, rel)), { recursive: true });
      await writeFile(path.join(repoRoot!, rel), text);
    };
    for (const s of symbols) await put(s.filePath, "export function x() {\n  return 1;\n}\n");
    const table = (name: string) =>
      `CREATE TABLE ${name} (id INT PRIMARY KEY, total INT CHECK (total > 0));\n`;
    await put("db/outside_schema/schema.sql", table("outside_orders"));
    await put("packages/fit/sql/schema.sql", table("inside_laps"));

    // Control: unscoped, the SQL-only directory outside the scope is mined.
    await synthesizeHolisticDocument("p1", "business-requirements", "BR");
    expect(streamed.join("\n")).toContain("outside_schema");

    streamed.length = 0;
    await synthesizeHolisticDocument("p1", "business-requirements", "BR", {
      pathPrefixes: ["packages/fit"],
    });
    const all = streamed.join("\n");
    expect(all).not.toContain("outside_schema");
    expect(all).not.toContain(OUT_MARK);
    expect(all).toContain("fit/sql");
  });
});
