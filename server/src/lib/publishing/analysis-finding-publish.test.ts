/**
 * #800 — Deep Dive analysis-finding publishing, moved with its #733 tests out
 * of the bug scanner's Prisma-adapter suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks (must be declared before the import-under-test) ---------------

const mockPrisma = {
  repoConnection: { findFirst: vi.fn() },
  jiraConnection: { findFirst: vi.fn() },
  project: { findUnique: vi.fn() },
  scanFinding: { findUnique: vi.fn() },
  issueLink: { upsert: vi.fn(), findFirst: vi.fn() },
};
vi.mock("../prisma.js", () => ({ prisma: mockPrisma }));

vi.mock("../audit/audit-service.js", () => ({ audit: vi.fn() }));

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
});
