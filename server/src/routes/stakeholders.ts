/**
 * Stakeholder + project-context routes — Epic #208 (E6.1 #230 / E6.4 #233).
 *
 * Mounted at `/api/projects/:projectId`:
 *   GET    /stakeholders                                  analysis.read   (list)
 *   POST   /stakeholders                                  analysis.run    (create)
 *   PATCH  /stakeholders/:stakeholderId                   analysis.run    (update)
 *   DELETE /stakeholders/:stakeholderId                   analysis.run    (remove)
 *   GET    /context                                       analysis.read   (read project context)
 *   PUT    /context                                       analysis.run    (upsert project context)
 *   GET    /requirements/:requirementId/stakeholders      analysis.read   (links + metadata)
 *   POST   /requirements/:requirementId/stakeholders      analysis.run    (attribute)
 *   DELETE /requirements/:requirementId/stakeholders/:stakeholderId  analysis.run (detach)
 *
 * Validation is Zod-based; the `StakeholderService` throws `StakeholderError`
 * with a `statusCode` that is mapped to an `AppError` so the global error
 * handler formats it consistently.
 */
import { Router, type Request } from "express";
import {
  type ApiResponse,
  createStakeholderSchema,
  linkStakeholderSchema,
  projectContextSchema,
  updateStakeholderSchema,
} from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";
import {
  StakeholderError,
  StakeholderService,
  type StakeholderPrismaClient,
} from "../lib/stakeholders/stakeholder-service.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function paramOf(req: Request, name: string, code: string): string {
  const v = String(req.params[name] ?? "");
  if (!v) throw new AppError(400, code, `${name} path parameter is required`);
  return v;
}

const projectIdOf = (req: Request) => paramOf(req, "projectId", "PROJECT_REQUIRED");
const requirementIdOf = (req: Request) => paramOf(req, "requirementId", "REQUIREMENT_REQUIRED");
const stakeholderIdOf = (req: Request) => paramOf(req, "stakeholderId", "STAKEHOLDER_REQUIRED");

function service(): StakeholderService {
  return new StakeholderService(prisma as unknown as StakeholderPrismaClient);
}

/** Map a StakeholderError onto the framework AppError. */
function rethrow(err: unknown): never {
  if (err instanceof StakeholderError) {
    throw new AppError(err.statusCode, err.code, err.message);
  }
  throw err;
}

export function stakeholdersRouter(): Router {
  const r = Router({ mergeParams: true });

  // ---- Stakeholder CRUD ---------------------------------------------------
  r.get("/stakeholders", requireAuth, requirePermission("analysis.read"), async (req, res) => {
    res.json(ok(await service().list(projectIdOf(req))));
  });

  r.post("/stakeholders", requireAuth, requirePermission("analysis.run"), async (req, res) => {
    const parsed = createStakeholderSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "invalid payload", {
        issues: parsed.error.flatten(),
      });
    }
    try {
      const created = await service().create(projectIdOf(req), parsed.data);
      res.status(201).json(ok(created));
    } catch (err) {
      rethrow(err);
    }
  });

  r.patch(
    "/stakeholders/:stakeholderId",
    requireAuth,
    requirePermission("analysis.run"),
    async (req, res) => {
      const parsed = updateStakeholderSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "invalid payload", {
          issues: parsed.error.flatten(),
        });
      }
      try {
        const updated = await service().update(projectIdOf(req), stakeholderIdOf(req), parsed.data);
        res.json(ok(updated));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  r.delete(
    "/stakeholders/:stakeholderId",
    requireAuth,
    requirePermission("analysis.run"),
    async (req, res) => {
      try {
        await service().remove(projectIdOf(req), stakeholderIdOf(req));
        res.status(204).end();
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // ---- Project context ----------------------------------------------------
  r.get("/context", requireAuth, requirePermission("analysis.read"), async (req, res) => {
    res.json(ok(await service().getContext(projectIdOf(req))));
  });

  r.put("/context", requireAuth, requirePermission("analysis.run"), async (req, res) => {
    const parsed = projectContextSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "invalid payload", {
        issues: parsed.error.flatten(),
      });
    }
    res.json(ok(await service().upsertContext(projectIdOf(req), parsed.data)));
  });

  // ---- Requirement ↔ stakeholder links ------------------------------------
  r.get(
    "/requirements/:requirementId/stakeholders",
    requireAuth,
    requirePermission("analysis.read"),
    async (req, res) => {
      res.json(ok(await service().listForRequirement(projectIdOf(req), requirementIdOf(req))));
    },
  );

  r.post(
    "/requirements/:requirementId/stakeholders",
    requireAuth,
    requirePermission("analysis.run"),
    async (req, res) => {
      const parsed = linkStakeholderSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "invalid payload", {
          issues: parsed.error.flatten(),
        });
      }
      try {
        await service().linkRequirement(projectIdOf(req), requirementIdOf(req), parsed.data);
        res.status(204).end();
      } catch (err) {
        rethrow(err);
      }
    },
  );

  r.delete(
    "/requirements/:requirementId/stakeholders/:stakeholderId",
    requireAuth,
    requirePermission("analysis.run"),
    async (req, res) => {
      try {
        await service().unlinkRequirement(
          projectIdOf(req),
          requirementIdOf(req),
          stakeholderIdOf(req),
        );
        res.status(204).end();
      } catch (err) {
        rethrow(err);
      }
    },
  );

  return r;
}
