/**
 * Issue #23 — human title for the master epic draft of an analysis.
 *
 * The epic used to be titled `[Epic] <project> — Analysis <first 8 id chars>`,
 * which tells a reader nothing about what was analysed. It is titled from the
 * BATCH: the set of requirements one analysis run produced.
 *
 * #1064 — it was titled from the first line of the run's requirement text, so a
 * run started from five imported requirements became an epic named after the
 * first of the five. A batch has no name field and the user is never asked for
 * one, so the rule for what a batch is called is, in order:
 *
 *   1. the heading that opens the requirement text (`metadata.extraInstructions`),
 *      when it opens with a Markdown heading — the user named the batch;
 *   2. the text's first line, when the text states ONE requirement (that
 *      requirement is the batch);
 *   3. when the text opens with a list of two or more requirements and no
 *      heading, no single line names the batch: the label of an imported
 *      requirement set (`metadata.label`) if there is one, else
 *      `<N> stated requirements (analysis of <start time>)`;
 *   4. with no requirement text: the import label, else `Analysis of <start
 *      time>`, which still keeps separate runs apart.
 *
 * "States one requirement": a text that opens with a list of two or more
 * bullet or numbered items states that many (`leadingListCount` — tight or
 * loose, items that wrap, and the one-imported-item-plus-typed-list shape the
 * start form writes, #1006); anything else is one stated requirement, whose
 * first line titles it.
 *
 * The title is also the draft's dedup key (`computeDedupHash`), so the same
 * analysis must always produce the same title — every input here is fixed once
 * the run has started. It is not unique across analyses — two runs can share a
 * first line — so `draft-generator.ts` (`claimTitle`) adds an `(n)` suffix
 * when another analysis already holds the title. An epic draft generated under
 * an earlier rule keeps the title it has (`draft-generator.ts`), because a
 * renamed epic would publish as a second issue.
 */

import { formatStartedAt } from "../analysis/run-start-label.js";

/** Maximum length of the part after `[Epic] <project> — `. */
export const EPIC_TITLE_SUBJECT_MAX = 80;

export interface EpicTitleAnalysis {
  startedAt?: Date | null;
  /** JSON-encoded run config (`Analysis.metadata`). */
  metadata?: string | null;
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
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

/** First line that still has text once list/heading/quote/emphasis markers are removed. */
function firstMeaningfulLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line
      .replace(/^\s*(?:[#>]+|[-*+]\s+\[[ xX]\]|[-*+]|\d+[.)])\s*/, "")
      .replace(/[*_`]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned) return cleaned;
  }
  return "";
}

function truncate(subject: string): string {
  if (subject.length <= EPIC_TITLE_SUBJECT_MAX) return subject;
  const room = subject.slice(0, EPIC_TITLE_SUBJECT_MAX - 1);
  const lastSpace = room.lastIndexOf(" ");
  const cut = lastSpace > 0 ? room.slice(0, lastSpace) : room;
  return `${cut.trimEnd()}…`;
}

// #1170 — lives with the analysis code so the BRD can name a run without
// importing publishing; re-exported here for the existing callers.
export { formatStartedAt };

const LIST_LINE_RE = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+\S/;

/** The bare heading `composeImportedRequirementInput` puts between one imported item and a typed list. */
const COMPOSER_HEADING_RE = /^#{1,6}\s+Requirements\s*$/i;

/**
 * Count the items of the list that starts at `lines[from]`, and where it ends.
 * An item is a bullet or numbered line no deeper than the first one. Lines that
 * belong to an item are not items: an indented line (a wrapped or nested
 * continuation) and an unindented line directly under an item (Markdown's lazy
 * continuation). Blank lines between items are allowed (a loose list); after a
 * blank line anything that is neither an item nor indented ends the list.
 */
function countListItems(lines: readonly string[], from: number): { count: number; next: number } {
  const first = LIST_LINE_RE.exec(lines[from] ?? "");
  if (!first) return { count: 0, next: from };
  const depth = first[1]!.length;
  let count = 0;
  let afterBlank = false;
  let i = from;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      afterBlank = true;
      continue;
    }
    const item = LIST_LINE_RE.exec(line);
    if (item && item[1]!.length <= depth) count += 1;
    else if (afterBlank && !/^\s/.test(line)) break;
    afterBlank = false;
  }
  return { count, next: i };
}

/**
 * How many requirements the text's opening list states, or 0 when it does not
 * open with a list of two or more (a heading above the list is not a list
 * line, so a headed text is 0 too and its heading names the batch).
 *
 * The list is read the way Markdown reads one — tight or loose, with wrapped
 * and nested lines belonging to their item — and one more shape is known: one
 * imported requirement followed by a typed list is written by the start form
 * as a single bullet, a bare `## Requirements` heading and the list. Those are
 * requirements of one batch, so the two lists are counted together.
 */
function leadingListCount(text: string): number {
  const lines = text.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === "") start += 1;
  const opening = countListItems(lines, start);
  let count = opening.count;
  if (count === 1 && COMPOSER_HEADING_RE.test(lines[opening.next] ?? "")) {
    let rest = opening.next + 1;
    while (rest < lines.length && lines[rest]!.trim() === "") rest += 1;
    count += countListItems(lines, rest).count;
  }
  return count >= 2 ? count : 0;
}

function subjectFor(analysis: EpicTitleAnalysis): string {
  const meta = parseMetadata(analysis.metadata);
  const text = typeof meta.extraInstructions === "string" ? meta.extraInstructions : "";
  const stated = leadingListCount(text);
  if (stated === 0) {
    const line = firstMeaningfulLine(text);
    if (line) return truncate(line);
  }
  const label = typeof meta.label === "string" ? firstMeaningfulLine(meta.label) : "";
  if (label) return truncate(label);
  const when = formatStartedAt(analysis.startedAt);
  if (stated > 0) {
    return when
      ? `${stated} stated requirements (analysis of ${when})`
      : `${stated} stated requirements`;
  }
  return when ? `Analysis of ${when}` : "Requirements analysis";
}

export function buildEpicTitle(projectName: string, analysis: EpicTitleAnalysis): string {
  return `[Epic] ${projectName} — ${subjectFor(analysis)}`;
}

/**
 * The title this analysis's epic was given before #1064 (first line of the
 * requirement text, else the import label, else the start time). Only used to
 * find an epic draft that already exists under it — never to title a new one.
 */
export function buildLegacyEpicTitle(projectName: string, analysis: EpicTitleAnalysis): string {
  const meta = parseMetadata(analysis.metadata);
  for (const candidate of [meta.extraInstructions, meta.label]) {
    if (typeof candidate !== "string") continue;
    const line = firstMeaningfulLine(candidate);
    if (line) return `[Epic] ${projectName} — ${truncate(line)}`;
  }
  return buildEpicTitle(projectName, analysis);
}
