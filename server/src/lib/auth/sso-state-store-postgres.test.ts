/**
 * Epic #518 (#542) — Postgres-backed SSO-state store tests.
 *
 * The point of #542 is that SSO transaction state survives load balancing across
 * replicas AND can be redeemed at most once. These tests prove both against a
 * fake Prisma client modelling ONE shared Postgres: a single-row-per-state table
 * with a `DELETE … RETURNING` consume serialized exactly as Postgres row-locking
 * serializes concurrent callbacks. Two separately-constructed PostgresSSOStateStore
 * instances (= two replicas/pods) share that one fake DB:
 *   - cross-replica: `put` on replica A, `consume` on replica B → succeeds.
 *   - consume-once : two concurrent `consume`s of one state → exactly one wins.
 *
 * (The end-to-end proof against a real `postgres:16-alpine` lives in the gated
 * sso-state-store-postgres.integration.test.ts.)
 */
import { describe, expect, it } from "vitest";

import {
  PostgresSSOStateStore,
  registerPostgresSSOStateStore,
} from "./sso-state-store-postgres.js";
import {
  __setPostgresSSOStateStoreFactory,
  resolveSSOStateStore,
  type SSOStatePayload,
} from "./sso-state-store.js";

interface Row {
  state: string;
  mode: string;
  code_verifier: string;
  nonce: string;
  expires_at: number;
}

/**
 * Minimal fake of the Prisma client surface the Postgres store uses. Models a
 * SINGLE shared table and serializes mutating queries through a promise chain so
 * concurrent calls from two store instances interleave the way Postgres
 * row-locking serializes concurrent replicas — i.e. a `DELETE … RETURNING` yields
 * the row to exactly one racer.
 */
class FakeSharedPg {
  rows = new Map<string, Row>(); // key = state
  ddlCount = 0;
  pruneCount = 0;
  private tail: Promise<unknown> = Promise.resolve();

  private serialize<T>(fn: () => T): Promise<T> {
    const run = this.tail.then(
      () => new Promise<T>((resolve) => setImmediate(() => resolve(fn()))),
    );
    this.tail = run.catch(() => undefined);
    return run;
  }

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

  // Tagged-template `$executeRaw` — the upsert (put) and the prune land here.
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const sql = strings.join("?");
    if (sql.includes("INSERT INTO")) {
      const [state, mode, codeVerifier, nonce, expiresAt] = values as [
        string,
        string,
        string,
        string,
        number,
      ];
      return this.serialize(() => {
        this.rows.set(state, {
          state,
          mode,
          code_verifier: codeVerifier,
          nonce,
          expires_at: expiresAt,
        });
        return 0;
      });
    }
    if (sql.includes("DELETE FROM") && sql.includes("expires_at")) {
      const [now] = values as [number];
      return this.serialize(() => {
        this.pruneCount += 1;
        for (const [k, row] of this.rows) {
          if (row.expires_at <= now) this.rows.delete(k);
        }
        return 0;
      });
    }
    return Promise.resolve(0);
  }

  // Tagged-template `$queryRaw` — only the `DELETE … RETURNING` consume lands here.
  $queryRaw<T>(_strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    const [state] = values as [string];
    return this.serialize(() => {
      const row = this.rows.get(state);
      if (!row) return [] as unknown as T;
      this.rows.delete(state); // atomic delete-returning
      return [
        {
          mode: row.mode,
          code_verifier: row.code_verifier,
          nonce: row.nonce,
          expires_at: row.expires_at,
        },
      ] as unknown as T;
    });
  }
}

function makeStore(db: FakeSharedPg): PostgresSSOStateStore {
  return new PostgresSSOStateStore(db as unknown as never);
}

const payload: SSOStatePayload = {
  codeVerifier: "verifier-abc",
  nonce: "nonce-xyz",
  mode: "oidc",
};

describe("PostgresSSOStateStore — consume-once + TTL", () => {
  it("stores then consumes the payload once", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    await store.put("s1", payload, 60_000, 1000);
    expect(await store.consume("s1", 2000)).toEqual(payload);
  });

  it("rejects a replay: a second consume returns null", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    await store.put("s1", payload, 60_000, 1000);
    expect(await store.consume("s1", 2000)).toEqual(payload);
    expect(await store.consume("s1", 2000)).toBeNull();
  });

  it("returns null for an unknown state", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    expect(await store.consume("nope", 0)).toBeNull();
  });

  it("rejects an expired state (and the row is gone)", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    await store.put("s1", payload, 1000, 0); // expires at 1000
    expect(await store.consume("s1", 1001)).toBeNull();
    expect(db.rows.has("s1")).toBe(false); // deleted by the DELETE … RETURNING
  });

  it("treats the expiry boundary as expired (expires_at <= now)", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    await store.put("s1", payload, 1000, 0);
    expect(await store.consume("s1", 1000)).toBeNull();
  });

  it("a fresh put for the same state overwrites (latest initiate wins)", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    await store.put("s1", payload, 60_000, 0);
    const second: SSOStatePayload = { codeVerifier: "v2", nonce: "n2", mode: "oidc" };
    await store.put("s1", second, 60_000, 0);
    expect(await store.consume("s1", 10)).toEqual(second);
  });

  it("creates the UNLOGGED table exactly once (memoised DDL)", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    await store.put("a", payload, 1000, 0);
    await store.put("b", payload, 1000, 0);
    await store.consume("a", 10);
    expect(db.ddlCount).toBe(1);
  });

  it("preserves the SAML mode round-trip", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    const saml: SSOStatePayload = { codeVerifier: "rid", nonce: "", mode: "saml" };
    await store.put("s1", saml, 60_000, 0);
    expect(await store.consume("s1", 10)).toEqual(saml);
  });

  it("reset() truncates the shared table", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    await store.put("s1", payload, 60_000, 0);
    await store.reset();
    expect(await store.consume("s1", 10)).toBeNull();
  });

  it("prunes expired rows opportunistically (table stays bounded)", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    const realRandom = Math.random;
    Math.random = () => 0; // always < PRUNE_PROBABILITY
    try {
      await store.put("old", payload, 1000, 0); // expires at 1000
      await store.put("new", payload, 1000, 5000); // put at now=5000 triggers prune
      await new Promise((r) => setImmediate(r)); // let the fire-and-forget prune run
      expect(db.rows.has("old")).toBe(false);
      expect(db.rows.has("new")).toBe(true);
    } finally {
      Math.random = realRandom;
    }
  });

  it("retries the table bootstrap after a transient DDL failure (resets memo)", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    // First ensureTable DDL throws — the memo must reset so a later call retries.
    const realExec = db.$executeRawUnsafe.bind(db);
    let firstDdl = true;
    db.$executeRawUnsafe = (sql: string) => {
      if (sql.includes("CREATE UNLOGGED TABLE") && firstDdl) {
        firstDdl = false;
        return Promise.reject(new Error("transient DDL failure"));
      }
      return realExec(sql);
    };
    await expect(store.put("s1", payload, 1000, 0)).rejects.toThrow(/transient DDL failure/);
    // Retry succeeds — the memo was cleared, so a fresh DDL runs.
    await store.put("s1", payload, 1000, 0);
    expect(await store.consume("s1", 10)).toEqual(payload);
  });

  it("handles a bigint expires_at from the driver", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    await store.put("s1", payload, 60_000, 0);
    // Simulate the pg driver returning expires_at as a bigint.
    const row = db.rows.get("s1")!;
    db.rows.set("s1", { ...row, expires_at: BigInt(row.expires_at) as unknown as number });
    expect(await store.consume("s1", 10)).toEqual(payload);
  });
});

describe("PostgresSSOStateStore — CROSS-REPLICA + consume-once race", () => {
  it("state put on replica A is consumed on replica B (cross-replica continuity)", async () => {
    const sharedDb = new FakeSharedPg();
    // Two SEPARATELY-CONSTRUCTED stores sharing ONE Postgres = two pods.
    const replicaA = makeStore(sharedDb);
    const replicaB = makeStore(sharedDb);

    // Initiate hits replica A; callback hits replica B — the load-balancer split.
    await replicaA.put("state-xyz", payload, 60_000, 1000);
    const got = await replicaB.consume("state-xyz", 2000);

    expect(got).toEqual(payload); // login completes on a different pod (#542 fix)
  });

  it("two concurrent consumes of one state across replicas: exactly ONE wins", async () => {
    const sharedDb = new FakeSharedPg();
    const replicaA = makeStore(sharedDb);
    const replicaB = makeStore(sharedDb);

    await replicaA.put("state-xyz", payload, 60_000, 0);

    // Both pods race the same callback `state` concurrently — the row lock on
    // DELETE … RETURNING means only one gets the payload back; the other gets null.
    const [a, b] = await Promise.all([
      replicaA.consume("state-xyz", 10),
      replicaB.consume("state-xyz", 10),
    ]);

    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toEqual(payload);
    expect(sharedDb.rows.has("state-xyz")).toBe(false); // consumed
  });
});

describe("registerPostgresSSOStateStore", () => {
  it("wires the resolver so backend=postgres builds a PostgresSSOStateStore", () => {
    const db = new FakeSharedPg();
    registerPostgresSSOStateStore(db as unknown as never);
    const store = resolveSSOStateStore({ SSO_STATE_BACKEND: "postgres" });
    expect(store).toBeInstanceOf(PostgresSSOStateStore);
    // Clean up the global factory so other suites are unaffected.
    __setPostgresSSOStateStoreFactory(() => {
      throw new Error("not registered");
    });
  });
});
