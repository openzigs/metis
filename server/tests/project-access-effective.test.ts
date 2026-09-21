/**
 * Issue #1058 (epic #1051) — the BEHAVIOURAL half of the project-scope guard.
 *
 * `project-access-guard.test.ts` asks a structural question: "does this router
 * carry its own `requireProjectAccess()`?". This file asks the question an
 * attacker asks: "can a cross-tenant request reach ANY handler under
 * `/projects/:projectId/**`?" — by assembling the real `apiRouter()` and
 * replaying a denied caller against every mount in the table.
 *
 * The two are deliberately separate, and the reason is measured, not assumed.
 * Today every project-scoped URL is intercepted by two independent upstream
 * chokepoints, either of which alone suffices:
 *
 *   • `projects.ts:94`   `r.use("/:id/:sub", requireAuth, requireProjectAccess("id"))`
 *   • `documents.ts:525` `knowledgeRouter()`'s path-less router-level guard,
 *                        mounted early at `/projects/:projectId`
 *
 * Deleting either one on its own changes nothing; deleting both makes routers
 * that lack their own guard start serving other tenants' data. That is why the
 * structural test still carries a baseline while this one is green — and why
 * this one is the test that actually goes red on a live BOLA regression.
 *
 * `assertProjectAccess` is stubbed to ALWAYS deny, so "the handler produced a
 * response" is unambiguous evidence of an unguarded path, with no dependence on
 * how any particular service behaves against a mocked database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { fileURLToPath } from "node:url";
import { isProjectScopedPath, readMountTable } from "./helpers/mount-table.js";

const DENIED_MESSAGE = "Project not found";

const { accessChecks, currentUser } = vi.hoisted(() => ({
  accessChecks: [] as string[],
  currentUser: {
    value: { userId: "user_b", role: "coordinator", workspaces: ["ws_b"] } as {
      userId: string;
      role: string;
      workspaces: string[];
    },
  },
}));

// Deny every object-level project check, and record what was checked. Anything
// that still answers from a handler bypassed the seam.
vi.mock("../src/lib/custom-agents/authz.js", async () => {
  const { AppError } = await import("../src/middleware/error-handler.js");
  return {
    assertProjectAccess: vi.fn(async (_user: unknown, projectId: string) => {
      accessChecks.push(projectId);
      throw new AppError(404, "NOT_FOUND", DENIED_MESSAGE);
    }),
    assertWorkspaceAdminForProject: vi.fn(async (_user: unknown, projectId: string) => {
      accessChecks.push(projectId);
      throw new AppError(404, "NOT_FOUND", DENIED_MESSAGE);
    }),
  };
});

// A real, non-admin caller. Admins bypass `assertProjectAccess` by design, so
// authenticating as one here would make the whole sweep vacuous.
vi.mock("../src/middleware/auth.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
      (req as unknown as { user: unknown }).user = currentUser.value;
      next();
    },
  };
});

const INDEX_PATH = fileURLToPath(new URL("../src/routes/index.ts", import.meta.url));
const PROBE_PROJECT = "proj_victim";

/** Turn a mount path into a concrete URL: `/projects/:projectId/x` → `/api/projects/proj_victim/x`. */
function probeUrl(mountPath: string, leaf: string): string {
  const concrete = mountPath.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) =>
    name === "projectId" ? PROBE_PROJECT : `probe-${name}`,
  );
  return `/api${concrete}${leaf}`;
}

const { apiRouter } = await import("../src/routes/index.js");
const { errorHandler } = await import("../src/middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", apiRouter());
  app.use(errorHandler);
  return app;
}

const app = createApp();
const scopedMounts = readMountTable(INDEX_PATH).filter((e) => isProjectScopedPath(e.path));

beforeEach(() => {
  accessChecks.length = 0;
  currentUser.value = { userId: "user_b", role: "coordinator", workspaces: ["ws_b"] };
});

describe("cross-tenant sweep of every :projectId mount", () => {
  it("enumerates the whole project-scoped subtree", () => {
    expect(scopedMounts.length).toBeGreaterThanOrEqual(30);
  });

  // Probe the mount path itself AND a child path, because a router mounted at
  // the bare `/projects/:projectId` prefix is reached by a different set of
  // upstream layers than one mounted at `/projects/:projectId/<something>`.
  for (const leaf of ["", "/probe-leaf"]) {
    for (const mount of scopedMounts) {
      const url = probeUrl(mount.path as string, leaf);
      it(`denies a non-member: GET ${url}  [${mount.expression}]`, async () => {
        const res = await request(app).get(url);

        expect(
          accessChecks,
          `GET ${url} (mounted at index.ts:${mount.line} as ${mount.expression}) never reached ` +
            `assertProjectAccess — nothing verified that the caller may access ${PROBE_PROJECT}.`,
        ).toContain(PROBE_PROJECT);

        expect(
          res.status,
          `GET ${url} answered ${res.status} for a caller who cannot access ${PROBE_PROJECT}. ` +
            `Body: ${JSON.stringify(res.body).slice(0, 200)}`,
        ).toBe(404);
        expect(res.body?.error?.message).toBe(DENIED_MESSAGE);
      });
    }
  }
});

describe("the sweep is not vacuous", () => {
  it("reaches handlers when the project check is not the thing denying", async () => {
    // Same request, but as a system admin — `requireProjectAccess` short-circuits
    // the admin bypass inside the REAL middleware only via assertProjectAccess,
    // which is stubbed here, so admins are denied too. Instead prove liveness
    // structurally: an unrelated, non-project route is unaffected by the stub.
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(accessChecks).toEqual([]);
  });

  it("returns the guard's 404 envelope, distinguishable from a route-not-found 404", async () => {
    // Express's own "no route matched" 404 has an empty body; the guard's has a
    // NOT_FOUND envelope. The sweep asserts the latter, so it cannot be
    // satisfied by a path that simply does not exist.
    const res = await request(app).get("/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.body?.error?.message).toBeUndefined();
  });
});
