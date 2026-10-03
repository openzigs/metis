/**
 * #717 — the lexical half of hybrid retrieval must match code by its parts.
 *
 * In the #706 walkthrough "how often are feeds refreshed", and even the
 * identifier query "ScheduleNextCheck polling scheduler entry_frequency
 * round_robin", returned miniflux's TESTS and never `internal/model/feed.go`,
 * which DEFINES `ScheduleNextCheck`. The definition spells the concepts as
 * camelCase identifiers; a tokenizer that keeps `SchedulerEntryFrequency` whole
 * can never match `entry` or `frequency` there, while the tests spell them as
 * `"entry_frequency"` and win every term. The corpus here is a synthetic
 * repository of the same shape (see the fixture's header).
 *
 * Measured against the real miniflux v2.3.3 files with the real chunker while
 * fixing this: the definition went from 8th to 1st on the identifier query, and
 * from 10th to 6th on the lexical half of "how often are feeds refreshed".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLI_SYNC,
  CORPUS,
  DEFINITION,
  OPTION,
  TRANSLATIONS,
} from "./fixtures/code-retrieval-corpus.js";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    knowledgeChunk: { findMany: vi.fn(async () => []) },
    document: { findMany: vi.fn(async () => []) },
  },
}));

import { BM25Index, __resetBM25IndexSingleton, codeAwareTerms } from "../src/lib/rag/bm25-index.js";
import { prisma } from "../src/lib/prisma.js";

const PROJECT = "p717";

async function seededIndex(): Promise<BM25Index> {
  const idx = new BM25Index();
  for (const c of CORPUS) {
    await idx.upsertDocumentChunks(
      PROJECT,
      `doc-${c.id}`,
      `connector:repo:conn1:src/${c.relPath}`,
      [{ id: c.id, position: Number(c.id.split("#")[1]), text: c.text }],
      false,
    );
  }
  return idx;
}

beforeEach(() => __resetBM25IndexSingleton());
afterEach(() => vi.clearAllMocks());

describe("codeAwareTerms (#717)", () => {
  it("keeps an identifier whole and adds its camelCase / snake_case parts", () => {
    expect(codeAwareTerms("ScheduleNextCheck")).toEqual(
      expect.arrayContaining(["schedulenextcheck", "schedule", "next", "check"]),
    );
    expect(codeAwareTerms("SchedulerEntryFrequency")).toEqual(
      expect.arrayContaining(["schedulerentryfrequency", "scheduler", "entry", "frequency"]),
    );
    expect(codeAwareTerms("HTTPServerError")).toEqual(
      expect.arrayContaining(["httpservererror", "http", "server", "error"]),
    );
  });

  it("folds simple English inflections so a question meets the code's words", () => {
    expect(codeAwareTerms("feeds")).toContain("feed");
    expect(codeAwareTerms("refreshed")).toContain("refresh");
    expect(codeAwareTerms("refreshing")).toContain("refresh");
    expect(codeAwareTerms("policies")).toContain("policy");
    // Not over-stemmed: a double-s word and a short word are left alone.
    expect(codeAwareTerms("class")).toEqual(["class"]);
    expect(codeAwareTerms("bus")).toEqual(["bus"]);
  });

  it("drops question stop words, which only add noise to a BM25 OR query", () => {
    expect(codeAwareTerms("how")).toEqual([]);
    expect(codeAwareTerms("are")).toEqual([]);
    expect(codeAwareTerms("the")).toEqual([]);
  });
});

describe("BM25 over code (#717)", () => {
  // Old tokenizer: the four tests ranked 1-4 and the definition LAST, as in the
  // walkthrough's "ScheduleNextCheck polling scheduler entry_frequency round_robin".
  it("ranks the DEFINING chunk above its tests for an identifier query", async () => {
    const idx = await seededIndex();
    const hits = await idx.search(PROJECT, "PlanNextSync activity_based fixed_rate", 10);
    const ids = hits.map((h) => h.chunkId);
    expect(ids[0]).toBe(DEFINITION);
    // The option table that names the strategies is still part of the answer.
    expect(ids).toContain(OPTION);
  });

  // Old tokenizer: the translation file led on "which"/"the"; now the definition does.
  it("ranks the definition first for a question phrased in its words", async () => {
    const idx = await seededIndex();
    const hits = await idx.search(PROJECT, "which strategy decides the next sync", 10);
    expect(hits[0]?.chunkId).toBe(DEFINITION);
  });

  // Old tokenizer: translations first on "how"/"often"/"are", definition last of four.
  it("leads with code, not the translation file, for the walkthrough's question shape", async () => {
    const idx = await seededIndex();
    const hits = await idx.search(PROJECT, "how often are sources synced", 10);
    const ids = hits.map((h) => h.chunkId);
    expect(ids[0]).toBe(CLI_SYNC);
    expect(ids.slice(0, 3)).toContain(DEFINITION);
    expect(ids[0]).not.toBe(TRANSLATIONS);
  });

  it("matches a repository file by its path, not only its body", async () => {
    const idx = new BM25Index();
    await idx.upsertDocumentChunks(
      PROJECT,
      "d-sched",
      "connector:repo:c1:src/internal/scheduler/poller.go",
      [{ id: "path-only", position: 0, text: "func run() { tick() }" }],
    );
    await idx.upsertDocumentChunks(
      PROJECT,
      "d-other",
      "connector:repo:c1:src/internal/ui/view.go",
      [{ id: "other", position: 0, text: "func render() { draw() }" }],
    );
    const hits = await idx.search(PROJECT, "scheduler", 5);
    expect(hits.map((h) => h.chunkId)).toEqual(["path-only"]);
  });

  // The cold load (`loadProject`, a restart or first search) builds the index
  // from the database rows, not from `upsertDocumentChunks`: it must index the
  // same `path` field, or a path-only match works until the process restarts.
  it("matches by path on a cold load from the database", async () => {
    vi.mocked(prisma.knowledgeChunk.findMany).mockResolvedValueOnce([
      { id: "path-only", documentId: "d-sched", position: 0, text: "func run() { tick() }" },
      { id: "other", documentId: "d-other", position: 0, text: "func render() { draw() }" },
    ] as never);
    vi.mocked(prisma.document.findMany).mockResolvedValueOnce([
      { id: "d-sched", filename: "connector:repo:c1:src/internal/scheduler/poller.go" },
      { id: "d-other", filename: "connector:repo:c1:src/internal/ui/view.go" },
    ] as never);
    const idx = new BM25Index();
    const hits = await idx.search(PROJECT, "scheduler", 5);
    expect(prisma.knowledgeChunk.findMany).toHaveBeenCalled();
    expect(hits.map((h) => h.chunkId)).toEqual(["path-only"]);
  });

  it("does not match every file of a language because the query says its extension", async () => {
    const idx = new BM25Index();
    await idx.upsertDocumentChunks(PROJECT, "d1", "connector:repo:c1:src/internal/a.go", [
      { id: "a", position: 0, text: "func a() {}" },
    ]);
    expect(await idx.search(PROJECT, "go", 5)).toEqual([]);
  });

  it("does not match the connector key or the src/ marker of every repository file", async () => {
    const idx = new BM25Index();
    await idx.upsertDocumentChunks(PROJECT, "d1", "connector:repo:c1:src/internal/a.go", [
      { id: "a", position: 0, text: "func a() {}" },
    ]);
    expect(await idx.search(PROJECT, "connector repo src", 5)).toEqual([]);
  });
});
