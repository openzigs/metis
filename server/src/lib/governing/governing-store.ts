/**
 * Epic #1866 (#1869) — the database side of governing documents: a workspace's
 * policies, their revisions and the access rule every reader applies.
 *
 * Scope is the workspace, and nothing here takes an id on its own. A revision
 * carries no `workspaceId`, so every by-id read and write filters on the
 * document's `workspaceId` (and on the revision's document reaching it), never
 * on the id alone: an id from another workspace reads as "not found". A soft-
 * deleted workspace (`Workspace.deletedAt`, the workspace delete route) and a
 * soft-deleted document are refused by every reader here.
 *
 * The writer owns `GoverningDocument.currentRevisionId`: a document and its first
 * revision, and every later revision, are written in one transaction with the
 * pointer, so the current revision is always one of the document's own.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";

/** Who is asking: the user id and their deployment role (`admin` reads every workspace). */
export interface GoverningActor {
  id: string;
  role: string;
}

/** A revision's fields as they go on the wire: no `storagePath`, no `extractedText`. */
const PUBLIC_REVISION_SELECT = {
  id: true,
  documentId: true,
  revisionLabel: true,
  effectiveDate: true,
  contentHash: true,
  mimeType: true,
  sizeBytes: true,
  indexState: true,
  extractionState: true,
  uploadedById: true,
  createdAt: true,
} satisfies Prisma.GoverningDocumentRevisionSelect;

type RevisionRow = Prisma.GoverningDocumentRevisionGetPayload<{
  select: typeof PUBLIC_REVISION_SELECT;
}>;

export interface PublicGoverningRevision {
  id: string;
  documentId: string;
  revisionLabel: string;
  effectiveDate: string;
  contentHash: string;
  mimeType: string;
  sizeBytes: number;
  indexState: string;
  extractionState: string;
  uploadedById: string;
  createdAt: string;
  isCurrent: boolean;
}

export interface PublicGoverningDocument {
  id: string;
  workspaceId: string;
  title: string;
  framework: string | null;
  currentRevisionId: string | null;
  createdById: string;
  createdAt: string;
  deletedAt: string | null;
}

/** One stored file, already validated, parsed and written to storage. */
export interface RevisionInput {
  revisionLabel: string;
  effectiveDate: Date;
  storagePath: string;
  contentHash: string;
  mimeType: string;
  sizeBytes: number;
  extractedText: string;
  uploadedById: string;
}

/** A document's live-row filter: in this workspace, not deleted, workspace not deleted. */
function liveDocumentWhere(workspaceId: string): Prisma.GoverningDocumentWhereInput {
  return { workspaceId, deletedAt: null, workspace: { deletedAt: null } };
}

function publicRevision(row: RevisionRow, currentRevisionId: string | null) {
  return {
    ...row,
    effectiveDate: row.effectiveDate.toISOString(),
    createdAt: row.createdAt.toISOString(),
    isCurrent: row.id === currentRevisionId,
  } satisfies PublicGoverningRevision;
}

function publicDocument(row: {
  id: string;
  workspaceId: string;
  title: string;
  framework: string | null;
  currentRevisionId: string | null;
  createdById: string;
  createdAt: Date;
  deletedAt: Date | null;
}): PublicGoverningDocument {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    framework: row.framework,
    currentRevisionId: row.currentRevisionId,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

/** True when the workspace exists and is not soft-deleted. */
export async function isWorkspaceLive(workspaceId: string): Promise<boolean> {
  const row = await prisma.workspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: { id: true },
  });
  return row !== null;
}

/**
 * True when `actor` may read the workspace's governing documents: any member of
 * a live workspace, or a deployment admin (the bypass `requireWorkspaceRole`
 * grants). A deleted workspace is readable by nobody.
 */
export async function canReadWorkspace(
  workspaceId: string,
  actor: GoverningActor,
): Promise<boolean> {
  if (actor.role === "admin") return isWorkspaceLive(workspaceId);
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId: actor.id, workspace: { deletedAt: null } },
    select: { id: true },
  });
  return membership !== null;
}

/** Create a document with its first revision, which becomes current. */
export async function createDocumentWithRevision(input: {
  workspaceId: string;
  title: string;
  framework: string | null;
  createdById: string;
  revision: RevisionInput;
}): Promise<{ documentId: string; revisionId: string }> {
  return prisma.$transaction(async (tx) => {
    const document = await tx.governingDocument.create({
      data: {
        workspaceId: input.workspaceId,
        title: input.title,
        framework: input.framework,
        createdById: input.createdById,
      },
      select: { id: true },
    });
    const revision = await tx.governingDocumentRevision.create({
      data: { ...input.revision, documentId: document.id },
      select: { id: true },
    });
    await tx.governingDocument.update({
      where: { id: document.id },
      data: { currentRevisionId: revision.id },
    });
    return { documentId: document.id, revisionId: revision.id };
  });
}

/**
 * Add a revision to a live document of this workspace and make it current. The
 * previous revision's row is left as it was. `null` when the document is not
 * this workspace's live document.
 */
export async function addRevision(
  workspaceId: string,
  documentId: string,
  revision: RevisionInput,
): Promise<{ documentId: string; revisionId: string } | null> {
  return prisma.$transaction(async (tx) => {
    const document = await tx.governingDocument.findFirst({
      where: { id: documentId, ...liveDocumentWhere(workspaceId) },
      select: { id: true },
    });
    if (!document) return null;
    const created = await tx.governingDocumentRevision.create({
      data: { ...revision, documentId: document.id },
      select: { id: true },
    });
    await tx.governingDocument.update({
      where: { id: document.id },
      data: { currentRevisionId: created.id },
    });
    return { documentId: document.id, revisionId: created.id };
  });
}

/** True when this workspace has a live document with this id. */
export async function documentExists(workspaceId: string, documentId: string): Promise<boolean> {
  const row = await prisma.governingDocument.findFirst({
    where: { id: documentId, ...liveDocumentWhere(workspaceId) },
    select: { id: true },
  });
  return row !== null;
}

/** True when this document already has a revision with this label. */
export async function revisionLabelExists(
  documentId: string,
  revisionLabel: string,
): Promise<boolean> {
  const row = await prisma.governingDocumentRevision.findFirst({
    where: { documentId, revisionLabel },
    select: { id: true },
  });
  return row !== null;
}

/** Record the outcome of embedding a revision of this workspace. */
export async function setRevisionIndexState(
  workspaceId: string,
  revisionId: string,
  indexState: "indexed" | "pending",
): Promise<void> {
  await prisma.governingDocumentRevision.updateMany({
    where: { id: revisionId, document: { workspaceId } },
    data: { indexState },
  });
}

/** The workspace's live documents, newest first, each with its current revision. */
export async function listDocuments(
  workspaceId: string,
): Promise<Array<PublicGoverningDocument & { currentRevision: PublicGoverningRevision | null }>> {
  const rows = await prisma.governingDocument.findMany({
    where: liveDocumentWhere(workspaceId),
    orderBy: { createdAt: "desc" },
    include: { currentRevision: { select: PUBLIC_REVISION_SELECT } },
  });
  return rows.map((row) => ({
    ...publicDocument(row),
    currentRevision: row.currentRevision
      ? publicRevision(row.currentRevision, row.currentRevisionId)
      : null,
  }));
}

/** One live document of this workspace with every revision, newest first; `null` if none. */
export async function getDocument(
  workspaceId: string,
  documentId: string,
): Promise<(PublicGoverningDocument & { revisions: PublicGoverningRevision[] }) | null> {
  const row = await prisma.governingDocument.findFirst({
    where: { id: documentId, ...liveDocumentWhere(workspaceId) },
    include: {
      revisions: { select: PUBLIC_REVISION_SELECT, orderBy: { createdAt: "desc" } },
    },
  });
  if (!row) return null;
  return {
    ...publicDocument(row),
    revisions: row.revisions.map((rev) => publicRevision(rev, row.currentRevisionId)),
  };
}

/** Soft-delete a live document of this workspace. False when there is none. */
export async function softDeleteDocument(
  workspaceId: string,
  documentId: string,
): Promise<boolean> {
  const result = await prisma.governingDocument.updateMany({
    where: { id: documentId, ...liveDocumentWhere(workspaceId) },
    data: { deletedAt: new Date() },
  });
  return result.count > 0;
}

/**
 * The revisions a search of this workspace may return, keyed by revision id.
 *
 * By default, one per live document: its current revision once that is
 * embedded, and until then (#1918) the newest revision that is. A new revision
 * becomes current when it is stored, before it is embedded, so without the
 * fallback a failed embed would drop the whole document out of search while its
 * previous revision's vectors are still in the table. Each hit names the
 * revision it came from, so an answer from the previous revision says so. A
 * document none of whose revisions is embedded returns nothing. With
 * `includeSuperseded`, every revision of each live document.
 */
export async function searchableRevisions(
  workspaceId: string,
  opts: { includeSuperseded?: boolean } = {},
): Promise<Map<string, { documentId: string; revisionLabel: string; title: string }>> {
  const docs = await prisma.governingDocument.findMany({
    where: liveDocumentWhere(workspaceId),
    select: {
      id: true,
      title: true,
      currentRevisionId: true,
      revisions: {
        select: { id: true, revisionLabel: true, indexState: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      },
    },
  });
  const out = new Map<string, { documentId: string; revisionLabel: string; title: string }>();
  for (const doc of docs) {
    const add = (rev: { id: string; revisionLabel: string }) =>
      out.set(rev.id, { documentId: doc.id, revisionLabel: rev.revisionLabel, title: doc.title });
    if (opts.includeSuperseded) {
      doc.revisions.forEach(add);
      continue;
    }
    const current = doc.revisions.find((rev) => rev.id === doc.currentRevisionId);
    const serving =
      current?.indexState === "indexed"
        ? current
        : doc.revisions.find((rev) => rev.indexState === "indexed");
    if (serving) add(serving);
  }
  return out;
}

/** One workspace's live revisions, as the governing reindex sweep reads them (#1918). */
export interface GoverningReindexTarget {
  workspaceId: string;
  revisions: Array<{ revisionId: string; title: string; indexState: string }>;
}

/**
 * Every revision of every live document in every live workspace, grouped by
 * workspace: what an embedding-model migration must keep searchable (#1918).
 * No text: the sweep reads it one revision at a time ({@link revisionText}).
 */
export async function listReindexTargets(): Promise<GoverningReindexTarget[]> {
  const docs = await prisma.governingDocument.findMany({
    where: { deletedAt: null, workspace: { deletedAt: null } },
    orderBy: [{ workspaceId: "asc" }, { createdAt: "asc" }],
    select: {
      workspaceId: true,
      title: true,
      revisions: { select: { id: true, indexState: true }, orderBy: { createdAt: "asc" } },
    },
  });
  const byWorkspace = new Map<string, GoverningReindexTarget>();
  for (const doc of docs) {
    const target = byWorkspace.get(doc.workspaceId) ?? {
      workspaceId: doc.workspaceId,
      revisions: [],
    };
    for (const rev of doc.revisions) {
      target.revisions.push({ revisionId: rev.id, title: doc.title, indexState: rev.indexState });
    }
    byWorkspace.set(doc.workspaceId, target);
  }
  return [...byWorkspace.values()];
}

/** A revision's parsed text, when it belongs to this workspace; `null` otherwise. */
export async function revisionText(
  workspaceId: string,
  revisionId: string,
): Promise<string | null> {
  const row = await prisma.governingDocumentRevision.findFirst({
    where: { id: revisionId, document: { workspaceId } },
    select: { extractedText: true },
  });
  return row?.extractedText ?? null;
}
