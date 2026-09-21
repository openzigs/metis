/**
 * Epic #708 follow-up — prisma-adapter coverage.
 *
 * These tests exercise the adapter layer that wires the pure scanner
 * pipeline to Prisma + filesystem + the LLM/Octokit/Jira providers. The
 * heavy modules (provider, Octokit, JiraClient, repo clone) are mocked
 * so the suite stays a unit test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
// #1330 — the Finding create payload is validated against the REAL schema,
// not against a hand-written stub that resolves for anything.
import {
  makeValidatingCreateFake,
  parsePrismaModel,
  readSchemaText,
} from "../../../tests/lib/db/prisma-model-schema.js";
import type { MaterialisedFindingInput } from "./triage-service.js";

// ---- Mocks (must be declared before the import-under-test) ---------------

const mockPrisma = {
  codeEdge: { findMany: vi.fn() },
  codeGraph: { findFirst: vi.fn() },
  codeSymbol: { findMany: vi.fn() },
  ruleSet: { findMany: vi.fn() },
  scan: { findUnique: vi.fn() },
  repoConnection: { findFirst: vi.fn() },
  jiraConnection: { findFirst: vi.fn() },
  project: { findUnique: vi.fn() },
  scanFinding: { findUnique: vi.fn(), update: vi.fn() },
  issueLink: { upsert: vi.fn(), findFirst: vi.fn() },
  finding: { create: vi.fn() },
  document: { findMany: vi.fn() },
  $transaction: vi.fn(),
};
vi.mock("../prisma.js", () => ({ prisma: mockPrisma }));

vi.mock("../audit/audit-service.js", () => ({ audit: vi.fn() }));

vi.mock("../ai/index.js", () => ({
  buildProvider: vi.fn(() => ({ chat: vi.fn() })),
  loadAIConfig: vi.fn(() => ({})),
}));
vi.mock("../ai/model-router.js", () => ({
  HAIKU_MODEL_ID: "haiku",
  SONNET_MODEL_ID: "sonnet",
}));

vi.mock("../connectors/repo/repo-service.js", () => ({
  pullOrCloneRepo: vi.fn().mockResolvedValue({ path: "/tmp/fake-repo" }),
}));

vi.mock("../connectors/vault-resolver.js", () => ({
  resolveVaultRef: vi.fn().mockResolvedValue("ghp_fake"),
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

const mockKnowledgeSearch = vi.fn();
vi.mock("../rag/knowledge-service.js", () => ({
  getKnowledgeService: vi.fn(() => ({ search: mockKnowledgeSearch })),
}));

vi.mock("../publishing/octokit-factory.js", () => ({
  acquirePublishOctokit: vi.fn().mockResolvedValue({
    request: vi.fn().mockResolvedValue({
      data: { number: 7, html_url: "https://github.com/o/r/issues/7" },
    }),
  }),
}));

// node:fs is used by readSymbolSlice — return predictable content.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      readFile: vi.fn().mockResolvedValue("line1\nline2\nline3\nline4\nline5\n"),
    },
  };
});

const {
  buildScannerPorts,
  buildPublisherPorts,
  loadNeighboursForScan,
  loadRagHitsForScan,
  publishScanFinding,
  publishImpactAnalysisToJira,
  materializeTriagedFinding,
} = await import("./prisma-adapter.js");
const { PublishError } = await import("./finding-publisher.js");

afterEach(() => {
  vi.clearAllMocks();
});

// ----------------------------------------------------------------------------
// loadNeighboursForScan — production 1-hop wiring + project isolation
// ----------------------------------------------------------------------------

describe("loadNeighboursForScan", () => {
  const scan = {
    id: "scan-1",
    projectId: "proj-1",
    repoConnectionId: "repo-1",
    createdById: "user-1",
  };

  it("returns empty when both directions have zero edges", async () => {
    mockPrisma.codeEdge.findMany.mockResolvedValue([]);
    const result = await loadNeighboursForScan(scan, "sym-1");
    expect(result).toEqual([]);
  });

  it("scopes both queries by projectId AND repoConnectionId (no cross-project leakage)", async () => {
    mockPrisma.codeEdge.findMany.mockResolvedValue([]);
    await loadNeighboursForScan(scan, "sym-1");
    // Two queries — one outgoing (fromSymbolId), one incoming (toSymbolId).
    expect(mockPrisma.codeEdge.findMany).toHaveBeenCalledTimes(2);
    for (const call of mockPrisma.codeEdge.findMany.mock.calls) {
      const where = call[0]?.where;
      expect(where?.projectId).toBe("proj-1");
      expect(where?.graph?.repoConnectionId).toBe("repo-1");
    }
  });

  it("populates callees from outgoing edges and callers from incoming edges", async () => {
    mockPrisma.codeEdge.findMany
      // Outgoing — callees
      .mockResolvedValueOnce([
        {
          id: "e1",
          toSymbol: {
            id: "callee-1",
            qualifiedName: "lib/foo.ts::callee",
            filePath: "lib/foo.ts",
            startLine: 1,
            endLine: 2,
            language: "ts",
            kind: "function",
          },
        },
      ])
      // Incoming — callers
      .mockResolvedValueOnce([
        {
          id: "e2",
          fromSymbol: {
            id: "caller-1",
            qualifiedName: "lib/bar.ts::caller",
            filePath: "lib/bar.ts",
            startLine: 3,
            endLine: 4,
            language: "ts",
            kind: "function",
          },
        },
      ]);
    const result = await loadNeighboursForScan(scan, "sym-1");
    expect(result).toHaveLength(2);
    expect(result.find((n) => n.qualifiedName === "lib/foo.ts::callee")?.relation).toBe("callee");
    expect(result.find((n) => n.qualifiedName === "lib/bar.ts::caller")?.relation).toBe("caller");
    // Snippets were read from disk.
    for (const n of result) {
      expect(typeof n.snippet).toBe("string");
      expect(n.snippet.length).toBeGreaterThan(0);
    }
  });

  it("skips edges whose joined symbol is missing (unresolved external)", async () => {
    mockPrisma.codeEdge.findMany
      .mockResolvedValueOnce([{ id: "e1", toSymbol: null }])
      .mockResolvedValueOnce([]);
    const result = await loadNeighboursForScan(scan, "sym-1");
    expect(result).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// loadRagHitsForScan — project-scoped retrieval
// ----------------------------------------------------------------------------

describe("loadRagHitsForScan", () => {
  const scan = {
    id: "scan-1",
    projectId: "proj-1",
    repoConnectionId: "repo-1",
    createdById: "user-1",
  };

  it("returns empty when the query reduces to whitespace", async () => {
    const result = await loadRagHitsForScan(scan, { qualifiedName: "", body: "" });
    expect(result).toEqual([]);
    expect(mockKnowledgeSearch).not.toHaveBeenCalled();
  });

  it("calls knowledge.search with the scan's projectId (per-project isolation)", async () => {
    mockKnowledgeSearch.mockResolvedValue({ hits: [], mode: "hybrid" });
    await loadRagHitsForScan(scan, { qualifiedName: "lib/foo.ts::bar", body: "console.log(x)" });
    expect(mockKnowledgeSearch).toHaveBeenCalledTimes(1);
    const [calledProjectId, calledQuery, opts] = mockKnowledgeSearch.mock.calls[0];
    expect(calledProjectId).toBe("proj-1");
    expect(calledQuery).toContain("lib/foo.ts::bar");
    expect(opts).toMatchObject({ k: expect.any(Number) });
  });

  it("maps hits to AssembledRagHit shape and truncates snippets", async () => {
    mockKnowledgeSearch.mockResolvedValue({
      hits: [
        {
          chunkId: "c1",
          documentId: "d1",
          filename: "guide.md",
          position: 3,
          text: "x".repeat(5000),
          score: 0.42,
          embeddingModel: "m",
        },
      ],
      mode: "hybrid",
    });
    const result = await loadRagHitsForScan(scan, {
      qualifiedName: "x",
      body: "y",
    });
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("guide.md#3");
    expect(result[0].snippet.length).toBeLessThanOrEqual(900);
  });

  it("swallows search failures and returns empty (best-effort retrieval)", async () => {
    mockKnowledgeSearch.mockRejectedValue(new Error("vector store down"));
    const result = await loadRagHitsForScan(scan, { qualifiedName: "x", body: "y" });
    expect(result).toEqual([]);
  });

  // ── #885: spec-mode retrieval is constrained to spec-tagged documents ────
  describe("spec mode (specOnly, #885)", () => {
    it("does NOT pass documentIds when specOnly is false/absent", async () => {
      mockKnowledgeSearch.mockResolvedValue({ hits: [], mode: "hybrid" });
      await loadRagHitsForScan(scan, { qualifiedName: "x", body: "y" });
      expect(mockPrisma.document.findMany).not.toHaveBeenCalled();
      const opts = mockKnowledgeSearch.mock.calls[0][2];
      expect(opts.documentIds).toBeUndefined();
    });

    it("constrains retrieval to indexed spec documents via documentIds", async () => {
      mockPrisma.document.findMany.mockResolvedValue([{ id: "spec-1" }, { id: "spec-2" }]);
      mockKnowledgeSearch.mockResolvedValue({ hits: [], mode: "hybrid" });
      await loadRagHitsForScan(scan, { qualifiedName: "x", body: "y" }, { specOnly: true });
      // Only indexed, non-deleted spec docs for THIS project are eligible.
      const where = mockPrisma.document.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        projectId: "proj-1",
        isSpec: true,
        deletedAt: null,
        indexState: "indexed",
      });
      const opts = mockKnowledgeSearch.mock.calls[0][2];
      expect(opts.documentIds).toEqual(["spec-1", "spec-2"]);
    });

    it("returns empty (explicit no-spec signal) when the project has no spec docs", async () => {
      mockPrisma.document.findMany.mockResolvedValue([]);
      const result = await loadRagHitsForScan(
        scan,
        { qualifiedName: "x", body: "y" },
        { specOnly: true },
      );
      expect(result).toEqual([]);
      // Crucially: it does NOT fall through to an unfiltered search.
      expect(mockKnowledgeSearch).not.toHaveBeenCalled();
    });
  });
});

// ----------------------------------------------------------------------------
// buildPublisherPorts — production Jira/GitHub wiring
// ----------------------------------------------------------------------------

describe("buildPublisherPorts.currentRepoCommitSha", () => {
  it("returns null when the repo connection has no last commit SHA", async () => {
    mockPrisma.repoConnection.findFirst.mockResolvedValue({ lastCommitSha: null });
    const ports = buildPublisherPorts();
    const sha = await ports.currentRepoCommitSha("proj-1", "repo-1");
    expect(sha).toBeNull();
  });

  it("returns null when the repo connection row is missing entirely", async () => {
    mockPrisma.repoConnection.findFirst.mockResolvedValue(null);
    const ports = buildPublisherPorts();
    const sha = await ports.currentRepoCommitSha("proj-1", "repo-1");
    expect(sha).toBeNull();
  });

  it("returns the captured SHA when present", async () => {
    mockPrisma.repoConnection.findFirst.mockResolvedValue({ lastCommitSha: "abc123" });
    const ports = buildPublisherPorts();
    const sha = await ports.currentRepoCommitSha("proj-1", "repo-1");
    expect(sha).toBe("abc123");
  });
});

describe("buildPublisherPorts.createJiraIssue", () => {
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
    const ports = buildPublisherPorts();
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
    const ports = buildPublisherPorts();
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
    const ports = buildPublisherPorts();
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
    const ports = buildPublisherPorts();
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
// buildScannerPorts.runFirstPass — assembles real neighbours + RAG
// ----------------------------------------------------------------------------

describe("buildScannerPorts.runFirstPass", () => {
  it("invokes loadNeighboursForScan + loadRagHitsForScan with scan/project context", async () => {
    // Both loaders read from prisma.codeEdge / knowledge service — assert
    // they were called with the scan's projectId.
    mockPrisma.codeEdge.findMany.mockResolvedValue([]);
    mockKnowledgeSearch.mockResolvedValue({ hits: [], mode: "hybrid" });

    // Stub scanSymbol indirectly: the underlying provider returns no
    // candidates, so we only need to assert the prisma/knowledge wiring fires.
    const ports = buildScannerPorts();
    const scan = {
      id: "scan-1",
      projectId: "proj-1",
      repoConnectionId: "repo-1",
      commitSha: "abc",
      mode: "both" as const,
      budgetCapTokens: 100_000,
      createdById: "user-1",
    };
    const symbol = {
      id: "sym-1",
      qualifiedName: "lib/foo.ts::bar",
      kind: "function",
      language: "ts",
      filePath: "lib/foo.ts",
      startLine: 1,
      endLine: 2,
    };
    // scanSymbol path will throw because the mocked provider has no chat
    // implementation — that's fine for this test, we only care that the
    // adapter reached the loaders before delegating. Wrap in expect().rejects
    // so the test still passes if the LLM stub rejects.
    await ports
      .runFirstPass({
        scan,
        symbol,
        body: "function bar() { return null; }",
        ruleInstructions: "",
        signal: new AbortController().signal,
      })
      .catch(() => {
        /* provider not wired in this unit test */
      });

    // The neighbour query MUST have been issued and scoped to proj-1.
    expect(mockPrisma.codeEdge.findMany).toHaveBeenCalled();
    for (const call of mockPrisma.codeEdge.findMany.mock.calls) {
      expect(call[0]?.where?.projectId).toBe("proj-1");
    }
    // The RAG search MUST have been issued and scoped to proj-1.
    expect(mockKnowledgeSearch).toHaveBeenCalled();
    expect(mockKnowledgeSearch.mock.calls[0][0]).toBe("proj-1");
  });
});

// ----------------------------------------------------------------------------
// buildPublisherPorts.createGitHubIssue
// ----------------------------------------------------------------------------

describe("buildPublisherPorts.createGitHubIssue", () => {
  it("posts to the repo issues endpoint and returns external id + url", async () => {
    mockPrisma.repoConnection.findFirst.mockResolvedValue({
      id: "repo-1",
      ownerOrOrg: "o",
      repoName: "r",
      apiBaseUrl: "https://api.github.com",
      secretId: "sec-1",
      lastCommitSha: "abc",
    });
    const ports = buildPublisherPorts();
    const issue = await ports.createGitHubIssue({
      projectId: "proj-1",
      repoConnectionId: "repo-1",
      title: "T",
      body: "B",
      labels: ["bug"],
    });
    expect(issue.externalId).toBe("7");
    expect(issue.externalUrl).toBe("https://github.com/o/r/issues/7");
  });

  it("throws when the repo connection is missing", async () => {
    mockPrisma.repoConnection.findFirst.mockResolvedValue(null);
    const ports = buildPublisherPorts();
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

// ----------------------------------------------------------------------------
// publishScanFinding — end-to-end wiring with mocked Prisma
// ----------------------------------------------------------------------------

describe("publishScanFinding", () => {
  function scanFindingRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "sf-1",
      fingerprint: "abc-fp",
      scanId: "scan-1",
      title: "Null deref",
      body: "Some body",
      severity: "high",
      category: "security",
      ruleId: "rule-1",
      evidenceLines: "[1,2]",
      scan: {
        projectId: "proj-1",
        repoConnectionId: "repo-1",
        commitSha: "abc123",
      },
      symbol: { qualifiedName: "lib/foo.ts::bar", filePath: "lib/foo.ts" },
      ...overrides,
    };
  }

  it("throws when the scan finding row is missing", async () => {
    mockPrisma.scanFinding.findUnique.mockResolvedValue(null);
    await expect(
      publishScanFinding({ scanFindingId: "missing", provider: "github" }),
    ).rejects.toThrow(/scan finding .* not found/);
  });

  it("reuses an existing IssueLink and skips provider call (idempotent)", async () => {
    mockPrisma.scanFinding.findUnique.mockResolvedValue(scanFindingRow());
    mockPrisma.repoConnection.findFirst.mockResolvedValue({
      id: "repo-1",
      ownerOrOrg: "o",
      repoName: "r",
      apiBaseUrl: "https://api.github.com",
      secretId: "sec-1",
      lastCommitSha: "abc123",
    });
    mockPrisma.issueLink.findFirst.mockResolvedValue({
      id: "L1",
      scanFindingId: "sf-1",
      provider: "github",
      externalId: "999",
      externalUrl: "https://github.com/o/r/issues/999",
    });
    const link = await publishScanFinding({
      scanFindingId: "sf-1",
      provider: "github",
    });
    expect(link.externalId).toBe("999");
    expect(mockPrisma.issueLink.upsert).not.toHaveBeenCalled();
  });

  it("creates an issue + persists IssueLink when no prior link exists", async () => {
    mockPrisma.scanFinding.findUnique.mockResolvedValue(scanFindingRow());
    mockPrisma.repoConnection.findFirst.mockResolvedValue({
      id: "repo-1",
      ownerOrOrg: "o",
      repoName: "r",
      apiBaseUrl: "https://api.github.com",
      secretId: "sec-1",
      lastCommitSha: "abc123",
    });
    mockPrisma.issueLink.findFirst.mockResolvedValue(null);
    mockPrisma.issueLink.upsert.mockImplementation(
      async (args: { create: Record<string, unknown> }) => ({
        id: "L1",
        ...args.create,
      }),
    );
    const link = await publishScanFinding({
      scanFindingId: "sf-1",
      provider: "github",
    });
    expect(link.externalId).toBe("7");
    expect(mockPrisma.issueLink.upsert).toHaveBeenCalledTimes(1);
  });

  it("rejects when scan commit SHA is empty (stale-gate)", async () => {
    mockPrisma.scanFinding.findUnique.mockResolvedValue(
      scanFindingRow({ scan: { projectId: "proj-1", repoConnectionId: "repo-1", commitSha: "" } }),
    );
    mockPrisma.repoConnection.findFirst.mockResolvedValue({
      id: "repo-1",
      lastCommitSha: "",
    });
    mockPrisma.issueLink.findFirst.mockResolvedValue(null);
    await expect(
      publishScanFinding({ scanFindingId: "sf-1", provider: "github" }),
    ).rejects.toMatchObject({ code: "ERR_STALE_COMMIT" });
  });

  it("falls back to evidenceLines=[] when the stored JSON is malformed", async () => {
    mockPrisma.scanFinding.findUnique.mockResolvedValue(
      scanFindingRow({ evidenceLines: "not-json" }),
    );
    mockPrisma.repoConnection.findFirst.mockResolvedValue({
      id: "repo-1",
      ownerOrOrg: "o",
      repoName: "r",
      apiBaseUrl: "https://api.github.com",
      secretId: "sec-1",
      lastCommitSha: "abc123",
    });
    mockPrisma.issueLink.findFirst.mockResolvedValue(null);
    mockPrisma.issueLink.upsert.mockImplementation(async () => ({
      id: "L1",
      scanFindingId: "sf-1",
      provider: "github",
      externalId: "7",
      externalUrl: "https://github.com/o/r/issues/7",
    }));
    const link = await publishScanFinding({
      scanFindingId: "sf-1",
      provider: "github",
    });
    expect(link.externalId).toBe("7");
  });
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
});

// ----------------------------------------------------------------------------
// materializeTriagedFinding — gated Finding row creation
// ----------------------------------------------------------------------------

describe("materializeTriagedFinding", () => {
  const findingFields = parsePrismaModel(readSchemaText(), "Finding");

  /** The payload `applyTriageDecision` hands the adapter for an approval. */
  function materialisedInput(
    overrides: Partial<MaterialisedFindingInput> = {},
  ): MaterialisedFindingInput {
    return {
      projectId: "proj-1",
      symbolId: "sym-1",
      title: "T",
      body: "B",
      severity: "high",
      category: "security",
      evidenceLines: [12, 40],
      filePath: "src/a.ts",
      scanFindingId: "sf-1",
      derivation: "inferred",
      confidence: 0.82,
      ...overrides,
    };
  }

  /**
   * #1330 — `tx.finding.create` is a fake DERIVED FROM `schema.prisma`, not a
   * bare `vi.fn()`. The previous version of this suite asserted
   * `expect(tx.finding.create).toHaveBeenCalledTimes(1)` against a stub that
   * resolved for any payload, which is why a create naming five nonexistent
   * columns passed for eight months. Renaming a column in the adapter's payload
   * now fails here the way the real client fails in production.
   */
  function setupTx(rowOverrides: Record<string, unknown> = {}) {
    const sfRow = {
      id: "sf-1",
      materializedFindingId: null as string | null,
      ...rowOverrides,
    };
    const tx = {
      scanFinding: {
        findUnique: vi.fn().mockResolvedValue(sfRow),
        update: vi.fn().mockResolvedValue({}),
      },
      finding: {
        create: makeValidatingCreateFake(findingFields, {
          modelName: "Finding",
          returnId: "find-1",
        }),
      },
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
    return tx;
  }

  it("returns undefined and skips Finding creation when not approved", async () => {
    const tx = setupTx();
    const result = await materializeTriagedFinding({
      scanFindingId: "sf-1",
      triagedById: "user-1",
      triageStatus: "rejected",
      materialised: null,
    });
    expect(result.findingId).toBeUndefined();
    expect(tx.finding.create.calls).toHaveLength(0);
    expect(tx.scanFinding.update).toHaveBeenCalledTimes(1); // only the triage stamp
  });

  it("writes a payload the real Finding model accepts, and links it back to the scan finding", async () => {
    const tx = setupTx();
    const result = await materializeTriagedFinding({
      scanFindingId: "sf-1",
      triagedById: "user-1",
      triageStatus: "approved",
      triageNote: "Looks real",
      materialised: materialisedInput(),
    });

    expect(result.findingId).toBe("find-1");
    expect(tx.finding.create.calls).toHaveLength(1);
    const data = tx.finding.create.calls[0];

    // Provenance (ADR 0011): no synthetic AgentResult; the back-link instead.
    expect(data.agentResultId).toBeNull();
    expect(data.scanFindingId).toBe("sf-1");
    // Sourced from applyTriageDecision's payload, not rebuilt from the row.
    expect(data.title).toBe("T");
    expect(data.body).toBe("B");
    expect(data.severity).toBe("high");
    expect(data.category).toBe("security");
    expect(data.symbolId).toBe("sym-1");
    // #1325 provenance invariant.
    expect(data.derivation).toBe("inferred");
    expect(data.confidence).toBe(0.82);
    // The evidence blob is readable by the analysis pipeline's parseEvidence.
    expect(JSON.parse(String(data.evidence))).toEqual({
      citations: [{ filePath: "src/a.ts", startLine: 12, endLine: 40, symbolId: "sym-1" }],
      tags: [],
      requirementId: null,
      verdict: null,
    });
    // The materializedFindingId back-pointer is set.
    expect(tx.scanFinding.update).toHaveBeenCalledTimes(2);
    expect(tx.scanFinding.update.mock.calls[1][0]).toMatchObject({
      data: { materializedFindingId: "find-1" },
    });
  });

  it("writes no citation when the scan finding has no file path or no evidence lines", async () => {
    const tx = setupTx();
    await materializeTriagedFinding({
      scanFindingId: "sf-1",
      triagedById: "user-1",
      triageStatus: "approved",
      materialised: materialisedInput({ filePath: "", evidenceLines: [] }),
    });
    expect(JSON.parse(String(tx.finding.create.calls[0].evidence)).citations).toEqual([]);
  });

  it("omits symbolId rather than writing an empty string when the finding has no symbol", async () => {
    const tx = setupTx();
    await materializeTriagedFinding({
      scanFindingId: "sf-1",
      triagedById: "user-1",
      triageStatus: "approved",
      materialised: materialisedInput({ symbolId: "" }),
    });
    expect(tx.finding.create.calls[0].symbolId).toBeNull();
  });

  it("returns the existing Finding id when one is already materialised (idempotent)", async () => {
    const tx = setupTx({ materializedFindingId: "find-prev" });
    const result = await materializeTriagedFinding({
      scanFindingId: "sf-1",
      triagedById: "user-1",
      triageStatus: "approved",
      materialised: materialisedInput(),
    });
    expect(result.findingId).toBe("find-prev");
    expect(tx.finding.create.calls).toHaveLength(0);
  });

  it("THROWS instead of reporting success when an approval arrives with no payload", async () => {
    // #1330's third defeated guard: `if (!findingDelegate) return { findingId:
    // undefined }` made a total failure look like a rejected triage to the
    // route, which answered `200 {materializedFindingId: null}`. Absence must
    // never read as success.
    setupTx();
    await expect(
      materializeTriagedFinding({
        scanFindingId: "sf-1",
        triagedById: "user-1",
        triageStatus: "approved",
        materialised: null,
      }),
    ).rejects.toThrow(/approved triage requires a MaterialisedFindingInput/);
  });

  it("does not stamp the triage when the approval payload is missing", async () => {
    const tx = setupTx();
    await expect(
      materializeTriagedFinding({
        scanFindingId: "sf-1",
        triagedById: "user-1",
        triageStatus: "approved",
        materialised: null,
      }),
    ).rejects.toThrow();
    // The guard runs BEFORE the transaction, so nothing is written and rolled
    // back — the rollback is what destroyed the reviewer's decision in #1330.
    expect(tx.scanFinding.update).not.toHaveBeenCalled();
  });

  it("throws when the scan finding row is missing", async () => {
    const tx = {
      scanFinding: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
      },
      finding: { create: makeValidatingCreateFake(findingFields, { modelName: "Finding" }) },
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
    await expect(
      materializeTriagedFinding({
        scanFindingId: "missing",
        triagedById: "user-1",
        triageStatus: "approved",
        materialised: materialisedInput(),
      }),
    ).rejects.toThrow(/scan finding .* not found/);
  });
});

// ----------------------------------------------------------------------------
// buildScannerPorts — thin Prisma wrappers (branch coverage uplift)
// ----------------------------------------------------------------------------

describe("buildScannerPorts wrappers", () => {
  it("loadScan returns mapped row or null", async () => {
    mockPrisma.scan.findUnique.mockResolvedValueOnce(null);
    const ports = buildScannerPorts();
    expect(await ports.loadScan("missing")).toBeNull();

    mockPrisma.scan.findUnique.mockResolvedValueOnce({
      id: "scan-1",
      projectId: "p",
      repoConnectionId: "r",
      commitSha: "abc",
      mode: "both",
      budgetCapTokens: 100,
      createdById: "u",
    });
    const row = await ports.loadScan("scan-1");
    expect(row).toMatchObject({ id: "scan-1", mode: "both" });
  });

  it("graphCommitSha returns null when no graph exists", async () => {
    mockPrisma.codeGraph.findFirst.mockResolvedValue(null);
    const ports = buildScannerPorts();
    expect(await ports.graphCommitSha("p", "r")).toBeNull();
  });

  it("graphCommitSha returns the latest graph's commit SHA when present", async () => {
    mockPrisma.codeGraph.findFirst.mockResolvedValue({ commitSha: "abc" });
    const ports = buildScannerPorts();
    expect(await ports.graphCommitSha("p", "r")).toBe("abc");
  });

  it("listSymbols returns empty when no graph is found", async () => {
    mockPrisma.codeGraph.findFirst.mockResolvedValue(null);
    const ports = buildScannerPorts();
    const result = await ports.listSymbols({
      id: "s",
      projectId: "p",
      repoConnectionId: "r",
      commitSha: "c",
      mode: "both",
      budgetCapTokens: 1,
      createdById: null,
    });
    expect(result).toEqual([]);
  });

  it("listSymbols maps rows and fills sane defaults for missing optional fields", async () => {
    mockPrisma.codeGraph.findFirst.mockResolvedValue({ id: "g-1" });
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      {
        id: "sym-1",
        qualifiedName: "qn",
        kind: "function",
        language: null,
        filePath: null,
        startLine: null,
        endLine: null,
      },
    ]);
    const ports = buildScannerPorts();
    const result = await ports.listSymbols({
      id: "s",
      projectId: "p",
      repoConnectionId: "r",
      commitSha: "c",
      mode: "both",
      budgetCapTokens: 1,
      createdById: null,
    });
    expect(result[0]).toMatchObject({
      id: "sym-1",
      language: "unknown",
      filePath: "",
      startLine: 1,
      endLine: 1,
    });
  });

  it("readSymbolBody returns empty string when symbol has no filePath", async () => {
    const ports = buildScannerPorts();
    const body = await ports.readSymbolBody(
      {
        id: "s",
        projectId: "p",
        repoConnectionId: "r",
        commitSha: "c",
        mode: "both",
        budgetCapTokens: 1,
        createdById: null,
      },
      {
        id: "sym-1",
        qualifiedName: "qn",
        kind: "function",
        language: "ts",
        filePath: "",
        startLine: 1,
        endLine: 2,
      },
    );
    expect(body).toBe("");
  });

  it("readSymbolBody reads file slice from cloned repo", async () => {
    const ports = buildScannerPorts();
    const body = await ports.readSymbolBody(
      {
        id: "s",
        projectId: "p",
        repoConnectionId: "r",
        commitSha: "c",
        mode: "both",
        budgetCapTokens: 1,
        createdById: "u",
      },
      {
        id: "sym-1",
        qualifiedName: "qn",
        kind: "function",
        language: "ts",
        filePath: "lib/foo.ts",
        startLine: 2,
        endLine: 3,
      },
    );
    expect(body).toBe("line2\nline3");
  });

  it("ruleInstructions returns empty string in heuristic mode (no rule lookup)", async () => {
    const ports = buildScannerPorts();
    const out = await ports.ruleInstructions({
      id: "s",
      projectId: "p",
      repoConnectionId: "r",
      commitSha: "c",
      mode: "heuristic",
      budgetCapTokens: 1,
      createdById: null,
    });
    expect(out).toBe("");
    expect(mockPrisma.ruleSet.findMany).not.toHaveBeenCalled();
  });

  it("ruleInstructions concatenates active rules", async () => {
    mockPrisma.ruleSet.findMany.mockResolvedValue([
      {
        rules: [{ id: "r1", naturalLanguage: "no eval", severity: "high", category: "security" }],
      },
    ]);
    const ports = buildScannerPorts();
    const out = await ports.ruleInstructions({
      id: "s",
      projectId: "p",
      repoConnectionId: "r",
      commitSha: "c",
      mode: "rules",
      budgetCapTokens: 1,
      createdById: null,
    });
    expect(out).toContain("no eval");
    expect(out).toContain("r1");
  });
});
