/**
 * #50 — a documentation generation interrupted by a server restart stayed
 * `generating` forever.
 *
 * Generation runs in-process (fire-and-forget from the request), so when the
 * process dies nothing ever finishes, fails or resumes the row. This drives the
 * REAL `generateDocumentAsync` against a stateful in-memory `generated_documents`
 * table and simulates the process exiting mid-generation: the synthesizer never
 * returns, and the dying process's timers vanish with it (`vi.clearAllTimers`).
 * A new process's startup sweep must then fail the row with a clear message;
 * a generation that is still ALIVE (another replica, or this process) must not
 * be touched. The one-click regenerate route is exercised against the same row.
 *
 * Only I/O is faked: Prisma (in-memory), the synthesizer (never resolves) and
 * socket job events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";

type Row = Record<string, unknown> & {
  id: string;
  projectId: string;
  status: string;
  updatedAt: Date;
  deletedAt: Date | null;
};

const state = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  release: null as null | ((err: Error) => void),
  user: null as null | Record<string, unknown>,
}));

const ADMIN = { userId: "user_admin", username: "admin", role: "admin", permissions: [] };

type Where = Record<string, unknown>;
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Where[]).some((w) => matches(row, w));
    if (key === "versions") return true; // no versions in this table fixture
    const value = row[key];
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (cond && typeof cond === "object") {
      const c = cond as { lt?: Date; not?: unknown; in?: unknown[] };
      if (c.lt !== undefined) return value instanceof Date && value < c.lt;
      if ("not" in c) return value !== c.not;
      if (c.in) return c.in.includes(value);
      return false;
    }
    return (value ?? null) === (cond ?? null);
  });
}

vi.mock("../src/lib/prisma.js", () => {
  const rows = () => [...state.docs.values()] as Row[];
  const prisma = {
    // proj-1 lives in workspace ws-1 (object-level scope, requireProjectAccess).
    project: {
      findFirst: vi.fn(),
      findUnique: vi.fn(async () => ({ name: "P", workspaceId: "ws-1" })),
    },
    generatedDocument: {
      findFirst: vi.fn(async ({ where, include }: { where: Where; include?: unknown }) => {
        const row = rows().find((r) => matches(r, where));
        return row ? { ...row, ...(include ? { versions: [] } : {}) } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        rows()
          .filter((r) => matches(r, where))
          .map((r) => ({ ...r })),
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Where }) => {
        const hit = rows().filter((r) => matches(r, where));
        // Prisma's @updatedAt: every update stamps "now" unless data sets it.
        for (const r of hit) Object.assign(r, { updatedAt: new Date() }, data);
        return { count: hit.length };
      }),
    },
    generatedDocumentVersion: { findFirst: vi.fn(async () => null), create: vi.fn() },
    task: { upsert: vi.fn(), findUnique: vi.fn(async () => null) },
    document: { findFirst: vi.fn(async () => null) },
    $transaction: vi.fn(),
  };
  return { prisma, Prisma: { DbNull: Symbol("DbNull") } };
});

const logError = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: logError, debug: vi.fn() }),
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = state.user ?? {
      userId: "user_admin",
      username: "admin",
      role: "admin",
      permissions: [],
    };
    next();
  },
  refreshAuthenticatedUser: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../src/middleware/require-permission.js", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("express-rate-limit", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));

vi.mock("../src/lib/docs-gen/evidence-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/docs-gen/evidence-policy.js")>();
  return {
    ...actual,
    resolveEvidencePolicy: vi.fn(async () => ({
      projectId: "proj-1",
      generatedDocumentId: "doc-1",
      actor: { userId: "user_admin", role: "admin" },
      sharedDocumentIds: [],
      allowWebResearch: false,
    })),
  };
});

// The generation that the process "dies" in: it never returns on its own.
vi.mock("../src/lib/docs-gen/db-schema-synthesizer.js", () => ({
  DB_SCHEMA_PROSE_PROMPT_VERSION: 1,
  synthesizeDbSchemaDocument: vi.fn(
    () =>
      new Promise((_resolve, reject) => {
        state.release = reject;
      }),
  ),
}));

vi.mock("../src/lib/socket/job-events.js", () => ({
  jobEvents: {
    started: vi.fn(),
    progress: vi.fn(),
    completed: vi.fn(),
    failed: vi.fn(),
    docSection: vi.fn(),
  },
  genericFailureMessage: () => "Document generation failed",
}));

import { generateDocumentAsync, generatedDocsRouter } from "../src/routes/generated-docs.js";
import {
  GENERATING_STALE_MS,
  GENERATION_HEARTBEAT_MS,
  GENERATION_INTERRUPTED_MESSAGE,
  INTERRUPTED_SWEEP_INTERVAL_MS,
  PENDING_STALE_MS,
  failInterruptedGenerations,
  startGenerationHeartbeat,
  startInterruptedGenerationSweeper,
} from "../src/lib/docs-gen/interrupted-generations.js";
import { prisma } from "../src/lib/prisma.js";
import { jobEvents } from "../src/lib/socket/job-events.js";
import { synthesizeDbSchemaDocument } from "../src/lib/docs-gen/db-schema-synthesizer.js";
import {
  GENERATION_FAILED_MESSAGE,
  GENERATION_PROVIDER_BALANCE_MESSAGE,
} from "../src/lib/docs-gen/generation-failure-message.js";

const T0 = new Date("2026-09-22T10:00:00.000Z");

function seed(over: Partial<Row> = {}): Row {
  const row: Row = {
    id: "doc-1",
    projectId: "proj-1",
    title: "Schema",
    scope: "database",
    scopeFilter: JSON.stringify({ dbConnectorId: "db-1" }),
    evidencePolicy: "{}",
    status: "pending",
    errorMessage: null,
    codeGraphHash: "previous-hash",
    autoUpdate: false,
    updatedAt: new Date(T0),
    deletedAt: null,
    ...over,
  };
  state.docs.set(row.id, row);
  return row;
}
const doc = (id = "doc-1") => state.docs.get(id) as Row;

/** Start a generation and wait until it holds its claim (status `generating`). */
async function startGeneration(id = "doc-1"): Promise<void> {
  void generateDocumentAsync(id, "proj-1").catch(() => undefined);
  await vi.waitFor(() => expect(synthesizeDbSchemaDocument).toHaveBeenCalled());
  expect(doc(id).status).toBe("generating");
}

/** Let fake wall-clock time pass, firing any live interval (heartbeat). */
async function elapse(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/projects/:projectId/docs", generatedDocsRouter());
  app.use(
    (
      err: { statusCode?: number; code?: string; message?: string },
      _req: unknown,
      res: express.Response,
      _next: unknown,
    ) => {
      res.status(err.statusCode ?? 500).json({ error: { code: err.code, message: err.message } });
    },
  );
  return app;
}

describe("#50 — a generation interrupted by a restart never stays `generating`", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.docs.clear();
    state.release = null;
    // Fake only the clock and intervals; setTimeout/setImmediate stay real so
    // the async generation path and vi.waitFor run normally.
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: T0 });
  });

  afterEach(() => {
    // Unblock any generation still awaiting the synthesizer.
    state.release?.(new Error("test teardown"));
    vi.useRealTimers();
  });

  it("process exits mid-generation → the next process fails the document", async () => {
    seed();
    await startGeneration();

    // The process dies: its heartbeat (and every other timer) is gone, and the
    // synthesizer never returns. Wall-clock time moves on.
    vi.clearAllTimers();
    vi.setSystemTime(new Date(Date.now() + GENERATING_STALE_MS + 1_000));

    // A new process boots and runs the startup sweep.
    const failed = await failInterruptedGenerations();

    expect(failed).toBe(1);
    expect(doc().status).toBe("failed");
    expect(doc().errorMessage).toBe(GENERATION_INTERRUPTED_MESSAGE);
    expect(doc().errorMessage).toMatch(/interrupted/i);
    expect(doc().errorMessage).toMatch(/regenerate/i);
    // The dead run's claim is revoked, so it can never commit over the row.
    expect(String(doc().codeGraphHash ?? "")).not.toMatch(/^regenerating:/);
    // Live UIs leave the spinner without a refresh.
    expect(jobEvents.failed).toHaveBeenCalledWith(
      "doc-generation",
      "doc-1",
      "proj-1",
      GENERATION_INTERRUPTED_MESSAGE,
    );
  });

  it("a generation that is still running keeps its heartbeat and is left alone", async () => {
    seed();
    await startGeneration();

    // Far longer than the stale threshold — but the process is alive, so its
    // heartbeat keeps the row fresh (another replica's sweep must not kill it).
    await elapse(GENERATING_STALE_MS * 3);

    expect(await failInterruptedGenerations()).toBe(0);
    expect(doc().status).toBe("generating");
    expect(doc().updatedAt.getTime()).toBeGreaterThan(Date.now() - GENERATION_HEARTBEAT_MS - 1);
  });

  it("stops the heartbeat when the generation ends", async () => {
    seed();
    await startGeneration();
    // The heartbeat is the only interval a generation runs.
    expect(vi.getTimerCount()).toBe(1);
    state.release?.(new Error("model unavailable"));
    await vi.waitFor(() => expect(doc().status).toBe("failed"));
    const endedAt = doc().updatedAt.getTime();

    await elapse(GENERATION_HEARTBEAT_MS * 3);
    expect(doc().updatedAt.getTime()).toBe(endedAt);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a stale run that wakes up after being failed cannot overwrite the row", async () => {
    seed();
    await startGeneration();
    vi.clearAllTimers();
    vi.setSystemTime(new Date(Date.now() + GENERATING_STALE_MS + 1_000));
    await failInterruptedGenerations();

    // The "dead" run was only stalled; it now fails on its own.
    state.release?.(new Error("late failure"));
    await new Promise((r) => setTimeout(r, 20));

    expect(doc().status).toBe("failed");
    expect(doc().errorMessage).toBe(GENERATION_INTERRUPTED_MESSAGE);
  });

  it("fails a `pending` row left by a dead process, after the pending threshold only", async () => {
    seed({ status: "pending" });
    vi.setSystemTime(new Date(T0.getTime() + GENERATING_STALE_MS + 1_000));
    expect(await failInterruptedGenerations()).toBe(0);
    expect(doc().status).toBe("pending");

    vi.setSystemTime(new Date(T0.getTime() + PENDING_STALE_MS + 1_000));
    expect(await failInterruptedGenerations()).toBe(1);
    expect(doc().status).toBe("failed");
    expect(doc().errorMessage).toBe(GENERATION_INTERRUPTED_MESSAGE);
    // A pending row never held a claim — its hash is left as it was.
    expect(doc().codeGraphHash).toBe("previous-hash");
  });

  it("leaves finished, failed and deleted documents alone", async () => {
    const later = new Date(T0.getTime() + PENDING_STALE_MS * 4);
    seed({ id: "ready", status: "ready" });
    seed({ id: "failed", status: "failed", errorMessage: "earlier" });
    seed({ id: "deleted", status: "generating", deletedAt: new Date(T0) });
    vi.setSystemTime(later);

    expect(await failInterruptedGenerations()).toBe(0);
    expect(doc("ready").status).toBe("ready");
    expect(doc("failed").errorMessage).toBe("earlier");
    expect(doc("deleted").status).toBe("generating");
  });
});

describe("#50 — POST /:docId/regenerate (one-click regenerate)", () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
    state.docs.clear();
    state.release = null;
    state.user = ADMIN;
  });

  afterEach(() => {
    state.release?.(new Error("test teardown"));
    state.user = null;
  });

  it("404s a non-member regenerating another tenant's document", async () => {
    state.user = { userId: "u", role: "coordinator", workspaces: ["ws-other"], permissions: [] };
    seed({ status: "failed", errorMessage: GENERATION_INTERRUPTED_MESSAGE });

    const res = await request(app).post("/projects/proj-1/docs/doc-1/regenerate");

    expect(res.status).toBe(404);
    expect(doc().status).toBe("failed");
    expect(synthesizeDbSchemaDocument).not.toHaveBeenCalled();
  });

  it("lets a workspace member (non-admin) regenerate", async () => {
    state.user = { userId: "u", role: "coordinator", workspaces: ["ws-1"], permissions: [] };
    seed({ status: "failed", errorMessage: GENERATION_INTERRUPTED_MESSAGE });

    const res = await request(app).post("/projects/proj-1/docs/doc-1/regenerate");

    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(doc().status).toBe("generating"));
  });

  it("restarts an interrupted document in place", async () => {
    seed({ status: "failed", errorMessage: GENERATION_INTERRUPTED_MESSAGE, codeGraphHash: null });

    const res = await request(app).post("/projects/proj-1/docs/doc-1/regenerate").send({});

    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ id: "doc-1", status: "pending" });
    // Read back through the store: the real generation path picked it up.
    await vi.waitFor(() => expect(doc().status).toBe("generating"));
    expect(doc().errorMessage).toBeNull();
    expect(synthesizeDbSchemaDocument).toHaveBeenCalledTimes(1);
  });

  it("GET /:docId flags an interrupted failure (and only that)", async () => {
    seed({ status: "failed", errorMessage: GENERATION_INTERRUPTED_MESSAGE });
    seed({ id: "other-failure", status: "failed", errorMessage: "Error: boom" });
    seed({ id: "ready", status: "ready" });
    const get = (id: string) => request(app).get(`/projects/proj-1/docs/${id}`);
    expect((await get("doc-1")).body.data.interrupted).toBe(true);
    expect((await get("other-failure")).body.data.interrupted).toBe(false);
    expect((await get("ready")).body.data.interrupted).toBe(false);
  });

  it("409s for a document that is not failed", async () => {
    seed({ status: "generating" });
    const res = await request(app).post("/projects/proj-1/docs/doc-1/regenerate").send({});
    expect(res.status).toBe(409);
    expect(doc().status).toBe("generating");
    expect(synthesizeDbSchemaDocument).not.toHaveBeenCalled();
  });

  it("404s for a document in another project or deleted", async () => {
    seed({ status: "failed", projectId: "other" });
    expect((await request(app).post("/projects/proj-1/docs/doc-1/regenerate")).status).toBe(404);
    seed({ id: "gone", status: "failed", deletedAt: new Date() });
    expect((await request(app).post("/projects/proj-1/docs/gone/regenerate")).status).toBe(404);
    expect(doc().status).toBe("failed");
    expect(synthesizeDbSchemaDocument).not.toHaveBeenCalled();
  });
});

describe("#52 — a failed generation's raw error never reaches the client", () => {
  const app = buildApp();
  const SECRET =
    'secret detail: openai returned 500 {"prompt":"customer data"} at /srv/metis/server/src/x.ts:9';

  beforeEach(() => {
    vi.clearAllMocks();
    state.docs.clear();
    state.release = null;
    state.user = ADMIN;
  });

  afterEach(() => {
    state.release?.(new Error("test teardown"));
    state.user = null;
  });

  async function failWith(err: Error) {
    seed();
    void generateDocumentAsync("doc-1", "proj-1").catch(() => undefined);
    await vi.waitFor(() => expect(synthesizeDbSchemaDocument).toHaveBeenCalled());
    state.release?.(err);
    state.release = null;
    await vi.waitFor(() => expect(doc().status).toBe("failed"));
  }

  it("stores and returns a generic message, and logs the detail server-side", async () => {
    await failWith(new Error(SECRET));

    // Read back through the same path the UI uses.
    const res = await request(app).get("/projects/proj-1/docs/doc-1");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("failed");
    expect(res.body.data.errorMessage).toBe(GENERATION_FAILED_MESSAGE);
    expect(JSON.stringify(res.body)).not.toContain("secret detail");
    expect(JSON.stringify(res.body)).not.toContain("/srv/metis");
    expect(doc().errorMessage).toBe(GENERATION_FAILED_MESSAGE);

    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).toContain("secret detail");
    expect(logged).toContain("/srv/metis");
  });

  it("keeps a provider's 402 Insufficient Balance recognisable", async () => {
    await failWith(
      new Error('deepseek returned 402: {"error":{"message":"Insufficient Balance","code":"x9"}}'),
    );
    const res = await request(app).get("/projects/proj-1/docs/doc-1");
    expect(res.body.data.errorMessage).toBe(GENERATION_PROVIDER_BALANCE_MESSAGE);
    expect(res.body.data.errorMessage).toMatch(/402 Insufficient Balance/);
    expect(JSON.stringify(res.body)).not.toContain("x9");
  });

  it("sanitises raw text a pre-#52 row still holds, and keeps the #53 restart message", async () => {
    seed({ status: "failed", errorMessage: `Error: ${SECRET}` });
    seed({ id: "restarted", status: "failed", errorMessage: GENERATION_INTERRUPTED_MESSAGE });

    const legacy = await request(app).get("/projects/proj-1/docs/doc-1");
    expect(legacy.body.data.errorMessage).toBe(GENERATION_FAILED_MESSAGE);
    expect(JSON.stringify(legacy.body)).not.toContain("secret detail");

    const restarted = await request(app).get("/projects/proj-1/docs/restarted");
    expect(restarted.body.data.errorMessage).toBe(GENERATION_INTERRUPTED_MESSAGE);
    expect(restarted.body.data.interrupted).toBe(true);
  });
});

describe("#50 — startInterruptedGenerationSweeper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.docs.clear();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: T0 });
  });
  afterEach(() => vi.useRealTimers());

  it("sweeps at startup, then periodically, until stopped", async () => {
    seed({ id: "boot", status: "generating", codeGraphHash: "regenerating:dead" });
    vi.setSystemTime(new Date(T0.getTime() + GENERATING_STALE_MS + 1_000));
    const stop = startInterruptedGenerationSweeper();
    // Startup pass — no interval tick needed.
    await vi.waitFor(() => expect(doc("boot").status).toBe("failed"));

    // A run orphaned AFTER startup is caught by a later tick.
    seed({ id: "later", status: "generating", updatedAt: new Date(Date.now()) });
    await vi.advanceTimersByTimeAsync(GENERATING_STALE_MS + INTERRUPTED_SWEEP_INTERVAL_MS);
    await vi.waitFor(() => expect(doc("later").status).toBe("failed"));

    stop();
    seed({ id: "after-stop", status: "generating", updatedAt: new Date(Date.now()) });
    await vi.advanceTimersByTimeAsync(GENERATING_STALE_MS + INTERRUPTED_SWEEP_INTERVAL_MS * 2);
    // Let any sweep a tick would have started settle (real timeout).
    await new Promise((r) => setTimeout(r, 20));
    expect(doc("after-stop").status).toBe("generating");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("#50 — a database error never escapes a timer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.docs.clear();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: T0 });
  });
  afterEach(() => vi.useRealTimers());

  it("a failed heartbeat write is logged, not thrown, and the next beat still runs", async () => {
    const updateMany = vi.mocked(prisma.generatedDocument.updateMany);
    updateMany.mockRejectedValueOnce(new Error("database is locked"));
    const stop = startGenerationHeartbeat("doc-1", "proj-1", "regenerating:x");
    await vi.advanceTimersByTimeAsync(GENERATION_HEARTBEAT_MS * 2);
    expect(updateMany).toHaveBeenCalledTimes(2);
    stop();
  });

  it("a failed sweep is logged, not thrown", async () => {
    const findMany = vi.mocked(prisma.generatedDocument.findMany);
    findMany.mockRejectedValueOnce(new Error("database is locked"));
    const stop = startInterruptedGenerationSweeper();
    await new Promise((r) => setTimeout(r, 20));
    expect(findMany).toHaveBeenCalledTimes(1);
    stop();
  });
});
