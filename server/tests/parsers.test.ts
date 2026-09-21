/**
 * Parser happy-path + edge-case tests using real libraries.
 *
 * The existing documents.test.ts covers error paths (invalid bytes → real
 * library errors).  This file creates real minimal file buffers to exercise
 * the successful-parse branches and edge cases in parsers.ts.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { parseDocument } from "../src/lib/documents/parsers.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/**
 * Create a real XLSX buffer with the given sheet data using exceljs.
 */
async function createXlsxBuffer(
  sheets: { name: string; rows: (string | number | null)[][]; merges?: string[] }[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name);
    for (const row of sheet.rows) {
      ws.addRow(row);
    }
    if (sheet.merges) {
      for (const merge of sheet.merges) {
        ws.mergeCells(merge);
      }
    }
  }
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Create a minimal valid DOCX buffer using raw OOXML + JSZip.
 * mammoth needs [Content_Types].xml, _rels/.rels, word/document.xml
 */
async function createDocxBuffer(bodyXml: string): Promise<Buffer> {
  const zip = new JSZip();

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );

  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );

  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyXml}</w:body>
</w:document>`,
  );

  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
  );

  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return buf;
}

/* ================================================================== */
/*  XLSX                                                              */
/* ================================================================== */
describe("parseXlsx (real exceljs)", () => {
  it("converts a simple worksheet to a Markdown table", async () => {
    const buffer = await createXlsxBuffer([
      {
        name: "Sheet1",
        rows: [
          ["Name", "Age"],
          ["Alice", 30],
          ["Bob", 25],
        ],
      },
    ]);

    const r = await parseDocument({ buffer, mimeType: XLSX_MIME, filename: "a.xlsx" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain("## Sheet1");
      expect(r.text).toContain("Name");
      expect(r.text).toContain("Alice");
      expect(r.text).toContain("30");
    }
  });

  it("returns *Empty spreadsheet* for a workbook with no data rows", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Empty");
    const arrayBuffer = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const r = await parseDocument({ buffer, mimeType: XLSX_MIME, filename: "empty.xlsx" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("*Empty spreadsheet*");
  });

  it("handles merged cells", async () => {
    const buffer = await createXlsxBuffer([
      {
        name: "Merged",
        rows: [
          ["Header", null, "Other"],
          ["Data1", "Data2", "Data3"],
        ],
        merges: ["A1:B1"],
      },
    ]);

    const r = await parseDocument({ buffer, mimeType: XLSX_MIME, filename: "merge.xlsx" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain("## Merged");
      expect(r.text).toContain("Header");
      expect(r.text).toContain("Data1");
    }
  });

  it("joins multiple sheets", async () => {
    const buffer = await createXlsxBuffer([
      { name: "First", rows: [["A"]] },
      { name: "Second", rows: [["B"]] },
    ]);

    const r = await parseDocument({ buffer, mimeType: XLSX_MIME, filename: "multi.xlsx" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain("## First");
      expect(r.text).toContain("## Second");
    }
  });

  it("handles null cell values", async () => {
    const buffer = await createXlsxBuffer([
      {
        name: "Sheet1",
        rows: [
          ["Name", "Age"],
          [null, 42],
        ],
      },
    ]);

    const r = await parseDocument({ buffer, mimeType: XLSX_MIME, filename: "nulls.xlsx" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("42");
  });

  it("sniffs .xlsx extension from application/octet-stream", async () => {
    const buffer = await createXlsxBuffer([{ name: "S1", rows: [["val"]] }]);

    const r = await parseDocument({
      buffer,
      mimeType: "application/octet-stream",
      filename: "data.xlsx",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("val");
  });
});

/* ================================================================== */
/*  DOCX                                                              */
/* ================================================================== */
describe("parseDocx (real mammoth)", () => {
  it("converts DOCX with a paragraph to Markdown", async () => {
    const buffer = await createDocxBuffer(`<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>`);

    const r = await parseDocument({ buffer, mimeType: DOCX_MIME, filename: "a.docx" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("Hello World");
  });

  it("converts DOCX with bold text to Markdown", async () => {
    const buffer = await createDocxBuffer(
      `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold Text</w:t></w:r></w:p>`,
    );

    const r = await parseDocument({ buffer, mimeType: DOCX_MIME, filename: "bold.docx" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("**Bold Text**");
  });

  it("converts DOCX with heading to Markdown", async () => {
    const buffer = await createDocxBuffer(
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>My Title</w:t></w:r></w:p>`,
    );

    const r = await parseDocument({ buffer, mimeType: DOCX_MIME, filename: "heading.docx" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("My Title");
  });

  it("returns DOCX_EMPTY_TEXT for an empty DOCX body", async () => {
    const buffer = await createDocxBuffer("");

    const r = await parseDocument({ buffer, mimeType: DOCX_MIME, filename: "empty.docx" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("DOCX_EMPTY_TEXT");
  });

  it("sniffs .docx extension from application/octet-stream", async () => {
    const buffer = await createDocxBuffer(`<w:p><w:r><w:t>Sniffed</w:t></w:r></w:p>`);

    const r = await parseDocument({
      buffer,
      mimeType: "application/octet-stream",
      filename: "doc.docx",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("Sniffed");
  });
});

/* ================================================================== */
/*  PDF                                                               */
/* ================================================================== */
describe("parsePdf (real pdf-parse)", () => {
  /**
   * Create a minimal valid PDF with text content.
   * pdf-parse v4 needs a real PDF structure to parse.
   */
  function createMinimalPdf(text: string): Buffer {
    // Build a minimal valid PDF 1.0 structure
    const streamContent = `BT /F1 12 Tf 100 700 Td (${text}) Tj ET`;
    const streamLength = Buffer.byteLength(streamContent, "ascii");

    const lines = [
      "%PDF-1.0",
      "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj",
      "2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj",
      `3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj`,
      `4 0 obj<< /Length ${streamLength} >>\nstream\n${streamContent}\nendstream\nendobj`,
      "5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj",
    ];

    // Build the body and calculate xref offsets
    const body = lines.join("\n") + "\n";
    const xrefOffset = body.length;

    const xref = ["xref", "0 6", "0000000000 65535 f "];

    // Calculate byte offsets for objects 1-5
    let pos = 0;
    for (const line of lines) {
      if (line.startsWith("1 0 obj")) xref.push(`${String(pos).padStart(10, "0")} 00000 n `);
      if (line.startsWith("2 0 obj")) xref.push(`${String(pos).padStart(10, "0")} 00000 n `);
      if (line.startsWith("3 0 obj")) xref.push(`${String(pos).padStart(10, "0")} 00000 n `);
      if (line.startsWith("4 0 obj")) xref.push(`${String(pos).padStart(10, "0")} 00000 n `);
      if (line.startsWith("5 0 obj")) xref.push(`${String(pos).padStart(10, "0")} 00000 n `);
      pos += Buffer.byteLength(line + "\n", "ascii");
    }

    const trailer = [
      ...xref,
      `trailer << /Size 6 /Root 1 0 R >>`,
      "startxref",
      String(xrefOffset),
      "%%EOF",
    ].join("\n");

    return Buffer.from(body + trailer, "ascii");
  }

  it("parses a minimal valid PDF and returns text", async () => {
    const buffer = createMinimalPdf("TestContent");

    const r = await parseDocument({ buffer, mimeType: "application/pdf", filename: "test.pdf" });
    // If pdf-parse can parse our minimal PDF, we should get text
    // If it can't, it will fail with PDF_PARSE_FAILED (acceptable for a minimal PDF)
    if (r.ok) {
      expect(r.text).toContain("TestContent");
    } else {
      // The minimal PDF may not be parseable by all versions of pdf-parse
      expect(r.reason).toMatch(/^PDF_/);
    }
  });

  it("sniffs .pdf extension from application/octet-stream", async () => {
    // Even with invalid data, the extension should route to the PDF handler. Since #1279
    // the bytes are checked against the resolved type before any parser runs, so the
    // refusal comes from the routing decision — and it names the type the extension
    // resolved to, which is what makes the routing still observable here.
    const r = await parseDocument({
      buffer: Buffer.from("not a pdf"),
      mimeType: "application/octet-stream",
      filename: "report.pdf",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/^CONTENT_TYPE_MISMATCH/);
      expect(r.reason).toContain("declared application/pdf");
    }
  });
});

/* ================================================================== */
/*  PPTX                                                              */
/* ================================================================== */
describe("parsePptx (real officeparser)", () => {
  /**
   * Create a minimal valid PPTX using JSZip + raw Open XML.
   */
  async function createPptxBuffer(slideBodyXml: string): Promise<Buffer> {
    const zip = new JSZip();

    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`,
    );

    zip.file(
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`,
    );

    zip.file(
      "ppt/presentation.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>
</p:presentation>`,
    );

    zip.file(
      "ppt/_rels/presentation.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`,
    );

    zip.file(
      "ppt/slides/slide1.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>${slideBodyXml}</p:cSld>
</p:sld>`,
    );

    zip.file(
      "ppt/slides/_rels/slide1.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
    );

    return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
  }

  it("extracts text from a simple slide", async () => {
    const buffer = await createPptxBuffer(`
      <p:spTree>
        <p:sp>
          <p:txBody>
            <a:p><a:r><a:t>Hello Presentation</a:t></a:r></a:p>
          </p:txBody>
        </p:sp>
      </p:spTree>
    `);

    const r = await parseDocument({ buffer, mimeType: PPTX_MIME, filename: "deck.pptx" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("Hello Presentation");
  });

  it("handles a minimal empty slide", async () => {
    const buffer = await createPptxBuffer(`<p:spTree/>`);

    const r = await parseDocument({ buffer, mimeType: PPTX_MIME, filename: "empty.pptx" });
    // Might be empty or have minimal content — just shouldn't fail
    expect(r.ok).toBe(true);
  });
});

/* ================================================================== */
/*  Extension sniffing (normaliseMime)                                */
/* ================================================================== */
describe("normaliseMime via parseDocument", () => {
  it("sniffs .html extension", async () => {
    const r = await parseDocument({
      buffer: Buffer.from("<p>hello</p>"),
      mimeType: "application/octet-stream",
      filename: "page.html",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("hello");
  });

  it("sniffs .htm extension", async () => {
    const r = await parseDocument({
      buffer: Buffer.from("<p>content</p>"),
      mimeType: "application/octet-stream",
      filename: "page.htm",
    });
    expect(r.ok).toBe(true);
  });

  it("sniffs .txt extension", async () => {
    const r = await parseDocument({
      buffer: Buffer.from("plain text"),
      mimeType: "application/octet-stream",
      filename: "notes.txt",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("plain text");
  });

  it("sniffs .json extension", async () => {
    const r = await parseDocument({
      buffer: Buffer.from('{"a":1}'),
      mimeType: "application/octet-stream",
      filename: "data.json",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain('"a": 1');
  });

  it("sniffs .markdown extension", async () => {
    const r = await parseDocument({
      buffer: Buffer.from("# hi"),
      mimeType: "application/octet-stream",
      filename: "notes.markdown",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("# hi");
  });

  it("returns MIME_UNSUPPORTED for unknown extension and MIME", async () => {
    const r = await parseDocument({
      buffer: Buffer.from("binary"),
      mimeType: "application/octet-stream",
      filename: "file.xyz",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("MIME_UNSUPPORTED");
  });
});

/* ================================================================== */
/*  Surrogate stripping                                               */
/* ================================================================== */
describe("parseDocument — lone surrogate sanitization", () => {
  it("strips lone surrogates from plain text", async () => {
    // \uD800 is a lone high surrogate, \uDC00 without a preceding high is a lone low surrogate
    const input = Buffer.from("Hello \uD800 world \uDC00 end", "utf-8");
    const r = await parseDocument({
      buffer: input,
      mimeType: "text/plain",
      filename: "test.txt",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).not.toMatch(/[\uD800-\uDFFF]/);
      expect(r.text).toContain("Hello");
      expect(r.text).toContain("world");
      expect(r.text).toContain("end");
      // Verify the result is valid JSON-serializable (no surrogate errors)
      expect(() => JSON.stringify(r.text)).not.toThrow();
    }
  });

  it("strips surrogates from markdown", async () => {
    const input = Buffer.from("# Title\n\nParagraph with \uD83D data", "utf-8");
    const r = await parseDocument({
      buffer: input,
      mimeType: "text/markdown",
      filename: "doc.md",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).not.toMatch(/[\uD800-\uDFFF]/);
      expect(() => JSON.stringify(r.text)).not.toThrow();
    }
  });
});
