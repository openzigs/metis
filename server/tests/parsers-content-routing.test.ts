import { MAX_PDF_PAGES } from "@metis/shared";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  contentMatchesDeclaredMime,
  detectContentFamily,
  requiredContentFamily,
} from "../src/lib/documents/content-signature.js";
import { parseDocument } from "../src/lib/documents/parsers.js";
import { exceedsPdfPageCap } from "../src/lib/documents/pdf-page-bound.js";
import { createPdf } from "./helpers/pdf-fixture.js";

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/**
 * #1279 — the declared MIME type must agree with the content, or the document is refused.
 *
 * The bypass proof for the pptx route lives in `parsers-pptx-sniff-bypass.test.ts`, which
 * deliberately loads no PDF parser; see its header for why that isolation is what makes
 * the mutation proof honest.
 */
describe("MAX_PDF_PAGES binds on every route that can end in PDF parsing", () => {
  it("refuses an over-cap PDF whether it is declared as pdf or as pptx", async () => {
    // The cap must be a real bound, not a constant that happens to exceed the fixture.
    expect(MAX_PDF_PAGES).toBeGreaterThan(1);
    const overCap = createPdf(MAX_PDF_PAGES + 1, "OverCapProbe");

    // Route 1 — declared pdf: parsePdf's own page cap.
    const asPdf = await parseDocument({
      buffer: overCap,
      mimeType: PDF_MIME,
      filename: "big.pdf",
    });
    expect(asPdf.ok, "declared application/pdf must hit the page cap").toBe(false);
    if (!asPdf.ok) expect(asPdf.reason).toBe("PDF_TOO_MANY_PAGES");

    // Route 2 — declared pptx: officeparser would sniff these same bytes into its own
    // pdfjs and extract every page, applying no page bound at all. Refused before it can.
    const asPptx = await parseDocument({
      buffer: overCap,
      mimeType: PPTX_MIME,
      filename: "big.pptx",
    });
    expect(asPptx.ok, "declared pptx must not reach an unbounded PDF parse").toBe(false);
    if (!asPptx.ok) expect(asPptx.reason).toMatch(/^CONTENT_TYPE_MISMATCH/);
  });

  it("still parses an under-cap PDF, so the cap bounds rather than blocks", async () => {
    const r = await parseDocument({
      buffer: createPdf(2, "UnderCapProbe"),
      mimeType: PDF_MIME,
      filename: "small.pdf",
    });

    expect(r.ok, `expected a 2-page PDF to parse, got ${JSON.stringify(r)}`).toBe(true);
    if (r.ok) expect(r.text).toContain("UnderCapProbe");
  });
});

/**
 * Per-type verdicts for the sniff-and-re-dispatch class, established by running the
 * libraries rather than by reading them. These assertions are tripwires: if `mammoth` or
 * `exceljs` ever gains content sniffing the way `officeparser` has, they go red.
 */
describe("other declared types: does the library re-dispatch on content?", () => {
  const pdfBytes = createPdf(1, "CrossTypeProbe");

  it("mammoth (docx) requires a zip container and never re-dispatches to a PDF parser", async () => {
    const mammoth = (await import("mammoth")) as {
      convertToHtml(input: { buffer: Buffer }): Promise<{ value: string }>;
    };

    // Called directly, bypassing our gate: the verdict is about the LIBRARY.
    await expect(mammoth.convertToHtml({ buffer: pdfBytes })).rejects.toThrow(
      /end of central directory|zip/i,
    );
  });

  it("exceljs (xlsx) requires a zip container and never re-dispatches to a PDF parser", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();

    await expect(workbook.xlsx.load(pdfBytes)).rejects.toThrow();
  });

  it("refuses PDF bytes declared as docx at the routing decision", async () => {
    const r = await parseDocument({ buffer: pdfBytes, mimeType: DOCX_MIME, filename: "x.docx" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^CONTENT_TYPE_MISMATCH/);
  });

  it("refuses PDF bytes declared as xlsx at the routing decision", async () => {
    const r = await parseDocument({ buffer: pdfBytes, mimeType: XLSX_MIME, filename: "x.xlsx" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^CONTENT_TYPE_MISMATCH/);
  });

  it("refuses zip bytes declared as pdf", async () => {
    const zip = Buffer.from(
      await new JSZip().file("a.txt", "hi").generateAsync({ type: "nodebuffer" }),
    );
    const r = await parseDocument({ buffer: zip, mimeType: PDF_MIME, filename: "x.pdf" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("content zip");
  });
});

/**
 * The gate must not become a *substitute* for the parsers' own error handling.
 *
 * `documents.test.ts` used to reach `parseDocx`/`parseXlsx`/`parsePptx`'s catch branches
 * by feeding them plain text; since #1279 that text is refused earlier, which would have
 * left those three `*_PARSE_FAILED` returns executed by no test at all. A zip-signed
 * buffer that is not a valid OOXML package passes the gate and still fails inside the
 * library, so it reaches exactly the branches the gate displaced. #1279's adversarial
 * panel caught this by mutating all three catch returns to `{ ok: true }` and finding the
 * suite still green.
 */
describe("library failures are still reported after the gate admits a document", () => {
  /** A structurally valid zip that is not an OOXML package of any kind. */
  async function createNonOoxmlZip(): Promise<Buffer> {
    return Buffer.from(
      await new JSZip().file("notes.txt", "not an office document").generateAsync({
        type: "nodebuffer",
      }),
    );
  }

  it("returns DOCX_PARSE_FAILED for a zip that is not a Word package", async () => {
    const r = await parseDocument({
      buffer: await createNonOoxmlZip(),
      mimeType: DOCX_MIME,
      filename: "n.docx",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^DOCX_PARSE_FAILED/);
  });

  it("returns XLSX_PARSE_FAILED for a workbook part that is not valid XML", async () => {
    // A bare zip is NOT enough here: exceljs reads it as a workbook with no sheets and
    // returns "*Empty spreadsheet*". Corrupting `xl/workbook.xml` is what reaches the
    // catch — measured, not assumed.
    const buffer = Buffer.from(
      await new JSZip()
        .file("[Content_Types].xml", "<Types/>")
        .file("xl/workbook.xml", "<<<not xml")
        .generateAsync({ type: "nodebuffer" }),
    );

    const r = await parseDocument({ buffer, mimeType: XLSX_MIME, filename: "n.xlsx" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^XLSX_PARSE_FAILED/);
  });

  it("returns PPTX_PARSE_FAILED for a zip that is not a presentation", async () => {
    const r = await parseDocument({
      buffer: await createNonOoxmlZip(),
      mimeType: PPTX_MIME,
      filename: "n.pptx",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^PPTX_PARSE_FAILED/);
  });

  it("returns PDF_PARSE_FAILED for a truncated PDF that clears the signature check", async () => {
    // `%PDF` is present, so the gate admits it; the document itself is unreadable.
    const r = await parseDocument({
      buffer: Buffer.from("%PDF-1.4 truncated, no xref, no trailer"),
      mimeType: PDF_MIME,
      filename: "n.pdf",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^PDF_PARSE_FAILED/);
  });
});

describe("MAX_PDF_PAGES lives in one predicate (#1279)", () => {
  /** Stands in for `pdf-parse`'s parser; the count is the only thing the bound reads. */
  const parserReporting = (info: { numPages?: number; total?: number }) => ({
    getInfo: async () => info,
  });

  it("compares strictly greater than the cap, one page either side of it", async () => {
    expect(await exceedsPdfPageCap(parserReporting({ numPages: MAX_PDF_PAGES - 1 }))).toBe(false);
    expect(await exceedsPdfPageCap(parserReporting({ numPages: MAX_PDF_PAGES }))).toBe(false);
    expect(await exceedsPdfPageCap(parserReporting({ numPages: MAX_PDF_PAGES + 1 }))).toBe(true);
  });

  it("falls back to `total` and treats an absent count as zero pages", async () => {
    expect(await exceedsPdfPageCap(parserReporting({ total: MAX_PDF_PAGES + 1 }))).toBe(true);
    expect(await exceedsPdfPageCap(parserReporting({ total: 1 }))).toBe(false);
    // A missing count is not evidence of a large document — refusing here would reject
    // readable PDFs that simply do not report a page count.
    expect(await exceedsPdfPageCap(parserReporting({}))).toBe(false);
  });
});

describe("content-signature predicate", () => {
  it("maps each signed declared type to the family its bytes must carry", () => {
    expect(requiredContentFamily(PDF_MIME)).toBe("pdf");
    expect(requiredContentFamily(DOCX_MIME)).toBe("zip");
    expect(requiredContentFamily(XLSX_MIME)).toBe("zip");
    expect(requiredContentFamily(PPTX_MIME)).toBe("zip");
  });

  it("treats the text-shaped types as unsigned, so they are not checked this way", () => {
    for (const mime of ["text/plain", "text/markdown", "text/html", "application/json"]) {
      expect(requiredContentFamily(mime)).toBeNull();
      expect(contentMatchesDeclaredMime(mime, Buffer.from("%PDF-1.4 whatever"))).toBe(true);
    }
  });

  it("detects the PDF and zip families with literal signatures", () => {
    expect(detectContentFamily(Buffer.from("%PDF-1.7\n..."))).toBe("pdf");
    expect(detectContentFamily(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe("zip");
    // Empty archive and spanned archive, the other two signatures `file-type` accepts.
    expect(detectContentFamily(Buffer.from([0x50, 0x4b, 0x05, 0x06, 0x00]))).toBe("zip");
    expect(detectContentFamily(Buffer.from([0x50, 0x4b, 0x07, 0x08, 0x00]))).toBe("zip");
  });

  it("reports no family for bytes with no signature, including a bare PK prefix", () => {
    expect(detectContentFamily(Buffer.from("plain text file"))).toBeNull();
    // "PK" alone is not a zip signature — bytes 2 and 3 must match too.
    expect(detectContentFamily(Buffer.from([0x50, 0x4b, 0x99, 0x99]))).toBeNull();
    // A signature cannot be established from fewer than four bytes.
    expect(detectContentFamily(Buffer.from([0x50, 0x4b, 0x03]))).toBeNull();
    expect(detectContentFamily(Buffer.alloc(0))).toBeNull();
  });

  it("accepts a real OOXML package for every OOXML declared type", async () => {
    const ooxml = Buffer.from(
      await new JSZip()
        .file("[Content_Types].xml", "<Types/>")
        .generateAsync({ type: "nodebuffer" }),
    );

    for (const mime of [DOCX_MIME, XLSX_MIME, PPTX_MIME]) {
      expect(contentMatchesDeclaredMime(mime, ooxml)).toBe(true);
    }
    expect(contentMatchesDeclaredMime(PDF_MIME, ooxml)).toBe(false);
  });

  it("rejects a document whose declared family is not the one its bytes carry", () => {
    const pdf = createPdf(1, "x");
    expect(contentMatchesDeclaredMime(PDF_MIME, pdf)).toBe(true);
    expect(contentMatchesDeclaredMime(PPTX_MIME, pdf)).toBe(false);
    expect(contentMatchesDeclaredMime(DOCX_MIME, pdf)).toBe(false);
    expect(contentMatchesDeclaredMime(XLSX_MIME, pdf)).toBe(false);
  });
});
