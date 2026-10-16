/**
 * Issue #1220 — the analyst's answer to an imported requirement that is
 * "diverged from source": both the source issue and the local copy changed
 * since the last sync, so re-sync kept the local copy and recorded the source's
 * newer content (`Requirement.sourcePending`) instead of overwriting.
 *
 *  - **Take the source version** writes the recorded source content through
 *    {@link updateRequirementWithHistory} with the analyst as actor: a version
 *    row in History, a version bump — and, because the content changed, a
 *    review pinned to the old version is stale, as it should be.
 *  - **Keep mine** changes no content, so it writes no version row and does
 *    not bump `version`: an approved review of the analyst's text stays
 *    current. The decision is recorded on the row instead — `sourceDecision`
 *    (shown in History), `sourceDecisionActorId` (the analyst) and
 *    `sourceDecidedAt` — and in the audit log. `sourceDecisionActorId` is what
 *    the #769 replacement guard (`reviewedRequirementWhere`) reads as a
 *    person's review work, so a re-synthesis will not replace the set.
 *
 * Either way the source content answered becomes the row's last-synced source
 * (`sourceFingerprint`), so the next re-sync of an unchanged source keeps the
 * analyst's text rather than flagging it again. The import's own automatic
 * writes never set an actor.
 */
import type { PrismaClient } from "@prisma/client";
import {
  updateRequirementWithHistory,
  type VersionPrismaClient,
} from "./requirement-version-service.js";
import {
  parseSourcePending,
  type SourceDecision,
  type SourcePending,
} from "../importers/source-sync.js";

/** The reason on the version row "Take the source version" appends. */
export const SOURCE_TAKEN_VERSION_REASON = "Took the source version over local edits";

export type SourceDivergenceChoice = "source" | "local";

export class SourceDivergenceError extends Error {
  /**
   * `NOT_DIVERGED` — nothing to resolve (already resolved, or never diverged).
   * `SOURCE_MOVED` — the source changed again since the analyst looked; the
   * choice was made against content that is no longer the source's.
   */
  readonly code: "NOT_FOUND" | "NOT_DIVERGED" | "SOURCE_MOVED";
  constructor(code: SourceDivergenceError["code"], message: string) {
    super(message);
    this.name = "SourceDivergenceError";
    this.code = code;
  }
}

export interface ResolveSourceDivergenceParams {
  requirementId: string;
  choice: SourceDivergenceChoice;
  /** Fingerprint of the source content the analyst saw and answered. */
  sourceFingerprint: string;
  actorId: string;
  /** Tenant narrowing, as for every requirement write (#1118). */
  projectId?: string;
  /** "Take the source version" only: the version the analyst's view was of. */
  expectedVersion?: number;
  now?: Date;
}

export interface ResolveSourceDivergenceResult {
  id: string;
  choice: SourceDivergenceChoice;
  version: number;
  /** True when the requirement's content changed (a History version row). */
  changed: boolean;
}

type ResolverClient = Pick<PrismaClient, "requirement">;

function sourceMoved(): SourceDivergenceError {
  return new SourceDivergenceError(
    "SOURCE_MOVED",
    "The source changed again since this was loaded — reload to compare",
  );
}

export async function resolveSourceDivergence(
  client: PrismaClient,
  params: ResolveSourceDivergenceParams,
): Promise<ResolveSourceDivergenceResult> {
  const db = client as unknown as ResolverClient;
  const row = await db.requirement.findFirst({
    where: {
      id: params.requirementId,
      deletedAt: null,
      ...(params.projectId ? { projectId: params.projectId } : {}),
    },
    select: { id: true, version: true, sourcePending: true },
  });
  if (!row) throw new SourceDivergenceError("NOT_FOUND", "Requirement not found");

  const pending: SourcePending | null = parseSourcePending(row.sourcePending);
  if (!pending) {
    throw new SourceDivergenceError(
      "NOT_DIVERGED",
      "This requirement is not diverged from its source",
    );
  }
  if (pending.fingerprint !== params.sourceFingerprint) throw sourceMoved();

  const at = params.now ?? new Date();
  const decision: SourceDecision = {
    choice: params.choice,
    fingerprint: pending.fingerprint,
    actorId: params.actorId,
    at: at.toISOString(),
  };
  // Untracked columns only: never `version`. Conditional on the divergence
  // read above, so a re-sync that recorded a newer source in between keeps its
  // record (the row is still diverged from THAT).
  const settle = () =>
    db.requirement.updateMany({
      where: { id: params.requirementId, deletedAt: null, sourcePending: row.sourcePending },
      data: {
        sourceFingerprint: pending.fingerprint,
        sourcePending: null,
        sourceDecision: JSON.stringify(decision),
        sourceDecisionActorId: params.actorId,
        sourceDecidedAt: at,
      },
    });

  if (params.choice === "local") {
    if ((await settle()).count !== 1) throw sourceMoved();
    return { id: params.requirementId, choice: "local", version: row.version, changed: false };
  }

  const result = await updateRequirementWithHistory(client as unknown as VersionPrismaClient, {
    requirementId: params.requirementId,
    patch: {
      title: pending.title,
      body: pending.body,
      type: pending.type,
      priority: pending.priority,
      labels: JSON.stringify(pending.labels),
    },
    // The source never carries METIS's hidden traceability labels; keep them.
    keepHiddenLabels: true,
    actorId: params.actorId,
    reason: SOURCE_TAKEN_VERSION_REASON,
    projectId: params.projectId,
    expectedVersion: params.expectedVersion,
  });
  // The content is written; a newer source recorded meanwhile stays as the
  // divergence to answer next.
  await settle();
  return {
    id: params.requirementId,
    choice: "source",
    version: result.version,
    changed: result.changed,
  };
}
