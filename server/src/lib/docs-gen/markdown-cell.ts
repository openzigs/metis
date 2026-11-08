/**
 * One line of stored text, safe inside a Markdown table cell or heading.
 * Shared by the requirements BRD (`requirements-scope.ts`, #991) and its
 * governing-rules section (`governing-section.ts`, #1877).
 */

/**
 * Whitespace is folded to single spaces and raw HTML is shown as text.
 * Backslashes are escaped first, so a stored `\|` cannot turn the added escape
 * into a literal backslash followed by a live column separator. Empty text
 * reads as an em dash.
 */
export function cell(value: string): string {
  return (
    value
      .replace(/\s+/g, " ")
      .replace(/\\/g, "\\\\")
      .replace(/\|/g, "\\|")
      .replace(/</g, "&lt;")
      .trim() || "—"
  );
}
