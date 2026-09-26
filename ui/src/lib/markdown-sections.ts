/**
 * #190 — split a large markdown document into independently renderable
 * sections, and give every heading the id a single whole-document render
 * would have given it.
 *
 * A 600k-character generated document cannot be rendered in one react-markdown
 * pass without freezing the page, so the previewer renders it section by
 * section. Two things have to survive that split:
 *
 * - **Anchors.** `rehype-slug` de-duplicates heading ids with a counter, so a
 *   second "Edge Cases" heading becomes `edge-cases-1`. Rendered per section,
 *   every section starts that counter again and the ids collide. Each section
 *   therefore carries the slug counts of every heading before it, and
 *   {@link rehypeSectionSlugs} continues from there.
 * - **Code fences.** A `## ` line inside a fenced code block is not a heading,
 *   and splitting there would cut the fence in two.
 *
 * #196 — the splitter's ids (TOC links, pending-section anchors, deep-link
 * lookup) and the rendered ids come from ONE function, {@link headingSlugText},
 * applied to the same parsed heading. The splitter parses each heading line
 * with the renderer's own markdown grammar, so `_emphasis_`, `&amp;` and the
 * like reduce to the text the reader sees on both sides.
 *
 * #227 — a reference link (`[text][ref]`) or a footnote reference (`[^1]`)
 * resolves only against a definition the parser can see. The renderer parses
 * one section at a time and the splitter one heading line at a time, so both
 * re-parse a bracketed heading beside the document's definitions of the labels
 * it names ({@link SplitDocument.definitions}); the id no longer depends on
 * which section a definition happens to sit in.
 */
import GithubSlugger from "github-slugger";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

export interface MarkdownHeading {
  id: string;
  text: string;
  level: number;
}

export interface MarkdownSection {
  index: number;
  markdown: string;
  /** The H2/H3 the section starts with, when it starts with one. */
  heading?: MarkdownHeading;
  /** Ids of every heading in the section (all levels), in document order. */
  headingIds: string[];
  /** Slug occurrence counts of every heading BEFORE this section. */
  slugOccurrences: Readonly<Record<string, number>>;
}

export interface TocEntry extends MarkdownHeading {
  sectionIndex: number;
}

export interface SplitDocument {
  sections: MarkdownSection[];
  /** H1–H3 headings, for the table of contents. */
  toc: TocEntry[];
  /** Every heading id (all levels) → the section that contains it. */
  sectionOfId: Map<string, number>;
  /** Every definition in the document, for {@link headingText}. */
  definitions: Definitions;
}

/**
 * Normalized label (`spec`, `^1`) → a synthetic definition of it, for every
 * link-reference and footnote label defined anywhere in a document.
 */
export type Definitions = ReadonlyMap<string, string>;

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A link-reference (`[label]: url`) or footnote (`[^label]: text`) definition line. */
const DEFINITION = /^ {0,3}\[((?:[^\\[\]]|\\.)+)\]:(?:[ \t]|$)/;
/** A bracketed run in a heading: a candidate reference or footnote label. */
const BRACKETED = /\[([^[\]]+)\]/g;

/** A label as the markdown parser matches it: whitespace collapsed, case folded. */
function normalizeLabel(label: string): string {
  // Lower then upper, exactly as micromark's normalizeIdentifier does: some
  // characters (e.g. `ẞ`) only fold together through both steps.
  return label
    .replace(/[\t\n\r ]+/g, " ")
    .trim()
    .toLowerCase()
    .toUpperCase();
}

/**
 * A line-by-line fence tracker: returns true for a line that opens, sits
 * inside, or closes a fenced code block — where nothing is a heading or a
 * definition.
 */
function fenceTracker(): (line: string) => boolean {
  let fence: { char: string; length: number } | null = null;
  return (line) => {
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.char &&
        fenceMatch[1].length >= fence.length &&
        fenceMatch[2].trim() === ""
      ) {
        fence = null;
      }
      return true;
    }
    if (fenceMatch && !(fenceMatch[1][0] === "`" && fenceMatch[2].includes("`"))) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      return true;
    }
    return false;
  };
}

/**
 * Every definition label in the document. A definition cannot interrupt a
 * paragraph, so a definition-shaped line counts only where a block may start:
 * after a blank line, a heading, a fence or a link definition. A footnote
 * definition's text is a paragraph, so after one only another footnote
 * definition starts; a link definition there is continuation.
 */
function collectDefinitions(markdown: string): Definitions {
  const definitions = new Map<string, string>();
  const inFence = fenceTracker();
  let after: "block" | "footnote" | "text" = "block";
  for (const line of markdown.split("\n")) {
    if (inFence(line)) {
      after = "block";
      continue;
    }
    const label = DEFINITION.exec(line)?.[1];
    const footnote = label?.startsWith("^") ?? false;
    if (label && (after === "block" || (after === "footnote" && footnote))) {
      definitions.set(normalizeLabel(label), `[${label}]: x`);
      after = footnote ? "footnote" : "block";
    } else {
      after = line.trim() === "" || HEADING.test(line) ? "block" : "text";
    }
  }
  return definitions;
}

/** A markdown AST node, as far as slugging needs one. */
export interface MdastNode {
  type: string;
  value?: string;
  depth?: number;
  children?: MdastNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  data?: { hProperties?: Record<string, unknown> } & Record<string, unknown>;
}

/**
 * The text a heading's id is slugged from: what the reader sees, with
 * emphasis, code, link and entity syntax resolved. Image alt text and raw
 * inline HTML are excluded, because neither renders as heading text (the
 * previewer does not render raw HTML), so ids match what `rehype-slug` gives a
 * whole-document render. The ONLY source of heading ids, used by both the
 * splitter and {@link remarkSectionSlugs}.
 */
export function headingSlugText(node: MdastNode): string {
  if (node.type === "html" || node.type === "image" || node.type === "imageReference") return "";
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(headingSlugText).join("");
}

/** Parses markdown with the same grammar extensions the previewer renders with. */
const headingParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).freeze();

/** The heading `source` parses to (as the first block), or `undefined`. */
function parseHeading(source: string): MdastNode | undefined {
  const [first] = (headingParser.parse(source.trimStart()) as MdastNode).children ?? [];
  return first?.type === "heading" ? first : undefined;
}

/**
 * The text a heading's id is slugged from, given its parsed `heading`, its
 * markdown `source` and the document's {@link SplitDocument.definitions}. A
 * heading naming a defined label is re-parsed beside those definitions (only
 * those: the cost stays per heading, not per heading × definition), so a
 * reference link resolves to its text and a footnote reference drops out
 * whether or not the definition was in the parse that produced `heading`. The
 * ONLY way either side computes a heading's text.
 */
export function headingText(heading: MdastNode, source: string, definitions: Definitions): string {
  const named = new Set<string>();
  for (const [, label] of source.matchAll(BRACKETED)) {
    const definition = definitions.get(normalizeLabel(label));
    if (definition) named.add(definition);
  }
  if (named.size > 0) {
    // Blank-line separated, so no definition reads as continuing another.
    const resolved = parseHeading(`${source}\n\n${[...named].join("\n\n")}`);
    if (resolved) return headingSlugText(resolved);
  }
  return headingSlugText(heading);
}

export function splitMarkdownSections(markdown: string): SplitDocument {
  const slugger = new GithubSlugger();
  const sections: MarkdownSection[] = [];
  const toc: TocEntry[] = [];
  const sectionOfId = new Map<string, number>();
  const definitions = collectDefinitions(markdown);

  let lines: string[] = [];
  let current: Omit<MarkdownSection, "markdown" | "index"> = {
    headingIds: [],
    slugOccurrences: {},
  };
  const flush = () => {
    const text = lines.join("\n");
    if (text.trim() !== "" || current.heading) {
      sections.push({ ...current, index: sections.length, markdown: text });
    }
    lines = [];
  };

  const inFence = fenceTracker();
  for (const line of markdown.split("\n")) {
    if (inFence(line)) {
      lines.push(line);
      continue;
    }
    const match = HEADING.exec(line);
    const parsed = match ? parseHeading(line) : undefined;
    if (match && parsed) {
      const level = match[1].length;
      const text = headingText(parsed, line, definitions);
      if (level === 2 || level === 3) {
        flush();
        current = { headingIds: [], slugOccurrences: { ...slugger.occurrences } };
      }
      const id = slugger.slug(text);
      const heading = { id, text, level };
      if ((level === 2 || level === 3) && lines.length === 0) current.heading = heading;
      current.headingIds.push(id);
      sectionOfId.set(id, sections.length);
      if (level <= 3) toc.push({ ...heading, sectionIndex: sections.length });
    }
    lines.push(line);
  }
  flush();
  return { sections, toc, sectionOfId, definitions };
}

/**
 * A remark plugin that gives every heading the id the splitter gave it:
 * {@link headingText} of the heading's own source span, de-duplicated by a
 * counter that continues from `occurrences` (the whole document's counts
 * before this section) instead of starting at zero.
 */
export function remarkSectionSlugs(options: {
  occurrences: Readonly<Record<string, number>>;
  /** The document's {@link SplitDocument.definitions}. */
  definitions: Definitions;
}) {
  return (tree: MdastNode, file: { value?: unknown }) => {
    const slugger = new GithubSlugger();
    slugger.occurrences = { ...options.occurrences };
    // react-markdown passes a string; a byte buffer is decoded the way
    // remark-parse decodes it, so node offsets index the same text.
    const markdown =
      // `isView`, not `instanceof`: a buffer from another realm is still bytes.
      ArrayBuffer.isView(file.value)
        ? new TextDecoder().decode(file.value)
        : String(file.value ?? "");
    const visit = (node: MdastNode) => {
      if (node.type === "heading") {
        const hProperties = node.data?.hProperties ?? {};
        if (!hProperties.id) {
          // Slug the heading as parsed from its OWN source, like the splitter
          // does: `node` was parsed with its whole section, so a definition in
          // that section the collector missed would resolve here and not
          // there. A heading with no source span (made by another plugin)
          // keeps its own text.
          const { start, end } = node.position ?? {};
          const source = markdown.slice(start?.offset ?? 0, end?.offset ?? 0);
          const text = headingText(parseHeading(source) ?? node, source, options.definitions);
          node.data = {
            ...node.data,
            hProperties: { ...hProperties, id: slugger.slug(text) },
          };
        }
        return;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
