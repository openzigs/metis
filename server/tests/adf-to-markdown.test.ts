/**
 * ADF → Markdown — #2244. Jira Cloud (API v3) returns rich text as an
 * Atlassian Document Format tree; these pin the Markdown it becomes.
 */
import { describe, expect, it } from "vitest";
import { adfToMarkdown, isAdfDocument } from "../src/lib/connectors/jira/adf-to-markdown.js";

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
    expect(md).toBe("@Dana 😄 due 2026-01-01 [IN PROGRESS]\n<https://jira.example.com/browse/X-1>");
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
