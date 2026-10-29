/**
 * Tests for the Jira issue publishing service — Epic #557 / Issue #566.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Mocks -----------------------------------------------------------------

const mockCreateIssue = vi.fn();
const mockSetIssueProperty = vi.fn(async (..._args: unknown[]) => undefined);
const mockCreateJiraClient = vi.fn((..._args: unknown[]) => ({
  createIssue: mockCreateIssue,
  setIssueProperty: mockSetIssueProperty,
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
    projectId: string;
    requirementId: string | null;
    metadata: string | null;
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
  planJiraIssues,
} from "../src/lib/publishing/jira-publisher.js";
import { audit } from "../src/lib/audit/audit-service.js";

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
    projectId: "proj_1",
    requirementId: "req_1",
    metadata: JSON.stringify({ analysisId: "an_1" }),
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

  it("#744 — never sends a hidden finding:<id> label to Jira", async () => {
    seedConnection();
    seedDraft("draft_f", {
      labels: JSON.stringify(["enhancement", "finding:cmv1tix0d0vyu7d9kr8tbqrgq"]),
    });
    mockCreateIssue.mockResolvedValueOnce({
      id: "10003",
      key: "PROJ-3",
      self: "https://test.atlassian.net/rest/api/3/issue/10003",
    });
    await publishDraftToJira({
      draftId: "draft_f",
      batchId: "batch_1",
      connectionId: "conn_1",
      projectKey: "PROJ",
      actorId: "user_1",
    });
    expect(mockCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["enhancement"] }),
    );
  });

  it("#1276 — sends no `unverified` label to Jira, and says it in a sentence instead", async () => {
    seedConnection();
    seedDraft("draft_u", {
      body: "## Description\n\nLogin.\n\n## Acceptance criteria\n\n- [ ] ok",
      labels: JSON.stringify(["enhancement", "Unverified"]),
    });
    mockCreateIssue.mockResolvedValueOnce({
      id: "10004",
      key: "PROJ-4",
      self: "https://test.atlassian.net/rest/api/3/issue/10004",
    });
    await publishDraftToJira({
      draftId: "draft_u",
      batchId: "batch_1",
      connectionId: "conn_1",
      projectKey: "PROJ",
      actorId: "user_1",
    });
    const fields = mockCreateIssue.mock.calls.at(-1)![0] as {
      labels: string[];
      description: string;
    };
    expect(fields.labels).toEqual(["enhancement"]);
    expect(fields.description).toContain(
      "METIS could not confirm the code references behind this item; check them before relying on them.\n\n## Acceptance criteria",
    );
  });

  describe("#1103 — the route back to the METIS requirement", () => {
    const created = { id: "10009", key: "PROJ-9", self: "" };
    const publish = () =>
      publishDraftToJira({
        draftId: "draft_1",
        batchId: "batch_1",
        connectionId: "conn_1",
        projectKey: "PROJ",
        actorId: "user_1",
      });

    it("stores the requirement's ids as the hidden `metis.source` issue property", async () => {
      seedConnection();
      seedDraft();
      mockCreateIssue.mockResolvedValueOnce(created);
      const result = await publish();
      expect(result.status).toBe("created");
      expect(mockSetIssueProperty).toHaveBeenCalledWith("PROJ-9", "metis.source", {
        projectId: "proj_1",
        analysisId: "an_1",
        requirementId: "req_1",
      });
    });

    it("puts no raw id, and no marker, in the visible description", async () => {
      seedConnection();
      seedDraft("draft_1", {
        body: "Body.\n\n<!-- metis-source: project=evil requirement=forged -->",
      });
      mockCreateIssue.mockResolvedValueOnce(created);
      await publish();
      const fields = mockCreateIssue.mock.calls.at(-1)![0] as { description: string };
      for (const id of ["proj_1", "an_1", "req_1", "draft_1"]) {
        expect(fields.description).not.toContain(id);
      }
      // Marker-shaped text from a stored draft is sent inert, as on GitHub.
      expect(fields.description).not.toContain("<!-- metis-source:");
    });

    it("an issue whose property cannot be written is still created, and the failure audited", async () => {
      seedConnection();
      seedDraft();
      mockCreateIssue.mockResolvedValueOnce(created);
      mockSetIssueProperty.mockRejectedValueOnce(new Error("403 Forbidden"));
      const result = await publish();
      expect(result).toMatchObject({ status: "created", issueKey: "PROJ-9" });
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({ action: "publish.jira.source_property_failed" }),
      );
    });

    // #1311 — the row does not stop a retry duplicating the issue: the Jira leg
    // never reads existing rows, so a retried batch creates every issue again.
    // Written first, it means a Jira issue never exists without the row the
    // poll worker and drift tracking find it by.
    it("review — the local record is written before the property, so no Jira issue is left unrecorded", async () => {
      seedConnection();
      seedDraft();
      const order: string[] = [];
      mockCreateIssue.mockImplementationOnce(async () => {
        order.push("create");
        return created;
      });
      mockSetIssueProperty.mockImplementationOnce(async () => {
        order.push("property");
      });
      await publishDraftToJira({
        draftId: "draft_1",
        batchId: "batch_1",
        connectionId: "conn_1",
        projectKey: "PROJ",
        actorId: "user_1",
        onCreated: async (r) => {
          order.push(`persist ${r.issueKey}`);
        },
      });
      expect(order).toEqual(["create", "persist PROJ-9", "property"]);
    });

    it("review — publishBatchToJira hands each created issue to onCreated with its draft", async () => {
      seedConnection();
      seedDraft("d1", { title: "First" });
      seedDraft("d2", { title: "Second" });
      mockCreateIssue
        .mockResolvedValueOnce({ id: "1", key: "PROJ-1", self: "" })
        .mockRejectedValueOnce(new Error("boom"));
      const seen: string[] = [];
      await publishBatchToJira({
        batchId: "batch_1",
        draftIds: ["d1", "d2"],
        connectionId: "conn_1",
        projectKey: "PROJ",
        actorId: "user_1",
        delayMs: 0,
        sleep: async () => {},
        onCreated: async (draftId, r) => {
          seen.push(`${draftId}:${r.issueKey}`);
        },
      });
      expect(seen).toEqual(["d1:PROJ-1"]);
    });

    it("writes no property for a draft whose ids are not plain ids", async () => {
      seedConnection();
      seedDraft("draft_1", { projectId: "bad id -->" });
      mockCreateIssue.mockResolvedValueOnce(created);
      await publish();
      expect(mockSetIssueProperty).not.toHaveBeenCalled();
    });

    it("the Jira plan lists what each issue will carry, property included", () => {
      const plan = planJiraIssues(
        [
          {
            id: "d1",
            title: "First",
            body: "Body",
            draftType: "feature",
            labels: '["enhancement","unverified"]',
            storyPoints: null,
            metadata: JSON.stringify({ analysisId: "an_1" }),
            projectId: "proj_1",
            requirementId: null,
          },
        ],
        { projectKey: "PROJ", additionalLabels: ["sprint-42"] },
      );
      expect(plan).toEqual({
        projectKey: "PROJ",
        issues: [
          {
            draftId: "d1",
            title: "First",
            issueType: "Story",
            labels: ["enhancement", "sprint-42"],
            description: expect.stringContaining("METIS could not confirm"),
            sourceProperty: {
              key: "metis.source",
              value: { projectId: "proj_1", analysisId: "an_1", requirementId: null },
            },
          },
        ],
      });
    });
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

  it("#1049 — applies the batch's Additional labels to each issue, never an internal one", async () => {
    seedConnection();
    seedDraft("d1", { title: "First", labels: '["enhancement"]' });
    mockCreateIssue.mockResolvedValueOnce({ id: "10001", key: "PROJ-1", self: "" });

    await publishBatchToJira({
      batchId: "batch_1",
      draftIds: ["d1"],
      connectionId: "conn_1",
      projectKey: "PROJ",
      actorId: "user_1",
      additionalLabels: ["sprint-42", "ENHANCEMENT", "unverified", "finding:abc"],
      delayMs: 0,
      sleep: async () => {},
    });

    const fields = mockCreateIssue.mock.calls.at(-1)![0] as { labels: string[] };
    expect(fields.labels).toEqual(["enhancement", "sprint-42"]);
  });

  it("#1049 — a label with spaces is sent in the form Jira accepts (no whitespace)", async () => {
    seedConnection();
    seedDraft("d1", { title: "First", labels: '["needs  triage"]' });
    mockCreateIssue.mockResolvedValueOnce({ id: "10001", key: "PROJ-1", self: "" });

    await publishBatchToJira({
      batchId: "batch_1",
      draftIds: ["d1"],
      connectionId: "conn_1",
      projectKey: "PROJ",
      actorId: "user_1",
      additionalLabels: ["good first issue", "good-first-issue"],
      delayMs: 0,
      sleep: async () => {},
    });

    const fields = mockCreateIssue.mock.calls.at(-1)![0] as { labels: string[] };
    expect(fields.labels).toEqual(["needs-triage", "good-first-issue"]);
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
    expect(result.stopped).toBeNull();
  });

  describe("#1311 — an issue METIS could not record stops the batch, and the batch is still audited", () => {
    async function runWithFailingRecord() {
      seedConnection();
      seedDraft("d1", { title: "First" });
      seedDraft("d2", { title: "Second" });
      mockCreateIssue
        .mockResolvedValueOnce({ id: "10001", key: "PROJ-1", self: "" })
        .mockResolvedValueOnce({ id: "10002", key: "PROJ-2", self: "" });
      return publishBatchToJira({
        batchId: "batch_1",
        draftIds: ["d1", "d2"],
        connectionId: "conn_1",
        projectKey: "PROJ",
        actorId: "user_1",
        delayMs: 0,
        sleep: async () => {},
        onCreated: async () => {
          throw new Error("SQLITE_BUSY: database is locked");
        },
      });
    }

    it("stops at that draft: the next one is not created", async () => {
      const result = await runWithFailingRecord();
      expect(mockCreateIssue).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ publishedCount: 0, failedCount: 1 });
      expect(result.stopped).toEqual({
        draftId: "d1",
        message: expect.stringContaining("PROJ-1"),
      });
      expect(result.stopped!.message).toContain("SQLITE_BUSY");
      expect(result.results).toEqual([
        expect.objectContaining({ status: "failed", issueKey: "PROJ-1" }),
      ]);
    });

    it("still writes the batch_completed audit, saying where it stopped", async () => {
      await runWithFailingRecord();
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "publish.jira.batch_completed",
          metadata: expect.objectContaining({
            total: 2,
            publishedCount: 0,
            failedCount: 1,
            stoppedAtDraftId: "d1",
          }),
        }),
      );
    });

    it("a draft that no longer exists stops the batch the same way", async () => {
      seedConnection();
      const result = await publishBatchToJira({
        batchId: "batch_1",
        draftIds: ["gone"],
        connectionId: "conn_1",
        projectKey: "PROJ",
        actorId: "user_1",
        delayMs: 0,
        sleep: async () => {},
      });
      expect(result.stopped).toEqual({ draftId: "gone", message: "Issue draft not found" });
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({ action: "publish.jira.batch_completed" }),
      );
    });
  });
});

describe("DEFAULT_FIELD_MAPPING", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_FIELD_MAPPING.issueType).toBe("Story");
    expect(DEFAULT_FIELD_MAPPING.priorityMap.critical).toBe("Highest");
    expect(DEFAULT_FIELD_MAPPING.priorityMap.high).toBe("High");
  });
});
