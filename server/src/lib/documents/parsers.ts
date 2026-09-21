/**
 * Document text extractors (Phase 5 / part of issue #39 + #43).
 *
 * Supported formats:
 *   - text/plain, text/markdown, application/json
 *   - text/html (script/style/event handlers stripped)
 *   - application/pdf via `pdf-parse` (with heading detection)
 *   - application/vnd.openxmlformats-officedocument.wordprocessingml.document via `mammoth` (Markdown output)
 *   - application/vnd.openxmlformats-officedocument.spreadsheetml.sheet via `exceljs` (Markdown tables)
 *   - application/vnd.openxmlformats-officedocument.presentationml.presentation via `officeparser` (Markdown)
 *
 * The PDF/DOCX/XLSX/PPTX libs are loaded dynamically so the heavy native deps
 * stay out of the test path unless explicitly exercised. Parsers enforce the
 * `MAX_DOCUMENT_PARSE_BYTES` ceiling and PDF additionally rejects documents
 * with more than `MAX_PDF_PAGES` pages to bound memory use.
 *
 * The routing decision is made ONCE, in `parseByMime`, and on evidence: a declared type
 * that carries magic bytes must be backed by them or the document is refused, so no
 * parser is ever handed content it was not matched to (#1279 — see
 * `content-signature.ts` for the mechanism and the measurement).
 */
import { MAX_DOCUMENT_PARSE_BYTES, UPLOAD_MIME_ALLOWLIST } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { contentMatchesDeclaredMime, detectContentFamily } from "./content-signature.js";
import { exceedsPdfPageCap } from "./pdf-page-bound.js";
import {
  cleanPdfText,
  htmlToMarkdown,
  rowsToMarkdownTable,
  expandMergedCells,
  type MergeRange,
} from "./markdown-utils.js";

const log = createChildLogger("parsers");

/**
 * Reason prefix for a document whose contents contradict its declared MIME type.
 *
 * Unlike a parser failure this is never transient — the same bytes under the same
 * declared type will always be refused — so `knowledge-service` treats it as fatal rather
 * than leaving the document `pending` for a retry.
 */
export const CONTENT_TYPE_MISMATCH = "CONTENT_TYPE_MISMATCH";

export type ParseSuccess = { ok: true; text: string };
export type ParseFailure = { ok: false; reason: string };
export type ParseResult = ParseSuccess | ParseFailure;

export interface ParseInput {
  /** Buffer holding the raw uploaded bytes. */
  buffer: Buffer;
  /** MIME type as advertised by the client (after our allowlist check). */
  mimeType: string;
  /** Original filename (used as a tie-breaker for `application/octet-stream`). */
  filename: string;
}

/** Parse a document into normalised UTF-8 text. */
export async function parseDocument(input: ParseInput): Promise<ParseResult> {
  if (input.buffer.length > MAX_DOCUMENT_PARSE_BYTES) {
    return { ok: false, reason: "PARSER_FILE_TOO_LARGE" };
  }
  const mime = normaliseMime(input);
  const result = await parseByMime(mime, input);
  // Strip lone surrogates from all parser output — they are invalid in JSON
  // and cause Prisma/SQLite serialization failures.
  if (result.ok) {
    result.text = result.text.replace(/[\uD800-\uDFFF]/g, "");
  }
  return result;
}

async function parseByMime(mime: string, input: ParseInput): Promise<ParseResult> {
  // Refuse rather than re-route. The declared type has already picked a handler; if the
  // bytes disagree we do not silently pick a different one, because that would hand the
  // choice of parser to whoever produced the content. Re-routing is friendlier to a
  // browser with a sloppy `Content-Type`, but that case is already covered upstream by
  // `normaliseMime`'s extension fallback, so what remains here is a file whose declared
  // type, filename extension and contents all disagree — a claim we cannot honour.
  if (!contentMatchesDeclaredMime(mime, input.buffer)) {
    const detected = detectContentFamily(input.buffer) ?? "unrecognised";
    log.warn("content signature does not match declared type", { mime, detected });
    return { ok: false, reason: `${CONTENT_TYPE_MISMATCH}: declared ${mime}, content ${detected}` };
  }
  switch (mime) {
    case "text/plain":
    case "text/markdown":
    case "text/x-markdown":
      return { ok: true, text: toUtf8(input.buffer) };
    case "application/json":
      return { ok: true, text: prettyJson(toUtf8(input.buffer)) };
    case "text/html":
      return { ok: true, text: sanitiseHtml(toUtf8(input.buffer)) };
    case "application/pdf":
      return parsePdf(input.buffer);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return parseDocx(input.buffer);
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return parseXlsx(input.buffer);
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return parsePptx(input.buffer);
    default:
      return { ok: false, reason: "MIME_UNSUPPORTED" };
  }
}

async function parsePdf(buffer: Buffer): Promise<ParseResult> {
  try {
    const moduleName = "pdf-parse";
    const mod = (await import(moduleName)) as {
      PDFParse: new (opts: { data: Uint8Array }) => {
        getInfo(): Promise<{ numPages?: number; total?: number }>;
        getText(): Promise<{ text: string; total?: number }>;
        destroy(): Promise<void>;
      };
    };
    const data = new Uint8Array(buffer);
    const parser = new mod.PDFParse({ data });
    try {
      if (await exceedsPdfPageCap(parser)) {
        return { ok: false, reason: "PDF_TOO_MANY_PAGES" };
      }
      const result = await parser.getText();
      const text = (result.text ?? "").trim();
      if (text.length === 0) {
        return { ok: false, reason: "PDF_EMPTY_TEXT" };
      }
      return { ok: true, text: cleanPdfText(text) };
    } finally {
      try {
        await parser.destroy();
      } catch {
        // noop
      }
    }
  } catch (err) {
    log.warn("pdf parse failed", { error: (err as Error).message });
    return { ok: false, reason: `PDF_PARSE_FAILED: ${(err as Error).message}` };
  }
}

async function parseDocx(buffer: Buffer): Promise<ParseResult> {
  try {
    const moduleName = "mammoth";
    const mammoth = (await import(moduleName)) as {
      convertToHtml(input: { buffer: Buffer }): Promise<{ value: string }>;
    };
    const result = await mammoth.convertToHtml({ buffer });
    const md = htmlToMarkdown(result.value ?? "");
    if (md.length === 0) {
      return { ok: false, reason: "DOCX_EMPTY_TEXT" };
    }
    return { ok: true, text: md };
  } catch (err) {
    log.warn("docx parse failed", { error: (err as Error).message });
    return { ok: false, reason: `DOCX_PARSE_FAILED: ${(err as Error).message}` };
  }
}

async function parseXlsx(buffer: Buffer): Promise<ParseResult> {
  try {
    const moduleName = "exceljs";
    const ExcelJS = await import(moduleName);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheets: string[] = [];

    for (const worksheet of workbook.worksheets) {
      const rows: string[][] = [];
      const merges: MergeRange[] = [];

      // Collect merge ranges
      for (const mergeRef of Object.keys(
        (worksheet.model as { merges?: Record<string, unknown> }).merges ?? {},
      )) {
        const range = parseMergeRef(mergeRef);
        if (range) merges.push(range);
      }

      worksheet.eachRow({ includeEmpty: false }, (row: import("exceljs").Row) => {
        const cells: string[] = [];
        for (let col = 1; col <= worksheet.columnCount; col++) {
          const cell = row.getCell(col);
          cells.push(String(cell.value ?? ""));
        }
        rows.push(cells);
      });

      if (rows.length === 0) continue;

      const expandedRows = expandMergedCells(rows, merges);
      const mdTable = rowsToMarkdownTable(expandedRows);
      if (mdTable) {
        sheets.push(`## ${worksheet.name}\n\n${mdTable}`);
      }
    }

    if (sheets.length === 0) {
      return { ok: true, text: "*Empty spreadsheet*" };
    }
    return { ok: true, text: sheets.join("\n\n") };
  } catch (err) {
    log.warn("xlsx parse failed", { error: (err as Error).message });
    return { ok: false, reason: `XLSX_PARSE_FAILED: ${(err as Error).message}` };
  }
}

function parseMergeRef(ref: string): MergeRange | null {
  const match = ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!match) return null;
  return {
    s: { r: parseInt(match[2], 10) - 1, c: colLetterToIndex(match[1]) },
    e: { r: parseInt(match[4], 10) - 1, c: colLetterToIndex(match[3]) },
  };
}

function colLetterToIndex(letters: string): number {
  let index = 0;
  for (let i = 0; i < letters.length; i++) {
    index = index * 26 + (letters.charCodeAt(i) - 64);
  }
  return index - 1;
}

async function parsePptx(buffer: Buffer): Promise<ParseResult> {
  try {
    const moduleName = "officeparser";
    const mod = (await import(moduleName)) as typeof import("officeparser");
    const ast = await mod.default.parseOffice(buffer);
    const sections: string[] = [];

    function visit(nodes: typeof ast.content) {
      for (const node of nodes) {
        if (node.type === "slide" || node.type === "page") {
          if (node.children) visit(node.children);
        } else if (node.type === "heading") {
          const level = (node.metadata as { level?: number } | undefined)?.level ?? 2;
          const prefix = "#".repeat(Math.min(level + 1, 6));
          sections.push(`${prefix} ${node.text}`);
        } else if (node.type === "list") {
          sections.push(`- ${node.text}`);
        } else if (node.type === "table") {
          const rows = (node.children ?? [])
            .filter((r) => r.type === "row")
            .map((row) =>
              (row.children ?? [])
                .filter((c) => c.type === "cell")
                .map((c) => (c.text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")),
            );
          if (rows.length > 0) {
            const mdTable = rowsToMarkdownTable(rows);
            if (mdTable) sections.push(mdTable);
          }
        } else if (node.text?.trim()) {
          sections.push(node.text.trim());
        }
      }
    }

    visit(ast.content);

    if (sections.length === 0) {
      return { ok: true, text: "*Empty presentation*" };
    }
    return { ok: true, text: sections.join("\n\n") };
  } catch (err) {
    log.warn("pptx parse failed", { error: (err as Error).message });
    return { ok: false, reason: `PPTX_PARSE_FAILED: ${(err as Error).message}` };
  }
}

function normaliseMime(input: ParseInput): string {
  const mime = (input.mimeType ?? "").toLowerCase();
  if (mime && (UPLOAD_MIME_ALLOWLIST as readonly string[]).includes(mime)) return mime;
  // Fall back to extension-based sniffing for browsers that send octet-stream.
  const ext = input.filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "md":
    case "markdown":
      return "text/markdown";
    case "txt":
      return "text/plain";
    case "html":
    case "htm":
      return "text/html";
    case "json":
      return "application/json";
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    default:
      return mime;
  }
}

function toUtf8(buf: Buffer): string {
  // Strip a BOM so downstream chunkers don't choke on a leading U+FEFF.
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/**
 * Extremely conservative HTML → text reducer.
 *
 * We are NOT trying to render HTML — we are stripping it down to the textual
 * content so it can be embedded. Anything resembling executable content is
 * dropped: `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, and any
 * `on*` event-handler attributes. The output is plain text with collapsed
 * whitespace.
 */
export function sanitiseHtml(html: string): string {
  let out = html;
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  out = out.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
  out = out.replace(/<style\b[\s\S]*?<\/style\s*>/gi, "");
  out = out.replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, "");
  out = out.replace(/<object\b[\s\S]*?<\/object\s*>/gi, "");
  out = out.replace(/<embed\b[^>]*\/?>/gi, "");
  out = out.replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, "");
  // Strip on* event handler attributes anywhere.
  out = out.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, "");
  out = out.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, "");
  out = out.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, "");
  // Drop javascript: and data: URLs from href/src to be safe (output is text
  // anyway but we want the textual fragments to be benign).
  out = out.replace(/(href|src)\s*=\s*"\s*(javascript|data):[^"]*"/gi, '$1=""');
  out = out.replace(/(href|src)\s*=\s*'\s*(javascript|data):[^']*'/gi, "$1=''");
  // Replace block-level closers with a newline so the resulting text retains
  // some structure for chunking.
  out = out.replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)\s*>/gi, "\n");
  out = out.replace(/<br\s*\/?>(?!\n)/gi, "\n");
  // Strip remaining tags.
  out = out.replace(/<[^>]+>/g, "");
  // Decode the most common HTML entities — full entity decoding is overkill
  // for our embedding purposes.
  out = out
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  // Collapse runs of whitespace.
  out = out.replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return out.trim();
}
