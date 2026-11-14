/**
 * #2447 (epic #2438) — redact on read: the one filter every surface that shows
 * analysis output applies before a finding, citation, requirement or
 * cross-document finding leaves the server.
 *
 * #2446 records, on each row, the `Document` and `KnowledgeChunk` ids its
 * citations name (`sourceIds`, `source-ids.ts`). Here a reader is checked
 * against the CURRENT access list of each of those documents (`rag/acl.ts`'s
 * {@link isVisibleTo}, the rule document search follows): a row resting on one
 * the reader cannot see is redacted, shown as a "restricted" placeholder in its
 * place. A row is never dropped from a result, and a result is never hidden
 * whole. This is the pattern of the notification access re-check (#1447).
 *
 * How a row reads (`Analysis.sourceAccess` is the run's marker):
 *   - a run with no marker (before #2446) keeps the shared-audience rule
 *     (#2314): its rows carry no sources and are shown to every reader;
 *   - a row with a list (even an empty one): shown when the reader can see
 *     every document it names; a document that is not in the run's project, or
 *     that cannot be read at all, counts as one they cannot see;
 *   - a row with no list (NULL, or a value that does not parse): it rests on
 *     the run as a whole, so it is shown only to a reader who can see
 *     everything the run could (fail closed). A `shared` run read as the
 *     shared audience (#2248), which sees no restricted document; every member
 *     sees at least that, so the row is shown. A run under any other marker
 *     (#2448 adds the starter's access) is shown only to an admin, whom no
 *     access list restricts, until that marker says what the run could read.
 *
 * Chunk ids are not checked separately: a chunk's access list is written with
 * its document's, in one transaction (`saveDocumentAcl`), and a cited chunk's
 * document is always among the row's document ids.
 *
 * Cost: one query for the runs' markers, one for the cited documents' access
 * lists (none when no run carries a marker), and the reader's role only when a
 * cited document is restricted or a row rests on a non-shared run. The reader
 * is never resolved for an unrestricted project, so it behaves as before.
 */
import {
  RESTRICTED_SOURCE_BODY,
  RESTRICTED_SOURCE_TITLE,
  type AclSubject,
  type AnalysisSnapshot,
  type CrossDocFinding,
} from "@metis/shared";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import {
  InactiveAclActorError,
  isVisibleTo,
  parseAclSubjects,
  resolveAclActor,
  sharedAudienceActor,
  type AclActor,
} from "../rag/acl.js";
import { SYSTEM_ACTOR_ID } from "../audit/system-actor.js";
import { parseSourceIds, SOURCE_ACCESS_SHARED } from "./source-ids.js";

/** A row the filter decides on: the run it belongs to and its stored sources. */
export interface SourceGuardedRow {
  analysisId: string;
  sourceIds: string | null;
}

/** Who reads: an actor, or a loader called only when an access list must be checked. */
export type SourceReader = AclActor | (() => Promise<AclActor>);

/** The reader `userId`, resolved from durable state only when it is needed. */
export function userSourceReader(userId: string): SourceReader {
  return () => resolveAclActor(userId);
}

/**
 * The reader of output a whole project reads (a Spec Kit artifact, a
 * discussion reply): the shared audience (#2248), which sees no restricted
 * document. The same audience `loadSharedCodeAccess` reads code as (#2314).
 */
export function sharedSourceReader(triggeredBy: string = SYSTEM_ACTOR_ID): SourceReader {
  return sharedAudienceActor(triggeredBy);
}

export interface SourceGuard {
  /** Whether the reader may see `row`. */
  canSee(row: SourceGuardedRow): boolean;
  /**
   * Whether the reader may see what rests on run `analysisId` as a whole: a
   * row with no record of its own, or the run's narrative (an agent's summary).
   */
  canSeeRun(analysisId: string): boolean;
}

/** The guard for a reader nothing is redacted from (no row to decide on). */
export const OPEN_SOURCE_GUARD: SourceGuard = { canSee: () => true, canSeeRun: () => true };

interface GuardRun {
  projectId: string;
  sourceAccess: string | null;
}

interface GuardDocument {
  projectId: string;
  subjects: AclSubject[];
}

/**
 * The decision, given what was read: the runs' markers, the cited documents'
 * access lists, and the reader (`null` when they could not be resolved, e.g. an
 * inactive user: then nothing restricted is shown). Pure, so every branch is
 * unit-tested without a database.
 */
export function sourceGuardOf(input: {
  runs: ReadonlyMap<string, GuardRun>;
  documents: ReadonlyMap<string, GuardDocument>;
  actor: AclActor | null;
}): SourceGuard {
  const { runs, documents, actor } = input;
  const isAdmin = actor !== null && !actor.sharedAudience && actor.role === "admin";
  const seesRun = (run: GuardRun | undefined): boolean => {
    if (!run) return false;
    if (run.sourceAccess === null) return true;
    if (run.sourceAccess === SOURCE_ACCESS_SHARED) return true;
    return isAdmin;
  };
  const seesDocument = (run: GuardRun, documentId: string): boolean => {
    const doc = documents.get(documentId);
    if (!doc || doc.projectId !== run.projectId) return false;
    if (doc.subjects.length === 0) return true;
    return actor !== null && isVisibleTo({ subjects: doc.subjects }, actor);
  };
  return {
    canSeeRun: (analysisId) => seesRun(runs.get(analysisId)),
    canSee: (row) => {
      const run = runs.get(row.analysisId);
      if (!run) return false;
      if (run.sourceAccess === null) return true;
      const sources = parseSourceIds(row.sourceIds);
      if (!sources) return seesRun(run);
      return sources.documentIds.every((id) => seesDocument(run, id));
    },
  };
}

type GuardDb = Pick<PrismaClient, "analysis" | "document">;

/** Ids per `IN (...)` list: well under SQLite's bound-parameter limit. */
const ID_BATCH = 500;

function batches<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += ID_BATCH) out.push(items.slice(i, i + ID_BATCH));
  return out;
}

/**
 * Load the guard for `reader` over `rows` (every row the caller will show). A
 * reader that cannot be resolved (an inactive user) sees nothing restricted;
 * any other failure rejects, and the caller must then show nothing.
 */
export async function loadSourceGuard(
  reader: SourceReader,
  rows: readonly SourceGuardedRow[],
  db: GuardDb = defaultPrisma as unknown as GuardDb,
): Promise<SourceGuard> {
  const analysisIds = [...new Set(rows.map((r) => r.analysisId))];
  if (analysisIds.length === 0) return OPEN_SOURCE_GUARD;
  const runRows = await db.analysis.findMany({
    where: { id: { in: analysisIds } },
    select: { id: true, projectId: true, sourceAccess: true },
  });
  const runs = new Map(runRows.map((r) => [r.id, r]));

  let needsActor = false;
  const documentIds = new Set<string>();
  for (const row of rows) {
    const run = runs.get(row.analysisId);
    if (!run || run.sourceAccess === null) continue;
    const sources = parseSourceIds(row.sourceIds);
    if (sources) for (const id of sources.documentIds) documentIds.add(id);
    else if (run.sourceAccess !== SOURCE_ACCESS_SHARED) needsActor = true;
  }

  const documents = new Map<string, GuardDocument>();
  for (const ids of batches([...documentIds])) {
    const docs = await db.document.findMany({
      where: { id: { in: ids } },
      select: { id: true, projectId: true, aclSubjects: true },
    });
    for (const d of docs) {
      const subjects = parseAclSubjects(d.aclSubjects);
      documents.set(d.id, { projectId: d.projectId, subjects });
      if (subjects.length > 0) needsActor = true;
    }
  }

  let actor: AclActor | null = null;
  if (needsActor) {
    try {
      actor = typeof reader === "function" ? await reader() : reader;
    } catch (err) {
      if (!(err instanceof InactiveAclActorError)) throw err;
    }
  }
  return sourceGuardOf({ runs, documents, actor });
}

// ── The placeholders ──────────────────────────────────────────────────────

type SnapshotAgent = AnalysisSnapshot["agents"][number];
type SnapshotFinding = SnapshotAgent["findings"][number];
type SnapshotRequirement = AnalysisSnapshot["requirements"][number];

/**
 * A finding as the restricted placeholder: its id, category, severity and
 * provenance stay (so counts and links still add up); its title, body, tags,
 * citations and every verdict drawn from them go.
 */
export function restrictedFinding(f: SnapshotFinding): SnapshotFinding {
  return {
    id: f.id,
    category: f.category,
    severity: f.severity,
    title: RESTRICTED_SOURCE_TITLE,
    body: RESTRICTED_SOURCE_BODY,
    tags: [],
    citations: [],
    derivation: f.derivation,
    confidence: f.confidence,
    agentResultId: f.agentResultId,
    requirementId: null,
    verificationStatus: null,
    verdict: null,
    supportPanel: null,
    faithfulness: null,
    restricted: true,
  };
}

/**
 * A requirement as the restricted placeholder: its id, status, type, priority,
 * story points and version stay (so the review workflow still counts it); its
 * text, criteria, labels, evidence and every verdict drawn from them go.
 */
export function restrictedRequirement(r: SnapshotRequirement): SnapshotRequirement {
  return {
    id: r.id,
    type: r.type,
    title: RESTRICTED_SOURCE_TITLE,
    body: RESTRICTED_SOURCE_BODY,
    priority: r.priority,
    labels: [],
    storyPoints: r.storyPoints,
    reviewStatus: r.reviewStatus,
    evidenceFindingIds: [],
    coverage: null,
    verdict: null,
    kind: r.kind,
    nfrCategory: r.nfrCategory,
    acceptanceCriteria: [],
    version: r.version,
    ...(r.analysedVersion !== undefined ? { analysedVersion: r.analysedVersion } : {}),
    supportConfidence: null,
    sourceItems: null,
    sourceDivergence: null,
    criteriaProposal: null,
    restricted: true,
  };
}

/** A cross-document finding as the restricted placeholder. */
export function restrictedCrossDocFinding(f: CrossDocFinding): CrossDocFinding {
  return {
    id: f.id,
    kind: f.kind,
    severity: f.severity,
    title: RESTRICTED_SOURCE_TITLE,
    detail: RESTRICTED_SOURCE_BODY,
    evidenceIds: [],
    scope: f.scope,
    restricted: true,
  };
}

/** The stored sources of a snapshot's rows, which the snapshot does not carry. */
export interface SnapshotSourceRows {
  findings: ReadonlyMap<string, string | null>;
  requirements: ReadonlyMap<string, string | null>;
  crossDocFindings: ReadonlyMap<string, string | null>;
}

/**
 * The snapshot of run `snapshot.id` as `guard` lets its reader see it: every
 * row they cannot see becomes its placeholder, and an agent's summary and notes
 * (the run's narrative) are emptied when they cannot see the run as a whole.
 * Nothing is removed, so the result keeps its shape and its counts.
 */
export function redactAnalysisSnapshot<T extends AnalysisSnapshot>(
  snapshot: T,
  sources: SnapshotSourceRows,
  guard: SourceGuard,
): T {
  const analysisId = snapshot.id;
  const sees = (stored: ReadonlyMap<string, string | null>, id: string) =>
    guard.canSee({ analysisId, sourceIds: stored.get(id) ?? null });
  const seesRun = guard.canSeeRun(analysisId);
  return {
    ...snapshot,
    agents: snapshot.agents.map((a) => ({
      ...a,
      ...(seesRun ? {} : { summary: null, notes: [] }),
      findings: a.findings.map((f) => (sees(sources.findings, f.id) ? f : restrictedFinding(f))),
    })),
    requirements: snapshot.requirements.map((r) =>
      sees(sources.requirements, r.id) ? r : restrictedRequirement(r),
    ),
    crossDocFindings: snapshot.crossDocFindings
      ? {
          ...snapshot.crossDocFindings,
          findings: snapshot.crossDocFindings.findings.map((f) =>
            sees(sources.crossDocFindings, f.id) ? f : restrictedCrossDocFinding(f),
          ),
        }
      : snapshot.crossDocFindings,
  };
}

/**
 * The ids among `rows` (requirements, or anything else carrying its own run)
 * that `reader` cannot see. One guard load for all of them.
 */
export async function restrictedIds(
  reader: SourceReader,
  rows: ReadonlyArray<SourceGuardedRow & { id: string }>,
  db?: GuardDb,
): Promise<Set<string>> {
  if (rows.length === 0) return new Set();
  const guard = await loadSourceGuard(reader, rows, db);
  return new Set(rows.filter((r) => !guard.canSee(r)).map((r) => r.id));
}
