/**
 * #2429 — the stored chunks the document reader quotes, read for many
 * documents at once, and joined back into a document's text across the
 * chunker's overlaps.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ knowledge: vi.fn(), quarantine: vi.fn() }));
vi.mock("../prisma.js", () => ({
  prisma: {
    knowledgeChunk: { findMany: db.knowledge },
    quarantineChunk: { findMany: db.quarantine },
  },
}));

const { MIN_CHUNK_OVERLAP, joinOverlappingChunks, storedChunksByDocument } =
  await import("./stored-chunks.js");
const { chunkMarkdown } = await import("./chunker.js");

beforeEach(() => {
  db.knowledge.mockReset();
  db.quarantine.mockReset();
});

describe("storedChunksByDocument", () => {
  it("reads approved chunks by position, and quarantined ones only for documents with none", async () => {
    db.knowledge.mockResolvedValue([
      { documentId: "d1", position: 0, text: "a" },
      { documentId: "d1", position: 1, text: "b" },
    ]);
    db.quarantine.mockResolvedValue([{ documentId: "d2", ord: 0, text: "q" }]);
    const out = await storedChunksByDocument("p1", ["d1", "d2", "d3"]);
    expect(db.knowledge).toHaveBeenCalledWith({
      where: { projectId: "p1", documentId: { in: ["d1", "d2", "d3"] } },
      select: { documentId: true, position: true, text: true },
      orderBy: { position: "asc" },
    });
    expect(db.quarantine).toHaveBeenCalledWith({
      where: { projectId: "p1", documentId: { in: ["d2", "d3"] }, ord: { gte: 0 } },
      select: { documentId: true, ord: true, text: true },
      orderBy: { ord: "asc" },
    });
    expect([...out]).toEqual([
      [
        "d1",
        [
          { index: 0, text: "a" },
          { index: 1, text: "b" },
        ],
      ],
      ["d2", [{ index: 0, text: "q" }]],
    ]);
  });

  it("reads nothing for no documents, and no quarantine when every document is approved", async () => {
    expect((await storedChunksByDocument("p1", [])).size).toBe(0);
    expect(db.knowledge).not.toHaveBeenCalled();
    db.knowledge.mockResolvedValue([{ documentId: "d1", position: 0, text: "a" }]);
    await storedChunksByDocument("p1", ["d1"]);
    expect(db.quarantine).not.toHaveBeenCalled();
  });
});

describe("joinOverlappingChunks", () => {
  it("drops the carry-over a chunk opens with, so a passage across the cut reads whole", () => {
    const passage = "Passwords for guest accounts must be long enough and rotated monthly.";
    const chunks = [
      "Intro. Passwords for guest accounts must be",
      "guest accounts must be long enough and rotated monthly. End.",
    ];
    expect(chunks.join("\n")).not.toContain(passage);
    const joined = joinOverlappingChunks(chunks);
    expect(joined).toBe(`Intro. ${passage} End.`);
  });

  it("joins chunks with no overlap (or one shorter than the minimum) with a newline, keeping both whole", () => {
    expect(joinOverlappingChunks(["one section", "another section"])).toBe(
      "one section\nanother section",
    );
    const short = "x".repeat(MIN_CHUNK_OVERLAP - 1);
    expect(joinOverlappingChunks([`a ${short}`, `${short} b`])).toBe(`a ${short}\n${short} b`);
    expect(joinOverlappingChunks([])).toBe("");
    expect(joinOverlappingChunks(["only"])).toBe("only");
  });

  it("rebuilds every sentence of a document the chunker cut with overlap", () => {
    const sentences = Array.from(
      { length: 120 },
      // No sentence end, and each clause longer than the overlap: the chunker cuts
      // between words, and a clause across a cut is whole in no chunk.
      (_, i) =>
        `clause ${i} says the account policy rule number ${i} holds for every user of every product and every tenant in the project, whatever their role,`,
    );
    const source = `# Policy\n\n${sentences.join(" ")}`;
    const chunks = chunkMarkdown(source, { chunkSize: 512, overlap: 64 }).map((c) => c.text);
    expect(chunks.length).toBeGreaterThan(3);
    const joined = joinOverlappingChunks(chunks);
    for (const s of sentences) expect(joined).toContain(s);
    // Some sentence straddles a cut: the plain join loses it.
    expect(sentences.some((s) => !chunks.join("\n").includes(s))).toBe(true);
  });
});
