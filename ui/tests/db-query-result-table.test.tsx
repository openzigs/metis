/**
 * #1580 — a read-only query's result renders as a table, not raw JSON.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { DbQueryResultTable, formatDbCell } from "@/components/connectors/db-query-result-table";

describe("formatDbCell", () => {
  it.each([
    [null, "NULL"],
    [undefined, "NULL"],
    ["text", "text"],
    ["", ""],
    [0, "0"],
    [false, "false"],
    [BigInt("9007199254740993"), "9007199254740993"],
    [{ a: 1 }, '{"a":1}'],
    [[1, 2], "[1,2]"],
  ])("%s → %s", (value, expected) => {
    expect(formatDbCell(value)).toBe(expected);
  });
});

describe("DbQueryResultTable", () => {
  it("says a result was cut at the row limit and how many rows are shown", () => {
    render(
      <DbQueryResultTable
        result={{
          columns: ["id"],
          rows: [{ id: 1 }, { id: 2 }],
          rowCount: 2,
          truncated: true,
          durationMs: 4,
        }}
      />,
    );
    expect(screen.getByTestId("db-query-summary")).toHaveTextContent(
      "2 rows in 4 ms — cut at the row limit; only the first 2 are shown",
    );
  });

  it("says when the query returned no rows, with no empty table", () => {
    render(
      <DbQueryResultTable
        result={{ columns: ["id"], rows: [], rowCount: 0, truncated: false, durationMs: 1 }}
      />,
    );
    expect(screen.getByText("The query returned no rows.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByTestId("db-query-summary")).toHaveTextContent("0 rows in 1 ms");
  });

  it("uses the singular for one row and reads cells by column name", () => {
    render(
      <DbQueryResultTable
        result={{
          columns: ["meta", "id"],
          rows: [{ id: 7, meta: { tags: ["a"] } }],
          rowCount: 1,
          truncated: false,
          durationMs: 2,
        }}
      />,
    );
    expect(screen.getByTestId("db-query-summary")).toHaveTextContent("1 row in 2 ms");
    const cells = within(screen.getByRole("table"))
      .getAllByRole("cell")
      .map((c) => c.textContent);
    expect(cells).toEqual(['{"tags":["a"]}', "7"]);
  });
});
