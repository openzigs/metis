/**
 * Issue #542 (epic #518) — end-to-end proof that the Postgres-backed SSO-state
 * store gives cross-replica login continuity AND consume-once replay protection
 * against a REAL Postgres, using two separately-constructed store instances
 * (= two pods) sharing one database.
 *
 *   "State created via one store instance is consumed via a SEPARATE instance
 *    sharing the backend (cross-replica), AND a second consume of the same state
 *    fails (consume-once / replay)."
 *
 * Gated exactly like rate-limit-store-postgres.integration.test.ts: runs only
 * when `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped (via
 * `pnpm test:integration`). In CI a `postgres:16-alpine` service is provided.
 * Locally it is skipped unless those conditions hold, so the default `pnpm test`
 * never needs a live database. The store self-creates its UNLOGGED table (no
 * migration), so no schema setup beyond a reachable Postgres is required.
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { selectPrismaAdapter } from "../src/lib/prisma.js";
import { PostgresSSOStateStore } from "../src/lib/auth/sso-state-store-postgres.js";
import type { SSOStatePayload } from "../src/lib/auth/sso-state-store.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

describe.runIf(enabled)("PostgresSSOStateStore cross-replica + consume-once (integration)", () => {
  const adapter = selectPrismaAdapter(databaseUrl);
  const prisma = new PrismaClient({ adapter });

  // Two SEPARATELY-CONSTRUCTED stores sharing ONE Postgres = two replicas/pods.
  const replicaA = new PostgresSSOStateStore(prisma);
  const replicaB = new PostgresSSOStateStore(prisma);

  beforeEach(async () => {
    await replicaA.reset();
  });

  afterAll(async () => {
    await replicaA.reset();
    await prisma.$disconnect();
  });

  const payload: SSOStatePayload = {
    codeVerifier: "verifier-integration",
    nonce: "nonce-integration",
    mode: "oidc",
  };

  it("state put on replica A is consumed on replica B (cross-replica continuity)", async () => {
    const now = Date.now();
    const state = `it::${now}`; // unique per run so reruns never collide

    // Initiate lands on replica A; callback lands on replica B — the LB split.
    await replicaA.put(state, payload, 60_000, now);
    const got = await replicaB.consume(state, now + 1000);

    expect(got).toEqual(payload);
  });

  it("consume-once: a second consume of the same state fails (replay rejected)", async () => {
    const now = Date.now();
    const state = `it-once::${now}`;

    await replicaA.put(state, payload, 60_000, now);
    expect(await replicaB.consume(state, now + 1000)).toEqual(payload);
    // Replay on either replica must miss — the row was atomically deleted.
    expect(await replicaA.consume(state, now + 1000)).toBeNull();
    expect(await replicaB.consume(state, now + 1000)).toBeNull();
  });

  it("two concurrent consumes across replicas: exactly ONE wins (atomic single-use)", async () => {
    const now = Date.now();
    const state = `it-race::${now}`;
    await replicaA.put(state, payload, 60_000, now);

    const [a, b] = await Promise.all([
      replicaA.consume(state, now + 1000),
      replicaB.consume(state, now + 1000),
    ]);

    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toEqual(payload);
  });

  it("rejects expired state past TTL", async () => {
    const now = Date.now();
    const state = `it-ttl::${now}`;
    await replicaA.put(state, payload, 1000, now); // expires at now+1000
    expect(await replicaB.consume(state, now + 2000)).toBeNull();
  });
});
