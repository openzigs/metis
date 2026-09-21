/**
 * Jira service unit tests — Epic #556 / Issues #560–#561.
 *
 * Tests the CRUD + operations layer with mocked Prisma and vault.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mock stores -----------------------------------------------------------

interface JiraRow {
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
  errorMessage: string | null;
  lastTestedAt: Date | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const rows = new Map<string, JiraRow>();
let counter = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    user: {
      upsert: vi.fn(
        async ({
          create,
        }: {
          create: { username: string; displayName: string; email: string };
        }) => ({
          id: "user_admin",
          ...create,
        }),
      ),
    },
    userRole: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
    jiraConnection: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        [...rows.values()].filter((r) => r.projectId === where.projectId && !r.deletedAt),
      ),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        for (const r of rows.values()) {
          if (r.deletedAt) continue;
          let match = true;
          for (const [k, v] of Object.entries(where)) {
            if (k === "deletedAt") continue;
            if ((r as unknown as Record<string, unknown>)[k] !== v) match = false;
          }
          if (match) return r;
        }
        return null;
      }),
      create: vi.fn(async ({ data }: { data: Partial<JiraRow> }) => {
        counter++;
        const row: JiraRow = {
          id: `jira_${counter}`,
          projectId: "",
          label: "",
          edition: "cloud",
          baseUrl: "",
          username: "",
          secretId: "",
          proxyUrl: null,
          tlsRejectUnauthorized: true,
          tlsCaSecretId: null,
          status: "untested",
          errorMessage: null,
          lastTestedAt: null,
          createdById: "",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          ...(data as JiraRow),
        };
        rows.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<JiraRow> }) => {
        const r = rows.get(where.id);
        if (!r) throw new Error("not found");
        const next = { ...r, ...data, updatedAt: new Date() } as JiraRow;
        rows.set(where.id, next);
        return next;
      }),
    },
  },
}));

let vaultWriteCounter = 0;
vi.mock("../src/lib/vault/vault-service.js", () => ({
  getVaultService: () => ({
    read: vi.fn(async (id: string) => ({ plaintext: `plaintext-${id}`, id })),
    create: vi.fn(async (label: string, _value: string) => {
      vaultWriteCounter++;
      return { id: `secret_${vaultWriteCounter}`, label };
    }),
    list: vi.fn(async () => []),
  }),
}));

vi.mock("../src/lib/connectors/jira/jira-client.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/connectors/jira/jira-client.js")>();
  return {
    ...orig,
    createJiraClient: vi.fn(() => ({
      testConnection: vi.fn(async () => ({
        ok: true,
        serverInfo: { version: "9.0.0", baseUrl: "https://jira.example.com" },
        latencyMs: 42,
      })),
      getServerInfo: vi.fn(async () => ({ version: "9.0.0", baseUrl: "https://jira.example.com" })),
      listProjects: vi.fn(async () => [
        { id: "10000", key: "PROJ", name: "My Project", projectTypeKey: "software" },
      ]),
      searchIssues: vi.fn(async () => ({
        startAt: 0,
        maxResults: 20,
        total: 1,
        issues: [{ id: "1", key: "PROJ-1", self: "u", fields: { summary: "Test" } }],
      })),
      getIssue: vi.fn(async () => ({
        id: "1",
        key: "PROJ-1",
        self: "u",
        fields: { summary: "Test" },
        renderedFields: {},
      })),
      createIssue: vi.fn(async () => ({ id: "1", key: "PROJ-1", self: "u", fields: {} })),
      searchIssuesAll: vi.fn(async function* () {
        /* empty */
      }),
    })),
  };
});

import {
  listJiraConnections,
  getJiraConnection,
  createJiraConnection,
  updateJiraConnection,
  deleteJiraConnection,
  testJiraConnection,
  listJiraProjects,
  searchJiraIssues,
  getJiraIssue,
} from "../src/lib/connectors/jira/jira-service.js";

beforeEach(() => {
  rows.clear();
  counter = 0;
  vaultWriteCounter = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Jira service — CRUD", () => {
  it("creates, lists, gets, updates, and soft-deletes", async () => {
    const created = await createJiraConnection(
      "proj_1",
      {
        label: "cloud-prod",
        edition: "cloud",
        baseUrl: "https://test.atlassian.net",
        username: "user@example.com",
        apiToken: "token-123",
      },
      "user_1",
    );
    expect(created.id).toBe("jira_1");
    expect(created.secretMasked).toBe("••••••••");
    expect(created.status).toBe("untested");

    const list = await listJiraConnections("proj_1");
    expect(list).toHaveLength(1);

    const got = await getJiraConnection(created.id);
    expect(got.label).toBe("cloud-prod");
    expect(got.edition).toBe("cloud");

    const updated = await updateJiraConnection(created.id, { label: "renamed" }, "user_1");
    expect(updated.label).toBe("renamed");

    await deleteJiraConnection(created.id, "user_1");
    const remaining = await listJiraConnections("proj_1");
    expect(remaining).toHaveLength(0);
  });

  it("rejects duplicate label per project", async () => {
    await createJiraConnection(
      "proj_1",
      {
        label: "dup",
        edition: "cloud",
        baseUrl: "https://test.atlassian.net",
        username: "u",
        apiToken: "t",
      },
      "user_1",
    );
    await expect(
      createJiraConnection(
        "proj_1",
        {
          label: "dup",
          edition: "cloud",
          baseUrl: "https://test.atlassian.net",
          username: "u",
          apiToken: "t",
        },
        "user_1",
      ),
    ).rejects.toMatchObject({ code: "JIRA_LABEL_TAKEN", status: 409 });
  });

  it("throws NOT_FOUND for unknown ids", async () => {
    await expect(getJiraConnection("nonexistent")).rejects.toMatchObject({
      code: "JIRA_CONNECTION_NOT_FOUND",
      status: 404,
    });
  });

  it("rotates secret on update with new apiToken", async () => {
    const created = await createJiraConnection(
      "proj_1",
      {
        label: "rotate-test",
        edition: "datacenter",
        baseUrl: "https://jira.corp.net",
        username: "svc",
        apiToken: "old-token",
      },
      "user_1",
    );
    const beforeSecretId = rows.get(created.id)!.secretId;

    await updateJiraConnection(created.id, { apiToken: "new-token" }, "user_1");
    const afterSecretId = rows.get(created.id)!.secretId;

    expect(afterSecretId).not.toBe(beforeSecretId);
  });

  it("stores TLS CA cert in vault when provided", async () => {
    const created = await createJiraConnection(
      "proj_1",
      {
        label: "tls-test",
        edition: "datacenter",
        baseUrl: "https://jira.corp.net",
        username: "svc",
        apiToken: "token",
        tlsCaCert: "-----BEGIN CERTIFICATE-----\nMIIBxx...\n-----END CERTIFICATE-----",
      },
      "user_1",
    );
    expect(created.hasTlsCa).toBe(true);
  });

  it("resets status to untested on connection-altering update", async () => {
    const created = await createJiraConnection(
      "proj_1",
      {
        label: "status-reset",
        edition: "cloud",
        baseUrl: "https://test.atlassian.net",
        username: "u",
        apiToken: "t",
      },
      "user_1",
    );
    // Manually set status to ok
    rows.get(created.id)!.status = "ok";

    await updateJiraConnection(created.id, { baseUrl: "https://new.atlassian.net" }, "user_1");
    const updated = await getJiraConnection(created.id);
    expect(updated.status).toBe("untested");
  });
});

describe("Jira service — operations", () => {
  it("testJiraConnection updates status to ok", async () => {
    const created = await createJiraConnection(
      "proj_1",
      {
        label: "test-conn",
        edition: "cloud",
        baseUrl: "https://test.atlassian.net",
        username: "u",
        apiToken: "t",
      },
      "user_1",
    );
    const result = await testJiraConnection(created.id, "user_1");
    expect(result.ok).toBe(true);
    expect(result.serverInfo?.version).toBe("9.0.0");

    const updated = await getJiraConnection(created.id);
    expect(updated.status).toBe("ok");
  });

  it("listJiraProjects returns project list", async () => {
    const created = await createJiraConnection(
      "proj_1",
      {
        label: "proj-list",
        edition: "cloud",
        baseUrl: "https://test.atlassian.net",
        username: "u",
        apiToken: "t",
      },
      "user_1",
    );
    const projects = await listJiraProjects(created.id);
    expect(projects).toHaveLength(1);
    expect(projects[0].key).toBe("PROJ");
  });

  it("searchJiraIssues returns search results", async () => {
    const created = await createJiraConnection(
      "proj_1",
      {
        label: "search-test",
        edition: "cloud",
        baseUrl: "https://test.atlassian.net",
        username: "u",
        apiToken: "t",
      },
      "user_1",
    );
    const result = await searchJiraIssues(created.id, {
      jql: "project=PROJ",
      startAt: 0,
      maxResults: 20,
    });
    expect(result.total).toBe(1);
    expect(result.issues[0].key).toBe("PROJ-1");
  });

  it("getJiraIssue returns issue detail", async () => {
    const created = await createJiraConnection(
      "proj_1",
      {
        label: "detail-test",
        edition: "cloud",
        baseUrl: "https://test.atlassian.net",
        username: "u",
        apiToken: "t",
      },
      "user_1",
    );
    const detail = await getJiraIssue(created.id, "PROJ-1");
    expect(detail.key).toBe("PROJ-1");
    expect(detail.renderedFields).toBeDefined();
  });
});
