/**
 * #190 — splitting a large document into renderable sections without losing
 * code fences or heading anchors.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { remarkSectionSlugs, splitMarkdownSections } from "@/lib/markdown-sections";

function headingIds(html: string): string[] {
  return [...html.matchAll(/<h[1-6] id="([^"]*)"/g)].map((m) => m[1]);
}

/** Heading ids from ONE whole-document rehype-slug pass — the reference. */
function wholeDocumentIds(markdown: string): string[] {
  return headingIds(
    renderToStaticMarkup(
      createElement(
        ReactMarkdown,
        { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeSlug] },
        markdown,
      ),
    ),
  );
}

/** Heading ids when each section is rendered on its own with remarkSectionSlugs. */
function sectionedIds(markdown: string): string[] {
  return splitMarkdownSections(markdown).sections.flatMap((section) =>
    headingIds(
      renderToStaticMarkup(
        createElement(
          ReactMarkdown,
          {
            remarkPlugins: [
              remarkGfm,
              [remarkSectionSlugs, { occurrences: section.slugOccurrences }],
            ],
          },
          section.markdown,
        ),
      ),
    ),
  );
}

const DOC = [
  "# Title",
  "Intro text.",
  "## Rules",
  "### Edge Cases",
  "First.",
  "#### Edge Cases",
  "Nested duplicate.",
  "### Edge Cases",
  "Second.",
  "```md",
  "## Not a heading",
  "### Also not a heading",
  "```",
  "## Workflows",
  "~~~",
  "### Tilde fenced, not a heading",
  "~~~",
  "### Edge Cases",
  "Third.",
  "## `Code` and **bold** and [a link](https://example.com)",
].join("\n");

describe("splitMarkdownSections", () => {
  it("splits at H2/H3 only, never inside a code fence", () => {
    const { sections } = splitMarkdownSections(DOC);
    expect(sections.map((s) => s.heading?.text ?? "(preamble)")).toEqual([
      "(preamble)",
      "Rules",
      "Edge Cases",
      "Edge Cases",
      "Workflows",
      "Edge Cases",
      "Code and bold and a link",
    ]);
    // The fenced "## Not a heading" stayed inside its section, fence intact.
    expect(sections[3].markdown).toContain("```md\n## Not a heading\n### Also not a heading\n```");
    expect(sections[4].markdown).toContain("~~~\n### Tilde fenced, not a heading\n~~~");
    // Nothing is lost or duplicated.
    expect(sections.map((s) => s.markdown).join("\n")).toBe(DOC);
  });

  it("gives every section the heading ids a whole-document render gives", () => {
    expect(sectionedIds(DOC)).toEqual(wholeDocumentIds(DOC));
    expect(new Set(sectionedIds(DOC)).size).toBe(sectionedIds(DOC).length);
  });

  it("builds the table of contents from H1–H3 with the rendered ids", () => {
    const { toc, sectionOfId } = splitMarkdownSections(DOC);
    expect(toc.map((e) => [e.level, e.id, e.sectionIndex])).toEqual([
      [1, "title", 0],
      [2, "rules", 1],
      [3, "edge-cases", 2],
      [3, "edge-cases-2", 3],
      [2, "workflows", 4],
      [3, "edge-cases-3", 5],
      [2, "code-and-bold-and-a-link", 6],
    ]);
    const rendered = wholeDocumentIds(DOC);
    for (const entry of toc) expect(rendered).toContain(entry.id);
    // H4 anchors resolve to their section too, for deep links.
    expect(sectionOfId.get("edge-cases-1")).toBe(2);
  });

  it("keeps a document with no H2/H3 as one section", () => {
    const { sections } = splitMarkdownSections("# Only\n\nText\n#### Deep");
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBeUndefined();
  });

  it("does not open a fence on a backtick line that carries a backtick in its info", () => {
    const { sections } = splitMarkdownSections("## A\n```inline ` tick\n## B");
    expect(sections.map((s) => s.heading?.text)).toEqual(["A", "B"]);
  });

  it("closes a fence only with the same character and at least its length", () => {
    const { sections } = splitMarkdownSections("## A\n````\n```\n## Inside\n````\n## B");
    expect(sections.map((s) => s.heading?.text)).toEqual(["A", "B"]);
  });
});

/** #196 — headings whose inline markup or entities used to drift. */
const TRICKY = [
  "# Doc",
  "## _Emphasis_ heading",
  "## __Strong__ and *em* and ~~gone~~",
  "## Fish &amp; Chips",
  "## Caf&eacute; menu &copy; &#36;5",
  "### Escaped \\_underscore\\_ and \\*star\\*",
  "## `code_with_underscores` and <kbd>",
  "## ![logo](x.png) Brand [site](https://example.com)",
  "## _Emphasis_ heading",
  "Setext heading",
  "--------------",
].join("\n");

describe("heading ids with inline markup and entities (#196)", () => {
  it("the table of contents names the ids a whole-document rehype-slug render gives", () => {
    const { toc } = splitMarkdownSections(TRICKY);
    // The setext heading is not a split point; every ATX heading is listed.
    expect(toc.map((e) => e.id)).toEqual(wholeDocumentIds(TRICKY).slice(0, toc.length));
    expect(toc.map((e) => e.id)).toEqual([
      "doc",
      "emphasis-heading",
      "strong-and-em-and-gone",
      "fish--chips",
      "café-menu--5",
      "escaped-_underscore_-and-star",
      "code_with_underscores-and-",
      "-brand-site",
      "emphasis-heading-1",
    ]);
  });

  it("sectioned rendering gives the same ids as the whole-document render", () => {
    expect(sectionedIds(TRICKY)).toEqual(wholeDocumentIds(TRICKY));
  });

  it("the TOC shows the text a reader sees, not its markup", () => {
    expect(splitMarkdownSections(TRICKY).toc.map((e) => e.text)).toContain("Fish & Chips");
    expect(splitMarkdownSections(TRICKY).toc.map((e) => e.text)).toContain("Emphasis heading");
  });
});

describe("heading text", () => {
  it("is the text rehype-slug sees: no markers, no image alt, entities decoded", () => {
    const { toc } = splitMarkdownSections(
      "## **Bold** `code` ![img](x.png) [link](http://x)\n## _a_ &amp; b",
    );
    expect(toc.map((e) => e.text)).toEqual(["Bold code  link", "a & b"]);
  });
});
