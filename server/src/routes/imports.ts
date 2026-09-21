/**
 * /api/projects/:projectId/imports — Epic #776 inbound importer routes.
 *
 *   POST   /preview                preview a filter (count + sample)   (connector.read)
 *   GET    /sources                list saved import sources           (connector.read)
 *   POST   /sources                create + kick off first run         (connector.write)
 *   GET    /sources/:id            source detail                       (connector.read)
 *   POST   /sources/:id/run        trigger a manual run                (connector.write)
 *   PATCH  /sources/:id/sync       enable/disable ongoing sync         (connector.write)
 *   DELETE /sources/:id            delete a source                     (connector.write)
 *   GET    /runs                   run history (optional ?sourceId)    (connector.read)
 */
import { Router, type Request } from "express";
import {
  type ApiResponse,
  createImportSourceSchema,
  importPreviewRequestSchema,
  updateImportSyncSchema,
} from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { requireProjectAccess } from "../middleware/require-project-access.js";
import { AppError } from "../middleware/error-handler.js";
import { getImportService, type ImportService } from "../lib/importers/import-service.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function actor(req: Request): string {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.userId;
}

function projectIdOf(req: Request): string {
  const id = String(req.params.projectId ?? "");
  if (!id) throw new AppError(400, "PROJECT_REQUIRED", "projectId path parameter is required");
  return id;
}

export function importsRouter(service: ImportService = getImportService()): Router {
  const r = Router({ mergeParams: true });

  // #1053 (F3) — object-level project scope (OWASP A01 / BOLA, CWE-639).
  // `requirePermission` checks the caller's GLOBAL role, which does not confine
  // them to their own workspace, and the import service scopes its queries by
  // the caller-supplied `projectId` alone. Gate the WHOLE subtree on the
  // caller's membership of the target project's workspace before any handler
  // runs — otherwise a coordinator in workspace A can read another tenant's
  // import sources (vault secret refs, Jira connection ids) and write
  // `Requirement` rows into their project. Non-members get 404 (no existence
  // oracle); system admins bypass. MUST stay above every route below.
  r.use(requireAuth, requireProjectAccess());

  r.post("/preview", requireAuth, requirePermission("connector.read"), async (req, res) => {
    // #426 — throw the raw ZodError; the global error handler maps it to a
    // friendly 400 envelope (no raw issues array / schema internals leaked).
    const parsed = importPreviewRequestSchema.parse(req.body ?? {});
    res.json(ok(await service.preview(projectIdOf(req), parsed)));
  });

  r.get("/sources", requireAuth, requirePermission("connector.read"), async (req, res) => {
    res.json(ok(await service.listSources(projectIdOf(req))));
  });

  r.post("/sources", requireAuth, requirePermission("connector.write"), async (req, res) => {
    // #426 — raw ZodError → friendly 400 via the global error handler.
    const parsed = createImportSourceSchema.parse(req.body ?? {});
    const result = await service.createSource(projectIdOf(req), parsed, actor(req));
    res.status(201).json(ok(result));
  });

  r.get("/sources/:id", requireAuth, requirePermission("connector.read"), async (req, res) => {
    res.json(ok(await service.getSource(projectIdOf(req), String(req.params.id))));
  });

  r.post(
    "/sources/:id/run",
    requireAuth,
    requirePermission("connector.write"),
    async (req, res) => {
      // Surface a 404 for an unknown/deleted source before enqueueing.
      await service.getSource(projectIdOf(req), String(req.params.id));
      // Enqueue an async task and respond 202 immediately — the client polls
      // run status via GET /runs.  Do NOT await the import inline here.
      const run = await service.enqueueRun(String(req.params.id), {
        trigger: "manual",
        userId: actor(req),
      });
      res.status(202).json(ok(run));
    },
  );

  r.patch(
    "/sources/:id/sync",
    requireAuth,
    requirePermission("connector.write"),
    async (req, res) => {
      // #426 — raw ZodError → friendly 400 via the global error handler.
      const parsed = updateImportSyncSchema.parse(req.body ?? {});
      const updated = await service.setSync(
        projectIdOf(req),
        String(req.params.id),
        parsed,
        actor(req),
      );
      res.json(ok(updated));
    },
  );

  r.delete("/sources/:id", requireAuth, requirePermission("connector.write"), async (req, res) => {
    await service.deleteSource(projectIdOf(req), String(req.params.id), actor(req));
    res.status(204).end();
  });

  r.get("/runs", requireAuth, requirePermission("connector.read"), async (req, res) => {
    const sourceId = req.query.sourceId ? String(req.query.sourceId) : undefined;
    res.json(ok(await service.listRuns(projectIdOf(req), sourceId)));
  });

  return r;
}
