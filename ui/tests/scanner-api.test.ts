/**
 * Issue #129 — scanner-api client unit tests.
 *
 * Mocks apiFetch and asserts URL / method / body for the rule-set, rule, scan,
 * and triage/publish wrappers, plus error propagation.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockApiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const { scannerApi } = await import("../src/lib/scanner-api");

beforeEach(() => mockApiFetch.mockReset());

describe("scannerApi", () => {
  it("listRuleSets fetches the rule-sets collection", async () => {
    mockApiFetch.mockResolvedValue([]);
    await scannerApi.listRuleSets("p1");
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/rule-sets");
  });

  it("createRuleSet POSTs the body", async () => {
    mockApiFetch.mockResolvedValue({ id: "rs1" });
    await scannerApi.createRuleSet("p1", { name: "Security", description: "d" });
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/rule-sets", {
      method: "POST",
      body: { name: "Security", description: "d" },
    });
  });

  it("createRule POSTs to the rules collection", async () => {
    mockApiFetch.mockResolvedValue({ id: "r1" });
    await scannerApi.createRule("p1", "rs1", { naturalLanguage: "no eval", severity: "high" });
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/rule-sets/rs1/rules", {
      method: "POST",
      body: { naturalLanguage: "no eval", severity: "high" },
    });
  });

  it("compileRule POSTs to the compile endpoint", async () => {
    mockApiFetch.mockResolvedValue({ id: "r1", status: "compiling" });
    await scannerApi.compileRule("p1", "rs1", "r1");
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/rule-sets/rs1/rules/r1/compile", {
      method: "POST",
    });
  });

  it("gradeRule POSTs exemplars", async () => {
    mockApiFetch.mockResolvedValue({ id: "r1" });
    const exemplars = [
      {
        codeSnippet: "x",
        language: "ts",
        expectedFinding: true,
        humanGrade: "true_positive" as const,
      },
    ];
    await scannerApi.gradeRule("p1", "rs1", "r1", { exemplars });
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/rule-sets/rs1/rules/r1/grade", {
      method: "POST",
      body: { exemplars },
    });
  });

  it("startScan POSTs to the repo scans endpoint", async () => {
    mockApiFetch.mockResolvedValue({ id: "s1" });
    await scannerApi.startScan("p1", "rc1", { mode: "both", budgetCapTokens: 1000 });
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/repositories/rc1/scans", {
      method: "POST",
      body: { mode: "both", budgetCapTokens: 1000 },
    });
  });

  it("listProjectScans fetches the cross-repo scans", async () => {
    mockApiFetch.mockResolvedValue([]);
    await scannerApi.listProjectScans("p1");
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/scans");
  });

  it("listScans fetches repo scans", async () => {
    mockApiFetch.mockResolvedValue([]);
    await scannerApi.listScans("p1", "rc1");
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/repositories/rc1/scans");
  });

  it("getIndexStatus fetches the index-status gate", async () => {
    mockApiFetch.mockResolvedValue({ indexed: true });
    await scannerApi.getIndexStatus("p1", "rc1");
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/repositories/rc1/scans/index-status");
  });

  it("getScan fetches a single scan", async () => {
    mockApiFetch.mockResolvedValue({ id: "s1" });
    await scannerApi.getScan("p1", "s1");
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/scans/s1");
  });

  it("listFindings fetches findings for a scan", async () => {
    mockApiFetch.mockResolvedValue([]);
    await scannerApi.listFindings("p1", "s1");
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/scans/s1/findings");
  });

  it("triage POSTs the decision", async () => {
    mockApiFetch.mockResolvedValue({ scanFindingId: "f1", newStatus: "approved" });
    await scannerApi.triage("p1", "s1", "f1", { decision: "approved", note: "ok" });
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/scans/s1/findings/f1/triage", {
      method: "POST",
      body: { decision: "approved", note: "ok" },
    });
  });

  it("publish POSTs the provider", async () => {
    mockApiFetch.mockResolvedValue({ id: "il1" });
    await scannerApi.publish("p1", "s1", "f1", { provider: "github", extraLabels: ["bug"] });
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/scans/s1/findings/f1/publish", {
      method: "POST",
      body: { provider: "github", extraLabels: ["bug"] },
    });
  });

  it("propagates errors from apiFetch", async () => {
    mockApiFetch.mockRejectedValueOnce(new Error("boom"));
    await expect(scannerApi.getScan("p1", "s1")).rejects.toThrow("boom");
  });
});
