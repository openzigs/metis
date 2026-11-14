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
 *     cites as evidence ({@link sourceIdsOfFindingSets}). If any of those
 *     findings cannot be read, or carries no record, the row gets none
 *     (`null`): a partial union would claim to be complete.
 *   - a requirement, elicited NFR or cross-document finding that cites NO
 *     finding: none (`null`), never an empty set. Synthesis, elicitation and
 *     the completeness check each read every finding of the run, so such a row
 *     is derived from the run's whole corpus, not from nothing.
 *
 * How a reader (#2447) must read the column:
 *   - a list (even an empty one, which only a finding citing nothing has):
 *     exactly the sources the row's citations name;
 *   - `null` on a row of a run whose `Analysis.sourceAccess` is set: "rests on
 *     the run as a whole, or not recorded" — fail closed, treating the row as
 *     drawing on every source the run read (its audience), never as on none.
 *
 * A row's uncited context (what its pass read without citing) is, on a
 * `shared` run, the run's audience (`Analysis.sourceAccess`), which hides
 * nothing. #2448 — on a `starter` run it is the pass's read set
 * (`AgentResult.readSourceIds`), folded into each of its findings' lists when
 * they are written (`persistAgentResult`). A run from before
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
 * (#2314) and recorded sources on every row it wrote.
 */
export const SOURCE_ACCESS_SHARED = "shared";

/**
 * #2448 — `Analysis.sourceAccess` of a run a person started: its code passes
 * read with the access of whoever ran them, and each records what it read
 * (`AgentResult.readSourceIds`, `pass-reads.ts`). Every finding a pass writes
 * rests on that read set as well as on its citations; a requirement or a
 * cross-document finding rests on the run as a whole ({@link
 * sourceIdsOfFindingSets}).
 */
export const SOURCE_ACCESS_STARTER = "starter";

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
            OR: [
              // A document citation names its row exactly.
              { id: { in: [...docIds] } },
              // A code citation names the live repository file, on the same
              // filters as the ACL loader (`loadCodeAccessFilterFor`): not a
              // soft-deleted copy of it, and not an upload named like it (#474).
              { filename: { in: [...filenames] }, source: "repo", deletedAt: null },
            ],
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
 * The stored sources of each row that rests on `findingIds` (a requirement's
 * evidence findings, a cross-document finding's evidence), index-aligned with
 * `sets`: the union of theirs, from the analysis `analysisId` only, read in
 * one query for every row of a write site. A row's record is `null` when any
 * of its findings cannot be read there or carries no record (a finding from
 * before #2446), so it is never recorded as resting on less than it does; and
 * `null` when it cites no finding, because the pass that wrote it read every
 * finding of the run (see the module header).
 *
 * #2448 — and `null` for every row of a {@link SOURCE_ACCESS_STARTER} run: the
 * pass that wrote it (synthesis, the completeness check, promotion) read every
 * finding of the run, and there a finding may rest on a restricted file its
 * citations do not name. So the row rests on the run as a whole, and a reader
 * sees it only when they can see everything the run read.
 */
export async function sourceIdsOfFindingSets(
  db: Pick<Prisma.TransactionClient, "finding">,
  analysisId: string,
  sets: ReadonlyArray<readonly string[]>,
): Promise<Array<string | null>> {
  const all = sorted(sets.flat());
  if (all.length === 0) return sets.map(() => null);
  const rows = await db.finding.findMany({
    where: { id: { in: all }, agentResult: { analysisId } },
    select: {
      id: true,
      sourceIds: true,
      agentResult: { select: { analysis: { select: { sourceAccess: true } } } },
    },
  });
  // A row citing no finding of the run is `null` below whatever the run is.
  if (rows.some((r) => r.agentResult?.analysis?.sourceAccess === SOURCE_ACCESS_STARTER)) {
    return sets.map(() => null);
  }
  const byId = new Map(rows.map((r) => [r.id, parseSourceIds(r.sourceIds)]));
  return sets.map((set) => {
    const ids = sorted(set);
    if (ids.length === 0) return null;
    const parts: SourceIds[] = [];
    for (const id of ids) {
      const parsed = byId.get(id);
      if (!parsed) return null;
      parts.push(parsed);
    }
    return serializeSourceIds(unionSourceIds(parts));
  });
}

/** {@link sourceIdsOfFindingSets} for one row. */
export async function sourceIdsOfFindings(
  db: Pick<Prisma.TransactionClient, "finding">,
  analysisId: string,
  findingIds: readonly string[],
): Promise<string | null> {
  const [stored] = await sourceIdsOfFindingSets(db, analysisId, [findingIds]);
  return stored ?? null;
}
