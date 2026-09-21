/**
 * /api/scheduler + /api/tasks route layer integration.
 *
 * Mocks Prisma + the scheduler bootstrap so we can exercise auth, RBAC, and
 * error mapping without touching live cron. Lib tests cover behaviour; this
 * is purely a route-surface coverage harness.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface JobRow {
  id: string;
  key: string;
  name: string;
  cron: string;
  taskType: string;
  payload: string;
  projectId: string | null;
  enabled: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  maxAttempts: number;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const jobs = new Map<string, JobRow>();
const tasks = new Map<string, Record<string, unknown>>();

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(
        async ({
          create,
        }: {
          create: { username: string; displayName: string; email: string };
        }) => ({
          id: `user_${create.username}`,
          ...create,
        }),
      ),
      findUnique: vi.fn(async ({ where }: { where: { username?: string; id?: string } }) => ({
        id: `user_${where.username ?? where.id}`,
        username: where.username ?? "x",
        displayName: where.username ?? "x",
        email: `${where.username ?? "x"}@x`,
      })),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    project: { findMany: vi.fn(async () => []) },
    scheduledJob: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => jobs.get(where.id) ?? null),
    },
    task: {
      findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
        return Array.from(tasks.values()).filter((t) => {
          if (!where) return true;
          for (const [k, v] of Object.entries(where)) {
            if ((t as Record<string, unknown>)[k] !== v) return false;
          }
          return true;
        });
      }),
      count: vi.fn(async () => tasks.size),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => tasks.get(where.id) ?? null,
      ),
    },
  });
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const fakeBoot = {
  scheduler: {
    listJobs: vi.fn(async () => Array.from(jobs.values())),
    getJob: vi.fn(async (id: string) => jobs.get(id) ?? null),
    createJob: vi.fn(
      async (input: { key: string; name: string; cron: string; taskType: string }) => {
        const row: JobRow = {
          id: `job_${jobs.size + 1}`,
          key: input.key,
          name: input.name,
          cron: input.cron,
          taskType: input.taskType,
          payload: "{}",
          projectId: null,
          enabled: true,
          lastRunAt: null,
          nextRunAt: new Date(Date.now() + 60_000),
          maxAttempts: 3,
          createdById: "user_admin",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        };
        jobs.set(row.id, row);
        return row;
      },
    ),
    updateJob: vi.fn(async (id: string, data: Partial<JobRow>) => {
      const r = jobs.get(id);
      if (!r) {
        const { SchedulerError } = await import("../src/lib/scheduler/types.js");
        throw new SchedulerError(404, "JOB_NOT_FOUND", "missing");
      }
      Object.assign(r, data);
      return r;
    }),
    deleteJob: vi.fn(async (id: string) => {
      jobs.delete(id);
    }),
    runNow: vi.fn(async (id: string) => {
      if (!jobs.has(id)) {
        const { SchedulerError } = await import("../src/lib/scheduler/types.js");
        throw new SchedulerError(404, "JOB_NOT_FOUND", "missing");
      }
      const t = { id: `t_${tasks.size + 1}`, status: "pending" };
      tasks.set(t.id, t);
      return t;
    }),
  },
  registry: {
    list: vi.fn(() => [
      { type: "noop", description: "" },
      { type: "http-webhook", description: "" },
    ]),
  },
  queue: {
    cancel: vi.fn(async (id: string) => tasks.has(id)),
    retry: vi.fn(async (id: string) => ({ id: `${id}_retry`, status: "pending" })),
  },
};

vi.mock("../src/lib/scheduler/index.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/scheduler/index.js")>(
    "../src/lib/scheduler/index.js",
  );
  return {
    ...actual,
    getSchedulerBootstrap: () => fakeBoot,
    fetchTaskRecord: async (id: string) => tasks.get(id) ?? null,
  };
});

import request from "supertest";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;

async function login(username: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

beforeAll(() => {
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(() => {
  jobs.clear();
  tasks.clear();
  app = createApp();
});

afterEach(() => vi.clearAllMocks());

describe("/api/scheduler auth + RBAC", () => {
  it("rejects anonymous calls with 401", async () => {
    const res = await request(app).get("/api/scheduler");
    expect(res.status).toBe(401);
  });

  it("reader can list (scheduler.read)", async () => {
    const token = await login("reader");
    const res = await request(app).get("/api/scheduler").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("reader cannot create (needs scheduler.manage)", async () => {
    const token = await login("reader");
    const res = await request(app)
      .post("/api/scheduler")
      .set("Authorization", `Bearer ${token}`)
      .send({ key: "k", name: "k", cron: "*/15 * * * *", taskType: "noop" });
    expect(res.status).toBe(403);
  });

  it("admin can create + run + pause + resume + delete", async () => {
    const token = await login("admin");
    const create = await request(app)
      .post("/api/scheduler")
      .set("Authorization", `Bearer ${token}`)
      .send({ key: "k", name: "k", cron: "*/15 * * * *", taskType: "noop" });
    expect(create.status).toBe(201);
    const id = create.body.data.id;
    expect(
      (await request(app).get(`/api/scheduler/${id}`).set("Authorization", `Bearer ${token}`))
        .status,
    ).toBe(200);
    expect(
      (await request(app).post(`/api/scheduler/${id}/run`).set("Authorization", `Bearer ${token}`))
        .status,
    ).toBe(202);
    expect(
      (
        await request(app)
          .post(`/api/scheduler/${id}/pause`)
          .set("Authorization", `Bearer ${token}`)
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post(`/api/scheduler/${id}/resume`)
          .set("Authorization", `Bearer ${token}`)
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .patch(`/api/scheduler/${id}`)
          .set("Authorization", `Bearer ${token}`)
          .send({ name: "renamed" })
      ).status,
    ).toBe(200);
    expect(
      (await request(app).delete(`/api/scheduler/${id}`).set("Authorization", `Bearer ${token}`))
        .status,
    ).toBe(204);
  });

  it("returns 404 for missing job detail", async () => {
    const token = await login("admin");
    const res = await request(app)
      .get("/api/scheduler/missing")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid create payload", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/scheduler")
      .set("Authorization", `Bearer ${token}`)
      .send({ key: "" });
    expect(res.status).toBe(400);
  });

  it("returns the registered handler catalogue", async () => {
    const token = await login("reader");
    const res = await request(app)
      .get("/api/scheduler/handlers")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it("history endpoint returns 404 for unknown job", async () => {
    const token = await login("admin");
    const res = await request(app)
      .get("/api/scheduler/missing/history")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("history endpoint returns 200 for existing job", async () => {
    const token = await login("admin");
    const c = await request(app)
      .post("/api/scheduler")
      .set("Authorization", `Bearer ${token}`)
      .send({ key: "k", name: "k", cron: "*/15 * * * *", taskType: "noop" });
    const res = await request(app)
      .get(`/api/scheduler/${c.body.data.id}/history`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe("/api/tasks", () => {
  it("rejects anonymous calls with 401", async () => {
    const res = await request(app).get("/api/tasks");
    expect(res.status).toBe(401);
  });

  it("reader can list (task.read)", async () => {
    const token = await login("reader");
    const res = await request(app).get("/api/tasks").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ items: expect.any(Array), total: expect.any(Number) });
  });

  it("returns 400 on invalid status filter", async () => {
    const token = await login("reader");
    const res = await request(app)
      .get("/api/tasks?status=banana")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("returns 404 on missing detail", async () => {
    const token = await login("reader");
    const res = await request(app)
      .get("/api/tasks/missing")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("admin can cancel + retry an existing task", async () => {
    const token = await login("admin");
    tasks.set("t1", { id: "t1", status: "running", type: "noop" });
    const cancel = await request(app)
      .post("/api/tasks/t1/cancel")
      .set("Authorization", `Bearer ${token}`);
    expect(cancel.status).toBe(202);
    const retry = await request(app)
      .post("/api/tasks/t1/retry")
      .set("Authorization", `Bearer ${token}`);
    expect(retry.status).toBe(202);
  });

  it("retry returns 404 on missing task", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/tasks/nope/retry")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("cancel returns 409 when task is not cancellable", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/tasks/missing/cancel")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(409);
  });

  it("reader cannot cancel (needs task.cancel)", async () => {
    const token = await login("reader");
    const res = await request(app)
      .post("/api/tasks/t1/cancel")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
