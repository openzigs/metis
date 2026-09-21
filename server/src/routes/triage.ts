/**
 * Epic #708 / Issues #714+#715 — Triage + publish API.
 *
 * Mounted at /api/projects/:projectId/scans/:scanId.
 *
 *   GET    /findings                       — list scan findings
 *   POST   /findings/:findingId/triage     — approve / reject / defer
 *   POST   /findings/:findingId/publish    — push to GitHub
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";
import { audit } from "../lib/audit/audit-service.js";
import {
  applyTriageDecision,
  TriageError,
  type ScanFindingForTriage,
} from "../lib/scanner/triage-service.js";
import { materializeTriagedFinding, publishScanFinding } from "../lib/scanner/prisma-adapter.js";
import { PublishError } from "../lib/scanner/finding-publisher.js";
import {
  PUBLISHER_VALUES,
  type Publisher,
  type Severity,
  type TriageStatus,
} from "../lib/scanner/types.js";

const triageSchema = z.object({
  decision: z.enum(["approved", "rejected", "deferred"]),
  note: z.string().max(2000).optional(),
});

const publishSchema = z.object({
  provider: z.enum(PUBLISHER_VALUES as unknown as [Publisher, ...Publisher[]]),
  extraLabels: z.array(z.string().min(1).max(64)).max(20).optional(),
});

function projectIdOf(req: Request): string {
  const id = String(req.params.projectId ?? "");
  if (!id) throw new AppError(400, "PROJECT_REQUIRED", "projectId is required");
  return id;
}

function actor(req: Request): string {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.userId;
}

function parseEvidenceLines(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((n): n is number => typeof n === "number");
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function triageRouter(): Router {
  const r = Router({ mergeParams: true });

  r.get(
    "/scans/:scanId/findings",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      const projectId = projectIdOf(req);
      const scanId = String(req.params.scanId);
      const scan = await prisma.scan.findFirst({
        where: { id: scanId, projectId },
        select: { id: true },
      });
      if (!scan) throw new AppError(404, "SCAN_NOT_FOUND", "Scan not found");

      const findings = await prisma.scanFinding.findMany({
        where: { scanId },
        include: {
          symbol: { select: { qualifiedName: true, filePath: true } },
          issueLinks: true,
        },
        orderBy: [{ severity: "asc" }, { confidence: "desc" }],
        take: 1000,
      });
      res.json({ success: true, data: findings });
    },
  );

  r.post(
    "/scans/:scanId/findings/:findingId/triage",
    requireAuth,
    requirePermission("analysis.run"),
    async (req: Request, res: Response) => {
      const projectId = projectIdOf(req);
      const scanId = String(req.params.scanId);
      const findingId = String(req.params.findingId);
      const parsed = triageSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid triage payload", {
          issues: parsed.error.flatten(),
        });
      }

      const finding = await prisma.scanFinding.findFirst({
        where: { id: findingId, scanId, scan: { projectId } },
        include: {
          scan: true,
          symbol: { select: { qualifiedName: true, filePath: true } },
        },
      });
      if (!finding) throw new AppError(404, "SCAN_FINDING_NOT_FOUND", "Scan finding not found");

      // Pure-logic gate first.
      const sf: ScanFindingForTriage = {
        id: finding.id,
        scanId: finding.scanId,
        projectId: finding.scan.projectId,
        repoConnectionId: finding.scan.repoConnectionId,
        symbolId: finding.symbolId,
        qualifiedName: finding.symbol?.qualifiedName ?? "",
        ruleId: finding.ruleId,
        title: finding.title,
        body: finding.body ?? "",
        severity: finding.severity as Severity,
        category: finding.category,
        evidenceLines: parseEvidenceLines(finding.evidenceLines),
        filePath: finding.symbol?.filePath ?? "",
        fingerprint: finding.fingerprint,
        confidence: finding.confidence,
        triageStatus: finding.triageStatus as TriageStatus,
        materializedFindingId: finding.materializedFindingId,
      };
      let outcome;
      try {
        outcome = applyTriageDecision(sf, {
          scanFindingId: findingId,
          decision: parsed.data.decision,
          actorId: actor(req),
          note: parsed.data.note,
        });
      } catch (err) {
        if (err instanceof TriageError) {
          throw new AppError(409, err.code, err.message);
        }
        throw err;
      }

      // Persist + (when approved) materialise into Finding inside a tx.
      // #1330 — `outcome.materialised` is the payload `applyTriageDecision`
      // already built; it is threaded through rather than rebuilt. The adapter
      // used to derive its own from the raw row and got five column names
      // wrong, so every approved triage 500'd and the rollback took the triage
      // stamp with it.
      const result = await materializeTriagedFinding({
        scanFindingId: findingId,
        triagedById: actor(req),
        triageStatus: outcome.newStatus,
        triageNote: parsed.data.note,
        materialised: outcome.materialised,
      });

      audit({
        actor: { id: actor(req) },
        action: `scanner.triage.${outcome.newStatus}`,
        target: { type: "scan_finding", id: findingId },
        metadata: {
          projectId,
          scanId,
          fingerprint: finding.fingerprint,
          materializedFindingId: result.findingId ?? null,
        },
      });

      res.json({
        success: true,
        data: {
          scanFindingId: findingId,
          newStatus: outcome.newStatus,
          materializedFindingId: result.findingId ?? null,
        },
      });
    },
  );

  r.post(
    "/scans/:scanId/findings/:findingId/publish",
    requireAuth,
    requirePermission("issue.publish"),
    async (req: Request, res: Response) => {
      const projectId = projectIdOf(req);
      const scanId = String(req.params.scanId);
      const findingId = String(req.params.findingId);
      const parsed = publishSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid publish payload", {
          issues: parsed.error.flatten(),
        });
      }
      const finding = await prisma.scanFinding.findFirst({
        where: { id: findingId, scanId, scan: { projectId } },
        select: {
          id: true,
          triageStatus: true,
          materializedFindingId: true,
        },
      });
      if (!finding) throw new AppError(404, "SCAN_FINDING_NOT_FOUND", "Scan finding not found");
      if (finding.triageStatus !== "approved") {
        throw new AppError(
          409,
          "TRIAGE_NOT_APPROVED",
          "Only triage-approved findings can be published",
        );
      }
      try {
        const link = await publishScanFinding({
          scanFindingId: findingId,
          provider: parsed.data.provider,
          extraLabels: parsed.data.extraLabels,
        });
        audit({
          actor: { id: actor(req) },
          action: "scanner.publish",
          target: { type: "scan_finding", id: findingId },
          metadata: {
            projectId,
            scanId,
            provider: parsed.data.provider,
            externalUrl: link.externalUrl,
          },
        });
        res.json({ success: true, data: link });
      } catch (err) {
        // Surface typed publisher errors with accurate HTTP codes so the UI
        // can render actionable messages instead of a generic 502.
        if (err instanceof PublishError) {
          const msg = err.message?.slice(0, 1000) ?? "publish failed";
          if (err.code === "ERR_STALE_COMMIT") {
            throw new AppError(409, err.code, msg);
          }
          // A precondition wasn't satisfied (e.g. Jira not configured for this
          // project). 409 Conflict is honest — the feature IS implemented, the
          // project just needs configuration — and consistent with ERR_STALE_COMMIT.
          if (err.code === "ERR_JIRA_NOT_CONFIGURED") {
            throw new AppError(409, err.code, msg);
          }
          if (err.code === "ERR_NOT_IMPLEMENTED") {
            throw new AppError(501, err.code, msg);
          }
          // Default: infrastructure/transport failure surfaces as 502.
          throw new AppError(502, err.code || "PUBLISH_FAILED", msg);
        }
        const msg = (err as Error).message?.slice(0, 1000) ?? "publish failed";
        throw new AppError(502, "PUBLISH_FAILED", msg);
      }
    },
  );

  return r;
}
