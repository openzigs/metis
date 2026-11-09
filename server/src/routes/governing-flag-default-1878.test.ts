/**
 * #1878 — the governing-documents feature is ON by default: with
 * `GOVERNING_DOCS_ENABLED` unset, every route of the governing-documents and
 * governing-rules routers is past the flag gate, and set to `"0"` every one of
 * them is a 404 before authentication. The routes are read from the routers'
 * own stacks, so a route added later is covered without editing this test.
 *
 * The analysis-scoped governing routes (`/:id/governing-applicability`,
 * `/:id/governing-findings`, `…/decision`) check the flag after
 * authentication; their `"0"` → 404 is asserted against a real router and
 * SQLite in `tests/governing-findings-1874.sqlite.test.ts` and
 * `tests/governing-questions-round-trip-1873.sqlite.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import express, { type Router } from "express";
import request from "supertest";

/** Authentication always refuses: a 401 proves the request passed the flag gate. */
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: express.Request, res: express.Response) => {
    res.status(401).json({ success: false, error: { code: "AUTH_REQUIRED", message: "no" } });
  },
}));
vi.mock("../lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { governingDocumentsRouter, governingRulesRouter } = await import("./governing-documents.js");
const { errorHandler } = await import("../middleware/error-handler.js");
const { GOVERNING_DOCS_ENABLED_DEFAULT } = await import("../lib/governing/flag.js");

const MOUNTS: Array<{ base: string; router: () => Router }> = [
  { base: "/api/workspaces/ws-1/governing-documents", router: () => governingDocumentsRouter() },
  { base: "/api/workspaces/ws-1/governing-rules", router: () => governingRulesRouter() },
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
  for (const m of MOUNTS) a.use(m.base, m.router());
  a.use(errorHandler);
  return a;
}

/** Every governing route's status, unauthenticated. */
async function statuses(): Promise<Array<{ route: string; status: number; code?: string }>> {
  const a = app();
  const out: Array<{ route: string; status: number; code?: string }> = [];
  for (const m of MOUNTS) {
    for (const r of routesOf(m.router())) {
      const url = `${m.base}${r.path === "/" ? "" : r.path}`;
      const res = await request(a)[r.method](url);
      out.push({
        route: `${r.method.toUpperCase()} ${url}`,
        status: res.status,
        code: res.body?.error?.code,
      });
    }
  }
  return out;
}

describe('#1878 — GOVERNING_DOCS_ENABLED is on by default; "0" still turns every governing route off', () => {
  afterEach(() => vi.unstubAllEnvs());

  it("finds every route of both routers", () => {
    const [documents, rules] = MOUNTS.map((m) => routesOf(m.router()).map((r) => r.method));
    // Documents: upload, new revision, list, read, rules, retry extraction, delete; rules: edit.
    expect(documents!.length).toBeGreaterThanOrEqual(7);
    expect(documents).toEqual(expect.arrayContaining(["get", "post", "delete"]));
    expect(rules).toEqual(expect.arrayContaining(["patch"]));
  });

  it("unset, every route is past the flag gate: authentication answers, not a 404", async () => {
    vi.stubEnv("GOVERNING_DOCS_ENABLED", undefined);
    expect(GOVERNING_DOCS_ENABLED_DEFAULT).toBe(true);
    for (const s of await statuses()) {
      expect(s, s.route).toMatchObject({ status: 401, code: "AUTH_REQUIRED" });
    }
  });

  it.each(["0", "false", "off", ""])(
    "set to %j, every route is a 404 before authentication",
    async (value) => {
      vi.stubEnv("GOVERNING_DOCS_ENABLED", value);
      for (const s of await statuses()) {
        expect(s, s.route).toMatchObject({ status: 404, code: "NOT_FOUND" });
      }
    },
  );
});
