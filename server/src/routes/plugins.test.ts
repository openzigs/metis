/**
 * #678 (epic #671) — `POST /api/plugins/import` authorization.
 *
 * The import endpoint installs skills / custom agents / hooks into the target
 * project named in the request BODY. Before #678 it authenticated only, so any
 * logged-in user could install content into an arbitrary project (OWASP A01 /
 * BOLA). This suite exercises the REAL `requirePermission("mcp.manage")` (role
 * layer) and `assertProjectAccess` (object layer) wired onto the route:
 *   - object-level scope: a caller who can reach the project via role but is not
 *     a member of the body `projectId`'s workspace → 404 (no existence oracle,
 *     admin bypass);
 *   - role scope: a caller who can reach the project but lacks `mcp.manage`
 *     → 403;
 *   - a permitted in-tenant caller (coordinator) and a system admin → succeed.
 *
 * `mcp.manage` is the same scope the sibling #675 hooks router requires to
 * create hook subscriptions, which plugin import also does (via
 * `createSubscription`); coordinator carries it, so the object layer stays
 * meaningful for non-admins.
 *
 * Prisma, the audit sink, and the agent/hook create helpers are mocked so the
 * test asserts authorization, not persistence.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

interface TestUser {
  userId: string;
  role: string;
  workspaces?: string[];
}
let currentUser: TestUser = { userId: "user-1", role: "coordinator", workspaces: ["ws-1"] };
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: TestUser }).user = currentUser;
    next();
  },
}));

const projectFindUnique = vi.fn();
const skillCreate = vi.fn();
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: projectFindUnique },
    skill: { create: skillCreate },
    customAgent: { findMany: vi.fn() },
    hookSubscription: { findMany: vi.fn() },
  },
}));
vi.mock("../lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
const createAgent = vi.fn();
vi.mock("../lib/custom-agents/index.js", () => ({ createAgent }));
const createSubscription = vi.fn();
vi.mock("../lib/hooks/index.js", () => ({ createSubscription }));

const { pluginsRouter } = await import("./plugins.js");
const { errorHandler } = await import("../middleware/error-handler.js");
const { pack } = await import("../lib/plugins/index.js");

function createApp() {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use("/api/plugins", pluginsRouter());
  app.use(errorHandler);
  return app;
}

/**
 * A valid envelope carrying one of each content type so a permitted import
 * exercises every install path (skills / agents / hooks).
 */
function envelope() {
  const buf = pack({
    manifest: { name: "demo-plugin", version: "1.0.0", description: "" },
    skills: [
      {
        name: "Demo",
        description: "d",
        version: "1.0.0",
        instructions: "do things",
        tools: [],
        tags: [],
      },
    ],
    agents: [
      {
        name: "Agent",
        description: "a",
        systemPrompt: "be helpful",
        tools: [],
        model: null,
        reasoningEffort: null,
      },
    ],
    hooks: [{ event: "sessionEnd", handlerKind: "webhook", config: {} }],
  });
  return JSON.parse(buf.toString("utf-8"));
}

let app: ReturnType<typeof createApp>;
beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { userId: "user-1", role: "coordinator", workspaces: ["ws-1"] };
  // Default: the target project lives in a workspace the caller belongs to.
  projectFindUnique.mockResolvedValue({ id: "proj-1", workspaceId: "ws-1" });
  skillCreate.mockResolvedValue({});
  app = createApp();
});

describe("POST /api/plugins/import — object-level scope (assertProjectAccess)", () => {
  it("404s a permitted caller who is not a member of the target workspace", async () => {
    // coordinator carries mcp.manage (passes the role layer) but belongs only to
    // ws-1; the target project lives in ws-other → object layer 404, no oracle.
    projectFindUnique.mockResolvedValue({ id: "proj-victim", workspaceId: "ws-other" });
    const res = await request(app)
      .post("/api/plugins/import")
      .send({ projectId: "proj-victim", envelope: envelope() });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(skillCreate).not.toHaveBeenCalled();
  });
});

describe("POST /api/plugins/import — role scope (requirePermission)", () => {
  it("403s a caller who lacks mcp.manage even for a reachable project", async () => {
    // developer holds mcp.read but not mcp.manage.
    currentUser = { userId: "dev-1", role: "developer", workspaces: ["ws-1"] };
    const res = await request(app)
      .post("/api/plugins/import")
      .send({ projectId: "proj-1", envelope: envelope() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(skillCreate).not.toHaveBeenCalled();
  });
});

describe("POST /api/plugins/import — permitted callers", () => {
  it("imports for an in-tenant coordinator (role + object both pass)", async () => {
    currentUser = { userId: "user-1", role: "coordinator", workspaces: ["ws-1"] };
    const res = await request(app)
      .post("/api/plugins/import")
      .send({ projectId: "proj-1", envelope: envelope() });
    expect(res.status).toBe(201);
    expect(res.body.data.installed).toEqual({ skills: 1, agents: 1, hooks: 1 });
    expect(skillCreate).toHaveBeenCalledOnce();
    expect(createAgent).toHaveBeenCalledOnce();
    // Imported hooks are forced disabled (sandboxed until explicit enablement).
    expect(createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-1", enabled: false }),
      "user-1",
    );
  });

  it("imports for a system admin (bypasses object scope)", async () => {
    currentUser = { userId: "root", role: "admin", workspaces: [] };
    const res = await request(app)
      .post("/api/plugins/import")
      .send({ projectId: "proj-1", envelope: envelope() });
    expect(res.status).toBe(201);
    expect(res.body.data.installed.skills).toBe(1);
  });

  it("400s a permitted caller on a malformed envelope (after authz passes)", async () => {
    currentUser = { userId: "user-1", role: "coordinator", workspaces: ["ws-1"] };
    const res = await request(app)
      .post("/api/plugins/import")
      .send({ projectId: "proj-1", envelope: { not: "a plugin" } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PLUGIN_FORMAT");
    expect(skillCreate).not.toHaveBeenCalled();
  });

  it("404s an admin importing into a non-existent project", async () => {
    currentUser = { userId: "root", role: "admin", workspaces: [] };
    projectFindUnique.mockResolvedValue(null);
    const res = await request(app)
      .post("/api/plugins/import")
      .send({ projectId: "ghost", envelope: envelope() });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(skillCreate).not.toHaveBeenCalled();
  });
});
