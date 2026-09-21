/**
 * Tests for the Deep Dive → Issue analysis API client methods (Epic #176 / #180).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockApiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import { analysisApi, type FindingIssueDraft } from "@/lib/analysis-api";

beforeEach(() => vi.clearAllMocks());

const DRAFT: FindingIssueDraft = {
  title: "Add audit logging",
  problemStatement: "Mutations are not audited.",
  affected: { files: ["src/routes/users.ts"], requirementIds: ["REQ-1"] },
  acceptanceCriteria: ["Every mutation writes an AuditLog row"],
  suggestedLabels: ["security"],
};

describe("analysisApi deep dive → issue", () => {
  it("deepDiveFinding POSTs to the scoped deep-dive path with the body", async () => {
    mockApiFetch.mockResolvedValueOnce({ draft: DRAFT, meta: { tokensUsed: 180, model: "haiku" } });

    const res = await analysisApi.deepDiveFinding("proj_1", "ana_1", "find_1", {
      instructions: "focus on GDPR",
    });

    expect(mockApiFetch).toHaveBeenCalledWith(
      "/projects/proj_1/analyses/ana_1/findings/find_1/deep-dive",
      { method: "POST", body: { instructions: "focus on GDPR" } },
    );
    expect(res.draft.title).toBe("Add audit logging");
    expect(res.meta.tokensUsed).toBe(180);
  });

  it("deepDiveFinding defaults to an empty body", async () => {
    mockApiFetch.mockResolvedValueOnce({ draft: DRAFT, meta: { tokensUsed: 0, model: "haiku" } });

    await analysisApi.deepDiveFinding("proj_1", "ana_1", "find_1");

    expect(mockApiFetch).toHaveBeenCalledWith(
      "/projects/proj_1/analyses/ana_1/findings/find_1/deep-dive",
      { method: "POST", body: {} },
    );
  });

  it("publishFinding POSTs the draft to the scoped publish path", async () => {
    mockApiFetch.mockResolvedValueOnce({
      links: [{ provider: "github", url: "https://gh/issues/1", issueKey: "1" }],
    });

    const res = await analysisApi.publishFinding("proj_1", "ana_1", "find_1", {
      draft: DRAFT,
      extraLabels: ["triaged"],
    });

    expect(mockApiFetch).toHaveBeenCalledWith(
      "/projects/proj_1/analyses/ana_1/findings/find_1/publish",
      { method: "POST", body: { draft: DRAFT, extraLabels: ["triaged"] } },
    );
    expect(res.links).toHaveLength(1);
    expect(res.links[0].provider).toBe("github");
  });

  it("publishFinding forwards an explicit provider override", async () => {
    mockApiFetch.mockResolvedValueOnce({ links: [] });

    await analysisApi.publishFinding("proj_1", "ana_1", "find_1", {
      provider: "jira",
      draft: DRAFT,
    });

    expect(mockApiFetch).toHaveBeenCalledWith(
      "/projects/proj_1/analyses/ana_1/findings/find_1/publish",
      { method: "POST", body: { provider: "jira", draft: DRAFT } },
    );
  });
});
