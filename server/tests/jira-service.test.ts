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

/**
 * #106 — a vault double that behaves like the real table: `Secret.name` is
 * UNIQUE (soft-deleted rows keep their name), `read` sees live rows only, and
 * `rotate` rewrites a row in place. The previous double accepted any create,
 * so a rotation that re-created an existing name could never fail here.
 */
interface SecretRow {
  id: string;
  name: string;
  plaintext: string;
  deletedAt: Date | null;
}
const secrets = new Map<string, SecretRow>();
let vaultWriteCounter = 0;
const vaultDouble = {
  read: vi.fn(async (id: string) => {
    const row = secrets.get(id);
    if (!row || row.deletedAt) throw new Error(`Secret ${id} not found`);
    return { plaintext: row.plaintext, summary: { id } };
  }),
  create: vi.fn(async (label: string, value: string, scope = "global") => {
    const name = `${scope}:${label}`;
    if ([...secrets.values()].some((r) => r.name === name)) {
      throw Object.assign(new Error("Unique constraint failed on the fields: (`name`)"), {
        code: "P2002",
      });
    }
    vaultWriteCounter++;
    const row = { id: `secret_${vaultWriteCounter}`, name, plaintext: value, deletedAt: null };
    secrets.set(row.id, row);
    return { id: row.id, label };
  }),
  // Like the real `rotate` (#106, review of PR #259): live rows only — a
  // soft-deleted row is refused with `SecretNotFoundError` and left untouched.
  rotate: vi.fn(async (id: string, value: string) => {
    const row = secrets.get(id);
    if (!row || row.deletedAt) throw new SecretNotFoundError(id);
    row.plaintext = value;
    return { id };
  }),
  delete: vi.fn(async (id: string) => {
    const row = secrets.get(id);
    if (row) row.deletedAt = new Date();
  }),
  list: vi.fn(async (scope?: string) =>
    [...secrets.values()]
      .filter((r) => !r.deletedAt && (!scope || r.name.startsWith(`${scope}:`)))
      .map((r) => ({ id: r.id, label: r.name.slice(r.name.indexOf(":") + 1) })),
  ),
};
vi.mock("../src/lib/vault/vault-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/vault/vault-service.js")>()),
  getVaultService: () => vaultDouble,
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

vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));

// The SSRF host guard resolves DNS; these tests exercise the vault path, so the
// guard is stubbed (its own suite covers it) and the file stays hermetic.
vi.mock("../src/lib/connectors/network-allowlist.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/connectors/network-allowlist.js")>()),
  assertConnectorHostAllowed: vi.fn(async () => undefined),
}));

import { createJiraClient } from "../src/lib/connectors/jira/jira-client.js";
import { audit } from "../src/lib/audit/audit-service.js";
import { SecretNotFoundError } from "../src/lib/vault/vault-service.js";
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
  secrets.clear();
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
    const secretId = rows.get(created.id)!.secretId;

    await updateJiraConnection(created.id, { apiToken: "new-token" }, "user_1");

    // #106 — rotated IN PLACE: same secret, new value, nothing orphaned.
    expect(rows.get(created.id)!.secretId).toBe(secretId);
    expect((await vaultDouble.read(secretId)).plaintext).toBe("new-token");
    expect(secrets.size).toBe(1);
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

describe("Jira service — secret rotation against a unique-name vault (#106)", () => {
  const base = {
    edition: "datacenter" as const,
    baseUrl: "https://jira.example.com",
    username: "svc",
  };
  const CA_OLD = "-----BEGIN CERTIFICATE-----\nOLD\n-----END CERTIFICATE-----";
  const CA_NEW = "-----BEGIN CERTIFICATE-----\nNEW\n-----END CERTIFICATE-----";

  /** What the connection actually reads: the credentials handed to the client. */
  async function credentialsOf(id: string) {
    const client = vi.mocked(createJiraClient);
    client.mockClear();
    await testJiraConnection(id, "user_1");
    return client.mock.calls.at(-1)![0];
  }

  it("updating the API token WITHOUT renaming succeeds and is what the connection reads back", async () => {
    const created = await createJiraConnection(
      "proj_1",
      { ...base, label: "prod", apiToken: "old-token" },
      "user_1",
    );
    rows.get(created.id)!.status = "ok";

    const updated = await updateJiraConnection(created.id, { apiToken: "new-token" }, "user_1");

    expect(updated.status).toBe("untested");
    expect((await credentialsOf(created.id)).apiToken).toBe("new-token");
  });

  it("updating the TLS CA cert WITHOUT renaming succeeds and is what the connection reads back", async () => {
    const created = await createJiraConnection(
      "proj_1",
      { ...base, label: "prod", apiToken: "t", tlsCaCert: CA_OLD },
      "user_1",
    );
    const caId = rows.get(created.id)!.tlsCaSecretId;

    await updateJiraConnection(created.id, { tlsCaCert: CA_NEW }, "user_1");

    expect(rows.get(created.id)!.tlsCaSecretId).toBe(caId);
    expect((await credentialsOf(created.id)).tlsCaCert).toBe(CA_NEW);
  });

  it("adding a first TLS CA cert on update stores a new secret the connection reads", async () => {
    const created = await createJiraConnection(
      "proj_1",
      { ...base, label: "prod", apiToken: "t" },
      "user_1",
    );
    await updateJiraConnection(created.id, { tlsCaCert: CA_NEW }, "user_1");
    expect((await credentialsOf(created.id)).tlsCaCert).toBe(CA_NEW);

    await updateJiraConnection(created.id, { tlsCaCert: "" }, "user_1");
    expect((await credentialsOf(created.id)).tlsCaCert).toBeNull();
  });

  it("a token whose secret was deleted from the vault is replaced, not rotated into a dead row", async () => {
    const created = await createJiraConnection(
      "proj_1",
      { ...base, label: "prod", apiToken: "old", tlsCaCert: CA_OLD },
      "user_1",
    );
    const { secretId, tlsCaSecretId } = rows.get(created.id)!;
    await vaultDouble.delete(secretId);
    await vaultDouble.delete(tlsCaSecretId!);

    await updateJiraConnection(created.id, { apiToken: "new", tlsCaCert: CA_NEW }, "user_1");

    expect(rows.get(created.id)!.secretId).not.toBe(secretId);
    const creds = await credentialsOf(created.id);
    expect(creds.apiToken).toBe("new");
    expect(creds.tlsCaCert).toBe(CA_NEW);
  });

  // Review of PR #259 — the soft-deleted row is never written, and the new
  // secret takes a fresh, suffixed name rather than the dead row's name.
  it("a soft-deleted token secret keeps its old value; the new one gets a fresh suffixed name", async () => {
    const created = await createJiraConnection(
      "proj_1",
      { ...base, label: "prod", apiToken: "old" },
      "user_1",
    );
    const deadId = rows.get(created.id)!.secretId;
    const deadName = secrets.get(deadId)!.name;
    await vaultDouble.delete(deadId);

    await updateJiraConnection(created.id, { apiToken: "new" }, "user_1");

    expect(secrets.get(deadId)!.plaintext).toBe("old");
    const fresh = secrets.get(rows.get(created.id)!.secretId)!;
    expect(fresh.id).not.toBe(deadId);
    expect(fresh.plaintext).toBe("new");
    expect(fresh.name).not.toBe(deadName);
    expect(fresh.name).toMatch(/^project:jira-proj_1-prod-[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("a rotation looks up only its own secret — it never lists the project's secrets", async () => {
    const created = await createJiraConnection(
      "proj_1",
      { ...base, label: "prod", apiToken: "old", tlsCaCert: CA_OLD },
      "user_1",
    );
    const { secretId, tlsCaSecretId } = rows.get(created.id)!;
    vaultDouble.list.mockClear();
    vaultDouble.rotate.mockClear();

    await updateJiraConnection(created.id, { apiToken: "new", tlsCaCert: CA_NEW }, "user_1");

    expect(vaultDouble.list).not.toHaveBeenCalled();
    expect(vaultDouble.rotate.mock.calls.map(([id]) => id).sort()).toEqual(
      [secretId, tlsCaSecretId].sort(),
    );
  });

  it("a vault failure other than not-found propagates instead of minting a new secret", async () => {
    const created = await createJiraConnection(
      "proj_1",
      { ...base, label: "prod", apiToken: "old" },
      "user_1",
    );
    const before = secrets.size;
    vaultDouble.rotate.mockRejectedValueOnce(new Error("vault master key unavailable"));
    await expect(updateJiraConnection(created.id, { apiToken: "new" }, "user_1")).rejects.toThrow(
      "vault master key unavailable",
    );
    expect(secrets.size).toBe(before);
  });

  it("creating under a label whose old secret name is soft-deleted in the vault succeeds", async () => {
    // A secret left behind (soft-deleted) under the name the old scheme derived.
    secrets.set("secret_old", {
      id: "secret_old",
      name: "project:jira-proj_1-prod",
      plaintext: "stale",
      deletedAt: new Date(),
    });
    const created = await createJiraConnection(
      "proj_1",
      { ...base, label: "prod", apiToken: "fresh", tlsCaCert: CA_OLD },
      "user_1",
    );
    const creds = await credentialsOf(created.id);
    expect(creds.apiToken).toBe("fresh");
    expect(creds.tlsCaCert).toBe(CA_OLD);
  });

  it("re-using a label a renamed connection gave up never touches that connection's token", async () => {
    const a = await createJiraConnection(
      "proj_1",
      { ...base, label: "prod", apiToken: "token-a" },
      "user_1",
    );
    await updateJiraConnection(a.id, { label: "prod-old" }, "user_1");
    const b = await createJiraConnection(
      "proj_1",
      { ...base, label: "prod", apiToken: "token-b" },
      "user_1",
    );
    expect((await credentialsOf(a.id)).apiToken).toBe("token-a");
    expect((await credentialsOf(b.id)).apiToken).toBe("token-b");
  });

  it("two labels that sanitize to the same string keep separate tokens", async () => {
    const a = await createJiraConnection(
      "proj_1",
      { ...base, label: "team a", apiToken: "token-a" },
      "user_1",
    );
    const b = await createJiraConnection(
      "proj_1",
      { ...base, label: "team-a", apiToken: "token-b" },
      "user_1",
    );
    await updateJiraConnection(b.id, { apiToken: "token-b2" }, "user_1");
    expect((await credentialsOf(a.id)).apiToken).toBe("token-a");
    expect((await credentialsOf(b.id)).apiToken).toBe("token-b2");
  });

  it("the audit record names the rotated secrets even though the row keeps its ids", async () => {
    const created = await createJiraConnection(
      "proj_1",
      { ...base, label: "prod", apiToken: "t", tlsCaCert: CA_OLD },
      "user_1",
    );
    vi.mocked(audit).mockClear();
    await updateJiraConnection(created.id, { apiToken: "t2", tlsCaCert: CA_NEW }, "user_1");
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "connector.jira.update",
        metadata: expect.objectContaining({
          fields: expect.arrayContaining(["apiToken", "tlsCaCert"]),
        }),
      }),
    );
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
