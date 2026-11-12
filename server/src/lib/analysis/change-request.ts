/**
 * Issue #2341 (epic #2328) — the change request: an analysis run with a name
 * and a record of what it was started from.
 *
 * Every run stores its title on `Analysis.title`, so SQL can search and sort
 * it (#2347): the analyst's, else the default `createAnalysis` writes from the
 * run's sources ({@link generatedChangeRequestTitle}), with `titleGenerated`
 * saying which. A run from before #2341 is given the same default by
 * {@link backfillChangeRequestTitles} at startup; until then the read path
 * generates the identical title, so no run is ever listed blank. The sources
 * are not a new table: every run already records its chosen documents
 * (`metadata.documentIds`) and imported items (`metadata.sourceRequirements`,
 * #1006).
 */
import {
  CHANGE_REQUEST_TITLE_MAX,
  normaliseChangeRequestTitle,
  type AnalysisSourceRequirement,
  type ChangeRequestSources,
} from "@metis/shared";
import { prisma } from "../prisma.js";

/** How much of the free-text requirements a generated title quotes. */
export const GENERATED_TITLE_EXCERPT = 80;

/** One line of plain text, at most `max` characters (an ellipsis marks a cut). */
export function clampTitle(raw: string, max = CHANGE_REQUEST_TITLE_MAX): string {
  const line = normaliseChangeRequestTitle(raw);
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The title a change request gets when nobody names it: the first source
 * document's name, else the first imported item's title (with how many more
 * there are), else the start of the free-text requirements, else the date.
 */
export function generatedChangeRequestTitle(input: {
  documentNames: readonly string[];
  importedTitles: readonly string[];
  extraInstructions?: string | null;
  startedAt: Date;
}): string {
  const names = input.documentNames.map((n) => clampTitle(n)).filter(Boolean);
  const imported = input.importedTitles.map((t) => clampTitle(t)).filter(Boolean);
  const list = names.length > 0 ? names : imported;
  if (list.length > 0) {
    const more = list.length - 1;
    return more > 0
      ? `${clampTitle(list[0]!, CHANGE_REQUEST_TITLE_MAX - 16)} and ${more} more`
      : list[0]!;
  }
  const text = clampTitle(input.extraInstructions ?? "", GENERATED_TITLE_EXCERPT);
  if (text) return text;
  const day = Number.isNaN(input.startedAt.getTime())
    ? "an unknown date"
    : input.startedAt.toISOString().slice(0, 10);
  return `Change request of ${day}`;
}

function parseObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The sources a run's stored metadata names (ids only; names are read later). */
export function runSourceRecord(metadata: string | null | undefined): {
  documentIds: string[];
  importedItems: AnalysisSourceRequirement[];
  extraInstructions: string | null;
} {
  const meta = parseObject(metadata);
  const documentIds = Array.isArray(meta.documentIds)
    ? meta.documentIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const importedItems = Array.isArray(meta.sourceRequirements)
    ? (meta.sourceRequirements as unknown[]).filter(
        (r): r is AnalysisSourceRequirement =>
          !!r &&
          typeof r === "object" &&
          typeof (r as AnalysisSourceRequirement).title === "string" &&
          typeof (r as AnalysisSourceRequirement).requirementId === "string",
      )
    : [];
  const extra = typeof meta.extraInstructions === "string" ? meta.extraInstructions : null;
  return { documentIds: [...new Set(documentIds)], importedItems, extraInstructions: extra };
}

/** A document's display name: the title its source supplied, else the filename. */
function documentName(d: { filename: string; title: string | null }): string {
  return d.title?.trim() || d.filename;
}

/**
 * The display names of `ids`, read only from `projectId`'s documents: an id
 * of another project's document resolves to nothing, so it never surfaces that
 * document's name. A soft-deleted document keeps its name (it is history).
 */
export async function documentNames(
  projectId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await prisma.document.findMany({
    where: { projectId, id: { in: unique } },
    select: { id: true, filename: true, title: true },
  });
  return new Map(rows.map((d) => [d.id, documentName(d)] as const));
}

export interface ChangeRequestDetails {
  title: string;
  /** True when Metis proposed the title; false when a person typed or renamed it. */
  titleGenerated: boolean;
  sources: ChangeRequestSources;
}

/**
 * The title and sources of each run of ONE project, in one document read.
 * Every row must belong to `projectId` (the callers' queries are scoped to it).
 */
export async function changeRequestDetails(
  projectId: string,
  rows: ReadonlyArray<{
    id: string;
    title: string | null;
    titleGenerated?: boolean;
    metadata: string | null;
    startedAt: Date;
  }>,
): Promise<Map<string, ChangeRequestDetails>> {
  const records = rows.map((r) => ({ row: r, record: runSourceRecord(r.metadata) }));
  const names = await documentNames(
    projectId,
    records.flatMap((r) => r.record.documentIds),
  );
  const out = new Map<string, ChangeRequestDetails>();
  for (const { row, record } of records) {
    const sources: ChangeRequestSources = {
      documents: record.documentIds.map((id) => ({ id, name: names.get(id) ?? null })),
      allDocuments: record.documentIds.length === 0,
      importedItems: record.importedItems.map((i) => ({
        requirementId: i.requirementId,
        title: i.title,
        externalSource: i.externalSource,
        externalId: i.externalId ?? null,
        externalUrl: i.externalUrl ?? null,
      })),
    };
    const stored = row.title?.trim();
    out.set(row.id, {
      title: stored
        ? stored
        : generatedChangeRequestTitle({
            documentNames: sources.documents
              .map((d) => d.name)
              .filter((n): n is string => n !== null),
            importedTitles: record.importedItems.map((i) => i.title),
            extraInstructions: record.extraInstructions,
            startedAt: row.startedAt,
          }),
      // A NULL title (not yet backfilled) is generated here, so it is Metis's.
      titleGenerated: stored ? row.titleGenerated === true : true,
      sources,
    });
  }
  return out;
}

/**
 * Rename a change request of `projectId`. Scoped on the project AND the id, so
 * a run of another project is not found (the caller answers 404), and a
 * deleted run is not renamed. Returns false when nothing matched.
 */
export async function renameChangeRequest(
  projectId: string,
  analysisId: string,
  title: string,
): Promise<boolean> {
  const res = await prisma.analysis.updateMany({
    where: { id: analysisId, projectId, deletedAt: null },
    data: { title, titleGenerated: false },
  });
  return res.count > 0;
}

/**
 * The title a new run is stored with when the analyst gives none: its first
 * chosen document's name, else its first imported item's title, else the start
 * of its free-text requirements, else the date. Document names are read from
 * `projectId` only, in the order the documents were chosen.
 */
export async function defaultChangeRequestTitle(input: {
  projectId: string;
  documentIds?: readonly string[];
  importedTitles?: readonly string[];
  extraInstructions?: string | null;
  startedAt?: Date;
}): Promise<string> {
  const ids = input.documentIds ?? [];
  const names = await documentNames(input.projectId, ids);
  return generatedChangeRequestTitle({
    documentNames: ids.map((id) => names.get(id)).filter((n): n is string => !!n),
    importedTitles: input.importedTitles ?? [],
    extraInstructions: input.extraInstructions ?? null,
    startedAt: input.startedAt ?? new Date(),
  });
}

/**
 * The title of a run with no sources to name it after (the synthetic import,
 * discussion and code-ingest runs): the same rule's date title, which is what
 * the read path would generate for it.
 */
export function sourcelessRunTitle(startedAt: Date): string {
  return generatedChangeRequestTitle({ documentNames: [], importedTitles: [], startedAt });
}

/**
 * #2341 — store a title on every run that has none (every run from before
 * #2341), by the same rule the read path generates it with, so a title is
 * searchable and sortable in SQL for every row. Idempotent: it reads only
 * `title IS NULL` rows and writes each only while it is still NULL, so a
 * second run, or a run racing a rename, changes nothing. Deleted runs are named
 * too: they are history, and a filter over them must not miss them either.
 */
export async function backfillChangeRequestTitles(
  opts: { batchSize?: number } = {},
): Promise<{ scanned: number; updated: number }> {
  const take = opts.batchSize ?? 500;
  let scanned = 0;
  let updated = 0;
  let after: string | undefined;
  for (;;) {
    const rows = await prisma.analysis.findMany({
      where: { title: null, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: "asc" },
      take,
      select: { id: true, projectId: true, title: true, metadata: true, startedAt: true },
    });
    if (rows.length === 0) break;
    scanned += rows.length;
    after = rows[rows.length - 1]!.id;
    const byProject = new Map<string, typeof rows>();
    for (const r of rows) byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r]);
    for (const [projectId, projectRows] of byProject) {
      const details = await changeRequestDetails(projectId, projectRows);
      for (const r of projectRows) {
        const res = await prisma.analysis.updateMany({
          where: { id: r.id, title: null },
          data: { title: details.get(r.id)!.title, titleGenerated: true },
        });
        updated += res.count;
      }
    }
    if (rows.length < take) break;
  }
  return { scanned, updated };
}
