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

// #763 — the vault-secret binding check has its own real-SQLite suite
// (`import-secret-binding.sqlite.test.ts`); here it is a seam the route must call.
const binding = vi.hoisted(() => ({
  authorizeImportSecretRef: vi.fn(
    async (
      _user: unknown,
      _projectId: string,
      ref: string | null | undefined,
      _target: unknown,
    ): Promise<{ secretId: string | null; until: Date | null }> => ({
      secretId: ref ? "sec_bound" : null,
      until: null,
    }),
  ),
}));
vi.mock("../src/lib/importers/import-secret-binding.js", () => binding);

import { importsRouter } from "../src/routes/imports.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import type { ImportService } from "../src/lib/importers/import-service.js";
import { parseImportFilter, type ImportSourceKind } from "@metis/shared";

/** A route stub: any subset of the service, returning only the fields a test reads. */
type ImportServiceStub = { [K in keyof ImportService]?: (...args: never[]) => Promise<unknown> };

function buildApp(service: ImportServiceStub) {
  const app = express();
  app.use(express.json());
  // The route only serialises the stub's partial views.
  app.use("/projects/:projectId/imports", importsRouter(service as unknown as ImportService));
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
      { secretId: null },
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
    expect(service.createSource).toHaveBeenCalledWith("p1", expect.any(Object), "user_1", {
      secretId: null,
    });
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

describe("#763 — imports take a vault secret reference", () => {
  const ghBody = { source: "github", filter: { owner: "o", repo: "r", state: "open" } };

  it("POST /preview binds secretRef through the binding check and hands the service only the id", async () => {
    binding.authorizeImportSecretRef.mockClear();
    const service = { preview: vi.fn(async () => ({ source: "github", count: 0, sample: [] })) };
    const res = await request(buildApp(service))
      .post("/projects/p1/imports/preview")
      .send({ ...ghBody, secretRef: "${vault:github-flux-v2-sandbox}" });
    expect(res.status).toBe(200);
    expect(binding.authorizeImportSecretRef).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_1" }),
      "p1",
      "${vault:github-flux-v2-sandbox}",
      { type: "import_source", id: "preview" },
    );
    expect(service.preview).toHaveBeenCalledWith("p1", expect.any(Object), {
      secretId: "sec_bound",
    });
    // The secret id is a server-side binding — it is not echoed back.
    expect(JSON.stringify(res.body)).not.toContain("sec_bound");
  });

  it("POST /sources binds secretRef and passes the bound id to the service", async () => {
    binding.authorizeImportSecretRef.mockClear();
    const service = {
      createSource: vi.fn(async () => ({ source: { id: "src_1" }, run: { id: "run_1" } })),
    };
    const res = await request(buildApp(service))
      .post("/projects/p1/imports/sources")
      .send({ ...ghBody, label: "GH", secretRef: "${vault:gh}" });
    expect(res.status).toBe(201);
    expect(binding.authorizeImportSecretRef).toHaveBeenCalledWith(
      expect.anything(),
      "p1",
      "${vault:gh}",
      { type: "import_source", id: "new" },
    );
    expect(service.createSource).toHaveBeenCalledWith("p1", expect.any(Object), "user_1", {
      secretId: "sec_bound",
    });
  });

  it("refuses a vault reference pasted into the token field instead of vaulting it as plaintext", async () => {
    const service = { createSource: vi.fn(), preview: vi.fn() };
    for (const path of ["/projects/p1/imports/preview", "/projects/p1/imports/sources"]) {
      const res = await request(buildApp(service))
        .post(path)
        .send({ ...ghBody, label: "GH", token: "${vault:gh}" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(service.createSource).not.toHaveBeenCalled();
    expect(service.preview).not.toHaveBeenCalled();
  });

  it("refuses a malformed secretRef and a request carrying both credentials", async () => {
    const service = { preview: vi.fn() };
    for (const extra of [
      { secretRef: "vault:gh" },
      { secretRef: "${vault: }" },
      { secretRef: "${vault:gh}", token: "ghp_x" },
    ]) {
      const res = await request(buildApp(service))
        .post("/projects/p1/imports/preview")
        .send({ ...ghBody, ...extra });
      expect(res.status).toBe(400);
      // A pasted token is never reflected back in the error envelope.
      expect(JSON.stringify(res.body)).not.toContain("ghp_x");
    }
    expect(service.preview).not.toHaveBeenCalled();
  });

  it("a refused binding stops the request before the service runs", async () => {
    const { AppError } = await import("../src/middleware/error-handler.js");
    binding.authorizeImportSecretRef.mockRejectedValueOnce(
      new AppError(403, "SECRET_BINDING_FORBIDDEN", "not yours"),
    );
    const service = { createSource: vi.fn() };
    const res = await request(buildApp(service))
      .post("/projects/p1/imports/sources")
      .send({ ...ghBody, label: "GH", secretRef: "${vault:someone-elses}" });
    expect(res.status).toBe(403);
    expect(service.createSource).not.toHaveBeenCalled();
  });

  it("a pasted token or no credential skips the binding check", async () => {
    binding.authorizeImportSecretRef.mockClear();
    const service = { preview: vi.fn(async () => ({ source: "github", count: 0, sample: [] })) };
    await request(buildApp(service)).post("/projects/p1/imports/preview").send(ghBody);
    expect(service.preview).toHaveBeenCalledWith("p1", expect.any(Object), { secretId: null });
  });
});
