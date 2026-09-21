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
 * Visibility check. Empty ACL is unrestricted; admin bypasses; otherwise we
 * require at least one matching subject (user / role / group).
 */
export function isVisibleTo(acl: ChunkAcl, actor: AclActor): boolean {
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
