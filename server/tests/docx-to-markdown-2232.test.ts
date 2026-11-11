/**
 * #2232 — Word conversion keeps requirement numbering, nested lists, tables and images, and
 * reports what it cannot carry instead of dropping it.
 *
 * Every case goes through `parseDocument` (the path document ingest and governing-document
 * upload both take) unless it pins a helper of the converter itself.
 */
import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { parseDocument } from "../src/lib/documents/parsers.js";
import {
  MAX_DESCRIBED_IMAGES,
  MAX_DESCRIBED_IMAGE_BYTES,
  docxToMarkdown,
  formatNumber,
  type ImageDescriber,
} from "../src/lib/documents/docx-to-markdown.js";
import { PIXEL_PNG, buildBrdDocx, buildDocx, image, p } from "./fixtures/docx-2232.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

async function parse(buffer: Buffer, describeImage?: ImageDescriber): Promise<string> {
  const r = await parseDocument({
    buffer,
    mimeType: DOCX_MIME,
    filename: "brd.docx",
    describeImage,
  });
  if (!r.ok) throw new Error(`parse failed: ${r.reason}`);
  return r.text;
}

function imageRel(id: string, target: string, external = false): string {
  return `<Relationship Id="${id}" Type="${REL}/image" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`;
}

describe("the BRD fixture (numbering, nesting, a table, an image, comments, tracked changes)", () => {
  it("keeps heading numbers and levels from the heading styles' numbering", async () => {
    const text = await parse(await buildBrdDocx());
    expect(text).toContain(
      "# 1 Login and Account Recovery\n\n## 1.1 Scope\n\nThis section covers sign-in.",
    );
    expect(text).toContain("## 1.2 Requirements");
    expect(text).toContain("# 2 Notes");
    expect(text).toContain("# 3 Appendix list restarts");
  });

  it("keeps multi-level requirement numbers and nests each level under its parent", async () => {
    const text = await parse(await buildBrdDocx());
    expect(text).toContain(
      [
        "1. The system shall authenticate users.",
        "    - 1.1. Users sign in with email.",
        "        - 1.1.1 Email is validated.",
        "            - (a) Format is checked.",
        "                - i) Domain is allow-listed.",
        "    - 1.2. Users may use SSO.",
        "2. The system shall lock accounts.",
      ].join("\n"),
    );
  });

  it("keeps a generated requirement id (`REQ-%1`, starting at 10) as the item's label", async () => {
    const text = await parse(await buildBrdDocx());
    expect(text).toContain("- REQ-10 Generated id requirement.\n- REQ-11 Second generated id.");
  });

  it("nests bullets by level", async () => {
    const text = await parse(await buildBrdDocx());
    expect(text).toContain("- Audit everything\n    - Including failures");
  });

  it("restarts a list where a `startOverride` instance of it is first used", async () => {
    const text = await parse(await buildBrdDocx());
    expect(text).toContain("# 3 Appendix list restarts\n\n1. Restarted item.");
  });

  it("keeps a table as a table: a vertical merge repeats the value, a span leaves a filler cell", async () => {
    const text = await parse(await buildBrdDocx());
    expect(text).toContain(
      [
        "| ID | Rule | Owner |",
        "| --- | --- | --- |",
        "| REQ-1 | Lock after 5 tries | Sec \\| Ops |",
        "| REQ-1 | Unlock by email |  |",
      ].join("\n"),
    );
  });

  it("lists an image it cannot describe as not read, with its alt text, in place", async () => {
    const text = await parse(await buildBrdDocx());
    expect(text).toContain(
      // #2263 — with no describer at all (a governing-document upload) the reason says so,
      // rather than blaming a model configuration that route never consults.
      '| REQ-1 | Unlock by email |  |\n\n> **Image 1** (image1.png, alt text "Login wireframe"): image not read: images are not described for this kind of document.\n\nLockout is',
    );
    expect(text).not.toContain("[Image 1]\n");
  });

  it("keeps bold, a comment as a note and a footnote", async () => {
    const text = await parse(await buildBrdDocx());
    expect(text).toContain("Lockout is **mandatory** after five attempts [comment 1][^1]");
    expect(text).toContain("## Footnotes\n\n[^1]: Per the 2026 password policy.");
    expect(text).toContain(
      "## Reviewer comments\n\n- [comment 1] Dana Analyst: Confirm the lockout threshold with Security.",
    );
  });

  it("shows tracked changes accepted and reports the deleted text rather than dropping it", async () => {
    const text = await parse(await buildBrdDocx());
    expect(text).toContain("Session timeout is 15 minutes.");
    expect(text).not.toContain("Session timeout is 30 minutes");
    expect(text).toContain(
      [
        "## Conversion notes",
        "",
        '- 1 reviewer comment is kept as notes under "Reviewer comments".',
        "- 1 image: 0 described, 1 not read.",
        "- Tracked changes: 1 insertion shown as accepted; 1 deletion not shown in the text.",
        '- Deleted text: "30 minutes"',
      ].join("\n"),
    );
  });
});

describe("image description", () => {
  it("hands the describer the image bytes, type and alt text, and quotes its description in place", async () => {
    const describe = vi
      .fn<ImageDescriber>()
      .mockResolvedValue("A login form.\nEmail and password fields.");
    const text = await parse(await buildBrdDocx(), describe);
    expect(describe).toHaveBeenCalledTimes(1);
    const arg = describe.mock.calls[0][0];
    expect(arg).toMatchObject({
      index: 1,
      name: "image1.png",
      contentType: "image/png",
      altText: "Login wireframe",
    });
    expect(arg.data.equals(PIXEL_PNG)).toBe(true);
    expect(text).toContain(
      '> **Image 1** (image1.png, alt text "Login wireframe"): A login form.\n> Email and password fields.',
    );
    expect(text).toContain("- 1 image: 1 described, 0 not read.");
  });

  it("lists the image as not read when the describer has no vision model (null)", async () => {
    const text = await parse(await buildBrdDocx(), async () => null);
    expect(text).toContain("image not read: no vision-capable model is configured.");
  });

  it("lists the image as not read when the model returns nothing", async () => {
    const text = await parse(await buildBrdDocx(), async () => "   ");
    expect(text).toContain("image not read: the model returned no description.");
  });

  it("keeps converting when a description fails, and says why that image was not read", async () => {
    const text = await parse(await buildBrdDocx(), async () => {
      throw new Error("rate limited");
    });
    expect(text).toContain("image not read: the description failed.");
    // The provider's raw message never reaches the stored text (#1059).
    expect(text).not.toContain("rate limited");
    expect(text).toContain("Session timeout is 15 minutes.");
  });

  it(`describes at most ${MAX_DESCRIBED_IMAGES} images and says so for the rest`, async () => {
    const count = MAX_DESCRIBED_IMAGES + 1;
    const body = Array.from({ length: count }, (_, i) =>
      image("rIdImg", `pic ${i + 1}`, i + 1),
    ).join("");
    const buffer = await buildDocx({
      body,
      media: { "word/media/image1.png": PIXEL_PNG },
      rels: [imageRel("rIdImg", "media/image1.png")],
    });
    const describe = vi.fn<ImageDescriber>().mockResolvedValue("seen");
    const text = await parse(buffer, describe);
    expect(describe).toHaveBeenCalledTimes(MAX_DESCRIBED_IMAGES);
    expect(text).toContain(
      `> **Image ${count}** (image1.png, alt text "pic ${count}"): image not read: only the first ${MAX_DESCRIBED_IMAGES} images in a document are described.`,
    );
    expect(text).toContain(`- ${count} images: ${MAX_DESCRIBED_IMAGES} described, 1 not read.`);
  });

  it("does not send a format a model cannot read (EMF), nor a linked image", async () => {
    const buffer = await buildDocx({
      body: image("rIdEmf", "", 1) + image("rIdLink", "remote", 2),
      media: { "word/media/image2.emf": Buffer.from("emf") },
      rels: [
        imageRel("rIdEmf", "media/image2.emf"),
        imageRel("rIdLink", "https://example.com/a.png", true),
      ],
    });
    const describe = vi.fn<ImageDescriber>().mockResolvedValue("seen");
    const text = await parse(buffer, describe);
    expect(describe).not.toHaveBeenCalled();
    expect(text).toContain(
      "> **Image 1** (image2.emf): image not read: its format (image2.emf) cannot be sent to a model.",
    );
    expect(text).toContain(
      '> **Image 2** (https://example.com/a.png, alt text "remote"): image not read: it is linked from outside the document, not embedded.',
    );
  });

  it(`does not send an image larger than ${MAX_DESCRIBED_IMAGE_BYTES} bytes`, async () => {
    const buffer = await buildDocx({
      body: image("rIdBig", "big"),
      media: { "word/media/big.png": Buffer.alloc(MAX_DESCRIBED_IMAGE_BYTES + 1) },
      rels: [imageRel("rIdBig", "media/big.png")],
    });
    const describe = vi.fn<ImageDescriber>().mockResolvedValue("seen");
    const text = await parse(buffer, describe);
    expect(describe).not.toHaveBeenCalled();
    expect(text).toContain("image not read: it is larger than 5 MB.");
  });

  it("reads a legacy VML picture (`v:imagedata`) and an image inside a table cell", async () => {
    const vml = `<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:imagedata r:id="rIdImg" o:title="Old diagram" xmlns:o="urn:schemas-microsoft-com:office:office"/></v:shape></w:pict></w:r></w:p>`;
    const cell = `<w:tbl><w:tr><w:tc>${p("Screen")}</w:tc><w:tc>${image("rIdImg", "Cell pic", 2)}</w:tc></w:tr></w:tbl>`;
    const buffer = await buildDocx({
      body: vml + cell,
      media: { "word/media/image1.png": PIXEL_PNG },
      rels: [imageRel("rIdImg", "media/image1.png")],
    });
    const text = await parse(buffer);
    expect(text).toContain('> **Image 1** (image1.png, alt text "Old diagram"): image not read');
    expect(text).toContain("| Screen | [Image 2] |");
    expect(text).toContain('> **Image 2** (image1.png, alt text "Cell pic"): image not read');
  });
});

describe("numbering details", () => {
  const numbering = (
    levels: string,
    nums = `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`,
  ) =>
    `<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0">${levels}</w:abstractNum>${nums}</w:numbering>`;

  it("formats letters, roman numerals and zero-padded decimals as Word does", () => {
    expect(formatNumber(1, "lowerLetter")).toBe("a");
    expect(formatNumber(27, "upperLetter")).toBe("AA");
    expect(formatNumber(1994, "upperRoman")).toBe("MCMXCIV");
    expect(formatNumber(4, "lowerRoman")).toBe("iv");
    expect(formatNumber(7, "decimalZero")).toBe("07");
    expect(formatNumber(12, "decimalZero")).toBe("12");
    expect(formatNumber(3, "none")).toBe("");
    expect(formatNumber(3, "cardinalText")).toBe("3");
    expect(formatNumber(0, "lowerLetter")).toBe("0");
    expect(formatNumber(4000, "upperRoman")).toBe("4000");
  });

  it("restarts a deeper level after its parent advances, unless `lvlRestart` is 0", async () => {
    const levels = `<w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl><w:lvl w:ilvl="2"><w:lvlRestart w:val="0"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%3)"/></w:lvl>`;
    const body = [
      p("A", { numId: "1", ilvl: 0 }),
      p("A1", { numId: "1", ilvl: 1 }),
      p("x", { numId: "1", ilvl: 2 }),
      p("B", { numId: "1", ilvl: 0 }),
      p("B1", { numId: "1", ilvl: 1 }),
      p("y", { numId: "1", ilvl: 2 }),
    ].join("");
    const text = await parse(await buildDocx({ body, numbering: numbering(levels) }));
    expect(text).toContain(
      "1. A\n    - 1.1 A1\n        - a) x\n2. B\n    - 2.1 B1\n        - b) y",
    );
  });

  it("shows every level in decimal under `isLgl` (legal numbering)", async () => {
    const levels = `<w:lvl w:ilvl="0"><w:numFmt w:val="upperRoman"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:isLgl/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl>`;
    const body = [p("Part", { numId: "1", ilvl: 0 }), p("Clause", { numId: "1", ilvl: 1 })].join(
      "",
    );
    const text = await parse(await buildDocx({ body, numbering: numbering(levels) }));
    expect(text).toContain("- I. Part\n    - 1.1 Clause");
  });

  it("applies a `num` instance's full level override", async () => {
    const levels = `<w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>`;
    const nums = `<w:num w:numId="1"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:lvl w:ilvl="0"><w:start w:val="5"/><w:numFmt w:val="upperLetter"/><w:lvlText w:val="Step %1:"/></w:lvl></w:lvlOverride></w:num>`;
    const text = await parse(
      await buildDocx({
        body: p("Go", { numId: "1", ilvl: 0 }),
        numbering: numbering(levels, nums),
      }),
    );
    expect(text).toContain("- Step E: Go");
  });

  it("renders an un-numbered paragraph when the list it names is missing or is numId 0", async () => {
    const levels = `<w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>`;
    const body = [
      p("Zero", { numId: "0" }),
      p("Unknown", { numId: "99" }),
      p("No level", { numId: "1", ilvl: 3 }),
    ].join("");
    const text = await parse(await buildDocx({ body, numbering: numbering(levels) }));
    expect(text).toBe("Zero\n\nUnknown\n\nNo level");
  });

  it("renders a numbered paragraph as plain text when the package has no numbering part", async () => {
    const text = await parse(await buildDocx({ body: p("Item", { numId: "1" }), numbering: null }));
    expect(text).toBe("Item");
  });

  it("nests a list that skips a level no deeper than one under its parent", async () => {
    const levels = `<w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl><w:lvl w:ilvl="2"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl>`;
    const body = [
      p("Top", { numId: "1", ilvl: 2 }),
      p("Next", { numId: "1", ilvl: 0 }),
      p("Deep", { numId: "1", ilvl: 2 }),
    ].join("");
    const text = await parse(await buildDocx({ body, numbering: numbering(levels) }));
    expect(text).toBe("- Top\n- Next\n    - Deep");
  });
});

describe("headings and inline content", () => {
  it("reads a heading from a localised style id by its name, a Title, and a direct outline level", async () => {
    const body = [
      p("Doc title", { style: "Title" }),
      p("Dutch heading", { style: "Kop3" }),
      `<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>Outlined</w:t></w:r></w:p>`,
      `<w:p><w:pPr><w:outlineLvl w:val="9"/></w:pPr><w:r><w:t>Body level</w:t></w:r></w:p>`,
    ].join("");
    const text = await parse(await buildDocx({ body }));
    expect(text).toBe("# Doc title\n\n### Dutch heading\n\n## Outlined\n\nBody level");
  });

  it("reads a heading level from a style's outline level and from `Heading N` ids with no styles part", async () => {
    const styles = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Custom"><w:name w:val="Req Head"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Loop"><w:name w:val="Loop"/><w:basedOn w:val="Loop"/></w:style></w:styles>`;
    const withStyles = await parse(
      await buildDocx({
        body: p("Custom", { style: "Custom" }) + p("Cycle", { style: "Loop" }),
        styles,
      }),
    );
    expect(withStyles).toBe("### Custom\n\nCycle");
    const noStyles = await parse(
      await buildDocx({ body: p("Bare", { style: "Heading2" }), styles: null }),
    );
    expect(noStyles).toBe("## Bare");
  });

  it("keeps external http(s) links and refuses any other scheme", async () => {
    const body = `<w:p><w:hyperlink r:id="rIdL1"><w:r><w:t>Spec</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:hyperlink r:id="rIdL2"><w:r><w:t>bad</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:hyperlink w:anchor="_Toc1"><w:r><w:t>internal</w:t></w:r></w:hyperlink></w:p>`;
    const rels = [
      `<Relationship Id="rIdL1" Type="${REL}/hyperlink" Target="https://example.com/spec" TargetMode="External"/>`,
      `<Relationship Id="rIdL2" Type="${REL}/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>`,
    ];
    const text = await parse(await buildDocx({ body, rels }));
    expect(text).toBe("[Spec](https://example.com/spec) and bad and internal");
  });

  it("encodes a link target that would close the Markdown link early (#2253 review)", async () => {
    const body = `<w:p><w:hyperlink r:id="rIdL1"><w:r><w:t>Spec</w:t></w:r></w:hyperlink></w:p>`;
    const rels = [
      `<Relationship Id="rIdL1" Type="${REL}/hyperlink" Target="https://a.example/x)[click](javascript:alert(1))" TargetMode="External"/>`,
    ];
    const text = await parse(await buildDocx({ body, rels }));
    expect(text).toBe("[Spec](https://a.example/x%29[click]%28javascript:alert%281%29%29)");
    expect(text).not.toContain("](javascript:");
  });

  it("merges adjacent runs of one format, keeps spaces outside markers, and reads italics", async () => {
    const body = `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">must </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>not</w:t></w:r><w:r><w:rPr><w:b w:val="0"/><w:i/></w:rPr><w:t xml:space="preserve"> ever</w:t></w:r></w:p>`;
    expect(await parse(await buildDocx({ body }))).toBe("**must not** *ever*");
  });

  it("reads tabs, breaks, hyphens, content controls, smart tags, fields and math", async () => {
    const body = [
      `<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t><w:br w:type="page"/><w:t>d</w:t><w:noBreakHyphen/><w:t>e</w:t></w:r></w:p>`,
      `<w:sdt><w:sdtContent>${p("In a control")}</w:sdtContent></w:sdt>`,
      `<w:p><w:sdt><w:sdtContent><w:r><w:t>inline control</w:t></w:r></w:sdtContent></w:sdt><w:smartTag><w:r><w:t xml:space="preserve"> tag</w:t></w:r></w:smartTag><w:fldSimple><w:r><w:t xml:space="preserve"> field</w:t></w:r></w:fldSimple><m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t> x+1</m:t></m:r></m:oMath></w:p>`,
      `<w:customXml>${p("In custom xml")}</w:customXml>`,
    ].join("");
    expect(await parse(await buildDocx({ body }))).toBe(
      "a b\nc d-e\n\nIn a control\n\ninline control tag field x+1\n\nIn custom xml",
    );
  });

  it("puts a line break inside a list item or heading on one line", async () => {
    const body = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Two</w:t><w:br/><w:t>lines</w:t></w:r></w:p>`;
    const text = await parse(await buildDocx({ body, numbering: null }));
    expect(text).toBe("# Two lines");
  });

  it("reads a text box once, though Word writes it as both a Choice and a Fallback", async () => {
    const box = (t: string) => `<w:txbxContent>${p(t)}</w:txbxContent>`;
    const body = `<w:p><w:r><w:t>Before</w:t></w:r><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps"><w:drawing>${box("Boxed note")}</w:drawing></mc:Choice><mc:Fallback><w:pict>${box("Boxed note")}</w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`;
    expect(await parse(await buildDocx({ body }))).toBe("Before\n\nBoxed note");
  });

  it("counts a tracked insertion and a deletion at block level, and truncates a long deletion visibly", async () => {
    const long = "x".repeat(250);
    const body = `<w:ins w:id="1">${p("Inserted paragraph")}</w:ins><w:del w:id="2"><w:p><w:r><w:delText>${long}</w:delText></w:r></w:p></w:del><w:moveFrom w:id="3"><w:p><w:r><w:t>moved away</w:t></w:r></w:p></w:moveFrom><w:moveTo w:id="4">${p("moved here")}</w:moveTo><w:p><w:del w:id="5"><w:r><w:delText>  </w:delText></w:r></w:del><w:r><w:t>kept</w:t></w:r></w:p>`;
    const text = await parse(await buildDocx({ body }));
    expect(text).toContain("Inserted paragraph\n\nmoved here\n\nkept");
    expect(text).toContain(
      "- Tracked changes: 2 insertions shown as accepted; 2 deletions not shown in the text.",
    );
    expect(text).toContain(`- Deleted text: "${"x".repeat(200)}…"`);
    expect(text).toContain('- Deleted text: "moved away"');
  });

  it("keeps a comment that no range anchors, and an endnote", async () => {
    const comments = `<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="7"><w:p><w:r><w:t>Floating</w:t></w:r></w:p></w:comment><w:comment w:id="8" w:author="A"><w:p/></w:comment></w:comments>`;
    const endnotes = `<?xml version="1.0"?><w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:endnote w:id="2"><w:p><w:r><w:t>End text</w:t></w:r></w:p></w:endnote></w:endnotes>`;
    const body = `<w:p><w:r><w:t>See</w:t></w:r><w:r><w:endnoteReference w:id="2"/></w:r><w:r><w:footnoteReference w:id="44"/></w:r><w:r><w:commentReference w:id="8"/></w:r></w:p>`;
    const buffer = await buildDocx({
      body,
      comments,
      rels: [`<Relationship Id="rIdEnd" Type="${REL}/endnotes" Target="endnotes.xml"/>`],
    });
    const zip = await JSZip.loadAsync(buffer);
    zip.file("word/endnotes.xml", endnotes);
    const text = await parse(Buffer.from(await zip.generateAsync({ type: "nodebuffer" })));
    expect(text).toContain("See[^e1][^2] [comment 1]");
    expect(text).toContain("[^e1]: End text\n[^2]: (empty)");
    expect(text).toContain("- [comment 1] A: (empty)\n- [comment (unanchored)] Floating");
    expect(text).toContain('- 2 reviewer comments are kept as notes under "Reviewer comments".');
  });
});

describe("package handling", () => {
  /** Rewrite the central-directory uncompressed size of `name`, as a zip bomb declares it. */
  function declareSize(zip: Buffer, name: string, size: number): Buffer {
    const out = Buffer.from(zip);
    for (let i = 0; i + 46 < out.length; i++) {
      if (out.readUInt32LE(i) !== 0x02014b50) continue;
      const nameLen = out.readUInt16LE(i + 28);
      if (out.toString("utf8", i + 46, i + 46 + nameLen) === name) out.writeUInt32LE(size, i + 24);
    }
    return out;
  }

  it("refuses a part whose declared inflated size is over the cap, before inflating it", async () => {
    const buffer = declareSize(
      await buildDocx({ body: p("hello") }),
      "word/document.xml",
      100 * 1024 * 1024,
    );
    const r = await parseDocument({ buffer, mimeType: DOCX_MIME, filename: "bomb.docx" });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.reason).toMatch(/^DOCX_PARSE_FAILED: part word\/document\.xml is larger than/);
  });

  it("finds the main part from the package relationships, wherever it is", async () => {
    const zip = new JSZip();
    zip.file(
      "_rels/.rels",
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="${REL}/officeDocument" Target="/doc/main.xml"/></Relationships>`,
    );
    zip.file(
      "doc/main.xml",
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p("Moved main part")}</w:body></w:document>`,
    );
    const { markdown } = await docxToMarkdown(
      Buffer.from(await zip.generateAsync({ type: "nodebuffer" })),
    );
    expect(markdown).toBe("Moved main part");
  });

  it("returns DOCX_EMPTY_TEXT for a body of empty paragraphs", async () => {
    const r = await parseDocument({
      buffer: await buildDocx({ body: "<w:p/><w:p/>" }),
      mimeType: DOCX_MIME,
      filename: "e.docx",
    });
    expect(r).toEqual({ ok: false, reason: "DOCX_EMPTY_TEXT" });
  });

  it("returns the notes alongside the Markdown for the caller's log", async () => {
    const { notes } = await docxToMarkdown(await buildBrdDocx());
    expect(notes).toEqual([
      '1 reviewer comment is kept as notes under "Reviewer comments".',
      "1 image: 0 described, 1 not read.",
      "Tracked changes: 1 insertion shown as accepted; 1 deletion not shown in the text.",
      'Deleted text: "30 minutes"',
    ]);
  });
});
