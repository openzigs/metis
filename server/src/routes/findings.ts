/**
 * Epic #298 / Issue #312 — finding review-acknowledgement.
 *
 * Tiny router exposing a single endpoint:
 *
 *   POST /api/findings/:id/review-ack
 *     body: { note?: string }
 *     auth: project.read + access to the finding's project (#334)
 *
 * Records an audit row noting that a human reviewed an `ambiguous`-derivation
 * finding. We keep the surface minimal: no state mutation on the finding row
 * itself in v1 — the durable record lives in the AuditLog. Future iterations
 * can add a `Finding.reviewedAt` column when product surfaces a "reviewed"
 * filter; YAGNI for now.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { audit } from "../lib/audit/audit-service.js";
import { prisma } from "../lib/prisma.js";
import { assertResourceProjectAccess } from "../lib/auth/resource-project-access.js";

const findingNotFound = () => new AppError(404, "FINDING_NOT_FOUND", "Finding not found");

const reviewAckSchema = z.object({
  note: z.string().max(2000).optional(),
});

export function findingsRouter(): Router {
  const r = Router();

  r.post(
    "/:id/review-ack",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const findingId = String(req.params.id);
      const parsed = reviewAckSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid review-ack payload", {
          issues: parsed.error.flatten(),
        });
      }
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");

      const finding = await prisma.finding.findUnique({
        where: { id: findingId },
        select: {
          id: true,
          derivation: true,
          confidence: true,
          agentResultId: true,
          agentResult: { select: { analysis: { select: { projectId: true } } } },
          scanFinding: { select: { scan: { select: { projectId: true } } } },
        },
      });
      if (!finding) throw findingNotFound();
      // #334 — mounted outside `/api/projects`: resolve the finding's project
      // through whichever provenance it has (analysis agent result or
      // materialised scan finding) and check the caller can reach it. An
      // unreachable finding answers the same 404 as an unknown id and is
      // never audited.
      const projectId =
        finding.agentResult?.analysis.projectId ?? finding.scanFinding?.scan.projectId ?? null;
      await assertResourceProjectAccess(req.user, projectId, findingNotFound);

      audit({
        actor: { id: req.user.userId },
        action: "finding.review-ack",
        target: { type: "finding", id: finding.id },
        metadata: {
          derivation: finding.derivation,
          confidence: finding.confidence,
          agentResultId: finding.agentResultId,
          note: parsed.data.note ?? null,
        },
      });

      res.json({
        success: true,
        data: { id: finding.id, reviewedAt: new Date().toISOString() },
      });
    },
  );

  return r;
}
