/**
 * #2446 (epic #2438) — which sources each analysis finding, citation and
 * requirement drew on, recorded at write time as ids only.
 *
 * A source is a `Document` row (an uploaded document, or a repository file
 * ingested as `connector:repo:<connectorId>:src/<path>`) and, where the
 * citation names one, a `KnowledgeChunk` row of it. Those are the rows a
 * document ACL restricts (`code-access.ts`, `rag/acl.ts`), so a read-time
 * filter (#2447) can check a reader against them without re-deriving anything
 * from text. Never a path, filename, symbol name or snippet: the column is
 * read by code that decides who may see the row, and holds nothing a reader
 * could learn a restricted file from.
 *
 * What is recorded:
 *   - a finding: the sources its citations name, and each citation's own, in
 *     the order of `evidence.citations` ({@link FindingSourceIds});
 *   - a requirement or a cross-document finding: the union of the findings it
 *     cites as evidence ({@link sourceIdsOfFindings}). If any of those findings
 *     cannot be read, or carries no record, the row gets none (`null`): a
 *     partial union would claim to be complete.
 *
 * A row's uncited context (what its pass read without citing) is not on the
 * row: it is the run's audience, `Analysis.sourceAccess`. A run from before
 * #2446 has `sourceAccess` NULL and keeps the shared-audience rule (#2314);
 * none of its rows carry sources, and none are backfilled.
 */
import {
  isCodeCitation,
  isDocumentCitation,
  type Citation,
  type CodeCitation,
} from "@metis/shared";
import type { Prisma } from "@prisma/client";
import { repoDocumentFilenames } from "./tools/code-access.js";

/**
 * `Analysis.sourceAccess` of a run that read code as the shared audience
 * (#2314) and recorded sources on every row it wrote. #2448 adds the starter's.
 */
export const SOURCE_ACCESS_SHARED = "shared";

/** The sources one row, or one citation, drew on: sorted, distinct ids. */
export interface SourceIds {
  documentIds: string[];
  chunkIds: string[];
}

/** A finding's sources, and each of its citations' own (index-aligned). */
export interface FindingSourceIds extends SourceIds {
  citations: SourceIds[];
}

type SourceDb = Pick<
  Prisma.TransactionClient,
  "analysis" | "document" | "knowledgeChunk" | "repoConnection"
>;

const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

/** The union of `parts`, sorted and distinct. */
export function unionSourceIds(parts: Iterable<SourceIds>): SourceIds {
  const documentIds: string[] = [];
  const chunkIds: string[] = [];
  for (const p of parts) {
    documentIds.push(...p.documentIds);
    chunkIds.push(...p.chunkIds);
  }
  return { documentIds: sorted(documentIds), chunkIds: sorted(chunkIds) };
}

const EMPTY: SourceIds = { documentIds: [], chunkIds: [] };

/**
 * The `Document` id a document citation names, or `null` for a code citation.
 * A synthetic `code-graph:` id the grounding gate did not normalise names no
 * row, so the project-scoped lookup below leaves it out like any unknown id.
 */
function citedDocumentId(c: Citation): string | null {
  return isDocumentCitation(c) ? c.documentId.trim() || null : null;
}

/**
 * Resolve each finding's citations to the ids of the rows they name, in the
 * analysis's own project only: an id from another project, or one that names
 * no row, is not a source of anything and is left out.
 *
 *   - A document citation names its `Document` and the `KnowledgeChunk` at its
 *     `chunkIndex`.
 *   - A code citation names the repository file's `Document` row in the
 *     repository it was grounded in; one with no `repoConnectionId` (#1611:
 *     the repository could not be told apart) names that path's row in every
 *     repository of the project, so a reader must be able to see each.
 *     A file with no `Document` row has nothing an ACL can restrict.
 *
 * At most four reads per call, and none when nothing is cited.
 */
export async function resolveFindingSourceIds(
  db: SourceDb,
  analysisId: string,
  findings: ReadonlyArray<{ citations?: readonly Citation[] | null }>,
): Promise<FindingSourceIds[]> {
  const lists = findings.map((f) => f.citations ?? []);
  if (lists.every((l) => l.length === 0)) {
    return lists.map(() => ({ ...EMPTY, citations: [] }));
  }
  const analysis = await db.analysis.findUnique({
    where: { id: analysisId },
    select: { projectId: true },
  });
  if (!analysis) throw new Error(`Analysis ${analysisId} not found`);
  const { projectId } = analysis;

  const codeCitations = lists.flat().filter(isCodeCitation);
  const repoIds = codeCitations.some((c) => !c.repoConnectionId)
    ? (await db.repoConnection.findMany({ where: { projectId }, select: { id: true } })).map(
        (r) => r.id,
      )
    : [];
  const filenamesOf = (c: CodeCitation): string[] =>
    (c.repoConnectionId ? [c.repoConnectionId] : repoIds).flatMap((repo) =>
      repoDocumentFilenames(repo, c.filePath),
    );

  const docIds = new Set<string>();
  const filenames = new Set<string>();
  for (const c of lists.flat()) {
    const id = citedDocumentId(c);
    if (id) docIds.add(id);
    else if (isCodeCitation(c)) for (const name of filenamesOf(c)) filenames.add(name);
  }
  const documents =
    docIds.size + filenames.size > 0
      ? await db.document.findMany({
          where: {
            projectId,
            OR: [{ id: { in: [...docIds] } }, { filename: { in: [...filenames] } }],
          },
          select: { id: true, filename: true },
        })
      : [];
  const knownIds = new Set(documents.map((d) => d.id));
  const idsByFilename = new Map<string, string[]>();
  for (const d of documents) {
    idsByFilename.set(d.filename, [...(idsByFilename.get(d.filename) ?? []), d.id]);
  }

  const chunkLookups = lists
    .flat()
    .filter(isDocumentCitation)
    .filter((c) => knownIds.has(c.documentId.trim()));
  const chunks =
    chunkLookups.length > 0
      ? await db.knowledgeChunk.findMany({
          where: {
            projectId,
            documentId: { in: sorted(chunkLookups.map((c) => c.documentId.trim())) },
            position: { in: [...new Set(chunkLookups.map((c) => c.chunkIndex))] },
          },
          select: { id: true, documentId: true, position: true },
        })
      : [];
  const chunkIdAt = new Map(chunks.map((ch) => [`${ch.documentId}\u0000${ch.position}`, ch.id]));

  const ofCitation = (c: Citation): SourceIds => {
    const id = citedDocumentId(c);
    if (id) {
      if (!knownIds.has(id) || !isDocumentCitation(c)) return EMPTY;
      const chunk = chunkIdAt.get(`${id}\u0000${c.chunkIndex}`);
      return { documentIds: [id], chunkIds: chunk ? [chunk] : [] };
    }
    if (!isCodeCitation(c)) return EMPTY;
    return {
      documentIds: sorted(filenamesOf(c).flatMap((name) => idsByFilename.get(name) ?? [])),
      chunkIds: [],
    };
  };

  return lists.map((list) => {
    const citations = list.map(ofCitation);
    return { ...unionSourceIds(citations), citations };
  });
}

/** The stored form of a row's sources (`Finding`/`Requirement`/`CrossDocFinding.sourceIds`). */
export function serializeSourceIds(ids: SourceIds | FindingSourceIds): string {
  const base = { documentIds: sorted(ids.documentIds), chunkIds: sorted(ids.chunkIds) };
  return JSON.stringify(
    "citations" in ids
      ? {
          ...base,
          citations: ids.citations.map((c) => ({
            documentIds: sorted(c.documentIds),
            chunkIds: sorted(c.chunkIds),
          })),
        }
      : base,
  );
}

const isIdList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);

/**
 * A stored `sourceIds` value, or `null` when there is none or it is not the
 * shape {@link serializeSourceIds} writes: an unreadable record is no record,
 * never an empty one.
 */
export function parseSourceIds(raw: string | null | undefined): SourceIds | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const { documentIds, chunkIds } = v as Record<string, unknown>;
  return isIdList(documentIds) && isIdList(chunkIds) ? { documentIds, chunkIds } : null;
}

/**
 * Two stored records as one: a row that now rests on both (a reviewed
 * requirement whose text a withheld re-synthesis replaced, #780). `null` when
 * either is: a union with an unknown part is unknown.
 */
export function unionStoredSourceIds(a: string | null, b: string | null): string | null {
  const left = parseSourceIds(a);
  const right = parseSourceIds(b);
  return left && right ? serializeSourceIds(unionSourceIds([left, right])) : null;
}

const FINDING_LABEL = "finding:";

/** The finding ids a requirement's labels cite as evidence (`finding:<id>`, `evidenceLabels`). */
export function evidenceFindingIds(labels: readonly string[]): string[] {
  return sorted(
    labels.flatMap((l) =>
      l.startsWith(FINDING_LABEL) && l.length > FINDING_LABEL.length
        ? [l.slice(FINDING_LABEL.length)]
        : [],
    ),
  );
}

/**
 * The stored sources of a row that rests on `findingIds` (a requirement's
 * evidence findings, a cross-document finding's evidence): the union of
 * theirs, from the analysis `analysisId` only. `null` when any of them cannot
 * be read there or carries no record (a finding from before #2446), so the
 * row is never recorded as resting on less than it does. A row citing no
 * finding rests on none of them: an empty record.
 */
export async function sourceIdsOfFindings(
  db: Pick<Prisma.TransactionClient, "finding">,
  analysisId: string,
  findingIds: readonly string[],
): Promise<string | null> {
  const ids = sorted(findingIds);
  if (ids.length === 0) return serializeSourceIds(EMPTY);
  const rows = await db.finding.findMany({
    where: { id: { in: ids }, agentResult: { analysisId } },
    select: { id: true, sourceIds: true },
  });
  if (rows.length !== ids.length) return null;
  const parts: SourceIds[] = [];
  for (const row of rows) {
    const parsed = parseSourceIds(row.sourceIds);
    if (!parsed) return null;
    parts.push(parsed);
  }
  return serializeSourceIds(unionSourceIds(parts));
}
