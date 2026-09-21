import { parseMarkdown } from "./markdown-provider.js";
import type { ImportProvider, ImportProviderContext, ImportProviderResult } from "./types.js";

export const docxProvider: ImportProvider = {
  source: "docx",
  parse(input, ctx) {
    if (typeof input === "string") {
      throw new TypeError("docxProvider requires a Buffer input");
    }
    return parseDocx(input, ctx);
  },
};

async function parseDocx(
  buffer: Buffer,
  _ctx: ImportProviderContext,
): Promise<ImportProviderResult> {
  const moduleName = "mammoth";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mammoth = (await import(moduleName)) as any;
  // Convert to Markdown by way of plain text + heading markers — mammoth's
  // built-in markdown converter does not preserve our ## blocks reliably for
  // a wide range of inputs, so we wrap headings ourselves.
  const { value: html } = (await mammoth.convertToHtml({ buffer })) as { value: string };
  const md = htmlToMarkdown(html);
  const result = parseMarkdown(md);
  return {
    ...result,
    cases: result.cases.map((c) => ({ ...c, source: "docx" })),
  };
}

function htmlToMarkdown(html: string): string {
  return html
    .replace(/<h1[^>]*>/gi, "\n## ")
    .replace(/<h2[^>]*>/gi, "\n## ")
    .replace(/<h3[^>]*>/gi, "\n**")
    .replace(/<\/h3>/gi, ":**\n")
    .replace(/<\/h[12]>/gi, "\n")
    .replace(/<br\s*\/?>(?:\s*)/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
