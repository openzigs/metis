/**
 * Issue #23 — human title for the master epic draft of an analysis.
 *
 * The epic used to be titled `[Epic] <project> — Analysis <first 8 id chars>`,
 * which tells a reader nothing about what was analysed. It is now titled from
 * the analysed feature, in order of preference:
 *
 *   1. the first meaningful line of the requirement text the user asked the
 *      analysis to evaluate (`metadata.extraInstructions`);
 *   2. the label of an imported requirement set (`metadata.label`);
 *   3. the run's start time, which still keeps separate runs apart.
 *
 * The title is also the draft's dedup key (`computeDedupHash`), so the same
 * analysis must always produce the same title — every input here is fixed once
 * the run has started.
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
  // "2026-09-29T14:05:33.000Z" → "2026-09-29 14:05 UTC"
  return `${startedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function subjectFor(analysis: EpicTitleAnalysis): string {
  const meta = parseMetadata(analysis.metadata);
  for (const candidate of [meta.extraInstructions, meta.label]) {
    if (typeof candidate !== "string") continue;
    const line = firstMeaningfulLine(candidate);
    if (line) return truncate(line);
  }
  const when = formatStartedAt(analysis.startedAt);
  return when ? `Analysis of ${when}` : "Requirements analysis";
}

export function buildEpicTitle(projectName: string, analysis: EpicTitleAnalysis): string {
  return `[Epic] ${projectName} — ${subjectFor(analysis)}`;
}
