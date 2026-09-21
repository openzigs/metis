/**
 * The `MAX_PDF_PAGES` bound, in one place (#1279).
 *
 * The cap exists to bound memory use during text extraction, and byte size alone was
 * judged insufficient — a 320 KB PDF can carry 2001 pages. It was enforced in exactly one
 * of the routes that end in PDF parsing:
 *
 *   - `documents/parsers.ts` `parsePdf` — capped
 *   - `connectors/jira/attachment-extractor.ts` `extractPdf` — **not** capped; it called
 *     `getText()` straight after constructing the parser, bounded only by the attachment's
 *     self-reported `meta.size`
 *
 * A third route existed until #1279 and is now closed rather than capped: a PDF declared
 * `.pptx` reached `officeparser`, which sniffs a Buffer and re-dispatches into its own
 * `pdfjs-dist`. See `content-signature.ts`.
 *
 * Both surviving routes call the predicate below, so the comparison lives once. A caller
 * that stops calling it fails that caller's own test; a change to the comparison fails
 * both.
 */
import { MAX_PDF_PAGES } from "@metis/shared";

/** The part of `pdf-parse`'s `PDFParse` this bound needs. */
export interface PdfInfoSource {
  getInfo(): Promise<{ numPages?: number; total?: number }>;
}

/**
 * Whether a PDF reports more pages than `MAX_PDF_PAGES` and so must not be text-extracted.
 *
 * `pdf-parse` reports the count as `numPages` on some documents and `total` on others; a
 * document that reports neither is treated as 0 pages, which cannot exceed the cap — a
 * missing count is not evidence of a large document, and refusing on it would reject
 * readable PDFs.
 */
export async function exceedsPdfPageCap(parser: PdfInfoSource): Promise<boolean> {
  const info = await parser.getInfo();
  const pages = info.numPages ?? info.total ?? 0;
  return pages > MAX_PDF_PAGES;
}
