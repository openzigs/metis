/**
 * #2431 — document access restrictions for an analysis's and a Spec Kit
 * artifact's document reads.
 *
 * Both are read by the whole project: an analysis's findings, citations and
 * snippets by every member with `analysis.read`, a Spec Kit artifact by every
 * member. So they may draw only on documents every member can read — the
 * shared-audience rule #2314 chose for their code reads
 * (`loadSharedCodeAccess`), applied to document search, the quarantine
 * fallback and the default document selection. A document whose ACL names any
 * subject is left out, even when the person who started the run could read it.
 *
 * The audit rows a denied search writes name the person who started the run
 * (`triggeredBy`), so a denial stays traceable to a person and a run; that
 * attribution grants nothing (`sharedAudienceActor`). A read nobody started (a
 * scheduled run, an eval) is attributed to the system actor.
 */
import { SYSTEM_ACTOR_ID } from "../audit/system-actor.js";
import { prisma } from "../prisma.js";
import {
  isVisibleTo,
  parseAclSubjects,
  sharedAudienceActor,
  type SharedAudienceActor,
} from "../rag/acl.js";

/**
 * The ACL actor of a document search whose result the whole project reads. A
 * fresh object each call, so no caller can change another's. `triggeredBy`
 * (the run's requester) only attributes the denial audit rows: it reads
 * exactly what the system actor would.
 */
export function sharedDocumentAudience(triggeredBy?: string | null): SharedAudienceActor {
  return sharedAudienceActor(triggeredBy || SYSTEM_ACTOR_ID);
}

/** Whether a document with this stored `aclSubjects` is visible to a shared audience. */
export function isSharedVisible(aclSubjects: unknown): boolean {
  return isVisibleTo({ subjects: parseAclSubjects(aclSubjects) }, sharedDocumentAudience());
}

/**
 * The ids among `documentIds` (all in `projectId`) of documents a shared
 * audience may read, in the order given. An id that is not a live document of
 * the project is dropped too: nothing can be read from it.
 */
export async function sharedVisibleDocumentIds(
  projectId: string,
  documentIds: readonly string[],
): Promise<string[]> {
  if (documentIds.length === 0) return [];
  const rows = await prisma.document.findMany({
    where: { projectId, deletedAt: null, id: { in: [...documentIds] } },
    select: { id: true, aclSubjects: true },
  });
  const visible = new Set(rows.filter((r) => isSharedVisible(r.aclSubjects)).map((r) => r.id));
  return documentIds.filter((id) => visible.has(id));
}
