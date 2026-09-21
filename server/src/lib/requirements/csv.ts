/**
 * Epic #770 / Issue #775 — RFC 4180-compliant CSV serialization.
 *
 * Rules implemented (RFC 4180 §2):
 *   • Fields are separated by commas; records by CRLF.
 *   • A field is quoted with double-quotes when it contains a comma, a
 *     double-quote, CR, or LF.
 *   • Embedded double-quotes are escaped by doubling them ("" ).
 *   • `null` / `undefined` serialize to an empty field.
 *
 * Security: requirement fields (title, body, reason, …) are user-controlled, so
 * the serializer also defends against CSV / formula injection (OWASP). A cell
 * whose text would be interpreted as a formula by a spreadsheet (leading `=`,
 * `+`, `-`, `@`, TAB, or CR) is prefixed with a single quote so the value is
 * rendered as inert text rather than evaluated.
 */

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * Neutralize spreadsheet formula injection by prefixing risky leading
 * characters with a single quote. Returns the (possibly prefixed) string.
 */
export function neutralizeFormula(s: string): string {
  return FORMULA_TRIGGER.test(s) ? `'${s}` : s;
}

/** Quote a single field per RFC 4180 when required, after formula-neutralizing. */
export function toCsvField(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const s = neutralizeFormula(raw);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Serialize a 2D matrix of cells into an RFC 4180 CSV document (CRLF rows). */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return rows.map((row) => row.map(toCsvField).join(",")).join("\r\n");
}
