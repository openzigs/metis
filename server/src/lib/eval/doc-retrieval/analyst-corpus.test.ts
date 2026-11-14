/**
 * #2527 — the analyst corpus (`docretrieval-03-analyst-docs`) and the sourced-document
 * loader it introduced. The METIS-docs corpora's tests live in `corpus.test.ts`.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../../rag/chunker.js";
import { alignChunksToSource, bestCoveringChunk } from "./chunk-alignment.js";
import { CHUNK_SIZE_ARMS, extraSizeArm } from "./chunk-sweep.js";
import {
  ANALYST_DOC_CORPUS_ID,
  buildCorpusIdf,
  DOC_SNAPSHOT_DIR,
  DOC_SOURCES_FILE,
  docCorpusDir,
  idfWeightedQuestionCoverage,
  loadDocRetrievalCorpus,
  loadSourcedDocs,
  longestSharedWordRun,
  readSourceText,
  type DocRetrievalSourcesSpec,
} from "./corpus.js";
import { PRACTICAL_QUERY_CEILING } from "./power-sizing.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A throwaway stand-in for `eval-data/corpus/`, holding the given files. */
async function tmpRoot(files: Record<string, string>): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sourced-corpus-")));
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text, "utf8");
  }
  return root;
}

/**
 * The loader path: a corpus that reads its documents from committed sources, pinned by
 * sha256, instead of a `docs/` snapshot. Exercised on throwaway files so every refusal is
 * reachable without breaking the committed corpus.
 */
describe("sourced corpus documents", () => {
  it("reads each source verbatim, checks its pin, and returns the documents sorted by id", async () => {
    const root = await tmpRoot({ "b/source.md": "# B\n\nbee\n", "a/source.md": "# A\n\nay\n" });
    const spec: DocRetrievalSourcesSpec = {
      corpusId: "t",
      documents: [
        { id: "b.md", source: "b/source.md", sha256: sha("# B\n\nbee\n") },
        { id: "a.md", source: "a/source.md", sha256: sha("# A\n\nay\n") },
      ],
    };
    expect(await loadSourcedDocs(spec, root)).toEqual([
      { id: "a.md", text: "# A\n\nay\n" },
      { id: "b.md", text: "# B\n\nbee\n" },
    ]);
  });

  it("refuses a source whose text no longer matches its pinned hash, naming the source", async () => {
    const root = await tmpRoot({ "a/source.md": "edited after measurement\n" });
    const spec: DocRetrievalSourcesSpec = {
      corpusId: "t",
      documents: [{ id: "a.md", source: "a/source.md", sha256: sha("original\n") }],
    };
    await expect(loadSourcedDocs(spec, root)).rejects.toThrow(
      /a\/source\.md now reads as text hashing .*no longer the corpus/s,
    );
  });

  it("refuses a document id that would not be ingested as markdown", async () => {
    const root = await tmpRoot({ "a/source.md": "x\n" });
    const spec: DocRetrievalSourcesSpec = {
      corpusId: "t",
      documents: [{ id: "a.docx", source: "a/source.md", sha256: sha("x\n") }],
    };
    await expect(loadSourcedDocs(spec, root)).rejects.toThrow(/must end in \.md/);
  });

  it("refuses a source outside eval-data/corpus and a source of any other type", async () => {
    const root = await tmpRoot({ "a/notes.txt": "x\n" });
    await expect(readSourceText(root, "../escape.md")).rejects.toThrow(/outside eval-data/);
    await expect(readSourceText(root, "a/notes.txt")).rejects.toThrow(/neither \.md nor \.docx/);
  });

  it("reads a .docx through the production Word conversion, not the authoring markup", async () => {
    const root = path.dirname(docCorpusDir(ANALYST_DOC_CORPUS_ID));
    const text = await readSourceText(root, "docunderstanding-01-clinic-booking/source.docx");
    expect(text.startsWith("# Riverside Community Clinics")).toBe(true);
    // `frd.src.md` carries `[[R…]]` label markers and an HTML label comment; neither is in
    // the document an analyst would upload, so neither may reach the index.
    expect(text).not.toContain("[[");
    expect(text).not.toContain("<!-- labels");
  });

  it("refuses a .docx that does not convert", async () => {
    const root = await tmpRoot({ "a/source.docx": "not a zip archive" });
    await expect(readSourceText(root, "a/source.docx")).rejects.toThrow(/did not convert/);
  });
});

/**
 * The analyst corpus, held to its `PREREGISTRATION.md`. The count, the strata balance and
 * the copy-discipline bounds are the pre-registered ones, asserted beside the exact values
 * the committed corpus measures, so a new batch has to justify any change here.
 */
describe("the analyst corpus", () => {
  const ARMS = [...CHUNK_SIZE_ARMS, extraSizeArm(4096)];

  it("loads its fourteen documents from sources.json, with no docs/ snapshot", async () => {
    const dir = docCorpusDir(ANALYST_DOC_CORPUS_ID);
    const sources = JSON.parse(
      await fs.readFile(path.join(dir, DOC_SOURCES_FILE), "utf8"),
    ) as DocRetrievalSourcesSpec;
    const corpus = await loadDocRetrievalCorpus(ANALYST_DOC_CORPUS_ID);
    expect(corpus.id).toBe(ANALYST_DOC_CORPUS_ID);
    expect(sources.corpusId).toBe(ANALYST_DOC_CORPUS_ID);
    expect(corpus.docs.map((d) => d.id)).toEqual(sources.documents.map((d) => d.id).sort());
    expect(corpus.docs).toHaveLength(14);
    await expect(fs.access(path.join(dir, DOC_SNAPSHOT_DIR))).rejects.toThrow();
    // The four FRDs come from the Word documents, the rest verbatim from markdown.
    expect(sources.documents.filter((d) => d.source.endsWith(".docx"))).toHaveLength(4);
    expect(corpus.snapshotCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("holds the pre-registered query count: at least 200, at most the 250 ceiling", async () => {
    const corpus = await loadDocRetrievalCorpus(ANALYST_DOC_CORPUS_ID);
    expect(corpus.queries.length).toBeGreaterThanOrEqual(200);
    expect(corpus.queries.length).toBeLessThanOrEqual(PRACTICAL_QUERY_CEILING);
    expect(corpus.queries.length).toBe(226);
  });

  it("repeats no question and no span, and puts queries on every document", async () => {
    const corpus = await loadDocRetrievalCorpus(ANALYST_DOC_CORPUS_ID);
    const n = corpus.queries.length;
    expect(new Set(corpus.queries.map((q) => q.question)).size).toBe(n);
    expect(new Set(corpus.queries.map((q) => `${q.doc} ${q.quote}`)).size).toBe(n);
    expect(new Set(corpus.queries.map((q) => q.doc)).size).toBe(corpus.docs.length);
  });

  it("carries both strata at about half each, as pre-registered", async () => {
    const corpus = await loadDocRetrievalCorpus(ANALYST_DOC_CORPUS_ID);
    const lexical = corpus.queries.filter((q) => q.phrasing === "lexical").length;
    expect(lexical).toBe(109);
    expect(lexical / corpus.queries.length).toBeGreaterThan(0.4);
    expect(lexical / corpus.queries.length).toBeLessThan(0.6);
  });

  it("contains no query that restates its span: run at most 8, at most 10% at 5 or more", async () => {
    const corpus = await loadDocRetrievalCorpus(ANALYST_DOC_CORPUS_ID);
    const runs = corpus.queries.map((q) => longestSharedWordRun(q.question, q.quote));
    expect(Math.max(...runs)).toBeLessThanOrEqual(8);
    expect(runs.filter((r) => r >= 5).length).toBeLessThanOrEqual(corpus.queries.length / 10);
    // Exact today: the longest run is four words and none reaches five.
    expect(Math.max(...runs)).toBe(4);
    expect(runs.filter((r) => r >= 5)).toEqual([]);
  });

  it("keeps rare-term donation in the lexical stratum, and reports the 0.60 tail", async () => {
    const corpus = await loadDocRetrievalCorpus(ANALYST_DOC_CORPUS_ID);
    const idf = buildCorpusIdf(corpus.docs);
    const rows = corpus.queries.map((q) => ({
      id: q.id,
      phrasing: q.phrasing,
      coverage: idfWeightedQuestionCoverage(q.question, q.quote, idf),
    }));
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const lexical = mean(rows.filter((r) => r.phrasing === "lexical").map((r) => r.coverage));
    const paraphrase = mean(rows.filter((r) => r.phrasing === "paraphrase").map((r) => r.coverage));
    expect(lexical).toBeGreaterThan(paraphrase);
    expect(lexical).toBeCloseTo(0.451, 3);
    expect(paraphrase).toBeCloseTo(0.184, 3);
    const donors = rows.filter((r) => r.coverage >= 0.6);
    expect(donors.map((r) => r.id).sort()).toEqual(["aq-fc-23", "aq-gv2-15"]);
    expect(donors.every((r) => r.phrasing === "lexical")).toBe(true);
  });

  it("cuts each short BRD and PRD into the same three heading chunks at every arm", async () => {
    const corpus = await loadDocRetrievalCorpus(ANALYST_DOC_CORPUS_ID);
    const short = corpus.docs.filter((d) => /^(brd|prd)-/.test(d.id));
    expect(short).toHaveLength(8);
    for (const doc of short) {
      for (const arm of ARMS) {
        const chunks = chunkMarkdown(doc.text, { chunkSize: arm.chunkSize, overlap: arm.overlap });
        expect(chunks.length, `${doc.id} at ${arm.id}`).toBe(3);
      }
    }
  });

  it("uses LF line endings, which the offset alignment assumes", async () => {
    const corpus = await loadDocRetrievalCorpus(ANALYST_DOC_CORPUS_ID);
    for (const doc of corpus.docs) expect(doc.text).not.toContain("\r");
  });

  it("drops and straddles no answer span at any arm, 4096 included", async () => {
    const corpus = await loadDocRetrievalCorpus(ANALYST_DOC_CORPUS_ID);
    const byDoc = new Map(corpus.docs.map((d) => [d.id, d.text]));
    for (const arm of ARMS) {
      const notWhole: string[] = [];
      for (const q of corpus.queries) {
        const text = byDoc.get(q.doc) ?? "";
        const aligned = alignChunksToSource(
          text,
          chunkMarkdown(text, { chunkSize: arm.chunkSize, overlap: arm.overlap }),
        );
        const best = bestCoveringChunk(aligned, q.spanStart, q.spanEnd);
        if (best === null || best.overlap < q.spanEnd - q.spanStart) notWhole.push(q.id);
      }
      expect(notWhole, `${arm.id} did not hold every span whole`).toEqual([]);
    }
  });

  /**
   * Analyst documents are short-sectioned: `chunkMarkdown` splits on headings first, so
   * almost every section already fits in 2048 characters and the larger arms barely differ
   * from the control (240 chunks at 3072 and 4096 against 242 at 2048). The small arms
   * leave a few long FRD paragraphs out whole, the same long-line class as the METIS-docs
   * corpora; that text is still indexed, split across two chunks.
   */
  it("leaves only a few long lines out of every chunk, and none at 2048 and above", async () => {
    const corpus = await loadDocRetrievalCorpus(ANALYST_DOC_CORPUS_ID);
    const ceilings: Record<string, number> = {
      "size-768": 7,
      "size-1024": 2,
      "size-2048": 0,
      "size-3072": 0,
      "size-4096": 0,
    };
    const chunkCounts: Record<string, number> = {};
    for (const arm of ARMS) {
      let dropped = 0;
      let chunks = 0;
      for (const doc of corpus.docs) {
        const docChunks = chunkMarkdown(doc.text, {
          chunkSize: arm.chunkSize,
          overlap: arm.overlap,
        });
        chunks += docChunks.length;
        const haystack = docChunks.map((c) => c.text).join("\n\n");
        for (const raw of doc.text.split("\n")) {
          const trimmed = raw.trim();
          const heading = /^#{1,6}\s+(.*?)\s*$/.exec(trimmed);
          const line = heading ? heading[1] : trimmed;
          if (line.length > 12 && !haystack.includes(line)) dropped += 1;
        }
      }
      chunkCounts[arm.id] = chunks;
      expect(dropped, `${arm.id} substantive lines absent from every chunk`).toBe(ceilings[arm.id]);
    }
    expect(chunkCounts).toEqual({
      "size-2048": 242,
      "size-1024": 304,
      "size-768": 365,
      "size-3072": 240,
      "size-4096": 240,
    });
  });
});
