/**
 * Issue #1006 — start an analysis from imported requirements.
 *
 * #706 run 5 pasted five imported GitHub issues into the free-text box: the
 * splitter made one requirement of them, synthesis added fourteen nobody asked
 * for, and nothing linked the results back to the imported items. Here each
 * selected item becomes ONE line of a leading bullet block, so the deterministic
 * splitter (`heuristicChangeExtractor`, via `extractNewRequirementCandidates`)
 * gives it exactly one `NR-*` id, in selection order, and the run records which
 * imported item each id was.
 *
 * Only the TITLE goes to the splitter. An imported body is an issue template
 * (headings, checklists, steps to reproduce) that the splitter would cut into
 * many candidates, losing the one-item-one-requirement mapping.
 *
 * Issue #2233 — the body and acceptance criteria still reach the analysis: they
 * are recorded on the item's link as `detail`, and the code agent reads them
 * beside the title under the item's one `NR-*` id (`codeAgentRequirementSet`).
 */
import {
  MAX_EXTRA_INSTRUCTIONS,
  parseAcceptanceCriteria,
  type AnalysisSourceRequirement,
  type ImportedRequirementOption,
} from "@metis/shared";
import { AppError } from "../../middleware/error-handler.js";
import { type Prisma, prisma, resolveDatabaseProvider } from "../prisma.js";
import { newRequirementId } from "./new-requirements.js";

/** The most imported requirements the listing returns (newest first). */
export const IMPORTED_REQUIREMENT_LIST_LIMIT = 500;

/** The longest search term the listing uses; longer input is cut, not refused. */
export const IMPORTED_REQUIREMENT_QUERY_MAX = 200;

/**
 * #2233 — an imported item's selected row: the listing's fields plus the body
 * and acceptance criteria the analysis reads beside the title.
 */
export interface SelectedImportedRequirement extends ImportedRequirementOption {
  body?: string;
  acceptanceCriteria?: readonly string[];
}

/**
 * #2233 — an imported item's body and acceptance criteria as one block of text,
 * or `undefined` when it has neither. Neither is shortened: a cut here would be
 * the silent cap this issue removes.
 */
export function importedRequirementDetail(
  body: string | null | undefined,
  acceptanceCriteria: readonly string[] = [],
): string | undefined {
  const parts: string[] = [];
  const text = body?.trim() ?? "";
  if (text.length > 0) parts.push(text);
  const criteria = acceptanceCriteria.map((c) => c.trim()).filter((c) => c.length > 0);
  if (criteria.length > 0) {
    parts.push(["Acceptance criteria:", ...criteria.map((c) => `- ${c}`)].join("\n"));
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Collapse a title onto one line so it stays one bullet (one candidate). */
function oneLine(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

/** True when the first blank-line-separated block is 2+ bullet / numbered lines. */
function startsWithBulletList(text: string): boolean {
  const lines = (text.split(/\n\s*\n/)[0] ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 1 && lines.every((l) => /^(?:[-*+]|\d+[.)])\s+/.test(l));
}

/**
 * Compose the run's new-requirements text from the selected imported items
 * (leading, one bullet each) plus any free text the user also typed, and the
 * `NR-*` link record for each item. Throws a 400 when the result would reach the
 * free-text limit, at which point the splitter would treat it as truncated.
 */
export function composeImportedRequirementInput(
  items: ReadonlyArray<SelectedImportedRequirement>,
  extraInstructions?: string,
): { extraInstructions: string; sourceRequirements: AnalysisSourceRequirement[] } {
  const bullets = items.map((item) => `- ${oneLine(item.title)}`).join("\n");
  const typed = extraInstructions?.trim() ?? "";
  // The imported block LEADS: a bullet list that follows a stated requirement is
  // folded into it as detail (#1136), so the user's text must come after.
  // A lone imported bullet is a ONE-line block, which the splitter reads as a stated
  // requirement (a list needs 2+ lines), so a typed bullet LIST right after it would be
  // folded into NR-1 as detail. A bare heading between them resets that state, and a
  // heading only titles non-list blocks, so the typed list is unaffected.
  const text =
    typed.length === 0
      ? bullets
      : items.length === 1 && startsWithBulletList(typed)
        ? `${bullets}\n\n## Requirements\n\n${typed}`
        : `${bullets}\n\n${typed}`;
  if (text.length >= MAX_EXTRA_INSTRUCTIONS) {
    throw new AppError(
      400,
      "IMPORTED_REQUIREMENTS_TOO_LONG",
      `The selected imported requirements and new-requirements text come to ${text.length} characters; the limit is ${MAX_EXTRA_INSTRUCTIONS - 1}. Select fewer, or shorten the text.`,
    );
  }
  return {
    extraInstructions: text,
    sourceRequirements: items.map((item, i) => {
      const detail = importedRequirementDetail(item.body, item.acceptanceCriteria);
      return {
        candidateId: newRequirementId(i),
        requirementId: item.id,
        title: oneLine(item.title),
        externalSource: item.externalSource,
        externalId: item.externalId,
        externalUrl: item.externalUrl,
        ...(detail ? { detail } : {}),
      };
    }),
  };
}

const IMPORTED_SELECT = {
  id: true,
  title: true,
  type: true,
  externalSource: true,
  externalId: true,
  externalUrl: true,
} as const;

/** Narrow a row whose `externalSource` the query already required non-null. */
function toOption(row: {
  id: string;
  title: string;
  type: string;
  externalSource: string | null;
  externalId: string | null;
  externalUrl: string | null;
}): ImportedRequirementOption {
  return { ...row, externalSource: row.externalSource ?? "unknown" };
}

/**
 * Normalise the start form's search term: trimmed, a leading `#` dropped (so
 * `#3401` finds issue 3401), bounded. Empty means "no filter".
 */
export function normaliseImportedRequirementQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/^#+/, "").trim().slice(0, IMPORTED_REQUIREMENT_QUERY_MAX);
}

/** A case-insensitive substring filter on both backends; the term is a bound value. */
function containsFilter(q: string): Prisma.StringFilter {
  // SQLite `LIKE` already folds ASCII case. Postgres needs `mode: "insensitive"`,
  // which the SQLite-generated client's types do not declare.
  return resolveDatabaseProvider() === "postgresql"
    ? ({ contains: q, mode: "insensitive" } as Prisma.StringFilter)
    : { contains: q };
}

/**
 * The project's imported requirements, newest first, for the start form: at
 * most {@link IMPORTED_REQUIREMENT_LIST_LIMIT}, narrowed by `q` (title or
 * external number) so a row older than the cap is still reachable. `total` is
 * the full match count, so the picker can say when the list is cut.
 */
export async function listImportedRequirements(
  projectId: string,
  q = "",
): Promise<{ items: ImportedRequirementOption[]; total: number; truncated: boolean }> {
  const where: Prisma.RequirementWhereInput = {
    projectId,
    deletedAt: null,
    externalSource: { not: null },
    ...(q ? { OR: [{ title: containsFilter(q) }, { externalId: containsFilter(q) }] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.requirement.findMany({
      where,
      select: IMPORTED_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: IMPORTED_REQUIREMENT_LIST_LIMIT,
    }),
    prisma.requirement.count({ where }),
  ]);
  return { items: rows.map(toOption), total, truncated: total > rows.length };
}

/**
 * Load the selected imported requirements, scoped to the project, in selection
 * order. Any id that is not an imported requirement OF THIS PROJECT is a 404 —
 * the same answer for "does not exist" and "belongs to another project", so the
 * check cannot be used to probe ids across tenants.
 */
export async function loadSelectedImportedRequirements(
  projectId: string,
  ids: ReadonlyArray<string>,
): Promise<SelectedImportedRequirement[]> {
  const unique = [...new Set(ids)];
  const rows = await prisma.requirement.findMany({
    where: { id: { in: unique }, projectId, deletedAt: null, externalSource: { not: null } },
    // #2233 — the body and acceptance criteria travel with the item to the analysis.
    select: { ...IMPORTED_SELECT, body: true, acceptanceCriteria: true },
  });
  const byId = new Map(
    rows.map(
      ({ body, acceptanceCriteria, ...r }) =>
        [
          r.id,
          { ...toOption(r), body, acceptanceCriteria: parseAcceptanceCriteria(acceptanceCriteria) },
        ] as const,
    ),
  );
  const missing = unique.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new AppError(
      404,
      "IMPORTED_REQUIREMENT_NOT_FOUND",
      `${missing.length} selected imported requirement(s) were not found in this project`,
    );
  }
  return unique.map((id) => byId.get(id)!);
}
