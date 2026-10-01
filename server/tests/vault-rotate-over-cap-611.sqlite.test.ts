/**
 * #611 — a foreign secret with more live bindings than a list confirm may carry
 * (`MAX_CONFIRMED_BINDINGS`) is still confirmable: the 409 issues one
 * `bindingsDigest` over the whole set, and a confirm that echoes it as
 * `confirmedBindingsDigest` rotates the secret and transfers ownership. So an
 * owner cannot block an admin takeover by inflating bindings past the cap.
 *
 * Proven through the REAL vault router, vault service and audit service against
 * a REAL SQLite database built from the migration chain, behind the app's real
 * 10 MiB JSON parser limit. Every refusal is read back: the stored value still
 * decrypts to the owner's and no `vault.rotate` audit row was written.
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

const { vaultRouter, MAX_CONFIRMED_BINDINGS, digestsEqual } =
  await import("../src/routes/vault.js");
const { assertSecretBindingAllowed } = await import("../src/lib/vault/secret-binding.js");
const { JSON_LIMIT_BYTES } = await import("../src/lib/config/json-limit.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");

const OWNER_VALUE = "owner-own-token-611";
const ADMIN_VALUE = "admin-real-token-611";
const OVER_CAP = MAX_CONFIRMED_BINDINGS + 1;
const OWNER = { userId: "u-owner", role: "coordinator" as const };

describe("#611 — digestsEqual (PR #627 review: constant-time compare)", () => {
  const digest = "ab".repeat(32);
  it("is true only for the identical digest", () => {
    expect(digestsEqual(digest, digest)).toBe(true);
    expect(digestsEqual(`${"ab".repeat(31)}ac`, digest)).toBe(false);
  });
  it("is false, not a throw, for digests of unequal length", () => {
    expect(digestsEqual(digest.slice(1), digest)).toBe(false);
    expect(digestsEqual("", digest)).toBe(false);
  });
});

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#611 — a foreign secret over the list-confirm cap is confirmed by its bindings digest",
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
      return (await getVaultService().create(`s611-${n}`, OWNER_VALUE, "global", { createdById }))
        .id;
    };
    /** Bind `count` DB connectors to the secret, as an inflating owner would. */
    const bindMany = (secretId: string, count: number, prefix: string) =>
      db.databaseConnection.createMany({
        data: Array.from({ length: count }, (_, i) => ({
          id: `${prefix}-${i}`,
          projectId: "proj-611",
          label: `${prefix}-${i}`,
          driver: "postgres",
          host: `h${i}.owner.example`,
          secretId,
        })),
      });
    type Listed = { bindingsDigest: string; maxConfirmedBindings: number; bindings: unknown[] };
    const listed = (res: request.Response) => res.body.error.details as Listed;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("611-vault-rotate-over-cap");
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
        data: { id: "proj-611", name: "proj-611", slug: "proj-611", createdById: "u-owner" },
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

    it("lists every binding over the cap, then the echoed digest rotates it and transfers ownership", async () => {
      const id = await newSecret("u-owner");
      await bindMany(id, OVER_CAP, "big");

      const first = await rotate(id, { value: ADMIN_VALUE });
      expect(first.status).toBe(409);
      expect(first.body.error.code).toBe("VAULT_ROTATE_FOREIGN_OWNER");
      const shown = listed(first);
      expect(shown.bindings).toHaveLength(OVER_CAP);
      expect(shown.maxConfirmedBindings).toBe(MAX_CONFIRMED_BINDINGS);
      expect(shown.bindingsDigest).toMatch(/^[0-9a-f]{64}$/);

      // Echoing the whole list is over the cap: a 400, which is why the digest exists.
      const echoed = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindings: (shown.bindings as Array<Record<string, unknown>>).map(
          ({ type, id: bid, destination, routing }) => ({ type, id: bid, destination, routing }),
        ),
      });
      expect(echoed.status).toBe(400);
      expect(echoed.body.error.code).toBe("INVALID_BODY");
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);

      const res = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindingsDigest: shown.bindingsDigest,
      });
      expect(res.status).toBe(200);
      // Read back through the service and the owner column the binding check uses.
      expect(await plaintextOf(id)).toBe(ADMIN_VALUE);
      expect((await db.secret.findUniqueOrThrow({ where: { id } })).createdById).toBe("u-admin");

      const rows = await rotateAudit(id);
      expect(rows).toHaveLength(1);
      const meta = JSON.parse(rows[0]!.metadata ?? "{}") as Record<string, unknown>;
      expect(meta.foreignOwnerConfirmed).toBe(true);
      expect(meta.ownerId).toBe("u-owner");
      expect(meta.ownershipTransferredTo).toBe("u-admin");
      // The audit keeps every destination the digest stood for.
      const recorded = meta.confirmedBindings as Array<{ id: string; destination: string }>;
      expect(recorded).toHaveLength(OVER_CAP);
      expect(recorded.find((b) => b.id === "big-7")?.destination).toBe(
        "postgres://h7.owner.example",
      );
    });

    it("a binding re-pointed after the 409 refuses the digest with the fresh list and digest", async () => {
      const id = await newSecret("u-owner");
      await bindMany(id, OVER_CAP, "rp");
      const first = listed(await rotate(id, { value: ADMIN_VALUE }));

      await db.databaseConnection.update({
        where: { id: "rp-500" },
        data: { host: "evil.owner.example" },
      });
      const res = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindingsDigest: first.bindingsDigest,
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_BINDINGS_CHANGED");
      const fresh = listed(res);
      expect(fresh.bindingsDigest).not.toBe(first.bindingsDigest);
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
      expect(await rotateAudit(id)).toHaveLength(0);

      // The fresh digest, reviewed, confirms.
      const again = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindingsDigest: fresh.bindingsDigest,
      });
      expect(again.status).toBe(200);
      expect(await plaintextOf(id)).toBe(ADMIN_VALUE);
    });

    it("a binding added after the 409 refuses the digest", async () => {
      const id = await newSecret("u-owner");
      await bindMany(id, 2, "add");
      const first = listed(await rotate(id, { value: ADMIN_VALUE }));
      await bindMany(id, 1, "add-late");
      const res = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindingsDigest: first.bindingsDigest,
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_BINDINGS_CHANGED");
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
      expect(await rotateAudit(id)).toHaveLength(0);
    });

    it("another secret's digest, even with identical bindings, does not confirm this one", async () => {
      const a = await newSecret("u-owner");
      const b = await newSecret("u-owner");
      const digestOfA = listed(await rotate(a, { value: ADMIN_VALUE })).bindingsDigest;
      const res = await rotate(b, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindingsDigest: digestOfA,
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_BINDINGS_CHANGED");
      expect(await plaintextOf(b)).toBe(OWNER_VALUE);
    });

    it("a list and a digest sent together must both match the live set", async () => {
      const id = await newSecret("u-owner");
      await bindMany(id, 1, "both");
      const first = listed(await rotate(id, { value: ADMIN_VALUE }));
      const list = (first.bindings as Array<Record<string, unknown>>).map(
        ({ type, id: bid, destination, routing }) => ({ type, id: bid, destination, routing }),
      );
      const staleDigest = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindings: list,
        confirmedBindingsDigest: "ab".repeat(32),
      });
      expect(staleDigest.status).toBe(409);
      expect(staleDigest.body.error.code).toBe("VAULT_ROTATE_BINDINGS_CHANGED");
      const staleList = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindings: [],
        confirmedBindingsDigest: first.bindingsDigest,
      });
      expect(staleList.status).toBe(409);
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);

      const ok = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindings: list,
        confirmedBindingsDigest: first.bindingsDigest,
      });
      expect(ok.status).toBe(200);
    });

    it("a digest without confirmForeignOwner is the plain refusal, and writes nothing", async () => {
      const id = await newSecret("u-owner");
      const digest = listed(await rotate(id, { value: ADMIN_VALUE })).bindingsDigest;
      const res = await rotate(id, { value: ADMIN_VALUE, confirmedBindingsDigest: digest });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_FOREIGN_OWNER");
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
      expect(await rotateAudit(id)).toHaveLength(0);
    });

    // -- PR #627 review: a digest-only confirm through the #552 race path. The
    // compare-and-swap misses on the write, and `refuseIfBindingsMoved`
    // re-checks the live set against what the digest stood for. --
    /** Run `between` inside the rotation, after its bindings read and before its UPDATE. */
    const betweenReadAndWrite = (between: () => Promise<void>) => {
      const svc = getVaultService();
      const real = svc.rotate.bind(svc);
      return vi.spyOn(svc, "rotate").mockImplementationOnce(async (...args) => {
        await between();
        return real(...args);
      });
    };
    /** The owner's binding check: stamps the secret's binding-write window. */
    const ownerChecks = (secretId: string) =>
      assertSecretBindingAllowed(
        OWNER,
        { before: [], after: [secretId], destinationChanged: true },
        { target: { type: "db_connector", id: "new" } },
      );

    it("a digest-only confirm whose bindings move mid-rotation (a stamped binding write lands) is CHANGED", async () => {
      const id = await newSecret("u-owner");
      await bindMany(id, OVER_CAP, "race");
      const first = listed(await rotate(id, { value: ADMIN_VALUE }));

      // The owner's stamped binding write lands between the rotation's read and its write.
      const spy = betweenReadAndWrite(async () => {
        await ownerChecks(id);
        await bindMany(id, 1, "race-late");
      });
      let res: request.Response;
      try {
        res = await rotate(id, {
          value: ADMIN_VALUE,
          confirmForeignOwner: true,
          confirmedBindingsDigest: first.bindingsDigest,
        });
      } finally {
        spy.mockRestore();
      }

      expect(res.status, JSON.stringify(res.body).slice(0, 500)).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_BINDINGS_CHANGED");
      const fresh = listed(res);
      expect(fresh.bindings).toHaveLength(OVER_CAP + 1);
      expect(fresh.bindingsDigest).not.toBe(first.bindingsDigest);
      // Read back: the owner's value and ownership are unchanged, nothing audited.
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
      expect((await db.secret.findUniqueOrThrow({ where: { id } })).createdById).toBe("u-owner");
      expect(await rotateAudit(id)).toHaveLength(0);
    });

    it("a digest-only confirm whose binding check stamps mid-rotation, write not landed, is IN_PROGRESS", async () => {
      const id = await newSecret("u-owner");
      await bindMany(id, 2, "race-ip");
      const first = listed(await rotate(id, { value: ADMIN_VALUE }));

      const spy = betweenReadAndWrite(async () => {
        await ownerChecks(id);
      });
      let res: request.Response;
      try {
        res = await rotate(id, {
          value: ADMIN_VALUE,
          confirmForeignOwner: true,
          confirmedBindingsDigest: first.bindingsDigest,
        });
      } finally {
        spy.mockRestore();
      }

      expect(res.status, JSON.stringify(res.body).slice(0, 500)).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_BINDING_IN_PROGRESS");
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
      expect((await db.secret.findUniqueOrThrow({ where: { id } })).createdById).toBe("u-owner");
      expect(await rotateAudit(id)).toHaveLength(0);
    });

    it("rejects a digest that is not the 64-hex value the server issues", async () => {
      const id = await newSecret("u-owner");
      for (const digest of ["", "ab", "AB".repeat(32), `${"ab".repeat(32)}0`, 1234, null]) {
        const res = await rotate(id, {
          value: ADMIN_VALUE,
          confirmForeignOwner: true,
          confirmedBindingsDigest: digest,
        });
        expect(res.status, JSON.stringify(digest)).toBe(400);
        expect(res.body.error.code).toBe("INVALID_BODY");
      }
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
    });
  },
);
