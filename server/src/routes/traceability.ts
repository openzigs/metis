/**
 * Requirement → Spec → Code traceability routes — Epic #207 (#226/#227/#229).
 *
 * Mounted at `/api/projects/:projectId`:
 *   GET    /requirements/:requirementId/traceability        analysis.read   (#229 full chain)
 *   GET    /requirements/:requirementId/spec-mappings        analysis.read   (#226 list)
 *   POST   /requirements/:requirementId/spec-mappings        analysis.run    (#226 create)
 *   DELETE /requirements/:requirementId/spec-mappings/:id     analysis.run    (#226 remove)
 *   GET    /specs/:specId/code-mappings                       analysis.read   (#227 list)
 *   POST   /specs/:specId/code-mappings                       analysis.run    (#227 create)
 *   DELETE /specs/:specId/code-mappings/:id                   analysis.run    (#227 remove)
 *   GET    /traceability/by-file                              analysis.read   (#229 reverse)
 *   POST   /traceability/backfill                             analysis.run    (#228 backfill)
 *
 * Validation is Zod-based; the service layer throws `AppError` with stable
 * codes that the global error handler formats. Express 5 forwards rejected
 * promises from async handlers.
 */
import { Router, type Request } from "express";
import {
  type ApiResponse,
  createRequirementSpecMappingSchema,
  createSpecCodeMappingSchema,
} from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import * as reqSpec from "../lib/traceability/requirement-spec-mapping.js";
import * as specCode from "../lib/traceability/spec-code-mapping.js";
import {
  getRequirementChain,
  getRequirementsForFile,
} from "../lib/traceability/traceability-spine.js";
import {
  getRequirementChainWithLinks,
  getWorkspaceTraceabilitySummary,
} from "../lib/traceability/workspace-rollup.js";
import { runBackfill } from "../lib/traceability/backfill-spec-links.js";
import type { SchedulerActor } from "../lib/scheduler/project-access.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function actorOf(req: Request): SchedulerActor {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return { id: req.user.userId, role: req.user.role };
}

function paramOf(req: Request, name: string, code: string): string {
  const v = String(req.params[name] ?? "");
  if (!v) throw new AppError(400, code, `${name} path parameter is required`);
  return v;
}

const projectIdOf = (req: Request) => paramOf(req, "projectId", "PROJECT_REQUIRED");
const requirementIdOf = (req: Request) => paramOf(req, "requirementId", "REQUIREMENT_REQUIRED");
const specIdOf = (req: Request) => paramOf(req, "specId", "SPEC_REQUIRED");

export function traceabilityRouter(): Router {
  const r = Router({ mergeParams: true });

  // ---- #229 full chain (+ #626 optional cross-project linked chains) -------
  r.get(
    "/requirements/:requirementId/traceability",
    requireAuth,
    requirePermission("analysis.read"),
    async (req, res) => {
      const projectId = projectIdOf(req);
      const requirementId = requirementIdOf(req);
      // Default behaviour (no `includeLinked`) is byte-for-byte the #229 chain.
      if (String(req.query.includeLinked) !== "true") {
        res.json(ok(await getRequirementChain(projectId, requirementId)));
        return;
      }
      const rawDepth = req.query.depth;
      const depth = rawDepth != null ? Number(rawDepth) : undefined;
      res.json(
        ok(await getRequirementChainWithLinks(actorOf(req), projectId, requirementId, { depth })),
      );
    },
  );

  // ---- #229 reverse (which requirements touch a file) ---------------------
  r.get(
    "/traceability/by-file",
    requireAuth,
    requirePermission("analysis.read"),
    async (req, res) => {
      const filePath = String(req.query.filePath ?? "");
      if (!filePath) {
        throw new AppError(400, "FILE_PATH_REQUIRED", "filePath query parameter is required");
      }
      const requirementIds = await getRequirementsForFile(projectIdOf(req), filePath);
      res.json(ok({ filePath, requirementIds }));
    },
  );

  // ---- #226 requirement↔spec ---------------------------------------------
  r.get(
    "/requirements/:requirementId/spec-mappings",
    requireAuth,
    requirePermission("analysis.read"),
    async (req, res) => {
      res.json(ok(await reqSpec.listForRequirement(projectIdOf(req), requirementIdOf(req))));
    },
  );

  r.post(
    "/requirements/:requirementId/spec-mappings",
    requireAuth,
    requirePermission("analysis.run"),
    async (req, res) => {
      const parsed = createRequirementSpecMappingSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "invalid payload", {
          issues: parsed.error.flatten(),
        });
      }
      const created = await reqSpec.create(projectIdOf(req), requirementIdOf(req), parsed.data);
      res.status(201).json(ok(created));
    },
  );

  r.delete(
    "/requirements/:requirementId/spec-mappings/:mappingId",
    requireAuth,
    requirePermission("analysis.run"),
    async (req, res) => {
      await reqSpec.remove(projectIdOf(req), requirementIdOf(req), String(req.params.mappingId));
      res.status(204).end();
    },
  );

  // ---- #227 spec↔code -----------------------------------------------------
  r.get(
    "/specs/:specId/code-mappings",
    requireAuth,
    requirePermission("analysis.read"),
    async (req, res) => {
      res.json(ok(await specCode.listForSpec(projectIdOf(req), specIdOf(req))));
    },
  );

  r.post(
    "/specs/:specId/code-mappings",
    requireAuth,
    requirePermission("analysis.run"),
    async (req, res) => {
      const parsed = createSpecCodeMappingSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "invalid payload", {
          issues: parsed.error.flatten(),
        });
      }
      const created = await specCode.create(projectIdOf(req), specIdOf(req), parsed.data);
      res.status(201).json(ok(created));
    },
  );

  r.delete(
    "/specs/:specId/code-mappings/:mappingId",
    requireAuth,
    requirePermission("analysis.run"),
    async (req, res) => {
      await specCode.remove(projectIdOf(req), specIdOf(req), String(req.params.mappingId));
      res.status(204).end();
    },
  );

  // ---- #228 backfill ------------------------------------------------------
  r.post(
    "/traceability/backfill",
    requireAuth,
    requirePermission("analysis.run"),
    async (req, res) => {
      res.json(ok(await runBackfill(projectIdOf(req))));
    },
  );

  return r;
}

/**
 * Workspace-level traceability rollup — Epic #610 (#626).
 *
 * Mounted at `/api/workspaces/:workspaceId/traceability`:
 *   GET /summary   analysis.read   per-project coverage + cross-project link map
 *
 * The service (`workspace-rollup.ts`) asserts workspace membership (404 for
 * non-members) and confines every count / link to the caller's accessible
 * projects, so the coarse `analysis.read` gate here is the outer guard only.
 */
export function workspaceTraceabilityRouter(): Router {
  const r = Router({ mergeParams: true });

  r.get("/summary", requireAuth, requirePermission("analysis.read"), async (req, res) => {
    const workspaceId = paramOf(req, "workspaceId", "WORKSPACE_REQUIRED");
    res.json(ok(await getWorkspaceTraceabilitySummary(actorOf(req), workspaceId)));
  });

  return r;
}
