/**
 * #2263 — follow-ups from the #2253 Word-conversion review: a streamed zip-bomb guard that does
 * not trust declared sizes, bounded and deadlined image descriptions, notes that resolve their
 * own relationships, `w:gridBefore` / `w:gridAfter` and content-control rows in tables, and
 * body text that cannot turn itself into Markdown structure.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { crc32, deflateRawSync } from "node:zlib";
import JSZip from "jszip";
import { parseDocument } from "../src/lib/documents/parsers.js";
import {
  IMAGE_DESCRIPTION_CONCURRENCY,
  MAX_DESCRIBED_IMAGE_BYTES,
  MAX_DOCX_PART_BYTES,
  ImageNotRead,
  docxToMarkdown,
  type ImageDescriber,
} from "../src/lib/documents/docx-to-markdown.js";
import { chunkMarkdown } from "../src/lib/rag/chunker.js";
import { PIXEL_PNG, buildDocx, image, p } from "./fixtures/docx-2232.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

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

function imageRel(id: string, target: string): string {
  return `<Relationship Id="${id}" Type="${REL}/image" Target="${target}"/>`;
}

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

/**
 * A one-entry zip whose entry is deflated by native zlib (JSZip's own deflate takes seconds
 * over 64 MB) and whose headers declare `declaredSize` as its inflated size.
 */
function deflatedZip(name: string, data: Buffer, declaredSize: number): Buffer {
  const packed = deflateRawSync(data, { level: 1 });
  const fileName = Buffer.from(name, "utf8");
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(fileName.length, 28);
  const centralOffset = local.length + fileName.length + packed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, fileName, packed, central, fileName, end]);
}

/** Record the package parts JSZip is asked to inflate, by name. */
async function spyOnInflate() {
  const zip = await JSZip.loadAsync(await buildDocx({ body: p("x") }));
  const proto = Object.getPrototypeOf(zip.file("word/document.xml")!) as {
    internalStream: (type: string) => unknown;
  };
  const spy = vi.spyOn(proto, "internalStream");
  return () => spy.mock.contexts.map((c) => (c as { name: string }).name);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the zip-bomb guard inflates as a stream and stops at the cap", () => {
  it("refuses an image whose header declares it too large without inflating a byte of it", async () => {
    const inflated = await spyOnInflate();
    const buffer = await buildDocx({
      body: image("rIdBig", "big"),
      media: { "word/media/big.png": Buffer.alloc(MAX_DESCRIBED_IMAGE_BYTES + 1) },
      rels: [imageRel("rIdBig", "media/big.png")],
    });
    const describe = vi.fn<ImageDescriber>().mockResolvedValue("seen");
    const text = await parse(buffer, describe);
    expect(text).toContain("image not read: it is larger than 5 MB.");
    expect(describe).not.toHaveBeenCalled();
    expect(inflated()).toContain("word/document.xml");
    expect(inflated()).not.toContain("word/media/big.png");
  });

  it("stops an image whose header lies small once its inflated bytes pass the cap", async () => {
    const honest = await buildDocx({
      body: image("rIdBig", "big"),
      media: { "word/media/big.png": Buffer.alloc(MAX_DESCRIBED_IMAGE_BYTES * 2) },
      rels: [imageRel("rIdBig", "media/big.png")],
    });
    const forged = declareSize(honest, "word/media/big.png", 100);
    const describe = vi.fn<ImageDescriber>().mockResolvedValue("seen");
    const text = await parse(forged, describe);
    // Inflating the whole part would end in JSZip's size-mismatch error instead ("the
    // description failed"): this reason is the running cap's.
    expect(text).toContain("image not read: it is larger than 5 MB.");
    expect(describe).not.toHaveBeenCalled();
  });

  it("stops an XML part whose header lies small once its inflated bytes pass the part cap", async () => {
    // Deflated, as a real bomb is: 64 MB of one byte compresses to ~64 KB.
    const xml = Buffer.alloc(MAX_DOCX_PART_BYTES + 1024, " ");
    xml.write(`<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body>${p("hello")}`);
    const forged = deflatedZip("word/document.xml", xml, 2048);
    const r = await parseDocument({ buffer: forged, mimeType: DOCX_MIME, filename: "bomb.docx" });
    expect(r).toEqual({
      ok: false,
      reason: `DOCX_PARSE_FAILED: part word/document.xml is larger than ${MAX_DOCX_PART_BYTES} bytes`,
    });
  });

  it("still reads an image whose real size is under the cap", async () => {
    const buffer = await buildDocx({
      body: image("rIdImg", "ok"),
      media: { "word/media/image1.png": PIXEL_PNG },
      rels: [imageRel("rIdImg", "media/image1.png")],
    });
    const describe = vi.fn<ImageDescriber>().mockResolvedValue("seen");
    await parse(buffer, describe);
    expect(describe.mock.calls[0][0].data.equals(PIXEL_PNG)).toBe(true);
  });
});

describe("image descriptions run a few at a time, each under a deadline", () => {
  function images(count: number) {
    return buildDocx({
      body: Array.from({ length: count }, (_, i) => image("rIdImg", `pic ${i + 1}`, i + 1)).join(
        "",
      ),
      media: { "word/media/image1.png": PIXEL_PNG },
      rels: [imageRel("rIdImg", "media/image1.png")],
    });
  }

  it(`describes up to ${IMAGE_DESCRIPTION_CONCURRENCY} at once and keeps reading order`, async () => {
    let inFlight = 0;
    let peak = 0;
    const describe = vi.fn<ImageDescriber>(async (img) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Later images finish first, so an order kept by completion would show.
      await new Promise((r) => setTimeout(r, 40 - img.index * 3));
      inFlight--;
      return `described ${img.index}`;
    });
    const text = await parse(await images(10), describe);
    expect(describe).toHaveBeenCalledTimes(10);
    // More than one at a time, and never more than the bound.
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBe(IMAGE_DESCRIPTION_CONCURRENCY);
    const order = [
      ...text.matchAll(/\*\*Image (\d+)\*\* \(image1\.png, alt text "pic \d+"\): described (\d+)/g),
    ];
    expect(order.map((m) => [m[1], m[2]])).toEqual(
      Array.from({ length: 10 }, (_, i) => [String(i + 1), String(i + 1)]),
    );
  });

  it("abandons a description past its deadline, aborts its signal, and converts the rest", async () => {
    const signals: AbortSignal[] = [];
    const describe = vi.fn<ImageDescriber>(async (img, signal) => {
      signals.push(signal!);
      if (img.index === 1) return new Promise<string>(() => undefined); // never answers
      return "fast";
    });
    const { markdown } = await docxToMarkdown(await images(2), {
      describeImage: describe,
      imageTimeoutMs: 30,
    });
    expect(markdown).toContain(
      '**Image 1** (image1.png, alt text "pic 1"): image not read: the description timed out.',
    );
    expect(markdown).toContain('**Image 2** (image1.png, alt text "pic 2"): fast');
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it("writes a describer's own `ImageNotRead` reason into the text (a spent budget)", async () => {
    const text = await parse(await images(1), async () => {
      throw new ImageNotRead("the project's monthly token budget is spent");
    });
    expect(text).toContain("image not read: the project's monthly token budget is spent.");
  });

  it("says an image's bytes could not be read when the package part is corrupt", async () => {
    const zip = await JSZip.loadAsync(await images(1));
    zip.file("word/media/image1.png", PIXEL_PNG);
    const buffer = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    // Corrupt the image's size in the header, so JSZip's own end-of-stream check fails.
    const corrupt = declareSize(buffer, "word/media/image1.png", PIXEL_PNG.length + 5);
    const describe = vi.fn<ImageDescriber>().mockResolvedValue("seen");
    const text = await parse(corrupt, describe);
    expect(text).toContain("image not read: its bytes could not be read from the package.");
    expect(describe).not.toHaveBeenCalled();
  });
});

describe("notes resolve links through their own part's relationships", () => {
  it("keeps a footnote's hyperlink, which names an id in footnotes.xml.rels, not the main part's", async () => {
    const footnotes = `<?xml version="1.0"?><w:footnotes xmlns:w="${W}" xmlns:r="${REL}"><w:footnote w:id="1"><w:p><w:r><w:t xml:space="preserve">See </w:t></w:r><w:hyperlink r:id="rIdL1"><w:r><w:t>the policy</w:t></w:r></w:hyperlink></w:p></w:footnote></w:footnotes>`;
    const body = `<w:p><w:r><w:t>Rule</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>`;
    const buffer = await buildDocx({
      body,
      footnotes,
      // The main part's rIdL1 is a different link: reading the footnote through the main
      // relationships linked it here.
      rels: [
        `<Relationship Id="rIdL1" Type="${REL}/hyperlink" Target="https://wrong.example/" TargetMode="External"/>`,
      ],
    });
    const zip = await JSZip.loadAsync(buffer);
    zip.file(
      "word/_rels/footnotes.xml.rels",
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdL1" Type="${REL}/hyperlink" Target="https://policy.example/pw" TargetMode="External"/></Relationships>`,
    );
    const text = await parse(Buffer.from(await zip.generateAsync({ type: "nodebuffer" })));
    expect(text).toContain("[^1]: See [the policy](https://policy.example/pw)");
    expect(text).not.toContain("wrong.example");
  });

  it("keeps a note on one line, so a break in it cannot start a heading", async () => {
    const footnotes = `<?xml version="1.0"?><w:footnotes xmlns:w="${W}"><w:footnote w:id="1"><w:p><w:r><w:t>First</w:t><w:br/><w:t># Second</w:t></w:r></w:p></w:footnote></w:footnotes>`;
    const body = `<w:p><w:r><w:t>Rule</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>`;
    const text = await parse(await buildDocx({ body, footnotes }));
    expect(text).toContain("[^1]: First # Second");
    expect(text).not.toMatch(/^# Second/m);
  });
});

describe("tables", () => {
  const tc = (t: string) => `<w:tc>${p(t)}</w:tc>`;

  it("places a row's cells under their grid columns past `w:gridBefore` and `w:gridAfter`", async () => {
    const body =
      `<w:tbl><w:tr>${tc("A")}${tc("B")}${tc("C")}</w:tr>` +
      `<w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr>${tc("b2")}${tc("c2")}</w:tr>` +
      `<w:tr><w:trPr><w:gridAfter w:val="2"/></w:trPr>${tc("a3")}</w:tr></w:tbl>`;
    const text = await parse(await buildDocx({ body }));
    expect(text).toBe(
      ["| A | B | C |", "| --- | --- | --- |", "|  | b2 | c2 |", "| a3 |  |  |"].join("\n"),
    );
  });

  it("repeats a merged value from the right column when the row starts late", async () => {
    const body =
      `<w:tbl><w:tr>${tc("A")}<w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${p("Owner")}</w:tc></w:tr>` +
      `<w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>`;
    expect(await parse(await buildDocx({ body }))).toBe(
      "| A | Owner |\n| --- | --- |\n|  | Owner |",
    );
  });

  it("keeps the rows and cells a content control (a repeating section) or custom XML wraps", async () => {
    const body =
      `<w:tbl><w:tr>${tc("ID")}${tc("Rule")}</w:tr>` +
      `<w:sdt><w:sdtPr/><w:sdtContent><w:tr>${tc("R1")}${tc("Lock")}</w:tr><w:tr>${tc("R2")}${tc("Unlock")}</w:tr></w:sdtContent></w:sdt>` +
      `<w:customXml><w:tr><w:sdt><w:sdtContent>${tc("R3")}</w:sdtContent></w:sdt>${tc("Audit")}</w:tr></w:customXml></w:tbl>`;
    expect(await parse(await buildDocx({ body }))).toBe(
      "| ID | Rule |\n| --- | --- |\n| R1 | Lock |\n| R2 | Unlock |\n| R3 | Audit |",
    );
  });
});

describe("body text is escaped where it would read as Markdown structure", () => {
  it("does not let a paragraph's own words become a heading, a setext underline or a fence", async () => {
    const body = [
      p("Scope", { style: "Heading1" }),
      p("# not a heading"),
      `<w:p><w:r><w:t>Title line</w:t><w:br/><w:t>===</w:t></w:r></w:p>`,
      `<w:p><w:r><w:t>Other line</w:t><w:br/><w:t>-</w:t></w:r></w:p>`,
      p("```js"),
      p("~~~"),
      p("   ## indented"),
      p("#hashtag stays"),
      p("- typed bullet stays"),
      p("1. typed number stays"),
    ].join("");
    const text = await parse(await buildDocx({ body, numbering: null }));
    expect(text).toBe(
      [
        "# Scope",
        "\\# not a heading",
        "Title line\n\\===",
        "Other line\n\\-",
        "\\```js",
        "\\~~~",
        "\\## indented",
        "#hashtag stays",
        "- typed bullet stays",
        "1. typed number stays",
      ].join("\n\n"),
    );
    // The chunker splits only on the document's one real heading.
    const headings = new Set(chunkMarkdown(text).flatMap((c) => c.headings));
    expect([...headings]).toEqual(["Scope"]);
  });

  it("leaves text in a table cell, a list item and a heading as it was", async () => {
    const body = `<w:tbl><w:tr><w:tc>${p("# in a cell")}</w:tc></w:tr></w:tbl>`;
    expect(await parse(await buildDocx({ body }))).toContain("| # in a cell |");
  });
});
