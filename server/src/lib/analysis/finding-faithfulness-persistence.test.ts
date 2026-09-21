/**
 * Epic #1316 (#1318) — the analysis pipeline's claim-level faithfulness metric
 * persists ALONGSIDE the deterministic `verificationStatus` and is READABLE back
 * through the same path a real consumer uses.
 *
 * Written because a metric that is computed, attached in memory and then dropped
 * at the storage boundary is the classic "the write reports success but the read
 * cannot see it" defect — and it passes every unit test of the scorer. This
 * exercises the REAL `persistAgentResult` -> `getAnalysisSnapshot` path against
 * the repo's in-memory Prisma fake. The metric rides the existing
 * `Finding.evidence` JSON blob, the same no-migration route #916's
 * `requirementId`, #773's `verdict` and #1109's `supportPanel` already take.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOutput, FindingFaithfulness } from "@metis/shared";
import { applyFindingFaithfulness, toFindingFaithfulness } from "./finding-faithfulness.js";
import type { PanelEvidence } from "./support-panel.js";
import type { AIProvider } from "../ai/types.js";
import type { GroundingContext } from "../docs-gen/grounding/grounding-context.js";

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
      create: vi.fn(async ({ data }: { data: Partial<FindingRow> }) => {
        const row: FindingRow = {
          id: `f_${++store.seq}`,
          agentResultId: data.agentResultId!,
          category: data.category ?? "other",
          severity: data.severity ?? "info",
          title: data.title ?? "",
          body: data.body ?? "",
          evidence: data.evidence ?? null,
          derivation: data.derivation ?? "inferred",
          confidence: data.confidence ?? 0.7,
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

/**
 * Built through the PRODUCTION factory, not as a literal: `persistAgentResult`
 * persists only a metric the server authored (#1318 review), and the mark that
 * says so is applied by `toFindingFaithfulness`. A hand-written literal is
 * indistinguishable from one a model emitted, and is meant to be dropped.
 */
const METRIC: FindingFaithfulness = toFindingFaithfulness({
  faithfulness: 0.75,
  totalClaims: 4,
  supportedClaims: 3,
});

/** An UNVERIFIABLE measurement: null score plus the reason it could not be made. */
const UNVERIFIABLE: FindingFaithfulness = toFindingFaithfulness({
  faithfulness: null,
  totalClaims: 0,
  supportedClaims: 0,
  unverifiableReason: "judge-unavailable",
});

function output(faithfulness: FindingFaithfulness | undefined): AgentOutput {
  return {
    agentKey: "code",
    summary: "code agent output",
    notes: [],
    findings: [
      {
        category: "security",
        severity: "high",
        title: "Measured gap",
        body: "b",
        citations: [],
        tags: [],
        verificationStatus: "unverified",
        ...(faithfulness ? { faithfulness } : {}),
      },
    ],
  };
}

const persist = async (faithfulness?: FindingFaithfulness) => {
  const { persistAgentResult } = await import("./analysis-service.js");
  await persistAgentResult({
    analysisId: ANALYSIS_ID,
    agentKey: "code",
    status: "completed",
    output: output(faithfulness),
    startedAt: new Date(),
    completedAt: new Date(),
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
};

const snapshotFinding = async () => {
  const { getAnalysisSnapshot } = await import("./analysis-service.js");
  const snapshot = await getAnalysisSnapshot(ANALYSIS_ID);
  return snapshot?.agents.find((a) => a.agentKey === "code")?.findings[0];
};

describe("faithfulness-metric persistence round-trip (#1318)", () => {
  beforeEach(() => {
    store.agentResults = [];
    store.findings = [];
    store.seq = 0;
  });

  it("persists the metric BESIDE verificationStatus, not instead of it", async () => {
    await persist(METRIC);
    const row = store.findings[0];
    expect(row.verificationStatus).toBe("unverified");
    expect(JSON.parse(row.evidence!).faithfulness).toEqual(METRIC);
  });

  it("writes NO faithfulness key at all when the metric did not run", async () => {
    // "Flag off => byte-identical to a pre-#1318 run": a `"faithfulness": null`
    // key would still be a difference in the persisted blob, so it is omitted.
    await persist(undefined);
    expect(Object.keys(JSON.parse(store.findings[0].evidence!))).not.toContain("faithfulness");
  });

  it("surfaces the metric on the analysis GET snapshot — the read CAN see the write", async () => {
    await persist(METRIC);
    expect((await snapshotFinding())?.faithfulness).toEqual(METRIC);
  });

  it("round-trips an UNVERIFIABLE measurement as null, never as 0 or 1", async () => {
    await persist(UNVERIFIABLE);
    const finding = await snapshotFinding();
    expect(finding?.faithfulness?.score).toBeNull();
    expect(finding?.faithfulness?.unverifiableReason).toBe("judge-unavailable");
  });

  it("round-trips a score of 0 as a real measurement, not as 'not measured'", async () => {
    // The trap a truthiness check falls into: `{ score: 0 }` is a finding the
    // judge scored and found wholly unsupported. Dropping it would hide the worst
    // result the metric can produce.
    await persist(toFindingFaithfulness({ faithfulness: 0, totalClaims: 3, supportedClaims: 0 }));
    expect((await snapshotFinding())?.faithfulness).toEqual({
      score: 0,
      totalClaims: 3,
      supportedClaims: 0,
    });
  });

  it("reads a pre-#1318 row as 'not measured' rather than half-formed state", async () => {
    await persist(undefined);
    expect((await snapshotFinding())?.faithfulness).toBeNull();
  });

  it("discards a malformed persisted metric instead of leaking it to the UI", async () => {
    await persist(METRIC);
    store.findings[0].evidence = JSON.stringify({
      citations: [],
      tags: [],
      faithfulness: { score: 42, totalClaims: -1, supportedClaims: "many" },
    });
    expect((await snapshotFinding())?.faithfulness).toBeNull();
  });
});

/**
 * The mainline specialist path: `AnalysisOrchestrator.runOneAgent` hands
 * `runAgent`'s output straight to `persistAgentResult` for the `document`,
 * `business` and `database` agents — no panel, no metric, no grader. Whatever
 * the model emitted for `faithfulness` is what reaches storage unless the
 * storage boundary itself refuses it.
 */
describe("#1318 — a MODEL-authored faithfulness never reaches storage", () => {
  beforeEach(() => {
    store.agentResults = [];
    store.findings = [];
    store.seq = 0;
  });

  /** Exactly what the plain-Zod path yields for `"faithfulness": {...}`. */
  const modelAuthored = (): FindingFaithfulness =>
    JSON.parse(
      JSON.stringify({ score: 1, totalClaims: 40, supportedClaims: 40 }),
    ) as FindingFaithfulness;

  it("drops a fabricated perfect score persisted with no grader in the path", async () => {
    await persist(modelAuthored());
    expect(Object.keys(JSON.parse(store.findings[0].evidence!))).not.toContain("faithfulness");
    expect((await snapshotFinding())?.faithfulness).toBeNull();
  });

  it("still persists the deterministic verificationStatus it rode in with", async () => {
    // The strip must remove ONE key, not quarantine the finding.
    await persist(modelAuthored());
    expect(store.findings[0].verificationStatus).toBe("unverified");
    expect(store.findings[0].title).toBe("Measured gap");
  });

  it("drops a COPY of a server metric — the mark is identity, not shape", async () => {
    // A JSON round trip anywhere between grader and storage yields a value the
    // server cannot vouch for. Dropping it loses a real measurement; keeping it
    // would mean shape alone is enough to be believed, which is the hole.
    await persist({ ...METRIC });
    expect(Object.keys(JSON.parse(store.findings[0].evidence!))).not.toContain("faithfulness");
  });

  it("persists the metric when the SERVER authored it on the same path", async () => {
    // The discriminator: same call site, same shape, different provenance.
    await persist(METRIC);
    expect(JSON.parse(store.findings[0].evidence!).faithfulness).toEqual({
      score: 0.75,
      totalClaims: 4,
      supportedClaims: 3,
    });
  });
});

/**
 * The whole chain, end to end: the REAL grader produces the metric and the REAL
 * storage boundary accepts it. Neither test above proves this on its own — the
 * grader tests stop in memory, and the round-trip tests start from a value the
 * test itself built. If the mark the grader applies and the mark storage checks
 * for ever diverge, the metric would vanish between two green suites.
 */
describe("#1318 — grader output survives the storage boundary", () => {
  beforeEach(() => {
    store.agentResults = [];
    store.findings = [];
    store.seq = 0;
  });

  const provider = {
    key: "anthropic",
    model: "test-model",
    offline: false,
    capabilities: { streaming: true, tools: true, embeddings: false, vision: false },
    chat: vi.fn(async () => ({
      content: "{}",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(async () => ["test-model"]),
    ping: vi.fn(async () => true),
  } as unknown as AIProvider;

  const EVIDENCE: PanelEvidence[] = [
    {
      filePath: "src/auth/login.ts",
      startLine: 10,
      endLine: 30,
      excerpt: "export function login() {}",
    },
  ];

  it("persists a metric the grader computed, unmarked copies aside", async () => {
    const finding = {
      category: "security" as const,
      severity: "high" as const,
      title: "Login lacks rate limiting",
      body: "The login route has no limiter.",
      citations: [
        { type: "code", filePath: "src/auth/login.ts", startLine: 10, endLine: 30 },
      ] as AgentOutput["findings"][number]["citations"],
      tags: [],
      verificationStatus: "unverified" as const,
    };
    const scored = await applyFindingFaithfulness(provider, [finding], EVIDENCE, {
      enabled: true,
      extractor: {
        decompose: vi.fn(async (_t: string, _c: GroundingContext) => ({
          claims: [{ claim: "login has no limiter" }, { claim: "login is a route" }],
        })),
      },
      judge: {
        judge: vi.fn(async (claims: string[]) =>
          claims.map((claim, i) => ({ claim, supported: i === 0 })),
        ),
      },
    });

    const { persistAgentResult } = await import("./analysis-service.js");
    await persistAgentResult({
      analysisId: ANALYSIS_ID,
      agentKey: "code",
      status: "completed",
      output: { agentKey: "code", summary: "s", notes: [], findings: scored.findings },
      startedAt: new Date(),
      completedAt: new Date(),
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    expect((await snapshotFinding())?.faithfulness).toEqual({
      score: 0.5,
      totalClaims: 2,
      supportedClaims: 1,
    });
    expect(store.findings[0].verificationStatus).toBe("unverified");
  });
});
