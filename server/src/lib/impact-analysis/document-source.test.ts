/**
 * #2231 — what an impact run reads from a document source: the parsed file,
 * or its chunks with the overlap kept once; and the changes and summary
 * sentence a document reading becomes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chunkMarkdown } from "../rag/chunker.js";
import type { DocumentReading, ReadStatement, SectionCoverage } from "../document-reader/reader.js";
import {
  MIN_CHUNK_OVERLAP_CHARS,
  READER_MIN_PASTED_CHARS,
  changesFromReading,
  documentReadingNotice,
  joinChunksWithoutOverlap,
  loadImpactDocumentText,
  overlapLength,
  readerFailedNotice,
  shouldReadWithModel,
} from "./document-source.js";

const here = dirname(fileURLToPath(import.meta.url));

// #2276 — a fallback to the chunks says why, in the log.
const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ debug: vi.fn(), error: vi.fn(), ...logged }),
}));
const fellBackBecause = (reason: string) =>
  expect(logged.info).toHaveBeenCalledWith(
    "impact run reads the document's chunks instead of its file",
    { documentId: expect.any(String), reason },
  );

/** An FRD of a dozen paragraphs, each sentence unique so a repeat is visible. */
const FRD = [
  "# Clinic booking FRD",
  "",
  "## 1 Purpose",
  "",
  ...Array.from(
    { length: 6 },
    (_, i) =>
      `Paragraph P${i} explains purpose ${i}: the portal lets a patient book, move and cancel appointment kind ${i} without calling the clinic, and staff see every change at once.\n`,
  ),
  "## 2 Requirements",
  "",
  ...Array.from(
    { length: 6 },
    (_, i) =>
      `Requirement R${i}: the portal shall enforce rule number ${i} for every booking a patient makes, and shall record who applied it and when it was applied.\n`,
  ),
].join("\n");

const paragraphs = FRD.split("\n").filter((l) => /^(Paragraph|Requirement) /.test(l));

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("overlapLength", () => {
  it("is the longest suffix of the first that starts the second", () => {
    expect(overlapLength("the quick brown fox", "brown fox jumps")).toBe("brown fox".length);
    expect(overlapLength("abcabc", "abcabcx")).toBe(6);
    expect(overlapLength("abc", "xyz")).toBe(0);
    expect(overlapLength("", "abc")).toBe(0);
    expect(overlapLength("abc", "")).toBe(0);
    // A NUL in the text cannot fake a match through the search's own sentinel.
    expect(overlapLength("a\u0000b", "b\u0000a")).toBe(1);
    expect(overlapLength("x\u0000", "\u0000x")).toBe(1);
  });

  it("agrees with the brute-force answer on every pair of short two-letter strings", () => {
    const words: string[] = [""];
    for (let len = 1; len <= 6; len++) {
      for (let n = 0; n < 2 ** len; n++) {
        words.push(n.toString(2).padStart(len, "0").replace(/0/g, "a").replace(/1/g, "b"));
      }
    }
    const brute = (p: string, q: string) => {
      for (let k = Math.min(p.length, q.length); k > 0; k--) {
        if (p.endsWith(q.slice(0, k))) return k;
      }
      return 0;
    };
    for (const p of words) for (const q of words) expect(overlapLength(p, q)).toBe(brute(p, q));
  });
});

describe("joinChunksWithoutOverlap", () => {
  it("reads every paragraph of a chunked document exactly once", () => {
    const chunks = chunkMarkdown(FRD, { chunkSize: 200, overlap: 48 }).map((c) => c.text);
    // The chunker does overlap: the plain join reads some paragraphs twice.
    const naive = chunks.join("\n\n");
    expect(paragraphs.some((p) => occurrences(naive, p) !== 1)).toBe(true);

    const joined = joinChunksWithoutOverlap(chunks);
    for (const p of paragraphs) expect(occurrences(joined, p)).toBe(1);
    expect(occurrences(joined, "## 2 Requirements")).toBe(1);
  });

  it("joins an overlapping chunk without inventing a paragraph break", () => {
    expect(joinChunksWithoutOverlap(["one two three four", "three four five six"])).toBe(
      "one two three four five six",
    );
  });

  it("starts a new paragraph where chunks do not overlap, and skips empty ones", () => {
    expect(joinChunksWithoutOverlap(["# A\n\nalpha.", "", "# B\n\nbeta."])).toBe(
      "# A\n\nalpha.\n\n# B\n\nbeta.",
    );
    expect(joinChunksWithoutOverlap([])).toBe("");
  });

  it("keeps a match shorter than the minimum: chance, not overlap", () => {
    const short = "x".repeat(MIN_CHUNK_OVERLAP_CHARS - 1);
    expect(joinChunksWithoutOverlap([`end ${short}`, `${short} start`])).toBe(
      `end ${short}\n\n${short} start`,
    );
    const long = "y".repeat(MIN_CHUNK_OVERLAP_CHARS);
    expect(joinChunksWithoutOverlap([`end ${long}`, `${long} start`])).toBe(`end ${long} start`);
  });
});

function prismaWith(opts: {
  doc?: Record<string, unknown> | null;
  approved?: string[];
  quarantined?: string[];
}) {
  return {
    document: {
      findUnique: vi.fn(async () =>
        opts.doc === undefined
          ? {
              projectId: "proj-docs",
              checksum: "sum-frd",
              filename: "frd.md",
              title: "Clinic booking FRD",
              mimeType: "text/markdown",
              storagePath: "p/frd.md",
            }
          : opts.doc,
      ),
    },
    knowledgeChunk: {
      findMany: vi.fn(async () => (opts.approved ?? []).map((text) => ({ text }))),
    },
    quarantineChunk: {
      findMany: vi.fn(async () => (opts.quarantined ?? []).map((text) => ({ text }))),
    },
  };
}

describe("loadImpactDocumentText", () => {
  beforeEach(() => {
    logged.info.mockClear();
    logged.warn.mockClear();
  });

  it("reads the stored file, parsed, and never touches the chunks", async () => {
    const prisma = prismaWith({ approved: ["chunk one", "chunk two"] });
    const read = vi.fn(async () => Buffer.from(FRD, "utf8"));
    const doc = await loadImpactDocumentText(prisma as never, "doc-1", { read });
    expect(read).toHaveBeenCalledWith("p/frd.md");
    expect(doc).toMatchObject({ from: "file", title: "Clinic booking FRD" });
    // #2280 — the key its reading is saved under: the document's OWN project.
    expect(doc.saved).toEqual({ projectId: "proj-docs", documentId: "doc-1", checksum: "sum-frd" });
    for (const p of paragraphs) expect(occurrences(doc.text, p)).toBe(1);
    expect(prisma.knowledgeChunk.findMany).not.toHaveBeenCalled();
    expect(prisma.document.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "doc-1" } }),
    );
  });

  // #2273 panel: a re-parse has no image describer, so a Word document's images
  // come back "not read" although ingest described them into the chunks.
  it("reads the described chunks when the re-parse lost the images ingest described", async () => {
    const reparsed = `${FRD}\n\n> Image 1 (wireframe.png): image not read: no vision-capable model is configured.`;
    const prisma = prismaWith({
      approved: ["Booking screen. Image 1 (wireframe.png): a calendar with a Book button"],
    });
    const read = vi.fn(async () => Buffer.from(reparsed, "utf8"));
    const doc = await loadImpactDocumentText(prisma as never, "doc-1", { read });
    expect(doc.from).toBe("chunks");
    expect(doc.saved?.checksum).toBe("sum-frd");
    expect(doc.text).toContain("a calendar with a Book button");
    expect(doc.text).not.toContain("image not read");
    fellBackBecause("images-not-described");
  });

  it("keeps the re-parsed file when it lost images but there are no chunks to read", async () => {
    const reparsed = `${FRD}\n\nImage 1: image not read: no vision-capable model is configured.`;
    const prisma = prismaWith({ approved: [], quarantined: [] });
    const read = vi.fn(async () => Buffer.from(reparsed, "utf8"));
    const doc = await loadImpactDocumentText(prisma as never, "doc-1", { read });
    expect(doc.from).toBe("file");
    for (const p of paragraphs) expect(occurrences(doc.text, p)).toBe(1);
  });

  it("falls back to the approved chunks, de-overlapped, when the file cannot be read", async () => {
    const prisma = prismaWith({ approved: ["one two three four", "three four five six"] });
    const read = vi.fn(async () => {
      throw new Error("ENOENT");
    });
    const doc = await loadImpactDocumentText(prisma as never, "doc-1", { read });
    expect(doc).toEqual({
      text: "one two three four five six",
      from: "chunks",
      title: "Clinic booking FRD",
      saved: { projectId: "proj-docs", documentId: "doc-1", checksum: "sum-frd" },
    });
    expect(prisma.quarantineChunk.findMany).not.toHaveBeenCalled();
    fellBackBecause("file-unreadable");
    expect(logged.warn).toHaveBeenCalledWith("impact run could not read the document's file", {
      documentId: "doc-1",
      error: "ENOENT",
    });
  });

  it("falls back to the quarantined chunks when none are approved", async () => {
    const prisma = prismaWith({ quarantined: ["The hub credit limit shall be configurable."] });
    const read = vi.fn(async () => Buffer.from("", "utf8"));
    const doc = await loadImpactDocumentText(prisma as never, "doc-1", { read });
    expect(doc.text).toBe("The hub credit limit shall be configurable.");
    expect(doc.from).toBe("chunks");
    expect(prisma.quarantineChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { documentId: "doc-1", ord: { gte: 0 } } }),
    );
    fellBackBecause("parsed-empty");
  });

  it("reads the chunks of a document whose row is gone, titled by its id", async () => {
    const prisma = prismaWith({ doc: null, approved: ["only chunk"] });
    const read = vi.fn();
    const doc = await loadImpactDocumentText(prisma as never, "doc-9", { read });
    expect(read).not.toHaveBeenCalled();
    expect(doc).toEqual({ text: "only chunk", from: "chunks", title: "doc-9" });
    fellBackBecause("no-document-row");
  });

  it("names the document by its filename when it has no title, and refuses an unparseable file", async () => {
    const prisma = prismaWith({
      doc: {
        projectId: "p",
        checksum: "c",
        filename: "x.bin",
        title: null,
        mimeType: "application/x-unknown",
        storagePath: "x",
      },
      approved: ["from chunks"],
    });
    const doc = await loadImpactDocumentText(prisma as never, "doc-1", {
      read: async () => Buffer.from("binary"),
    });
    expect(doc).toEqual({
      text: "from chunks",
      from: "chunks",
      title: "x.bin",
      saved: { projectId: "p", documentId: "doc-1", checksum: "c" },
    });
    fellBackBecause("parse-failed");
  });
});

describe("shouldReadWithModel", () => {
  const long = (s: string) => `${s}\n\n${"More context about the request. ".repeat(80)}`;

  it("reads every document, and pasted text only when it is long and not one issue", () => {
    expect(shouldReadWithModel({ fromDocument: true, text: "short" })).toBe(true);
    expect(shouldReadWithModel({ fromDocument: false, text: "Add a CSV export." })).toBe(false);
    const prose = long("The portal shall let a patient cancel a booking.");
    expect(prose.length).toBeGreaterThanOrEqual(READER_MIN_PASTED_CHARS);
    expect(shouldReadWithModel({ fromDocument: false, text: prose })).toBe(true);
    const justUnder = "a".repeat(READER_MIN_PASTED_CHARS - 1);
    expect(shouldReadWithModel({ fromDocument: false, text: justUnder })).toBe(false);
    expect(shouldReadWithModel({ fromDocument: false, text: `${justUnder}a` })).toBe(true);
  });

  it("keeps the splitter for an issue, however long", () => {
    const issue = readFileSync(join(here, "__fixtures__", "miniflux-4386.md"), "utf8").replace(
      "### Description\n",
      `### Description\n\n${"The page goes blank after marking it read. ".repeat(60)}\n`,
    );
    expect(issue.length).toBeGreaterThanOrEqual(READER_MIN_PASTED_CHARS);
    expect(shouldReadWithModel({ fromDocument: false, text: issue })).toBe(false);
  });
});

function statement(over: Partial<ReadStatement>): ReadStatement {
  return {
    id: "T1",
    kind: "requirement",
    statement: "The portal shall lock an account after five failed attempts.",
    quote: "The portal shall lock an account after five failed attempts.",
    start: 0,
    end: 10,
    sectionId: "S1",
    headingPath: ["Booking FRD", "2 Access"],
    refersTo: [],
    ...over,
  };
}

function section(over: Partial<SectionCoverage>): SectionCoverage {
  return {
    sectionId: "S1",
    headingPath: ["Booking FRD"],
    start: 0,
    end: 10,
    status: "read",
    kinds: {},
    statements: 0,
    unverified: 0,
    repeats: 0,
    ...over,
  };
}

function reading(over: Partial<DocumentReading>): DocumentReading {
  return {
    mode: "whole",
    statements: [],
    sections: [],
    droppedUnverified: 0,
    merge: "done",
    calls: 1,
    outputTokenCap: 8192,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    ...over,
  };
}

describe("changesFromReading", () => {
  it("makes one change per requirement, constraint and business rule, in order, with its context", () => {
    const changes = changesFromReading(
      reading({
        statements: [
          statement({ id: "T1", kind: "background", statement: "Patients phone today." }),
          statement({ id: "T2" }),
          statement({
            id: "T3",
            kind: "constraint",
            statement: "Bookings must be removed after 30 days.",
            quote: "removed after 30 days",
            headingPath: ["Booking FRD", "3 Retention"],
          }),
          statement({ id: "T4", kind: "example", statement: "For example, Ann." }),
          statement({ id: "T5", kind: "business-rule", statement: "A no-show costs 10 GBP." }),
          statement({ id: "T6", kind: "definition", statement: "A clinic is a site." }),
          statement({ id: "T7", kind: "assumption", statement: "Patients have email." }),
        ],
      }),
    );
    expect(changes.map((c) => c.title)).toEqual([
      "The portal shall lock an account after five failed attempts.",
      "Bookings must be removed after 30 days.",
      "A no-show costs 10 GBP.",
    ]);
    expect(changes[0]).toEqual({
      requirementId: null,
      title: "The portal shall lock an account after five failed attempts.",
      body:
        "The portal shall lock an account after five failed attempts.\n\n" +
        "Section: Booking FRD › 2 Access\n" +
        "> The portal shall lock an account after five failed attempts.",
      changeType: "added",
      bodyDelta: changes[0]!.body.length,
    });
    // The change type reads the source's words, here its quote.
    expect(changes[1]!.changeType).toBe("removed");
  });

  it("#2276 — types a change from the source's words, not the model's paraphrase", () => {
    const [kept, retired] = changesFromReading(
      reading({
        statements: [
          statement({
            id: "T1",
            kind: "constraint",
            // The model restated a retention period as a removal.
            statement: "Bookings must be removed after 30 days.",
            quote: "Bookings are kept for 30 days.",
            headingPath: ["Booking FRD", "3 Retention"],
          }),
          statement({
            id: "T2",
            statement: "Paper booking forms are accepted at reception.",
            quote: "Paper booking forms are accepted at reception.",
            headingPath: ["Booking FRD", "4 Retired channels"],
          }),
        ],
      }),
    );
    expect(kept!.changeType).toBe("added");
    // The heading is the source's words too, as the splitter reads it.
    expect(retired!.changeType).toBe("removed");
  });

  it("#2276 — quotes every line of a multi-line quote", () => {
    const [change] = changesFromReading(
      reading({
        statements: [
          statement({ quote: "The portal shall lock an account\nafter five failed attempts." }),
        ],
      }),
    );
    expect(change!.body).toMatch(
      /\n> The portal shall lock an account\n> after five failed attempts\.$/,
    );
  });

  it("clips a long statement's title onto one line", () => {
    const long = `The portal shall\n${"check every booking ".repeat(20)}`;
    const [change] = changesFromReading(reading({ statements: [statement({ statement: long })] }));
    expect(change!.title.length).toBe(120);
    expect(change!.title.endsWith("...")).toBe(true);
    expect(change!.title).not.toContain("\n");
    expect(change!.body.startsWith(long)).toBe(true);
  });
});

describe("documentReadingNotice", () => {
  it("#2280 — says a reading was reused, when and with which model, and how to read again", () => {
    const text = documentReadingNotice(
      reading({
        statements: [statement({ id: "T1" })],
        sections: [section({ sectionId: "S1", kinds: { requirement: 1 } })],
        reused: { readAt: new Date("2026-11-02T09:00:00Z"), model: "claude-sonnet-5-5" },
      }),
      true,
    );
    expect(text).toContain(
      'This reading was saved on 2026-11-02 (read with claude-sonnet-5-5) and reused, because the document\'s file has not changed; re-run with "Read the document again" for a fresh reading.',
    );
    expect(
      documentReadingNotice(reading({ statements: [statement({ id: "T1" })] }), true),
    ).not.toContain("reused");
  });

  it("counts the changes by kind and names the sections that held none", () => {
    const text = documentReadingNotice(
      reading({
        statements: [
          statement({ id: "T1" }),
          statement({ id: "T2" }),
          statement({ id: "T3", kind: "constraint" }),
          statement({ id: "T4", kind: "background" }),
        ],
        sections: [
          section({ sectionId: "S1", headingPath: ["FRD", "1 Purpose"], kinds: { background: 1 } }),
          section({ sectionId: "S2", headingPath: ["FRD", "2 Access"], kinds: { requirement: 2 } }),
          section({ sectionId: "S3", headingPath: ["FRD", "3 Limits"], kinds: { constraint: 1 } }),
        ],
      }),
      true,
    );
    expect(text).toBe(
      "The model read the document (3 sections) and found 2 requirements, 1 constraint; each is analysed as one change. " +
        '1 section held none: "FRD › 1 Purpose".',
    );
  });

  it("names the sections it could not read and the statements it dropped", () => {
    const text = documentReadingNotice(
      reading({
        statements: [statement({ kind: "business-rule" })],
        sections: [
          section({ sectionId: "S1", kinds: { "business-rule": 1 } }),
          ...["A", "B", "C", "D", "E"].map((h, i) =>
            section({ sectionId: `S${i + 2}`, headingPath: [h], status: "unread" }),
          ),
        ],
        droppedUnverified: 2,
      }),
      true,
    );
    expect(text).toContain("found 1 business rule;");
    expect(text).toContain(
      '5 sections could not be read, so nothing from them was analysed: "A", "B", "C" and 2 more.',
    );
    expect(text).toContain("2 statements were dropped because their quote is not in the document.");
    // An unread section is not also listed as holding none.
    expect(text).not.toContain("held none");
  });

  it("says so when the reading found nothing to analyse, and names pasted text as such", () => {
    const text = documentReadingNotice(
      reading({
        statements: [statement({ kind: "background" })],
        sections: [section({ kinds: { background: 1 } })],
        droppedUnverified: 1,
      }),
      false,
    );
    expect(text).toBe(
      "The model read the pasted text (1 section) and found no requirement, constraint or business rule in it, so nothing from it was analysed. " +
        "1 statement was dropped because its quote is not in the pasted text.",
    );
    const one = documentReadingNotice(
      reading({
        statements: [statement({})],
        sections: [
          section({ kinds: { requirement: 1 } }),
          section({ sectionId: "S2", headingPath: ["Z"], status: "unread" }),
        ],
      }),
      true,
    );
    expect(one).toContain('1 section could not be read, so nothing from it was analysed: "Z".');
  });
});

describe("readerFailedNotice", () => {
  it("names the source and what the splitter does instead", () => {
    expect(readerFailedNotice(true)).toMatch(
      /^The model could not read the document, so its changes were split by paragraph/,
    );
    expect(readerFailedNotice(false)).toMatch(/^The model could not read the pasted text/);
  });
});
