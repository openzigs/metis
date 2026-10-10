/**
 * Epic #609 (#619) — publish/export approval gate (`requireApprovedReview`).
 *
 * When a project enables `Project.requireApprovedReview`, every flow that
 * publishes an IssueDraft or exports a requirement / generated document must
 * first pass through one of the assertions below. An artifact passes only if
 * an APPROVED `ReviewRequest` (#616/#617) contains a `ReviewRequestItem`
 * pinned to the artifact's CURRENT version:
 *
 *   - Requirement: `pinnedVersion === Requirement.version`
 *   - GeneratedDocument: `pinnedVersion === latest GeneratedDocumentVersion`
 *     (0 when no version rows exist — mirrors `resolveCurrentPins` in
 *     review-service.ts)
 *
 * A stale approval (content changed after sign-off, so the pin no longer
 * matches) does NOT satisfy the gate.
 *
 * Security invariants — the gate FAILS CLOSED:
 *   - Only an explicit `requireApprovedReview === false` disables the gate;
 *     any other value (true, null, undefined, corrupt) enforces it.
 *   - A missing project blocks (404); any error thrown while checking
 *     (DB down, review lookup failure) blocks with 503
 *     `APPROVAL_GATE_UNAVAILABLE` — never allows.
 *   - Drafts with no traceable requirement (FK `SetNull` after requirement
 *     deletion, or drafts that never had one) are blocked while the gate is
 *     on: an unverifiable artifact is treated as unapproved.
 *   - Approvals only count within the SAME project (no cross-project
 *     satisfaction).
 *
 * Blocked decisions are audited (`review.gate.blocked`) via the standard
 * fire-and-forget audit queue, consistent with publishing-service.
 */
import { AppError } from "../../middleware/error-handler.js";
import { audit } from "../audit/audit-service.js";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import type { ApprovalGateCheckResult } from "@metis/shared";

export const APPROVAL_REQUIRED = "APPROVAL_REQUIRED";
export const APPROVAL_GATE_UNAVAILABLE = "APPROVAL_GATE_UNAVAILABLE";

const log = createChildLogger("reviews:approval-gate");

/** Minimal draft shape the gate needs (subset of IssueDraft). */
export interface GateDraft {
  id: string;
  requirementId: string | null;
  metadata?: string | null;
}

interface GateContext {
  /** Calling flow, recorded in audit + error details (e.g. `publish.batch.create`). */
  context: string;
  actorId?: string;
}

/**
 * Union of every requirement id a draft traces to: the FK plus the metadata
 * conventions used by the draft generators (`requirementId` on feature
 * drafts, `requirementIds` on epic drafts, `mappedRequirementIds` on legacy
 * test-coverage export drafts — the exporter is gone (#819), but drafts it
 * wrote can still be published). Malformed metadata contributes nothing — the draft
 * then counts as unlinked and is blocked while the gate is on.
 */
export function collectDraftRequirementIds(draft: GateDraft): string[] {
  const ids = new Set<string>();
  if (draft.requirementId) ids.add(draft.requirementId);
  if (draft.metadata) {
    try {
      const meta = JSON.parse(draft.metadata) as Record<string, unknown>;
      if (typeof meta.requirementId === "string" && meta.requirementId) {
        ids.add(meta.requirementId);
      }
      for (const key of ["requirementIds", "mappedRequirementIds"] as const) {
        const list = meta[key];
        if (Array.isArray(list)) {
          for (const id of list) if (typeof id === "string" && id) ids.add(id);
        }
      }
    } catch {
      /* malformed metadata → no additional refs (draft may be unlinked) */
    }
  }
  return [...ids];
}

/**
 * Fail-closed flag read. Returns `false` (gate off) only when the project
 * exists and the flag is EXPLICITLY `false`. A missing project throws 404.
 */
async function isGateEnforced(projectId: string): Promise<boolean> {
  const project = (await prisma.project.findUnique({
    where: { id: projectId },
    select: { requireApprovedReview: true },
  })) as { requireApprovedReview: boolean | null } | null;
  if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
  return project.requireApprovedReview !== false;
}

/**
 * Returns the subset of `requirementIds` that do NOT have an approved,
 * still-current review in this project. Ids that fail to resolve to a live
 * requirement in the project count as unapproved (fail closed).
 */
async function findUnapprovedRequirementIds(
  projectId: string,
  requirementIds: string[],
): Promise<string[]> {
  if (requirementIds.length === 0) return [];
  const rows = (await prisma.requirement.findMany({
    where: { id: { in: requirementIds }, projectId, deletedAt: null },
    select: { id: true, version: true },
  })) as { id: string; version: number }[];
  const currentVersion = new Map(rows.map((r) => [r.id, r.version]));

  const items = (await prisma.reviewRequestItem.findMany({
    where: {
      requirementId: { in: requirementIds },
      reviewRequest: { status: "approved", projectId },
    },
    select: { requirementId: true, pinnedVersion: true },
  })) as { requirementId: string | null; pinnedVersion: number }[];

  const approvedCurrent = new Set<string>();
  for (const item of items) {
    if (!item.requirementId) continue;
    const current = currentVersion.get(item.requirementId);
    // Staleness check: the approval must pin the requirement's CURRENT
    // version. `current === undefined` (unresolvable id) never matches.
    if (current !== undefined && item.pinnedVersion === current) {
      approvedCurrent.add(item.requirementId);
    }
  }
  return requirementIds.filter((id) => !approvedCurrent.has(id));
}

/** True when the document has an approved review pinned to its latest version. */
async function isDocumentApprovedCurrent(projectId: string, documentId: string): Promise<boolean> {
  const doc = await prisma.generatedDocument.findFirst({
    where: { id: documentId, projectId, deletedAt: null },
    select: { id: true },
  });
  if (!doc) return false; // unresolvable → unapproved (fail closed)
  const latest = (await prisma.generatedDocumentVersion.findFirst({
    where: { documentId },
    orderBy: { version: "desc" },
    select: { version: true },
  })) as { version: number } | null;
  const current = latest?.version ?? 0;
  const items = (await prisma.reviewRequestItem.findMany({
    where: {
      generatedDocumentId: documentId,
      reviewRequest: { status: "approved", projectId },
    },
    select: { pinnedVersion: true },
  })) as { pinnedVersion: number }[];
  return items.some((i) => i.pinnedVersion === current);
}

interface BlockDetails {
  requirementIds?: string[];
  documentIds?: string[];
  unlinkedDraftIds?: string[];
}

function blocked(projectId: string, gate: GateContext, details: BlockDetails): AppError {
  audit({
    actor: { id: gate.actorId ?? "system" },
    action: "review.gate.blocked",
    target: { type: "project", id: projectId },
    metadata: { context: gate.context, ...details },
  });
  return new AppError(
    409,
    APPROVAL_REQUIRED,
    "Blocked by the approval gate: this project requires an approved, up-to-date review before publishing or exporting. Submit the listed items for review (or re-approve them if content changed) and try again.",
    { context: gate.context, ...details },
  );
}

/**
 * Runs `fn` with fail-closed semantics: our own structured AppErrors pass
 * through; ANY other error becomes a 503 that blocks the operation.
 */
async function failClosed(
  gate: GateContext,
  projectId: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    audit({
      actor: { id: gate.actorId ?? "system" },
      action: "review.gate.error",
      target: { type: "project", id: projectId },
      metadata: { context: gate.context, error: err instanceof Error ? err.message : String(err) },
    });
    throw new AppError(
      503,
      APPROVAL_GATE_UNAVAILABLE,
      "The approval gate could not be verified; the operation was blocked (fail-closed). Retry later or contact an administrator.",
      { context: gate.context },
    );
  }
}

/**
 * Gate for every IssueDraft publishing flow (single approve, batch create,
 * batch execute, scheduler republish). Throws 409 `APPROVAL_REQUIRED` when
 * any draft traces to a requirement without an approved current review, or
 * traces to no requirement at all; throws 503 on any check failure.
 */
export async function assertDraftsPublishable(
  opts: {
    projectId: string;
    /**
     * Drafts to check, or a lazy loader invoked only when the gate is
     * enforced (spares the extra query when the flag is off). A loader
     * failure blocks the publish (fail-closed).
     */
    drafts: GateDraft[] | (() => Promise<GateDraft[]>);
  } & GateContext,
): Promise<void> {
  await failClosed(opts, opts.projectId, async () => {
    if (!(await isGateEnforced(opts.projectId))) return;

    const drafts = typeof opts.drafts === "function" ? await opts.drafts() : opts.drafts;
    const { unapproved, unlinkedDraftIds } = await evaluateDrafts(opts.projectId, drafts);
    if (unapproved.length > 0 || unlinkedDraftIds.length > 0) {
      throw blocked(opts.projectId, opts, {
        ...(unapproved.length > 0 ? { requirementIds: unapproved } : {}),
        ...(unlinkedDraftIds.length > 0 ? { unlinkedDraftIds } : {}),
      });
    }
  });
}

/**
 * The gate's decision on a set of drafts (gate assumed on): the requirement
 * ids without an approved current review, the drafts tracing to no
 * requirement, and every draft that one of those two reasons blocks.
 */
async function evaluateDrafts(
  projectId: string,
  drafts: GateDraft[],
): Promise<{ unapproved: string[]; unlinkedDraftIds: string[]; blockedDraftIds: string[] }> {
  const unlinkedDraftIds: string[] = [];
  const idsByDraft = new Map<string, string[]>();
  const requirementIds = new Set<string>();
  for (const draft of drafts) {
    const ids = collectDraftRequirementIds(draft);
    idsByDraft.set(draft.id, ids);
    if (ids.length === 0) unlinkedDraftIds.push(draft.id);
    for (const id of ids) requirementIds.add(id);
  }
  const unapproved = await findUnapprovedRequirementIds(projectId, [...requirementIds]);
  const unapprovedSet = new Set(unapproved);
  const blockedDraftIds = drafts
    .filter((d) => {
      const ids = idsByDraft.get(d.id) ?? [];
      return ids.length === 0 || ids.some((id) => unapprovedSet.has(id));
    })
    .map((d) => d.id);
  return { unapproved, unlinkedDraftIds, blockedDraftIds };
}

/** #744 — what {@link previewDraftsGate} predicts for a live publish. */
export interface DraftsGatePreview {
  check: ApprovalGateCheckResult;
  blockedDraftIds: string[];
}

/**
 * #744 — the gate's verdict for a dry run, WITHOUT throwing or auditing a
 * block: a preview is how a user discovers what still needs review, so it
 * reports what `assertDraftsPublishable` would decide for the same drafts.
 *
 * Mirrors the live gate's fail-closed rule: when the check itself fails (DB
 * down, project missing) the verdict is `unavailable`, because the live run
 * would be refused too — never `off` or `passed`.
 */
export async function previewDraftsGate(
  projectId: string,
  drafts: GateDraft[],
): Promise<DraftsGatePreview> {
  try {
    if (!(await isGateEnforced(projectId))) return { check: "off", blockedDraftIds: [] };
    const { blockedDraftIds } = await evaluateDrafts(projectId, drafts);
    return { check: blockedDraftIds.length > 0 ? "blocked" : "passed", blockedDraftIds };
  } catch (err) {
    log.warn("review.gate.preview_unavailable", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { check: "unavailable", blockedDraftIds: [] };
  }
}

/**
 * Gate for requirement export surfaces (e.g. the version-history CSV/JSON
 * export). Same flag, same approved-current rule.
 */
export async function assertRequirementsExportable(
  opts: { projectId: string; requirementIds: string[] } & GateContext,
): Promise<void> {
  await failClosed(opts, opts.projectId, async () => {
    if (!(await isGateEnforced(opts.projectId))) return;
    const unapproved = await findUnapprovedRequirementIds(opts.projectId, [
      ...new Set(opts.requirementIds),
    ]);
    if (unapproved.length > 0) {
      throw blocked(opts.projectId, opts, { requirementIds: unapproved });
    }
  });
}

/**
 * Gate for GeneratedDocument (spec) export. Same flag; the document must
 * have an approved review pinned to its latest generated version.
 */
export async function assertDocumentExportable(
  opts: { projectId: string; documentId: string } & GateContext,
): Promise<void> {
  await failClosed(opts, opts.projectId, async () => {
    if (!(await isGateEnforced(opts.projectId))) return;
    if (!(await isDocumentApprovedCurrent(opts.projectId, opts.documentId))) {
      throw blocked(opts.projectId, opts, { documentIds: [opts.documentId] });
    }
  });
}
