/**
 * #1132 — a section the model was CUT OFF from finishing (`section-truncated`:
 * the reply stopped at the output-token cap).
 *
 * The reply ends wherever the cap fell: inside a sentence, a table, or the
 * sub-section the model was writing. In #706 run 8 the Architecture document's
 * Component Breakdown ended on a bare `### 7. Outbound Integration Hub` and
 * `**Purpose**` with nothing under either, and its note named only one of the
 * two components that were missing.
 *
 * {@link trimCutOffSection} takes such a section back to the end of its last
 * complete sub-section, so it never ends on an empty heading or a bare label,
 * and returns the topics that are now absent — the one cut mid-way first among
 * them. {@link cutOffNote} is the closing note an analyst reads in its place.
 *
 * Pure: no I/O and no model calls.
 */
import {
  SHORTENED_NOTE_LEAD,
  headingText,
  isEmptyLead,
  omittedTopicsSentence,
  units,
  type Unit,
} from "./section-size.js";

export interface CutOffTrim {
  /** The section up to the end of its last complete sub-section. */
  markdown: string;
  /** True when anything was removed. */
  trimmed: boolean;
  /** Headings of the topics removed, in document order (the one cut mid-way included). */
  omittedTopics: string[];
}

const hasContent = (all: readonly Unit[]): boolean => all.some((u) => !isEmptyLead(u));

/**
 * Trim a cut-off section back to its last complete sub-section.
 *
 * The cut fell in the last top-level block (the last of the shallowest
 * headings — a group can write more than one `##` section). When that block has
 * sub-sections, the last one at its shallowest sub-level is the one the model
 * was writing: it is removed whole and named. When it has none, the unit the
 * model was writing (its last paragraph, list or table) is removed. Whatever is
 * then left at the end with nothing under it — a heading or a bare label — goes
 * too, and a heading removed that way is named as well.
 *
 * If nothing complete would be left, the section is returned as it was: a
 * section that ends mid-sentence still says more than an empty one.
 */
export function trimCutOffSection(markdown: string): CutOffTrim {
  const all = units(markdown);
  const unchanged: CutOffTrim = { markdown, trimmed: false, omittedTopics: [] };
  if (all.length === 0) return unchanged;
  const depths = all.filter((u) => u.depth > 0).map((u) => u.depth);
  const top = depths.length > 0 ? Math.min(...depths) : 0;
  let blockStart = -1;
  for (let i = all.length - 1; i >= 0 && top > 0; i--) {
    if (all[i].depth === top) {
      blockStart = i;
      break;
    }
  }
  const subLevels = all.slice(blockStart + 1).filter((u) => u.depth > top);
  let cut: number;
  if (subLevels.length > 0) {
    const level = Math.min(...subLevels.map((u) => u.depth));
    cut = all.length - 1;
    while (all[cut].depth !== level) cut -= 1;
  } else {
    cut = all[all.length - 1].depth === 0 ? all.length - 1 : all.length;
  }
  const kept = all.slice(0, cut);
  // The sub-section cut mid-way; a removed paragraph has no heading to name.
  const omitted = subLevels.length > 0 ? [all[cut]] : [];
  const popped: Unit[] = [];
  while (kept.length > 0 && isEmptyLead(kept[kept.length - 1])) popped.unshift(kept.pop()!);
  if (!hasContent(kept)) return unchanged;
  const named = [...popped.filter((u) => u.depth > 0), ...omitted].map(headingText);
  return {
    markdown: kept.map((u) => u.text).join("\n\n"),
    trimmed: true,
    omittedTopics: [...new Set(named)],
  };
}

/**
 * The closing note of a cut-off section, in an analyst's words. It opens like
 * every other shortened-section note ({@link SHORTENED_NOTE_LEAD}), so a later
 * length fit recognises it as the closing note rather than as content.
 */
export function cutOffNote(omittedTopics: readonly string[], removed = true): string {
  const what = removed
    ? "so the part it was still writing was removed."
    : "so its last part is unfinished.";
  return (
    `${SHORTENED_NOTE_LEAD} The AI model reached the most it can write in one answer before ` +
    `it finished this section, ${what}` +
    `${omittedTopicsSentence(omittedTopics)} Regenerate the document to write this section again.`
  );
}
