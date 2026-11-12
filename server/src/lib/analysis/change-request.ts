/**
 * Issue #2341 (epic #2328) — the change request: an analysis run with a name
 * and a record of what it was started from.
 *
 * The title is stored on `Analysis.title` when a run starts. A run with no
 * stored title (before #2341, or started by the system) gets one generated
 * here, from the same sources a new run is named after, so no run is ever
 * listed blank. The sources are not a new table: every run already records its
 * chosen documents (`metadata.documentIds`) and imported items
 * (`metadata.sourceRequirements`, #1006).
 */
import {
  CHANGE_REQUEST_TITLE_MAX,
  type AnalysisSourceRequirement,
  type ChangeRequestSources,
} from "@metis/shared";
import { prisma } from "../prisma.js";

/** How much of the free-text requirements a generated title quotes. */
export const GENERATED_TITLE_EXCERPT = 80;

/** One line of plain text, at most `max` characters (an ellipsis marks a cut). */
export function clampTitle(raw: string, max = CHANGE_REQUEST_TITLE_MAX): string {
  const line = raw.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
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
      titleGenerated: !stored,
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
    data: { title },
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
