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
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** A markdown AST node, as far as slugging needs one. */
export interface MdastNode {
  type: string;
  value?: string;
  depth?: number;
  children?: MdastNode[];
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

/** The parsed heading an ATX heading line produces, or `undefined`. */
function parseHeadingLine(line: string): MdastNode | undefined {
  const [first] = (headingParser.parse(line.trimStart()) as MdastNode).children ?? [];
  return first?.type === "heading" ? first : undefined;
}

export function splitMarkdownSections(markdown: string): SplitDocument {
  const slugger = new GithubSlugger();
  const sections: MarkdownSection[] = [];
  const toc: TocEntry[] = [];
  const sectionOfId = new Map<string, number>();

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

  let fence: { char: string; length: number } | null = null;
  for (const line of markdown.split("\n")) {
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
      lines.push(line);
      continue;
    }
    if (fenceMatch && !(fenceMatch[1][0] === "`" && fenceMatch[2].includes("`"))) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      lines.push(line);
      continue;
    }
    const match = HEADING.exec(line);
    const parsed = match ? parseHeadingLine(line) : undefined;
    if (match && parsed) {
      const level = match[1].length;
      const text = headingSlugText(parsed);
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
  return { sections, toc, sectionOfId };
}

/**
 * A remark plugin that gives every heading the id the splitter gave it:
 * {@link headingSlugText} of the parsed heading, de-duplicated by a counter
 * that continues from `occurrences` (the whole document's counts before this
 * section) instead of starting at zero.
 */
export function remarkSectionSlugs(options: { occurrences: Readonly<Record<string, number>> }) {
  return (tree: MdastNode) => {
    const slugger = new GithubSlugger();
    slugger.occurrences = { ...options.occurrences };
    const visit = (node: MdastNode) => {
      if (node.type === "heading") {
        const hProperties = node.data?.hProperties ?? {};
        if (!hProperties.id) {
          node.data = {
            ...node.data,
            hProperties: { ...hProperties, id: slugger.slug(headingSlugText(node)) },
          };
        }
        return;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
