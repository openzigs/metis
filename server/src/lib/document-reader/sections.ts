/**
 * #2230 — the document reader's view of a parsed document: its sections in
 * order, each with the heading path it sits under, and the batches the reader
 * asks the model about.
 *
 * Sections come from the governing rule reader's `splitSections` (every
 * Markdown heading starts one; a section over its `MAX_SECTION_CHARS` is split
 * at paragraph breaks), so both readers cut a document the same way. The
 * heading path is added here: `["3 Booking", "3.2 Cancellation"]` for a `###`
 * under a `##`, so a section read on its own still says where it sits.
 */
import { splitSections } from "../governing/rule-extraction.js";

export interface ReaderSection {
  /** `S1`, `S2`, ... in document order. */
  id: string;
  /** Offsets into the parsed text: `text === source.slice(start, end)`. */
  start: number;
  end: number;
  /** The headings above this section, outermost first; `["(start)"]` before the first heading. */
  headingPath: string[];
  text: string;
}

// As `rule-extraction.ts`'s HEADING, with the level captured.
const HEADING = /^(#{1,6})[ \t]+(.*)$/gm;

function stripHeadingTail(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === " " || s[end - 1] === "\t" || s[end - 1] === "#")) end--;
  return s.slice(0, end).trim();
}

interface HeadingMark {
  at: number;
  path: string[];
}

/** Every non-blank heading's offset and the path it opens, in order. */
function headingMarks(text: string): HeadingMark[] {
  const marks: HeadingMark[] = [];
  const stack: Array<{ level: number; heading: string }> = [];
  for (const m of text.matchAll(HEADING)) {
    const heading = stripHeadingTail(m[2]!);
    if (!heading) continue;
    const level = m[1]!.length;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, heading });
    marks.push({ at: m.index, path: stack.map((s) => s.heading) });
  }
  return marks;
}

/** The document's sections in order, each with its heading path. */
export function outlineSections(text: string): ReaderSection[] {
  const marks = headingMarks(text);
  let mark = -1;
  return splitSections(text).map((section, i) => {
    while (mark + 1 < marks.length && marks[mark + 1]!.at <= section.start) mark++;
    return {
      id: `S${i + 1}`,
      start: section.start,
      end: section.end,
      headingPath: mark >= 0 ? marks[mark]!.path : [section.heading],
      text: section.text,
    };
  });
}

/** `A › B › C`, the form a heading path is shown and sent in. */
export function formatHeadingPath(path: readonly string[]): string {
  return path.join(" › ");
}

/** The section holding offset `at`, or `undefined` when none does. */
export function sectionAt(
  sections: readonly ReaderSection[],
  at: number,
): ReaderSection | undefined {
  return sections.find((s) => at >= s.start && at < s.end);
}

/**
 * Consecutive sections grouped until a group's text reaches `maxChars`: each
 * group is one call's worth of requirements to write. A section longer than
 * `maxChars` is a group of its own (`splitSections` already bounds it).
 */
export function batchSections(
  sections: readonly ReaderSection[],
  maxChars: number,
): ReaderSection[][] {
  const batches: ReaderSection[][] = [];
  let current: ReaderSection[] = [];
  let chars = 0;
  for (const section of sections) {
    const size = section.end - section.start;
    if (current.length > 0 && chars + size > maxChars) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(section);
    chars += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
