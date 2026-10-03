/**
 * #800 — the shared GitHub / Jira issue-creation ports, moved with their tests
 * out of the bug scanner's Prisma-adapter suite. The heavy modules (Octokit,
 * JiraClient, vault) are mocked so the suite stays a unit test.
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

const { buildSharedFindingPublisherPorts } = await import("./finding-publish-ports.js");
const { PublishError } = await import("./finding-publisher.js");

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildSharedFindingPublisherPorts.createJiraIssue", () => {
  const args = {
    projectId: "proj-1",
    title: "Null deref in foo",
    body: "Body",
    labels: ["bug", "metis-scanner"],
    severity: "high" as const,
  };

  it("throws ERR_JIRA_NOT_CONFIGURED when the project has no Jira connection configured", async () => {
    mockPrisma.project.findUnique.mockResolvedValue({
      jiraConnectionId: null,
      jiraProjectKey: null,
    });
    const ports = buildSharedFindingPublisherPorts();
    await expect(ports.createJiraIssue(args)).rejects.toMatchObject({
      code: "ERR_JIRA_NOT_CONFIGURED",
    });
    await expect(ports.createJiraIssue(args)).rejects.toBeInstanceOf(PublishError);
  });

  it("throws ERR_JIRA_NOT_CONFIGURED when the configured Jira connection is missing or disabled", async () => {
    mockPrisma.project.findUnique.mockResolvedValue({
      jiraConnectionId: "jira-1",
      jiraProjectKey: "PROJ",
    });
    mockPrisma.jiraConnection.findFirst.mockResolvedValue(null);
    const ports = buildSharedFindingPublisherPorts();
    await expect(ports.createJiraIssue(args)).rejects.toMatchObject({
      code: "ERR_JIRA_NOT_CONFIGURED",
    });
  });

  it("throws ERR_JIRA_NOT_CONFIGURED when the Jira connection is in error state", async () => {
    mockPrisma.project.findUnique.mockResolvedValue({
      jiraConnectionId: "jira-1",
      jiraProjectKey: "PROJ",
    });
    mockPrisma.jiraConnection.findFirst.mockResolvedValue({
      id: "jira-1",
      baseUrl: "https://example.atlassian.net",
      edition: "cloud",
      username: "u",
      secretId: "sec-1",
      tlsCaSecretId: null,
      proxyUrl: null,
      tlsRejectUnauthorized: true,
      status: "error",
    });
    const ports = buildSharedFindingPublisherPorts();
    await expect(ports.createJiraIssue(args)).rejects.toMatchObject({
      code: "ERR_JIRA_NOT_CONFIGURED",
    });
    await expect(ports.createJiraIssue(args)).rejects.toBeInstanceOf(PublishError);
  });

  it("creates a Jira issue via the client and returns external id + url", async () => {
    mockPrisma.project.findUnique.mockResolvedValue({
      jiraConnectionId: "jira-1",
      jiraProjectKey: "PROJ",
    });
    mockPrisma.jiraConnection.findFirst.mockResolvedValue({
      id: "jira-1",
      baseUrl: "https://example.atlassian.net",
      edition: "cloud",
      username: "u",
      secretId: "sec-1",
      tlsCaSecretId: null,
      proxyUrl: null,
      tlsRejectUnauthorized: true,
      status: "active",
    });
    const ports = buildSharedFindingPublisherPorts();
    const issue = await ports.createJiraIssue(args);
    expect(issue.externalId).toBe("PROJ-42");
    expect(issue.externalUrl).toContain("/browse/PROJ-42");
    expect(mockJiraCreateIssue).toHaveBeenCalledTimes(1);
    const fields = mockJiraCreateIssue.mock.calls[0][0];
    expect(fields.project).toEqual({ key: "PROJ" });
    expect(fields.issuetype).toEqual({ name: "Bug" });
    expect(fields.summary).toBe("Null deref in foo");
    expect(fields.labels).toEqual(expect.arrayContaining(["bug", "metis-scanner"]));
  });
});

// ----------------------------------------------------------------------------
// buildSharedFindingPublisherPorts.createGitHubIssue
// ----------------------------------------------------------------------------

describe("buildSharedFindingPublisherPorts.createGitHubIssue", () => {
  it("posts to the repo issues endpoint and returns external id + url", async () => {
    mockPrisma.repoConnection.findFirst.mockResolvedValue({
      id: "repo-1",
      ownerOrOrg: "o",
      repoName: "r",
      apiBaseUrl: "https://api.github.com",
      secretId: "sec-1",
      lastCommitSha: "abc",
    });
    const ports = buildSharedFindingPublisherPorts();
    const issue = await ports.createGitHubIssue({
      projectId: "proj-1",
      repoConnectionId: "repo-1",
      title: "T",
      body: "B",
      labels: ["bug"],
      target: { owner: "o", repo: "r" },
    });
    expect(issue.externalId).toBe("7");
    expect(issue.externalUrl).toBe("https://github.com/o/r/issues/7");
    // #480 — the token comes from the connector's bound id, never a label
    // lookup (PR #499 panel: both mocks returned the same value before).
    const { readBoundSecret, resolveVaultRef } = await import("../connectors/vault-resolver.js");
    expect(readBoundSecret).toHaveBeenCalledWith("sec-1", expect.anything());
    expect(resolveVaultRef).not.toHaveBeenCalled();
  });

  it("#733 — files into an explicit target with the connector's credential", async () => {
    mockPrisma.repoConnection.findFirst.mockResolvedValue({
      id: "repo-1",
      ownerOrOrg: "miniflux",
      repoName: "v2",
      apiBaseUrl: "https://api.github.com",
      secretId: "sec-1",
      lastCommitSha: "abc",
    });
    const { acquirePublishOctokit } = await import("./octokit-factory.js");
    const ports = buildSharedFindingPublisherPorts();
    await ports.createGitHubIssue({
      projectId: "proj-1",
      repoConnectionId: "repo-1",
      title: "T",
      body: "B",
      labels: [],
      target: { owner: "openzigs", repo: "flux-v2" },
    });
    const factory = vi.mocked(acquirePublishOctokit);
    const client = await factory.mock.results.at(-1)!.value;
    expect(factory.mock.calls.at(-1)![0]).toMatchObject({
      owner: "openzigs",
      token: expect.any(String),
    });
    expect(client.request.mock.calls.at(-1)[0].url).toBe("/repos/openzigs/flux-v2/issues");
  });

  it("#733 — refuses with no target instead of filing into the connector's repo", async () => {
    mockPrisma.repoConnection.findFirst.mockResolvedValue({
      id: "repo-1",
      ownerOrOrg: "o",
      repoName: "r",
      apiBaseUrl: "https://api.github.com",
      secretId: "sec-1",
      lastCommitSha: "abc",
    });
    const { acquirePublishOctokit } = await import("./octokit-factory.js");
    vi.mocked(acquirePublishOctokit).mockClear();
    const ports = buildSharedFindingPublisherPorts();
    await expect(
      ports.createGitHubIssue({
        projectId: "proj-1",
        repoConnectionId: "repo-1",
        title: "T",
        body: "B",
        labels: [],
      }),
    ).rejects.toMatchObject({ code: "ERR_NO_PUBLISH_TARGET" });
    expect(acquirePublishOctokit).not.toHaveBeenCalled();
  });

  it("throws when the repo connection is missing", async () => {
    mockPrisma.repoConnection.findFirst.mockResolvedValue(null);
    const ports = buildSharedFindingPublisherPorts();
    await expect(
      ports.createGitHubIssue({
        projectId: "proj-1",
        repoConnectionId: "missing",
        title: "T",
        body: "B",
        labels: [],
      }),
    ).rejects.toThrow(/repo connection .* not found/);
  });
});
