/**
 * Epic #1107 (#1109) — the panel signal persists ALONGSIDE the deterministic
 * `verificationStatus`, and a flag-off run persists byte-identically to a
 * pre-#1109 run.
 *
 * Exercises the REAL `persistAgentResult` → `getAnalysisSnapshot` path against
 * the repo's in-memory Prisma fake, so the acceptance criterion "verdicts and
 * reasoning persist alongside the existing label" is proven end to end rather
 * than asserted about a type. The panel rides the existing `Finding.evidence`
 * JSON blob — the same no-migration route #916's `requirementId` and #773's
 * `verdict` already take.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOutput, FindingSupportPanel } from "@metis/shared";

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

const PANEL: FindingSupportPanel = {
  confidence: "low",
  votes: [
    {
      lens: "support",
      judgement: "unsupported",
      discardReason: null,
      citation: "src/api/auth.ts:12",
      reasoning: "src/api/auth.ts:12 already implements the thing the finding calls absent",
      counted: true,
    },
    {
      lens: "scope",
      judgement: "unsupported",
      discardReason: null,
      citation: "src/api/auth.ts:30",
      reasoning: "one handler generalised to the whole surface",
      counted: true,
    },
    {
      lens: "currency",
      judgement: null,
      discardReason: "no-signal",
      citation: null,
      reasoning: "provider-error: upstream 503",
      counted: false,
    },
  ],
  countedVotes: 2,
  supportedVotes: 0,
  unsupportedVotes: 2,
  uncertainVotes: 0,
  noSignalVotes: 1,
  uncitedVotes: 0,
  usage: { promptTokens: 900, completionTokens: 120, llmCalls: 3 },
};

function output(withPanel: boolean): AgentOutput {
  return {
    agentKey: "code",
    summary: "code agent output",
    notes: [],
    findings: [
      {
        category: "security",
        severity: "high",
        title: "Graded gap",
        body: "b",
        citations: [],
        tags: [],
        verificationStatus: "confirmed",
        ...(withPanel ? { supportPanel: PANEL } : {}),
      },
    ],
  };
}

const persist = async (withPanel: boolean) => {
  const { persistAgentResult } = await import("./analysis-service.js");
  await persistAgentResult({
    analysisId: ANALYSIS_ID,
    agentKey: "code",
    status: "completed",
    output: output(withPanel),
    startedAt: new Date(),
    completedAt: new Date(),
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
};

describe("support-panel persistence round-trip (#1109)", () => {
  beforeEach(() => {
    store.agentResults = [];
    store.findings = [];
    store.seq = 0;
  });

  it("persists the panel BESIDE verificationStatus, not instead of it", async () => {
    await persist(true);
    const row = store.findings[0];
    expect(row.verificationStatus).toBe("confirmed");
    const blob = JSON.parse(row.evidence!);
    expect(blob.supportPanel.confidence).toBe("low");
    expect(blob.supportPanel.votes).toHaveLength(3);
  });

  it("writes NO supportPanel key at all when the panel did not run", async () => {
    // "Flag off ⇒ byte-identical to today": a `"supportPanel": null` key would
    // still be a difference in the persisted blob, so the key is omitted.
    await persist(false);
    const blob = JSON.parse(store.findings[0].evidence!);
    expect(Object.keys(blob)).not.toContain("supportPanel");
  });

  it("surfaces the panel on the analysis GET snapshot with its reasoning intact", async () => {
    await persist(true);
    const { getAnalysisSnapshot } = await import("./analysis-service.js");
    const snapshot = await getAnalysisSnapshot(ANALYSIS_ID);
    const finding = snapshot?.agents.find((a) => a.agentKey === "code")?.findings[0];
    expect(finding?.supportPanel).toEqual(PANEL);
    // The audit trail #1110 renders: every vote keeps its file:line and its words.
    expect(finding?.supportPanel?.votes[0].citation).toBe("src/api/auth.ts:12");
    // …and a degraded lens stays a NON-vote, never a vote against the finding.
    expect(finding?.supportPanel?.votes[2]).toMatchObject({
      judgement: null,
      discardReason: "no-signal",
      counted: false,
    });
  });

  it("reads a pre-#1109 row as 'no panel' rather than half-formed state", async () => {
    await persist(false);
    const { getAnalysisSnapshot } = await import("./analysis-service.js");
    const snapshot = await getAnalysisSnapshot(ANALYSIS_ID);
    expect(snapshot?.agents[0].findings[0].supportPanel).toBeNull();
  });

  it("discards a malformed persisted panel instead of leaking it to the UI", async () => {
    await persist(true);
    const row = store.findings[0];
    row.evidence = JSON.stringify({ citations: [], tags: [], supportPanel: { confidence: "hmm" } });
    const { getAnalysisSnapshot } = await import("./analysis-service.js");
    const snapshot = await getAnalysisSnapshot(ANALYSIS_ID);
    expect(snapshot?.agents[0].findings[0].supportPanel).toBeNull();
  });
});
