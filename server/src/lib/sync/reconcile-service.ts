/**
 * Epic #739 — Reconciliation service.
 *
 * Matches incoming `IssueChangeEvent` (from GitHub or Jira webhooks) to
 * a `PublishedIssue` row, computes field-level diff against the local state,
 * and persists a `DriftEvent` row. Drift surfaces via the REST drift API and,
 * since #78, via a realtime `drift:detected` broadcast to the `project:{id}`
 * room so the pending-drift badge updates without a reload.
 *
 * Idempotent: duplicate `deliveryId` values are rejected at the DB unique
 * constraint level and surfaced as a no-op result.
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { createSocketDriftEmitter } from "./socket-emitter.js";
import { audit } from "../audit/audit-service.js";
import type {
  IssueChangeEvent,
  IssueChangeFields,
  FieldDiff,
  DriftEventRow,
  DriftResolutionAction,
} from "@metis/shared";

const log = createChildLogger("sync-reconcile");

export interface ReconcileResult {
  handled: boolean;
  driftEventId?: string;
  reason?: string;
}

export interface ReconcileDeps {
  /**
   * #78 — defaults to the Socket.IO emitter. Every caller (both webhook
   * receivers and the Jira poll worker) previously left this undefined, so the
   * broadcast never happened; defaulting HERE rather than at each composition
   * root is what stops a future caller re-introducing the silent gap. The
   * default is a no-op until the IO server is registered, so tests that pass no
   * deps behave exactly as before.
   */
  emitDrift?: (projectId: string, event: DriftEventRow) => void;
}

/** Built once per module load; resolves the live IO server on each call. */
const defaultEmitDrift = createSocketDriftEmitter();

/**
 * Process a normalized issue change event: look up the PublishedIssue,
 * compute diffs, persist a DriftEvent row, and emit the socket event.
 */
export async function reconcileIssueChange(
  event: IssueChangeEvent,
  deps: ReconcileDeps = {},
): Promise<ReconcileResult> {
  // 1. Find the PublishedIssue by external id
  const publishedIssue = await prisma.publishedIssue.findFirst({
    where: { issueId: event.externalId },
    include: {
      batch: { include: { project: true } },
      draft: true,
    },
  });

  if (!publishedIssue) {
    log.debug("sync.reconcile.no_published_issue", { externalId: event.externalId });
    return { handled: false, reason: "NO_PUBLISHED_ISSUE" };
  }

  const projectId = publishedIssue.batch.projectId;
  const requirementId = publishedIssue.draft.requirementId ?? null;

  // 2. Build local snapshot from draft
  const localSnapshot: IssueChangeFields = {
    title: publishedIssue.draft.title ?? "",
    body: publishedIssue.draft.body ?? "",
    state: publishedIssue.status === "created" ? "open" : "open",
    labels: safeJsonArray(publishedIssue.draft.labels),
    assignees: [],
  };

  // 3. Compute field-level diffs
  const fieldDiffs = computeFieldDiffs(localSnapshot, event.current);

  if (fieldDiffs.length === 0) {
    log.debug("sync.reconcile.no_diff", { deliveryId: event.deliveryId });
    return { handled: false, reason: "NO_DIFF" };
  }

  // 4. Persist DriftEvent (idempotent via unique deliveryId)
  try {
    const driftEvent = await prisma.driftEvent.create({
      data: {
        publishedIssueId: publishedIssue.id,
        projectId,
        requirementId,
        source: event.source,
        deliveryId: event.deliveryId,
        action: event.action,
        fieldDiffs: JSON.stringify(fieldDiffs),
        externalSnapshot: JSON.stringify(event.current),
        localSnapshot: JSON.stringify(localSnapshot),
        status: "pending",
      },
    });

    const row: DriftEventRow = {
      id: driftEvent.id,
      publishedIssueId: driftEvent.publishedIssueId,
      projectId: driftEvent.projectId,
      requirementId: driftEvent.requirementId,
      source: driftEvent.source as IssueChangeEvent["source"],
      deliveryId: driftEvent.deliveryId,
      action: driftEvent.action as IssueChangeEvent["action"],
      fieldDiffs,
      externalSnapshot: event.current,
      localSnapshot,
      status: "pending",
      resolution: null,
      resolvedById: null,
      resolvedAt: null,
      createdAt: driftEvent.createdAt.toISOString(),
    };

    // 5. Emit socket event (#78 — the badge's live update depends on this).
    (deps.emitDrift ?? defaultEmitDrift)(projectId, row);

    // 6. Audit
    void audit({
      actor: null,
      action: "sync.drift_detected",
      target: { type: "drift_event", id: driftEvent.id },
      metadata: {
        source: event.source,
        action: event.action,
        fieldCount: fieldDiffs.length,
        projectId,
      },
    });

    log.info("sync.reconcile.drift_created", {
      driftEventId: driftEvent.id,
      projectId,
      source: event.source,
      fields: fieldDiffs.map((d) => d.field),
    });

    return { handled: true, driftEventId: driftEvent.id };
  } catch (err: unknown) {
    // Unique constraint violation on deliveryId = duplicate webhook
    if (isPrismaUniqueConstraintError(err)) {
      log.debug("sync.reconcile.duplicate", { deliveryId: event.deliveryId });
      return { handled: false, reason: "DUPLICATE" };
    }
    throw err;
  }
}

/**
 * Resolve a drift event with the chosen action.
 */
export async function resolveDriftEvent(
  driftEventId: string,
  action: DriftResolutionAction,
  actorId: string,
): Promise<DriftEventRow> {
  const existing = await prisma.driftEvent.findUnique({ where: { id: driftEventId } });
  if (!existing) throw new Error("DRIFT_NOT_FOUND");
  if (existing.status === "resolved") throw new Error("ALREADY_RESOLVED");

  const updated = await prisma.driftEvent.update({
    where: { id: driftEventId },
    data: {
      status: "resolved",
      resolution: action,
      resolvedById: actorId,
      resolvedAt: new Date(),
    },
  });

  // If action is "adopt", update the local draft to match external state
  if (action === "adopt") {
    const externalSnapshot: IssueChangeFields = JSON.parse(existing.externalSnapshot);
    const publishedIssue = await prisma.publishedIssue.findUnique({
      where: { id: existing.publishedIssueId },
    });
    if (publishedIssue) {
      await prisma.issueDraft.update({
        where: { id: publishedIssue.draftId },
        data: {
          title: externalSnapshot.title,
          body: externalSnapshot.body,
          labels: JSON.stringify(externalSnapshot.labels),
        },
      });
    }
  }

  void audit({
    actor: actorId,
    action: "sync.drift_resolved",
    target: { type: "drift_event", id: driftEventId },
    metadata: {
      resolution: action,
      before: { status: existing.status },
      after: { status: "resolved", resolution: action },
    },
  });

  const fieldDiffs: FieldDiff[] = JSON.parse(updated.fieldDiffs);
  return {
    id: updated.id,
    publishedIssueId: updated.publishedIssueId,
    projectId: updated.projectId,
    requirementId: updated.requirementId,
    source: updated.source as IssueChangeEvent["source"],
    deliveryId: updated.deliveryId,
    action: updated.action as IssueChangeEvent["action"],
    fieldDiffs,
    externalSnapshot: JSON.parse(updated.externalSnapshot),
    localSnapshot: updated.localSnapshot ? JSON.parse(updated.localSnapshot) : null,
    status: "resolved",
    resolution: action,
    resolvedById: actorId,
    resolvedAt: updated.resolvedAt?.toISOString() ?? null,
    createdAt: updated.createdAt.toISOString(),
  };
}

/**
 * List drift events for a project with optional filters.
 */
export async function listDriftEvents(
  projectId: string,
  opts: { status?: string; requirementId?: string; page?: number; perPage?: number } = {},
): Promise<{ items: DriftEventRow[]; total: number }> {
  const { status, requirementId, page = 1, perPage = 20 } = opts;
  const where: Record<string, unknown> = { projectId };
  if (status) where.status = status;
  if (requirementId) where.requirementId = requirementId;

  const [items, total] = await Promise.all([
    prisma.driftEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.driftEvent.count({ where }),
  ]);

  return {
    items: items.map(toDriftEventRow),
    total,
  };
}

/**
 * Get drift count per project (for badge display).
 */
export async function getDriftCount(projectId: string): Promise<number> {
  return prisma.driftEvent.count({ where: { projectId, status: "pending" } });
}

// ---- Helpers ---------------------------------------------------------------

function computeFieldDiffs(local: IssueChangeFields, external: IssueChangeFields): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const fields: (keyof IssueChangeFields)[] = ["title", "body", "state", "labels", "assignees"];

  for (const field of fields) {
    const localVal = local[field];
    const externalVal = external[field];
    if (!deepEqual(localVal, externalVal)) {
      diffs.push({ field, local: localVal, external: externalVal });
    }
  }
  return diffs;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((v, i) => v === sortedB[i]);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function safeJsonArray(val: string | null | undefined): string[] {
  if (!val) return [];
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isPrismaUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "P2002"
  );
}

function toDriftEventRow(row: {
  id: string;
  publishedIssueId: string;
  projectId: string;
  requirementId: string | null;
  source: string;
  deliveryId: string;
  action: string;
  fieldDiffs: string;
  externalSnapshot: string;
  localSnapshot: string | null;
  status: string;
  resolution: string | null;
  resolvedById: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}): DriftEventRow {
  return {
    id: row.id,
    publishedIssueId: row.publishedIssueId,
    projectId: row.projectId,
    requirementId: row.requirementId,
    source: row.source as DriftEventRow["source"],
    deliveryId: row.deliveryId,
    action: row.action as DriftEventRow["action"],
    fieldDiffs: JSON.parse(row.fieldDiffs),
    externalSnapshot: JSON.parse(row.externalSnapshot),
    localSnapshot: row.localSnapshot ? JSON.parse(row.localSnapshot) : null,
    status: row.status as DriftEventRow["status"],
    resolution: (row.resolution as DriftEventRow["resolution"]) ?? null,
    resolvedById: row.resolvedById,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
