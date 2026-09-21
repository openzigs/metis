/**
 * Issue #1074 (epic #1051) — `projectLibraryRouter()` must carry its OWN
 * object-level project-scope guard (OWASP A01 / BOLA).
 *
 * Before this test, the router's only stated protection was a helper named
 * `ensureProjectAccess` whose `where` clause was `{ id, deletedAt: null }` —
 * an existence check wearing an authorization name — and the three read routes
 * (`GET /skills`, `GET /skills/available`, `GET /agents`) never called even
 * that. The subtree was in practice protected by the `/projects/:id/:sub`
 * catch-all on `projectsRouter()` (`projects.ts:94`), mounted first in
 * `index.ts`, i.e. by the mount ORDER of a 90+ layer table declared in a
 * different file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS TEST CANNOT PASS FOR THE WRONG REASON
 * ─────────────────────────────────────────────────────────────────────────────
 * The whole point of #1074 is that a test which passes because of the UPSTREAM
 * catch-all proves nothing about THIS router. Two things make that impossible
 * here:
 *
 *   1. The catch-all is absent by CONSTRUCTION. This file never imports
 *      `src/app.js`, `src/routes/index.js` or `src/routes/projects.js`. The
 *      app under test is assembled by hand from exactly one router —
 *      `projectLibraryRouter()` — mounted at `/api/projects/:projectId/library`.
 *      No `projectsRouter()`, no `knowledgeRouter()`, no mount table.
 *
 *   2. That claim is verified, not asserted. `describe("positive control")`
 *      builds a SECOND app through the identical harness (same mock auth, same
 *      mock prisma, same mount path, same error handler) wrapping a router that
 *      reproduces the pre-fix shape — `requireAuth` only, no guard — and proves
 *      the same non-member request reaches the handler with 200. Identical
 *      harness, no guard → served; identical harness, real router → 404. The
 *      denials below are therefore attributable to the router and nothing else.
 *
 * `assertProjectAccess` is deliberately NOT stubbed: the real implementation
 * runs against a mocked prisma, so the admin-bypass and null-`workspaceId`
 * conventions are exercised for real rather than assumed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { Router, type Request, type Response, type NextFunction } from "express";
import request from "supertest";

const VICTIM_PROJECT = "proj_victim"; // owned by ws_a
const OPEN_PROJECT = "proj_no_workspace"; // pre-migration, workspaceId === null
const DELETED_PROJECT = "proj_deleted"; // soft-deleted, owned by ws_a

interface TestUser {
  userId: string;
  role: string;
  workspaces: string[];
}

const { currentUser, projectRows } = vi.hoisted(() => ({
  currentUser: { value: null as TestUser | null },
  projectRows: {
    value: new Map<string, { workspaceId: string | null; deletedAt: Date | null }>(),
  },
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    project: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = projectRows.value.get(where.id);
        return row ? { id: where.id, workspaceId: row.workspaceId } : null;
      },
      findFirst: async ({ where }: { where: { id: string; deletedAt: null } }) => {
        const row = projectRows.value.get(where.id);
        if (!row) return null;
        if (where.deletedAt === null && row.deletedAt !== null) return null;
        return { id: where.id, workspaceId: row.workspaceId };
      },
    },
  },
}));

// Authenticate as whoever the current test says. A `null` user means "the
// request arrived unauthenticated" — the guard's own 401 branch.
vi.mock("../../src/middleware/auth.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    requireAuth: (req: Request, _res: Response, next: NextFunction) => {
      if (currentUser.value) (req as unknown as { user: TestUser }).user = currentUser.value;
      next();
    },
  };
});

const { projectLibraryRouter } = await import("../../src/routes/library.js");
const { errorHandler } = await import("../../src/middleware/error-handler.js");
const { requireAuth } = await import("../../src/middleware/auth.js");
const { __setProjectLibraryAllowlist } = await import("../../src/lib/library/project-allowlist.js");

/** Records every allowlist call so "the handler ran" is directly observable. */
const handlerCalls: string[] = [];

function stubAllowlist() {
  const record = <T>(name: string, value: T) => {
    handlerCalls.push(name);
    return Promise.resolve(value);
  };
  return {
    listSkills: () => record("listSkills", [{ skillId: "sk_1", enabled: true }]),
    listAgents: () => record("listAgents", [{ agentId: "ag_1", enabled: true }]),
    resolveAvailableSkills: () =>
      record("resolveAvailableSkills", [
        { skillId: "sk_1", skillKey: "alpha", name: "Alpha", description: "d" },
      ]),
    setSkillEnabled: () => record("setSkillEnabled", undefined),
    removeSkill: () => record("removeSkill", undefined),
    setAgentEnabled: () => record("setAgentEnabled", undefined),
    removeAgent: () => record("removeAgent", undefined),
  };
}

/**
 * The app under test: ONE router, mounted directly. This is the bypass — there
 * is no `projectsRouter()` in this stack to intercept anything.
 */
function mountStandalone(router: Router) {
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/library", router);
  app.use(errorHandler);
  return app;
}

const app = mountStandalone(projectLibraryRouter());

/** Every route the router serves, as (method, path, body) triples. */
const ROUTES = [
  { method: "get", path: "/skills", body: undefined, ok: 200 },
  { method: "get", path: "/skills/available", body: undefined, ok: 200 },
  { method: "get", path: "/agents", body: undefined, ok: 200 },
  { method: "put", path: "/skills/sk_1", body: { enabled: true }, ok: 204 },
  { method: "delete", path: "/skills/sk_1", body: undefined, ok: 204 },
  { method: "put", path: "/agents/ag_1", body: { enabled: true }, ok: 204 },
  { method: "delete", path: "/agents/ag_1", body: undefined, ok: 204 },
] as const;

function call(target: express.Express, route: (typeof ROUTES)[number], projectId: string) {
  const url = `/api/projects/${projectId}/library${route.path}`;
  const agent = request(target) as unknown as Record<
    string,
    (u: string) => request.Test | undefined
  >;
  const req = agent[route.method]?.(url) as request.Test;
  return route.body ? req.send(route.body) : req;
}

beforeEach(() => {
  handlerCalls.length = 0;
  projectRows.value = new Map([
    [VICTIM_PROJECT, { workspaceId: "ws_a", deletedAt: null }],
    [OPEN_PROJECT, { workspaceId: null, deletedAt: null }],
    [DELETED_PROJECT, { workspaceId: "ws_a", deletedAt: new Date() }],
  ]);
  currentUser.value = { userId: "user_b", role: "coordinator", workspaces: ["ws_b"] };
  __setProjectLibraryAllowlist(stubAllowlist() as never);
});

describe("positive control — the harness itself protects nothing", () => {
  // Reproduces the pre-#1074 router shape: `requireAuth` on each route, no
  // object-level guard. If this returned 404 the suite below would be
  // meaningless, because the denials could be coming from the test rig.
  function unguardedRouter(): Router {
    const r = Router({ mergeParams: true });
    for (const route of ROUTES) {
      (r as unknown as Record<string, (p: string, ...h: unknown[]) => void>)[route.method](
        route.path,
        requireAuth,
        (_req: Request, res: Response) => {
          handlerCalls.push(`unguarded:${route.method} ${route.path}`);
          res.json({ success: true, data: {} });
        },
      );
    }
    return r;
  }

  const unguarded = mountStandalone(unguardedRouter());

  for (const route of ROUTES) {
    it(`serves a non-member without a guard: ${route.method.toUpperCase()} ${route.path}`, async () => {
      const res = await call(unguarded, route, VICTIM_PROJECT);
      expect(res.status).toBe(200);
      expect(handlerCalls).toContain(`unguarded:${route.method} ${route.path}`);
    });
  }
});

describe("projectLibraryRouter mounts its own guard ahead of every route", () => {
  it("registers requireProjectAccess() before the first route layer", () => {
    // Structural companion to the behavioural sweep: a guard mounted after a
    // route does not protect it, and the failure would be silent.
    const stack = (projectLibraryRouter() as unknown as { stack: Array<Record<string, unknown>> })
      .stack;
    const guardAt = stack.findIndex(
      (l) => (l.handle as { name?: string } | undefined)?.name === "requireProjectAccessMiddleware",
    );
    const firstRouteAt = stack.findIndex((l) => l.route !== undefined);
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(firstRouteAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeLessThan(firstRouteAt);
  });

  it("exposes exactly the seven routes this suite sweeps", () => {
    // Guards against a route being added later and quietly escaping the sweep.
    const stack = (projectLibraryRouter() as unknown as { stack: Array<Record<string, unknown>> })
      .stack;
    const routes = stack
      .filter((l) => l.route !== undefined)
      .map((l) => {
        const route = l.route as { path: string; methods?: Record<string, boolean> };
        const method = Object.keys(route.methods ?? {})[0];
        return `${method} ${route.path}`;
      })
      .sort();
    expect(routes).toEqual(
      ROUTES.map(
        (r) => `${r.method} ${r.path.replace(/sk_1$/, ":skillId").replace(/ag_1$/, ":agentId")}`,
      ).sort(),
    );
  });
});

describe("non-member is denied on every route, including the three GETs", () => {
  for (const route of ROUTES) {
    it(`404s: ${route.method.toUpperCase()} ${route.path}`, async () => {
      const res = await call(app, route, VICTIM_PROJECT);
      expect(res.status).toBe(404);
      expect(res.body?.error?.code).toBe("NOT_FOUND");
      // No handler ran — the denial happened before any service call, so the
      // response body cannot leak allowlist contents either.
      expect(handlerCalls).toEqual([]);
    });
  }

  it("denies with 404 rather than 403 even when the role lacks project.update", async () => {
    // Role-first ordering would answer 403 and confirm the project exists.
    currentUser.value = { userId: "user_b", role: "reader", workspaces: ["ws_b"] };
    const res = await request(app)
      .put(`/api/projects/${VICTIM_PROJECT}/library/skills/sk_1`)
      .send({ enabled: true });
    expect(res.status).toBe(404);
    expect(handlerCalls).toEqual([]);
  });

  it("404s for an unknown project id without distinguishing it from a denial", async () => {
    const res = await request(app).get(`/api/projects/proj_does_not_exist/library/skills`);
    expect(res.status).toBe(404);
    expect(res.body?.error?.code).toBe("NOT_FOUND");
  });

  it("401s when the request is unauthenticated", async () => {
    currentUser.value = null;
    const res = await request(app).get(`/api/projects/${VICTIM_PROJECT}/library/skills`);
    expect(res.status).toBe(401);
    expect(handlerCalls).toEqual([]);
  });
});

describe("a legitimate member still succeeds on every route", () => {
  beforeEach(() => {
    currentUser.value = { userId: "user_a", role: "coordinator", workspaces: ["ws_a"] };
  });

  for (const route of ROUTES) {
    it(`${route.ok}s: ${route.method.toUpperCase()} ${route.path}`, async () => {
      const res = await call(app, route, VICTIM_PROJECT);
      expect(res.status).toBe(route.ok);
      expect(handlerCalls.length).toBe(1);
    });
  }
});

describe("the established access conventions hold", () => {
  it("lets a system admin through with no workspace membership at all", async () => {
    currentUser.value = { userId: "root", role: "admin", workspaces: [] };
    const res = await request(app).get(`/api/projects/${VICTIM_PROJECT}/library/skills`);
    expect(res.status).toBe(200);
    expect(handlerCalls).toEqual(["listSkills"]);
  });

  it("treats a pre-migration null-workspace project as open to any authenticated user", async () => {
    currentUser.value = { userId: "user_b", role: "coordinator", workspaces: ["ws_b"] };
    const res = await request(app).get(`/api/projects/${OPEN_PROJECT}/library/skills`);
    expect(res.status).toBe(200);
    expect(handlerCalls).toEqual(["listSkills"]);
  });

  it("still 404s a soft-deleted project on mutations (ensureProjectExists survives the rename)", async () => {
    // The renamed helper is the ONLY thing carrying the soft-delete check; the
    // access guard resolves the project without consulting `deletedAt`.
    currentUser.value = { userId: "user_a", role: "coordinator", workspaces: ["ws_a"] };
    const res = await request(app)
      .put(`/api/projects/${DELETED_PROJECT}/library/skills/sk_1`)
      .send({ enabled: true });
    expect(res.status).toBe(404);
    expect(res.body?.error?.code).toBe("PROJECT_NOT_FOUND");
    expect(handlerCalls).toEqual([]);
  });

  it("surfaces an AllowlistError with its own status and code, not a bare 500", async () => {
    // The four mutations funnel service failures through `rethrow`. A member
    // who clears the guard must still get the service's intended status.
    const { AllowlistError } = await import("../../src/lib/library/project-allowlist.js");
    currentUser.value = { userId: "user_a", role: "coordinator", workspaces: ["ws_a"] };
    __setProjectLibraryAllowlist({
      setSkillEnabled: () => {
        handlerCalls.push("setSkillEnabled");
        return Promise.reject(new AllowlistError(409, "SKILL_ARCHIVED", "Skill is archived"));
      },
    } as never);
    const res = await request(app)
      .put(`/api/projects/${VICTIM_PROJECT}/library/skills/sk_1`)
      .send({ enabled: true });
    expect(res.status).toBe(409);
    expect(res.body?.error?.code).toBe("SKILL_ARCHIVED");
    expect(handlerCalls).toEqual(["setSkillEnabled"]);
  });

  for (const route of [
    { path: "/skills/sk_1", method: "delete", fn: "removeSkill" },
    { path: "/agents/ag_1", method: "put", fn: "setAgentEnabled" },
    { path: "/agents/ag_1", method: "delete", fn: "removeAgent" },
  ] as const) {
    it(`rethrows a non-Allowlist service failure as 500: ${route.method.toUpperCase()} ${route.path}`, async () => {
      currentUser.value = { userId: "user_a", role: "coordinator", workspaces: ["ws_a"] };
      __setProjectLibraryAllowlist({
        [route.fn]: () => Promise.reject(new Error("db offline")),
      } as never);
      const req = request(app)[route.method](
        `/api/projects/${VICTIM_PROJECT}/library${route.path}`,
      );
      const res = await (route.method === "put" ? req.send({ enabled: true }) : req);
      expect(res.status).toBe(500);
    });
  }

  it("rejects an invalid mutation body before touching the service", async () => {
    currentUser.value = { userId: "user_a", role: "coordinator", workspaces: ["ws_a"] };
    const res = await request(app)
      .put(`/api/projects/${VICTIM_PROJECT}/library/skills/sk_1`)
      .send({ enabled: "yes" });
    expect(res.status).toBe(400);
    expect(handlerCalls).toEqual([]);
  });
});
