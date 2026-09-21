/**
 * Grounding-improvement unit tests for the holistic synthesizer.
 *
 * Covers two faithfulness/grounding fixes (free-form engineering task — no issue):
 *
 *   Change 2 — `selectRelevantFacts` is keyed by the CURRENT section-group ids.
 *     Previously the relevance map used long-removed business-requirements group
 *     ids (`capabilities-and-rules`, `workflows-and-formulas`, `data-and-glossary`),
 *     so every code-derived section fell through to the default
 *     [RULES, WORKFLOWS, ENTITIES] and ranked/selected the WRONG modules (e.g. the
 *     Integrations section was scored by RULES, not INTEGRATIONS/KEY_APIS). These
 *     tests prove the right modules now outrank the wrong ones per section.
 *
 *   Change 4 — code-derived section prompts (Business Rules, Workflows,
 *     Calculations, Data Model, Integrations) carry a cite-or-omit +
 *     no-file-metadata discipline; narrative sections (Overview, Capabilities) do
 *     NOT. This drives the ONLINE synthesis path (provider + prisma mocked),
 *     capturing each section's SYSTEM prompt to assert the guidance is wired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatChunk } from "../ai/types.js";

// ── prisma mock ─────────────────────────────────────────────────────────
const mockPrisma = {
  project: { findUnique: vi.fn() },
  codeSymbol: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
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

// Capture each Phase-2 section call's {system,user} prompt pair, keyed by the
// section-group label carried in the user message.
let sectionCalls: Array<{ system: string; user: string }> = [];

function makeProvider(): AIProvider {
  return {
    key: "bedrock-gateway",
    model: "mock",
    offline: false,
    chat: vi.fn(async () => ({
      // The faithfulness pass is irrelevant here; return a benign empty verdict
      // set / claim set. (Grounding is not supplied, so the pass is skipped.)
      content: JSON.stringify({ claims: [], verdicts: [] }),
    })),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue(["mock"]),
    ping: vi.fn().mockResolvedValue(true),
    async *stream(messages, _opts): AsyncGenerator<ChatChunk> {
      const system = String(messages[0]?.content ?? "");
      const user = String(messages[messages.length - 1]?.content ?? "");
      if (user.includes("section group now")) {
        sectionCalls.push({ system, user });
        yield { type: "delta", content: `## Section\n\nProse.` };
        yield { type: "done" };
        return;
      }
      // Phase-1 fact extraction stream.
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

import {
  synthesizeHolisticDocument,
  selectRelevantFacts,
  type ModuleFacts,
  type SectionGroup,
} from "./holistic-synthesizer.js";

/** A synthetic module whose facts are heavy under the given header. */
function moduleWithHeader(name: string, header: string, bullets: number): ModuleFacts {
  const body = Array.from({ length: bullets }, (_, i) => `- ${header} item ${i + 1}`).join("\n");
  // Other headers present but empty, so scoring depends on the heavy header.
  const facts = `PURPOSE\nA module.\n\n${header}\n${body}\n\nNOTES\n- n/a\n`;
  return {
    modulePath: `src/${name}`,
    moduleName: name,
    classCount: 1,
    methodCount: 0,
    facts,
    formulas: [],
    topClasses: [name],
    dataLineage: null,
  };
}

function group(id: string): SectionGroup {
  return { id, label: id, instructions: "x" };
}

describe("selectRelevantFacts — current section-group ids (Change 2)", () => {
  it("ranks an INTEGRATIONS-heavy module above a RULES-heavy one for integrations-and-glossary", () => {
    const integ = moduleWithHeader("IntegModule", "INTEGRATIONS", 8);
    const rules = moduleWithHeader("RulesModule", "RULES", 8);
    const { included } = selectRelevantFacts(
      [rules, integ],
      group("integrations-and-glossary"),
      "business-requirements",
    );
    // Both included (no budget pressure), but the integrations module must rank first.
    expect(included[0].moduleName).toBe("IntegModule");
  });

  it("ranks a RULES-heavy module above an INTEGRATIONS-heavy one for rules (the reverse)", () => {
    const integ = moduleWithHeader("IntegModule", "INTEGRATIONS", 8);
    const rules = moduleWithHeader("RulesModule", "RULES", 8);
    const { included } = selectRelevantFacts(
      [integ, rules],
      group("rules"),
      "business-requirements",
    );
    expect(included[0].moduleName).toBe("RulesModule");
  });

  it("ranks a FORMULAS-heavy module first for the formulas section", () => {
    const formulas = moduleWithHeader("CalcModule", "FORMULAS", 8);
    const rules = moduleWithHeader("RulesModule", "RULES", 8);
    const { included } = selectRelevantFacts(
      [rules, formulas],
      group("formulas"),
      "business-requirements",
    );
    expect(included[0].moduleName).toBe("CalcModule");
  });

  it("ranks an ENTITIES-heavy module first for the data-model section", () => {
    const entities = moduleWithHeader("EntityModule", "ENTITIES", 8);
    const workflows = moduleWithHeader("FlowModule", "WORKFLOWS", 8);
    const { included } = selectRelevantFacts(
      [workflows, entities],
      group("data-model"),
      "business-requirements",
    );
    expect(included[0].moduleName).toBe("EntityModule");
  });

  it("falls back to the default keywords for an unknown section id (no throw)", () => {
    const rules = moduleWithHeader("RulesModule", "RULES", 8);
    const { included } = selectRelevantFacts(
      [rules],
      group("totally-unknown-section"),
      "business-requirements",
    );
    expect(included.map((m) => m.moduleName)).toContain("RulesModule");
  });

  it("omits modules that exceed the per-section char cap (selection still works)", () => {
    const a = moduleWithHeader("A", "RULES", 8);
    const b = moduleWithHeader("B", "RULES", 8);
    // Cap smaller than a single module entry forces the lower-ranked one out.
    const { included, omitted } = selectRelevantFacts(
      [a, b],
      group("rules"),
      "business-requirements",
      50,
    );
    expect(included.length + omitted.length).toBe(2);
    expect(omitted.length).toBeGreaterThan(0);
  });
});

describe("code-derived section prompts carry cite-or-omit guidance (Change 4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sectionCalls = [];
    delete process.env.BEDROCK_GATEWAY_URL;
    delete process.env.BEDROCK_GATEWAY_BASE_URL;
    process.env.AI_OFFLINE = "0";
    mockPrisma.project.findUnique.mockResolvedValue({ name: "Proj" });
    mockPrisma.codeSymbol.count.mockResolvedValue(10);
    mockPrisma.codeSymbol.groupBy.mockResolvedValue([{ filePath: "src/a.ts" }]);
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      {
        id: "s1",
        codeGraphId: "graph-a",
        qualifiedName: "src.A",
        kind: "class",
        filePath: "src/a.ts",
        startLine: 1,
        endLine: 5,
      },
      {
        id: "s2",
        codeGraphId: "graph-a",
        qualifiedName: "src.A.m1",
        kind: "method",
        filePath: "src/a.ts",
        startLine: 6,
        endLine: 9,
      },
      {
        id: "s3",
        codeGraphId: "graph-a",
        qualifiedName: "src.A.m2",
        kind: "method",
        filePath: "src/a.ts",
        startLine: 10,
        endLine: 13,
      },
      {
        id: "s4",
        codeGraphId: "graph-a",
        qualifiedName: "src.A.m3",
        kind: "method",
        filePath: "src/a.ts",
        startLine: 14,
        endLine: 17,
      },
    ]);
    mockPrisma.codeGraph.findFirst.mockResolvedValue(null);
    mockPrisma.codeGraph.findMany.mockResolvedValue([
      { id: "graph-a", repoConnection: { id: "a", projectId: "p1", deletedAt: null } },
    ]);
    mockPrisma.finding.findMany.mockResolvedValue([]);
    mockPrisma.repoConnection.findFirst.mockResolvedValue(null);
    mockPrisma.docsGenFactCache.findUnique.mockResolvedValue(null);
    mockPrisma.docsGenFactCache.upsert.mockResolvedValue({});
  });

  afterEach(() => {
    process.env.AI_OFFLINE = "1";
  });

  it("appends the discipline to code-derived sections but NOT to narrative sections", async () => {
    await synthesizeHolisticDocument("p1", "business-requirements", "BR Doc");
    expect(sectionCalls.length).toBeGreaterThan(0);

    const codeDerived = sectionCalls.filter(
      (c) =>
        c.user.includes("Business Rules & Policies") ||
        c.user.includes("Key Workflows") ||
        c.user.includes("Calculations & Formulas") ||
        c.user.includes("Data & Domain Model") ||
        c.user.includes("Integrations & Glossary"),
    );
    const narrative = sectionCalls.filter(
      (c) => c.user.includes("Overview & Domain") || c.user.includes("Core Business Capabilities"),
    );

    expect(codeDerived.length).toBe(5);
    expect(narrative.length).toBe(2);

    // Every code-derived section gets the cite-or-omit + no-metadata discipline,
    // plus the inline provenance mandate (mark inferred statements `_(inferred)_`).
    for (const c of codeDerived) {
      expect(c.system).toContain("GROUNDING DISCIPLINE");
      expect(c.system).toContain("OMIT it");
      expect(c.system.toLowerCase()).toContain("modification");
      expect(c.system.toLowerCase()).toContain("author");
      expect(c.system).toContain("_(inferred)_");
      expect(c.system).toContain("MARK INFERENCES");
    }
    // Narrative sections deliberately do NOT (they supply domain context).
    for (const c of narrative) {
      expect(c.system).not.toContain("GROUNDING DISCIPLINE");
    }
  });

  it("is ground-or-omit, not invent-a-citation (no fabrication instruction)", async () => {
    await synthesizeHolisticDocument("p1", "business-requirements", "BR Doc");
    const rules = sectionCalls.find((c) => c.user.includes("Business Rules & Policies"));
    expect(rules).toBeDefined();
    // Explicitly forbids fabricating a source id.
    expect(rules!.system.toLowerCase()).toContain("never fabricate a source id");
  });
});
