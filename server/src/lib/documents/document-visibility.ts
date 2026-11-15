/**
 * #2546 — whether one reader may see a document by its CURRENT access list,
 * outside any analysis run: the document list, a portfolio check or an impact
 * analysis started from a document, and that check or run read back later.
 *
 * The rule is the one document search follows (`rag/acl.ts`'s `isVisibleTo`):
 * an empty list is open to every project member, an admin bypasses, and anyone
 * else must be named. The reader is resolved from durable state, and only when
 * a document is restricted, so an unrestricted project behaves as before. A
 * reader who cannot be resolved (an inactive user) sees nothing restricted;
 * any other failure rejects, and the caller must then show nothing.
 *
 * A document the reader cannot see is not named to them either: its name and
 * title are the restricted placeholder, as #2491 does for a run's document
 * coverage record. Counts (its size, its indexed sections) stay, as #2437
 * shows counts only.
 */
import { RESTRICTED_SOURCE_TITLE, type AclSubject } from "@metis/shared";
import { prisma } from "../prisma.js";
import { projectAudienceWhere } from "../auth/project-audience.js";
import {
  InactiveAclActorError,
  isVisibleTo,
  parseAclSubjects,
  resolveAclActor,
  type AclActor,
} from "../rag/acl.js";

/** A document row as far as its visibility goes: its stored access list. */
export interface AclDocument {
  aclSubjects: unknown;
}

/** Who reads: an actor, or a loader called only when an access list must be checked. */
export type DocumentReader = AclActor | (() => Promise<AclActor>);

/**
 * Whether `reader` (a user id, or an actor or its loader) may see each of
 * `docs`: a predicate over any document with an access list. The reader is
 * resolved once, and only when one of `docs` is restricted, so pass every
 * restricted document the predicate will be asked about.
 */
export async function documentVisibilityFor(
  reader: string | DocumentReader,
  docs: readonly AclDocument[],
): Promise<(doc: AclDocument) => boolean> {
  const restricted = docs.some((d) => parseAclSubjects(d.aclSubjects).length > 0);
  let actor: AclActor | null = null;
  if (restricted) {
    try {
      actor =
        typeof reader === "string"
          ? await resolveAclActor(reader)
          : typeof reader === "function"
            ? await reader()
            : reader;
    } catch (err) {
      if (!(err instanceof InactiveAclActorError)) throw err;
    }
  }
  return (doc) => {
    const subjects = parseAclSubjects(doc.aclSubjects);
    if (subjects.length === 0) return true;
    return actor !== null && isVisibleTo({ subjects }, actor);
  };
}

/** Whether `userId` may see `doc` (one document; see {@link documentVisibilityFor}). */
export async function canSeeDocument(userId: string, doc: AclDocument): Promise<boolean> {
  return (await documentVisibilityFor(userId, [doc]))(doc);
}

/** Ids per `IN (...)` list: well under SQLite's bound-parameter limit. */
const ID_BATCH = 500;

/**
 * Of `documentIds`, those `reader` may not see now: restricted from them, or
 * no longer in the database (fail closed). One read per {@link ID_BATCH} ids.
 */
export async function hiddenDocumentIds(
  reader: string | DocumentReader,
  documentIds: Iterable<string>,
): Promise<Set<string>> {
  const ids = [...new Set(documentIds)];
  if (ids.length === 0) return new Set();
  const rows: Array<{ id: string; aclSubjects: string }> = [];
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    rows.push(
      ...(await prisma.document.findMany({
        where: { id: { in: ids.slice(i, i + ID_BATCH) } },
        select: { id: true, aclSubjects: true },
      })),
    );
  }
  const sees = await documentVisibilityFor(reader, rows);
  const visible = new Set(rows.filter(sees).map((r) => r.id));
  return new Set(ids.filter((id) => !visible.has(id)));
}

/**
 * The fields of a document row a reader its access list leaves out is sent:
 * enough to keep its place in a list, tell it apart, and count it (#2437).
 * An ALLOWLIST, so a column added to `Document` later (a source URL, an
 * external title) is not sent to such a reader by default. Never `aclSubjects`:
 * who may read it is not told to someone it leaves out (#2547 sends a reader
 * of the document its subjects; a non-reader gets none of them).
 */
export const RESTRICTED_DOCUMENT_FIELDS = [
  "id",
  "projectId",
  "source",
  "status",
  "indexState",
  "isSpec",
  "sizeBytes",
  "chunkCount",
  "uploadedAt",
  "processedAt",
] as const;

type RestrictedField = (typeof RESTRICTED_DOCUMENT_FIELDS)[number];

/**
 * A document row as a reader who cannot see it is shown it: the
 * {@link RESTRICTED_DOCUMENT_FIELDS} it carries, its name the restricted
 * placeholder, no title or error text (an ingest error may quote the file),
 * and `restricted: true`. Every other field is dropped.
 */
export function restrictedDocumentRow<T extends object>(
  row: T,
): Pick<T, Extract<keyof T, RestrictedField>> & {
  filename: string;
  title: null;
  errorMessage: null;
  restricted: true;
} {
  const kept: Partial<Record<RestrictedField, unknown>> = {};
  for (const field of RESTRICTED_DOCUMENT_FIELDS) {
    if (field in row) kept[field] = (row as Record<string, unknown>)[field];
  }
  return {
    ...(kept as Pick<T, Extract<keyof T, RestrictedField>>),
    filename: RESTRICTED_SOURCE_TITLE,
    title: null,
    errorMessage: null,
    restricted: true,
  };
}

/**
 * #2547 — what a document row says about its access list, for the reader. A
 * reader (named on the list, or an admin, or anyone when the list is empty)
 * is told whether it is restricted and who it is restricted to; a reader the
 * list leaves out is told only that it is restricted, never who reads it, as
 * {@link restrictedDocumentRow} sends no `aclSubjects`. One shape: on a row a
 * reader cannot see, `access.canRead` is false and the row is `restricted`.
 */
export type DocumentAccess =
  | { restricted: boolean; canRead: true; subjects: AclSubject[]; users: AclUserName[] }
  | { restricted: true; canRead: false };

/**
 * #2555 — who a `user` subject is, as a reader of the document is told: the
 * same non-sensitive fields the people picker (`GET /api/users`) sends.
 */
export interface AclUserName {
  id: string;
  username: string;
  displayName: string;
}

/**
 * {@link DocumentAccess} for `doc`, given whether its reader may see it.
 * #2555 — `names` (from {@link aclUserNames}) names its `user` subjects to a
 * reader; a subject it does not resolve is left out of `users`, and the UI
 * says it is someone it does not know.
 */
export function documentAccessOf(
  doc: AclDocument,
  visible: boolean,
  names: ReadonlyMap<string, AclUserName> = new Map(),
): DocumentAccess {
  if (!visible) return { restricted: true, canRead: false };
  const subjects = parseAclSubjects(doc.aclSubjects);
  const users = [...new Set(subjects.filter((s) => s.kind === "user").map((s) => s.value))].flatMap(
    (id) => {
      const user = names.get(id);
      return user ? [user] : [];
    },
  );
  return { restricted: subjects.length > 0, canRead: true, subjects, users };
}

/**
 * #2555 — the people the `user` subjects of `docs` name, so a reader is told
 * "Readable by Alice Smith", not an internal id. Pass only documents the
 * reader may see: a non-reader is never told who reads one (#2546).
 *
 * Only active users who can open `projectId` are named (the audience the
 * people picker offers, `projectAudienceWhere`), so a list cannot be used to
 * look up someone outside the project by id. One query, and none when no
 * document names a user.
 */
export async function aclUserNames(
  projectId: string,
  docs: readonly AclDocument[],
): Promise<Map<string, AclUserName>> {
  const ids = [
    ...new Set(
      docs.flatMap((d) =>
        parseAclSubjects(d.aclSubjects)
          .filter((s) => s.kind === "user")
          .map((s) => s.value),
      ),
    ),
  ];
  if (ids.length === 0) return new Map();
  const audience = await projectAudienceWhere(projectId);
  if (!audience) return new Map();
  const rows: AclUserName[] = [];
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    rows.push(
      ...(await prisma.user.findMany({
        where: {
          id: { in: ids.slice(i, i + ID_BATCH) },
          status: "active",
          deletedAt: null,
          AND: [audience.where],
        },
        select: { id: true, username: true, displayName: true },
      })),
    );
  }
  return new Map(rows.map((u) => [u.id, u]));
}
