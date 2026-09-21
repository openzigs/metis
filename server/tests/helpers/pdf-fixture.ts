/**
 * Real PDF byte-streams for parser tests.
 *
 * These are genuine PDFs — a correct header, object table, xref and trailer — not a
 * `%PDF` prefix on junk. That matters: the defects these fixtures exercise (#1273, #1279)
 * only appear when a real parser successfully reads the bytes, so a stub that merely
 * *looks* like a PDF would assert nothing.
 */

/**
 * Build a syntactically valid PDF with `pageCount` pages, every page rendering `text`.
 *
 * All pages share one content-stream object, so a 2001-page document is ~320 KB and stays
 * well inside `MAX_DOCUMENT_PARSE_BYTES` — the point is to exceed the *page* cap while
 * leaving the *byte* cap untouched, which is exactly the case `MAX_PDF_PAGES` was added
 * for.
 */
export function createPdf(pageCount: number, text: string): Buffer {
  const streamContent = `BT /F1 12 Tf 100 700 Td (${text}) Tj ET`;
  const streamLength = Buffer.byteLength(streamContent, "ascii");
  const contentObjNum = 3 + pageCount;
  const fontObjNum = contentObjNum + 1;

  const kids: string[] = [];
  for (let i = 0; i < pageCount; i += 1) kids.push(`${3 + i} 0 R`);

  const objects: string[] = [
    "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj",
    `2 0 obj<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pageCount} >>endobj`,
  ];
  for (let i = 0; i < pageCount; i += 1) {
    objects.push(
      `${3 + i} 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Contents ${contentObjNum} 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> >>endobj`,
    );
  }
  objects.push(
    `${contentObjNum} 0 obj<< /Length ${streamLength} >>\nstream\n${streamContent}\nendstream\nendobj`,
  );
  objects.push(`${fontObjNum} 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj`);

  const header = "%PDF-1.4\n";
  let pos = header.length;
  const offsets: number[] = [];
  const body: string[] = [];
  for (const obj of objects) {
    offsets.push(pos);
    const line = `${obj}\n`;
    body.push(line);
    pos += Buffer.byteLength(line, "ascii");
  }

  const xrefOffset = pos;
  const size = objects.length + 1;
  const xref = ["xref", `0 ${size}`, "0000000000 65535 f "];
  for (const off of offsets) xref.push(`${String(off).padStart(10, "0")} 00000 n `);
  const trailer = `${xref.join("\n")}\ntrailer << /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(header + body.join("") + trailer, "ascii");
}
