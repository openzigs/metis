/**
 * Issue #112 — the #93 config-secret fix, proven against a REAL Postgres.
 *
 * #93 replaced "choose create-vs-rotate from `vault.list()`" with one upsert on
 * the unique `secrets.name`. Its unit tests run against Prisma doubles, which
 * model the unique index and the soft-delete by hand. This suite runs the real
 * `ConfigService` → `VaultService` → Prisma path on a real database, so the
 * behaviour the doubles assert is the behaviour Postgres gives:
 *
 *   - save → clear → save revives the SAME row (the index still holds the
 *     soft-deleted name, so a fresh create could never succeed);
 *   - the cleared row is invisible to `list()` and the revived one visible again;
 *   - two concurrent first saves both succeed and leave one row, whose value the
 *     in-process cache agrees with.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped (via
 * `pnpm test:integration`). CI's `postgres-adapter` job provides the database and
 * syncs the schema with `prisma db push` before this runs.
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { selectPrismaAdapter } from "../src/lib/prisma.js";
import { ConfigService } from "../src/lib/config/config-service.js";
import { getKeyDef } from "../src/lib/config/key-registry.js";
import { VaultService } from "../src/lib/vault/vault-service.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

/** A secret-tier key; stored in the vault as `global:<KEY>`. */
const KEY = "GITHUB_TOKEN";
const ROW_NAME = `global:${KEY}`;

describe.runIf(enabled)("Config secret save → clear → save on real Postgres (integration)", () => {
  // An independent client, so assertions read the table rather than anything
  // the service under test holds.
  const db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
  const vault = new VaultService({
    // 32 bytes of base64 — a test key, not a secret.
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    isProduction: false,
  });

  beforeEach(async () => {
    await db.secret.deleteMany({ where: { name: ROW_NAME } });
  });

  afterAll(async () => {
    await db.secret.deleteMany({ where: { name: ROW_NAME } });
    await db.$disconnect();
  });

  it("revives the soft-deleted row on the second save", async () => {
    const svc = new ConfigService({ vault, env: {} });

    const first = await svc.setSecret(KEY, "gho_first");
    const [created] = await db.secret.findMany({ where: { name: ROW_NAME } });
    expect(created?.id).toBe(first.id);
    expect(created?.deletedAt).toBeNull();

    await svc.clearSecret(KEY);
    const cleared = await db.secret.findMany({ where: { name: ROW_NAME } });
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.deletedAt).not.toBeNull();
    expect((await vault.list("global")).some((s) => s.label === KEY)).toBe(false);
    expect(svc.get(KEY)).toBeUndefined();
    // A row cleared under an older registry description: the revive must not
    // keep it (#112 item 5).
    await db.secret.update({ where: { name: ROW_NAME }, data: { description: "stale" } });

    const second = await svc.setSecret(KEY, "gho_second");
    const rows = await db.secret.findMany({ where: { name: ROW_NAME } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first.id);
    expect(second.id).toBe(first.id);
    expect(rows[0]?.deletedAt).toBeNull();
    expect(rows[0]?.description).toBe(getKeyDef(KEY)?.description);

    // Read back through the path a consumer uses: a FRESH service that loads
    // from the vault, not the cache of the instance that wrote.
    const reader = new ConfigService({ vault, env: {} });
    await reader.loadSecrets();
    expect(reader.get(KEY)).toBe("gho_second");
    expect(reader.describeSource(KEY).source).toBe("vault");
  });

  it("accepts two concurrent first saves and keeps cache and vault agreeing", async () => {
    const svc = new ConfigService({ vault, env: {} });

    await Promise.all([svc.setSecret(KEY, "gho_a"), svc.setSecret(KEY, "gho_b")]);

    const rows = await db.secret.findMany({ where: { name: ROW_NAME } });
    expect(rows).toHaveLength(1);
    const reader = new ConfigService({ vault, env: {} });
    await reader.loadSecrets();
    expect(svc.get(KEY)).toBe(reader.get(KEY));
  });
});
