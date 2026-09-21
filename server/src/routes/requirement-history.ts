/**
 * Epic #770 — Requirement version-history REST surface.
 *
 * Routes (mounted under `/api/requirements`):
 *   GET  /:requirementId/history                 — paginated version timeline
 *   GET  /:requirementId/history/export          — CSV / JSON export (ALL versions)
 *   POST /:requirementId/restore/:version        — restore a prior version (audited)
 *
 * RBAC:
 *   • Reading history / exporting requires `project.read` (all roles).
 *   • Restoring requires `project.update` (coordinator + admin only — developer
 *     and reader lack this permission), satisfying the "admin/coordinator"
 *     gate in the epic.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";
import { requirementScopeWhere } from "../lib/requirements/requirement-authz.js";
import { audit } from "../lib/audit/audit-service.js";
import { assertRequirementsExportable } from "../lib/reviews/approval-gate.js";
import {
  TRACKED_FIELDS,
  pickTracked,
  buildHistoryEntries,
  restoreRequirementVersion,
  RequirementVersionError,
  type HistoryEntry,
  type VersionRow,
} from "../lib/requirements/requirement-version-service.js";
import { toCsv } from "../lib/requirements/csv.js";

const TRACKED_SELECT = {
  id: true,
  projectId: true,
  version: true,
  title: true,
  body: true,
  priority: true,
  type: true,
  labels: true,
  storyPoints: true,
  reviewStatus: true,
} as const;

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

function parsePositiveInt(value: unknown, fallback: number): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** CSV header + ordered columns for a history export. */
const CSV_HEADER = [
  "version",
  "createdAt",
  "actorId",
  "reason",
  "changedFields",
  ...TRACKED_FIELDS,
];

/** Build the full RFC 4180 CSV document for a set of history entries. */
export function buildHistoryCsv(entries: HistoryEntry[]): string {
  const rows: unknown[][] = [CSV_HEADER];
  for (const entry of entries) {
    rows.push([
      entry.version,
      entry.createdAt,
      entry.actorId ?? "",
      entry.reason ?? "",
      JSON.stringify(entry.changedFields),
      ...TRACKED_FIELDS.map((f) => {
        const v = entry.snapshot[f];
        return v === null || v === undefined ? "" : String(v);
      }),
    ]);
  }
  return toCsv(rows);
}

async function loadRequirementOr404(
  req: Request,
  requirementId: string,
): Promise<Record<string, unknown> & { version: number }> {
  const row = (await prisma.requirement.findUnique({
    // Issue #1118 — narrowed to the project `requireRequirementAccess` resolved
    // for this caller, so the scope lives in the query, not only in the guard.
    where: { id: requirementId, deletedAt: null, ...requirementScopeWhere(req) },
    select: TRACKED_SELECT,
  })) as (Record<string, unknown> & { version: number }) | null;
  if (!row) {
    throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
  }
  return row;
}

async function loadVersionRows(requirementId: string): Promise<VersionRow[]> {
  return (await prisma.requirementVersion.findMany({
    where: { requirementId },
    orderBy: { version: "desc" },
  })) as unknown as VersionRow[];
}

export function requirementHistoryRouter(): Router {
  const r = Router({ mergeParams: true });

  // GET /:requirementId/history/export — full history (all versions).
  r.get(
    "/:requirementId/history/export",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const requirementId = String(req.params.requirementId);
      const format = String(req.query.format ?? "json").toLowerCase();
      const reqRow = await loadRequirementOr404(req, requirementId);
      // #619 — approval gate: with `requireApprovedReview` on, a requirement
      // may only be exported when an approved review pins its current
      // version. Throws 409 APPROVAL_REQUIRED / 503 on failure (fail-closed).
      await assertRequirementsExportable({
        projectId: String(reqRow.projectId),
        requirementIds: [requirementId],
        context: "requirement.history.export",
        actorId: req.user?.userId,
      });
      const rows = await loadVersionRows(requirementId);
      const entries = buildHistoryEntries(pickTracked(reqRow), rows);

      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="requirement-${requirementId}-history.csv"`,
        );
        res.send(buildHistoryCsv(entries));
        return;
      }

      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="requirement-${requirementId}-history.json"`,
      );
      res.send(
        JSON.stringify({ requirementId, total: entries.length, versions: entries }, null, 2),
      );
    },
  );

  // GET /:requirementId/history — paginated timeline (newest first).
  r.get(
    "/:requirementId/history",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const requirementId = String(req.params.requirementId);
      const page = parsePositiveInt(req.query.page, 1);
      const pageSize = Math.min(
        parsePositiveInt(req.query.pageSize, DEFAULT_PAGE_SIZE),
        MAX_PAGE_SIZE,
      );
      const reqRow = await loadRequirementOr404(req, requirementId);
      const rows = await loadVersionRows(requirementId);
      const entries = buildHistoryEntries(pickTracked(reqRow), rows);
      const total = entries.length;
      const start = (page - 1) * pageSize;
      const versions = entries.slice(start, start + pageSize);

      res.json({
        success: true,
        data: {
          versions,
          total,
          page,
          pageSize,
          currentVersion: reqRow.version,
        },
      });
    },
  );

  // POST /:requirementId/restore/:version — restore (admin/coordinator only).
  r.post(
    "/:requirementId/restore/:version",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const requirementId = String(req.params.requirementId);
      const targetVersion = Number.parseInt(String(req.params.version), 10);
      if (!Number.isInteger(targetVersion) || targetVersion < 1) {
        throw new AppError(400, "VALIDATION_ERROR", "`version` must be a positive integer");
      }
      const rawReason = (req.body as { reason?: unknown } | undefined)?.reason;
      const reason = typeof rawReason === "string" ? rawReason.slice(0, 500) : undefined;

      try {
        const result = await restoreRequirementVersion(prisma, {
          requirementId,
          targetVersion,
          actorId: req.user.userId,
          reason,
          // Issue #1118 — defence in depth alongside the router guard.
          projectId: requirementScopeWhere(req).projectId,
        });

        audit({
          actor: req.user.userId,
          action: "requirement.restore",
          target: { type: "requirement", id: requirementId },
          metadata: { restoredFrom: targetVersion, newVersion: result.version },
        });

        res.json({ success: true, data: result });
      } catch (err) {
        if (err instanceof RequirementVersionError) {
          if (err.code === "NOT_FOUND") {
            throw new AppError(404, "REQUIREMENT_NOT_FOUND", err.message);
          }
          throw new AppError(404, "VERSION_NOT_FOUND", err.message);
        }
        throw err;
      }
    },
  );

  return r;
}
