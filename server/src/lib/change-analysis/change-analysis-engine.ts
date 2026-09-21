/**
 * Change analysis engine — Epic #557 / Issue #564.
 *
 * Compares requirements between two analysis runs (base vs head), detecting
 * additions, removals, and modifications. Computes change severity and
 * impact scores using title similarity and content delta analysis.
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { audit } from "../audit/audit-service.js";
import type {
  ChangeAnalysis as SharedChangeAnalysis,
  RequirementChange as SharedRequirementChange,
  ChangeAnalysisDetail,
} from "@metis/shared";

const log = createChildLogger("change-analysis");

// ---- Types -----------------------------------------------------------------

type ChangeAnalysisRow = Awaited<ReturnType<typeof prisma.changeAnalysis.findFirst>> & object;
type RequirementChangeRow = Awaited<ReturnType<typeof prisma.requirementChange.findFirst>> & object;

interface RequirementSnapshot {
  id: string;
  title: string;
  body: string;
  type: string;
  priority: string;
  labels: string;
  storyPoints: number | null;
  parentId: string | null;
}

// ---- Errors ----------------------------------------------------------------

export class ChangeAnalysisError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ChangeAnalysisError";
  }
}

// ---- Mappers ---------------------------------------------------------------

function toApi(row: ChangeAnalysisRow): SharedChangeAnalysis {
  return {
    id: row.id,
    projectId: row.projectId,
    baseAnalysisId: row.baseAnalysisId,
    headAnalysisId: row.headAnalysisId,
    status: row.status as SharedChangeAnalysis["status"],
    summary: row.summary,
    totalChanges: row.totalChanges,
    additions: row.additions,
    removals: row.removals,
    modifications: row.modifications,
    startedById: row.startedById,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toChangeApi(row: RequirementChangeRow): SharedRequirementChange {
  return {
    id: row.id,
    changeAnalysisId: row.changeAnalysisId,
    changeType: row.changeType as SharedRequirementChange["changeType"],
    severity: row.severity as SharedRequirementChange["severity"],
    impactScore: row.impactScore,
    requirementId: row.requirementId,
    previousRequirementId: row.previousRequirementId,
    title: row.title,
    previousTitle: row.previousTitle,
    body: row.body,
    previousBody: row.previousBody,
    diffSummary: row.diffSummary,
    reviewStatus: row.reviewStatus as SharedRequirementChange["reviewStatus"],
    reviewedById: row.reviewedById,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
  };
}

// ---- Similarity / scoring --------------------------------------------------

/**
 * Compute Jaccard similarity between two strings by word bigrams.
 * Returns value in [0, 1] where 1 is identical.
 */
export function titleSimilarity(a: string, b: string): number {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim();
  const bigrams = (s: string): Set<string> => {
    const words = normalize(s).split(/\s+/).filter(Boolean);
    const set = new Set<string>();
    for (let i = 0; i < words.length - 1; i++) {
      set.add(`${words[i]} ${words[i + 1]}`);
    }
    // Also include unigrams for short titles
    for (const w of words) set.add(w);
    return set;
  };

  const setA = bigrams(a);
  const setB = bigrams(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Compute change severity based on change type and content delta size.
 */
export function computeSeverity(
  changeType: "added" | "removed" | "modified",
  bodyDelta: number,
  priorityChanged: boolean,
  typeChanged: boolean,
): "critical" | "high" | "medium" | "low" {
  if (changeType === "removed") return "high";
  if (changeType === "added") {
    return bodyDelta > 500 ? "medium" : "low";
  }
  // modified
  if (typeChanged || priorityChanged) return "high";
  if (bodyDelta > 300) return "medium";
  return "low";
}

/**
 * Compute impact score (0.0–1.0) based on change characteristics.
 */
export function computeImpactScore(
  changeType: "added" | "removed" | "modified",
  severity: string,
  hasChildren: boolean,
  bodyDelta: number,
): number {
  let score = 0.3; // base

  // Change type weight
  if (changeType === "removed") score += 0.3;
  else if (changeType === "modified") score += 0.15;
  else score += 0.1;

  // Severity weight
  if (severity === "critical") score += 0.25;
  else if (severity === "high") score += 0.2;
  else if (severity === "medium") score += 0.1;

  // Hierarchy weight — changes to parents impact children
  if (hasChildren) score += 0.15;

  // Content delta weight
  if (bodyDelta > 500) score += 0.1;

  return Math.min(1.0, Math.round(score * 100) / 100);
}

/**
 * Generate a human-readable summary of changes between two requirement versions.
 */
export function generateDiffSummary(base: RequirementSnapshot, head: RequirementSnapshot): string {
  const parts: string[] = [];

  if (base.title !== head.title) {
    parts.push(`Title changed from "${base.title}" to "${head.title}"`);
  }
  if (base.type !== head.type) {
    parts.push(`Type changed from ${base.type} to ${head.type}`);
  }
  if (base.priority !== head.priority) {
    parts.push(`Priority changed from ${base.priority} to ${head.priority}`);
  }
  if (base.storyPoints !== head.storyPoints) {
    parts.push(
      `Story points changed from ${base.storyPoints ?? "unset"} to ${head.storyPoints ?? "unset"}`,
    );
  }
  if (base.body !== head.body) {
    const delta = Math.abs(head.body.length - base.body.length);
    parts.push(`Body content modified (${delta} character delta)`);
  }

  return parts.length > 0 ? parts.join("; ") : "No significant changes detected";
}

// ---- Core engine -----------------------------------------------------------

/**
 * Match requirements between base and head by title similarity.
 * Returns matched pairs, unmatched base (removals), unmatched head (additions).
 */
export function matchRequirements(
  baseReqs: RequirementSnapshot[],
  headReqs: RequirementSnapshot[],
): {
  matched: Array<{ base: RequirementSnapshot; head: RequirementSnapshot; similarity: number }>;
  removed: RequirementSnapshot[];
  added: RequirementSnapshot[];
} {
  const MATCH_THRESHOLD = 0.4;
  const usedBase = new Set<string>();
  const usedHead = new Set<string>();

  // Build similarity matrix
  const candidates: Array<{
    base: RequirementSnapshot;
    head: RequirementSnapshot;
    similarity: number;
  }> = [];

  for (const b of baseReqs) {
    for (const h of headReqs) {
      const sim = titleSimilarity(b.title, h.title);
      if (sim >= MATCH_THRESHOLD) {
        candidates.push({ base: b, head: h, similarity: sim });
      }
    }
  }

  // Greedy matching — highest similarity first
  candidates.sort((a, b) => b.similarity - a.similarity);

  const matched: Array<{
    base: RequirementSnapshot;
    head: RequirementSnapshot;
    similarity: number;
  }> = [];

  for (const c of candidates) {
    if (usedBase.has(c.base.id) || usedHead.has(c.head.id)) continue;
    matched.push(c);
    usedBase.add(c.base.id);
    usedHead.add(c.head.id);
  }

  const removed = baseReqs.filter((b) => !usedBase.has(b.id));
  const added = headReqs.filter((h) => !usedHead.has(h.id));

  return { matched, removed, added };
}

// ---- Service API -----------------------------------------------------------

export async function triggerChangeAnalysis(opts: {
  projectId: string;
  baseAnalysisId: string;
  headAnalysisId: string;
  actorId: string;
}): Promise<SharedChangeAnalysis> {
  // Validate both analyses exist and belong to the project
  const [baseAnalysis, headAnalysis] = await Promise.all([
    prisma.analysis.findFirst({
      where: { id: opts.baseAnalysisId, projectId: opts.projectId, deletedAt: null },
    }),
    prisma.analysis.findFirst({
      where: { id: opts.headAnalysisId, projectId: opts.projectId, deletedAt: null },
    }),
  ]);

  if (!baseAnalysis) {
    throw new ChangeAnalysisError(404, "BASE_ANALYSIS_NOT_FOUND", "Base analysis not found");
  }
  if (!headAnalysis) {
    throw new ChangeAnalysisError(404, "HEAD_ANALYSIS_NOT_FOUND", "Head analysis not found");
  }
  if (baseAnalysis.status !== "completed") {
    throw new ChangeAnalysisError(
      400,
      "BASE_ANALYSIS_NOT_COMPLETED",
      "Base analysis must be completed",
    );
  }
  if (headAnalysis.status !== "completed") {
    throw new ChangeAnalysisError(
      400,
      "HEAD_ANALYSIS_NOT_COMPLETED",
      "Head analysis must be completed",
    );
  }
  if (opts.baseAnalysisId === opts.headAnalysisId) {
    throw new ChangeAnalysisError(
      400,
      "SAME_ANALYSIS",
      "Base and head analysis cannot be the same",
    );
  }

  const row = await prisma.changeAnalysis.create({
    data: {
      projectId: opts.projectId,
      baseAnalysisId: opts.baseAnalysisId,
      headAnalysisId: opts.headAnalysisId,
      status: "pending",
      startedById: opts.actorId,
    },
  });

  audit({
    actor: { id: opts.actorId },
    action: "change_analysis.trigger",
    target: { type: "change_analysis", id: row.id },
    metadata: {
      projectId: opts.projectId,
      baseAnalysisId: opts.baseAnalysisId,
      headAnalysisId: opts.headAnalysisId,
    },
  });

  // Execute analysis in-band (synchronous for now — could be async via queue)
  void executeChangeAnalysis(row.id).catch((err) => {
    log.error("Change analysis execution failed", { id: row.id, error: String(err) });
  });

  // Return the pending row — client polls for completion
  return toApi(row);
}

async function executeChangeAnalysis(changeAnalysisId: string): Promise<void> {
  await prisma.changeAnalysis.update({
    where: { id: changeAnalysisId },
    data: { status: "running" },
  });

  try {
    const ca = await prisma.changeAnalysis.findUniqueOrThrow({
      where: { id: changeAnalysisId },
    });

    // Load requirements from both analyses
    const [baseReqs, headReqs] = await Promise.all([
      prisma.requirement.findMany({
        where: { analysisId: ca.baseAnalysisId, deletedAt: null },
        select: {
          id: true,
          title: true,
          body: true,
          type: true,
          priority: true,
          labels: true,
          storyPoints: true,
          parentId: true,
        },
      }),
      prisma.requirement.findMany({
        where: { analysisId: ca.headAnalysisId, deletedAt: null },
        select: {
          id: true,
          title: true,
          body: true,
          type: true,
          priority: true,
          labels: true,
          storyPoints: true,
          parentId: true,
        },
      }),
    ]);

    // Match requirements and detect changes
    const { matched, removed, added } = matchRequirements(baseReqs, headReqs);

    // Build parent lookup for impact scoring
    const headParentIds = new Set(headReqs.filter((r) => r.parentId).map((r) => r.parentId!));
    const baseParentIds = new Set(baseReqs.filter((r) => r.parentId).map((r) => r.parentId!));

    const changes: Array<{
      changeType: "added" | "removed" | "modified";
      severity: "critical" | "high" | "medium" | "low";
      impactScore: number;
      requirementId: string | null;
      previousRequirementId: string | null;
      title: string;
      previousTitle: string | null;
      body: string;
      previousBody: string | null;
      diffSummary: string | null;
    }> = [];

    // Additions
    for (const h of added) {
      const bodyDelta = h.body.length;
      const severity = computeSeverity("added", bodyDelta, false, false);
      const impact = computeImpactScore("added", severity, headParentIds.has(h.id), bodyDelta);
      changes.push({
        changeType: "added",
        severity,
        impactScore: impact,
        requirementId: h.id,
        previousRequirementId: null,
        title: h.title,
        previousTitle: null,
        body: h.body,
        previousBody: null,
        diffSummary: `New ${h.type} requirement added`,
      });
    }

    // Removals
    for (const b of removed) {
      const bodyDelta = b.body.length;
      const severity = computeSeverity("removed", bodyDelta, false, false);
      const impact = computeImpactScore("removed", severity, baseParentIds.has(b.id), bodyDelta);
      changes.push({
        changeType: "removed",
        severity,
        impactScore: impact,
        requirementId: null,
        previousRequirementId: b.id,
        title: b.title,
        previousTitle: b.title,
        body: b.body,
        previousBody: b.body,
        diffSummary: `${b.type} requirement removed`,
      });
    }

    // Modifications
    for (const m of matched) {
      const { base, head } = m;
      // Skip if nothing actually changed
      if (
        base.title === head.title &&
        base.body === head.body &&
        base.type === head.type &&
        base.priority === head.priority &&
        base.storyPoints === head.storyPoints
      ) {
        continue;
      }

      const bodyDelta = Math.abs(head.body.length - base.body.length);
      const priorityChanged = base.priority !== head.priority;
      const typeChanged = base.type !== head.type;
      const severity = computeSeverity("modified", bodyDelta, priorityChanged, typeChanged);
      const impact = computeImpactScore(
        "modified",
        severity,
        headParentIds.has(head.id),
        bodyDelta,
      );
      const diffSummary = generateDiffSummary(base, head);

      changes.push({
        changeType: "modified",
        severity,
        impactScore: impact,
        requirementId: head.id,
        previousRequirementId: base.id,
        title: head.title,
        previousTitle: base.title,
        body: head.body,
        previousBody: base.body,
        diffSummary,
      });
    }

    // Persist changes
    if (changes.length > 0) {
      await prisma.requirementChange.createMany({
        data: changes.map((c) => ({
          changeAnalysisId,
          ...c,
        })),
      });
    }

    // Compute summary
    const addCount = changes.filter((c) => c.changeType === "added").length;
    const removeCount = changes.filter((c) => c.changeType === "removed").length;
    const modCount = changes.filter((c) => c.changeType === "modified").length;
    const summaryParts: string[] = [];
    if (addCount) summaryParts.push(`${addCount} added`);
    if (removeCount) summaryParts.push(`${removeCount} removed`);
    if (modCount) summaryParts.push(`${modCount} modified`);
    const summary =
      changes.length === 0
        ? "No changes detected between the two analysis runs"
        : `${changes.length} changes detected: ${summaryParts.join(", ")}`;

    await prisma.changeAnalysis.update({
      where: { id: changeAnalysisId },
      data: {
        status: "completed",
        completedAt: new Date(),
        totalChanges: changes.length,
        additions: addCount,
        removals: removeCount,
        modifications: modCount,
        summary,
      },
    });

    log.info("Change analysis completed", { id: changeAnalysisId, totalChanges: changes.length });
  } catch (err) {
    log.error("Change analysis failed", { id: changeAnalysisId, error: String(err) });
    await prisma.changeAnalysis.update({
      where: { id: changeAnalysisId },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

// ---- Read API --------------------------------------------------------------

export async function listChangeAnalyses(projectId: string): Promise<SharedChangeAnalysis[]> {
  const rows = await prisma.changeAnalysis.findMany({
    where: { projectId },
    orderBy: { startedAt: "desc" },
  });
  return rows.map(toApi);
}

/**
 * Load a change analysis and its changes, scoped to its owning project.
 *
 * Issue #1073 — `projectId` is REQUIRED and lives in the Prisma `where`, not
 * only at the router: the caller-supplied id alone would otherwise resolve any
 * tenant's analysis (the route is mounted under `/projects/:projectId`, so a
 * legitimate member of one project could pair their own project with another
 * project's analysis id). An out-of-tenant id and an unknown id therefore
 * produce the same `CHANGE_ANALYSIS_NOT_FOUND` 404 — no existence oracle.
 */
export async function getChangeAnalysis(opts: {
  id: string;
  projectId: string;
}): Promise<ChangeAnalysisDetail> {
  const row = await prisma.changeAnalysis.findFirst({
    where: { id: opts.id, projectId: opts.projectId },
    include: { changes: { orderBy: { createdAt: "asc" } } },
  });
  if (!row) {
    throw new ChangeAnalysisError(404, "CHANGE_ANALYSIS_NOT_FOUND", "Change analysis not found");
  }
  return {
    ...toApi(row),
    changes: row.changes.map(toChangeApi),
  };
}

/**
 * Approve or reject a single requirement change.
 *
 * Issue #1073 — the lookup binds all three ids at once: the change must belong
 * to `changeAnalysisId`, and that analysis must belong to `projectId`. Scoping
 * only the analysis would still let a correctly-addressed analysis be paired
 * with a foreign `changeId`, and this route is a WRITE — it decides another
 * tenant's review state.
 */
export async function reviewChange(opts: {
  projectId: string;
  changeAnalysisId: string;
  changeId: string;
  reviewStatus: "approved" | "rejected";
  actorId: string;
}): Promise<SharedRequirementChange> {
  const change = await prisma.requirementChange.findFirst({
    where: {
      id: opts.changeId,
      changeAnalysisId: opts.changeAnalysisId,
      changeAnalysis: { projectId: opts.projectId },
    },
  });
  if (!change) {
    throw new ChangeAnalysisError(404, "CHANGE_NOT_FOUND", "Requirement change not found");
  }

  const updated = await prisma.requirementChange.update({
    where: { id: opts.changeId },
    data: {
      reviewStatus: opts.reviewStatus,
      reviewedById: opts.actorId,
      reviewedAt: new Date(),
    },
  });

  audit({
    actor: { id: opts.actorId },
    action: `change_analysis.review.${opts.reviewStatus}`,
    target: { type: "requirement_change", id: opts.changeId },
    metadata: { changeAnalysisId: change.changeAnalysisId, projectId: opts.projectId },
  });

  return toChangeApi(updated);
}
