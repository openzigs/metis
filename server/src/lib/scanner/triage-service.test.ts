/** Epic #708 / Issue #714 — triage-service tests. */
import { describe, expect, it } from "vitest";
import {
  type ScanFindingForTriage,
  TriageError,
  applyTriageDecision,
  bulkApplyTriage,
} from "./triage-service.js";

function f(overrides: Partial<ScanFindingForTriage> = {}): ScanFindingForTriage {
  return {
    id: "sf-1",
    scanId: "scan-1",
    projectId: "p1",
    repoConnectionId: "r1",
    symbolId: "s1",
    qualifiedName: "src/foo.ts::bar",
    ruleId: "rule-1",
    title: "raw sql",
    body: "concat",
    severity: "high",
    category: "security",
    evidenceLines: [12, 13],
    filePath: "src/foo.ts",
    fingerprint: "fp",
    confidence: 0.9,
    triageStatus: "pending",
    materializedFindingId: null,
    ...overrides,
  };
}

describe("applyTriageDecision", () => {
  it("approves and produces a materialised finding payload", () => {
    const out = applyTriageDecision(f(), {
      scanFindingId: "sf-1",
      decision: "approved",
      actorId: "u-1",
      note: "ship it",
    });
    expect(out.newStatus).toBe("approved");
    expect(out.materialised).not.toBeNull();
    expect(out.materialised?.scanFindingId).toBe("sf-1");
    expect(out.materialised?.derivation).toBe("inferred");
    expect(out.auditMetadata.fingerprint).toBe("fp");
    expect(out.auditMetadata.note).toBe("ship it");
  });

  it("rejects without producing a materialised finding", () => {
    const out = applyTriageDecision(f(), {
      scanFindingId: "sf-1",
      decision: "rejected",
      actorId: "u-1",
    });
    expect(out.newStatus).toBe("rejected");
    expect(out.materialised).toBeNull();
  });

  it("defers transition", () => {
    const out = applyTriageDecision(f(), {
      scanFindingId: "sf-1",
      decision: "deferred",
      actorId: "u-1",
    });
    expect(out.newStatus).toBe("deferred");
  });

  it("rejects id mismatch", () => {
    expect(() =>
      applyTriageDecision(f(), { scanFindingId: "wrong", decision: "approved", actorId: "u-1" }),
    ).toThrow(TriageError);
  });

  it("rejects noop transition", () => {
    expect(() =>
      applyTriageDecision(f({ triageStatus: "approved" }), {
        scanFindingId: "sf-1",
        decision: "approved",
        actorId: "u-1",
      }),
    ).toThrow(/already in approved/);
  });

  it("refuses to re-approve a finding that is already materialised", () => {
    expect(() =>
      applyTriageDecision(f({ triageStatus: "rejected", materializedFindingId: "fnd-1" }), {
        scanFindingId: "sf-1",
        decision: "approved",
        actorId: "u-1",
      }),
    ).toThrow(/already materialised/);
  });
});

describe("bulkApplyTriage", () => {
  it("processes a mixed batch and reports per-finding outcomes", () => {
    const findings = [f({ id: "a" }), f({ id: "b", triageStatus: "approved" })];
    const decisions = [
      { scanFindingId: "a", decision: "approved" as const, actorId: "u" },
      { scanFindingId: "b", decision: "approved" as const, actorId: "u" }, // noop
      { scanFindingId: "missing", decision: "rejected" as const, actorId: "u" },
    ];
    const out = bulkApplyTriage(findings, decisions);
    expect(out[0].ok).toBe(true);
    expect(out[1].ok).toBe(false);
    expect(out[2].ok).toBe(false);
    if (!out[1].ok) expect(out[1].error).toBe("ERR_TRIAGE_NOOP");
    if (!out[2].ok) expect(out[2].error).toBe("ERR_SCAN_FINDING_NOT_FOUND");
  });
});
