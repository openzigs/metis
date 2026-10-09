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
 * Only the TITLE is used. An imported body is an issue template (headings,
 * checklists, steps to reproduce) that the splitter would cut into many
 * candidates, losing the one-item-one-requirement mapping.
 */
import {
  MAX_EXTRA_INSTRUCTIONS,
  type AnalysisSourceRequirement,
  type ImportedRequirementOption,
} from "@metis/shared";
import { AppError } from "../../middleware/error-handler.js";
import { prisma } from "../prisma.js";
import { newRequirementId } from "./new-requirements.js";

/** The most imported requirements the listing returns (newest first). */
export const IMPORTED_REQUIREMENT_LIST_LIMIT = 500;

/** Collapse a title onto one line so it stays one bullet (one candidate). */
function oneLine(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

/**
 * Compose the run's new-requirements text from the selected imported items
 * (leading, one bullet each) plus any free text the user also typed, and the
 * `NR-*` link record for each item. Throws a 400 when the result would reach the
 * free-text limit, at which point the splitter would treat it as truncated.
 */
export function composeImportedRequirementInput(
  items: ReadonlyArray<ImportedRequirementOption>,
  extraInstructions?: string,
): { extraInstructions: string; sourceRequirements: AnalysisSourceRequirement[] } {
  const bullets = items.map((item) => `- ${oneLine(item.title)}`).join("\n");
  const typed = extraInstructions?.trim() ?? "";
  // The imported block LEADS: a bullet list that follows a stated requirement is
  // folded into it as detail (#1136), so the user's text must come after.
  const text = typed.length > 0 ? `${bullets}\n\n${typed}` : bullets;
  if (text.length >= MAX_EXTRA_INSTRUCTIONS) {
    throw new AppError(
      400,
      "IMPORTED_REQUIREMENTS_TOO_LONG",
      `The selected imported requirements and new-requirements text come to ${text.length} characters; the limit is ${MAX_EXTRA_INSTRUCTIONS - 1}. Select fewer, or shorten the text.`,
    );
  }
  return {
    extraInstructions: text,
    sourceRequirements: items.map((item, i) => ({
      candidateId: newRequirementId(i),
      requirementId: item.id,
      title: oneLine(item.title),
      externalSource: item.externalSource,
      externalId: item.externalId,
      externalUrl: item.externalUrl,
    })),
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

/** The project's imported requirements, newest first, for the start form. */
export async function listImportedRequirements(
  projectId: string,
): Promise<ImportedRequirementOption[]> {
  const rows = await prisma.requirement.findMany({
    where: { projectId, deletedAt: null, externalSource: { not: null } },
    select: IMPORTED_SELECT,
    orderBy: { createdAt: "desc" },
    take: IMPORTED_REQUIREMENT_LIST_LIMIT,
  });
  return rows.map(toOption);
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
): Promise<ImportedRequirementOption[]> {
  const unique = [...new Set(ids)];
  const rows = await prisma.requirement.findMany({
    where: { id: { in: unique }, projectId, deletedAt: null, externalSource: { not: null } },
    select: IMPORTED_SELECT,
  });
  const byId = new Map(rows.map((r) => [r.id, toOption(r)] as const));
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
