/**
 * /api/test-management — TestManagementConnection CRUD + connectivity test
 * (Epic #856 / Issue #871).
 *
 *   POST   /connections?projectId=X        create   (connector.write)
 *   GET    /connections?projectId=X        list     (connector.read)
 *   GET    /connections/:id                detail   (connector.read)
 *   PATCH  /connections/:id                update   (connector.write)
 *   DELETE /connections/:id                delete   (connector.write)
 *   POST   /connections/:id/test           test     (connector.test)
 */
import { Router, type Request } from "express";
import {
  type ApiResponse,
  createTestManagementConnectionSchema,
  updateTestManagementConnectionSchema,
} from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { assertProjectAccess } from "../lib/custom-agents/authz.js";
import { authorizeTestManagementConnection } from "../lib/connectors/connection-authz.js";
import {
  createTestManagementConnection,
  deleteTestManagementConnection,
  getTestManagementConnection,
  listTestManagementConnections,
  testTestManagementConnection,
  updateTestManagementConnection,
} from "../lib/connectors/testmgmt/connection-service.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function actor(req: Request): string {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.userId;
}

/**
 * Resolve the project that owns `:id` and assert the caller can reach it
 * (#1055). Returns the projectId to scope the service lookup with —
 * `undefined` for system admins, who bypass workspace RBAC.
 */
function scopeOf(req: Request): Promise<string | undefined> {
  return authorizeTestManagementConnection(req.user, String(req.params.id));
}

/**
 * Assert access to a caller-supplied `projectId` (create / list), so a
 * workspace-B caller cannot create or enumerate connections under a
 * workspace-A project id.
 */
async function assertCallerProject(req: Request, projectId: string): Promise<void> {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  await assertProjectAccess(req.user, projectId);
}

export function testManagementRouter(): Router {
  const r = Router();

  // POST /api/test-management/connections — create
  r.post("/connections", requireAuth, requirePermission("connector.write"), async (req, res) => {
    const projectId = String(req.query.projectId ?? req.body?.projectId ?? "");
    if (!projectId) {
      throw new AppError(400, "PROJECT_REQUIRED", "projectId is required");
    }
    const parsed = createTestManagementConnectionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "invalid payload", {
        issues: parsed.error.flatten(),
      });
    }
    await assertCallerProject(req, projectId);
    const created = await createTestManagementConnection(projectId, parsed.data, actor(req));
    res.status(201).json(ok(created));
  });

  // GET /api/test-management/connections?projectId=X — list
  r.get("/connections", requireAuth, requirePermission("connector.read"), async (req, res) => {
    const projectId = String(req.query.projectId ?? "");
    if (!projectId) {
      throw new AppError(400, "PROJECT_REQUIRED", "projectId query param is required");
    }
    await assertCallerProject(req, projectId);
    const list = await listTestManagementConnections(projectId);
    res.json(ok(list));
  });

  // GET /api/test-management/connections/:id — detail
  r.get("/connections/:id", requireAuth, requirePermission("connector.read"), async (req, res) => {
    const scope = await scopeOf(req);
    const detail = await getTestManagementConnection(String(req.params.id), scope);
    res.json(ok(detail));
  });

  // PATCH /api/test-management/connections/:id — update
  r.patch(
    "/connections/:id",
    requireAuth,
    requirePermission("connector.write"),
    async (req, res) => {
      const parsed = updateTestManagementConnectionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "invalid payload", {
          issues: parsed.error.flatten(),
        });
      }
      const scope = await scopeOf(req);
      const updated = await updateTestManagementConnection(
        String(req.params.id),
        parsed.data,
        actor(req),
        scope,
      );
      res.json(ok(updated));
    },
  );

  // DELETE /api/test-management/connections/:id — soft-delete
  r.delete(
    "/connections/:id",
    requireAuth,
    requirePermission("connector.write"),
    async (req, res) => {
      const scope = await scopeOf(req);
      await deleteTestManagementConnection(String(req.params.id), actor(req), scope);
      res.status(204).end();
    },
  );

  // POST /api/test-management/connections/:id/test — test connectivity
  r.post(
    "/connections/:id/test",
    requireAuth,
    requirePermission("connector.test"),
    async (req, res) => {
      const scope = await scopeOf(req);
      const result = await testTestManagementConnection(String(req.params.id), actor(req), scope);
      res.json(ok(result));
    },
  );

  return r;
}
