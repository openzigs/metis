/**
 * Requirement ↔ data traceability routes — Epic #889 (#892).
 *
 * Mounted at `/api/projects/:projectId`:
 *   GET    /requirements/:requirementId/data-mappings          connector.read
 *   POST   /requirements/:requirementId/data-mappings          connector.write
 *   DELETE /requirements/:requirementId/data-mappings/:mappingId  connector.write
 *   POST   /requirements/:requirementId/data-mappings/suggest   connector.write
 *   GET    /data-mappings                                       connector.read
 *
 * Reuses the connector RBAC permissions. Validation is Zod-based; the service
 * layer throws `AppError` with stable codes, which the global error handler
 * formats. Express 5 forwards rejected promises from async handlers.
 *
 * The `/suggest` route fans out to up to N budget-bounded LLM calls, so it is
 * gated by the shared per-user `connectorQueryRateLimiter` (same limiter the
 * other expensive connector operations use) to bound cost amplification.
 */
import { Router, type Request } from "express";
import { type ApiResponse, createRequirementDataMappingSchema } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { connectorQueryRateLimiter } from "../middleware/connector-rate-limit.js";
import { AppError } from "../middleware/error-handler.js";
import {
  create,
  listForProject,
  listForRequirement,
  remove,
} from "../lib/traceability/requirement-data-mapping.js";
import { suggestMappings } from "../lib/traceability/suggest-mappings.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function projectIdOf(req: Request): string {
  const id = String(req.params.projectId ?? "");
  if (!id) throw new AppError(400, "PROJECT_REQUIRED", "projectId path parameter is required");
  return id;
}

function requirementIdOf(req: Request): string {
  const id = String(req.params.requirementId ?? "");
  if (!id) {
    throw new AppError(400, "REQUIREMENT_REQUIRED", "requirementId path parameter is required");
  }
  return id;
}

export function dataMappingsRouter(): Router {
  const r = Router({ mergeParams: true });

  r.get(
    "/requirements/:requirementId/data-mappings",
    requireAuth,
    requirePermission("connector.read"),
    async (req, res) => {
      res.json(ok(await listForRequirement(projectIdOf(req), requirementIdOf(req))));
    },
  );

  r.post(
    "/requirements/:requirementId/data-mappings",
    requireAuth,
    requirePermission("connector.write"),
    async (req, res) => {
      const parsed = createRequirementDataMappingSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "invalid payload", {
          issues: parsed.error.flatten(),
        });
      }
      const created = await create(projectIdOf(req), requirementIdOf(req), parsed.data);
      res.status(201).json(ok(created));
    },
  );

  r.delete(
    "/requirements/:requirementId/data-mappings/:mappingId",
    requireAuth,
    requirePermission("connector.write"),
    async (req, res) => {
      await remove(projectIdOf(req), requirementIdOf(req), String(req.params.mappingId));
      res.status(204).end();
    },
  );

  // Epic #889 (#893) — LLM-assisted, budget-bounded suggestions. Rate-limited
  // because each call can trigger up to N LLM requests (OWASP A04: cost
  // amplification), mirroring how `/dbs/:id/query` is throttled.
  r.post(
    "/requirements/:requirementId/data-mappings/suggest",
    requireAuth,
    connectorQueryRateLimiter,
    requirePermission("connector.write"),
    async (req, res) => {
      res.json(ok(await suggestMappings(projectIdOf(req), requirementIdOf(req))));
    },
  );

  r.get("/data-mappings", requireAuth, requirePermission("connector.read"), async (req, res) => {
    res.json(ok(await listForProject(projectIdOf(req))));
  });

  return r;
}
