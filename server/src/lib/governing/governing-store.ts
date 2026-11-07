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
  extractionError: true,
  droppedUnverified: true,
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
  extractionError: string | null;
  droppedUnverified: number;
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
 * The revisions a search of this workspace may return, keyed by revision id:
 * the current revision of each live document, or with `includeSuperseded`
 * every revision of each live document.
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
      revisions: { select: { id: true, revisionLabel: true } },
    },
  });
  const out = new Map<string, { documentId: string; revisionLabel: string; title: string }>();
  for (const doc of docs) {
    for (const rev of doc.revisions) {
      if (!opts.includeSuperseded && rev.id !== doc.currentRevisionId) continue;
      out.set(rev.id, { documentId: doc.id, revisionLabel: rev.revisionLabel, title: doc.title });
    }
  }
  return out;
}
// ── Rules (#1870) ──────────────────────────────────────────────────────────

/** A rule's fields as they go on the wire. */
const PUBLIC_RULE_SELECT = {
  id: true,
  revisionId: true,
  controlId: true,
  summary: true,
  clauseRef: true,
  clauseStart: true,
  clauseEnd: true,
  clauseExcerpt: true,
  category: true,
  editedById: true,
  editedAt: true,
  deletedAt: true,
  createdAt: true,
} satisfies Prisma.GoverningRuleSelect;

type RuleRow = Prisma.GoverningRuleGetPayload<{
  select: typeof PUBLIC_RULE_SELECT;
}>;

export interface PublicGoverningRule {
  id: string;
  revisionId: string;
  controlId: string;
  summary: string;
  clauseRef: string;
  clauseStart: number;
  clauseEnd: number;
  clauseExcerpt: string;
  category: string | null;
  editedById: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

function publicRule(row: RuleRow): PublicGoverningRule {
  return {
    ...row,
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A revision of a live document of this workspace (the revision has no `workspaceId` of its own). */
function liveRevisionWhere(
  workspaceId: string,
  revisionId: string,
): Prisma.GoverningDocumentRevisionWhereInput {
  return { id: revisionId, document: liveDocumentWhere(workspaceId) };
}

/**
 * Mark a revision of this workspace's live document `running` and return what
 * extraction reads. `null` when there is no such revision, or its extraction
 * is already running or done: a revision's rules are extracted once, so a
 * second run can neither duplicate them nor replace rules an admin has edited.
 */
export async function beginRuleExtraction(
  workspaceId: string,
  revisionId: string,
): Promise<{
  extractedText: string;
  revisionLabel: string;
  title: string;
} | null> {
  const where = liveRevisionWhere(workspaceId, revisionId);
  const updated = await prisma.governingDocumentRevision.updateMany({
    where: { ...where, extractionState: { in: ["pending", "failed"] } },
    data: { extractionState: "running", extractionError: null },
  });
  if (updated.count === 0) return null;
  const row = await prisma.governingDocumentRevision.findFirst({
    where,
    select: {
      extractedText: true,
      revisionLabel: true,
      document: { select: { title: true } },
    },
  });
  if (!row) return null;
  return {
    extractedText: row.extractedText,
    revisionLabel: row.revisionLabel,
    title: row.document.title,
  };
}

/** One rule to store, its citation already verified against the revision's text. */
export interface RuleInput {
  controlId: string;
  summary: string;
  clauseRef: string;
  clauseStart: number;
  clauseEnd: number;
  clauseExcerpt: string;
}

/**
 * Store a revision's extracted rules and mark it `done`, in one transaction, so
 * a reader sees either no rules and `running`, or every rule and `done`.
 */
export async function completeRuleExtraction(
  workspaceId: string,
  revisionId: string,
  rules: RuleInput[],
  droppedUnverified: number,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const revision = await tx.governingDocumentRevision.findFirst({
      where: { id: revisionId, document: { workspaceId } },
      select: { id: true },
    });
    if (!revision) return;
    if (rules.length > 0) {
      await tx.governingRule.createMany({
        data: rules.map((rule) => ({
          revisionId: revision.id,
          controlId: rule.controlId,
          summary: rule.summary,
          clauseRef: rule.clauseRef,
          clauseStart: rule.clauseStart,
          clauseEnd: rule.clauseEnd,
          clauseExcerpt: rule.clauseExcerpt,
        })),
      });
    }
    await tx.governingDocumentRevision.update({
      where: { id: revision.id },
      data: {
        extractionState: "done",
        extractionError: null,
        droppedUnverified,
      },
    });
  });
}

/** Mark a revision's extraction `failed` with the reason a reader is shown. */
export async function failRuleExtraction(
  workspaceId: string,
  revisionId: string,
  extractionError: string,
): Promise<void> {
  await prisma.governingDocumentRevision.updateMany({
    where: { id: revisionId, document: { workspaceId } },
    data: { extractionState: "failed", extractionError },
  });
}

export interface RuleListing {
  revision: Pick<
    PublicGoverningRevision,
    | "id"
    | "revisionLabel"
    | "extractionState"
    | "extractionError"
    | "droppedUnverified"
    | "isCurrent"
  >;
  rules: PublicGoverningRule[];
}

/**
 * The live rules of one revision of this workspace's live document, in clause
 * order: the current revision unless `revisionId` names another of the
 * document's own. `null` when there is no such document or revision, or the
 * document has no revision yet.
 */
export async function listRules(
  workspaceId: string,
  documentId: string,
  revisionId?: string,
): Promise<RuleListing | null> {
  const document = await prisma.governingDocument.findFirst({
    where: { id: documentId, ...liveDocumentWhere(workspaceId) },
    select: { currentRevisionId: true },
  });
  const wanted = revisionId ?? document?.currentRevisionId;
  if (!document || !wanted) return null;
  const revision = await prisma.governingDocumentRevision.findFirst({
    where: { id: wanted, documentId },
    select: {
      id: true,
      revisionLabel: true,
      extractionState: true,
      extractionError: true,
      droppedUnverified: true,
      rules: {
        where: { deletedAt: null },
        select: PUBLIC_RULE_SELECT,
        orderBy: [{ clauseStart: "asc" }, { clauseEnd: "asc" }, { id: "asc" }],
      },
    },
  });
  if (!revision) return null;
  const { rules, ...rest } = revision;
  return {
    revision: { ...rest, isCurrent: rest.id === document.currentRevisionId },
    rules: rules.map(publicRule),
  };
}

/** What an admin may change on a rule: its summary and control id, or delete it. */
export interface RulePatch {
  summary?: string;
  controlId?: string;
  deleted?: true;
}

/**
 * Edit or soft-delete a live rule of this workspace's live document, recording
 * who and when on the rule and the before and after values in a
 * `GoverningRuleEdit` row, in one transaction. A patch that changes nothing
 * writes nothing. `null` when there is no such rule.
 */
export async function editRule(
  workspaceId: string,
  ruleId: string,
  editedById: string,
  patch: RulePatch,
): Promise<{ rule: PublicGoverningRule; changed: boolean } | null> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.governingRule.findFirst({
      where: {
        id: ruleId,
        deletedAt: null,
        revision: { document: liveDocumentWhere(workspaceId) },
      },
      select: PUBLIC_RULE_SELECT,
    });
    if (!current) return null;
    const editedAt = new Date();
    let kind: "edit" | "delete";
    let before: Record<string, unknown>;
    let after: Record<string, unknown>;
    let data: Prisma.GoverningRuleUpdateInput;
    if (patch.deleted) {
      kind = "delete";
      before = { deletedAt: null };
      after = { deletedAt: editedAt.toISOString() };
      data = { deletedAt: editedAt };
    } else {
      kind = "edit";
      before = {};
      after = {};
      data = {};
      for (const field of ["summary", "controlId"] as const) {
        const next = patch[field];
        if (next === undefined || next === current[field]) continue;
        before[field] = current[field];
        after[field] = next;
        data[field] = next;
      }
      if (Object.keys(after).length === 0) return { rule: publicRule(current), changed: false };
    }
    const updated = await tx.governingRule.update({
      where: { id: current.id },
      data: { ...data, editedById, editedAt },
      select: PUBLIC_RULE_SELECT,
    });
    await tx.governingRuleEdit.create({
      data: {
        ruleId: current.id,
        kind,
        editedById,
        before: JSON.stringify(before),
        after: JSON.stringify(after),
      },
    });
    return { rule: publicRule(updated), changed: true };
  });
}
