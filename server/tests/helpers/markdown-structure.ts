/**
 * What a Markdown document IS, according to a real parser: micromark with the
 * GitHub Flavored Markdown extensions (CommonMark + autolink literals, task
 * lists, tables, strikethrough, footnotes).
 *
 * Tests that assert "METIS's Markdown cannot be made to mean something else"
 * read the parsed structure from here. A hand-written scan for code spans gets
 * inline structure right and cannot see block structure at all — a link
 * reference definition (`[label]: destination`) is found before any inline
 * content is read, and its label ends at the first `]` whatever backticks came
 * before it (#1102 review, cycle 2).
 */
import { parse, postprocess, preprocess } from "micromark";
import { gfm } from "micromark-extension-gfm";

/** One construct the parser found: its token type and where it sits in the source. */
export interface MdToken {
  type: string;
  start: number;
  end: number;
  text: string;
}

/** Every token of `markdown`, in document order (outer before inner). */
export function markdownTokens(markdown: string): MdToken[] {
  const events = postprocess(
    parse({ extensions: [gfm()] })
      .document()
      .write(preprocess()(markdown, undefined, true)),
  );
  const tokens: MdToken[] = [];
  for (const [kind, token, context] of events) {
    if (kind !== "enter") continue;
    tokens.push({
      type: token.type,
      start: token.start.offset,
      end: token.end.offset,
      text: context.sliceSerialize(token),
    });
  }
  return tokens;
}

/** The tokens of the given types. */
export function ofType(tokens: readonly MdToken[], ...types: string[]): MdToken[] {
  return tokens.filter((t) => types.includes(t.type));
}

/** The tokens that lie wholly inside `[start, end)`. */
export function within(tokens: readonly MdToken[], start: number, end: number): MdToken[] {
  return tokens.filter((t) => t.start >= start && t.end <= end);
}

/** `source[start, end)` with the given token ranges cut out. */
export function without(
  source: string,
  ranges: ReadonlyArray<Pick<MdToken, "start" | "end">>,
  start = 0,
  end = source.length,
): string {
  let out = "";
  let at = start;
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    if (r.start < at || r.end > end) continue;
    out += source.slice(at, r.start);
    at = r.end;
  }
  return out + source.slice(at, end);
}

/**
 * How many of each block and inline construct a document holds — everything
 * but code spans and links, which callers check one by one. Two documents with
 * the same counts have the same headings, lists, quotes, task items, HTML,
 * images, autolinks, definitions, tables, emphasis and code blocks.
 */
const COUNTED = [
  "atxHeading",
  "setextHeading",
  "blockQuote",
  "listUnordered",
  "listOrdered",
  "taskListCheck",
  "thematicBreak",
  "htmlFlow",
  "htmlText",
  "definition",
  "image",
  "autolink",
  "literalAutolink",
  "codeFenced",
  "codeIndented",
  "emphasis",
  "strong",
  "strikethrough",
  "table",
  "gfmFootnoteCall",
  "gfmFootnoteDefinition",
  "characterReference",
  "hardBreakEscape",
  "hardBreakTrailing",
] as const;

export function structureCounts(tokens: readonly MdToken[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(COUNTED.map((t) => [t, 0]));
  for (const t of tokens) if (t.type in counts) counts[t.type]! += 1;
  return counts;
}
