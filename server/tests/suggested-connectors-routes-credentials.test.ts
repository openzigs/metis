/**
 * Tests for suggested-connectors routes — credential-aware endpoints.
 * Epic #701 / Issue #704:
 *   GET    /:id           — detail + one-shot password
 *   POST   /:id/test      — credential-explicit liveness probe
 *   POST   /:id/provision — atomic vault + db connector
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockSuggestedConnectors = new Map<string, Record<string, unknown>>();
let nextId = 0;
let suggestionUpdateOverride:
  | null
  | ((args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>) = null;

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(
        async ({
          create,
        }: {
          create: { username: string; displayName: string; email: string };
        }) => ({ id: "user_admin", ...create }),
      ),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    suggestedConnector: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; projectId: string } }) => {
        const sc = mockSuggestedConnectors.get(where.id);
        if (sc && sc.projectId === where.projectId) return sc;
        return null;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          if (suggestionUpdateOverride) {
            return suggestionUpdateOverride({ where, data });
          }
          const sc = mockSuggestedConnectors.get(where.id);
          if (!sc) throw new Error("not found");
          const updated = { ...sc, ...data, updatedAt: new Date() };
          mockSuggestedConnectors.set(where.id, updated);
          return updated;
        },
      ),
    },
  });
  return { prisma };
});

const auditSpy = vi.fn();
vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: (args: Record<string, unknown>) => auditSpy(args),
}));

const vaultRead = vi.fn();
const vaultCreate = vi.fn();
const vaultRotate = vi.fn();
const vaultDelete = vi.fn();
vi.mock("../src/lib/vault/vault-service.js", () => ({
  getVaultService: () => ({
    read: vaultRead,
    create: vaultCreate,
    rotate: vaultRotate,
    delete: vaultDelete,
  }),
}));

const testDbExplicit = vi.fn();
const createDbConnectorMock = vi.fn();
const deleteDbConnectorMock = vi.fn();
vi.mock("../src/lib/connectors/db/db-service.js", async () => {
  // Pull ConnectorError type unused — route imports from types.js directly
  return {
    testDbWithExplicitCredentials: (...args: unknown[]) => testDbExplicit(...args),
    createDbConnector: (...args: unknown[]) => createDbConnectorMock(...args),
    deleteDbConnector: (...args: unknown[]) => deleteDbConnectorMock(...args),
  };
});

vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import request from "supertest";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;
let token: string;

async function login(): Promise<string> {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ username: "admin", password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

function addSuggestion(overrides: Partial<Record<string, unknown>> = {}) {
  nextId++;
  const id = `sc_${nextId}`;
  const sc = {
    id,
    projectId: "proj-1",
    driverType: "postgresql",
    host: "db-host",
    port: 5432,
    database: "mydb",
    sourceFile: "application-dev.properties",
    lineNumber: 10,
    confidence: "high",
    status: "pending",
    username: "alice",
    passwordVaultRef: null,
    devCredsDetected: false,
    credentialSourceFile: null,
    acceptedConnectorId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  mockSuggestedConnectors.set(id, sc);
  return sc;
}

beforeAll(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  // Default to a huge cap so the per-route limiter doesn't bite unrelated
  // tests in this file. The rate-limit test below resets it explicitly.
  process.env.CONNECTOR_SUGGESTED_CRED_READ_LIMIT_MAX = "100000";
  app = createApp();
});

describe("suggested-connectors routes — credentials (#704)", () => {
  beforeEach(async () => {
    mockSuggestedConnectors.clear();
    nextId = 0;
    auditSpy.mockReset();
    vaultRead.mockReset();
    vaultCreate.mockReset();
    vaultRotate.mockReset();
    vaultDelete.mockReset();
    testDbExplicit.mockReset();
    createDbConnectorMock.mockReset();
    deleteDbConnectorMock.mockReset();
    suggestionUpdateOverride = null;
    token = await login();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /:id", () => {
    it("returns one-shot decrypted password when present", async () => {
      const sc = addSuggestion({
        passwordVaultRef: "vault_abc",
        devCredsDetected: true,
        credentialSourceFile: "application-dev.properties",
      });
      vaultRead.mockResolvedValue({ summary: { id: "vault_abc" }, plaintext: "hunter2" });

      const res = await request(app)
        .get(`/api/projects/proj-1/suggested-connectors/${sc.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.password).toBe("hunter2");
      expect(res.body.data.hasStoredPassword).toBe(true);
      expect(res.body.data.passwordVaultRef).toBeUndefined();
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({ action: "suggested_connector.credential_read" }),
      );
    });

    it("returns null password when no vault ref", async () => {
      const sc = addSuggestion();
      const res = await request(app)
        .get(`/api/projects/proj-1/suggested-connectors/${sc.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.password).toBeNull();
      expect(res.body.data.hasStoredPassword).toBe(false);
      expect(vaultRead).not.toHaveBeenCalled();
    });

    it("returns null password (with failure audit) when vault read fails", async () => {
      const sc = addSuggestion({ passwordVaultRef: "vault_gone" });
      vaultRead.mockRejectedValue(new Error("vault unavailable"));
      const res = await request(app)
        .get(`/api/projects/proj-1/suggested-connectors/${sc.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.password).toBeNull();
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({ action: "suggested_connector.credential_read.failed" }),
      );
    });

    it("requires auth", async () => {
      const sc = addSuggestion();
      const res = await request(app).get(`/api/projects/proj-1/suggested-connectors/${sc.id}`);
      expect(res.status).toBe(401);
    });

    it("returns 404 for cross-project access", async () => {
      const sc = addSuggestion({ projectId: "proj-2" });
      const res = await request(app)
        .get(`/api/projects/proj-1/suggested-connectors/${sc.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    it("rate-limits credential reads (429 after the configured max)", async () => {
      // Tighten the cap and rebuild the limiter so this test is hermetic
      // and doesn't accidentally fire on neighbouring tests.
      process.env.CONNECTOR_SUGGESTED_CRED_READ_LIMIT_MAX = "3";
      const { __resetConnectorRateLimiters } =
        await import("../src/middleware/connector-rate-limit.js");
      __resetConnectorRateLimiters();
      try {
        const sc = addSuggestion({ passwordVaultRef: "vault_rl" });
        vaultRead.mockResolvedValue({ summary: { id: "vault_rl" }, plaintext: "x" });

        for (let i = 0; i < 3; i++) {
          const ok = await request(app)
            .get(`/api/projects/proj-1/suggested-connectors/${sc.id}`)
            .set("Authorization", `Bearer ${token}`);
          expect(ok.status).toBe(200);
        }
        const blocked = await request(app)
          .get(`/api/projects/proj-1/suggested-connectors/${sc.id}`)
          .set("Authorization", `Bearer ${token}`);
        expect(blocked.status).toBe(429);
      } finally {
        process.env.CONNECTOR_SUGGESTED_CRED_READ_LIMIT_MAX = "100000";
        const { __resetConnectorRateLimiters } =
          await import("../src/middleware/connector-rate-limit.js");
        __resetConnectorRateLimiters();
      }
    });
  });

  describe("POST /:id/test", () => {
    it("falls back to vault-stored password when body omits one", async () => {
      const sc = addSuggestion({ passwordVaultRef: "vault_abc" });
      vaultRead.mockResolvedValue({ summary: { id: "vault_abc" }, plaintext: "hunter2" });
      testDbExplicit.mockResolvedValue({ ok: true, latencyMs: 12 });

      const res = await request(app)
        .post(`/api/projects/proj-1/suggested-connectors/${sc.id}/test`)
        .set("Authorization", `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ ok: true, latencyMs: 12 });
      expect(testDbExplicit).toHaveBeenCalledWith(
        expect.objectContaining({
          driver: "postgres", // postgresql → postgres translation
          password: "hunter2",
          host: "db-host",
          port: 5432,
        }),
      );
    });

    it("uses explicit body password over vault-stored", async () => {
      const sc = addSuggestion({ passwordVaultRef: "vault_abc" });
      testDbExplicit.mockResolvedValue({ ok: true, latencyMs: 5 });

      await request(app)
        .post(`/api/projects/proj-1/suggested-connectors/${sc.id}/test`)
        .set("Authorization", `Bearer ${token}`)
        .send({ password: "override" });
      expect(vaultRead).not.toHaveBeenCalled();
      expect(testDbExplicit).toHaveBeenCalledWith(
        expect.objectContaining({ password: "override" }),
      );
    });

    it("returns sanitized ok:false on driver error (no raw leak)", async () => {
      const sc = addSuggestion();
      testDbExplicit.mockRejectedValue(
        new Error("connect ECONNREFUSED 10.0.0.42:5432 for user=svc_app"),
      );

      const res = await request(app)
        .post(`/api/projects/proj-1/suggested-connectors/${sc.id}/test`)
        .set("Authorization", `Bearer ${token}`)
        .send({ password: "p" });
      expect(res.status).toBe(200);
      expect(res.body.data.ok).toBe(false);
      // Stable client-safe code + message; raw driver string must NOT leak.
      expect(res.body.data.errorCode).toBe("host_unreachable");
      expect(res.body.data.errorMessage).toBe("Could not reach database host");
      expect(JSON.stringify(res.body)).not.toContain("ECONNREFUSED");
      expect(JSON.stringify(res.body)).not.toContain("10.0.0.42");
      expect(JSON.stringify(res.body)).not.toContain("svc_app");
    });

    it("rejects invalid body", async () => {
      const sc = addSuggestion();
      const res = await request(app)
        .post(`/api/projects/proj-1/suggested-connectors/${sc.id}/test`)
        .set("Authorization", `Bearer ${token}`)
        .send({ unknown: "field" });
      expect(res.status).toBe(400);
    });

    it("returns 404 for missing suggestion", async () => {
      const res = await request(app)
        .post(`/api/projects/proj-1/suggested-connectors/missing/test`)
        .set("Authorization", `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(404);
    });
  });

  describe("POST /:id/provision", () => {
    const validBody = {
      label: "dev-postgres",
      driver: "postgres" as const,
      host: "db-host",
      port: 5432,
      database: "mydb",
      username: "alice",
      password: "hunter2",
    };

    it("creates fresh vault secret + db connector, marks suggestion accepted", async () => {
      const sc = addSuggestion();
      vaultCreate.mockResolvedValue({ id: "vault_new" });
      createDbConnectorMock.mockResolvedValue({ id: "db_conn_1" });

      const res = await request(app)
        .post(`/api/projects/proj-1/suggested-connectors/${sc.id}/provision`)
        .set("Authorization", `Bearer ${token}`)
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        ok: true,
        connectorId: "db_conn_1",
        suggestionId: sc.id,
      });
      expect(vaultCreate).toHaveBeenCalledTimes(1);
      expect(createDbConnectorMock).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          label: "dev-postgres",
          driver: "postgres",
          secretRef: "${vault:vault_new}",
        }),
        expect.any(String),
      );
      const stored = mockSuggestedConnectors.get(sc.id) as Record<string, unknown>;
      expect(stored.status).toBe("accepted");
      expect(stored.acceptedConnectorId).toBe("db_conn_1");
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({ action: "suggested_connector.provisioned" }),
      );
    });

    it("rotates existing vault secret when password changed", async () => {
      const sc = addSuggestion({ passwordVaultRef: "vault_old" });
      vaultRead.mockResolvedValue({ summary: { id: "vault_old" }, plaintext: "old-pw" });
      createDbConnectorMock.mockResolvedValue({ id: "db_conn_2" });

      const res = await request(app)
        .post(`/api/projects/proj-1/suggested-connectors/${sc.id}/provision`)
        .set("Authorization", `Bearer ${token}`)
        .send({ ...validBody, password: "new-pw" });

      expect(res.status).toBe(200);
      expect(vaultRotate).toHaveBeenCalledWith("vault_old", "new-pw");
      expect(vaultCreate).not.toHaveBeenCalled();
      expect(createDbConnectorMock).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ secretRef: "${vault:vault_old}" }),
        expect.any(String),
      );
    });

    it("reuses vault secret when password unchanged", async () => {
      const sc = addSuggestion({ passwordVaultRef: "vault_old" });
      vaultRead.mockResolvedValue({ summary: { id: "vault_old" }, plaintext: "hunter2" });
      createDbConnectorMock.mockResolvedValue({ id: "db_conn_3" });

      await request(app)
        .post(`/api/projects/proj-1/suggested-connectors/${sc.id}/provision`)
        .set("Authorization", `Bearer ${token}`)
        .send(validBody);
      expect(vaultRotate).not.toHaveBeenCalled();
      expect(vaultCreate).not.toHaveBeenCalled();
    });

    it("rolls back freshly-created vault secret when db connector creation fails", async () => {
      const sc = addSuggestion();
      vaultCreate.mockResolvedValue({ id: "vault_freshly_created" });
      createDbConnectorMock.mockRejectedValue(new Error("DB unreachable"));

      const res = await request(app)
        .post(`/api/projects/proj-1/suggested-connectors/${sc.id}/provision`)
        .set("Authorization", `Bearer ${token}`)
        .send(validBody);
      expect(res.status).toBe(500);
      expect(vaultDelete).toHaveBeenCalledWith("vault_freshly_created");
      // Suggestion must NOT have been marked accepted.
      const stored = mockSuggestedConnectors.get(sc.id) as Record<string, unknown>;
      expect(stored.status).toBe("pending");
    });

    it("does NOT roll back vault secret when reused/rotated and create fails", async () => {
      const sc = addSuggestion({ passwordVaultRef: "vault_existing" });
      vaultRead.mockResolvedValue({ summary: { id: "vault_existing" }, plaintext: "hunter2" });
      createDbConnectorMock.mockRejectedValue(new Error("nope"));

      await request(app)
        .post(`/api/projects/proj-1/suggested-connectors/${sc.id}/provision`)
        .set("Authorization", `Bearer ${token}`)
        .send(validBody);
      expect(vaultDelete).not.toHaveBeenCalled();
    });

    it("rolls back BOTH vault and connector if suggestion update fails after create", async () => {
      const sc = addSuggestion();
      vaultCreate.mockResolvedValue({ id: "vault_fresh_2" });
      vaultDelete.mockResolvedValue(undefined);
      createDbConnectorMock.mockResolvedValue({ id: "db_conn_orphan" });
      deleteDbConnectorMock.mockResolvedValue(undefined);
      suggestionUpdateOverride = async () => {
        throw new Error("suggestion update lost connection");
      };

      const res = await request(app)
        .post(`/api/projects/proj-1/suggested-connectors/${sc.id}/provision`)
        .set("Authorization", `Bearer ${token}`)
        .send(validBody);

      expect(res.status).toBe(500);
      // Vault secret created on this request must be rolled back.
      expect(vaultDelete).toHaveBeenCalledWith("vault_fresh_2");
      // Orphaned connector must be deleted.
      expect(deleteDbConnectorMock).toHaveBeenCalledWith(
        "proj-1",
        "db_conn_orphan",
        expect.any(String),
      );
      // Suggestion stays pending.
      const stored = mockSuggestedConnectors.get(sc.id) as Record<string, unknown>;
      expect(stored.status).toBe("pending");
      // Failure audit recorded with the right phase.
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "suggested_connector.provisioned.failed",
          metadata: expect.objectContaining({ phase: "suggestion_update" }),
        }),
      );
    });

    it("rejects invalid body", async () => {
      const sc = addSuggestion();
      const res = await request(app)
        .post(`/api/projects/proj-1/suggested-connectors/${sc.id}/provision`)
        .set("Authorization", `Bearer ${token}`)
        .send({ label: "" });
      expect(res.status).toBe(400);
    });

    it("requires auth", async () => {
      const sc = addSuggestion();
      const res = await request(app)
        .post(`/api/projects/proj-1/suggested-connectors/${sc.id}/provision`)
        .send(validBody);
      expect(res.status).toBe(401);
    });
  });
});
