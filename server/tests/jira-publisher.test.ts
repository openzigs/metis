/**
 * Tests for the Jira issue publishing service — Epic #557 / Issue #566.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Mocks -----------------------------------------------------------------

const mockCreateIssue = vi.fn();
const mockCreateJiraClient = vi.fn(() => ({
  createIssue: mockCreateIssue,
  testConnection: vi.fn(),
  getServerInfo: vi.fn(),
  listProjects: vi.fn(),
  searchIssues: vi.fn(),
  getIssue: vi.fn(),
  searchIssuesAll: vi.fn(),
}));

vi.mock("../src/lib/connectors/jira/jira-client.js", () => ({
  createJiraClient: (...args: unknown[]) => mockCreateJiraClient(...args),
  JiraApiError: class JiraApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
      this.name = "JiraApiError";
    }
  },
}));

vi.mock("../src/lib/connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn(),
}));

const mockVaultRead = vi.fn(async () => ({ plaintext: "fake-token" }));
vi.mock("../src/lib/vault/vault-service.js", () => ({
  getVaultService: () => ({ read: mockVaultRead }),
}));

const mockDrafts = new Map<
  string,
  {
    id: string;
    title: string;
    body: string;
    draftType: string;
    labels: string;
    storyPoints: number | null;
    deletedAt: null | Date;
  }
>();
const mockConnections = new Map<
  string,
  {
    id: string;
    projectId: string;
    label: string;
    edition: string;
    baseUrl: string;
    username: string;
    secretId: string;
    proxyUrl: string | null;
    tlsRejectUnauthorized: boolean;
    tlsCaSecretId: string | null;
    status: string;
    deletedAt: null | Date;
  }
>();

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    issueDraft: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) => mockDrafts.get(where.id) ?? null,
      ),
    },
    jiraConnection: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) => mockConnections.get(where.id) ?? null,
      ),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

import {
  publishDraftToJira,
  publishBatchToJira,
  JiraPublishError,
  DEFAULT_FIELD_MAPPING,
} from "../src/lib/publishing/jira-publisher.js";

beforeEach(() => {
  mockDrafts.clear();
  mockConnections.clear();
  vi.clearAllMocks();
});

afterEach(() => vi.restoreAllMocks());

// ---- Test data helpers ------------------------------------------------------

function seedConnection(id = "conn_1") {
  mockConnections.set(id, {
    id,
    projectId: "proj_1",
    label: "Test Jira",
    edition: "cloud",
    baseUrl: "https://test.atlassian.net",
    username: "user@test.com",
    secretId: "secret_1",
    proxyUrl: null,
    tlsRejectUnauthorized: true,
    tlsCaSecretId: null,
    status: "ok",
    deletedAt: null,
  });
}

function seedDraft(
  id = "draft_1",
  overrides: Partial<typeof mockDrafts extends Map<string, infer V> ? V : never> = {},
) {
  mockDrafts.set(id, {
    id,
    title: "Test Feature",
    body: "As a user, I want to do things",
    draftType: "feature",
    labels: '["enhancement"]',
    storyPoints: 5,
    deletedAt: null,
    ...overrides,
  });
}

// ---- Tests ------------------------------------------------------------------

describe("publishDraftToJira", () => {
  it("creates a Jira issue from a draft", async () => {
    seedConnection();
    seedDraft();
    mockCreateIssue.mockResolvedValueOnce({
      id: "10001",
      key: "PROJ-1",
      self: "https://test.atlassian.net/rest/api/3/issue/10001",
    });

    const result = await publishDraftToJira({
      draftId: "draft_1",
      batchId: "batch_1",
      connectionId: "conn_1",
      projectKey: "PROJ",
      actorId: "user_1",
    });

    expect(result.status).toBe("created");
    expect(result.issueKey).toBe("PROJ-1");
    expect(result.issueId).toBe("10001");
    expect(result.htmlUrl).toBe("https://test.atlassian.net/browse/PROJ-1");
  });

  it("maps epic draft type to Epic issue type", async () => {
    seedConnection();
    seedDraft("draft_epic", { draftType: "epic", title: "Epic Feature" });
    mockCreateIssue.mockResolvedValueOnce({
      id: "10002",
      key: "PROJ-2",
      self: "https://test.atlassian.net/rest/api/3/issue/10002",
    });

    await publishDraftToJira({
      draftId: "draft_epic",
      batchId: "batch_1",
      connectionId: "conn_1",
      projectKey: "PROJ",
      actorId: "user_1",
    });

    expect(mockCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        project: { key: "PROJ" },
        issuetype: { name: "Epic" },
        summary: "Epic Feature",
      }),
    );
  });

  it("returns failed status on Jira API error", async () => {
    seedConnection();
    seedDraft();
    mockCreateIssue.mockRejectedValueOnce(new Error("Jira API error"));

    const result = await publishDraftToJira({
      draftId: "draft_1",
      batchId: "batch_1",
      connectionId: "conn_1",
      projectKey: "PROJ",
      actorId: "user_1",
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("Jira API error");
  });

  it("throws if draft not found", async () => {
    await expect(
      publishDraftToJira({
        draftId: "missing",
        batchId: "batch_1",
        connectionId: "conn_1",
        projectKey: "PROJ",
        actorId: "user_1",
      }),
    ).rejects.toThrow(JiraPublishError);
  });

  it("returns failed status if connection not found", async () => {
    seedDraft();
    const result = await publishDraftToJira({
      draftId: "draft_1",
      batchId: "batch_1",
      connectionId: "missing",
      projectKey: "PROJ",
      actorId: "user_1",
    });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("not found");
  });

  it("returns failed status if connection is in error state", async () => {
    mockConnections.set("conn_err", {
      id: "conn_err",
      projectId: "proj_1",
      label: "Bad",
      edition: "cloud",
      baseUrl: "https://test.atlassian.net",
      username: "user@test.com",
      secretId: "secret_1",
      proxyUrl: null,
      tlsRejectUnauthorized: true,
      tlsCaSecretId: null,
      status: "error",
      deletedAt: null,
    });
    seedDraft();

    const result = await publishDraftToJira({
      draftId: "draft_1",
      batchId: "batch_1",
      connectionId: "conn_err",
      projectKey: "PROJ",
      actorId: "user_1",
    });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("error state");
  });
});

describe("publishBatchToJira", () => {
  it("publishes multiple drafts sequentially", async () => {
    seedConnection();
    seedDraft("d1", { title: "First" });
    seedDraft("d2", { title: "Second" });
    mockCreateIssue
      .mockResolvedValueOnce({ id: "10001", key: "PROJ-1", self: "" })
      .mockResolvedValueOnce({ id: "10002", key: "PROJ-2", self: "" });

    const result = await publishBatchToJira({
      batchId: "batch_1",
      draftIds: ["d1", "d2"],
      connectionId: "conn_1",
      projectKey: "PROJ",
      actorId: "user_1",
      delayMs: 0,
      sleep: async () => {},
    });

    expect(result.publishedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.results).toHaveLength(2);
  });

  it("continues on individual failures", async () => {
    seedConnection();
    seedDraft("d1");
    seedDraft("d2");
    mockCreateIssue
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce({ id: "10002", key: "PROJ-2", self: "" });

    const result = await publishBatchToJira({
      batchId: "batch_1",
      draftIds: ["d1", "d2"],
      connectionId: "conn_1",
      projectKey: "PROJ",
      actorId: "user_1",
      delayMs: 0,
      sleep: async () => {},
    });

    expect(result.publishedCount).toBe(1);
    expect(result.failedCount).toBe(1);
  });
});

describe("DEFAULT_FIELD_MAPPING", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_FIELD_MAPPING.issueType).toBe("Story");
    expect(DEFAULT_FIELD_MAPPING.priorityMap.critical).toBe("Highest");
    expect(DEFAULT_FIELD_MAPPING.priorityMap.high).toBe("High");
  });
});
