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
 * Free of server imports on purpose: the requirement version service clears
 * the flag on a criteria edit and must not pull in the enrichment pass's
 * database and analysis-service imports. The marker is found with the shared
 * matcher (`@metis/shared`), so a whitespace variant
 * (`<!--metis:criteria-predate-answers-->`), which every view hides as a
 * marker, is the flag here too (#1225).
 */

import { findMetisMarkers } from "@metis/shared";

/** Invisible marker identifying the flag line, so it can be found and removed. */
export const CRITERIA_FLAG_MARKER = "<!-- metis:criteria-predate-answers -->";

/** The flag line as it appears inside the Clarifications block. */
export const CRITERIA_FLAG_LINE =
  "> **Check the acceptance criteria.** They were derived before these answers and are not " +
  "regenerated from them. Edit them if an answer changes what this requirement must do. " +
  CRITERIA_FLAG_MARKER;

const CRITERIA_FLAG_NAME = "criteria-predate-answers";

/** Whether a body (or a block) carries the flag marker, in any whitespace variant. */
export function hasCriteriaFlag(text: string): boolean {
  return findMetisMarkers(text).some((m) => m.name === CRITERIA_FLAG_NAME);
}

/**
 * `text` with every flag marker written in its canonical form, so a block
 * whose flag marker is a whitespace variant compares equal to the one METIS
 * renders (#1225). Nothing else changes.
 */
export function canonicalizeCriteriaFlag(text: string): string {
  let out = "";
  let from = 0;
  for (const m of findMetisMarkers(text)) {
    if (m.name !== CRITERIA_FLAG_NAME) continue;
    out += text.slice(from, m.index) + CRITERIA_FLAG_MARKER;
    from = m.index + m.length;
  }
  return out + text.slice(from);
}

/**
 * The body without the flag line (and the blank line that follows it). A body
 * with no flag is returned unchanged.
 *
 * #1237 — the flags removed are the ones {@link hasCriteriaFlag} detects, so
 * a body it flags never comes back still flagged: a marker split across lines
 * removes every line it spans. A blank line is blank with its `\r` too, so a
 * CRLF body loses the one after the flag as well.
 */
export function clearCriteriaFlag(body: string): string {
  const flags = findMetisMarkers(body).filter((m) => m.name === CRITERIA_FLAG_NAME);
  if (flags.length === 0) return body;
  const lines = body.split("\n");
  const lineOf = (offset: number) => body.slice(0, offset).split("\n").length - 1;
  const drop = new Set<number>();
  for (const m of flags) {
    const last = lineOf(m.index + m.length);
    for (let i = lineOf(m.index); i <= last; i++) drop.add(i);
    if (lines[last + 1]?.trim() === "") drop.add(last + 1);
  }
  return lines.filter((_, i) => !drop.has(i)).join("\n");
}
