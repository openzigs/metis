/**
 * Issue #1000 — the "check the acceptance criteria" flag a requirement body
 * carries after clarification answers changed it.
 *
 * Answers are written into a requirement's body (`clarification-enrichment.ts`)
 * but its acceptance criteria are not regenerated from them, so an issue draft
 * could carry criteria that contradict the answers above them. The flag says so
 * in the body itself — the requirement view and the published issue both show
 * it — until someone edits the criteria, which removes it.
 *
 * Dependency-free on purpose: the requirement version service clears the flag
 * on a criteria edit and must not pull in the enrichment pass's database and
 * analysis-service imports.
 */

/** Invisible marker identifying the flag line, so it can be found and removed. */
export const CRITERIA_FLAG_MARKER = "<!-- metis:criteria-predate-answers -->";

/** The flag line as it appears inside the Clarifications block. */
export const CRITERIA_FLAG_LINE =
  "> **Check the acceptance criteria.** They were derived before these answers and are not " +
  "regenerated from them. Edit them if an answer changes what this requirement must do. " +
  CRITERIA_FLAG_MARKER;

/** Whether a body (or a block) carries the flag. */
export function hasCriteriaFlag(text: string): boolean {
  return text.includes(CRITERIA_FLAG_MARKER);
}

/**
 * The body without the flag line (and the blank line that follows it). A body
 * with no flag is returned unchanged.
 */
export function clearCriteriaFlag(body: string): string {
  const lines = body.split("\n");
  const at = lines.findIndex((line) => line.includes(CRITERIA_FLAG_MARKER));
  if (at === -1) return body;
  lines.splice(at, lines[at + 1] === "" ? 2 : 1);
  return lines.join("\n");
}
