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
 */
import GithubSlugger from "github-slugger";

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

/**
 * The plain text `rehype-slug` sees for a heading's inline markdown: link and
 * image syntax reduced to their text, emphasis and code markers dropped.
 */
export function headingText(inline: string): string {
  return inline
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim();
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
    if (match) {
      const level = match[1].length;
      const text = headingText(match[2]);
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

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function hastText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

/**
 * A `rehype-slug` that continues the whole document's de-duplication counter
 * from `occurrences` instead of starting at zero, so a section rendered on its
 * own gets the ids a single whole-document render would have produced.
 */
export function rehypeSectionSlugs(options: { occurrences: Readonly<Record<string, number>> }) {
  return (tree: HastNode) => {
    const slugger = new GithubSlugger();
    slugger.occurrences = { ...options.occurrences };
    const visit = (node: HastNode) => {
      if (node.type === "element" && /^h[1-6]$/.test(node.tagName ?? "")) {
        node.properties = node.properties ?? {};
        if (!node.properties.id) node.properties.id = slugger.slug(hastText(node));
        return;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
