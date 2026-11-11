/**
 * #2232 — a Word package shaped like a BRD: numbered headings (`1`, `1.1`), a multi-level
 * numbered requirement list (`3.2.1`-style and a `REQ-%1` prefix), a bullet list, a table
 * with a merged cell, an embedded image with alt text, a reviewer comment, a footnote and
 * tracked changes. Built with JSZip from raw OOXML so every part is visible in review; the
 * parts follow what Word writes (`numbering.xml` abstractNum/num/lvlOverride, `styles.xml`
 * headings carrying `numPr`, `a:blip r:embed` for a picture).
 */
import JSZip from "jszip";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A 1×1 PNG: the bytes the describer is expected to be handed. */
export const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export function p(text: string, opts: { style?: string; numId?: string; ilvl?: number } = {}) {
  const numPr =
    opts.numId !== undefined
      ? `<w:numPr><w:ilvl w:val="${opts.ilvl ?? 0}"/><w:numId w:val="${opts.numId}"/></w:numPr>`
      : "";
  const style = opts.style ? `<w:pStyle w:val="${opts.style}"/>` : "";
  const pPr = style || numPr ? `<w:pPr>${style}${numPr}</w:pPr>` : "";
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

export function image(rId: string, alt: string, id = 1): string {
  return `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:docPr id="${id}" name="Picture ${id}" descr="${alt}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="${rId}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Heading1"/>
    <w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Kop3"><w:name w:val="heading 3"/></w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style>
</w:styles>`;

/** abstractNum 0: headings `1` / `1.1`; 1: requirements `1.` / `1.1.` / `1.1.1.` (decimal, letter, roman at depth); 2: bullets; 3: `REQ-%1`. */
const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1"/></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2."/></w:lvl>
    <w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2.%3"/></w:lvl>
    <w:lvl w:ilvl="3"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="(%4)"/></w:lvl>
    <w:lvl w:ilvl="4"><w:start w:val="1"/><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="%5)"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="2">
    <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="3">
    <w:lvl w:ilvl="0"><w:start w:val="10"/><w:numFmt w:val="decimal"/><w:lvlText w:val="REQ-%1"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
  <w:num w:numId="3"><w:abstractNumId w:val="2"/></w:num>
  <w:num w:numId="4"><w:abstractNumId w:val="3"/></w:num>
  <w:num w:numId="5"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>
</w:numbering>`;

const COMMENTS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="${W}">
  <w:comment w:id="0" w:author="Dana Analyst"><w:p><w:r><w:t>Confirm the lockout threshold with Security.</w:t></w:r></w:p></w:comment>
</w:comments>`;

const FOOTNOTES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="${W}">
  <w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
  <w:footnote w:id="1"><w:p><w:r><w:t>Per the 2026 password policy.</w:t></w:r></w:p></w:footnote>
</w:footnotes>`;

/** The BRD body: every structure the issue names, in reading order. */
export const BRD_BODY = [
  p("Login and Account Recovery", { style: "Heading1" }),
  p("Scope", { style: "Heading2" }),
  p("This section covers sign-in."),
  p("Requirements", { style: "Heading2" }),
  p("The system shall authenticate users.", { numId: "2", ilvl: 0 }),
  p("Users sign in with email.", { numId: "2", ilvl: 1 }),
  p("Email is validated.", { numId: "2", ilvl: 2 }),
  p("Format is checked.", { numId: "2", ilvl: 3 }),
  p("Domain is allow-listed.", { numId: "2", ilvl: 4 }),
  p("Users may use SSO.", { numId: "2", ilvl: 1 }),
  p("The system shall lock accounts.", { numId: "2", ilvl: 0 }),
  p("Generated id requirement.", { numId: "4", ilvl: 0 }),
  p("Second generated id.", { numId: "4", ilvl: 0 }),
  p("Notes", { style: "Heading1" }),
  p("Audit everything", { numId: "3", ilvl: 0 }),
  p("Including failures", { numId: "3", ilvl: 1 }),
  `<w:tbl><w:tr><w:tc>${p("ID")}</w:tc><w:tc>${p("Rule")}</w:tc><w:tc>${p("Owner")}</w:tc></w:tr>` +
    `<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${p("REQ-1")}</w:tc><w:tc>${p("Lock after 5 tries")}</w:tc><w:tc>${p("Sec | Ops")}</w:tc></w:tr>` +
    `<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${p("Unlock by email")}</w:tc></w:tr></w:tbl>`,
  image("rIdImg1", "Login wireframe"),
  `<w:p><w:r><w:t xml:space="preserve">Lockout is </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>mandatory</w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t xml:space="preserve"> after five attempts</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>`,
  `<w:p><w:r><w:t xml:space="preserve">Session timeout is </w:t></w:r><w:del w:id="9" w:author="Ed"><w:r><w:delText>30 minutes</w:delText></w:r></w:del><w:ins w:id="10" w:author="Ed"><w:r><w:t>15 minutes</w:t></w:r></w:ins><w:r><w:t>.</w:t></w:r></w:p>`,
  p("Appendix list restarts", { style: "Heading1" }),
  p("Restarted item.", { numId: "5", ilvl: 0 }),
].join("");

export interface DocxParts {
  body: string;
  styles?: string | null;
  numbering?: string | null;
  comments?: string | null;
  footnotes?: string | null;
  /** Extra package files, e.g. `{ "word/media/image1.png": PIXEL_PNG }`. */
  media?: Record<string, Buffer>;
  /** Relationships of the main part beyond the defaults. */
  rels?: string[];
}

/** Build a `.docx` from parts; omitted optional parts are left out of the package. */
export async function buildDocx(parts: DocxParts): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${parts.body}<w:sectPr/></w:body></w:document>`,
  );
  const rels: string[] = [...(parts.rels ?? [])];
  const add = (id: string, type: string, target: string, content: string | null | undefined) => {
    if (!content) return;
    zip.file(`word/${target}`, content);
    rels.push(`<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`);
  };
  add("rIdStyles", "styles", "styles.xml", parts.styles === undefined ? STYLES : parts.styles);
  add(
    "rIdNumbering",
    "numbering",
    "numbering.xml",
    parts.numbering === undefined ? NUMBERING : parts.numbering,
  );
  add("rIdComments", "comments", "comments.xml", parts.comments);
  add("rIdFootnotes", "footnotes", "footnotes.xml", parts.footnotes);
  for (const [path, data] of Object.entries(parts.media ?? {})) zip.file(path, data);
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

/** The BRD fixture with its image, comment and footnote parts. */
export function buildBrdDocx(): Promise<Buffer> {
  return buildDocx({
    body: BRD_BODY,
    comments: COMMENTS,
    footnotes: FOOTNOTES,
    media: { "word/media/image1.png": PIXEL_PNG },
    rels: [`<Relationship Id="rIdImg1" Type="${REL}/image" Target="media/image1.png"/>`],
  });
}
