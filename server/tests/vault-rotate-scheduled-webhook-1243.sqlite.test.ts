/**
 * #1243 — the #502 "Rotate anyway" bindings list names scheduled `http-webhook`
 * jobs whose `authHeader` references the secret (a secret-binding surface since
 * #1235), proven through the REAL vault router and vault service against a
 * REAL SQLite database built from the migration chain.
 *
 * The 409 lists the job by name and project with only the URL's origin, never
 * the path, query, body or headers. Re-pointing the job after the admin was
 * shown the list refuses the confirm, and confirming the live list rotates.
 * Rotation is `vault.write`, which only the admin role holds.
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
  process.env.RATE_LIMIT_MAX = "100000";
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
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");

const OWNER_VALUE = "coordinator-own-token-1243";
const ADMIN_VALUE = "admin-real-token-1243";
const HOOK_PATH = "/services/T0/B0/PATHSECRET1243";

type Shown = { type: string; id: string; destination: string | null; routing: string };

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1243 — the Rotate-anyway bindings list names scheduled webhook jobs",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let adminToken = "";
    let n = 0;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/vault", vaultRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const rotate = (id: string, body: Record<string, unknown>) =>
      request(app())
        .post(`/api/vault/${id}/rotate`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send(body);
    const newSecret = async () => {
      n += 1;
      return (
        await getVaultService().create(`s1243-${n}`, OWNER_VALUE, "global", {
          createdById: "u-coord",
        })
      ).id;
    };
    const webhookJob = (
      id: string,
      secretRef: string,
      over: { projectId?: string | null; deletedAt?: Date; taskType?: string } = {},
    ) =>
      db.scheduledJob.create({
        data: {
          id,
          key: id,
          name: `Job ${id}`,
          cron: "0 * * * *",
          taskType: over.taskType ?? "http-webhook",
          projectId: over.projectId === undefined ? "proj-1243" : over.projectId,
          createdById: "u-coord",
          webhookBinderId: "u-coord",
          webhookBoundAt: new Date(),
          ...(over.deletedAt ? { deletedAt: over.deletedAt } : {}),
          payload: JSON.stringify({
            url: `https://hooks.coord.example${HOOK_PATH}?token=QUERYSECRET`,
            authHeader: `\${vault:${secretRef}}`,
            body: { note: "PRIVATE-BODY" },
            headers: { "x-team": "PRIVATE-HEADER" },
          }),
        },
      });
    const shownIn = (res: request.Response): Shown[] =>
      (res.body.error.details.bindings as Shown[]).map(({ type, id, destination, routing }) => ({
        type,
        id,
        destination,
        routing,
      }));

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1243-vault-rotate-webhook");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      __resetVaultSingleton();
      for (const [id, displayName] of [
        ["u-admin", "Ada Admin"],
        ["u-coord", "Cora Coordinator"],
      ]) {
        await db.user.create({
          data: { id, username: id, displayName, email: `${id}@example.test` },
        });
      }
      await db.project.create({
        data: { id: "proj-1243", name: "Ledger", slug: "ledger-1243", createdById: "u-coord" },
      });
      adminToken = issueTokens({
        userId: "u-admin",
        username: "u-admin",
        role: "admin",
        permissions: [],
        workspaces: [],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      __resetVaultSingleton();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("lists a webhook job bound by id or label, by name and project, and nothing of its payload", async () => {
      const id = await newSecret();
      await webhookJob("job-by-id", id);
      await webhookJob("job-by-label", `s1243-${n}`, { projectId: null });
      // Not bindings: a deleted job, another secret, a non-webhook task type.
      await webhookJob("job-deleted", id, { deletedAt: new Date() });
      await webhookJob("job-other", "someone-else");
      await webhookJob("job-not-webhook", id, { taskType: "rerun-analysis" });

      const res = await rotate(id, { value: ADMIN_VALUE });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_FOREIGN_OWNER");
      const bindings = res.body.error.details.bindings as Array<Record<string, unknown>>;
      expect(bindings).toEqual([
        {
          type: "scheduled_webhook_job",
          id: "job-by-id",
          label: "Job job-by-id (project Ledger)",
          projectId: "proj-1243",
          destination: "https://hooks.coord.example",
          routing: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        {
          type: "scheduled_webhook_job",
          id: "job-by-label",
          label: "Job job-by-label (no project)",
          projectId: null,
          destination: "https://hooks.coord.example",
          routing: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ]);
      expect(res.body.error.message).toContain("Job job-by-id (project Ledger)");
      const wire = JSON.stringify(res.body);
      for (const leak of [
        "PATHSECRET1243",
        "QUERYSECRET",
        "PRIVATE-BODY",
        "PRIVATE-HEADER",
        "services",
      ]) {
        expect(wire).not.toContain(leak);
      }
      expect(
        await getVaultService()
          .read(id)
          .then((s) => s.plaintext),
      ).toBe(OWNER_VALUE);
    });

    it("re-pointing the job after the list was shown refuses the confirm; the live list rotates", async () => {
      const id = await newSecret();
      await webhookJob("job-repoint", id);
      const first = await rotate(id, { value: ADMIN_VALUE });
      const shown = shownIn(first);
      expect(shown.map((b) => b.id)).toEqual(["job-repoint"]);

      // Same origin, new path: the listing looks the same, the routing does not.
      await db.scheduledJob.update({
        where: { id: "job-repoint" },
        data: {
          payload: JSON.stringify({
            url: "https://hooks.coord.example/elsewhere",
            authHeader: `\${vault:${id}}`,
          }),
        },
      });
      const stale = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindings: shown,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe("VAULT_ROTATE_BINDINGS_CHANGED");
      const fresh = shownIn(stale);
      expect(fresh[0]!.destination).toBe(shown[0]!.destination);
      expect(fresh[0]!.routing).not.toBe(shown[0]!.routing);
      expect(
        await getVaultService()
          .read(id)
          .then((s) => s.plaintext),
      ).toBe(OWNER_VALUE);

      const ok = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindings: fresh,
      });
      expect(ok.status).toBe(200);
      expect(
        await getVaultService()
          .read(id)
          .then((s) => s.plaintext),
      ).toBe(ADMIN_VALUE);
    });
  },
);
