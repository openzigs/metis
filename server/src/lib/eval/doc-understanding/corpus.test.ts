import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDocument } from "../../documents/parsers.js";
import { parseFrdSource } from "./corpus-source.js";
import {
  DOCX_MIME,
  DOC_UNDERSTANDING_CORPORA,
  LABEL_STATUS,
  corpusRoot,
  labelProblems,
  loadDocUnderstandingCorpus,
  loadDocUnderstandingItem,
  sha256,
  type DocUnderstandingItem,
} from "./corpus.js";
import { renderFrdDocx } from "./docx-render.js";

describe("the committed document-understanding corpus", () => {
  let items: DocUnderstandingItem[];
  beforeAll(async () => {
    items = await loadDocUnderstandingCorpus();
  });

  it("loads every item: each label's span is in the converted Word text and each section is a heading", () => {
    expect(items.map((i) => i.name)).toEqual([...DOC_UNDERSTANDING_CORPORA]);
    for (const item of items) expect(labelProblems(item.text, item.labels)).toEqual([]);
  });

  it("holds documents larger than ten retrieved chunks, each with requirements and ambiguities", () => {
    for (const item of items) {
      // 20,000 characters is ten full 2,048-character chunks, the most today's
      // ten-chunk read could cover; chunkMarkdown cuts at every heading, so it
      // covered 8,170 to 9,611 on #2229's three documents. Every document exceeds it.
      expect(item.text.length).toBeGreaterThan(20_000);
      expect(item.labels.requirements.length).toBeGreaterThanOrEqual(30);
      expect(item.labels.ambiguities.length).toBeGreaterThanOrEqual(8);
    }
  });

  it.each(DOC_UNDERSTANDING_CORPORA)("%s: labels.json is what frd.src.md builds", async (name) => {
    const dir = path.join(corpusRoot(), name);
    const source = await readFile(path.join(dir, "frd.src.md"), "utf8");
    const held = JSON.parse(await readFile(path.join(dir, "labels.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const parsed = parseFrdSource(source);
    expect(held).toEqual({
      corpusId: name,
      title: parsed.title,
      license: "CC0-1.0",
      labelStatus: LABEL_STATUS,
      sourceSha256: sha256(source),
      ...parsed.labels,
    });
  });
});

describe("labelProblems", () => {
  const text = "# T\n\n## 1. Scope\n\nThe system shall send a reminder each day.\n";
  it("reports a span the text does not hold and a section that is not a heading", () => {
    expect(
      labelProblems(text, {
        sections: [],
        requirements: [
          { id: "R1", section: "1. Scope", span: "The system shall send a reminder each day." },
          { id: "R2", section: "2. Missing", span: "The system shall never send a reminder." },
        ],
        ambiguities: [
          {
            id: "A1",
            kind: "missing",
            description: "d",
            question: "q",
            requirements: [],
            spans: ["words that are not there"],
            sections: ["Nowhere"],
          },
        ],
      }),
    ).toEqual([
      "R2: span not found in the converted text",
      'R2: section "2. Missing" is not a heading',
      "A1: span 1 not found in the converted text",
      'A1: section "Nowhere" is not a heading',
    ]);
  });
});

describe("loading an item", () => {
  let root: string;
  const SOURCE = `# Small FRD

## 1. Rules

[[R1 The portal shall lock an account after five failed attempts.]]

1. Numbered step one.

<!-- labels
A1 [tbd] @R1: unlock is unstated => When does a locked account unlock?
-->
`;
  const labelsFor = (name: string, over: Record<string, unknown> = {}) => {
    const parsed = parseFrdSource(SOURCE);
    return JSON.stringify({
      corpusId: name,
      title: parsed.title,
      license: "CC0-1.0",
      labelStatus: LABEL_STATUS,
      sourceSha256: sha256(SOURCE),
      ...parsed.labels,
      ...over,
    });
  };
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "doc-understanding-"));
    const parsed = parseFrdSource(SOURCE);
    const docx = await renderFrdDocx(parsed.title, parsed.blocks);
    for (const [name, labels] of [
      ["good", labelsFor("good")],
      ["wrong-id", labelsFor("someone-else")],
      [
        "bad-span",
        labelsFor("bad-span", {
          requirements: [
            { id: "R1", section: "1. Rules", span: "A span the document lacks entirely." },
          ],
        }),
      ],
    ] as const) {
      await mkdir(path.join(root, name));
      await writeFile(path.join(root, name, "source.docx"), docx);
      await writeFile(path.join(root, name, "labels.json"), labels);
    }
    await mkdir(path.join(root, "not-word"));
    await writeFile(path.join(root, "not-word", "source.docx"), "plain text, not a Word file");
    await writeFile(path.join(root, "not-word", "labels.json"), labelsFor("not-word"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads the Word document through production's conversion", async () => {
    const item = await loadDocUnderstandingItem("good", root);
    expect(item.title).toBe("Small FRD");
    expect(item.text).toContain("## 1. Rules");
    expect(item.text).toContain("The portal shall lock an account after five failed attempts.");
    expect(item.sections.map((s) => s.heading)).toEqual(["Small FRD", "1. Rules"]);
    expect(item.docxBytes).toBeGreaterThan(0);
  });

  it("refuses labels for another corpus", async () => {
    await expect(loadDocUnderstandingItem("wrong-id", root)).rejects.toThrow(/names corpus/);
  });

  it("refuses labels whose span the document lacks", async () => {
    await expect(loadDocUnderstandingItem("bad-span", root)).rejects.toThrow(/R1: span not found/);
  });

  it("refuses a source.docx that does not convert", async () => {
    await expect(loadDocUnderstandingItem("not-word", root)).rejects.toThrow(/did not convert/);
  });

  it("refuses an unregistered corpus name", async () => {
    await expect(loadDocUnderstandingCorpus(["good"], root)).rejects.toThrow(/unknown corpus/);
  });
});

describe("renderFrdDocx", () => {
  it("writes a Word document whose headings, list items and table survive conversion", async () => {
    const parsed = parseFrdSource(
      "# Title\n\n## Part\n\n- A bullet item.\n1. A numbered item.\n\n| H1 | H2 |\n|---|---|\n| a cell | another cell |\n",
    );
    const res = await parseDocument({
      buffer: await renderFrdDocx(parsed.title, parsed.blocks),
      mimeType: DOCX_MIME,
      filename: "x.docx",
    });
    expect(res.ok).toBe(true);
    const text = res.ok ? res.text : "";
    expect(text).toContain("# Title");
    expect(text).toContain("## Part");
    expect(text).toContain("A bullet item.");
    expect(text).toContain("A numbered item.");
    expect(text).toContain("| a cell | another cell |");
  });
});
