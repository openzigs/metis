/**
 * #75 — `/readyz` must fail when `VECTOR_STORE=pgvector` points at a Postgres
 * without the `vector` extension.
 *
 * Measured before this check existed (the image smoke's Postgres arm against
 * `postgres:16-alpine`): `/healthz` answered 200 and every probe passed except the
 * pgvector write (`extension "vector" is not available`). The server booted, went
 * ready, took traffic — and failed on the first ingest. A readiness component makes
 * that rollout never go ready instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryRawUnsafe = vi.fn();
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: (...args: unknown[]) => queryRawUnsafe(...args),
    user: { upsert: vi.fn(async () => ({ id: "user_admin" })) },
    userRole: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

vi.mock("../src/lib/rag/embedder.js", () => ({
  getEmbedder: () => ({
    snapshot: () => ({
      loaded: true,
      ok: true,
      status: "ok",
      backend: "xenova",
      model: "m",
      dimension: 768,
      fellBack: false,
      hashFallbackAllowed: false,
      error: null,
    }),
  }),
}));

import request from "supertest";
import { createApp } from "../src/app.js";
import { HEALTH_CHECK_MESSAGES, PGVECTOR_READINESS_SQL } from "../src/routes/health.js";

/** Answer the database's `SELECT 1` and the pgvector catalog query separately. */
function database(pg: { installed: number | bigint; available: number | bigint } | Error) {
  queryRawUnsafe.mockImplementation(async (sql: string) => {
    if (sql !== PGVECTOR_READINESS_SQL) return 1;
    if (pg instanceof Error) throw pg;
    return [pg];
  });
}

const ENV_KEYS = ["VECTOR_STORE", "AI_OFFLINE"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.AI_OFFLINE;
  queryRawUnsafe.mockReset();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// Built once, with no VECTOR_STORE: building the routers constructs the store, and
// `pgvector` needs a registered factory this unit test has no database for. The
// check reads the selection per request, so each test sets it after this.
const savedStore = process.env.VECTOR_STORE;
delete process.env.VECTOR_STORE;
const app = createApp();
if (savedStore !== undefined) process.env.VECTOR_STORE = savedStore;

const checks = async () => {
  const res = await request(app).get("/readyz");
  return { res, check: res.body.checks.vectorStore as { status: string; message?: string } };
};

describe("/readyz — vector store check (#75)", () => {
  it("ERRORS (503) under VECTOR_STORE=pgvector when the extension is not available", async () => {
    process.env.VECTOR_STORE = "pgvector";
    database({ installed: 0, available: 0 });
    const { res, check } = await checks();
    expect(check.status).toBe("error");
    expect(check.message).toBe(HEALTH_CHECK_MESSAGES.pgvectorMissing);
    // This is what stops the rollout: overall error → 503.
    expect(res.body.status).toBe("error");
    expect(res.status).toBe(503);
  });

  it("is ok when the extension is already installed", async () => {
    process.env.VECTOR_STORE = "pgvector";
    database({ installed: 1n, available: 1n });
    const { check } = await checks();
    expect(check).toEqual({ status: "ok", message: "pgvector (extension installed)" });
  });

  it("is ok when the extension is available but not yet created (the first write creates it)", async () => {
    process.env.VECTOR_STORE = " PgVector ";
    database({ installed: 0, available: 1 });
    const { check } = await checks();
    expect(check.status).toBe("ok");
    expect(check.message).toMatch(/available.*created on first write/);
  });

  it("errors, with a fixed message and no driver text, when the catalog query fails", async () => {
    process.env.VECTOR_STORE = "pgvector";
    database(new Error("connect ECONNREFUSED db.internal:5432"));
    const { res, check } = await checks();
    expect(check).toEqual({ status: "error", message: HEALTH_CHECK_MESSAGES.vectorStore });
    // #121 — the probe is unauthenticated; the driver error goes to the log only.
    expect(JSON.stringify(res.body)).not.toContain("ECONNREFUSED");
    expect(res.status).toBe(503);
  });

  it("does not query Postgres at all for the other stores", async () => {
    delete process.env.VECTOR_STORE;
    database({ installed: 0, available: 0 });
    const lance = await checks();
    expect(lance.check).toEqual({ status: "ok", message: "lancedb" });

    process.env.VECTOR_STORE = "pgvector";
    process.env.AI_OFFLINE = "1"; // offline wins over pgvector (vector-store.ts)
    const local = await checks();
    expect(local.check).toEqual({ status: "ok", message: "local" });

    expect(queryRawUnsafe.mock.calls.map((c) => c[0])).not.toContain(PGVECTOR_READINESS_SQL);
  });
});
