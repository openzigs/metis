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
 *
 * #228 — the same holds for a section's BODY. A section is rendered with the
 * source of every definition it names prepended ({@link withDefinitions}), so
 * `[text][ref]` and `[^1]` resolve wherever their definition sits. Footnotes
 * get ONE document-level list, as a whole-document render gives them: each
 * section drops the list remark-rehype would give it and renumbers its
 * references document-wide ({@link rehypeSectionFootnotes}), and the list is
 * rendered once, after every section ({@link footnoteListMarkdown}), so no
 * `#footnote-label` or `fn-*` id is repeated.
 *
 * #522 — a section's footnote references are counted from its parse
 * ({@link footnoteReferences}), exactly the parse it is rendered from, not by
 * scanning its lines: an escaped `\[^1]`, or a `[^1]` in raw HTML or indented
 * code, is not a reference, and one after an invalid definition is.
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
  /** Footnote key → references to it BEFORE this section (#228). */
  footnotesBefore: Readonly<Record<string, number>>;
}

export interface TocEntry extends MarkdownHeading {
  sectionIndex: number;
}

export interface SplitDocument {
  sections: MarkdownSection[];
  /** H1–H3 headings, for the table of contents. */
  toc: TocEntry[];
  /**
   * Every heading id (all levels) and every footnote reference id
   * (`user-content-fnref-*`, #228) → the section that contains it.
   */
  sectionOfId: Map<string, number>;
  /** Every definition in the document, for {@link headingText} and {@link withDefinitions}. */
  definitions: Definitions;
  /** The document's footnote references to defined footnotes (#228). */
  footnotes: {
    /** Footnote key → its number: the order of its first reference in the document. */
    order: ReadonlyMap<string, number>;
    /** Every reference's label (`^1`), in document order. */
    references: readonly string[];
  };
}

/**
 * Normalized label (`SPEC`, `^1`) → the markdown source of its FIRST
 * definition (the one a markdown parser uses), for every link-reference and
 * footnote label defined anywhere in a document.
 */
export type Definitions = ReadonlyMap<string, string>;

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A link-reference (`[label]: url`) or footnote (`[^label]: text`) definition line. */
const DEFINITION = /^ {0,3}\[((?:[^\\[\]]|\\.)+)\]:(?:[ \t]|$)/;
/** A bracketed run: a candidate reference or footnote label. */
const BRACKETED = /\[([^[\]]+)\]/g;
/** Content indented into a footnote definition. */
const INDENTED = /^(?: {4}|\t)/;
/** A line that starts a block, so it cannot continue a footnote's paragraph. */
const BLOCK_START = /^ {0,3}(?:>|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|(?:[-*_][ \t]*){3,}$|<)/;

/** Parses markdown with the same grammar extensions the previewer renders with. */
const headingParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).freeze();

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
 * Where the footnote definition starting at line `start` ends (exclusive): its
 * text continues through lazy continuation lines and, past blank lines,
 * through lines indented into it.
 */
function footnoteEnd(lines: string[], fenced: boolean[], start: number): number {
  let end = start + 1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const lazy =
      i === end &&
      !fenced[i] &&
      !HEADING.test(line) &&
      !BLOCK_START.test(line) &&
      !DEFINITION.exec(line)?.[1].startsWith("^");
    if (!lazy && !INDENTED.test(line)) break;
    end = i + 1;
  }
  return end;
}

/**
 * Where the link definition starting at line `start` ends (exclusive), as the
 * parser reads it (label, destination and title span at most three lines), or
 * `undefined` when the line does not start a valid definition: a bare
 * `[label]:` whose next line is no destination is a paragraph (#522).
 */
function linkDefinitionEnd(lines: string[], start: number): number | undefined {
  const source = lines.slice(start, start + 3).join("\n");
  const [first] = (headingParser.parse(source) as MdastNode).children ?? [];
  if (first?.type !== "definition") return undefined;
  return start + (first.position?.end?.line ?? 1);
}

/**
 * Every definition in the document, and the lines they occupy. A definition
 * cannot interrupt a paragraph, so a definition-shaped line counts only where
 * a block may start: after a blank line, a heading, a fence or another
 * definition. A footnote definition's text is a paragraph, so a
 * definition-shaped line continuing it is part of it, unless it is another
 * footnote definition.
 */
function collectDefinitions(lines: string[]): Definitions {
  const definitions = new Map<string, string>();
  const inFence = fenceTracker();
  const fenced = lines.map((line) => inFence(line));
  let atBlock = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fenced[i]) {
      atBlock = true;
      continue;
    }
    const label = DEFINITION.exec(line)?.[1];
    const end =
      label && atBlock
        ? label.startsWith("^")
          ? footnoteEnd(lines, fenced, i)
          : linkDefinitionEnd(lines, i)
        : undefined;
    if (label && end !== undefined) {
      const key = normalizeLabel(label);
      if (!definitions.has(key)) definitions.set(key, lines.slice(i, end).join("\n"));
      i = end - 1;
      atBlock = true;
    } else {
      atBlock = line.trim() === "" || HEADING.test(line);
    }
  }
  return definitions;
}

/**
 * The source of every definition `markdown` names, prepended to it, so a
 * reference resolves when it is parsed alone. A supplied footnote's own
 * references are supplied too. Definitions render nothing, and each label's
 * source is its document-first definition, so it wins over any later one in
 * `markdown`, as it does in a whole-document parse.
 */
export function withDefinitions(markdown: string, definitions: Definitions): string {
  const supplied = new Set<string>();
  const pending = [markdown];
  for (let text = pending.pop(); text !== undefined; text = pending.pop()) {
    for (const [, label] of text.matchAll(BRACKETED)) {
      const definition = definitions.get(normalizeLabel(label));
      if (definition && !supplied.has(definition)) {
        supplied.add(definition);
        pending.push(definition);
      }
    }
  }
  // Blank-line separated, so no definition reads as continuing another.
  return supplied.size > 0 ? `${[...supplied].join("\n\n")}\n\n${markdown}` : markdown;
}

/** A markdown AST node, as far as slugging needs one. */
export interface MdastNode {
  type: string;
  value?: string;
  label?: string;
  depth?: number;
  children?: MdastNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number; line?: number } };
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
/**
 * The labels (`1`, `Note`) of the footnote references `markdown` renders in
 * its body, in document order, as the renderer parses it: beside the
 * definitions it names ({@link withDefinitions}). A footnote definition's own
 * references are left out; the footnote list numbers them after the body's, as
 * a whole-document render does.
 */
function footnoteReferences(markdown: string, definitions: Definitions): string[] {
  // Every reference starts `[^`: a section without one needs no parse.
  if (!markdown.includes("[^")) return [];
  const labels: string[] = [];
  const visit = (node: MdastNode) => {
    if (node.type === "footnoteDefinition") return;
    if (node.type === "footnoteReference" && node.label !== undefined) labels.push(node.label);
    node.children?.forEach(visit);
  };
  visit(headingParser.parse(withDefinitions(markdown, definitions)) as MdastNode);
  return labels;
}

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
  const source = markdown.split("\n");
  const definitions = collectDefinitions(source);
  const footnoteCounts: Record<string, number> = {};
  const order = new Map<string, number>();
  const references: string[] = [];

  let lines: string[] = [];
  let current: Omit<MarkdownSection, "markdown" | "index"> = {
    headingIds: [],
    slugOccurrences: {},
    footnotesBefore: {},
  };
  const flush = () => {
    const text = lines.join("\n");
    if (text.trim() !== "" || current.heading) {
      for (const label of footnoteReferences(text, definitions)) {
        const key = normalizeLabel(`^${label}`);
        if (!order.has(key)) order.set(key, order.size + 1);
        const count = (footnoteCounts[key] ?? 0) + 1;
        footnoteCounts[key] = count;
        references.push(`^${label}`);
        // The footnote list's back-link lands here, so reaching the list first
        // must still be able to render this section (#228).
        const id = footnoteReferenceId(key, count);
        if (!sectionOfId.has(id)) sectionOfId.set(id, sections.length);
      }
      sections.push({ ...current, index: sections.length, markdown: text });
    }
    lines = [];
  };

  const inFence = fenceTracker();
  for (const line of source) {
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
        current = {
          headingIds: [],
          slugOccurrences: { ...slugger.occurrences },
          footnotesBefore: { ...footnoteCounts },
        };
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
  return { sections, toc, sectionOfId, definitions, footnotes: { order, references } };
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

/** A hast node, as far as footnote rewriting needs one. */
export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** remark-rehype's default `clobberPrefix` on footnote ids. */
const FOOTNOTE_HREF = "#user-content-fn-";

/**
 * micromark's `normalizeUri`, which mdast-util-to-hast applies to a footnote
 * identifier to make its ids (`micromark-util-sanitize-uri`, not a direct
 * dependency of this package): percent-encode everything but URL-safe ASCII,
 * keeping any valid `%XX` escape as it is.
 */
function normalizeUri(value: string): string {
  const alphanumeric = (code: number) =>
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  let result = "";
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    let replace = "";
    let skip = 0;
    if (
      code === 37 &&
      alphanumeric(value.charCodeAt(index + 1)) &&
      alphanumeric(value.charCodeAt(index + 2))
    ) {
      skip = 2;
    } else if (code < 128) {
      if (!/[!#$&-;=?-Z_a-z~]/.test(String.fromCharCode(code))) replace = String.fromCharCode(code);
    } else if (code > 55_295 && code < 57_344) {
      const next = value.charCodeAt(index + 1);
      if (code < 56_320 && next > 56_319 && next < 57_344) {
        replace = String.fromCharCode(code, next);
        skip = 1;
      } else {
        replace = "\uFFFD";
      }
    } else {
      replace = String.fromCharCode(code);
    }
    if (replace) {
      result += value.slice(start, index) + encodeURIComponent(replace);
      start = index + skip + 1;
    }
    index += skip;
  }
  return result + value.slice(start);
}

/**
 * The id of the `count`-th reference to footnote `key` (`^LABEL`) in a
 * whole-document render: what {@link rehypeSectionFootnotes} gives it and the
 * footnote list's back-link points at.
 */
export function footnoteReferenceId(key: string, count: number): string {
  // mdast-util-to-hast's case round trip on the identifier, exactly.
  const safeId = normalizeUri(key.slice(1).toLowerCase().toUpperCase().toLowerCase());
  return `user-content-fnref-${safeId}${count > 1 ? `-${count}` : ""}`;
}

/** A footnote list remark-rehype appended to a render. */
function isFootnoteList(node: HastNode): boolean {
  return node.type === "element" && node.properties?.dataFootnotes === true;
}

/**
 * A rehype plugin for one section's render: drops the footnote list
 * remark-rehype gives the section (the document's list is rendered once,
 * from {@link footnoteListMarkdown}), and gives each footnote reference its
 * document-wide number and a reference id that continues counting from
 * `before`, so a note cited in two sections keeps distinct backlink targets.
 */
export function rehypeSectionFootnotes(options: {
  /** {@link SplitDocument.footnotes}' `order`. */
  order: ReadonlyMap<string, number>;
  /** The section's {@link MarkdownSection.footnotesBefore}. */
  before: Readonly<Record<string, number>>;
}) {
  return (tree: HastNode) => {
    const seen: Record<string, number> = { ...options.before };
    const visit = (node: HastNode) => {
      if (!node.children) return;
      node.children = node.children.filter((child) => !isFootnoteList(child));
      for (const child of node.children) {
        const properties = child.properties;
        const href = properties?.dataFootnoteRef ? String(properties.href ?? "") : "";
        if (!properties || !href.startsWith(FOOTNOTE_HREF)) {
          visit(child);
          continue;
        }
        const safeId = href.slice(FOOTNOTE_HREF.length);
        let label = safeId;
        try {
          label = decodeURIComponent(safeId);
        } catch {
          // Not percent-encoding after all: the id is the label.
        }
        const key = normalizeLabel(`^${label}`);
        const count = (seen[key] ?? 0) + 1;
        seen[key] = count;
        properties.id = `user-content-fnref-${safeId}${count > 1 ? `-${count}` : ""}`;
        const number = options.order.get(key);
        if (number !== undefined) child.children = [{ type: "text", value: String(number) }];
      }
    };
    visit(tree);
  };
}

/**
 * The markdown whose render (with {@link rehypeFootnoteList}) is the
 * document's footnote list: every footnote reference in document order, so
 * numbering and backlinks match a whole-document render, beside the
 * definitions they need. `null` when the document references no footnote.
 */
export function footnoteListMarkdown(doc: SplitDocument): string | null {
  const { references } = doc.footnotes;
  if (references.length === 0) return null;
  return withDefinitions(references.map((label) => `[${label}]`).join(" "), doc.definitions);
}

/** A rehype plugin that keeps only the footnote list of a render. */
export function rehypeFootnoteList() {
  return (tree: HastNode) => {
    tree.children = (tree.children ?? []).filter(isFootnoteList);
  };
}
