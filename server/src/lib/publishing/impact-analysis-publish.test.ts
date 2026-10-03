/**
 * #800 — Impact Analysis → Jira publishing (Issue #963), moved with its tests
 * out of the bug scanner's Prisma-adapter suite.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

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

const { publishImpactAnalysisToJira } = await import("./impact-analysis-publish.js");
const { PublishError } = await import("./finding-publisher.js");

afterEach(() => {
  vi.clearAllMocks();
});

// ----------------------------------------------------------------------------
// publishImpactAnalysisToJira — Issue #963 (one Jira issue per impact run)
// ----------------------------------------------------------------------------

describe("publishImpactAnalysisToJira", () => {
  function configureJira() {
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
  }

  it("reuses an existing IssueLink and skips the Jira call (idempotent per run)", async () => {
    mockPrisma.issueLink.findFirst.mockResolvedValue({
      id: "L9",
      impactAnalysisId: "ia-1",
      provider: "jira",
      externalId: "IMP-7",
      externalUrl: "https://jira.example.com/browse/IMP-7",
    });
    const link = await publishImpactAnalysisToJira({
      analysisId: "ia-1",
      jiraProjectId: "proj-1",
      title: "Impact analysis: ia-1",
      body: "# Impact analysis\n\nbody",
    });
    expect(link.externalId).toBe("IMP-7");
    expect(mockPrisma.issueLink.findFirst).toHaveBeenCalledWith({
      where: { impactAnalysisId: "ia-1", provider: "jira" },
    });
    expect(mockJiraCreateIssue).not.toHaveBeenCalled();
    expect(mockPrisma.issueLink.upsert).not.toHaveBeenCalled();
  });

  it("creates a Jira issue + persists the IssueLink keyed on impactAnalysisId", async () => {
    mockPrisma.issueLink.findFirst.mockResolvedValue(null);
    configureJira();
    mockJiraCreateIssue.mockResolvedValue({ key: "IMP-42" });
    mockPrisma.issueLink.upsert.mockImplementation(
      async (args: { create: Record<string, unknown> }) => ({ id: "L1", ...args.create }),
    );

    const link = await publishImpactAnalysisToJira({
      analysisId: "ia-1",
      jiraProjectId: "proj-1",
      title: "Impact analysis: ia-1",
      body: "# Impact analysis\n\nbody",
      severity: "critical",
    });

    expect(mockJiraCreateIssue).toHaveBeenCalledTimes(1);
    expect(link.externalId).toBe("IMP-42");
    expect(link.externalUrl).toBe("https://jira.example.com/browse/IMP-42");
    // Idempotency is keyed on the impact-analysis compound unique.
    const upsertArg = mockPrisma.issueLink.upsert.mock.calls[0][0] as {
      where: { impactAnalysisId_provider: { impactAnalysisId: string; provider: string } };
      create: { impactAnalysisId: string; provider: string };
    };
    expect(upsertArg.where.impactAnalysisId_provider).toEqual({
      impactAnalysisId: "ia-1",
      provider: "jira",
    });
    expect(upsertArg.create.impactAnalysisId).toBe("ia-1");
  });

  it("surfaces ERR_JIRA_NOT_CONFIGURED when the target project has no Jira wiring", async () => {
    mockPrisma.issueLink.findFirst.mockResolvedValue(null);
    mockPrisma.project.findUnique.mockResolvedValue({
      jiraConnectionId: null,
      jiraProjectKey: null,
    });
    await expect(
      publishImpactAnalysisToJira({
        analysisId: "ia-1",
        jiraProjectId: "proj-1",
        title: "t",
        body: "b",
      }),
    ).rejects.toBeInstanceOf(PublishError);
  });

  it("#802 — carries metis + metis-impact-analysis exactly once and no other source label", async () => {
    mockPrisma.issueLink.findFirst.mockResolvedValue(null);
    configureJira();
    mockJiraCreateIssue.mockResolvedValue({ key: "IMP-43" });
    mockPrisma.issueLink.upsert.mockImplementation(
      async (args: { create: Record<string, unknown> }) => ({ id: "L1", ...args.create }),
    );
    await publishImpactAnalysisToJira({
      analysisId: "ia-2",
      jiraProjectId: "proj-1",
      title: "t",
      body: "b",
      extraLabels: ["metis-impact-analysis", "metis-scanner", "metis-analysis"],
    });
    const labels = (mockJiraCreateIssue.mock.calls[0][0] as { labels: string[] }).labels;
    expect(labels.filter((l) => l.startsWith("metis"))).toEqual(["metis", "metis-impact-analysis"]);
    expect(labels).toContain("severity:medium");
    expect(labels).toContain("category:impact-analysis");
  });
});
