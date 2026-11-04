"use client";

/**
 * #1580 — a read-only query's result as a table. The Connections page printed
 * the whole response as raw JSON (`{"columns": [...], "rows": [...]}`), which
 * reads as a payload rather than as five rows of a table.
 */
import type { DbQueryResult } from "@metis/shared";

/** One cell as text: SQL NULL says so, nested values stay readable as JSON. */
export function formatDbCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
}

export function DbQueryResultTable({ result }: { result: DbQueryResult }): React.ReactElement {
  const { columns, rows } = result;
  const noun = result.rowCount === 1 ? "row" : "rows";
  return (
    <div className="space-y-1" data-testid="db-query-result">
      <p className="text-xs text-muted-foreground" data-testid="db-query-summary">
        {result.rowCount} {noun} in {result.durationMs} ms
        {result.truncated ? ` — cut at the row limit; only the first ${rows.length} are shown` : ""}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">The query returned no rows.</p>
      ) : (
        <div className="max-h-64 overflow-auto rounded border">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-muted">
              <tr>
                {columns.map((column) => (
                  <th key={column} scope="col" className="px-2 py-1 text-left font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-t">
                  {columns.map((column) => {
                    const text = formatDbCell(row[column]);
                    return (
                      <td
                        key={column}
                        className={`px-2 py-1 align-top font-mono ${
                          row[column] == null ? "text-muted-foreground" : ""
                        }`}
                      >
                        {text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
