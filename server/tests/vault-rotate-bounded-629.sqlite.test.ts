/**
 * #629 — an owner who inflates a secret's bindings cannot inflate what the
 * admin's 409 or the `vault.rotate` audit row carries. The 409 lists at most
 * `MAX_CONFIRMED_BINDINGS` bindings plus the total, per-type / per-host counts
 * and the set digest; a confirm over the cap audits the digest, total and
 * counts instead of every binding. Asserted at the cap, at cap+1 and at a set
 * five times the cap, through the REAL vault router, vault service and audit
 * service against a REAL SQLite database built from the migration chain.
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
const { MAX_CONFIRMED_BINDINGS, MAX_HOST_ROWS, MAX_NAMED_BINDINGS } =
  await import("../src/lib/vault/rotate-foreign-owner.js");
const { JSON_LIMIT_BYTES } = await import("../src/lib/config/json-limit.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");

const OWNER_VALUE = "owner-own-token-629";
const ADMIN_VALUE = "admin-real-token-629";
const CAP = MAX_CONFIRMED_BINDINGS;
/** Large enough that an unbounded listing would be several times the capped one. */
const HUGE = 5 * CAP;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#629 — the 409 listing and the audit row are bounded however many bindings a secret has",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let adminToken = "";
    let n = 0;

    const rotate = (id: string, body: Record<string, unknown>) => {
      const a = express();
      a.use(express.json({ limit: JSON_LIMIT_BYTES }));
      a.use("/api/vault", vaultRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return request(a)
        .post(`/api/vault/${id}/rotate`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send(body);
    };
    const plaintextOf = async (id: string) => (await getVaultService().read(id)).plaintext;
    const rotateAudit = async (id: string) => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      return db.auditLog.findMany({
        where: { action: "vault.rotate", targetType: "secret", targetId: id },
      });
    };
    const newSecret = async (createdById: string) => {
      n += 1;
      return (await getVaultService().create(`s629-${n}`, OWNER_VALUE, "global", { createdById }))
        .id;
    };
    /** Bind `count` DB connectors to the secret, as an inflating owner would. */
    const bindMany = (secretId: string, count: number, prefix: string) =>
      db.databaseConnection.createMany({
        data: Array.from({ length: count }, (_, i) => ({
          id: `${prefix}-${i}`,
          projectId: "proj-629",
          label: `${prefix}-${i}`,
          driver: "postgres",
          host: `h${i}.owner.example`,
          secretId,
        })),
      });
    beforeAll(async () => {
      sqlite = createMigratedSqlite("629-vault-rotate-bounded");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      __resetVaultSingleton();
      for (const [id, displayName] of [
        ["u-admin", "Ada Admin"],
        ["u-owner", "Olly Owner"],
      ]) {
        await db.user.create({
          data: { id, username: id, displayName, email: `${id}@example.test` },
        });
      }
      await db.project.create({
        data: { id: "proj-629", name: "proj-629", slug: "proj-629", createdById: "u-owner" },
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

    type View = {
      bindings: Array<Record<string, unknown>>;
      bindingsTotal: number;
      bindingsTruncated: boolean;
      bindingsDigest: string;
      bindingCounts: {
        byType: Array<{ type: string; count: number }>;
        byHost: Array<{ host: string; count: number }>;
        moreHosts: { hosts: number; bindings: number };
        withoutHost: number;
      };
    };
    /** The refusal, its parsed details, and its size on the wire. */
    const refusal = async (id: string) => {
      const res = await rotate(id, { value: ADMIN_VALUE });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_FOREIGN_OWNER");
      return { res, view: res.body.error.details as View, bytes: res.text.length };
    };
    /** Confirm by digest and return the one `vault.rotate` row's metadata and size. */
    const confirmAndAudit = async (id: string, digest: string) => {
      const res = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindingsDigest: digest,
      });
      expect(res.status).toBe(200);
      expect(await plaintextOf(id)).toBe(ADMIN_VALUE);
      const rows = await rotateAudit(id);
      expect(rows).toHaveLength(1);
      const raw = rows[0]!.metadata ?? "{}";
      return { meta: JSON.parse(raw) as Record<string, unknown>, bytes: raw.length };
    };

    const sizes: Record<string, { body: number; audit: number }> = {};

    it("at the cap: every binding listed, untruncated, and audited one by one", async () => {
      const id = await newSecret("u-owner");
      await bindMany(id, CAP, "cap");
      const { view, bytes } = await refusal(id);
      expect(view.bindings).toHaveLength(CAP);
      expect(view.bindingsTotal).toBe(CAP);
      expect(view.bindingsTruncated).toBe(false);
      expect(view.bindingCounts.byType).toEqual([{ type: "db_connector", count: CAP }]);
      const { meta, bytes: audit } = await confirmAndAudit(id, view.bindingsDigest);
      const recorded = meta.confirmedBindings as Array<{ id: string; destination: string }>;
      expect(recorded).toHaveLength(CAP);
      expect(recorded.find((b) => b.id === "cap-7")?.destination).toBe(
        "postgres://h7.owner.example",
      );
      sizes.cap = { body: bytes, audit };
    });

    it("at cap+1: the first cap listed, the whole set counted, and the audit row is the digest", async () => {
      const id = await newSecret("u-owner");
      await bindMany(id, CAP + 1, "cap1");
      const { res, view, bytes } = await refusal(id);
      expect(view.bindings).toHaveLength(CAP);
      expect(view.bindingsTotal).toBe(CAP + 1);
      expect(view.bindingsTruncated).toBe(true);
      expect(view.bindingCounts.byType).toEqual([{ type: "db_connector", count: CAP + 1 }]);
      expect(view.bindingCounts.byHost).toHaveLength(MAX_HOST_ROWS);
      expect(view.bindingCounts.moreHosts).toEqual({
        hosts: CAP + 1 - MAX_HOST_ROWS,
        bindings: CAP + 1 - MAX_HOST_ROWS,
      });
      expect(res.body.error.message).toContain(`and ${CAP + 1 - MAX_NAMED_BINDINGS} more.`);
      const { meta, bytes: audit } = await confirmAndAudit(id, view.bindingsDigest);
      expect(meta).not.toHaveProperty("confirmedBindings");
      expect(meta.confirmedBindingsDigest).toBe(view.bindingsDigest);
      expect(meta.confirmedBindingsTotal).toBe(CAP + 1);
      expect(meta.confirmedBindingCounts).toEqual(view.bindingCounts);
      sizes.capPlus1 = { body: bytes, audit };
    });

    it("five times the cap: the 409 and the audit row are no bigger than at cap+1", async () => {
      const id = await newSecret("u-owner");
      await bindMany(id, HUGE, "huge");
      const { res, view, bytes } = await refusal(id);
      expect(view.bindings).toHaveLength(CAP);
      expect(view.bindingsTotal).toBe(HUGE);
      expect(view.bindingsTruncated).toBe(true);
      expect(res.body.error.message.length).toBeLessThan(2000);
      const { meta, bytes: audit } = await confirmAndAudit(id, view.bindingsDigest);
      expect(meta.confirmedBindingsTotal).toBe(HUGE);

      // Bounded: only the digits of the totals and counts may grow with the set.
      expect(sizes.capPlus1).toBeDefined();
      expect(Math.abs(bytes - sizes.capPlus1!.body)).toBeLessThan(64);
      expect(Math.abs(audit - sizes.capPlus1!.audit)).toBeLessThan(64);
      // And the over-cap audit row is a small fraction of the per-binding one at the cap.
      expect(audit).toBeLessThan(2000);
      expect(audit * 10).toBeLessThan(sizes.cap!.audit);
    });
  },
);
