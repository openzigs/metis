/**
 * #1878 — the governing-documents feature is ON by default: with
 * `GOVERNING_DOCS_ENABLED` unset, every route of the governing-documents and
 * governing-rules routers is past the flag gate, and set to `"0"` every one of
 * them is a 404 before authentication runs. The routes are read from the
 * routers' own stacks, so a route added later is covered without editing this
 * test.
 *
 * "Past the gate" is read from authentication itself: the gate runs before
 * `requireAuth`, so the stub below counts its calls. The caller is a
 * non-admin who is not a member of the workspace, so once past the gate every
 * route must still refuse it (`requireWorkspaceRole`: 404 "Workspace not
 * found") — the flag flip opens no route to an outsider.
 *
 * The analysis-scoped governing routes (`/:id/governing-applicability`,
 * `/:id/governing-findings`, `…/decision`) check the flag after
 * authentication; their `"0"` → 404 is asserted against a real router and
 * SQLite in `tests/governing-findings-1874.sqlite.test.ts` and
 * `tests/governing-questions-round-trip-1873.sqlite.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Router } from "express";
import request from "supertest";

const auth = vi.hoisted(() => ({ calls: 0 }));
/** A deployment `reader` with no membership in `ws-1`. */
const OUTSIDER = { userId: "u-outsider", role: "reader", workspaces: ["ws-other"] };
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    auth.calls += 1;
    (req as unknown as { user: unknown }).user = OUTSIDER;
    next();
  },
}));
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    workspace: { findFirst: vi.fn(async () => ({ id: "ws-1" })) },
    workspaceMember: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("../lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { governingDocumentsRouter, governingRulesRouter } = await import("./governing-documents.js");
const { errorHandler } = await import("../middleware/error-handler.js");
const { GOVERNING_DOCS_ENABLED_DEFAULT } = await import("../lib/governing/flag.js");

/** Each router at its `routes/index.ts` mount, and where this test calls it. */
const MOUNTS: Array<{ mount: string; base: string; router: () => Router }> = [
  {
    mount: "/api/workspaces/:workspaceId/governing-documents",
    base: "/api/workspaces/ws-1/governing-documents",
    router: () => governingDocumentsRouter(),
  },
  {
    mount: "/api/workspaces/:workspaceId/governing-rules",
    base: "/api/workspaces/ws-1/governing-rules",
    router: () => governingRulesRouter(),
  },
];

type Method = "get" | "post" | "put" | "patch" | "delete";

/** Every (method, path) a router declares, with its `:params` filled in. */
function routesOf(router: Router): Array<{ method: Method; path: string }> {
  const out: Array<{ method: Method; path: string }> = [];
  for (const layer of router.stack as Array<{
    route?: { path: string; methods: Record<string, boolean> };
  }>) {
    if (!layer.route) continue;
    for (const [method, on] of Object.entries(layer.route.methods)) {
      if (on) out.push({ method: method as Method, path: layer.route.path.replace(/:\w+/g, "x1") });
    }
  }
  return out;
}

function app(): express.Express {
  const a = express();
  a.use(express.json());
  for (const m of MOUNTS) a.use(m.mount, m.router());
  a.use(errorHandler);
  return a;
}

interface Outcome {
  route: string;
  status: number;
  message?: string;
  /** Whether `requireAuth` ran for this request: the flag gate let it through. */
  authenticated: boolean;
}

/** Every governing route, called once by {@link OUTSIDER}. */
async function outcomes(): Promise<Outcome[]> {
  const a = app();
  const out: Outcome[] = [];
  for (const m of MOUNTS) {
    for (const r of routesOf(m.router())) {
      const url = `${m.base}${r.path === "/" ? "" : r.path}`;
      const before = auth.calls;
      const res = await request(a)[r.method](url);
      out.push({
        route: `${r.method.toUpperCase()} ${url}`,
        status: res.status,
        message: res.body?.error?.message,
        authenticated: auth.calls > before,
      });
    }
  }
  return out;
}

describe('#1878 — GOVERNING_DOCS_ENABLED is on by default; "0" still turns every governing route off', () => {
  beforeEach(() => {
    auth.calls = 0;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("finds every route of both routers", () => {
    const [documents, rules] = MOUNTS.map((m) => routesOf(m.router()).map((r) => r.method));
    // Documents: upload, new revision, list, read, rules, retry extraction, delete; rules: edit.
    expect(documents!.length).toBeGreaterThanOrEqual(7);
    expect(documents).toEqual(expect.arrayContaining(["get", "post", "delete"]));
    expect(rules).toEqual(expect.arrayContaining(["patch"]));
  });

  it("unset, every route is past the flag gate, and still refuses a non-member", async () => {
    vi.stubEnv("GOVERNING_DOCS_ENABLED", undefined);
    expect(GOVERNING_DOCS_ENABLED_DEFAULT).toBe(true);
    for (const o of await outcomes()) {
      expect(o, o.route).toEqual({
        route: o.route,
        status: 404,
        message: "Workspace not found",
        authenticated: true,
      });
    }
  });

  it.each(["0", "false", "off", ""])(
    "set to %j, every route is a 404 before authentication runs",
    async (value) => {
      vi.stubEnv("GOVERNING_DOCS_ENABLED", value);
      for (const o of await outcomes()) {
        expect(o, o.route).toEqual({
          route: o.route,
          status: 404,
          message: "Not found",
          authenticated: false,
        });
      }
    },
  );
});
