/**
 * #863 / #990 — where an issue draft's acceptance criteria come from when the
 * requirement's stored list is empty, shared so the Edit dialog prefills from
 * exactly the extraction the draft renders (the editor is the single source).
 * String operations rather than one regex, so a long line of an untrusted body
 * cannot backtrack.
 */

/** Stored in place of `[]` when a user deliberately empties the list (#990). */
export const ACCEPTANCE_CRITERIA_CLEARED = "null";

export function isAcceptanceCriteriaCleared(raw: string | null | undefined): boolean {
  return raw === ACCEPTANCE_CRITERIA_CLEARED;
}

const MARKDOWN_HEADING = /^\s*#{1,6}\s/;
/** A bullet or numbered list marker. Linear: no overlapping quantifiers. */
const LIST_MARKER = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
const CHECKBOX = /^\[[ xX]\]\s+/;

/**
 * A heading or bold label introducing an acceptance-criteria section
 * (`## Acceptance criteria`, `**Acceptance Criteria:**`). String operations
 * rather than one regex, so a long line of an untrusted body cannot backtrack.
 */
function isAcceptanceCriteriaHeading(line: string): boolean {
  let text = line
    .trim()
    .replace(/^#{1,6}/, "")
    .trim();
  for (const mark of ["**", "__"]) {
    if (text.startsWith(mark)) text = text.slice(mark.length);
    if (text.endsWith(mark)) text = text.slice(0, -mark.length);
  }
  text = text.trim();
  if (text.endsWith(":")) text = text.slice(0, -1);
  for (const mark of ["**", "__"]) {
    if (text.endsWith(mark)) text = text.slice(0, -mark.length);
  }
  return text.trim().toLowerCase() === "acceptance criteria";
}

/** The text of a list item (bullet, numbered or checklist), or null. */
function listItemText(line: string): string | null {
  const marker = LIST_MARKER.exec(line);
  if (!marker) return null;
  const rest = line.slice(marker[0].length);
  const box = CHECKBOX.exec(rest);
  const text = (box ? rest.slice(box[0].length) : rest).trim();
  return text.length > 0 ? text : null;
}

/**
 * #863 — the criteria an upstream issue body states itself, under an
 * "Acceptance criteria" heading. Imported requirements carry the upstream text
 * only, so without this every imported draft read "no acceptance criteria"
 * even when the issue listed them. Only that section is read: a stray checklist
 * elsewhere ("- [x] I searched existing issues") is a template, not a criterion,
 * and inventing criteria is what #1096 removed.
 */
export function extractBodyAcceptanceCriteria(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(isAcceptanceCriteriaHeading);
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (MARKDOWN_HEADING.test(line) || isAcceptanceCriteriaHeading(line)) break;
    const item = listItemText(line);
    if (item) items.push(item);
    else if (line.trim().length > 0) {
      // An indented line continues the item above; any other prose ends the
      // section, even before the first item ("None yet." then a template box).
      if (items.length > 0 && /^\s+\S/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
      else break;
    }
  }
  return items;
}

/**
 * The criteria a draft renders when the stored list is empty: the body's
 * "Acceptance criteria" section, else a body already written as Gherkin.
 */
export function deriveBodyAcceptanceCriteria(body: string): string[] {
  const fromSection = extractBodyAcceptanceCriteria(body);
  if (fromSection.length > 0) return fromSection;
  const trimmed = body.trim();
  if (/given\b.*when\b.*then\b/is.test(trimmed)) {
    return trimmed
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  return [];
}
