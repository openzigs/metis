/**
 * #2229 — writes a corpus item's blocks as a Word document, so every arm reads
 * the document the way an analyst's upload is read: through production's
 * `parseDocument` (mammoth, then `htmlToMarkdown`), with whatever that
 * conversion keeps and loses.
 *
 * The bytes are not reproducible (the library stamps the build time), so the
 * committed `source.docx` is the corpus's source of truth for what an arm
 * reads; `labels.json` is checked against it by `corpus.test.ts`.
 */
import type { FrdBlock } from "./corpus-source.js";

const NUMBERING = "frd-numbering";

export async function renderFrdDocx(title: string, blocks: readonly FrdBlock[]): Promise<Buffer> {
  const {
    AlignmentType,
    Document,
    HeadingLevel,
    LevelFormat,
    Packer,
    Paragraph,
    Table,
    TableCell,
    TableRow,
    TextRun,
    WidthType,
  } = await import("docx");
  const headingLevel = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
  } as const;
  // A numbered list restarts after any other block, as an author's list would.
  let listInstance = 0;
  let previous: FrdBlock["kind"] | null = null;
  const children = blocks.map((b) => {
    if (b.kind === "numbered" && previous !== "numbered") listInstance++;
    previous = b.kind;
    switch (b.kind) {
      case "heading":
        return new Paragraph({ text: b.text, heading: headingLevel[b.level] });
      case "paragraph":
        return new Paragraph({ children: [new TextRun(b.text)] });
      case "bullet":
        return new Paragraph({ children: [new TextRun(b.text)], bullet: { level: 0 } });
      case "numbered":
        return new Paragraph({
          children: [new TextRun(b.text)],
          numbering: { reference: NUMBERING, level: 0, instance: listInstance },
        });
      case "table":
        return new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: b.rows.map(
            (row, r) =>
              new TableRow({
                tableHeader: r === 0,
                children: row.map(
                  (cell) =>
                    new TableCell({
                      children: [
                        new Paragraph({ children: [new TextRun({ text: cell, bold: r === 0 })] }),
                      ],
                    }),
                ),
              }),
          ),
        });
    }
  });
  const doc = new Document({
    title,
    creator: "METIS eval corpus (CC0-1.0)",
    numbering: {
      config: [
        {
          reference: NUMBERING,
          levels: [
            { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START },
          ],
        },
      ],
    },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}
