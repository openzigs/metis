/**
 * Epic #475 (Phase 1, #479) — promote a discussion message to a Requirement.
 *
 * A `Requirement` requires BOTH a non-null `projectId` AND a non-null
 * `analysisId` (server/prisma/schema.prisma:1176-1179). A discussion thread is
 * project-scoped but only OPTIONALLY anchored to an analysis, so promotion must
 * DERIVE an analysisId. The chosen, documented cascade (AC: "pick one"):
 *
 *   1. **thread-anchor** — if the thread is anchored to an `analysisId`, use it
 *      (the message was discussed in the context of that analysis run).
 *   2. **latest-analysis** — else the project's most recent non-deleted Analysis
 *      (`orderBy startedAt desc`). The promoted requirement attaches to the
 *      analysis the project is actively working from.
 *   3. **synthetic-discussion** — else (a brand-new project with no analysis
 *      yet) create a lightweight `status="completed"` Analysis tagged
 *      `metadata.origin="discussion"`, so the requirement always has a valid,
 *      traceable home and the FK invariant holds by construction.
 *
 * Provenance is recorded in `AuditLog` (action `discussion.message.promote`,
 * target `Requirement`/<new id>, metadata `{ sourceMessageId, threadId,
 * authorKind }`) so an AI-originated suggestion remains attributable to the AI.
 *
 * Authorization is the caller's responsibility (the route runs `canAccessThread`
 * first); this helper assumes access has been granted.
 */
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import type { RoleKey } from "@metis/shared";

export class PromoteError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PromoteError";
  }
}

export type AnalysisIdSource = "thread-anchor" | "latest-analysis" | "synthetic-discussion";

/**
 * Resolve an `analysisId` for a requirement promoted out of a discussion. See
 * the module doc for the cascade. Returns the id and which tier produced it
 * (recorded in the audit metadata for traceability).
 */
export async function deriveAnalysisId(input: {
  projectId: string;
  threadAnalysisId: string | null;
  actorId: string;
}): Promise<{ analysisId: string; source: AnalysisIdSource }> {
  // 1. Thread anchor.
  if (input.threadAnalysisId) {
    return { analysisId: input.threadAnalysisId, source: "thread-anchor" };
  }

  // 2. Project's latest analysis.
  const latest = await prisma.analysis.findFirst({
    where: { projectId: input.projectId, deletedAt: null },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  if (latest) {
    return { analysisId: latest.id, source: "latest-analysis" };
  }

  // 3. Synthetic "discussion" analysis.
  const synthetic = await prisma.analysis.create({
    data: {
      projectId: input.projectId,
      startedById: input.actorId,
      status: "completed",
      completedAt: new Date(),
      metadata: JSON.stringify({ origin: "discussion" }),
    },
    select: { id: true },
  });
  return { analysisId: synthetic.id, source: "synthetic-discussion" };
}

export interface PromoteInput {
  actor: { id: string; role: RoleKey };
  threadId: string;
  messageId: string;
  title: string;
  type?: string;
  priority?: string;
}

export interface PromoteResult {
  requirementId: string;
  analysisId: string;
  analysisIdSource: AnalysisIdSource;
}

/**
 * Promote a single discussion message into a tracked `Requirement` (+ initial
 * `RequirementVersion`) and write an `AuditLog` provenance row. Works for both
 * human- and AI-authored messages; the source `authorKind` is preserved in the
 * audit metadata.
 */
export async function promoteMessageToRequirement(input: PromoteInput): Promise<PromoteResult> {
  const thread = await prisma.discussionThread.findFirst({
    where: { id: input.threadId, deletedAt: null },
    select: { id: true, projectId: true, analysisId: true },
  });
  if (!thread) throw new PromoteError("THREAD_NOT_FOUND", "Discussion thread not found");

  const message = await prisma.discussionMessage.findFirst({
    where: { id: input.messageId, threadId: input.threadId, deletedAt: null },
    select: { id: true, authorKind: true, body: true },
  });
  if (!message) {
    throw new PromoteError("MESSAGE_NOT_FOUND", "Message not found in this thread");
  }

  const { analysisId, source } = await deriveAnalysisId({
    projectId: thread.projectId,
    threadAnalysisId: thread.analysisId,
    actorId: input.actor.id,
  });

  // Create the requirement + its initial (version 0) history row atomically so a
  // requirement never exists without its origin version.
  const requirementId = await prisma.$transaction(async (tx) => {
    const requirement = await tx.requirement.create({
      data: {
        projectId: thread.projectId,
        analysisId,
        title: input.title.slice(0, 255),
        body: message.body,
        type: input.type ?? "feature",
        priority: input.priority ?? "medium",
      },
      select: { id: true },
    });

    await tx.requirementVersion.create({
      data: {
        requirementId: requirement.id,
        version: 0,
        changedFields: JSON.stringify({
          __created: { from: null, to: "promoted-from-discussion" },
        }),
        actorId: input.actor.id,
        reason: `Promoted from discussion message ${message.id}`,
      },
    });

    return requirement.id;
  });

  // Provenance — keep the AI/human origin and the source ids.
  audit({
    actor: { id: input.actor.id },
    action: "discussion.message.promote",
    target: { type: "Requirement", id: requirementId },
    metadata: {
      sourceMessageId: message.id,
      threadId: input.threadId,
      authorKind: message.authorKind,
      analysisId,
      analysisIdSource: source,
    },
  });

  return { requirementId, analysisId, analysisIdSource: source };
}
