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
 * and returns the topics that are now absent — the one cut mid-way among them.
 * {@link cutOffNote} is the closing note an analyst reads in its place.
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

/** Remove the trailing headings and bare labels of `kept` (keeping at least `floor` units). */
function popEmptyLeads(kept: Unit[], floor: number): Unit[] {
  const popped: Unit[] = [];
  while (kept.length > floor && isEmptyLead(kept[kept.length - 1])) popped.unshift(kept.pop()!);
  return popped;
}

/**
 * Trim a cut-off section back to its last complete sub-section.
 *
 * The cut fell in the last top-level block (the last of the shallowest
 * headings — a group can write more than one `##` section), inside its last
 * sub-section at whatever depth: that innermost sub-section is the one the
 * model was writing. It is removed and named; every complete sub-section
 * before it stays, deeper ones included (`### 2` / `#### 2.1` complete /
 * `#### 2.2` cut keeps 2.1). A block with no sub-section loses the unit the
 * model was writing (its last paragraph, list or table) instead. Whatever is
 * then left at the end with nothing under it — a heading or a bare label — goes
 * too, and a heading removed that way is named as well.
 *
 * If nothing complete would be left, the text is kept as written, but still
 * never ends on an empty heading or label: those are removed (down to the
 * section's own first heading) and named. Line endings are the input's.
 */
export function trimCutOffSection(markdown: string): CutOffTrim {
  const unchanged: CutOffTrim = { markdown, trimmed: false, omittedTopics: [] };
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const all = units(markdown.replace(/\r\n?/g, "\n"));
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
  // The innermost sub-section being written: the block's last heading below its own.
  let cut = -1;
  for (let i = all.length - 1; i > blockStart; i--) {
    if (all[i].depth > top) {
      cut = i;
      break;
    }
  }
  const cutTopic: Unit[] = cut >= 0 ? [all[cut]] : [];
  if (cut < 0) cut = all[all.length - 1].depth === 0 ? all.length - 1 : all.length;

  let kept = all.slice(0, cut);
  let popped = popEmptyLeads(kept, 0);
  let named = [...popped.filter((u) => u.depth > 0), ...cutTopic];
  if (!hasContent(kept)) {
    // Nothing complete before the cut: keep what was written, minus an empty ending.
    kept = [...all];
    popped = popEmptyLeads(kept, 1);
    if (popped.length === 0) return unchanged;
    named = popped.filter((u) => u.depth > 0);
  }
  return {
    markdown: kept
      .map((u) => u.text)
      .join("\n\n")
      .replace(/\n/g, eol),
    trimmed: true,
    omittedTopics: [...new Set(named.map(headingText))],
  };
}

export interface CutOffNoteOptions {
  /** False when nothing could be removed, so the section's end is still unfinished. */
  removed?: boolean;
  /** Set when the length cap also shortened the section: the cap, in characters. */
  shortenedToChars?: number;
}

/**
 * The closing note of a cut-off section, in an analyst's words. It opens like
 * every other shortened-section note ({@link SHORTENED_NOTE_LEAD}), so a later
 * length fit recognises it as the closing note rather than as content. Only
 * the topics the reply itself named can be listed, so it says that topics the
 * model never reached may be missing as well.
 */
export function cutOffNote(
  omittedTopics: readonly string[],
  { removed = true, shortenedToChars }: CutOffNoteOptions = {},
): string {
  const what = removed
    ? "so the part it was still writing was removed."
    : "so its last part is unfinished.";
  const shortened =
    shortenedToChars !== undefined
      ? ` It was also shortened to about ${Math.round(shortenedToChars / 1000)}k characters (DOCS_GEN_SECTION_MAX_CHARS).`
      : "";
  return (
    `${SHORTENED_NOTE_LEAD} The AI model reached the most it can write in one answer before ` +
    `it finished this section, ${what}${shortened}${omittedTopicsSentence(omittedTopics)} ` +
    `Topics it had not reached yet may be missing as well. Regenerate the document to write ` +
    `this section again; if it stops in the same place, ask an administrator to raise the ` +
    `AI model's answer limit.`
  );
}
