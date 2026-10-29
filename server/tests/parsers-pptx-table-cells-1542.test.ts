/**
 * #1542 — a pptx table cell reaches Markdown escaped exactly once. The pptx
 * route escaped `|` itself and then handed the cell to `rowsToMarkdownTable`,
 * which escaped it again, so `a|b` came out as `a\\|b`: an escaped backslash
 * and a bare pipe that split the cell.
 *
 * officeparser is mocked: what is under test is how its AST becomes Markdown,
 * and a zip signature is all the routing gate needs to send the bytes there.
 */
import { describe, expect, it, vi } from "vitest";
import { parseDocument } from "../src/lib/documents/parsers.js";
import { tableRows } from "./helpers/gfm-table.js";

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const cell = (text: string) => ({ type: "cell", text });
const row = (...texts: string[]) => ({ type: "row", children: texts.map(cell) });

vi.mock("officeparser", () => ({
  default: {
    parseOffice: vi.fn(async () => ({
      content: [
        {
          type: "slide",
          children: [
            {
              type: "table",
              children: [row("Name", "Value"), row("a|b", "a\\|b"), row("C:\\x", "two\nlines")],
            },
          ],
        },
      ],
    })),
  },
}));

describe("pptx table cells (#1542)", () => {
  it("render as their own text, one cell each", async () => {
    const r = await parseDocument({
      buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
      mimeType: PPTX_MIME,
      filename: "deck.pptx",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(tableRows(r.text)).toEqual([
      ["Name", "Value"],
      ["a|b", "a\\|b"],
      ["C:\\x", "two lines"],
    ]);
  });
});
