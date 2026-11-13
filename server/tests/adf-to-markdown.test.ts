/**
 * ADF → Markdown — #2244. Jira Cloud (API v3) returns rich text as an
 * Atlassian Document Format tree; these pin the Markdown it becomes.
 */
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { describe, expect, it } from "vitest";
import { adfToMarkdown, isAdfDocument } from "../src/lib/connectors/jira/adf-to-markdown.js";

/**
 * What the Markdown renders to under CommonMark + GFM. Raw HTML and every link
 * protocol pass through, so a test sees what the Markdown *forms*, not what a
 * downstream sanitiser would strip.
 */
const html = (md: string) =>
  micromark(md, {
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
    allowDangerousHtml: true,
    allowDangerousProtocol: true,
  }).trim();

const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const t = (text: string, ...marks: unknown[]) =>
  marks.length ? { type: "text", text, marks } : { type: "text", text };
const li = (...content: unknown[]) => ({ type: "listItem", content });

/** A realistic Jira Cloud description, shaped as the v3 API returns it. */
const JIRA_DESCRIPTION = doc(
  { type: "heading", attrs: { level: 2 }, content: [t("Background")] },
  p(
    t("Customers on the "),
    t("Pro", { type: "strong" }),
    t(" plan cannot export. See "),
    t("the spec", { type: "link", attrs: { href: "https://wiki.example.com/spec" } }),
    t("."),
  ),
  {
    type: "bulletList",
    content: [
      li(p(t("Export to CSV"))),
      li(p(t("Export to PDF")), {
        type: "orderedList",
        attrs: { order: 1 },
        content: [li(p(t("A4"))), li(p(t("Letter")))],
      }),
    ],
  },
  {
    type: "table",
    attrs: { isNumberColumnEnabled: false, layout: "default" },
    content: [
      {
        type: "tableRow",
        content: [
          { type: "tableHeader", content: [p(t("Plan"))] },
          { type: "tableHeader", content: [p(t("Limit"))] },
        ],
      },
      {
        type: "tableRow",
        content: [
          { type: "tableCell", content: [p(t("Pro"))] },
          { type: "tableCell", content: [p(t("10 | 20"))] },
        ],
      },
    ],
  },
  {
    type: "codeBlock",
    attrs: { language: "sql" },
    content: [t("SELECT *\nFROM exports;")],
  },
);

describe("isAdfDocument", () => {
  it("recognises an ADF root and nothing else", () => {
    expect(isAdfDocument(doc(p(t("x"))))).toBe(true);
    expect(isAdfDocument({ type: "doc" })).toBe(false);
    expect(isAdfDocument({ type: "paragraph", content: [] })).toBe(false);
    expect(isAdfDocument("text")).toBe(false);
    expect(isAdfDocument(null)).toBe(false);
  });
});

describe("adfToMarkdown", () => {
  it("renders a realistic Jira Cloud description: heading, marks, link, nested lists, table, code", () => {
    expect(adfToMarkdown(JIRA_DESCRIPTION)).toBe(
      [
        "## Background",
        "",
        "Customers on the **Pro** plan cannot export. See [the spec](https://wiki.example.com/spec).",
        "",
        "- Export to CSV",
        "- Export to PDF",
        "  1. A4",
        "  2. Letter",
        "",
        "| Plan | Limit |",
        "| --- | --- |",
        "| Pro | 10 \\| 20 |",
        "",
        "```sql",
        "SELECT *",
        "FROM exports;",
        "```",
      ].join("\n"),
    );
  });

  it("escapes a cell's own backslash so it cannot un-escape the pipe after it", () => {
    const cell = (text: string) => ({ type: "tableCell", content: [p(t(text))] });
    const md = adfToMarkdown(
      doc({
        type: "table",
        content: [
          { type: "tableRow", content: [cell("Path"), cell("Note")] },
          { type: "tableRow", content: [cell("C:\\dir\\|x"), cell("ok")] },
        ],
      }),
    );
    // `C:\dir\|x` → `C:\\dir\\\|x`: two literal backslashes and an escaped pipe, still two columns.
    expect(md.split("\n")[2]).toBe("| C:\\\\dir\\\\\\|x | ok |");
  });

  it("applies em, strike and inline code marks, keeping edge spaces outside the markers", () => {
    const md = adfToMarkdown(
      doc(
        p(
          t("a "),
          t(" slanted ", { type: "em" }),
          t("gone", { type: "strike" }),
          t(" "),
          t("x`y", { type: "code" }),
        ),
      ),
    );
    expect(md).toBe("a  *slanted* ~~gone~~ ``x`y``");
  });

  it("drops a link target that is not http(s) or mailto, keeping the text", () => {
    const md = adfToMarkdown(
      doc(
        p(
          t("click", { type: "link", attrs: { href: "javascript:alert(1)" } }),
          t(" "),
          t("mail", { type: "link", attrs: { href: "mailto:ba@example.com" } }),
        ),
      ),
    );
    expect(md).toBe("click [mail](mailto:ba@example.com)");
  });

  it("escapes parentheses in a link target so the Markdown link cannot end early", () => {
    const md = adfToMarkdown(
      doc(p(t("w", { type: "link", attrs: { href: "https://x.example/a_(b)" } }))),
    );
    expect(md).toBe("[w](https://x.example/a_%28b%29)");
  });

  it("renders inline nodes: mention, emoji, date, status, inline card, hard break", () => {
    const md = adfToMarkdown(
      doc(
        p(
          { type: "mention", attrs: { id: "abc", text: "@Dana" } },
          t(" "),
          { type: "emoji", attrs: { shortName: ":smile:", text: "😄" } },
          t(" due "),
          { type: "date", attrs: { timestamp: "1767225600000" } },
          t(" "),
          { type: "status", attrs: { text: "IN PROGRESS", color: "blue" } },
          { type: "hardBreak" },
          { type: "inlineCard", attrs: { url: "https://jira.example.com/browse/X-1" } },
        ),
      ),
    );
    expect(md).toBe(
      "@Dana 😄 due 2026-01-01 \\[IN PROGRESS\\]  \n<https://jira.example.com/browse/X-1>",
    );
  });

  it("renders task lists with their state, quotes, panels, expands and rules", () => {
    const md = adfToMarkdown(
      doc(
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { state: "DONE" }, content: [t("Write spec")] },
            { type: "taskItem", attrs: { state: "TODO" }, content: [t("Review")] },
          ],
        },
        { type: "blockquote", content: [p(t("quoted"))] },
        { type: "panel", attrs: { panelType: "warning" }, content: [p(t("careful"))] },
        { type: "rule" },
        { type: "expand", attrs: { title: "Details" }, content: [p(t("hidden"))] },
      ),
    );
    expect(md).toBe(
      [
        "- [x] Write spec",
        "- [ ] Review",
        "",
        "> quoted",
        "",
        "> **Warning:** careful",
        "",
        "---",
        "",
        "**Details**",
        "",
        "hidden",
      ].join("\n"),
    );
  });

  it("renders media as an attachment placeholder and a block card as a link", () => {
    const md = adfToMarkdown(
      doc(
        {
          type: "mediaSingle",
          content: [{ type: "media", attrs: { type: "file", id: "m1", alt: "wireframe.png" } }],
        },
        { type: "blockCard", attrs: { url: "https://wiki.example.com/page" } },
      ),
    );
    expect(md).toBe("[attachment: wireframe.png]\n\n<https://wiki.example.com/page>");
  });

  it("degrades an unknown node to its text content, never to JSON", () => {
    const md = adfToMarkdown(
      doc({ type: "futureBlock", content: [p(t("still readable"))] }, { type: "futureLeaf" }),
    );
    expect(md).toBe("still readable");
    expect(md).not.toContain("{");
  });

  it("uses a longer code fence when the code itself contains a triple backtick", () => {
    const md = adfToMarkdown(doc({ type: "codeBlock", content: [t("```\nx")] }));
    expect(md).toBe("````\n```\nx\n````");
  });

  it("starts an ordered list at its order attribute and clamps heading levels", () => {
    const md = adfToMarkdown(
      doc(
        { type: "heading", attrs: { level: 9 }, content: [t("Deep")] },
        { type: "orderedList", attrs: { order: 3 }, content: [li(p(t("c"))), li(p(t("d")))] },
      ),
    );
    expect(md).toBe("###### Deep\n\n3. c\n4. d");
  });

  it("returns an empty string for non-objects and stops at hostile nesting depth", () => {
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown("x")).toBe("");
    let deep: unknown = p(t("bottom"));
    for (let i = 0; i < 10_000; i += 1) deep = { type: "blockquote", content: [deep] };
    expect(() => adfToMarkdown(doc(deep))).not.toThrow();
  });
});

describe("adfToMarkdown — mark closing stays linear (#2260 review)", () => {
  const flips = (n: number) =>
    Array.from({ length: n }, (_, i) => (i % 2 === 0 ? t("x", { type: "strong" }) : t("y")));

  it("does not go quadratic on a long whitespace run followed by many mark flips", () => {
    const start = performance.now();
    adfToMarkdown(doc(p(t(" ".repeat(16_000)), ...flips(300))));
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it("does not go quadratic on many hard breaks followed by mark flips", () => {
    const start = performance.now();
    const breaks = Array.from({ length: 2_000 }, () => ({ type: "hardBreak" }));
    adfToMarkdown(doc(p(...breaks, ...flips(300))));
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});

describe("adfToMarkdown — rendered by a real Markdown parser (#2260)", () => {
  it("keeps a hard break as a line break, not a soft break that renders as a space", () => {
    const md = adfToMarkdown(doc(p(t("Line one"), { type: "hardBreak" }, t("Line two"))));
    expect(html(md)).toBe("<p>Line one<br />\nLine two</p>");
  });

  it("keeps a list item's second paragraph as its own paragraph", () => {
    const md = adfToMarkdown(
      doc({ type: "bulletList", content: [li(p(t("First")), p(t("Second"))), li(p(t("Next")))] }),
    );
    expect(md).toBe("- First\n\n  Second\n- Next");
    expect(html(md)).toContain("<p>First</p>\n<p>Second</p>");
  });

  it("keeps a nested list tight under its parent paragraph", () => {
    const md = adfToMarkdown(
      doc({
        type: "bulletList",
        content: [li(p(t("Parent")), { type: "bulletList", content: [li(p(t("Child")))] })],
      }),
    );
    expect(md).toBe("- Parent\n  - Child");
  });

  it("escapes text so a `]` in link text cannot end the link early", () => {
    const md = adfToMarkdown(
      doc(p(t("see [1] here", { type: "link", attrs: { href: "https://x.example/" } }))),
    );
    expect(html(md)).toBe('<p><a href="https://x.example/">see [1] here</a></p>');
  });

  it("merges adjacent same-mark nodes instead of fusing their delimiters", () => {
    const md = adfToMarkdown(doc(p(t("foo", { type: "strong" }), t("bar", { type: "strong" }))));
    expect(md).toBe("**foobar**");
    expect(html(md)).toBe("<p><strong>foobar</strong></p>");
  });

  it("merges adjacent inline-code nodes into one code span", () => {
    const md = adfToMarkdown(doc(p(t("a", { type: "code" }), t("b", { type: "code" }))));
    expect(html(md)).toBe("<p><code>ab</code></p>");
  });

  it("nests bold then bold-italic instead of fusing `**foo*****bar***`", () => {
    const md = adfToMarkdown(
      doc(p(t("foo", { type: "strong" }), t("bar", { type: "strong" }, { type: "em" }), t(" end"))),
    );
    expect(md).toBe("**foo*bar*** end");
    expect(html(md)).toBe("<p><strong>foo<em>bar</em></strong> end</p>");
  });

  it("closes and reopens marks across a run: italic then bold, link then plain", () => {
    const href = { type: "link", attrs: { href: "https://x.example/" } };
    const md = adfToMarkdown(
      doc(
        p(
          t("a", { type: "em" }),
          t("b", { type: "strong" }),
          t(" "),
          t("in ", href),
          t("link", href, { type: "strong" }),
          t(" out"),
        ),
      ),
    );
    expect(html(md)).toBe(
      '<p><em>a</em><strong>b</strong> <a href="https://x.example/">in <strong>link</strong></a> out</p>',
    );
  });

  it("keeps a mark open across a whitespace-only node and closes it before an inline node", () => {
    const md = adfToMarkdown(
      doc(
        p(
          t("a", { type: "strong" }),
          t(" ", { type: "strong" }, { type: "em" }),
          t("b", { type: "strong" }, { type: "em" }),
          { type: "mention", attrs: { text: "@Dana" } },
        ),
      ),
    );
    expect(html(md)).toBe("<p><strong>a <em>b</em></strong>@Dana</p>");
  });

  it("escapes emphasis, strike, code, entity and HTML characters typed as text", () => {
    const md = adfToMarkdown(doc(p(t("a*b*c _d_ ~e~ `f` &amp; <b>g</b> \\ end"))));
    expect(html(md)).toBe("<p>a*b*c _d_ ~e~ `f` &amp;amp; &lt;b&gt;g&lt;/b&gt; \\ end</p>");
  });

  it("does not let literal `[x](javascript:…)` or raw HTML text form a link or a tag", () => {
    const md = adfToMarkdown(
      doc(
        p(t("[click](javascript:alert(1)) <img src=x onerror=alert(1)> <javascript:alert(1)>")),
        p({ type: "status", attrs: { text: "OPEN" } }, t("(javascript:alert(1))")),
      ),
    );
    const out = html(md);
    expect(out).not.toContain("<a");
    expect(out).not.toContain("<img");
    expect(out).toContain("[click](javascript:alert(1))");
  });

  it("escapes text in mentions, emoji, panel labels, expand titles and attachment names", () => {
    const md = adfToMarkdown(
      doc(
        p({ type: "mention", attrs: { text: "@*x*" } }, t(" "), {
          type: "emoji",
          attrs: { text: "_y_" },
        }),
        { type: "panel", attrs: { panelType: "*note*" }, content: [p(t("body"))] },
        { type: "expand", attrs: { title: "<b>t</b>" }, content: [p(t("hidden"))] },
        { type: "mediaSingle", content: [{ type: "media", attrs: { alt: "a](javascript:x)" } }] },
        { type: "futureBlock", text: "*raw*" },
      ),
    );
    const out = html(md);
    expect(out).toContain("<p>@*x* _y_</p>");
    expect(out).toContain("<strong>*note*:</strong> body");
    expect(out).toContain("<strong>&lt;b&gt;t&lt;/b&gt;</strong>");
    expect(out).toContain("[attachment: a](javascript:x)]");
    expect(out).toContain("<p>*raw*</p>");
    expect(out).not.toContain("<a");
    expect(out).not.toContain("<em>");
  });

  it("keeps a pipe in text, a code span and a status inside one table cell", () => {
    const cell = (...c: unknown[]) => ({ type: "tableCell", content: [p(...c)] });
    const md = adfToMarkdown(
      doc({
        type: "table",
        content: [
          { type: "tableRow", content: [cell(t("A")), cell(t("B"))] },
          {
            type: "tableRow",
            content: [cell(t("x | y"), t("a|b", { type: "code" })), cell(t("ok"))],
          },
          // A code span's own backslash-pipe is already an escaped pipe: escaping it again
          // would leave `\\|`, an escaped backslash and a real cell boundary.
          { type: "tableRow", content: [cell(t("a\\|b", { type: "code" })), cell(t("ok"))] },
        ],
      }),
    );
    const out = html(md);
    expect(out).toContain("<td>x | y<code>a|b</code></td>");
    expect(out.match(/<td>ok<\/td>/g)).toHaveLength(2);
    expect(out).not.toContain("b`");
  });
});
