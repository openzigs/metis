/**
 * Markdown conversion utilities for document parsers (issue #242).
 *
 * - `htmlToMarkdown()` — regex-based HTML→Markdown: headings, bold, italic,
 *   links, lists, tables, paragraphs, code blocks.
 * - `rowsToMarkdownTable()` — 2D string array → Markdown table with header
 *   separator row.
 * - `expandMergedCells()` — fills merged-cell ranges in a 2D grid so
 *   downstream table rendering sees the repeated value.
 *
 * Ported from copilot365-int/src/file-parser.ts.
 */

// ── Merged-cell support ─────────────────────────────────────────────────────

export interface MergeRange {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

export function expandMergedCells(rows: string[][], merges: MergeRange[]): string[][] {
  const result = rows.map((row) => [...row]);
  for (const { s, e } of merges) {
    const value = result[s.r]?.[s.c] ?? "";
    for (let r = s.r; r <= e.r; r++) {
      for (let c = s.c; c <= e.c; c++) {
        if (!result[r]) result[r] = [];
        result[r][c] = String(value);
      }
    }
  }
  return result;
}

// ── Markdown table ──────────────────────────────────────────────────────────

export function rowsToMarkdownTable(rows: string[][]): string {
  if (rows.length === 0) return "";

  const maxCols = Math.max(...rows.map((r) => r.length));
  const normalized = rows.map((row) => {
    const padded = [...row];
    while (padded.length < maxCols) padded.push("");
    return padded.map((cell) =>
      String(cell ?? "")
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " "),
    );
  });

  if (normalized.length === 0) return "";

  const header = normalized[0];
  const separator = header.map(() => "---");
  const body = normalized.slice(1);

  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ];

  return lines.join("\n");
}

// ── HTML → Markdown ─────────────────────────────────────────────────────────

export function htmlToMarkdown(html: string): string {
  let md = html;

  // Headings (process h6→h1 so nested tags don't collide)
  for (let i = 6; i >= 1; i--) {
    const hashes = "#".repeat(i);
    md = md.replace(new RegExp(`<h${i}[^>]*>(.*?)</h${i}>`, "gi"), `\n${hashes} $1\n`);
  }

  // Bold / italic
  md = md.replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**");
  md = md.replace(/<b[^>]*>(.*?)<\/b>/gi, "**$1**");
  md = md.replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*");
  md = md.replace(/<i[^>]*>(.*?)<\/i>/gi, "*$1*");

  // Links
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)");

  // Unordered lists
  md = md.replace(/<ul[^>]*>/gi, "\n");
  md = md.replace(/<\/ul>/gi, "\n");
  md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n");

  // Ordered lists
  md = md.replace(/<ol[^>]*>/gi, "\n");
  md = md.replace(/<\/ol>/gi, "\n");

  // Tables
  md = convertHtmlTables(md);

  // Paragraphs and line breaks
  md = md.replace(/<p[^>]*>(.*?)<\/p>/gi, "\n$1\n");
  md = md.replace(/<br\s*\/?>/gi, "\n");

  // Strip remaining tags
  md = md.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  md = md.replace(/&amp;/g, "&");
  md = md.replace(/&lt;/g, "<");
  md = md.replace(/&gt;/g, ">");
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");

  // Clean up whitespace
  md = md.replace(/\n{3,}/g, "\n\n");

  return md.trim();
}

/**
 * Extract plain text from a table cell's inner HTML. Block-level boundaries
 * (`</p>`, `</div>`, `</li>`, `<br>`, etc.) are replaced with a space *before*
 * stripping remaining tags so that text from adjacent paragraphs or lines is
 * not concatenated into a single run-on token (which would corrupt the chunk
 * text fed to the embedder).
 */
function cellText(html: string): string {
  return html
    .replace(/<\/(?:p|div|li|h[1-6]|tr)\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function convertOneTable(tableContent: string): string {
  const rows: string[][] = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(tableContent)) !== null) {
    const cells: string[] = [];
    const cellRegex = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      cells.push(cellText(cellMatch[1]));
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows.length > 0 ? "\n" + rowsToMarkdownTable(rows) + "\n" : "";
}

function convertHtmlTables(html: string): string {
  let out = html;
  // Resolve tables innermost-first so nested tables do not truncate the outer
  // table at the inner table's `</table>` (which previously ejected the outer
  // table's trailing rows). Each pass converts every table that contains no
  // further nested table; repeat until none remain.
  const innermost = /<table[^>]*>(?:(?!<table)[\s\S])*?<\/table>/i;
  const innermostGlobal = /<table[^>]*>((?:(?!<table)[\s\S])*?)<\/table>/gi;
  let guard = 0;
  while (innermost.test(out) && guard < 50) {
    out = out.replace(innermostGlobal, (_match, tableContent: string) =>
      convertOneTable(tableContent),
    );
    guard++;
  }
  return out;
}

// ── PDF text cleaning ───────────────────────────────────────────────────────

/**
 * Clean raw PDF text: normalise line endings, detect ALL CAPS lines as
 * headings, and collapse excessive whitespace.
 */
export function cleanPdfText(text: string): string {
  // Strip lone surrogates (U+D800–U+DFFF) that PDF extractors sometimes emit.
  // These are invalid in JSON and cause Prisma/SQLite serialization failures.
  let cleaned = text.replace(/[\uD800-\uDFFF]/g, "");

  cleaned = cleaned.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // ALL CAPS lines → ## HEADING (reasonably short lines only)
  cleaned = cleaned.replace(/^([A-Z][A-Z\s]{2,})$/gm, (match) => {
    const trimmed = match.trim();
    if (trimmed.length > 3 && trimmed.length < 100) {
      return `\n## ${trimmed}\n`;
    }
    return match;
  });

  // Collapse whitespace while preserving paragraph breaks
  cleaned = cleaned.replace(/[ \t]+/g, " ");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  return cleaned.trim();
}
