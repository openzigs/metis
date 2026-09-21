/**
 * #271 — reconstruction-grade synthesis fixture tests.
 *
 * Drives the full ONLINE synthesis path (provider + prisma mocked) with a
 * SAS function-only module group whose code graph carries DATA/PROC lineage
 * edges (references + metadata.lineage) and a cross-module dependency edge,
 * and PROVES end-to-end that:
 *
 *   1. DATA_LINEAGE (dataset input/output) appears in the Phase-1 fact
 *      extraction prompt AND in the returned/cached facts text.
 *   2. The project-level cross-module flow + dataset lineage chain is fed into
 *      the Phase-2 synthesis prompt (END-TO-END FLOW block).
 *   3. SAS rules (subsetting IF, WHERE, RETAIN, KEEP/DROP, PROC options, macro
 *      params) are mined and injected into the Phase-1 prompt.
 *
 * This isolates the #271 content track: it does NOT touch the grounding /
 * citation validator (no grounding context is supplied).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { AIProvider, ChatChunk, ChatMessage } from "../ai/types.js";

// ── prisma mock (adds codeEdge for #271 edge loading) ─────────────────────
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

// ── filesystem mock: serve SAS source for the lineage modules ─────────────
const SAS_SOURCE_LOAD = `%macro risk_calc(asof=, cutoff=0.8);
data work.flagged;
  set raw.exposures;
  where reporting_date <= &asof;
  retain cum_exposure 0;
  cum_exposure = cum_exposure + amount;
  if rating in ('CCC','D') then risk_flag = 1;
  else risk_flag = 0;
  if amount > 0;
  keep entity_id amount risk_flag cum_exposure;
run;
%mend;`;

const SAS_SOURCE_REPORT = `proc sql;
  create table report.summary as
  select entity_id, sum(amount) as total
  from work.flagged
  group by entity_id
  having sum(amount) > 1000
  order by total desc;
quit;`;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: vi.fn(async (p: string) => path.resolve(p)),
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn(async (p: string, enc?: unknown) => {
      const s = String(p);
      if (s.endsWith("/.git/HEAD")) return "ref: refs/heads/main\n";
      if (s.includes("load.sas")) return SAS_SOURCE_LOAD;
      if (s.includes("risk.sas")) return SAS_SOURCE_REPORT;
      // Unrelated reads retain their real filesystem behavior.
      return actual.readFile(p as never, enc as never);
    }),
  };
});

// ── provider mock: capture EVERY prompt sent so we can assert on them ──────
const capturedPrompts: { phase: "phase1" | "phase2"; messages: ChatMessage[] }[] = [];

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
      const isPhase2 = user.includes("section group now");
      capturedPrompts.push({ phase: isPhase2 ? "phase2" : "phase1", messages });
      if (isPhase2) {
        // #1226 — each group must lead with its OWN H2. Reusing one heading for
        // every group had them collapsed into a single block by
        // `dedupeH2Sections`, which is now reported as a missing section.
        const label = /Section group: \*\*(.+?)\*\*/.exec(user)?.[1] ?? "Section";
        yield { type: "delta", content: `## ${label}\n\nSAS prose.` };
      } else {
        yield { type: "delta", content: "PURPOSE\nETL module." };
      }
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

// Two SAS modules: etl/load.sas (writes work.flagged from raw.exposures) and
// report/risk.sas (reads work.flagged → writes report.summary). Each module
// dir has ≥3 SAS function symbols so it qualifies the SAS-relaxed filter.
const LOAD = "sas/etl/load.sas";
const REPORT = "sas/report/risk.sas";

const sasFn = (id: string, name: string, filePath: string) => ({
  id,
  codeGraphId: "graph-a",
  qualifiedName: `${filePath}::${name}`,
  kind: "function",
  language: "sas",
  filePath,
  startLine: 1,
  endLine: 12,
});

function refEdge(fromSymbolId: string, dataset: string, lineage: "input" | "output") {
  return {
    kind: "references",
    fromSymbolId,
    toSymbolId: null,
    toQualifiedName: dataset,
    metadata: JSON.stringify({ lineage, dataset }),
  };
}

function seedPrisma(): void {
  mockPrisma.project.findUnique.mockResolvedValue({ name: "RiskCalc" });
  mockPrisma.codeSymbol.count.mockResolvedValue(6);
  mockPrisma.codeSymbol.groupBy.mockResolvedValue([{ filePath: LOAD }, { filePath: REPORT }]);
  mockPrisma.codeGraph.findFirst.mockResolvedValue(null);
  mockPrisma.codeGraph.findMany.mockResolvedValue([
    { id: "graph-a", repoConnection: { id: "a", projectId: "p1", deletedAt: null } },
  ]);
  mockPrisma.finding.findMany.mockResolvedValue([]);
  mockPrisma.repoConnection.findFirst.mockResolvedValue(null);
  mockPrisma.docsGenFactCache.findUnique.mockResolvedValue(null);
  mockPrisma.docsGenFactCache.upsert.mockResolvedValue({});

  mockPrisma.codeSymbol.findMany.mockResolvedValue([
    sasFn("l1", "risk_calc", LOAD),
    sasFn("l2", "flagged", LOAD),
    sasFn("l3", "macroClean", LOAD),
    sasFn("r1", "summary", REPORT),
    sasFn("r2", "procSql", REPORT),
    sasFn("r3", "report_macro", REPORT),
  ] as never);

  // Lineage edges + one cross-module code edge (report calls load's macro).
  mockPrisma.codeEdge.findMany.mockResolvedValue([
    refEdge("l2", "raw.exposures", "input"),
    refEdge("l2", "work.flagged", "output"),
    refEdge("r1", "work.flagged", "input"),
    refEdge("r1", "report.summary", "output"),
    {
      kind: "calls",
      fromSymbolId: "r3",
      toSymbolId: "l1",
      toQualifiedName: `${LOAD}::risk_calc`,
    },
  ] as never);
}

function phase1Text(): string {
  return capturedPrompts
    .filter((p) => p.phase === "phase1")
    .map((p) => p.messages.map((m) => String(m.content)).join("\n"))
    .join("\n\n====\n\n");
}
function phase2Text(): string {
  return capturedPrompts
    .filter((p) => p.phase === "phase2")
    .map((p) => p.messages.map((m) => String(m.content)).join("\n"))
    .join("\n\n====\n\n");
}

describe("#271 reconstruction-grade synthesis (SAS lineage + cross-module + rules)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedPrompts.length = 0;
    delete process.env.BEDROCK_GATEWAY_URL;
    delete process.env.BEDROCK_GATEWAY_BASE_URL;
    process.env.AI_OFFLINE = "0";
    seedPrisma();
  });

  afterEach(() => {
    process.env.AI_OFFLINE = "1";
  });

  it("surfaces DATA_LINEAGE into the Phase-1 fact prompt (input + output datasets)", async () => {
    await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    const p1 = phase1Text();
    expect(p1).toContain("DATA_LINEAGE");
    // load.sas module: reads raw.exposures, writes work.flagged.
    expect(p1).toContain("raw.exposures");
    expect(p1).toContain("work.flagged");
  });

  it("persists DATA_LINEAGE into the cached/returned facts text (survives cache)", async () => {
    await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    // The facts written to cache must carry the DATA_LINEAGE section so Phase-2
    // sees it via factsModuleEntry even on a later cache hit.
    const upserts = mockPrisma.docsGenFactCache.upsert.mock.calls;
    expect(upserts.length).toBeGreaterThan(0);
    const anyFactsHaveLineage = upserts.some((c) => {
      const args = c[0] as { create?: { facts?: string } };
      return (args.create?.facts ?? "").includes("DATA_LINEAGE");
    });
    expect(anyFactsHaveLineage).toBe(true);
  });

  it("feeds the cross-module flow + dataset lineage chain into the Phase-2 synthesis prompt", async () => {
    await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    const p2 = phase2Text();
    expect(p2).toContain("=== END FLOW ===");
    expect(p2).toContain("DATASET LINEAGE");
    // work.flagged is produced by etl and consumed by report → chain present.
    expect(p2).toContain("work.flagged");
    expect(p2).toContain("CROSS-MODULE DEPENDENCIES");
    // report module depends on etl module (the calls edge).
    expect(p2).toMatch(/sas\/report.*→.*sas\/etl|sas\/etl/);
  });

  it("mines SAS rules and injects them into the Phase-1 prompt", async () => {
    await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    const p1 = phase1Text();
    expect(p1).toContain("SAS RULE INVENTORY");
    // Categories proven from the risk-calc-style fixture source.
    expect(p1).toContain("Subsetting IF (row filters)");
    expect(p1).toContain("WHERE filters");
    expect(p1).toContain("RETAIN (carried state)");
    expect(p1).toContain("KEEP/DROP (output fields)");
    expect(p1).toContain("Macro parameters");
  });

  it("still produces a non-empty document (no regression in the SAS module filter)", async () => {
    const result = await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    expect(result.markdown).not.toContain("No documentable modules");
    expect(result.markdown).toContain("SAS prose.");
    expect(result.warnings).toHaveLength(0);
  });

  it("degrades gracefully when edge loading fails (lineage absent, no crash)", async () => {
    mockPrisma.codeEdge.findMany.mockRejectedValue(new Error("db down"));
    const result = await synthesizeHolisticDocument("p1", "business-requirements", "BRD");
    expect(result.markdown).toContain("SAS prose.");
    // No flow block injected into the user prompt when edges could not be
    // loaded (the `=== END FLOW ===` delimiter is only emitted with a flowBlob;
    // the literal phrase "END-TO-END FLOW" also appears in the static workflow
    // instructions, so assert on the unique delimiter instead).
    expect(phase2Text()).not.toContain("=== END FLOW ===");
  });
});
