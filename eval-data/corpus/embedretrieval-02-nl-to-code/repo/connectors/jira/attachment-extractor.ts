/**
 * Jira Attachment Extractor — Epic #658 / Issues #659, #660, #661.
 *
 * Downloads Jira issue attachments via JiraClient.fetchRaw() and extracts
 * text content for ingestion into the RAG pipeline. Supports:
 *   - Text-based files (.txt, .csv, .md, .json, .xml, .log) — #659
 *   - Images (jpeg, png, gif, webp) via vision LLM description — #660
 *   - PDF, DOCX, XLSX via specialized parsers — #661
 */
import { createChildLogger } from "../../logger.js";
import type { JiraClient } from "./jira-client.js";
import type { AIProvider, ChatMessage } from "../../ai/types.js";

const log = createChildLogger("jira-attachment-extractor");

/** Maximum attachment size in bytes (5 MB). */
export const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;

/** Attachment metadata as returned by the Jira MCP tool or API. */
export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
  /** Absolute URL to download the attachment content. */
  content: string;
}

/** Result of extracting text from a single attachment. */
export interface AttachmentExtraction {
  filename: string;
  /** Extracted text/markdown content. */
  text: string;
  /** How the content was extracted. */
  method: "text" | "image-description" | "pdf" | "docx" | "xlsx" | "skipped";
  /** Reason for skipping, if applicable. */
  skipReason?: string;
}

/** Options for the extraction pipeline. */
export interface ExtractAttachmentsOptions {
  /** JiraClient for downloading attachment content. */
  client: JiraClient;
  /** Attachment metadata array. */
  attachments: AttachmentMeta[];
  /** Optional AI provider for image description (vision LLM). */
  aiProvider?: AIProvider;
}

// ---- MIME classification ---------------------------------------------------

const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_MIME_EXACT = [
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
];
const TEXT_EXTENSIONS = [".txt", ".csv", ".md", ".json", ".xml", ".log", ".yaml", ".yml"];

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function isTextAttachment(meta: AttachmentMeta): boolean {
  const mime = meta.mimeType.toLowerCase();
  if (TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p))) return true;
  if (TEXT_MIME_EXACT.includes(mime)) return true;
  const ext = meta.filename.toLowerCase().replace(/^.*(\.[^.]+)$/, "$1");
  return TEXT_EXTENSIONS.includes(ext);
}

function isImageAttachment(meta: AttachmentMeta): boolean {
  return IMAGE_MIMES.includes(meta.mimeType.toLowerCase());
}

function isPdfAttachment(meta: AttachmentMeta): boolean {
  return meta.mimeType.toLowerCase() === PDF_MIME;
}

function isDocxAttachment(meta: AttachmentMeta): boolean {
  return meta.mimeType.toLowerCase() === DOCX_MIME;
}

function isXlsxAttachment(meta: AttachmentMeta): boolean {
  return meta.mimeType.toLowerCase() === XLSX_MIME;
}

// ---- Download helper -------------------------------------------------------

async function downloadBuffer(client: JiraClient, url: string): Promise<Buffer> {
  const { body } = await client.fetchRaw(url);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// ---- Extractors ------------------------------------------------------------

async function extractText(client: JiraClient, meta: AttachmentMeta): Promise<string> {
  const buffer = await downloadBuffer(client, meta.content);
  return buffer.toString("utf-8");
}

async function extractImageDescription(
  client: JiraClient,
  meta: AttachmentMeta,
  aiProvider: AIProvider,
): Promise<string> {
  const buffer = await downloadBuffer(client, meta.content);
  const base64 = buffer.toString("base64");
  const mimeType = meta.mimeType.toLowerCase();

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are an assistant that describes images found in software requirements documents. " +
        "Extract any visible text, diagrams, tables, flowcharts, wireframes, or specifications. " +
        "Be concise but thorough.",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Describe this image in the context of a software requirements document. Extract any visible text, diagrams, tables, or specifications.",
        },
        {
          type: "image_url",
          image_url: { url: `data:${mimeType};base64,${base64}` },
        },
      ],
    },
  ];

  const response = await aiProvider.chat(messages, { disableTools: true });
  return response.content;
}

async function extractPdf(client: JiraClient, meta: AttachmentMeta): Promise<string> {
  const buffer = await downloadBuffer(client, meta.content);
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const textResult = await parser.getText();
  return textResult.text;
}

async function extractDocx(client: JiraClient, meta: AttachmentMeta): Promise<string> {
  const buffer = await downloadBuffer(client, meta.content);
  const mammoth = await import("mammoth");
  const result = await mammoth.default.extractRawText({ buffer });
  return result.value;
}

async function extractXlsx(client: JiraClient, meta: AttachmentMeta): Promise<string> {
  const buffer = await downloadBuffer(client, meta.content);
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.default.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheets: string[] = [];

  workbook.eachSheet((worksheet) => {
    const rows: string[][] = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = (row.values as (string | number | null | undefined)[]).slice(1); // exceljs is 1-indexed
      rows.push(cells.map((c) => String(c ?? "")));
    });
    if (rows.length === 0) return;

    const lines: string[] = [`### Sheet: ${worksheet.name}`, ""];
    // Header row
    const header = rows[0];
    if (header && header.length > 0) {
      lines.push("| " + header.join(" | ") + " |");
      lines.push("| " + header.map(() => "---").join(" | ") + " |");
      // Data rows
      for (let i = 1; i < rows.length; i++) {
        lines.push("| " + rows[i].join(" | ") + " |");
      }
    }
    sheets.push(lines.join("\n"));
  });

  return sheets.join("\n\n");
}

// ---- Main pipeline ---------------------------------------------------------

/**
 * Extract text content from an array of Jira attachments.
 * Returns extraction results keyed by filename.
 */
export async function extractAttachments(
  opts: ExtractAttachmentsOptions,
): Promise<AttachmentExtraction[]> {
  const { client, attachments, aiProvider } = opts;
  const results: AttachmentExtraction[] = [];

  for (const meta of attachments) {
    try {
      // Skip oversized attachments
      if (meta.size > MAX_ATTACHMENT_SIZE) {
        results.push({
          filename: meta.filename,
          text: "",
          method: "skipped",
          skipReason: `File exceeds ${MAX_ATTACHMENT_SIZE / 1024 / 1024}MB limit (${(meta.size / 1024 / 1024).toFixed(1)}MB)`,
        });
        continue;
      }

      if (isTextAttachment(meta)) {
        const text = await extractText(client, meta);
        results.push({ filename: meta.filename, text, method: "text" });
      } else if (isImageAttachment(meta)) {
        if (!aiProvider) {
          results.push({
            filename: meta.filename,
            text: "",
            method: "skipped",
            skipReason: "No AI provider configured for image description",
          });
          continue;
        }
        const text = await extractImageDescription(client, meta, aiProvider);
        results.push({ filename: meta.filename, text, method: "image-description" });
      } else if (isPdfAttachment(meta)) {
        const text = await extractPdf(client, meta);
        results.push({ filename: meta.filename, text, method: "pdf" });
      } else if (isDocxAttachment(meta)) {
        const text = await extractDocx(client, meta);
        results.push({ filename: meta.filename, text, method: "docx" });
      } else if (isXlsxAttachment(meta)) {
        const text = await extractXlsx(client, meta);
        results.push({ filename: meta.filename, text, method: "xlsx" });
      } else {
        results.push({
          filename: meta.filename,
          text: "",
          method: "skipped",
          skipReason: `Unsupported MIME type: ${meta.mimeType}`,
        });
      }
    } catch (err) {
      log.warn("Attachment extraction failed", {
        filename: meta.filename,
        err: (err as Error).message,
      });
      results.push({
        filename: meta.filename,
        text: "",
        method: "skipped",
        skipReason: `Extraction failed: ${(err as Error).message}`,
      });
    }
  }

  return results;
}

/**
 * Format extraction results as markdown sections to append to a Jira issue
 * markdown document.
 */
export function renderAttachmentMarkdown(extractions: AttachmentExtraction[]): string {
  const sections: string[] = [];

  for (const ext of extractions) {
    if (ext.method === "skipped" || !ext.text) continue;

    const suffix = ext.method === "image-description" ? " (image description)" : "";
    sections.push(`## Attachment: ${ext.filename}${suffix}`);
    sections.push("");
    sections.push(ext.text);
  }

  return sections.join("\n");
}
