/**
 * #2382 — `GET /api/vault` says, per secret, whether the caller may attach it
 * (`bindable`), so the picker can offer a non-admin only the secrets they can
 * bind. #344 rule 1: without `vault.reveal` a caller may attach only a secret
 * they created. Proven through the REAL router and vault service against a REAL
 * SQLite database built from the migration chain, and checked against the
 * binding rule itself (`refsOwnedBy`), so the flag cannot drift from what the
 * write path accepts.
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
const { refsOwnedBy } = await import("../src/lib/vault/secret-binding.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");

type Role = "admin" | "coordinator" | "developer";
const userOf: Record<Role, string> = {
  admin: "u-admin",
  coordinator: "u-coord",
  developer: "u-dev",
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2382 — the vault list flags the secrets the caller may attach",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const tokens: Record<Role, string> = { admin: "", coordinator: "", developer: "" };

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/vault", vaultRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const list = (role: Role) =>
      request(app()).get("/api/vault").set("Authorization", `Bearer ${tokens[role]}`);
    const bindableByLabel = (items: Array<{ label: string; bindable: boolean }>) =>
      Object.fromEntries(items.map((i) => [i.label, i.bindable]));

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2382-vault-bindable");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      __resetVaultSingleton();
      for (const id of Object.values(userOf)) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      const vault = getVaultService();
      await vault.create("admin-pat", "a", "global", { createdById: "u-admin" });
      await vault.create("dev-pat", "d", "global", { createdById: "u-dev" });
      await vault.create("coord-db", "c", "project", { createdById: "u-coord" });
      // System-written (credential discovery): nobody's, so only an admin binds it.
      await vault.create("discovered", "s", "project", { createdById: null });
      for (const role of Object.keys(userOf) as Role[]) {
        tokens[role] = issueTokens({
          userId: userOf[role],
          username: userOf[role],
          role,
          permissions: [],
          workspaces: [],
        }).accessToken;
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      __resetVaultSingleton();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("a developer may attach only the secret they created", async () => {
      const res = await list("developer");
      expect(res.status).toBe(200);
      expect(bindableByLabel(res.body.data.items)).toEqual({
        "admin-pat": false,
        "dev-pat": true,
        "coord-db": false,
        discovered: false,
      });
    });

    it("a coordinator may attach only theirs", async () => {
      const res = await list("coordinator");
      expect(bindableByLabel(res.body.data.items)).toEqual({
        "admin-pat": false,
        "dev-pat": false,
        "coord-db": true,
        discovered: false,
      });
    });

    it("an admin (vault.reveal) may attach every secret, including a system-written one", async () => {
      const res = await list("admin");
      expect(Object.values(bindableByLabel(res.body.data.items))).toEqual([true, true, true, true]);
    });

    it("agrees with the binding rule the write path enforces", async () => {
      for (const role of ["developer", "coordinator"] as const) {
        const items = (await list(role)).body.data.items as Array<{
          label: string;
          bindable: boolean;
        }>;
        const owned = await refsOwnedBy(
          userOf[role],
          items.map((i) => i.label),
        );
        for (const item of items)
          expect(item.bindable, `${role} ${item.label}`).toBe(owned.has(item.label));
      }
    });

    it("names no owner: the list carries the flag, not who created the secret", async () => {
      const res = await list("developer");
      for (const item of res.body.data.items) {
        expect(item).not.toHaveProperty("createdById");
        expect(JSON.stringify(item)).not.toContain("u-admin");
      }
    });
  },
);
