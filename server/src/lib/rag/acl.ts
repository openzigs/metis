/**
 * Epic #157 — Permission-aware RAG (issue #151).
 *
 * Owns the small ACL primitives shared by the ingest pipeline + retrieval
 * filter:
 *   - `parseAclSubjects` — decode the JSON `aclSubjects` column safely.
 *   - `serializeAclSubjects` — encode for storage with validation.
 *   - `isVisibleTo` — authoritative visibility check given a `ChunkAcl`.
 *   - `propagateAcl` — copy a document's ACL onto every live chunk.
 *
 * Storage representation:
 *   - SQLite: `aclSubjects` is a TEXT column holding a JSON array.
 *   - Postgres: a `Json` column. Prisma reads it as a parsed value already.
 *   - We normalize everything to a string array on the way in/out so
 *     downstream code never has to branch on the dialect.
 *
 * Visibility rule:
 *   - Empty ACL list  ⇒ visible to every project member (most chunks).
 *   - Non-empty list  ⇒ visible only when the actor matches at least one
 *                       subject. Matching is exact:
 *                         { kind: "user",  value: actor.userId } ✅
 *                         { kind: "role",  value: actor.role   } ✅
 *                         { kind: "group", value: g } when g ∈ actor.groups ✅
 *   - The `admin` role bypasses ACLs entirely (audit-logged at the call site).
 *   - A shared-audience actor (#2248) sees unrestricted chunks only: no subject
 *     matches it and it has no bypass.
 *
 * Performance:
 *   - The filter runs over the candidate pool returned by the dense / hybrid
 *   retriever. Pool sizes top out around 200 so the per-chunk cost is a
 *   handful of map lookups. We deliberately avoid pushing ACL filtering down
 *   into the vector store to keep the dialect contract simple.
 */
import { aclSubjectSchema, type AclSubject } from "@metis/shared";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { resolveDurableRole } from "../auth/durable-roles.js";
import { AppError } from "../../middleware/error-handler.js";

const log = createChildLogger("rag-acl");

export interface ChunkAcl {
  /** Empty array == unrestricted. */
  subjects: AclSubject[];
}

export interface AclActor {
  userId: string;
  role: string;
  /** Optional group membership (Phase 11 user-mgmt or future SSO). */
  groups?: string[];
  /**
   * #2248 — set by {@link sharedAudienceActor} only: the retrieval is for an
   * audience, not one person, so it sees unrestricted chunks and nothing else.
   */
  sharedAudience?: true;
}

/** An actor built by {@link sharedAudienceActor}; nothing else carries the flag. */
export type SharedAudienceActor = AclActor & { sharedAudience: true };

/** The `role` a shared-audience actor reports in the ACL-denial audit row. */
export const SHARED_AUDIENCE_ROLE = "shared-audience";

/**
 * #2248 — the ACL actor for a reply the whole audience of a shared surface
 * reads: a discussion thread (any project member may open it) or a Teams
 * channel (whose membership METIS does not hold). Such a reply is grounded only
 * on unrestricted chunks, so a chunk restricted to the member who triggered it
 * never reaches the others. `triggeredBy` attributes the audit row; it grants
 * nothing — no user, role or group subject matches, and there is no admin
 * bypass.
 */
export function sharedAudienceActor(triggeredBy: string): SharedAudienceActor {
  return { userId: triggeredBy, role: SHARED_AUDIENCE_ROLE, sharedAudience: true };
}

/** #2248 — the user an ACL actor was asked for is soft-deleted, not active, or absent. */
export class InactiveAclActorError extends Error {
  constructor() {
    super("ACL actor unavailable: the user is not active");
    this.name = "InactiveAclActorError";
  }
}

/**
 * #2261 — the HTTP form of {@link InactiveAclActorError} for a route whose
 * caller IS the actor: their token outlived their account, so it is a 401
 * `TOKEN_INVALID`, as `refreshAuthenticatedUser` answers, not a 500. Any other
 * error is returned unchanged. Use as `.catch((err) => { throw ... })`.
 */
export function inactiveCallerAsUnauthenticated(err: unknown): unknown {
  if (!(err instanceof InactiveAclActorError)) return err;
  return new AppError(401, "TOKEN_INVALID", "Access token is malformed or invalid");
}

/**
 * #2261 — the `group` subjects in `next` that `current` does not already hold.
 * METIS stores no group membership (IdP group claims are read at login, never
 * persisted), so a group subject matches no one; `PATCH /documents/:id/acl`
 * rejects a new one. One a document already carries may stay, so the ACL
 * editor can still save the document's other subjects.
 */
export function newGroupSubjects(current: AclSubject[], next: AclSubject[]): string[] {
  const held = new Set(current.filter((s) => s.kind === "group").map((s) => s.value));
  return next.filter((s) => s.kind === "group" && !held.has(s.value)).map((s) => s.value);
}

/**
 * #2225 — the ACL actor for a retrieval a user started, for a caller that holds
 * only the requester's id: chat auto-RAG, the chat `search-knowledge` tool,
 * `POST /api/projects/:id/retrieve`, federated search. The role is read from
 * durable state, not from the token's claim (`requireAuth` only verifies the
 * JWT).
 *
 * #2248 — the user must still be live (`status: "active"`, not soft-deleted),
 * as `loadLiveAuthPayload` requires: `resolveDurableRole` ignores
 * deprovisioning, so a SCIM-deleted admin would otherwise keep the ACL bypass
 * until their token expired. An inactive user rejects with
 * {@link InactiveAclActorError} — no bypass and no access. Any rejection means
 * the caller must fail closed (retrieve nothing), never search without an actor.
 */
export async function resolveAclActor(userId: string): Promise<AclActor> {
  const [live, role] = await Promise.all([
    prisma.user.findFirst({
      where: { id: userId, status: "active", deletedAt: null },
      select: { id: true },
    }),
    resolveDurableRole(userId),
  ]);
  if (!live) throw new InactiveAclActorError();
  return { userId, role };
}

/** Parse a JSON-encoded ACL string from Prisma into a normalized list. */
export function parseAclSubjects(raw: unknown): AclSubject[] {
  if (raw == null) return [];
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (raw.trim().length === 0) return [];
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: AclSubject[] = [];
  for (const entry of parsed) {
    const ok = aclSubjectSchema.safeParse(entry);
    if (ok.success) out.push(ok.data);
  }
  return out;
}

/** Encode an ACL list for the database. Throws on invalid input. */
export function serializeAclSubjects(subjects: AclSubject[]): string {
  for (const s of subjects) aclSubjectSchema.parse(s);
  return JSON.stringify(subjects);
}

/**
 * Visibility check. Empty ACL is unrestricted; a shared audience sees nothing
 * else; admin bypasses; otherwise we require at least one matching subject
 * (user / role / group).
 */
export function isVisibleTo(acl: ChunkAcl, actor: AclActor): boolean {
  if (actor.sharedAudience) return acl.subjects.length === 0;
  if (actor.role === "admin") return true;
  if (acl.subjects.length === 0) return true;
  for (const subj of acl.subjects) {
    if (subj.kind === "user" && subj.value === actor.userId) return true;
    if (subj.kind === "role" && subj.value === actor.role) return true;
    if (subj.kind === "group") {
      const groups = actor.groups ?? [];
      if (groups.includes(subj.value)) return true;
    }
  }
  return false;
}

/**
 * Filter a candidate list down to chunks the actor can see. Returns both the
 * surviving rows and the rejected chunk ids so the caller can log an audit
 * event with the precise denial set.
 */
export function filterAccessible<T extends { chunkId: string; aclSubjects?: AclSubject[] }>(
  chunks: T[],
  actor: AclActor,
): { allowed: T[]; deniedChunkIds: string[] } {
  const allowed: T[] = [];
  const deniedChunkIds: string[] = [];
  for (const c of chunks) {
    const acl: ChunkAcl = { subjects: c.aclSubjects ?? [] };
    if (isVisibleTo(acl, actor)) allowed.push(c);
    else deniedChunkIds.push(c.chunkId);
  }
  return { allowed, deniedChunkIds };
}

/**
 * Propagate a document's ACL list to every live chunk. Used by the re-permission
 * route (`PATCH /api/documents/:id/acl`) and re-ingestion. Returns the count of
 * affected chunk rows for audit logging.
 */
export async function propagateAcl(documentId: string, aclSubjects: AclSubject[]): Promise<number> {
  const serialized = serializeAclSubjects(aclSubjects);
  await prisma.document.update({
    where: { id: documentId },
    data: { aclSubjects: serialized },
  });
  const updated = await prisma.knowledgeChunk.updateMany({
    where: { documentId },
    data: { aclSubjects: serialized },
  });
  log.info("propagated document acl", {
    documentId,
    chunkCount: updated.count,
    subjectCount: aclSubjects.length,
  });
  return updated.count;
}
