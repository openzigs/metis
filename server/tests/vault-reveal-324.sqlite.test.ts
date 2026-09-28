/**
 * #324 — revealing a vault secret's plaintext is admin-only (`vault.reveal`),
 * proven through the REAL routers, the REAL vault service and the REAL audit
 * service against a REAL SQLite database built from the migration chain. The
 * permission helper is not mocked: every caller is a signed token for a user of
 * the named role.
 *
 * Every reveal attempt — granted, refused, or for an unknown id — must leave an
 * audit row naming the actor, the secret id and the outcome, and never the
 * value. Non-admins keep `vault.read` (listing, and USING a secret by reference
 * — #305's `canUseSecret` rule is unchanged); they lose only the plaintext.
 *
 * The suggested-connector detail route also returned a vaulted credential's
 * plaintext (to `connector.write`, i.e. coordinators), so it follows the same
 * rule; provisioning without re-typing the password reuses the stored secret
 * server-side, so a coordinator can still provision without ever seeing it.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.AI_RATE_LIMIT_MAX = "10000";
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});

const { vaultRouter } = await import("../src/routes/vault.js");
const { aiRouter } = await import("../src/routes/ai.js");
const { suggestedConnectorsRouter } = await import("../src/routes/suggested-connectors.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");
const { __resetVaultRevealRateLimiter } =
  await import("../src/middleware/vault-reveal-rate-limit.js");

type Role = "admin" | "coordinator" | "developer" | "reader";

const PLAINTEXT = "sk-test-324-plaintext-value";
const DB_PASSWORD = "dev-db-password-324";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#324 — vault plaintext reveal is admin-only and every attempt is audited",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let SECRET_ID = "";
    let DB_SECRET_ID = "";
    const tokens: Record<Role, string> = { admin: "", coordinator: "", developer: "", reader: "" };
    const userOf: Record<Role, string> = {
      admin: "u-admin",
      coordinator: "u-coord",
      developer: "u-dev",
      reader: "u-reader",
    };

    const app = () => {
      const a = express();
      a.set("trust proxy", 1);
      a.use(express.json());
      a.use("/api/vault", vaultRouter());
      a.use("/api/ai", aiRouter());
      a.use("/api/projects/:projectId/suggested-connectors", suggestedConnectorsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    let ip = 0;
    const call = (
      method: "get" | "post",
      url: string,
      bearer?: string,
      body?: Record<string, unknown>,
    ) => {
      ip += 1;
      const r = request(app())
        [method](url)
        .set("X-Forwarded-For", `198.51.100.${ip % 250}`);
      if (bearer) r.set("Authorization", `Bearer ${bearer}`);
      return body ? r.send(body) : r;
    };

    /** Wait for the fire-and-forget audit writes, then read the reveal rows back. */
    const revealAudit = async (targetId: string) => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      return db.auditLog.findMany({
        where: { action: "vault.reveal", targetType: "secret", targetId },
        orderBy: { ts: "asc" },
      });
    };
    const latestRevealBy = async (targetId: string, actorId: string) => {
      const rows = (await revealAudit(targetId)).filter((r) => r.actorId === actorId);
      return rows.at(-1);
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("324-vault-reveal");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      __resetVaultSingleton();

      for (const id of Object.values(userOf)) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: "ws-1", name: "ws-1", slug: "ws-1" } });
      for (const id of ["u-coord", "u-dev", "u-reader"]) {
        await db.workspaceMember.create({
          data: { workspaceId: "ws-1", userId: id, role: "member" },
        });
      }
      await db.project.create({
        data: {
          id: "proj-1",
          name: "proj-1",
          slug: "proj-1",
          createdById: "u-admin",
          workspaceId: "ws-1",
        },
      });

      const vault = getVaultService();
      SECRET_ID = (await vault.create("byok-key", PLAINTEXT, "global", { createdById: "u-admin" }))
        .id;
      DB_SECRET_ID = (
        await vault.create("discovered-db-password", DB_PASSWORD, "project", {
          createdById: "u-admin",
        })
      ).id;
      await db.suggestedConnector.create({
        data: {
          id: "sug-1",
          projectId: "proj-1",
          driverType: "postgresql",
          host: "db.example.test",
          port: 5432,
          database: "appdb",
          sourceFile: ".env.development",
          lineNumber: 1,
          confidence: "high",
          username: "app",
          passwordVaultRef: DB_SECRET_ID,
          devCredsDetected: true,
        },
      });

      // A suggestion discovered without a port: discovery stores the missing
      // port as 0, and the wizard sends it back as `port: null`.
      await db.suggestedConnector.create({
        data: {
          id: "sug-noport",
          projectId: "proj-1",
          driverType: "postgresql",
          host: "db0.invalid",
          port: 0,
          database: "noportdb",
          sourceFile: ".env.development",
          lineNumber: 3,
          confidence: "high",
          username: "app",
          passwordVaultRef: DB_SECRET_ID,
          devCredsDetected: true,
        },
      });

      // A second suggestion whose vaulted password has since been deleted.
      const goneId = (
        await vault.create("deleted-db-password", "gone-324", "project", {
          createdById: "u-admin",
        })
      ).id;
      await vault.delete(goneId);
      await db.suggestedConnector.create({
        data: {
          id: "sug-gone",
          projectId: "proj-1",
          driverType: "postgresql",
          host: "db2.example.test",
          port: 5432,
          database: "otherdb",
          sourceFile: ".env.development",
          lineNumber: 2,
          confidence: "high",
          passwordVaultRef: goneId,
          devCredsDetected: true,
        },
      });

      for (const role of Object.keys(userOf) as Role[]) {
        tokens[role] = issueTokens({
          userId: userOf[role],
          username: userOf[role],
          role,
          permissions: [],
          workspaces: role === "admin" ? [] : ["ws-1"],
        }).accessToken;
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      __resetVaultSingleton();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    describe("GET /api/vault/:id/reveal", () => {
      it("an admin reveals the plaintext, and the reveal is audited without the value", async () => {
        const res = await call("get", `/api/vault/${SECRET_ID}/reveal`, tokens.admin);
        expect(res.status).toBe(200);
        expect(res.body.data.plaintext).toBe(PLAINTEXT);

        const row = await latestRevealBy(SECRET_ID, "u-admin");
        expect(row).toBeDefined();
        const meta = JSON.parse(row!.metadata ?? "{}") as Record<string, unknown>;
        expect(meta.outcome).toBe("granted");
        expect(JSON.stringify(row)).not.toContain(PLAINTEXT);
      });

      for (const role of ["coordinator", "developer", "reader"] as const) {
        it(`a ${role} is refused 403 without the plaintext, and the refusal is audited`, async () => {
          const res = await call("get", `/api/vault/${SECRET_ID}/reveal`, tokens[role]);
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe("FORBIDDEN");
          expect(JSON.stringify(res.body)).not.toContain(PLAINTEXT);

          const row = await latestRevealBy(SECRET_ID, userOf[role]);
          expect(row).toBeDefined();
          const meta = JSON.parse(row!.metadata ?? "{}") as Record<string, unknown>;
          expect(meta.outcome).toBe("denied");
          expect(JSON.stringify(row)).not.toContain(PLAINTEXT);
        });
      }

      it("a non-admin gets the same 403 for an unknown id — no existence oracle", async () => {
        const res = await call("get", "/api/vault/does-not-exist/reveal", tokens.developer);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("FORBIDDEN");
      });

      it("an admin's reveal of an unknown id is a 404, audited as not_found", async () => {
        const res = await call("get", "/api/vault/missing-324/reveal", tokens.admin);
        expect(res.status).toBe(404);
        const row = await latestRevealBy("missing-324", "u-admin");
        expect(row).toBeDefined();
        expect((JSON.parse(row!.metadata ?? "{}") as Record<string, unknown>).outcome).toBe(
          "not_found",
        );
      });

      it("anonymous: 401", async () => {
        const res = await call("get", `/api/vault/${SECRET_ID}/reveal`);
        expect(res.status).toBe(401);
        expect(JSON.stringify(res.body)).not.toContain(PLAINTEXT);
      });
    });

    describe("non-admins keep vault.read and the use of a secret", () => {
      it("a developer and a coordinator still list the vault (metadata, no plaintext)", async () => {
        for (const role of ["developer", "coordinator"] as const) {
          const res = await call("get", "/api/vault", tokens[role]);
          expect(res.status).toBe(200);
          expect((res.body.data.items as Array<{ id: string }>).map((i) => i.id)).toContain(
            SECRET_ID,
          );
          expect(JSON.stringify(res.body)).not.toContain(PLAINTEXT);
        }
      });

      it("a developer can still point a chat session at the secret (#305 unchanged)", async () => {
        const res = await call("post", "/api/ai/sessions", tokens.developer, {
          providerSecretRef: SECRET_ID,
        });
        expect(res.status).toBe(201);
        expect(res.body.data.session.providerSecretRef).toBe(SECRET_ID);
        expect(JSON.stringify(res.body)).not.toContain(PLAINTEXT);
      });

      it("a reader still cannot use it (#305 unchanged)", async () => {
        const res = await call("post", "/api/ai/sessions", tokens.reader, {
          providerSecretRef: SECRET_ID,
        });
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("SECRET_NOT_FOUND");
      });
    });

    describe("suggested-connector detail follows the reveal rule", () => {
      const detail = "/api/projects/proj-1/suggested-connectors/sug-1";

      it("an admin receives the vaulted password", async () => {
        const res = await call("get", detail, tokens.admin);
        expect(res.status).toBe(200);
        expect(res.body.data.password).toBe(DB_PASSWORD);
        expect(res.body.data.passwordWithheld).toBe(false);
      });

      it("a coordinator (connector.write) sees that a password is stored, never its value", async () => {
        const res = await call("get", detail, tokens.coordinator);
        expect(res.status).toBe(200);
        expect(res.body.data.password).toBeNull();
        expect(res.body.data.hasStoredPassword).toBe(true);
        expect(res.body.data.passwordWithheld).toBe(true);
        expect(JSON.stringify(res.body)).not.toContain(DB_PASSWORD);
      });

      it("a coordinator provisioning without a password reuses the stored secret server-side", async () => {
        const res = await call("post", `${detail}/provision`, tokens.coordinator, {
          label: "appdb-324",
          driver: "postgres",
          host: "db.example.test",
          port: 5432,
          database: "appdb",
          username: "app",
          password: "",
        });
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain(DB_PASSWORD);
        const conn = await db.databaseConnection.findUnique({
          where: { id: res.body.data.connectorId as string },
        });
        expect(conn?.secretId).toBe(DB_SECRET_ID);
      });

      it("a stored password that was deleted is not reused — the connector gets no secret", async () => {
        const res = await call(
          "post",
          "/api/projects/proj-1/suggested-connectors/sug-gone/provision",
          tokens.coordinator,
          {
            label: "otherdb-324",
            driver: "postgres",
            host: "db2.example.test",
            port: 5432,
            database: "otherdb",
            username: null,
            password: "",
          },
        );
        expect(res.status).toBe(200);
        const conn = await db.databaseConnection.findUnique({
          where: { id: res.body.data.connectorId as string },
        });
        expect(conn?.secretId).toBeNull();
      });
    });

    describe("a stored password stays bound to the suggestion's own destination", () => {
      const base = "/api/projects/proj-1/suggested-connectors/sug-1";
      const provisionBody = {
        driver: "postgres",
        host: "db.example.test",
        port: 5432,
        database: "appdb",
        username: "app",
        password: "",
      };
      const refusalAudited = async () => {
        await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
        return db.auditLog.findMany({
          where: {
            action: "suggested_connector.stored_secret_refused",
            targetId: "sug-1",
            actorId: "u-coord",
          },
        });
      };

      for (const [what, body] of [
        ["host", { host: "exfil.invalid" }],
        ["port", { port: 6543 }],
      ] as const) {
        it(`/test: a coordinator using the stored password against a changed ${what} is refused 403`, async () => {
          const before = (await refusalAudited()).length;
          const res = await call("post", `${base}/test`, tokens.coordinator, {
            host: "db.example.test",
            port: 5432,
            database: "appdb",
            username: "app",
            ...body,
          });
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe("STORED_SECRET_DESTINATION_MISMATCH");
          expect(JSON.stringify(res.body)).not.toContain(DB_PASSWORD);
          expect((await refusalAudited()).length).toBe(before + 1);
        });
      }

      for (const [what, body] of [
        ["host", { host: "exfil.invalid" }],
        ["port", { port: 6543 }],
        ["driver", { driver: "mysql" }],
      ] as const) {
        it(`/provision: a coordinator reusing the stored password with a changed ${what} is refused 403`, async () => {
          const label = `appdb-324-bound-${what}`;
          const res = await call("post", `${base}/provision`, tokens.coordinator, {
            ...provisionBody,
            label,
            ...body,
          });
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe("STORED_SECRET_DESTINATION_MISMATCH");
          const leaked = await db.databaseConnection.findFirst({ where: { label } });
          expect(leaked).toBeNull();
        });
      }

      it("/provision: a hostname differing only in case and whitespace is the same destination", async () => {
        const res = await call("post", `${base}/provision`, tokens.coordinator, {
          ...provisionBody,
          label: "appdb-324-case",
          host: " DB.Example.TEST ",
        });
        expect(res.status).toBe(200);
      });

      it("/provision: an omitted port falls back to the suggestion's own, like /test", async () => {
        const res = await call("post", `${base}/provision`, tokens.coordinator, {
          ...provisionBody,
          label: "appdb-324-port-fallback",
          port: null,
        });
        expect(res.status).toBe(200);
        const conn = await db.databaseConnection.findUnique({
          where: { id: res.body.data.connectorId as string },
        });
        // The connector targets the port the guard checked, not the driver default.
        expect(conn?.port).toBe(5432);
        expect(conn?.secretId).toBe(DB_SECRET_ID);
      });

      it("/provision: an admin (vault.reveal) may use the stored password elsewhere", async () => {
        const res = await call("post", `${base}/provision`, tokens.admin, {
          ...provisionBody,
          label: "appdb-324-admin",
          host: "elsewhere.invalid",
        });
        expect(res.status).toBe(200);
        const conn = await db.databaseConnection.findUnique({
          where: { id: res.body.data.connectorId as string },
        });
        expect(conn?.secretId).toBe(DB_SECRET_ID);
      });
    });

    describe("a suggestion discovered without a port (stored as 0)", () => {
      const base = "/api/projects/proj-1/suggested-connectors/sug-noport";
      const noPortBody = {
        host: "db0.invalid",
        port: null,
        database: "noportdb",
        username: "app",
      };
      // What the wizard sends with the password field left blank: /test gets
      // `password: null` and /provision gets `password: ""` (db-connector-wizard.tsx).
      const blank = { test: { password: null }, provision: { password: "" } } as const;
      const auditFor = async (action: string) => {
        await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
        return db.auditLog.findMany({
          where: { action, targetId: "sug-noport", actorId: "u-coord" },
        });
      };

      it("/test: a coordinator sending port null with the stored password passes the guard", async () => {
        const before = (await auditFor("suggested_connector.test")).length;
        const res = await call("post", `${base}/test`, tokens.coordinator, {
          ...noPortBody,
          ...blank.test,
        });
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain(DB_PASSWORD);
        // Past the guard the probe ran (and failed to resolve `.invalid`).
        expect((await auditFor("suggested_connector.test")).length).toBe(before + 1);
        expect(await auditFor("suggested_connector.stored_secret_refused")).toHaveLength(0);
      });

      it("/provision: a coordinator sending port null with the stored password succeeds", async () => {
        const res = await call("post", `${base}/provision`, tokens.coordinator, {
          ...noPortBody,
          ...blank.provision,
          label: "noportdb-324",
          driver: "postgres",
        });
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain(DB_PASSWORD);
        const conn = await db.databaseConnection.findUnique({
          where: { id: res.body.data.connectorId as string },
        });
        expect(conn?.secretId).toBe(DB_SECRET_ID);
        expect(conn?.port ?? null).toBeNull();
      });

      for (const route of ["test", "provision"] as const) {
        it(`/${route}: a coordinator naming a real port 5433 is still refused 403`, async () => {
          const label = `noportdb-324-5433-${route}`;
          const res = await call("post", `${base}/${route}`, tokens.coordinator, {
            ...noPortBody,
            ...blank[route],
            port: 5433,
            ...(route === "provision" ? { label, driver: "postgres" } : {}),
          });
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe("STORED_SECRET_DESTINATION_MISMATCH");
          expect(await db.databaseConnection.findFirst({ where: { label } })).toBeNull();
        });
      }
    });

    describe("reveal rate limit", () => {
      it("answers 429 once one IP exceeds VAULT_REVEAL_LIMIT_MAX, before auth runs", async () => {
        process.env.VAULT_REVEAL_LIMIT_MAX = "2";
        __resetVaultRevealRateLimiter();
        try {
          const hit = (bearer?: string) => {
            const r = request(app())
              .get(`/api/vault/${SECRET_ID}/reveal`)
              .set("X-Forwarded-For", "192.0.2.77");
            return bearer ? r.set("Authorization", `Bearer ${bearer}`) : r;
          };
          expect((await hit(tokens.admin)).status).toBe(200);
          expect((await hit()).status).toBe(401);
          const limited = await hit(tokens.admin);
          expect(limited.status).toBe(429);
          expect(limited.body.error.code).toBe("VAULT_REVEAL_RATE_LIMITED");
          expect(JSON.stringify(limited.body)).not.toContain(PLAINTEXT);
        } finally {
          delete process.env.VAULT_REVEAL_LIMIT_MAX;
          __resetVaultRevealRateLimiter();
        }
      });
    });
  },
);
