/**
 * #800 — Deep Dive analysis-finding publishing, moved with its #733 tests out
 * of the bug scanner's Prisma-adapter suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks (must be declared before the import-under-test) ---------------

const mockPrisma = {
  repoConnection: { findFirst: vi.fn() },
  // The #1180 cross-project guard's lookup; no other project by default.
  $queryRaw: vi.fn(async () => [] as unknown[]),
  jiraConnection: { findFirst: vi.fn() },
  project: { findUnique: vi.fn() },
  issueLink: { upsert: vi.fn(), findFirst: vi.fn() },
};
vi.mock("../prisma.js", () => ({ prisma: mockPrisma }));

const mockAudit = vi.fn();
vi.mock("../audit/audit-service.js", () => ({ audit: mockAudit }));

vi.mock("../connectors/vault-resolver.js", () => ({
  resolveVaultRef: vi.fn().mockResolvedValue("ghp_fake"),
  // #480 — the repo connector's secret is read by its bound id.
  readBoundSecret: vi.fn().mockResolvedValue("ghp_fake"),
}));
vi.mock("../vault/vault-service.js", () => ({
  getVaultService: vi.fn(() => ({
    read: vi.fn().mockResolvedValue({ plaintext: "jira-token" }),
  })),
}));
vi.mock("../connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn().mockResolvedValue(undefined),
}));

const mockJiraCreateIssue = vi.fn().mockResolvedValue({ key: "PROJ-42" });
vi.mock("../connectors/jira/jira-client.js", () => ({
  createJiraClient: vi.fn(() => ({ createIssue: mockJiraCreateIssue })),
}));

vi.mock("./octokit-factory.js", () => ({
  acquirePublishOctokit: vi.fn().mockResolvedValue({
    request: vi.fn().mockResolvedValue({
      data: { number: 7, html_url: "https://github.com/o/r/issues/7" },
    }),
  }),
}));

const { publishAnalysisFinding } = await import("./analysis-finding-publish.js");

afterEach(() => {
  vi.clearAllMocks();
});

describe("publishAnalysisFinding", () => {
  beforeEach(() => {
    // #733 — a saved GitHub publish target, unless a test says otherwise.
    mockPrisma.project.findUnique.mockResolvedValue({
      publishGithubOwner: "o",
      publishGithubRepo: "r",
    });
  });

  // #733 — the connector (`miniflux/v2`, the analysed upstream) is never filed into.
  function upstreamConnector() {
    mockPrisma.repoConnection.findFirst.mockResolvedValue({
      id: "repo-1",
      ownerOrOrg: "miniflux",
      repoName: "v2",
      apiBaseUrl: "https://api.github.com",
      secretId: "sec-1",
      lastCommitSha: "abc123",
    });
    mockPrisma.issueLink.findFirst.mockResolvedValue(null);
    mockPrisma.issueLink.upsert.mockImplementation(
      async (args: { create: Record<string, unknown> }) => ({ id: "L1", ...args.create }),
    );
  }

  const ANALYSIS_DRAFT = {
    title: "Error limit excludes failing feeds",
    problemStatement: "p",
    affected: { files: [], requirementIds: [] },
    acceptanceCriteria: [],
    suggestedLabels: [],
  };
  const analysisInput: Parameters<typeof publishAnalysisFinding>[0] = {
    projectId: "proj-1",
    analysisId: "ana-1",
    findingId: "fnd-1",
    agentKey: "code",
    severity: "high",
    category: "bug",
    draft: ANALYSIS_DRAFT,
    provider: "github",
  };

  it("#733 — an analysis re-publish with no target still returns the existing link", async () => {
    upstreamConnector();
    mockPrisma.project.findUnique.mockResolvedValue(null);
    mockPrisma.issueLink.findFirst.mockResolvedValue({
      id: "L7",
      findingId: "fnd-1",
      provider: "github",
      externalId: "77",
      externalUrl: "https://github.com/openzigs/flux-v2/issues/77",
    });
    const { acquirePublishOctokit } = await import("./octokit-factory.js");
    vi.mocked(acquirePublishOctokit).mockClear();
    const link = await publishAnalysisFinding(analysisInput);
    expect(link.externalId).toBe("77");
    expect(acquirePublishOctokit).not.toHaveBeenCalled();
  });

  it("#733 — a first analysis publish with no target refuses before any GitHub call", async () => {
    upstreamConnector();
    mockPrisma.project.findUnique.mockResolvedValue({
      publishGithubOwner: null,
      publishGithubRepo: null,
    });
    const { acquirePublishOctokit } = await import("./octokit-factory.js");
    vi.mocked(acquirePublishOctokit).mockClear();
    await expect(publishAnalysisFinding(analysisInput)).rejects.toMatchObject({
      code: "ERR_NO_PUBLISH_TARGET",
    });
    expect(acquirePublishOctokit).not.toHaveBeenCalled();
    expect(mockPrisma.issueLink.upsert).not.toHaveBeenCalled();
  });

  it("#802 — a GitHub publish is labelled metis-analysis, never metis-scanner", async () => {
    upstreamConnector();
    const { acquirePublishOctokit } = await import("./octokit-factory.js");
    const request = vi.fn().mockResolvedValue({
      data: { number: 7, html_url: "https://github.com/o/r/issues/7" },
    });
    vi.mocked(acquirePublishOctokit).mockResolvedValueOnce({ request } as never);
    await publishAnalysisFinding({
      ...analysisInput,
      draft: { ...ANALYSIS_DRAFT, suggestedLabels: ["bug"] },
    });
    const labels = (request.mock.calls[0][0] as { data: { labels: string[] } }).data.labels;
    expect(labels).toContain("metis");
    expect(labels).toContain("metis-analysis");
    expect(labels).not.toContain("metis-scanner");
    expect(labels).toContain("severity:high");
    expect(labels).toContain("category:bug");
    expect(labels).toContain("bug");
  });

  it("#802 — a Jira publish is labelled metis-analysis, never metis-scanner", async () => {
    mockPrisma.issueLink.findFirst.mockResolvedValue(null);
    mockPrisma.project.findUnique.mockResolvedValue({
      jiraConnectionId: "jc-1",
      jiraProjectKey: "IMP",
    });
    mockPrisma.jiraConnection.findFirst.mockResolvedValue({
      id: "jc-1",
      baseUrl: "https://jira.example.com",
      edition: "cloud",
      username: "svc",
      secretId: "sec-jira",
      status: "active",
      proxyUrl: null,
      tlsRejectUnauthorized: true,
      tlsCaSecretId: null,
    });
    mockPrisma.issueLink.upsert.mockImplementation(
      async (args: { create: Record<string, unknown> }) => ({ id: "L1", ...args.create }),
    );
    await publishAnalysisFinding({ ...analysisInput, provider: "jira" });
    const fields = mockJiraCreateIssue.mock.calls[0][0] as { labels: string[] };
    expect(fields.labels).toContain("metis");
    expect(fields.labels).toContain("metis-analysis");
    expect(fields.labels).not.toContain("metis-scanner");
    // #804 — the audit names the analysis finding, not a scan finding.
    expect(mockAudit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: "publish.jira.created",
        target: { type: "finding", id: analysisInput.findingId },
        metadata: expect.objectContaining({ source: "analysis", provider: "jira" }),
      }),
    );
  });

  it("#802 — hostile suggested and extra labels cannot claim another source", async () => {
    upstreamConnector();
    const { acquirePublishOctokit } = await import("./octokit-factory.js");
    const request = vi.fn().mockResolvedValue({
      data: { number: 7, html_url: "https://github.com/o/r/issues/7" },
    });
    vi.mocked(acquirePublishOctokit).mockResolvedValueOnce({ request } as never);
    await publishAnalysisFinding({
      ...analysisInput,
      draft: { ...ANALYSIS_DRAFT, suggestedLabels: ["metis-scanner", "bug"] },
      extraLabels: ["metis-impact-analysis", "metis"],
    });
    const labels = (request.mock.calls[0][0] as { data: { labels: string[] } }).data.labels;
    expect(labels.filter((l) => l.startsWith("metis"))).toEqual(["metis", "metis-analysis"]);
    expect(labels).toContain("bug");
  });

  it("#1276 — a suggested `unverified` label is not sent; the body says it in a sentence", async () => {
    upstreamConnector();
    const { acquirePublishOctokit } = await import("./octokit-factory.js");
    const request = vi.fn().mockResolvedValue({
      data: { number: 8, html_url: "https://github.com/o/r/issues/8" },
    });
    vi.mocked(acquirePublishOctokit).mockResolvedValueOnce({ request } as never);
    await publishAnalysisFinding({
      ...analysisInput,
      draft: { ...ANALYSIS_DRAFT, suggestedLabels: ["Unverified", "bug"] },
      extraLabels: ["unverified"],
    });
    const data = (request.mock.calls[0][0] as { data: { labels: string[]; body: string } }).data;
    expect(data.labels.map((l) => l.toLowerCase())).not.toContain("unverified");
    expect(data.labels).toContain("bug");
    expect(data.body).toContain(
      "METIS could not confirm the code references behind this item; check them before relying on them.",
    );
  });

  describe("#1180 — the cross-project guard", () => {
    it("refuses a GitHub target another project connects, before any GitHub call", async () => {
      upstreamConnector();
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ projectId: "proj-other" }]);
      const { acquirePublishOctokit } = await import("./octokit-factory.js");
      vi.mocked(acquirePublishOctokit).mockClear();
      await expect(publishAnalysisFinding(analysisInput)).rejects.toMatchObject({
        code: "REPO_CROSS_PROJECT",
        repo: "o/r",
        conflictingProjectIds: ["proj-other"],
      });
      // Bound values of the guard's tagged query: owner, repo, this project.
      expect(mockPrisma.$queryRaw.mock.calls[0].slice(1)).toEqual(["o", "r", "proj-1"]);
      expect(acquirePublishOctokit).not.toHaveBeenCalled();
      expect(mockPrisma.issueLink.upsert).not.toHaveBeenCalled();
    });

    it("publishes once confirmed, without the lookup", async () => {
      upstreamConnector();
      const link = await publishAnalysisFinding({ ...analysisInput, confirmCrossProject: true });
      expect(link.externalId).toBe("7");
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it("an already-published finding returns its link without the guard", async () => {
      upstreamConnector();
      mockPrisma.issueLink.findFirst.mockResolvedValue({
        id: "L7",
        findingId: "fnd-1",
        provider: "github",
        externalId: "77",
        externalUrl: "https://github.com/o/r/issues/77",
      });
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ projectId: "proj-other" }]);
      const link = await publishAnalysisFinding(analysisInput);
      expect(link.externalId).toBe("77");
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it("a Jira publish is not guarded (no GitHub target)", async () => {
      mockPrisma.issueLink.findFirst.mockResolvedValue(null);
      mockPrisma.project.findUnique.mockResolvedValue({
        jiraConnectionId: "jc-1",
        jiraProjectKey: "IMP",
      });
      mockPrisma.jiraConnection.findFirst.mockResolvedValue({
        id: "jc-1",
        baseUrl: "https://jira.example.com",
        edition: "cloud",
        username: "svc",
        secretId: "sec-jira",
        status: "active",
        proxyUrl: null,
        tlsRejectUnauthorized: true,
        tlsCaSecretId: null,
      });
      mockPrisma.issueLink.upsert.mockImplementation(
        async (args: { create: Record<string, unknown> }) => ({ id: "L1", ...args.create }),
      );
      await publishAnalysisFinding({ ...analysisInput, provider: "jira" });
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });
  });
});
