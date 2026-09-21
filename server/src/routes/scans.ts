/**
 * Epic #708 / Issue #711 — Scan lifecycle API.
 *
 * Mounted at /api/projects/:projectId/repositories/:repoId/scans (queue + list)
 * and /api/projects/:projectId/scans/:scanId (single read).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";
import { audit } from "../lib/audit/audit-service.js";
import { getSchedulerBootstrap } from "../lib/scheduler/index.js";
import { DEFAULT_SCAN_TOKEN_BUDGET, SCAN_MODE_VALUES } from "../lib/scanner/types.js";

const startScanSchema = z.object({
  mode: z
    .enum(SCAN_MODE_VALUES as unknown as ["rules", "heuristic", "both", "spec"])
    .default("both"),
  budgetCapTokens: z.number().int().positive().max(50_000_000).optional(),
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

/**
 * Issue #422 — map each scan to the scheduler `Task` id that drives it, so the
 * scans page can `subscribe:task` and render the live `task:progress` /
 * `task:status` events the queue already emits.
 *
 * No schema change: the link is read from the existing `tasks` table. A scan is
 * enqueued as a `scanner.run-scan` task whose JSON `payload` carries `{ scanId }`.
 * We pull the active (`pending`/`running`) scanner tasks for the project and bucket
 * them by their payload's scanId, then attach the most recent task id per scan.
 * Terminal scans don't need a live taskId (the poll/row already shows the result),
 * so we only resolve ids for scans that are still in flight — keeping the query
 * narrow and avoiding a JSON scan over the whole task history.
 */
async function resolveScanTaskIds(
  projectId: string,
  scanIds: readonly string[],
): Promise<Map<string, string>> {
  const byScanId = new Map<string, string>();
  if (scanIds.length === 0) return byScanId;
  const wanted = new Set(scanIds);
  const tasks = await prisma.task.findMany({
    where: {
      projectId,
      type: "scanner.run-scan",
      status: { in: ["pending", "running"] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, payload: true },
  });
  for (const task of tasks) {
    let scanId: string | undefined;
    try {
      const parsed = JSON.parse(task.payload) as { scanId?: unknown };
      if (typeof parsed.scanId === "string") scanId = parsed.scanId;
    } catch {
      // Malformed payload — skip; never throw out of a read path.
      continue;
    }
    // `orderBy desc` means the first task seen for a scan is the newest; keep it.
    if (scanId && wanted.has(scanId) && !byScanId.has(scanId)) {
      byScanId.set(scanId, task.id);
    }
  }
  return byScanId;
}

export function scansRouter(): Router {
  const r = Router({ mergeParams: true });

  // POST /api/projects/:projectId/repositories/:repoId/scans — queue a scan
  r.post(
    "/repositories/:repoId/scans",
    requireAuth,
    requirePermission("analysis.run"),
    async (req: Request, res: Response) => {
      const projectId = projectIdOf(req);
      const repoConnectionId = String(req.params.repoId);
      const parsed = startScanSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid scan payload", {
          issues: parsed.error.flatten(),
        });
      }
      const conn = await prisma.repoConnection.findFirst({
        where: { id: repoConnectionId, projectId, deletedAt: null },
        select: { id: true, lastCommitSha: true, status: true },
      });
      if (!conn) {
        throw new AppError(404, "REPO_CONNECTION_NOT_FOUND", "Repo connection not found");
      }

      // Epic #708 mandate: refuse to scan a repository that has no code
      // graph indexed — otherwise the scanner has no symbols to walk and the
      // per-project RAG/neighbour lookups have no anchor.
      const graph = await prisma.codeGraph.findFirst({
        where: { projectId, repoConnectionId },
        select: { id: true, commitSha: true },
      });
      if (!graph) {
        throw new AppError(
          409,
          "INDEX_REQUIRED",
          "Repository has not been indexed yet — run the code-graph ingest first before scanning.",
        );
      }

      // Refuse to anchor a scan to an empty commit SHA. Prefer the
      // CodeGraph's snapshot SHA (set by ingest), fall back to the repo
      // connection's last-known commit. Reject when both are missing — we
      // will not let a scan run without a verifiable commit anchor.
      const commitSha = (graph.commitSha ?? conn.lastCommitSha ?? "").trim();
      if (!commitSha) {
        throw new AppError(
          409,
          "COMMIT_SHA_REQUIRED",
          "Repository has no captured commit SHA — re-ingest the code graph before scanning.",
        );
      }

      // Epic #724: spec mode requires at least one indexed spec-tagged document.
      if (parsed.data.mode === "spec") {
        const specDocCount = await prisma.document.count({
          where: { projectId, isSpec: true, deletedAt: null, indexState: "indexed" },
        });
        if (specDocCount === 0) {
          throw new AppError(
            409,
            "SPEC_DOCUMENTS_REQUIRED",
            "Spec scan mode requires at least one document tagged as a spec. Upload and tag documents before running a spec scan.",
          );
        }
      }

      const userId = actor(req);
      const scan = await prisma.scan.create({
        data: {
          projectId,
          repoConnectionId,
          commitSha,
          status: "pending",
          mode: parsed.data.mode,
          budgetCapTokens: parsed.data.budgetCapTokens ?? DEFAULT_SCAN_TOKEN_BUDGET,
          createdById: userId,
        },
      });

      const { queue } = getSchedulerBootstrap();
      await queue.enqueue({
        type: "scanner.run-scan",
        trigger: "manual",
        payload: { scanId: scan.id },
        projectId,
        createdById: userId,
      });

      audit({
        actor: { id: userId },
        action: "scanner.scan.enqueue",
        target: { type: "scan", id: scan.id },
        metadata: { projectId, repoConnectionId, mode: scan.mode },
      });

      res.status(202).json({ success: true, data: scan });
    },
  );

  // GET /api/projects/:projectId/repositories/:repoId/scans/index-status —
  // Epic #708: lightweight gate the UI calls to know whether the
  // "Scan for bugs" CTA should be enabled. Returns `{ indexed: boolean,
  // commitSha: string | null }` — no scan rows touched.
  r.get(
    "/repositories/:repoId/scans/index-status",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      const projectId = projectIdOf(req);
      const repoConnectionId = String(req.params.repoId);
      const [conn, graph] = await Promise.all([
        prisma.repoConnection.findFirst({
          where: { id: repoConnectionId, projectId, deletedAt: null },
          select: { id: true, lastCommitSha: true },
        }),
        prisma.codeGraph.findFirst({
          where: { projectId, repoConnectionId },
          select: { id: true, commitSha: true, updatedAt: true, symbolCount: true },
        }),
      ]);
      if (!conn) {
        throw new AppError(404, "REPO_CONNECTION_NOT_FOUND", "Repo connection not found");
      }
      const commitSha = (graph?.commitSha ?? conn.lastCommitSha ?? "").trim();
      res.json({
        success: true,
        data: {
          indexed: Boolean(graph) && commitSha.length > 0,
          commitSha: commitSha.length > 0 ? commitSha : null,
          lastIndexedAt: graph?.updatedAt ?? null,
          symbolCount: graph?.symbolCount ?? 0,
        },
      });
    },
  );

  // GET /api/projects/:projectId/repositories/:repoId/scans — list
  r.get(
    "/repositories/:repoId/scans",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      const projectId = projectIdOf(req);
      const repoConnectionId = String(req.params.repoId);
      const scans = await prisma.scan.findMany({
        where: { projectId, repoConnectionId },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      res.json({ success: true, data: scans });
    },
  );

  // GET /api/projects/:projectId/scans — list all scans for the project
  r.get(
    "/scans",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      const projectId = projectIdOf(req);
      const scans = await prisma.scan.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take: 100,
        include: {
          _count: { select: { scanFindings: true } },
        },
      });
      // Only in-flight scans need a live task id to subscribe to (#422).
      const inFlightIds = scans
        .filter((s) => s.status === "pending" || s.status === "running")
        .map((s) => s.id);
      const taskIdByScan = await resolveScanTaskIds(projectId, inFlightIds);
      const data = scans.map((s) => ({
        ...s,
        findingCount: s._count.scanFindings,
        taskId: taskIdByScan.get(s.id) ?? null,
        _count: undefined,
      }));
      res.json({ success: true, data });
    },
  );

  // GET /api/projects/:projectId/scans/:scanId — single
  r.get(
    "/scans/:scanId",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      const projectId = projectIdOf(req);
      const scanId = String(req.params.scanId);
      const scan = await prisma.scan.findFirst({
        where: { id: scanId, projectId },
      });
      if (!scan) throw new AppError(404, "SCAN_NOT_FOUND", "Scan not found");
      // Surface the live task id so the detail view can subscribe to progress (#422).
      const taskIdByScan =
        scan.status === "pending" || scan.status === "running"
          ? await resolveScanTaskIds(projectId, [scan.id])
          : new Map<string, string>();
      res.json({ success: true, data: { ...scan, taskId: taskIdByScan.get(scan.id) ?? null } });
    },
  );

  return r;
}
