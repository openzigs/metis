/**
 * Issue #1234 — finding provenance is model-authored, and a malformed value
 * costs one field rather than a whole run.
 *
 * Before this, `persistAgentResult` wrote the literals `"inferred"` / `0.7` on
 * every agent finding, so all 8 findings of a measured run carried an identical
 * pair and `ambiguous` — the value the analysis page's human-review affordance
 * gates on — was unreachable.
 *
 * Exercises the REAL `persistAgentResult` → `getAnalysisSnapshot` path against
 * the repo's in-memory Prisma fake (the shape used by #1109's
 * `support-panel-persistence.test.ts`), plus the Zod leniency that keeps a bad
 * number from discarding a completed investigation (#1230).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentOutputSchema,
  DEFAULT_FINDING_CONFIDENCE,
  MODEL_ASSERTABLE_FINDING_DERIVATIONS,
  type AgentOutput,
} from "@metis/shared";

interface AgentResultRow {
  id: string;
  analysisId: string;
  agentKey: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  output: string | null;
  errorMessage: string | null;
}
interface FindingRow {
  id: string;
  agentResultId: string;
  category: string;
  severity: string;
  title: string;
  body: string;
  evidence: string | null;
  derivation: string;
  confidence: number;
  symbolId: string | null;
  scanFindingId: string | null;
  verificationStatus: string | null;
  createdAt: Date;
}

const store = { agentResults: [] as AgentResultRow[], findings: [] as FindingRow[], seq: 0 };
const ANALYSIS_ID = "an_1";
const PROJECT_ID = "pr_1";

const findingsFor = (id: string): FindingRow[] =>
  store.findings.filter((f) => f.agentResultId === id);

vi.mock("../prisma.js", () => ({
  prisma: {
    agentResult: {
      findFirst: vi.fn(async () => null),
      delete: vi.fn(async () => ({ id: "x" })),
      create: vi.fn(async ({ data }: { data: Partial<AgentResultRow> }) => {
        const row: AgentResultRow = {
          id: `ar_${++store.seq}`,
          analysisId: data.analysisId!,
          agentKey: data.agentKey!,
          status: data.status ?? "completed",
          startedAt: data.startedAt ?? new Date(),
          completedAt: data.completedAt ?? null,
          output: data.output ?? null,
          errorMessage: data.errorMessage ?? null,
        };
        store.agentResults.push(row);
        return row;
      }),
      findMany: vi.fn(async () =>
        store.agentResults.map((a) => ({ ...a, findings: findingsFor(a.id) })),
      ),
    },
    finding: {
      // Deliberately NO `??` defaulting on derivation/confidence: the point of
      // this suite is what `persistAgentResult` actually writes.
      create: vi.fn(async ({ data }: { data: Partial<FindingRow> }) => {
        const row: FindingRow = {
          id: `f_${++store.seq}`,
          agentResultId: data.agentResultId!,
          category: data.category ?? "other",
          severity: data.severity ?? "info",
          title: data.title ?? "",
          body: data.body ?? "",
          evidence: data.evidence ?? null,
          derivation: data.derivation as string,
          confidence: data.confidence as number,
          symbolId: data.symbolId ?? null,
          scanFindingId: data.scanFindingId ?? null,
          verificationStatus: data.verificationStatus ?? null,
          createdAt: new Date(),
        };
        store.findings.push(row);
        return row;
      }),
    },
    analysis: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id !== ANALYSIS_ID) return null;
        return {
          id: ANALYSIS_ID,
          projectId: PROJECT_ID,
          status: "completed",
          startedAt: new Date(),
          completedAt: new Date(),
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          errorMessage: null,
          metadata: null,
          agentResults: store.agentResults.map((a) => ({ ...a, findings: findingsFor(a.id) })),
          requirements: [],
        };
      }),
    },
    crossDocFinding: { findMany: vi.fn(async () => []) },
  },
}));

/** One finding, with whatever provenance the caller wants to claim. */
function output(provenance: Record<string, unknown>): AgentOutput {
  return {
    agentKey: "code",
    summary: "code agent output",
    notes: [],
    findings: [
      {
        category: "security",
        severity: "high",
        title: "Gap",
        body: "b",
        citations: [],
        tags: [],
        ...provenance,
      },
    ],
  } as AgentOutput;
}

const persist = async (provenance: Record<string, unknown>) => {
  const { persistAgentResult } = await import("./analysis-service.js");
  await persistAgentResult({
    analysisId: ANALYSIS_ID,
    agentKey: "code",
    status: "completed",
    output: output(provenance),
    startedAt: new Date(),
    completedAt: new Date(),
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
};

describe("model-authored finding provenance (#1234)", () => {
  beforeEach(() => {
    store.agentResults = [];
    store.findings = [];
    store.seq = 0;
  });

  it("persists a model-supplied confidence instead of the 0.7 constant", async () => {
    await persist({ confidence: 0.35, derivation: "inferred" });
    expect(store.findings[0].confidence).toBe(0.35);
    expect(store.findings[0].confidence).not.toBe(DEFAULT_FINDING_CONFIDENCE);
  });

  it("persists derivation='ambiguous' so the human-review affordance is reachable", async () => {
    await persist({ derivation: "ambiguous", confidence: 0.2 });
    expect(store.findings[0].derivation).toBe("ambiguous");

    // The analysis page gates its review handler on exactly this value, so the
    // snapshot the page reads has to carry it through unchanged.
    const { getAnalysisSnapshot } = await import("./analysis-service.js");
    const snapshot = await getAnalysisSnapshot(ANALYSIS_ID);
    expect(snapshot?.agents[0].findings[0].derivation).toBe("ambiguous");
  });

  it("coerces a model-claimed derivation='extracted' to 'inferred'", async () => {
    // `extracted` mandates confidence 1.0 (`createFindingSchema` refines on it)
    // and is a server-side provenance claim — a model must not be able to
    // launder its own reasoning into it.
    await persist({ derivation: "extracted", confidence: 1 });
    expect(store.findings[0].derivation).toBe("inferred");
    expect(MODEL_ASSERTABLE_FINDING_DERIVATIONS).not.toContain("extracted");
  });

  it("falls back to inferred/0.7 when the model reports neither field", async () => {
    await persist({});
    expect(store.findings[0].derivation).toBe("inferred");
    expect(store.findings[0].confidence).toBe(DEFAULT_FINDING_CONFIDENCE);
  });

  it("persists the finding even when BOTH fields are junk", async () => {
    await persist({ confidence: "very high", derivation: "vibes" });
    expect(store.findings).toHaveLength(1);
    expect(store.findings[0].derivation).toBe("inferred");
    expect(store.findings[0].confidence).toBe(DEFAULT_FINDING_CONFIDENCE);
  });
});

describe("resolveFindingProvenance malformed-value fallbacks (#1234, #1230 rule)", () => {
  const cases: Array<[string, unknown]> = [
    ["negative", -0.5],
    ["greater than 1", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["a numeric string", "0.9"],
    ["a non-numeric string", "high"],
    ["null", null],
    ["undefined", undefined],
    ["an object", { value: 0.9 }],
  ];

  it.each(cases)("falls back to the default when confidence is %s", async (_label, value) => {
    const { resolveFindingProvenance } = await import("./analysis-service.js");
    expect(resolveFindingProvenance({ confidence: value }).confidence).toBe(
      DEFAULT_FINDING_CONFIDENCE,
    );
  });

  it.each([
    ["extracted", "extracted"],
    ["an unknown string", "hallucinated"],
    ["empty", ""],
    ["null", null],
    ["a number", 1],
  ])("falls back to 'inferred' when derivation is %s", async (_label, value) => {
    const { resolveFindingProvenance } = await import("./analysis-service.js");
    expect(resolveFindingProvenance({ derivation: value }).derivation).toBe("inferred");
  });

  it("keeps the boundary values 0 and 1", async () => {
    const { resolveFindingProvenance } = await import("./analysis-service.js");
    expect(resolveFindingProvenance({ confidence: 0 }).confidence).toBe(0);
    expect(resolveFindingProvenance({ confidence: 1 }).confidence).toBe(1);
  });

  it("keeps both model-assertable derivations", async () => {
    const { resolveFindingProvenance } = await import("./analysis-service.js");
    expect(resolveFindingProvenance({ derivation: "inferred" }).derivation).toBe("inferred");
    expect(resolveFindingProvenance({ derivation: "ambiguous" }).derivation).toBe("ambiguous");
  });
});

describe("agentOutputSchema tolerates malformed provenance (#1234)", () => {
  const parse = (provenance: Record<string, unknown>) =>
    agentOutputSchema.parse({
      agentKey: "code",
      summary: "s",
      notes: [],
      findings: [
        {
          category: "security",
          severity: "high",
          title: "t",
          body: "b",
          citations: [],
          tags: [],
          ...provenance,
        },
      ],
    });

  it.each([
    ["out of range", { confidence: 5 }],
    ["negative", { confidence: -1 }],
    ["NaN", { confidence: Number.NaN }],
    ["non-numeric", { confidence: "high" }],
    ["derivation extracted", { derivation: "extracted" }],
    ["derivation unknown", { derivation: "guessed" }],
  ])("keeps the finding when provenance is %s", (_label, provenance) => {
    const parsed = parse(provenance);
    // The whole point: a bad provenance value must cost the FIELD, never the
    // completed investigation that produced the finding (#1230).
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].title).toBe("t");
  });

  it("keeps a valid pair through validation", () => {
    const parsed = parse({ confidence: 0.42, derivation: "ambiguous" });
    expect(parsed.findings[0].confidence).toBe(0.42);
    expect(parsed.findings[0].derivation).toBe("ambiguous");
  });
});
