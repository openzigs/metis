/**
 * Tests for the gap-report SERVICE aggregation (#742). Proves assembly from the
 * real `getAnalysisSnapshot` read-path SHAPE via an injected loader — the report
 * is built from persisted requirement + finding rows, not stubbed builder
 * internals.
 */
import { describe, it, expect, vi } from "vitest";
import type { AnalysisSnapshot } from "@metis/shared";
import { getGapReport } from "./gap-report-service.js";
import type { GapReportSchemaImpactInput } from "./gap-report.js";

function snapshot(overrides: Partial<AnalysisSnapshot> = {}): AnalysisSnapshot {
  return {
    id: "an-1",
    projectId: "proj-1",
    status: "completed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    errorMessage: null,
    metadata: null,
    crossDocFindings: null,
    capability: null,
    affectedCode: null,
    escalation: null,
    agents: [
      {
        agentKey: "code",
        status: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        summary: null,
        notes: [],
        errorMessage: null,
        findings: [
          {
            id: "f-1",
            category: "gap",
            severity: "high",
            title: "No account lockout",
            body: "Requirement asks for lockout; auth.ts logs in but has no throttle; add attempt counting.",
            tags: [],
            citations: [
              { filePath: "server/src/auth.ts", startLine: 10, endLine: 20, symbolId: "sym-a" },
            ],
            derivation: "inferred",
            confidence: 0.7,
            agentResultId: "ar-1",
            requirementId: null,
            verificationStatus: "confirmed",
          },
        ],
      },
    ],
    requirements: [
      {
        id: "req-1",
        type: "feature",
        title: "Users can log in",
        body: "Users authenticate with email + password and are locked out after repeated failures.",
        priority: "high",
        labels: [],
        storyPoints: 5,
        reviewStatus: "draft",
        evidenceFindingIds: ["f-1"],
        coverage: "grounded_in_code",
        version: 1,
      },
    ],
    ...overrides,
  };
}

describe("getGapReport", () => {
  it("returns null when the analysis is not visible", async () => {
    const report = await getGapReport("missing", {
      loadSnapshot: vi.fn().mockResolvedValue(null),
    });
    expect(report).toBeNull();
  });

  it("assembles a per-requirement report from the snapshot read path", async () => {
    const report = await getGapReport("an-1", {
      loadSnapshot: vi.fn().mockResolvedValue(snapshot()),
    });
    expect(report).not.toBeNull();
    expect(report!.analysisId).toBe("an-1");
    expect(report!.requirements).toHaveLength(1);
    const r = report!.requirements[0]!;
    expect(r.requirementId).toBe("req-1");
    expect(r.body).toContain("email + password");
    expect(r.storyPoints).toBe(5);
    expect(r.coverage).toBe("grounded_in_code");
    expect(r.verificationStatus).toBe("confirmed");
    expect(r.currentImplementation.citations).toEqual([
      { filePath: "server/src/auth.ts", startLine: 10, endLine: 20, symbolId: "sym-a" },
    ]);
    expect(r.gapFindings[0]!.body).toContain("no throttle");
    expect(r.noEvidence).toBe(false);
  });

  it("coerces an unknown finding severity to 'info' and a missing coverage to null", async () => {
    const snap = snapshot();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (snap.agents[0]!.findings[0] as any).severity = "bogus";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (snap.requirements[0] as any).coverage = undefined;
    const report = await getGapReport("an-1", {
      loadSnapshot: vi.fn().mockResolvedValue(snap),
    });
    const r = report!.requirements[0]!;
    expect(r.gapFindings[0]!.severity).toBe("info");
    expect(r.coverage).toBeNull();
  });

  it("surfaces a no-evidence report for a requirement whose findings cite no code", async () => {
    const snap = snapshot();
    snap.agents[0]!.findings[0]!.citations = [{ documentId: "doc-1", chunkIndex: 0 }];
    snap.agents[0]!.findings[0]!.verificationStatus = null;
    snap.requirements[0]!.coverage = "no_evidence";
    const report = await getGapReport("an-1", {
      loadSnapshot: vi.fn().mockResolvedValue(snap),
    });
    const r = report!.requirements[0]!;
    expect(r.noEvidence).toBe(true);
    expect(r.currentImplementation.hasEvidence).toBe(false);
    expect(r.verificationStatus).toBeNull();
  });

  it("threads databaseChanges through when a schema-impact loader is provided (#825)", async () => {
    const schemaImpact = new Map<string, GapReportSchemaImpactInput>([
      [
        "req-1",
        {
          rows: [
            {
              objectKind: "column",
              tableName: "public.users",
              columnName: "locked_at",
              columnType: "timestamptz",
              changeKind: "add-column",
              suggestedDdl: "ALTER TABLE public.users ADD COLUMN locked_at timestamptz;",
              source: "orm",
              reconciliation: "matched",
              confidence: 0.85,
            },
          ],
          consumers: [
            {
              tableName: "public.users",
              columnName: "locked_at",
              changeKind: "add-column",
              identityResolved: true,
              consumers: [
                {
                  projectId: "p-2",
                  projectName: "billing",
                  usage: "readBy",
                  objectQualifiedName: "public.users",
                },
              ],
            },
          ],
        },
      ],
    ]);
    const report = await getGapReport("an-1", {
      loadSnapshot: vi.fn().mockResolvedValue(snapshot()),
      loadSchemaImpact: vi.fn().mockResolvedValue(schemaImpact),
    });
    const r = report!.requirements[0]!;
    expect(r.databaseChanges).toHaveLength(1);
    expect(r.databaseChanges![0]!.tableName).toBe("public.users");
    expect(r.databaseChanges![0]!.identityResolved).toBe(true);
    expect(r.databaseChanges![0]!.consumers).toHaveLength(1);
  });

  it("omits databaseChanges when no schema-impact loader is wired (backward compatible)", async () => {
    const report = await getGapReport("an-1", {
      loadSnapshot: vi.fn().mockResolvedValue(snapshot()),
    });
    expect(report!.requirements[0]!.databaseChanges).toBeUndefined();
  });
});
