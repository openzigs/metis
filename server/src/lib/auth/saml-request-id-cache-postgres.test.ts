/**
 * Epic #517 (#520) — unit tests for the Postgres-backed SAML request-id cache.
 *
 * The point of the Postgres backend is that the SAML request id survives load
 * balancing across replicas AND that `validateInResponseTo` replay protection
 * still holds. These tests prove both against a fake Prisma client modelling ONE
 * shared Postgres table, with the same `CacheProvider` contract node-saml relies
 * on (save-returns-null-on-dup, non-destructive get, single-use remove, TTL).
 * Two separately-constructed caches (= two pods) share that one fake DB:
 *   - cross-replica: `saveAsync` on cache A, `getAsync`/`removeAsync` on cache B.
 *   - single-use   : after `removeAsync`, a replayed `getAsync` misses.
 *
 * (The end-to-end proof against a real Postgres lives in the gated
 * saml-request-id-cache-postgres.integration.test.ts.)
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  PostgresSamlRequestIdCache,
  registerPostgresSamlRequestIdCache,
} from "./saml-request-id-cache-postgres.js";
import { __resetSamlRequestIdCache, resolveSamlRequestIdCache } from "./saml-request-id-cache.js";

interface Row {
  request_id: string;
  value: string;
  created_at: number;
}

/**
 * Minimal fake of the Prisma client surface the cache uses. Models a SINGLE
 * shared table so two cache instances behave like two pods on one Postgres.
 * Parses the tagged-template SQL the cache emits and applies the matching
 * mutation/read, including ON CONFLICT DO NOTHING and TTL filters.
 */
class FakeSharedPg {
  rows = new Map<string, Row>(); // key = request_id
  ddlCount = 0;
  pruneCount = 0;

  $executeRawUnsafe(sql: string): Promise<number> {
    if (sql.includes("CREATE UNLOGGED TABLE")) {
      this.ddlCount += 1;
      return Promise.resolve(0);
    }
    if (sql.includes("TRUNCATE")) {
      this.rows.clear();
      return Promise.resolve(0);
    }
    return Promise.resolve(0);
  }

  // Tagged-template `$executeRaw`: save-insert, save's expired-row delete,
  // remove-delete, and the opportunistic prune all land here.
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const sql = strings.join("?");

    if (sql.includes("INSERT INTO")) {
      const [requestId, value, createdAt] = values as [string, string, number];
      if (this.rows.has(requestId)) return Promise.resolve(0); // ON CONFLICT DO NOTHING
      this.rows.set(requestId, { request_id: requestId, value, created_at: createdAt });
      return Promise.resolve(1);
    }

    // DELETE … WHERE request_id = ? AND created_at + ? <= ?  (save's expired drop)
    if (sql.includes("DELETE FROM") && sql.includes('"request_id" = ?') && sql.includes("<=")) {
      const [requestId, expirationMs, now] = values as [string, number, number];
      const row = this.rows.get(requestId);
      if (row && row.created_at + expirationMs <= now) {
        this.rows.delete(requestId);
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    }

    // DELETE … WHERE request_id = ?  (single-use remove)
    if (sql.includes("DELETE FROM") && sql.includes('"request_id" = ?')) {
      const [requestId] = values as [string];
      const existed = this.rows.delete(requestId);
      return Promise.resolve(existed ? 1 : 0);
    }

    // DELETE … WHERE created_at + ? <= ?  (opportunistic prune)
    if (sql.includes("DELETE FROM")) {
      const [expirationMs, now] = values as [number, number];
      this.pruneCount += 1;
      for (const [k, row] of this.rows) {
        if (row.created_at + expirationMs <= now) this.rows.delete(k);
      }
      return Promise.resolve(0);
    }
    return Promise.resolve(0);
  }

  // Tagged-template `$queryRaw`: the non-destructive get.
  $queryRaw<T>(_strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    const [requestId] = values as [string];
    const row = this.rows.get(requestId);
    if (!row) return Promise.resolve([] as unknown as T);
    return Promise.resolve([{ value: row.value, created_at: row.created_at }] as unknown as T);
  }
}

function makeCache(db: FakeSharedPg, expirationMs = 60_000, now: () => number = () => 1000) {
  return new PostgresSamlRequestIdCache(db as unknown as never, expirationMs, now);
}

describe("PostgresSamlRequestIdCache — CacheProvider contract", () => {
  it("saveAsync inserts a new id and returns the CacheItem", async () => {
    const db = new FakeSharedPg();
    const cache = makeCache(db, 60_000, () => 1000);
    const item = await cache.saveAsync("req-1", "instant-1");
    expect(item).toEqual({ value: "instant-1", createdAt: 1000 });
    expect(db.rows.has("req-1")).toBe(true);
  });

  it("saveAsync returns null for a still-live duplicate id (no overwrite)", async () => {
    const db = new FakeSharedPg();
    const cache = makeCache(db, 60_000, () => 1000);
    expect(await cache.saveAsync("req-1", "first")).not.toBeNull();
    expect(await cache.saveAsync("req-1", "second")).toBeNull();
    expect(await cache.getAsync("req-1")).toBe("first");
  });

  it("getAsync is non-destructive and returns the value", async () => {
    const db = new FakeSharedPg();
    const cache = makeCache(db, 60_000, () => 1000);
    await cache.saveAsync("req-1", "v1");
    expect(await cache.getAsync("req-1")).toBe("v1");
    expect(await cache.getAsync("req-1")).toBe("v1"); // still there
  });

  it("getAsync returns null for an unknown id", async () => {
    const db = new FakeSharedPg();
    const cache = makeCache(db);
    expect(await cache.getAsync("nope")).toBeNull();
  });

  it("removeAsync is single-use: after remove, a replay get misses", async () => {
    const db = new FakeSharedPg();
    const cache = makeCache(db, 60_000, () => 1000);
    await cache.saveAsync("req-1", "v1");
    expect(await cache.removeAsync("req-1")).toBe("req-1");
    expect(await cache.getAsync("req-1")).toBeNull();
  });

  it("removeAsync returns null for an unknown or null id", async () => {
    const db = new FakeSharedPg();
    const cache = makeCache(db);
    expect(await cache.removeAsync("missing")).toBeNull();
    expect(await cache.removeAsync(null)).toBeNull();
  });

  it("getAsync expires an id past its TTL", async () => {
    const db = new FakeSharedPg();
    let now = 0;
    const cache = makeCache(db, 1000, () => now);
    await cache.saveAsync("req-1", "v1");
    now = 999;
    expect(await cache.getAsync("req-1")).toBe("v1");
    now = 1000; // created_at + ttl <= now
    expect(await cache.getAsync("req-1")).toBeNull();
  });

  it("saveAsync re-mints an id whose prior entry has expired", async () => {
    const db = new FakeSharedPg();
    let now = 0;
    const cache = makeCache(db, 1000, () => now);
    await cache.saveAsync("req-1", "old");
    now = 2000; // expired
    expect(await cache.saveAsync("req-1", "new")).not.toBeNull();
    expect(await cache.getAsync("req-1")).toBe("new");
  });

  it("bootstraps the table exactly once across many ops", async () => {
    const db = new FakeSharedPg();
    const cache = makeCache(db, 60_000, () => 1000);
    await cache.saveAsync("a", "1");
    await cache.getAsync("a");
    await cache.removeAsync("a");
    expect(db.ddlCount).toBe(1);
  });
});

describe("PostgresSamlRequestIdCache — cross-replica (two pods, one DB)", () => {
  it("an id saved on cache A is visible to cache B (cross-replica)", async () => {
    const db = new FakeSharedPg();
    const replicaA = makeCache(db, 60_000, () => 1000);
    const replicaB = makeCache(db, 60_000, () => 1000);

    await replicaA.saveAsync("req-1", "instant-1");
    expect(await replicaB.getAsync("req-1")).toBe("instant-1");
  });

  it("replay across replicas: once B removes the id, A's get misses", async () => {
    const db = new FakeSharedPg();
    const replicaA = makeCache(db, 60_000, () => 1000);
    const replicaB = makeCache(db, 60_000, () => 1000);

    await replicaA.saveAsync("req-1", "instant-1");
    expect(await replicaB.getAsync("req-1")).toBe("instant-1");
    expect(await replicaB.removeAsync("req-1")).toBe("req-1"); // first use on B
    // Replayed Response hits pod A — the id is gone cluster-wide.
    expect(await replicaA.getAsync("req-1")).toBeNull();
  });
});

describe("PostgresSamlRequestIdCache — reset + factory registration", () => {
  afterEach(() => {
    __resetSamlRequestIdCache();
  });

  it("reset truncates the shared table", async () => {
    const db = new FakeSharedPg();
    const cache = makeCache(db, 60_000, () => 1000);
    await cache.saveAsync("req-1", "v1");
    expect(db.rows.size).toBe(1);
    await cache.reset();
    expect(db.rows.size).toBe(0);
  });

  it("registerPostgresSamlRequestIdCache wires the resolver to a Postgres cache", () => {
    const db = new FakeSharedPg();
    registerPostgresSamlRequestIdCache(db as unknown as never);
    const resolved = resolveSamlRequestIdCache({
      SAML_REQUEST_ID_CACHE_BACKEND: "postgres",
    } as NodeJS.ProcessEnv);
    expect(resolved).toBeInstanceOf(PostgresSamlRequestIdCache);
  });
});
