/**
 * #190 — splitting a large document into renderable sections without losing
 * code fences or heading anchors.
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  footnoteListMarkdown,
  rehypeFootnoteList,
  rehypeSectionFootnotes,
  remarkSectionSlugs,
  splitMarkdownSections,
  withDefinitions,
  type MdastNode,
} from "@/lib/markdown-sections";

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
  const { sections, definitions } = splitMarkdownSections(markdown);
  return sections.flatMap((section) =>
    headingIds(
      renderToStaticMarkup(
        createElement(
          ReactMarkdown,
          {
            remarkPlugins: [
              remarkGfm,
              [remarkSectionSlugs, { occurrences: section.slugOccurrences, definitions }],
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

  // #548 review: a definition-shaped line that is not a definition, at a
  // block start in a run with no blank lines, must not reparse the rest of the
  // run each time, or sectioning goes quadratic and freezes the main thread.
  // Counts the source handed to the parser, so the bound is deterministic.
  it("parses a run of non-definition `[x]:` lines in linear, not quadratic, source", () => {
    const markdown = Array.from({ length: 400 }, (_, n) => `### h${n}\n[x]:`).join("\n");
    const parse = vi.spyOn(Object.getPrototypeOf(unified()), "parse");
    try {
      splitMarkdownSections(markdown);
      // PR #556 review: a spy that never fires would read 0 and pass vacuously.
      expect(parse).toHaveBeenCalled();
      const parsed = parse.mock.calls.reduce((sum, [file]) => sum + String(file).length, 0);
      expect(parsed).toBeLessThan(10 * markdown.length);
    } finally {
      parse.mockRestore();
    }
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

/**
 * #227 — a reference link or a footnote reference in a heading. The renderer
 * parses one section at a time, so whether `[x][ref]` or `[^1]` resolved used
 * to depend on whether its definition sat in the same section, while the
 * splitter parsed the heading line alone and resolved neither.
 */
const REFERENCES = [
  "# Doc",
  "## See [the spec][spec]",
  "#### Detail [the spec][spec]",
  "Body.",
  "",
  "[spec]: https://example.com/spec",
  "## Rules[^1]",
  "Body with a note.[^1]",
  "",
  "[^1]: A footnote.",
  "## Both [the spec][spec] and a note[^2]",
  "Body.",
  "## Later [the Spec][SPEC]",
  "Body.",
  "## Notes[^2]",
  "Body.",
  "## Earlier [text][late]",
  "## Swallowed [s][swallowed]",
  "## Spaced [x][the   Spec]",
  "## Order[^1] [y][spec]",
  "## Unknown [label][nowhere] and [^9]",
  "Body.",
  "```md",
  "",
  "[fenced]: https://example.com/not-a-definition",
  "```",
  "## Fenced [ref][fenced]",
  "## Lazy [x][lazy]",
  "Body.",
  "[lazy]: https://example.com/continues-the-paragraph",
  "## Definitions",
  "[^2]: Second note.",
  "",
  "[late]: https://example.com/late",
  "[the spec]: https://example.com/the-spec",
  "[^3]: Third note.",
  "[swallowed]: https://example.com/continues-the-footnote",
].join("\n");
/** Every heading id, all levels, in document order. */
const REFERENCE_IDS = [
  "doc",
  "see-the-spec",
  "detail-the-spec",
  "rules",
  "both-the-spec-and-a-note",
  "later-the-spec",
  "notes",
  "earlier-text",
  "swallowed-sswallowed",
  "spaced-x",
  "order-y",
  "unknown-labelnowhere-and-9",
  "fenced-reffenced",
  "lazy-xlazy",
  "definitions",
];
/** The H4 is not a TOC entry. */
const REFERENCE_TOC_IDS = REFERENCE_IDS.filter((id) => id !== "detail-the-spec");

describe("heading ids with reference links and footnote references (#227)", () => {
  it("the TOC ids resolve reference links and drop footnote references", () => {
    expect(splitMarkdownSections(REFERENCES).toc.map((e) => e.id)).toEqual(REFERENCE_TOC_IDS);
  });

  it("sectioned rendering gives every heading the id the splitter gave it", () => {
    expect(sectionedIds(REFERENCES)).toEqual(REFERENCE_IDS);
  });

  it("a reference link resolves exactly where a whole-document render resolves it", () => {
    const whole = wholeDocumentIds(REFERENCES);
    for (const id of [
      "see-the-spec",
      "detail-the-spec",
      "later-the-spec",
      "earlier-text",
      "spaced-x",
      // Definition-shaped lines that define nothing: inside a fence, continuing
      // a paragraph, or continuing a footnote definition's text.
      "fenced-reffenced",
      "lazy-xlazy",
      "swallowed-sswallowed",
    ]) {
      expect(whole).toContain(id);
    }
  });

  it("the TOC shows the reference link's text, not its brackets", () => {
    const texts = splitMarkdownSections(REFERENCES).toc.map((e) => e.text);
    expect(texts).toContain("See the spec");
    expect(texts).toContain("Rules");
    expect(texts).toContain("Both the spec and a note");
  });

  it("every heading id maps to the section that holds it", () => {
    const { sectionOfId, sections } = splitMarkdownSections(REFERENCES);
    for (const id of REFERENCE_IDS) {
      expect(sections[sectionOfId.get(id)!].headingIds).toContain(id);
    }
  });

  it("a heading with no source span keeps the text of its own node", () => {
    const heading = { type: "heading", depth: 2, children: [{ type: "text", value: "A [b][c]" }] };
    remarkSectionSlugs({ occurrences: {}, definitions: new Map([["C", "[c]: x"]]) })(
      { type: "root", children: [heading] },
      {},
    );
    expect((heading as MdastNode).data?.hProperties?.id).toBe("a-bc");
  });

  it("a document with no definitions keeps bracketed heading text literal", () => {
    const { toc, definitions } = splitMarkdownSections("## A [b][c]\n## D[^1]");
    expect(definitions.size).toBe(0);
    expect(toc.map((e) => e.id)).toEqual(["a-bc", "d1"]);
  });
});

/**
 * #227 review — a definition in the heading's OWN section that the definition
 * collector does not see (after a thematic break or indented code, inside a
 * blockquote or a list item). The renderer's parse of the section sees it; the
 * splitter's parse of the heading line alone does not. Both sides must still
 * slug the same input, so the TOC id and the rendered id agree.
 */
describe("heading ids when a same-section definition is not collected (#227)", () => {
  it.each([
    [
      "after a thematic break",
      "## See [the spec][spec]\nBody.\n\n---\n[spec]: https://example.com",
    ],
    ["inside a blockquote", "## See [the spec][spec]\nBody.\n\n> [spec]: https://example.com"],
    ["inside a list item", "## See [the spec][spec]\nBody.\n\n- [spec]: https://example.com"],
    [
      "after an indented code block",
      "## See [the spec][spec]\nBody.\n\n    code\n[spec]: https://example.com",
    ],
    ["footnote inside a blockquote", "## Rules[^1]\nBody.[^1]\n\n> [^1]: A footnote."],
  ])("%s: the TOC id is the rendered id", (_, markdown) => {
    const tocIds = splitMarkdownSections(markdown).toc.map((e) => e.id);
    expect(tocIds).toHaveLength(1);
    expect(sectionedIds(markdown)).toEqual(tocIds);
  });
});

describe("remarkSectionSlugs source text", () => {
  it("decodes a byte-buffer file so heading offsets index the same text", () => {
    const markdown = "Überblick.\n\n## See [the spec][spec]";
    const tree = unified().use(remarkParse).parse(markdown) as MdastNode;
    remarkSectionSlugs({ occurrences: {}, definitions: new Map([["SPEC", "[spec]: x"]]) })(tree, {
      value: new TextEncoder().encode(markdown),
    });
    expect(tree.children?.[1].data?.hProperties?.id).toBe("see-the-spec");
  });
});

/**
 * #228 — the BODY of a section, not just its heading id. A reference link or a
 * footnote reference whose definition sits in another section used to render
 * as literal text, and every section holding footnote definitions rendered its
 * own "Footnotes" list with its own `#footnote-label` and restarted numbering.
 */
describe("reference links and footnotes in the body across sections (#228)", () => {
  /**
   * The whole document in ONE react-markdown pass. Heading ids come from
   * remarkSectionSlugs on both sides (they are #227's subject, and it drops a
   * footnote number from an id where rehype-slug would keep it); everything
   * else is react-markdown's own rendering.
   */
  function wholeDocumentHtml(markdown: string): string {
    const { definitions } = splitMarkdownSections(markdown);
    return renderToStaticMarkup(
      createElement(
        ReactMarkdown,
        { remarkPlugins: [remarkGfm, [remarkSectionSlugs, { occurrences: {}, definitions }]] },
        markdown,
      ),
    );
  }

  /** Every section rendered on its own, then the document's footnote list. */
  function sectionedHtml(markdown: string): string {
    const doc = splitMarkdownSections(markdown);
    const bodies = doc.sections.map((section) =>
      renderToStaticMarkup(
        createElement(
          ReactMarkdown,
          {
            remarkPlugins: [
              remarkGfm,
              [
                remarkSectionSlugs,
                { occurrences: section.slugOccurrences, definitions: doc.definitions },
              ],
            ],
            rehypePlugins: [
              [
                rehypeSectionFootnotes,
                { order: doc.footnotes.order, before: section.footnotesBefore },
              ],
            ],
          },
          withDefinitions(section.markdown, doc.definitions),
        ),
      ),
    );
    const list = footnoteListMarkdown(doc);
    if (list !== null) {
      bodies.push(
        renderToStaticMarkup(
          createElement(
            ReactMarkdown,
            { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeFootnoteList] },
            list,
          ),
        ),
      );
    }
    return bodies.join("");
  }

  /** Whitespace between tags is layout, not content. */
  const normalize = (html: string) => html.replace(/>\s+</g, "><").trim();

  const ISSUE = [
    "## One",
    "See [the spec][spec] and a note.[^1]",
    "## Two",
    "Another note.[^2]",
    "",
    "[^2]: Two.",
    "## Three",
    "",
    "[spec]: https://example.com/spec",
    "",
    "[^1]: One.",
  ].join("\n");

  it("the issue's document: the link and both footnotes resolve", () => {
    const html = sectionedHtml(ISSUE);
    expect(html).toContain('<a href="https://example.com/spec">the spec</a>');
    expect(html).not.toContain("[the spec][spec]");
    expect(html).not.toContain("[^1]");
    expect(html).not.toContain("[^2]");
  });

  const DOCUMENTS: Array<[string, string]> = [
    ["the issue's document", ISSUE],
    [
      "footnotes defined in two sections, referenced repeatedly and out of order",
      [
        "# Doc",
        "Intro.[^b]",
        "## A",
        "First [^a] and again [^b].",
        "",
        "[^a]: Alpha, citing [the spec][spec].",
        "## B",
        "More [^a] and [^c] and [^a].",
        "",
        "[^b]: Beta.",
        "    Indented continuation.",
        "",
        "    A second paragraph.",
        "## C",
        "Unknown [^zz] stays literal; [ref][nowhere] too; [spec] resolves.",
        "",
        "[spec]: https://example.com/spec 'Title'",
        "[^c]: Gamma",
        "lazy continuation.",
      ].join("\n"),
    ],
    [
      "a heading carrying a footnote and a link defined later",
      [
        "## Rules[^1] and [the spec][spec]",
        "Body.[^1]",
        "## Definitions",
        "[spec]:",
        "  https://example.com/spec",
        '  "Spec title"',
        "",
        "[^1]: One.",
      ].join("\n"),
    ],
    [
      "the first of two definitions of a label wins",
      [
        "## A",
        "[x][dup] and note[^d]",
        "## B",
        "[dup]: https://example.com/first",
        "[^d]: First.",
        "## C",
        "[dup]: https://example.com/second",
        "",
        "[^d]: Second.",
      ].join("\n"),
    ],
    [
      "a footnote reference inside inline code or a fence, or to no definition, is not a reference",
      [
        "## A",
        "Undefined [^nope] first. Code `[^1]` then a real one[^1].",
        "```",
        "[^1]",
        "```",
        "## B",
        "[^1]: One.",
      ].join("\n"),
    ],
    // #522 — references counted from the parse, not a line scan.
    [
      "an escaped footnote reference is literal text, not a reference",
      [
        "## A",
        "Escaped \\[^1] stays literal.",
        "## B",
        "Real[^1] and [^2].",
        "",
        "[^1]: One.",
        "[^2]: Two.",
      ].join("\n"),
    ],
    [
      "a reference on the line after a bare, invalid link definition",
      [
        "## A",
        "Intro.",
        "",
        "[x]:",
        "[^1] is cited here, after an invalid definition.",
        "## B",
        "Again[^1].",
        "",
        "[^1]: One.",
      ].join("\n"),
    ],
    [
      "a bare link definition whose destination is on the next line, spelled like a reference",
      ["## A", "See [x].", "", "[x]:", "[^1]", "## B", "Real[^1].", "", "[^1]: One."].join("\n"),
    ],
    [
      "a footnote reference inside a raw HTML block is not a reference",
      [
        "## A",
        "<div>",
        "[^1]",
        "</div>",
        "",
        "After.",
        "## B",
        "Real[^2] then [^1].",
        "",
        "[^1]: One.",
        "[^2]: Two.",
      ].join("\n"),
    ],
    [
      "a footnote reference inside an indented code block is not a reference",
      [
        "## A",
        "Para.",
        "",
        "    [^1] in code",
        "",
        "## B",
        "Real[^2] then [^1].",
        "",
        "[^1]: One.",
        "[^2]: Two.",
      ].join("\n"),
    ],
    // #548 — pre-existing section-render mismatches found reviewing #542.
    [
      "a link definition whose title spans several lines",
      [
        "## A",
        "See [x].",
        "## B",
        "[x]:",
        "https://example.com/x",
        '"A title',
        "that goes on",
        'for three lines"',
      ].join("\n"),
    ],
    [
      "a preamble that starts with indented code, after a prepended footnote definition",
      ["    [^1] in code", "", "Cited.[^1]", "## A", "", "[^1]: One."].join("\n"),
    ],
    [
      "a run of consecutive definitions, one with a multi-line title",
      [
        "## A",
        "See [a], [b] and [c].",
        "## B",
        "[a]: https://example.com/a",
        "[b]:",
        "https://example.com/b",
        "'B,",
        "titled'",
        "[c]: https://example.com/c (C",
        "title)",
      ].join("\n"),
    ],
    [
      "a document that spells the label closing the prepended definitions",
      [
        "## A",
        "See [x], [metis-definitions-end] and [METIS-DEFINITIONS-END-].",
        "## B",
        "[x]: https://example.com/x",
      ].join("\n"),
    ],
    [
      // PR #556 panel: only a differently-cased spelling, so a label check that
      // skipped case-folding would pick a colliding label.
      "a document that spells the closing label in another case only",
      ["## A", "See [x] and [Metis-Definitions-End].", "## B", "[x]: https://example.com/x"].join(
        "\n",
      ),
    ],
  ];

  it.each(DOCUMENTS)("%s renders exactly as a whole-document render", (_, markdown) => {
    expect(normalize(sectionedHtml(markdown))).toBe(normalize(wholeDocumentHtml(markdown)));
  });

  it.each(DOCUMENTS)("%s: every element id is unique", (_, markdown) => {
    const ids = [...sectionedHtml(markdown).matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a document without footnote references has no footnote list", () => {
    const doc = splitMarkdownSections(
      "## A\n[x][y]\n## B\n[y]: https://example.com\n[^1]: Unused.",
    );
    expect(footnoteListMarkdown(doc)).toBeNull();
    expect(doc.footnotes.order.size).toBe(0);
  });

  it("a section is given only the definitions it names, and none when it names none", () => {
    const { definitions } = splitMarkdownSections(
      "## A\n[a]: https://example.com/a\n[b]: https://example.com/b\n[^n]: Note [a].",
    );
    expect(withDefinitions("plain text", definitions)).toBe("plain text");
    // A footnote's own references are supplied too (to a fixed point).
    expect(withDefinitions("x[^n]", definitions)).toBe(
      "[^n]: Note [a].\n\n[a]: https://example.com/a\n\n[metis-definitions-end]: #\n\nx[^n]",
    );
  });

  it("picks a closing label longer than any dash run the text already spells", () => {
    // PR #556 panel: the label is found in one scan, not by growing it a dash at
    // a time and rescanning (quadratic in a long hostile dash run).
    const { definitions } = splitMarkdownSections("## A\n[x]: https://example.com/x");
    const run = "-".repeat(5000);
    const out = withDefinitions(`[x] metis-definitions-end${run}`, definitions);
    expect(out).toContain(`[metis-definitions-end${run}-]: #`);
  });

  it("a footnote reference whose href is not percent-decodable keeps its own number", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "a",
          properties: { href: "#user-content-fn-%E0%A4%A", dataFootnoteRef: true },
          children: [{ type: "text", value: "1" }],
        },
      ],
    };
    rehypeSectionFootnotes({ order: new Map(), before: {} })(tree);
    const [ref] = tree.children;
    expect(ref.properties).toMatchObject({ id: "user-content-fnref-%E0%A4%A" });
    expect(ref.children).toEqual([{ type: "text", value: "1" }]);
  });
});

describe("footnote reference ids in sectionOfId (#228)", () => {
  const doc = [
    "## A",
    "Cite.[^1] Again.[^Note]",
    "## B",
    "Cite again.[^1] Accented.[^é] Encoded.[^a%41] Undefined.[^nope] `code [^1]`",
    "",
    "[^1]: One, citing.[^é]",
    "",
    "[^NOTE]: Two.",
    "",
    "[^é]: Three.",
    "",
    "[^a%41]: Four.",
  ].join("\n");

  it("maps every body reference's whole-document id to the section citing it", () => {
    const { sectionOfId } = splitMarkdownSections(doc);
    const fnrefs = [...sectionOfId].filter(([id]) => id.startsWith("user-content-fnref-"));
    expect(fnrefs).toEqual([
      ["user-content-fnref-1", 0],
      ["user-content-fnref-note", 0],
      ["user-content-fnref-1-2", 1],
      ["user-content-fnref-%C3%A9", 1],
      ["user-content-fnref-a%41", 1],
    ]);
    // Exactly the ids a whole-document render gives its body references.
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, doc),
    );
    const rendered = [...html.matchAll(/<a[^>]* id="(user-content-fnref-[^"]*)"/g)].map(
      (m) => m[1],
    );
    expect(rendered.slice(0, fnrefs.length)).toEqual(fnrefs.map(([id]) => id));
  });
});
