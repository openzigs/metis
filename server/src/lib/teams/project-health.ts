/**
 * Epic #63 (#578) — cheap project-health summary for the Teams `/metis status`
 * ChatOps command.
 *
 * WHY A NEW, FOCUSED SUMMARIZER (not `generateOverview` or `summarizeUsage`):
 *   - `generateOverview` (`code-graph/overview.ts`) builds the full code-graph
 *     markdown — far too heavy for an interactive command with a <2s budget.
 *   - `summarizeUsage` (`finops/budget-enforcer.ts`) reports LLM cost, not the
 *     project's delivery health a user asks `/metis status` about.
 * This module instead runs a handful of INDEXED count queries (every model used
 * has a `@@index([projectId, status])` or `@@index([projectId])`) plus two
 * "latest row" lookups, so it returns a compact, current health snapshot well
 * within the latency target without touching the graph or cost subsystems.
 *
 * It is read-only and side-effect free; Prisma is injected so the summary is
 * unit-tested with a stub (no live DB).
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../prisma.js";

/** A compact, current snapshot of a project's delivery health. */
export interface ProjectHealthSummary {
  projectId: string;
  /** Human-facing project name (for the card heading). */
  name: string;
  /** Project lifecycle status (draft|active|archived). */
  status: string;
  /** Total non-deleted requirements tracked for the project. */
  requirementCount: number;
  /** Issue-draft counts that matter for a "what's pending?" view. */
  drafts: {
    /** Drafts awaiting approval (`status="draft"`). */
    pending: number;
    /** Drafts approved but not yet published (`status="approved"`). */
    approved: number;
    /** Drafts already published. */
    published: number;
  };
  /** The most recent analysis run's status, or null when none has run. */
  latestAnalysisStatus: string | null;
  /** The most recent publish batch's status, or null when none has run. */
  latestPublishStatus: string | null;
}

/** The minimal Prisma surface this summarizer needs (keeps tests tiny). */
export type ProjectHealthPrisma = Pick<
  PrismaClient,
  "project" | "requirement" | "issueDraft" | "analysis" | "publishBatch"
>;

/**
 * Build a compact project-health snapshot from indexed count queries. Returns
 * `null` when the project does not exist or is soft-deleted (the caller turns
 * that into a graceful "project not found" card — never a leak).
 */
export async function summarizeProjectHealth(
  projectId: string,
  db: ProjectHealthPrisma = defaultPrisma as ProjectHealthPrisma,
): Promise<ProjectHealthSummary | null> {
  const project = await db.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, name: true, status: true },
  });
  if (!project) return null;

  const [requirementCount, pending, approved, published, latestAnalysis, latestBatch] =
    await Promise.all([
      db.requirement.count({ where: { projectId, deletedAt: null } }),
      db.issueDraft.count({ where: { projectId, status: "draft", deletedAt: null } }),
      db.issueDraft.count({ where: { projectId, status: "approved", deletedAt: null } }),
      db.issueDraft.count({ where: { projectId, status: "published", deletedAt: null } }),
      db.analysis.findFirst({
        where: { projectId },
        orderBy: { startedAt: "desc" },
        select: { status: true },
      }),
      db.publishBatch.findFirst({
        where: { projectId },
        orderBy: { startedAt: "desc" },
        select: { status: true },
      }),
    ]);

  return {
    projectId: project.id,
    name: project.name,
    status: project.status,
    requirementCount,
    drafts: { pending, approved, published },
    latestAnalysisStatus: latestAnalysis?.status ?? null,
    latestPublishStatus: latestBatch?.status ?? null,
  };
}
