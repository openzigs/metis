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
 * "States one requirement" is read the way the analysis reads it (#1006,
 * `imported-requirement-input.ts`): a leading block of two or more bullet or
 * numbered lines is a list of requirements, one per line; anything else is one
 * stated requirement, whose first line titles it.
 *
 * The title is also the draft's dedup key (`computeDedupHash`), so the same
 * analysis must always produce the same title — every input here is fixed once
 * the run has started. It is not unique across analyses — two runs can share a
 * first line — so `draft-generator.ts` (`claimTitle`) adds an `(n)` suffix
 * when another analysis already holds the title. An epic draft generated under
 * an earlier rule keeps the title it has (`draft-generator.ts`), because a
 * renamed epic would publish as a second issue.
 */

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

function formatStartedAt(startedAt: Date | null | undefined): string | null {
  if (!(startedAt instanceof Date) || Number.isNaN(startedAt.getTime())) return null;
  // "2026-09-29T14:05:33.000Z" → "2026-09-29 14:05:33 UTC" — to the second, so
  // runs started in the same minute stay apart.
  return `${startedAt.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

const LIST_LINE_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\S/;

/**
 * How many requirements the text's opening list states: the number of lines in
 * its first block when every one of them (two or more) is a bullet or numbered
 * item, else 0. A heading above the list is not a list line, so a headed text
 * is 0 too and its heading names the batch.
 */
function leadingListCount(text: string): number {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() !== "") lines.push(line);
    else if (lines.length > 0) break;
  }
  if (lines.length < 2) return 0;
  return lines.every((l) => LIST_LINE_RE.test(l)) ? lines.length : 0;
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
