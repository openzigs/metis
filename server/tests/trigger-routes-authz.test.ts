/**
 * #1064 (epic #1051) — object-level project scope for
 * `/api/projects/:projectId/triggers`.
 *
 * `projectTriggersRouter()` is mounted project-scoped with `mergeParams: true`
 * but gated only on `requireAuth` + a GLOBAL-role `requirePermission(...)`. The
 * list route returned whole `Trigger` rows, and a trigger's `config.secret` is
 * the HMAC key that the UNAUTHENTICATED receivers (`POST /api/triggers/:id/fire`,
 * `POST /api/webhooks/github|slack`) verify against. So the missing scope was not
 * mere disclosure: any `project.read` caller — `reader`, the lowest tier — could
 * lift another tenant's signing key and then forge deliveries that pass
 * `verifyGenericWebhook` / `verifyGithubWebhook`.
 *
 * On the WRITE routes the picture is narrower than it first looks: `admin.write`
 * is carried by `admin` alone (`packages/shared/src/rbac.ts`), and `admin` is
 * exactly the role `assertProjectAccess` bypasses. So a non-admin never reached
 * those handlers to begin with. The guard still belongs there — it makes the
 * denial order uniform (object scope BEFORE role, so a wrong-tenant caller is
 * turned away identically regardless of role) and it means the routes stay safe
 * if `admin.write` is ever granted to a lower tier.
 *
 * These tests exercise the REAL `requireProjectAccess` + `requirePermission`
 * middleware wired onto the router.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

interface TestUser {
  userId: string;
  role: string;
  workspaces?: string[];
}
let currentUser: TestUser | undefined = { userId: "user-1", role: "reader", workspaces: ["ws-1"] };
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: TestUser | undefined }).user = currentUser;
    next();
  },
}));

const projectFindUnique = vi.fn();
const triggerFindMany = vi.fn();
const triggerCreate = vi.fn();
const triggerUpdate = vi.fn();
const triggerDelete = vi.fn();
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: projectFindUnique },
    trigger: {
      findMany: triggerFindMany,
      create: triggerCreate,
      update: triggerUpdate,
      delete: triggerDelete,
    },
  },
}));

vi.mock("../src/lib/async/runner.js", () => ({
  getAsyncRunner: () => ({ submit: vi.fn(async () => ({ id: "bg_1" })) }),
}));

const { projectTriggersRouter } = await import("../src/routes/triggers.js");
const { errorHandler } = await import("../src/middleware/error-handler.js");

/** The webhook signing secret an attacker would be hunting for. */
const VICTIM_SECRET = "victim-hmac-signing-key";

function triggerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "trg_1",
    projectId: "proj-victim",
    name: "GH",
    source: "github",
    config: JSON.stringify({ secret: VICTIM_SECRET, repo: "acme/app", event: "issues.opened" }),
    enabled: true,
    lastFiredAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/triggers", projectTriggersRouter());
  app.use(errorHandler);
  return app;
}

const createBody = {
  name: "GH",
  source: "github",
  config: { repo: "acme/app", secret: "s1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  // Lowest tier that carries `project.read` — the exact attacker profile.
  currentUser = { userId: "user-1", role: "reader", workspaces: ["ws-1"] };
  // Default: the path project lives in a workspace the caller belongs to.
  projectFindUnique.mockResolvedValue({ workspaceId: "ws-1" });
  triggerFindMany.mockResolvedValue([triggerRow()]);
  triggerCreate.mockResolvedValue(triggerRow());
  triggerUpdate.mockResolvedValue(triggerRow({ enabled: false }));
  triggerDelete.mockResolvedValue(triggerRow());
});

describe("triggers — cross-tenant read is refused and the HMAC secret stays unreachable", () => {
  it("404s a `reader` listing another tenant's triggers and leaks no secret", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-other" });
    const res = await request(buildApp()).get("/api/projects/proj-victim/triggers");
    expect(res.status).toBe(404);
    // The handler body must never run — no query, so there is no row to leak.
    expect(triggerFindMany).not.toHaveBeenCalled();
    // The signing key is nowhere in the response.
    expect(JSON.stringify(res.body)).not.toContain(VICTIM_SECRET);
  });

  it("404s a coordinator too — object scope is not a role-tier concession", async () => {
    currentUser = { userId: "user-3", role: "coordinator", workspaces: ["ws-1"] };
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-other" });
    const res = await request(buildApp()).get("/api/projects/proj-victim/triggers");
    expect(res.status).toBe(404);
    expect(triggerFindMany).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain(VICTIM_SECRET);
  });

  it("404s an unknown project id (no existence oracle)", async () => {
    projectFindUnique.mockResolvedValueOnce(null);
    const res = await request(buildApp()).get("/api/projects/nope/triggers");
    expect(res.status).toBe(404);
    expect(triggerFindMany).not.toHaveBeenCalled();
  });

  it("401s when no user was attached, before any project lookup", async () => {
    currentUser = undefined;
    const res = await request(buildApp()).get("/api/projects/proj-1/triggers");
    expect(res.status).toBe(401);
    expect(projectFindUnique).not.toHaveBeenCalled();
    expect(triggerFindMany).not.toHaveBeenCalled();
  });
});

describe("triggers — write routes run object scope BEFORE the role check", () => {
  // `admin.write` belongs to `admin` alone, so these callers were already
  // refused by role. The assertion that matters is the ORDER: a wrong-tenant
  // caller is turned away by the project guard first, so the response does not
  // vary with the caller's role.
  it("404s (not 403) a coordinator creating a trigger in another tenant's project", async () => {
    currentUser = { userId: "user-3", role: "coordinator", workspaces: ["ws-1"] };
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-other" });
    const res = await request(buildApp())
      .post("/api/projects/proj-victim/triggers")
      .send(createBody);
    expect(res.status).toBe(404);
    expect(triggerCreate).not.toHaveBeenCalled();
  });

  it("404s (not 403) a coordinator patching a trigger in another tenant's project", async () => {
    currentUser = { userId: "user-3", role: "coordinator", workspaces: ["ws-1"] };
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-other" });
    const res = await request(buildApp())
      .patch("/api/projects/proj-victim/triggers/trg_1")
      .send({ enabled: false });
    expect(res.status).toBe(404);
    expect(triggerUpdate).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain(VICTIM_SECRET);
  });

  it("404s (not 403) a coordinator deleting a trigger in another tenant's project", async () => {
    currentUser = { userId: "user-3", role: "coordinator", workspaces: ["ws-1"] };
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-other" });
    const res = await request(buildApp()).delete("/api/projects/proj-victim/triggers/trg_1");
    expect(res.status).toBe(404);
    expect(triggerDelete).not.toHaveBeenCalled();
  });

  it("still applies the role layer inside the caller's own workspace — 403", async () => {
    currentUser = { userId: "user-3", role: "coordinator", workspaces: ["ws-1"] };
    const res = await request(buildApp()).post("/api/projects/proj-1/triggers").send(createBody);
    expect(res.status).toBe(403);
    expect(triggerCreate).not.toHaveBeenCalled();
  });
});

describe("triggers — legitimate callers are still served (no over-blocking)", () => {
  it("lists triggers for a project in the caller's workspace", async () => {
    const res = await request(buildApp()).get("/api/projects/proj-1/triggers");
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(triggerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "proj-1" } }),
    );
  });

  it("serves a system admin regardless of workspace membership", async () => {
    currentUser = { userId: "admin-1", role: "admin", workspaces: [] };
    const res = await request(buildApp()).get("/api/projects/proj-any/triggers");
    expect(res.status).toBe(200);
    expect(projectFindUnique).not.toHaveBeenCalled();
  });

  it("keeps the pre-migration null-workspace project open to any authenticated user", async () => {
    currentUser = { userId: "user-2", role: "reader", workspaces: [] };
    projectFindUnique.mockResolvedValueOnce({ workspaceId: null });
    const res = await request(buildApp()).get("/api/projects/proj-legacy/triggers");
    expect(res.status).toBe(200);
    expect(triggerFindMany).toHaveBeenCalled();
  });

  it("lets an admin create a trigger in the project named on the path", async () => {
    currentUser = { userId: "admin-1", role: "admin", workspaces: [] };
    const res = await request(buildApp()).post("/api/projects/proj-1/triggers").send(createBody);
    expect(res.status).toBe(201);
    expect(triggerCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ projectId: "proj-1" }) }),
    );
  });

  it("lets an admin patch a trigger", async () => {
    currentUser = { userId: "admin-1", role: "admin", workspaces: [] };
    const res = await request(buildApp())
      .patch("/api/projects/proj-1/triggers/trg_1")
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(triggerUpdate).toHaveBeenCalled();
  });

  it("lets an admin delete a trigger", async () => {
    currentUser = { userId: "admin-1", role: "admin", workspaces: [] };
    const res = await request(buildApp()).delete("/api/projects/proj-1/triggers/trg_1");
    expect(res.status).toBe(200);
    expect(triggerDelete).toHaveBeenCalled();
  });

  it("400s when the path carries no project id", async () => {
    const app = express();
    app.use(express.json());
    // Mounted without the :projectId segment — the guard must not fall open.
    app.use("/api/triggers-unscoped", projectTriggersRouter());
    app.use(errorHandler);
    const res = await request(app).get("/api/triggers-unscoped/");
    expect(res.status).toBe(400);
    expect(triggerFindMany).not.toHaveBeenCalled();
  });
});

describe("triggers — response shape never carries the HMAC signing secret", () => {
  it("strips config.secret from the list route while keeping the fields the UI reads", async () => {
    const res = await request(buildApp()).get("/api/projects/proj-1/triggers");
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(VICTIM_SECRET);
    const item = res.body.data.items[0] as { config: string; name: string; source: string };
    // The UI (`ui/src/app/(authed)/settings/triggers/page.tsx`) JSON.parses
    // `config` and renders `cfg.repo`, so the non-secret keys must survive.
    const cfg = JSON.parse(item.config) as Record<string, unknown>;
    expect(cfg).toEqual({ repo: "acme/app", event: "issues.opened" });
    expect(item.name).toBe("GH");
    expect(item.source).toBe("github");
  });

  it("strips config.secret from the create response", async () => {
    currentUser = { userId: "admin-1", role: "admin", workspaces: [] };
    const res = await request(buildApp()).post("/api/projects/proj-1/triggers").send(createBody);
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain(VICTIM_SECRET);
    expect(JSON.parse(res.body.data.config as string)).not.toHaveProperty("secret");
  });

  it("strips config.secret from the patch response", async () => {
    currentUser = { userId: "admin-1", role: "admin", workspaces: [] };
    const res = await request(buildApp())
      .patch("/api/projects/proj-1/triggers/trg_1")
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(VICTIM_SECRET);
    expect(JSON.parse(res.body.data.config as string)).not.toHaveProperty("secret");
  });

  it("tolerates an unparseable config without echoing its raw text", async () => {
    triggerFindMany.mockResolvedValueOnce([triggerRow({ config: `not json ${VICTIM_SECRET}` })]);
    const res = await request(buildApp()).get("/api/projects/proj-1/triggers");
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(VICTIM_SECRET);
    expect(JSON.parse(res.body.data.items[0].config as string)).toEqual({});
  });
});
