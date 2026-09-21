/**
 * #1370 — the `[rag:…]` leak family and the backfill that cleans stored data.
 *
 * Measured on a real database before this fix: 328 `[rag:<cuid>:<cuid>]` markers
 * across 13 generated documents and 315 across 174 indexed chunks, none of which
 * the #1360 stripper matched. It covered MORE documents than the `[facts:…]`
 * family it was filed alongside.
 *
 * Every test here fails against `main`: the stripper only matched `facts:`, and
 * `backfillLeakedMarkers` did not exist at all.
 */
import { describe, it, expect } from "vitest";
import { stripLeakedSourceIds, hasLeakedSourceIds } from "./holistic-synthesizer.js";
import {
  backfillLeakedMarkers,
  type LeakedMarkerBackfillPrisma,
} from "./leaked-marker-backfill.js";

const RAG_MARKER = "[rag:cmsfckrn008gdfhwhh0xqfvvy:cmsfckro308gffhwh70jnburh]";

describe("stripLeakedSourceIds — [rag:…] family (#1370)", () => {
  it("removes a [rag:<cuid>:<cuid>] pair and the space before it", () => {
    expect(stripLeakedSourceIds(`JSP pages live under *.jsp ${RAG_MARKER}.`)).toBe(
      "JSP pages live under *.jsp.",
    );
  });

  it("removes mixed [facts:…] and [rag:…] markers in one sentence", () => {
    const line = `servlet at load-on-startup order 1 [facts:repo:...config:2] ${RAG_MARKER}.`;
    expect(stripLeakedSourceIds(line)).toBe("servlet at load-on-startup order 1.");
  });

  it("still removes the truncated [facts:repo:...N] ellipsis form", () => {
    expect(stripLeakedSourceIds("Batches run nightly [facts:repo:...config:2].")).toBe(
      "Batches run nightly.",
    );
  });

  it("does not touch [rag:…] inside a fenced code block", () => {
    const md = [
      "Prose " + RAG_MARKER + ".",
      "",
      "```ts",
      `const id = "${RAG_MARKER}";`,
      "```",
    ].join("\n");
    expect(stripLeakedSourceIds(md)).toBe(
      ["Prose.", "", "```ts", `const id = "${RAG_MARKER}";`, "```"].join("\n"),
    );
  });

  it("preserves table alignment when a [rag:…] marker sits in a cell", () => {
    const md = [
      "| Module | Purpose |",
      "|--------|---------|",
      `| orders | Billing ${RAG_MARKER} |`,
    ].join("\n");
    expect(stripLeakedSourceIds(md)).toBe(
      ["| Module | Purpose |", "|--------|---------|", "| orders | Billing |"].join("\n"),
    );
  });

  it("leaves ordinary markdown links and reference labels untouched", () => {
    const md = "See [the runbook](https://example.invalid/runbook) and [notes][ref].";
    expect(stripLeakedSourceIds(md)).toBe(md);
  });

  it("hasLeakedSourceIds detects both families and clears once stripped", () => {
    expect(hasLeakedSourceIds(`a ${RAG_MARKER}`)).toBe(true);
    expect(hasLeakedSourceIds("a [facts:x:1]")).toBe(true);
    expect(hasLeakedSourceIds("clean prose")).toBe(false);
    expect(hasLeakedSourceIds(stripLeakedSourceIds(`a ${RAG_MARKER}`))).toBe(false);
  });
});

interface DocRow {
  id: string;
  content: string;
}
interface ChunkRow {
  id: string;
  text: string;
  md5: string;
}

/**
 * In-memory stand-in for the two tables. `findMany` honours the `take`/`skip`
 * offset pagination the backfill uses and re-applies the `contains` filter on
 * every call, so a row that a write removed from the filter really does
 * disappear from later pages — the behaviour the offset scheme depends on.
 */
function makePrisma(docs: DocRow[], chunks: ChunkRow[]) {
  const docWrites: Array<{ id: string; content: string }> = [];
  const chunkWrites: Array<{ id: string; text: string; md5: string }> = [];
  const pageSizes: number[] = [];

  function page<T extends { id: string }>(rows: T[], args: unknown, match: (r: T) => boolean): T[] {
    const a = args as { take?: number; skip?: number };
    const candidates = rows.filter(match).sort((x, y) => x.id.localeCompare(y.id));
    const from = a.skip ?? 0;
    const slice = candidates.slice(from, from + (a.take ?? candidates.length));
    pageSizes.push(slice.length);
    return slice;
  }

  const prisma: LeakedMarkerBackfillPrisma = {
    generatedDocument: {
      findMany: async (args) =>
        page(docs, args, (r) => r.content.includes("[facts:") || r.content.includes("[rag:")).map(
          (r) => ({ id: r.id, content: r.content }),
        ),
      update: async ({ where, data }) => {
        const row = docs.find((d) => d.id === where.id)!;
        row.content = data.content;
        docWrites.push({ id: where.id, content: data.content });
        return { id: where.id };
      },
    },
    knowledgeChunk: {
      findMany: async (args) =>
        page(chunks, args, (r) => r.text.includes("[facts:") || r.text.includes("[rag:")).map(
          (r) => ({ id: r.id, text: r.text }),
        ),
      update: async ({ where, data }) => {
        const row = chunks.find((c) => c.id === where.id)!;
        row.text = data.text;
        row.md5 = data.md5;
        chunkWrites.push({ id: where.id, text: data.text, md5: data.md5 });
        return { id: where.id };
      },
    },
  };
  return { prisma, docWrites, chunkWrites, pageSizes };
}

describe("backfillLeakedMarkers (#1370)", () => {
  it("cleans GeneratedDocument.content and KnowledgeChunk.text in one pass", async () => {
    const docs: DocRow[] = [
      { id: "d1", content: `Executive summary ${RAG_MARKER}.` },
      { id: "d2", content: "Totals are derived [facts:docker_oracle_init:1]." },
    ];
    const chunks: ChunkRow[] = [{ id: "c1", text: `Chunk body ${RAG_MARKER}.`, md5: "stale" }];
    const { prisma } = makePrisma(docs, chunks);

    const report = await backfillLeakedMarkers(prisma);

    expect(docs[0].content).toBe("Executive summary.");
    expect(docs[1].content).toBe("Totals are derived.");
    expect(chunks[0].text).toBe("Chunk body.");
    expect(report.documentsUpdated).toBe(2);
    expect(report.chunksUpdated).toBe(1);
    expect(report.markersRemoved).toBe(3);
  });

  it("recomputes the chunk md5 so it matches the rewritten text", async () => {
    const chunks: ChunkRow[] = [{ id: "c1", text: `Body ${RAG_MARKER}.`, md5: "stale" }];
    const { prisma, chunkWrites } = makePrisma([], chunks);

    await backfillLeakedMarkers(prisma);

    const { createHash } = await import("node:crypto");
    expect(chunkWrites).toHaveLength(1);
    expect(chunkWrites[0].md5).toBe(createHash("md5").update("Body.").digest("hex"));
    expect(chunkWrites[0].md5).not.toBe("stale");
  });

  it("is idempotent — a second run writes nothing", async () => {
    const docs: DocRow[] = [{ id: "d1", content: `Summary ${RAG_MARKER}.` }];
    const chunks: ChunkRow[] = [{ id: "c1", text: `Body ${RAG_MARKER}.`, md5: "stale" }];
    const { prisma, docWrites, chunkWrites } = makePrisma(docs, chunks);

    const first = await backfillLeakedMarkers(prisma);
    const second = await backfillLeakedMarkers(prisma);

    expect(first.documentsUpdated).toBe(1);
    expect(first.chunksUpdated).toBe(1);
    expect(second.documentsUpdated).toBe(0);
    expect(second.chunksUpdated).toBe(0);
    expect(second.markersRemoved).toBe(0);
    expect(docWrites).toHaveLength(1);
    expect(chunkWrites).toHaveLength(1);
  });

  it("dryRun reports the same counts but writes nothing", async () => {
    const docs: DocRow[] = [{ id: "d1", content: `Summary ${RAG_MARKER}.` }];
    const chunks: ChunkRow[] = [{ id: "c1", text: `Body ${RAG_MARKER}.`, md5: "stale" }];
    const { prisma, docWrites, chunkWrites } = makePrisma(docs, chunks);

    const report = await backfillLeakedMarkers(prisma, { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.documentsUpdated).toBe(1);
    expect(report.chunksUpdated).toBe(1);
    expect(docWrites).toHaveLength(0);
    expect(chunkWrites).toHaveLength(0);
    expect(docs[0].content).toContain("[rag:");
  });

  it("pages past batchSize instead of stopping at the first page", async () => {
    const docs: DocRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `d${i}`,
      content: `Doc ${i} ${RAG_MARKER}.`,
    }));
    const { prisma, pageSizes } = makePrisma(docs, []);

    const report = await backfillLeakedMarkers(prisma, { batchSize: 2 });

    expect(report.documentsScanned).toBe(5);
    expect(report.documentsUpdated).toBe(5);
    expect(docs.every((d) => !d.content.includes("[rag:"))).toBe(true);
    // More than one page was genuinely fetched: 2, 2, 1, then the empty page
    // that ends the loop.
    expect(pageSizes.filter((n) => n > 0).length).toBeGreaterThan(1);
  });

  it("terminates and advances past rows it cannot rewrite, instead of looping on them", async () => {
    // Fenced-only docs match the `contains` filter but are never rewritten, so
    // they stay in the filtered set forever. Without the offset advancing past
    // them the loop would re-fetch the same page indefinitely.
    const fenced = ["```ts", `const id = "${RAG_MARKER}";`, "```"].join("\n");
    const docs: DocRow[] = [
      { id: "d0", content: fenced },
      { id: "d1", content: fenced },
      { id: "d2", content: `Prose ${RAG_MARKER}.` },
    ];
    const { prisma } = makePrisma(docs, []);

    const report = await backfillLeakedMarkers(prisma, { batchSize: 2 });

    expect(report.documentsScanned).toBe(3);
    expect(report.documentsUpdated).toBe(1);
    expect(docs[2].content).toBe("Prose.");
  });

  it("leaves a clean corpus completely alone", async () => {
    const docs: DocRow[] = [{ id: "d1", content: "Already clean prose." }];
    const { prisma, docWrites } = makePrisma(docs, []);

    const report = await backfillLeakedMarkers(prisma);

    expect(report.documentsScanned).toBe(0);
    expect(report.documentsUpdated).toBe(0);
    expect(docWrites).toHaveLength(0);
  });

  it("does not strip a marker that only appears inside a fenced block", async () => {
    const fenced = ["```ts", `const id = "${RAG_MARKER}";`, "```"].join("\n");
    const docs: DocRow[] = [{ id: "d1", content: fenced }];
    const { prisma } = makePrisma(docs, []);

    const report = await backfillLeakedMarkers(prisma);

    // Scanned (the `contains` filter matched) but not rewritten.
    expect(report.documentsScanned).toBe(1);
    expect(report.documentsUpdated).toBe(0);
    expect(docs[0].content).toBe(fenced);
  });
});
