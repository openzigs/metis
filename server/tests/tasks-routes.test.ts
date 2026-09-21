/**
 * /api/tasks HTTP route tests (Issue #128, Epic #119).
 *
 * Exercises the tasks router over HTTP: list (with filters + validation),
 * detail, cancel, and retry — asserting success paths, validation/error
 * paths, auth, and not-found cases. Prisma + the scheduler bootstrap are
 * mocked; RBAC + project-access run for real against the seeded admin.
 *
 * Provider guardrail (Epic #119): these tests touch the scheduler/task layer
 * only and never stub provider routing, so Bedrock / local-gemma behaviour is
 * unaffected.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface TaskRow {
  id: string;
  type: string;
  status: string;
  projectId: string | null;
  payload: string;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  updatedAt: Date;
}

const tasks = new Map<string, TaskRow>();

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        id: "user_admin",
        ...create,
      })),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    project: { findMany: vi.fn(async () => []) },
    task: {
      findMany: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) =>
        Array.from(tasks.values()).filter((t) => {
          for (const [k, v] of Object.entries(where)) {
            if (k === "OR") continue;
            if ((t as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          return true;
        }),
      ),
      count: vi.fn(
        async ({ where = {} }: { where?: Record<string, unknown> } = {}) =>
          Array.from(tasks.values()).filter((t) => {
            for (const [k, v] of Object.entries(where)) {
              if (k === "OR") continue;
              if ((t as unknown as Record<string, unknown>)[k] !== v) return false;
            }
            return true;
          }).length,
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => tasks.get(where.id) ?? null,
      ),
    },
  });
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const queue = {
  cancel: vi.fn(async (id: string) => tasks.has(id)),
  retry: vi.fn(async (id: string) => ({ id: `${id}_retry`, status: "pending" })),
};

vi.mock("../src/lib/scheduler/index.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/scheduler/index.js")>(
    "../src/lib/scheduler/index.js",
  );
  return {
    ...actual,
    getSchedulerBootstrap: () => ({ queue }),
    fetchTaskRecord: async (id: string) => tasks.get(id) ?? null,
  };
});

import request from "supertest";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;
let token: string;

async function login(): Promise<string> {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ username: "admin", password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

function seedTask(overrides: Partial<TaskRow> = {}): TaskRow {
  const id = overrides.id ?? `task_${tasks.size + 1}`;
  const row: TaskRow = {
    id,
    type: "analysis.run",
    status: "pending",
    projectId: "proj_1",
    payload: "{}",
    attempts: 0,
    maxAttempts: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  tasks.set(id, row);
  return row;
}

beforeAll(() => {
  process.env.AI_OFFLINE = "1";
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(async () => {
  tasks.clear();
  app = createApp();
  token = await login();
});

afterEach(() => vi.clearAllMocks());

describe("GET /api/tasks", () => {
  it("rejects anonymous calls with 401", async () => {
    const res = await request(app).get("/api/tasks");
    expect(res.status).toBe(401);
  });

  it("returns the task list with a total", async () => {
    seedTask({ id: "task_a", status: "pending" });
    seedTask({ id: "task_b", status: "completed" });
    const res = await request(app).get("/api/tasks").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.items).toHaveLength(2);
  });

  it("filters by status", async () => {
    seedTask({ id: "task_a", status: "pending" });
    seedTask({ id: "task_b", status: "completed" });
    const res = await request(app)
      .get("/api/tasks?status=completed")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].status).toBe("completed");
  });

  it("rejects an unknown status with 400", async () => {
    const res = await request(app)
      .get("/api/tasks?status=bogus")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_STATUS");
  });
});

describe("GET /api/tasks/:id", () => {
  it("returns 404 for a missing task", async () => {
    const res = await request(app).get("/api/tasks/nope").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("returns the task detail", async () => {
    seedTask({ id: "task_detail" });
    const res = await request(app)
      .get("/api/tasks/task_detail")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("task_detail");
  });
});

describe("POST /api/tasks/:id/cancel", () => {
  it("cancels a cancellable task with 202", async () => {
    seedTask({ id: "task_cancel", status: "running" });
    const res = await request(app)
      .post("/api/tasks/task_cancel/cancel")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(202);
    expect(queue.cancel).toHaveBeenCalledWith("task_cancel", expect.stringContaining("cancelled"));
  });

  it("returns 409 when the task is not cancellable", async () => {
    const res = await request(app)
      .post("/api/tasks/ghost/cancel")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("TASK_NOT_CANCELLABLE");
  });
});

describe("POST /api/tasks/:id/retry", () => {
  it("returns 404 when the original task is missing", async () => {
    const res = await request(app)
      .post("/api/tasks/nope/retry")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("re-enqueues a task with 202", async () => {
    seedTask({ id: "task_retry", status: "failed" });
    const res = await request(app)
      .post("/api/tasks/task_retry/retry")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(202);
    expect(res.body.data.taskId).toBe("task_retry_retry");
    expect(queue.retry).toHaveBeenCalled();
  });
});
