/**
 * Tests for markdown conversion utilities (issue #242).
 */
import { describe, expect, it } from "vitest";
import {
  cleanPdfText,
  expandMergedCells,
  htmlToMarkdown,
  rowsToMarkdownTable,
  type MergeRange,
} from "../src/lib/documents/markdown-utils.js";

describe("htmlToMarkdown()", () => {
  it("converts headings h1–h6", () => {
    expect(htmlToMarkdown("<h1>Title</h1>")).toContain("# Title");
    expect(htmlToMarkdown("<h2>Sub</h2>")).toContain("## Sub");
    expect(htmlToMarkdown("<h3>Sub2</h3>")).toContain("### Sub2");
    expect(htmlToMarkdown("<h4>Sub3</h4>")).toContain("#### Sub3");
    expect(htmlToMarkdown("<h5>Sub4</h5>")).toContain("##### Sub4");
    expect(htmlToMarkdown("<h6>Sub5</h6>")).toContain("###### Sub5");
  });

  it("converts bold text (<strong> and <b>)", () => {
    expect(htmlToMarkdown("<strong>bold</strong>")).toContain("**bold**");
    expect(htmlToMarkdown("<b>bold</b>")).toContain("**bold**");
  });

  it("converts italic text (<em> and <i>)", () => {
    expect(htmlToMarkdown("<em>italic</em>")).toContain("*italic*");
    expect(htmlToMarkdown("<i>italic</i>")).toContain("*italic*");
  });

  it("converts links", () => {
    const result = htmlToMarkdown('<a href="https://example.com">link</a>');
    expect(result).toContain("[link](https://example.com)");
  });

  it("converts unordered lists", () => {
    const result = htmlToMarkdown("<ul><li>Item 1</li><li>Item 2</li></ul>");
    expect(result).toContain("- Item 1");
    expect(result).toContain("- Item 2");
  });

  it("converts paragraphs", () => {
    const result = htmlToMarkdown("<p>Paragraph text</p>");
    expect(result).toContain("Paragraph text");
  });

  it("strips remaining HTML tags", () => {
    const result = htmlToMarkdown("<div><span>text</span></div>");
    expect(result).not.toContain("<");
    expect(result).toContain("text");
  });

  it("decodes HTML entities", () => {
    const result = htmlToMarkdown("&amp; &lt; &gt; &quot; &#39;");
    expect(result).toContain("&");
    expect(result).toContain("<");
    expect(result).toContain(">");
    expect(result).toContain('"');
    expect(result).toContain("'");
  });

  it("converts HTML tables to markdown tables", () => {
    const html = "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>";
    const result = htmlToMarkdown(html);
    expect(result).toContain("| A | B |");
    expect(result).toContain("| --- | --- |");
    expect(result).toContain("| 1 | 2 |");
  });

  it("separates multi-paragraph table cells instead of joining words", () => {
    const html =
      "<table><tr><td><p>First requirement.</p><p>Second requirement.</p></td><td>OK</td></tr></table>";
    const result = htmlToMarkdown(html);
    // Without the fix this produced "First requirement.Second requirement."
    expect(result).toContain("First requirement. Second requirement.");
    expect(result).not.toContain("requirement.Second");
  });

  it("separates <br>-delimited lines inside a table cell", () => {
    const html = "<table><tr><td>Line one<br/>Line two</td></tr></table>";
    const result = htmlToMarkdown(html);
    expect(result).toContain("Line one Line two");
    expect(result).not.toContain("oneLine");
  });

  it("preserves outer-table rows when tables are nested", () => {
    const html =
      "<table><tr><td>OuterCellBefore<table><tr><td>InnerCell</td></tr></table></td></tr>" +
      "<tr><td>OuterRow2</td></tr></table>";
    const result = htmlToMarkdown(html);
    // The non-greedy regex previously truncated the outer table at the inner
    // </table>, ejecting OuterRow2 and losing the inner cell content.
    expect(result).toContain("OuterCellBefore");
    expect(result).toContain("InnerCell");
    expect(result).toContain("OuterRow2");
  });

  it("returns empty string for empty input", () => {
    expect(htmlToMarkdown("")).toBe("");
  });

  it("collapses excessive newlines", () => {
    const result = htmlToMarkdown("<p>A</p><p></p><p></p><p>B</p>");
    expect(result).not.toMatch(/\n{3,}/);
  });

  it("converts line breaks", () => {
    const result = htmlToMarkdown("line1<br/>line2<br>line3");
    expect(result).toContain("line1\nline2\nline3");
  });
});

describe("rowsToMarkdownTable()", () => {
  it("creates a markdown table from rows", () => {
    const rows = [
      ["Name", "Age"],
      ["Alice", "30"],
      ["Bob", "25"],
    ];
    const result = rowsToMarkdownTable(rows);
    expect(result).toContain("| Name | Age |");
    expect(result).toContain("| --- | --- |");
    expect(result).toContain("| Alice | 30 |");
    expect(result).toContain("| Bob | 25 |");
  });

  it("returns empty string for empty rows", () => {
    expect(rowsToMarkdownTable([])).toBe("");
  });

  it("escapes pipe characters in cells", () => {
    const rows = [["A|B", "C"]];
    const result = rowsToMarkdownTable(rows);
    expect(result).toContain("A\\|B");
  });

  it("pads rows with uneven columns", () => {
    const rows = [["A", "B", "C"], ["1"]];
    const result = rowsToMarkdownTable(rows);
    expect(result).toContain("| 1 |  |  |");
  });

  it("handles single-row table (header only)", () => {
    const rows = [["Col1", "Col2"]];
    const result = rowsToMarkdownTable(rows);
    expect(result).toContain("| Col1 | Col2 |");
    expect(result).toContain("| --- | --- |");
  });

  it("replaces newlines in cells with spaces", () => {
    const rows = [["Header"], ["line1\nline2"]];
    const result = rowsToMarkdownTable(rows);
    expect(result).toContain("| line1 line2 |");
  });
});

describe("expandMergedCells()", () => {
  it("fills merged cell values across rows", () => {
    const rows = [
      ["Region", "100"],
      ["", "200"],
      ["", "300"],
    ];
    const merges: MergeRange[] = [{ s: { r: 0, c: 0 }, e: { r: 2, c: 0 } }];
    const result = expandMergedCells(rows, merges);
    expect(result[0][0]).toBe("Region");
    expect(result[1][0]).toBe("Region");
    expect(result[2][0]).toBe("Region");
  });

  it("returns unchanged rows when no merges", () => {
    const rows = [["A", "B"]];
    const result = expandMergedCells(rows, []);
    expect(result).toEqual([["A", "B"]]);
  });

  it("fills multi-column merges", () => {
    const rows = [
      ["Merged", "", ""],
      ["a", "b", "c"],
    ];
    const merges: MergeRange[] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }];
    const result = expandMergedCells(rows, merges);
    expect(result[0][0]).toBe("Merged");
    expect(result[0][1]).toBe("Merged");
    expect(result[0][2]).toBe("Merged");
  });

  it("does not mutate the original rows", () => {
    const original = [["A", "B"]];
    const merges: MergeRange[] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
    expandMergedCells(original, merges);
    expect(original[0][1]).toBe("B");
  });
});

describe("cleanPdfText()", () => {
  it("converts ALL CAPS lines to headings", () => {
    const result = cleanPdfText("INTRODUCTION\nSome body text");
    expect(result).toContain("## INTRODUCTION");
  });

  it("ignores short ALL CAPS words (≤3 chars)", () => {
    const result = cleanPdfText("OK\nBody text");
    expect(result).not.toContain("## OK");
  });

  it("ignores very long ALL CAPS lines (≥100 chars)", () => {
    const longLine = "A".repeat(101);
    const result = cleanPdfText(longLine);
    expect(result).not.toContain("##");
  });

  it("normalises CRLF and CR to LF", () => {
    const result = cleanPdfText("line1\r\nline2\rline3");
    expect(result).not.toContain("\r");
    expect(result).toContain("line1\nline2\nline3");
  });

  it("collapses excessive blank lines", () => {
    const result = cleanPdfText("A\n\n\n\n\nB");
    expect(result).not.toMatch(/\n{3,}/);
  });

  it("trims leading and trailing whitespace", () => {
    const result = cleanPdfText("  hello  ");
    expect(result).toBe("hello");
  });

  it("collapses multiple spaces to single space", () => {
    const result = cleanPdfText("hello    world");
    expect(result).toBe("hello world");
  });

  it("strips lone surrogates from extracted PDF text", () => {
    const result = cleanPdfText("Section \uD800 content \uDC00 end");
    expect(result).not.toMatch(/[\uD800-\uDFFF]/);
    expect(result).toContain("Section");
    expect(result).toContain("content");
    expect(result).toContain("end");
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
