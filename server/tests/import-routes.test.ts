/**
 * /api/projects/:projectId/imports route layer — validation, status codes, and
 * delegation. Auth + permission middleware are mocked to pass-through so we can
 * exercise the handlers directly with an injected fake service.
 */
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    (req as { user: unknown }).user = { userId: "user_1" };
    next();
  },
}));
vi.mock("../src/middleware/require-permission.js", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
// #1053 — the router now runs the REAL `requireProjectAccess()` chokepoint,
// which resolves the path project's workspace. A null workspace is "open to any
// authenticated user" (pre-migration projects), so this keeps the suite focused
// on validation/status codes/delegation. Cross-tenant 404 behaviour has its own
// suite in `import-routes-authz.test.ts`.
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { project: { findUnique: vi.fn(async () => ({ workspaceId: null })) } },
}));

import { importsRouter } from "../src/routes/imports.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import type { ImportService } from "../src/lib/importers/import-service.js";
import { parseImportFilter, type ImportSourceKind } from "@metis/shared";

function buildApp(service: Partial<ImportService>) {
  const app = express();
  app.use(express.json());
  app.use("/projects/:projectId/imports", importsRouter(service as ImportService));
  app.use(errorHandler);
  return app;
}

const previewBody = {
  source: "github",
  filter: { owner: "o", repo: "r", state: "open" },
  token: "t",
};

describe("imports routes", () => {
  it("POST /preview returns the preview payload", async () => {
    const service = { preview: vi.fn(async () => ({ source: "github", count: 2, sample: [] })) };
    const res = await request(buildApp(service))
      .post("/projects/p1/imports/preview")
      .send(previewBody);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { source: "github", count: 2, sample: [] } });
    expect(service.preview).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ source: "github" }),
    );
  });

  it("POST /preview rejects an invalid payload with a friendly 400 (#426)", async () => {
    const res = await request(buildApp({}))
      .post("/projects/p1/imports/preview")
      .send({ source: "bitbucket", filter: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    // Friendly, safe field summary — never the raw Zod `issues` array.
    expect(res.body.error.details.fields).toBeInstanceOf(Array);
    expect(res.body.error).not.toHaveProperty("details.issues");
  });

  it("POST /preview never leaks raw Zod tokens on invalid input (A09, #426)", async () => {
    // An empty github filter passes the loose route schema (`filter: z.unknown()`)
    // but the service's strict per-source parse throws a raw ZodError — which the
    // GLOBAL handler must map to a friendly 400, NOT a 500 with the raw array.
    const service = {
      preview: vi.fn(
        async (_projectId: string, req: { source: ImportSourceKind; filter: unknown }) => {
          // Real strict parse — this is exactly what import-service does internally.
          parseImportFilter(req.source, req.filter);
          return { source: req.source, count: 0, sample: [] };
        },
      ),
    };
    const res = await request(buildApp(service))
      .post("/projects/p1/imports/preview")
      .send({ source: "github", filter: {}, token: "t" });

    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("too_small");
    expect(serialized).not.toContain('"code":"too');
    expect(serialized).not.toContain('"path":');
    expect(serialized).not.toContain("minimum");
    // The derived friendly summary names the empty required fields.
    const fields = res.body.error.details.fields as Array<{ field: string; message: string }>;
    expect(fields.map((f) => f.field)).toEqual(expect.arrayContaining(["owner", "repo"]));
    expect(fields.every((f) => /required|invalid|too (short|long)/i.test(f.message))).toBe(true);
  });

  it("GET /sources lists sources", async () => {
    const service = { listSources: vi.fn(async () => []) };
    const res = await request(buildApp(service)).get("/projects/p1/imports/sources");
    expect(res.status).toBe(200);
    expect(service.listSources).toHaveBeenCalledWith("p1");
  });

  it("POST /sources creates a source and returns 201", async () => {
    const service = {
      createSource: vi.fn(async () => ({ source: { id: "src_1" }, run: { id: "run_1" } })),
    };
    const res = await request(buildApp(service))
      .post("/projects/p1/imports/sources")
      .send({
        source: "github",
        label: "GH",
        filter: { owner: "o", repo: "r", state: "open" },
        token: "t",
      });
    expect(res.status).toBe(201);
    expect(service.createSource).toHaveBeenCalledWith("p1", expect.any(Object), "user_1");
  });

  it("POST /sources/:id/run enqueues a task and returns 202", async () => {
    const service = {
      getSource: vi.fn(async () => ({ id: "src_1" })),
      enqueueRun: vi.fn(async () => ({ id: "run_1", status: "pending", taskId: "task_1" })),
    };
    const res = await request(buildApp(service)).post("/projects/p1/imports/sources/src_1/run");
    expect(res.status).toBe(202);
    expect(service.getSource).toHaveBeenCalledWith("p1", "src_1");
    expect(service.enqueueRun).toHaveBeenCalledWith("src_1", {
      trigger: "manual",
      userId: "user_1",
    });
    // Ensure runSource is NOT called (would be synchronous)
    expect((service as Record<string, unknown>).runSource).toBeUndefined();
  });

  it("PATCH /sources/:id/sync toggles ongoing sync", async () => {
    const service = { setSync: vi.fn(async () => ({ id: "src_1", syncEnabled: true })) };
    const res = await request(buildApp(service))
      .patch("/projects/p1/imports/sources/src_1/sync")
      .send({ syncEnabled: true, syncIntervalMinutes: 30 });
    expect(res.status).toBe(200);
    expect(service.setSync).toHaveBeenCalledWith(
      "p1",
      "src_1",
      expect.objectContaining({ syncEnabled: true }),
      "user_1",
    );
  });

  it("DELETE /sources/:id returns 204", async () => {
    const service = { deleteSource: vi.fn(async () => undefined) };
    const res = await request(buildApp(service)).delete("/projects/p1/imports/sources/src_1");
    expect(res.status).toBe(204);
    expect(service.deleteSource).toHaveBeenCalledWith("p1", "src_1", "user_1");
  });

  it("GET /runs passes the optional sourceId filter", async () => {
    const service = { listRuns: vi.fn(async () => []) };
    const res = await request(buildApp(service)).get("/projects/p1/imports/runs?sourceId=src_1");
    expect(res.status).toBe(200);
    expect(service.listRuns).toHaveBeenCalledWith("p1", "src_1");
  });
});
