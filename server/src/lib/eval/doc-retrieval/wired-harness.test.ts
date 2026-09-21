import { describe, expect, it, vi } from "vitest";

// The harness imports `prisma`, whose module body builds a driver adapter from
// `DATABASE_URL` at load. These tests exercise the PURE seams (guards, storage,
// span→chunk derivation), so the client is mocked away rather than connected.
vi.mock("../../prisma.js", () => ({
  prisma: {},
  // #1338 — the URL the client was BOUND to at module load, which is not
  // necessarily `process.env.DATABASE_URL` by the time a harness reads it.
  boundDatabaseUrl: "file:./dev.db",
  redactDatabaseUrl: (u: string) => u,
}));

import { chunkMarkdown, maxOverlapFor } from "../../rag/chunker.js";
import {
  CHUNK_SIZE_ARMS,
  CONTROL_CHUNK_SIZE,
  overlapArmsFor,
  type ChunkArmResult,
  type ChunkArmSpec,
} from "./chunk-sweep.js";
import { loadDocRetrievalCorpus, type DocRetrievalCorpus } from "./corpus.js";
import {
  armSensitiveQueryIds,
  assertPrismaOwnsDatabase,
  assertThrowawayDatabase,
  assertTokenCounterInjectedUnderTest,
  corpusStorage,
  coveredQueryIds,
  loadRerankTokenCounter,
  measureOverlapDelivery,
  openCorpusRetrieval,
  pickWinningArm,
  profileArmsAgainstRerankBudget,
  pushSchema,
  relevantChunksForArm,
  runChunkArm,
  runChunkSweep,
} from "./wired-harness.js";

const spec = (chunkSize: number, overlap: number): ChunkArmSpec => ({
  id: `size-${chunkSize}`,
  chunkSize,
  overlap,
  control: chunkSize === 2048,
  rationale: "test",
});

const LONG = "Sentence about alpha configuration and retry policy. ".repeat(120);
const tinyCorpus = (): DocRetrievalCorpus => {
  const text = `# Doc\n\n## One\n\n${LONG}\n\n## Two\n\nshort tail section.\n`;
  const quote = text.slice(text.indexOf("## Two") + 10, text.indexOf("## Two") + 28);
  return {
    id: "test",
    snapshotCommit: "0".repeat(40),
    description: "",
    projectId: "p1",
    docs: [{ id: "d.md", text }],
    queries: [
      {
        id: "q-long",
        question: "alpha?",
        doc: "d.md",
        quote: "",
        phrasing: "lexical",
        spanStart: 200,
        spanEnd: 300,
      },
      {
        id: "q-tail",
        question: "tail?",
        doc: "d.md",
        quote,
        phrasing: "lexical",
        spanStart: text.indexOf("short tail section"),
        spanEnd: text.indexOf("short tail section") + 18,
      },
    ],
  };
};

describe("assertThrowawayDatabase", () => {
  const tmp = "/tmp/eval1160-abc";

  it("accepts a SQLite file inside the run's own temp directory", () => {
    expect(() => assertThrowawayDatabase(`file:${tmp}/x.db`, tmp)).not.toThrow();
  });

  it("refuses Postgres — the harness writes Documents and deletes chunks", () => {
    expect(() => assertThrowawayDatabase("postgres://user:pw@host/prod", tmp)).toThrow(
      /throwaway SQLite file/,
    );
  });

  it("refuses an undefined DATABASE_URL rather than defaulting to dev.db", () => {
    expect(() => assertThrowawayDatabase(undefined, tmp)).toThrow(/throwaway SQLite file/);
  });

  it("refuses a SQLite file OUTSIDE the temp directory, e.g. the developer's dev.db", () => {
    expect(() => assertThrowawayDatabase("file:./dev.db", tmp)).toThrow(
      /must live under the run's temp directory|temp directory/,
    );
  });

  it("does not leak the connection string into the error message", () => {
    let message = "";
    try {
      assertThrowawayDatabase("postgres://user:sup3rsecret@host/prod", tmp);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain("sup3rsecret");
  });
});

describe("corpusStorage", () => {
  it("reads back a seeded blob", async () => {
    const store = corpusStorage(new Map([["mem://a", Buffer.from("hello")]]));
    expect((await store.read("mem://a")).toString()).toBe("hello");
    expect(await store.exists("mem://a")).toBe(true);
    expect(await store.exists("mem://missing")).toBe(false);
  });

  it("throws on an unknown path rather than returning empty bytes", async () => {
    const store = corpusStorage(new Map());
    await expect(store.read("mem://nope")).rejects.toThrow(/no blob at/);
  });

  it("write returns a content-addressed blob descriptor", async () => {
    const store = corpusStorage(new Map());
    const blob = await store.write({
      projectId: "p",
      buffer: Buffer.from("abc"),
      filename: "a.md",
      mimeType: "text/markdown",
    } as never);
    expect(blob.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(blob.storagePath).toContain(blob.checksum);
  });

  it("remove and removeProject are inert — storage is not on the query path", async () => {
    const store = corpusStorage(new Map());
    await expect(store.remove("mem://a")).resolves.toBeUndefined();
    await expect(store.removeProject("p")).resolves.toBeUndefined();
  });
});

describe("relevantChunksForArm", () => {
  it("derives exactly one relevant chunk per query from the fixed span", () => {
    const corpus = tinyCorpus();
    const rel = relevantChunksForArm(corpus, spec(2048, 256));
    expect(rel.size).toBe(2);
    for (const q of corpus.queries) expect(rel.get(q.id)?.text.length).toBeGreaterThan(0);
  });

  it("returns the chunk that actually CONTAINS the span text", () => {
    const corpus = tinyCorpus();
    const rel = relevantChunksForArm(corpus, spec(2048, 256));
    expect(rel.get("q-tail")?.text).toContain("short tail section");
  });

  it("reports full coverage when one chunk holds the whole span", () => {
    const rel = relevantChunksForArm(tinyCorpus(), spec(3072, 384));
    expect(rel.get("q-tail")?.coverage).toBe(1);
  });

  it("throws when a query names a document the corpus does not have", () => {
    const corpus = tinyCorpus();
    corpus.queries[0].doc = "absent.md";
    expect(() => relevantChunksForArm(corpus, spec(2048, 256))).toThrow(/unknown document/);
  });

  /**
   * `dq-eks-05` was the canonical dropped span: absent from every chunk at 1024/128
   * while present at the shipped 2048/256, which is what made the loss a property of
   * the chunk size rather than of the query. #1178 gave `chunkMarkdown` its tiling
   * property and the span came back at every arm.
   *
   * Asserted on the REAL corpus rather than a synthetic document: a synthetic doc
   * built from identical repeated lines defeats the monotone alignment (every chunk
   * matches at the earliest identical occurrence), so it would assert an artefact.
   *
   * The `null`-rather-than-throw contract this used to cover is now exercised by
   * `chunk-alignment.test.ts` against `bestCoveringChunk` directly, because a tiling
   * chunker gives the real corpus no dropped span to reach it with.
   */
  it("retains the span that the pre-#1178 chunker dropped, at every arm", async () => {
    const corpus = await loadDocRetrievalCorpus();
    for (const [size, overlap] of [
      [768, 96],
      [1024, 128],
      [2048, 256],
      [3072, 384],
    ] as const) {
      const rel = relevantChunksForArm(corpus, spec(size, overlap));
      expect(rel.has("dq-eks-05"), `${size}/${overlap} knows the query`).toBe(true);
      expect(rel.get("dq-eks-05"), `${size}/${overlap} retains the span`).not.toBeNull();
    }
  });
});

describe("coveredQueryIds", () => {
  it("lists only the queries whose span survives chunking", () => {
    const corpus = tinyCorpus();
    expect(coveredQueryIds(corpus, spec(2048, 256))).toEqual(["q-long", "q-tail"]);
  });
});

describe("armSensitiveQueryIds", () => {
  it("excludes a query whose section is shorter than both arms' chunk size", () => {
    const corpus = tinyCorpus();
    // "short tail section." is its own tiny section — identical at every arm.
    expect(armSensitiveQueryIds(corpus, spec(2048, 256), spec(768, 96))).not.toContain("q-tail");
  });

  it("includes a query whose containing section is re-chunked", () => {
    const corpus = tinyCorpus();
    expect(armSensitiveQueryIds(corpus, spec(2048, 256), spec(768, 96))).toContain("q-long");
  });

  it("is empty when both arms are the same", () => {
    const corpus = tinyCorpus();
    expect(armSensitiveQueryIds(corpus, spec(2048, 256), spec(2048, 256))).toEqual([]);
  });
});

describe("the committed corpus against the real arms", () => {
  it("keeps at least one arm-sensitive query per arm, or the sweep cannot measure anything", async () => {
    const corpus = await loadDocRetrievalCorpus();
    const control = CHUNK_SIZE_ARMS.find((a) => a.control) as ChunkArmSpec;
    for (const arm of CHUNK_SIZE_ARMS.filter((a) => !a.control)) {
      expect(armSensitiveQueryIds(corpus, control, arm).length, arm.id).toBeGreaterThan(0);
    }
  });

  it("resolves a relevant chunk OR an explicit null for every query at every arm", async () => {
    const corpus = await loadDocRetrievalCorpus();
    for (const arm of CHUNK_SIZE_ARMS) {
      const rel = relevantChunksForArm(corpus, arm);
      expect(rel.size).toBe(corpus.queries.length);
      for (const q of corpus.queries) expect(rel.has(q.id)).toBe(true);
    }
  });
});

describe("pushSchema", () => {
  it("invokes prisma db push against the throwaway URL, never a config-resolved one", () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    pushSchema("file:/tmp/eval1160-x/a.db", (file, args) => {
      calls.push({ file, args });
      return undefined;
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("npx");
    expect(calls[0].args).toContain("db");
    expect(calls[0].args).toContain("push");
    // The URL must be passed EXPLICITLY — prisma.config.ts would otherwise resolve
    // the datasource itself and the harness could write to the real database.
    expect(calls[0].args).toContain("--url");
    expect(calls[0].args).toContain("file:/tmp/eval1160-x/a.db");
  });

  it("does not pass --skip-generate, which this Prisma version rejects", () => {
    let args: readonly string[] = [];
    pushSchema("file:/tmp/x.db", (_f, a) => {
      args = a;
      return undefined;
    });
    expect(args).not.toContain("--skip-generate");
  });
});

describe("pickWinningArm", () => {
  const arm = (id: string, ndcg: number): ChunkArmResult =>
    ({
      spec: { ...spec(2048, 256), id },
      chunkCount: 1,
      reindexSeconds: 1,
      perQuery: [],
      metrics: { queryCount: 0, recallAtK: {}, mrr: 0, ndcgAtK: { 10: ndcg }, hitRateAt10: 0 },
      meanSpanCoverage: 1,
      sensitiveQueryIds: [],
      uncoveredQueryIds: [],
    }) as ChunkArmResult;

  it("picks the highest nDCG@10", () => {
    expect(pickWinningArm([arm("a", 0.1), arm("b", 0.9), arm("c", 0.5)]).spec.id).toBe("b");
  });

  it("keeps the EARLIER arm on a tie, so a flat sweep reports the control", () => {
    expect(pickWinningArm([arm("control", 0.5), arm("other", 0.5)]).spec.id).toBe("control");
  });

  it("throws rather than returning undefined when no arm ran", () => {
    expect(() => pickWinningArm([])).toThrow(/no arms were run/);
  });
});

describe("runChunkArm", () => {
  /**
   * The fake ingest reports the count the PRODUCTION chunker really produces for this
   * corpus, not an arbitrary constant. `runChunkArm` now cross-checks its locally
   * recomputed chunking against what ingest wrote — that is the guard on the
   * assumption the ground truth rests on — so a fixture inventing a count would be
   * testing the guard's failure path in every case.
   */
  const localChunks = (corpus: DocRetrievalCorpus, s: ChunkArmSpec): number =>
    corpus.docs.reduce(
      (n, d) => n + chunkMarkdown(d.text, { chunkSize: s.chunkSize, overlap: s.overlap }).length,
      0,
    );

  const base = async (
    overrides: Partial<Parameters<typeof runChunkArm>[2]> = {},
    hits: string[] = [],
  ): Promise<ChunkArmResult> => {
    const corpus = tinyCorpus();
    const armSpec = spec(2048, 256);
    const total = localChunks(corpus, armSpec);
    return runChunkArm(corpus, armSpec, {
      embedder: {} as never,
      tmpRoot: (await import("node:os")).tmpdir(),
      storagePaths: new Map(corpus.docs.map((d) => [d.id, `mem://${d.id}`])),
      docIds: new Map(corpus.docs.map((d) => [d.id, `doc-${d.id}`])),
      makeService: () => ({
        async ingestDocument() {
          return { status: "ready", chunkCount: total };
        },
        async search() {
          return { hits: hits.map((text) => ({ text })) };
        },
      }),
      resetIndex: async () => {},
      countPersisted: async () => total,
      ...overrides,
    });
  };

  /**
   * The dropped-span path, which the real corpus can no longer reach.
   *
   * Before #1178 this was exercised by `dq-eks-05` at 1024/128 falling into one of the
   * chunker's gaps. A tiling chunker has no gaps, so the branch that scores an
   * uncovered span 0, records it in `uncoveredQueryIds` and logs it would now be dead
   * in the test suite — and it is precisely the REGRESSION DETECTOR for #1178, so
   * letting it go uncovered would retire the alarm along with the fire.
   *
   * The span here is past the end of its document, so no chunk can overlap it at any
   * chunk size. That keeps the test independent of chunker internals: it asserts the
   * harness's response to an uncoverable span rather than re-creating a chunker bug.
   */
  it("scores an uncoverable span 0 and reports it rather than throwing", async () => {
    const corpus = tinyCorpus();
    const doc = corpus.docs[0];
    corpus.queries = [
      {
        ...corpus.queries[0],
        id: "q-unreachable",
        question: "unreachable?",
        spanStart: doc.text.length + 10,
        spanEnd: doc.text.length + 60,
      },
    ];
    const armSpec = spec(2048, 256);
    const total = localChunks(corpus, armSpec);
    const logged: string[] = [];
    const result = await runChunkArm(corpus, armSpec, {
      embedder: {} as never,
      tmpRoot: (await import("node:os")).tmpdir(),
      storagePaths: new Map(corpus.docs.map((d) => [d.id, `mem://${d.id}`])),
      docIds: new Map(corpus.docs.map((d) => [d.id, `doc-${d.id}`])),
      makeService: () => ({
        async ingestDocument() {
          return { status: "ready", chunkCount: total };
        },
        async search() {
          // Return real chunk text: even a perfect retrieval cannot score, because the
          // right answer is an unretrievable sentinel rather than any chunk.
          return { hits: [{ text: doc.text.slice(0, 200) }] };
        },
      }),
      resetIndex: async () => {},
      countPersisted: async () => total,
      log: (m: string) => logged.push(m),
    });
    expect(result.uncoveredQueryIds).toEqual(["q-unreachable"]);
    expect(result.spanCoverage["q-unreachable"]).toBe(0);
    expect(result.perQuery.find((q) => q.queryId === "q-unreachable")?.ndcgAtK[10]).toBe(0);
    expect(logged.join("\n")).toContain("answer span(s) DROPPED by the chunker");
  });

  it("scores a query that retrieves its relevant chunk at rank 1", async () => {
    const corpus = tinyCorpus();
    const target = relevantChunksForArm(corpus, spec(2048, 256)).get("q-tail");
    const result = await base({}, [target?.text ?? ""]);
    const tail = result.perQuery.find((q) => q.queryId === "q-tail");
    expect(tail?.ndcgAtK[10]).toBe(1);
  });

  it("scores a query whose relevant chunk is not retrieved as 0", async () => {
    const result = await base({}, ["something else entirely"]);
    for (const q of result.perQuery) expect(q.ndcgAtK[10]).toBe(0);
  });

  /**
   * The agreement check exists because a silently partial ingest would make the
   * arm score a smaller index than the one it claims to have measured.
   */
  it("fails loudly when persisted chunks disagree with what ingest reported", async () => {
    await expect(base({ countPersisted: async () => 3 })).rejects.toThrow(
      /ingest reported \d+ chunks but 3 were persisted/,
    );
  });

  /**
   * The persisted-count check above catches a partial WRITE. This one catches the
   * assumption the ground truth actually rests on: that the locally recomputed
   * `chunkMarkdown` matches the chunking ingest wrote. If `parseDocument` ever
   * normalised the text first, every derived relevant chunk would stop matching any
   * indexed chunk and all four arms would deflate to zero WITHOUT an error.
   */
  it("fails loudly when ingest's chunking disagrees with the locally derived one", async () => {
    const corpus = tinyCorpus();
    const total = localChunks(corpus, spec(2048, 256));
    await expect(
      base({
        makeService: () => ({
          async ingestDocument() {
            return { status: "ready", chunkCount: total + 1 };
          },
          async search() {
            return { hits: [] };
          },
        }),
        countPersisted: async () => total + 1,
      }),
    ).rejects.toThrow(/ground truth is derived from a DIFFERENT chunking/);
  });

  it("throws when the corpus names a document with no seeded Document row", async () => {
    await expect(base({ docIds: new Map() })).rejects.toThrow(/No Document row seeded/);
  });

  it("records per-query span coverage, which is what the coverage-clean subset reads", async () => {
    const result = await base();
    expect(Object.keys(result.spanCoverage).sort()).toEqual(["q-long", "q-tail"]);
    for (const v of Object.values(result.spanCoverage)) expect(v).toBeGreaterThan(0);
  });

  /**
   * Only that the fields are populated. The RATIO is asserted on the committed
   * corpus in `measureOverlapDelivery` below, never here: `tinyCorpus` is 120
   * byte-identical sentences, which is precisely the repetitive input
   * `alignChunksToSource` documents as defeating its monotone location — every chunk
   * matches at the earliest occurrence, the derived ranges bunch toward the front,
   * and realised overlap comes out ABOVE the tiled expectation. Asserting the
   * shortfall here would be asserting that artefact.
   */
  it("records realised against configured overlap for the #1178 callout", async () => {
    const result = await base();
    expect(result.expectedOverlapChars).toBeGreaterThan(0);
    expect(Number.isFinite(result.realisedOverlapChars)).toBe(true);
  });

  it("reports zero mean span coverage for a corpus with no queries", async () => {
    const corpus = { ...tinyCorpus(), queries: [] };
    const armSpec = spec(2048, 256);
    const total = localChunks(corpus, armSpec);
    const result = await runChunkArm(corpus, armSpec, {
      embedder: {} as never,
      tmpRoot: (await import("node:os")).tmpdir(),
      // No storage path for the document — the harness falls back to "" rather than
      // failing, because storage is not on the query path.
      storagePaths: new Map(),
      docIds: new Map(corpus.docs.map((d) => [d.id, `doc-${d.id}`])),
      makeService: () => ({
        async ingestDocument() {
          return { status: "ready", chunkCount: total };
        },
        async search() {
          return { hits: [] };
        },
      }),
      resetIndex: async () => {},
      countPersisted: async () => total,
    });
    expect(result.meanSpanCoverage).toBe(0);
    expect(result.spanCoverage).toEqual({});
  });

  it("fails loudly when a document does not ingest cleanly", async () => {
    await expect(
      base({
        makeService: () => ({
          async ingestDocument() {
            return { status: "failed", chunkCount: 0, errorMessage: "boom" };
          },
          async search() {
            return { hits: [] };
          },
        }),
      }),
    ).rejects.toThrow(/ended failed: boom/);
  });

  it("resets the index before the arm, so BM25 cannot carry over the previous arm", async () => {
    const reset: string[] = [];
    await base({ resetIndex: async (projectId) => void reset.push(projectId) });
    expect(reset).toEqual(["p1"]);
  });

  it("records the chunk count and a non-negative reindex wall clock", async () => {
    const result = await base();
    expect(result.chunkCount).toBe(localChunks(tinyCorpus(), spec(2048, 256)));
    expect(result.reindexSeconds).toBeGreaterThanOrEqual(0);
  });

  it("reports no dropped spans when every span survives", async () => {
    expect((await base()).uncoveredQueryIds).toEqual([]);
  });
});

describe("profileArmsAgainstRerankBudget", () => {
  it("profiles every arm using the injected token counter", async () => {
    const corpus = tinyCorpus();
    const profiles = await profileArmsAgainstRerankBudget(
      corpus,
      () => {},
      async () => (t: string) => Math.ceil(t.length / 4),
    );
    expect(profiles.map((p) => p.chunkSize)).toEqual([768, 1024, 2048, 3072]);
  });

  it("returns an empty profile rather than failing the sweep when the tokenizer is unavailable", async () => {
    const logged: string[] = [];
    const profiles = await profileArmsAgainstRerankBudget(
      tinyCorpus(),
      (m) => logged.push(m),
      async () => {
        throw new Error("no weights on disk");
      },
    );
    expect(profiles).toEqual([]);
    expect(logged.join("\n")).toContain("no weights on disk");
  });

  /**
   * `TokenCounter` is `(text) => Promise<number> | number` (`rerank-budget.ts:41`).
   * An unawaited call makes `queryTokens` NaN, hence `passageBudget` NaN, hence
   * `t > NaN === false` for every chunk — so the profile reports `truncatedChunks: 0`
   * and `meanSurvivingFraction: 1`, a clean-looking table asserting the exact opposite
   * of what this measurement is for. The real tokenizer happens to be synchronous, so
   * nothing else in the suite can see the defect.
   *
   * This test FAILS if the `await` is removed: with an async counter the assertions
   * below become NaN / 0 / 1.
   */
  it("awaits an ASYNC token counter instead of reporting a vacuous 0% over budget", async () => {
    // Two characters per token, not the realistic four. The divisor only has to put
    // the arm's chunks CLEARLY over `RERANK_TOKEN_BUDGET − query − specials` (507), so
    // that `truncatedChunks > 0` tests the await rather than the fixture's chunk
    // lengths. At four it did not: the largest chunk came to 506 tokens, one under the
    // budget, so #1178's boundary change flipped this assertion to 0 without touching
    // the seam it exists to guard.
    const asyncCounter = async (t: string): Promise<number> => Math.ceil(t.length / 2);
    const profiles = await profileArmsAgainstRerankBudget(
      tinyCorpus(),
      () => {},
      async () => asyncCounter,
    );
    const at2048 = profiles.find((p) => p.chunkSize === 2048);
    expect(at2048).toBeDefined();
    // Awaited: a real, finite mean query length. Unawaited: NaN.
    expect(Number.isFinite(at2048?.queryTokens)).toBe(true);
    expect(at2048?.queryTokens).toBeGreaterThan(0);
    // Awaited: chunks of ~2048 chars are ~1024 tokens here, comfortably over the
    // remaining budget. Unawaited: `t > NaN` is false for all of them, so 0.
    expect(at2048?.truncatedChunks).toBeGreaterThan(0);
    expect(at2048?.meanSurvivingFraction).toBeLessThan(1);
    expect(Number.isFinite(at2048?.medianTokens)).toBe(true);
  });

  it("still averages the query length when the corpus has no queries", async () => {
    const empty = { ...tinyCorpus(), queries: [] };
    const profiles = await profileArmsAgainstRerankBudget(
      empty,
      () => {},
      async () => (t: string) => Math.ceil(t.length / 4),
    );
    expect(profiles[0].queryTokens).toBe(0);
  });
});

/**
 * The seam that keeps "no network from `pnpm test`" an invariant rather than a
 * convention. The `catch` in `profileArmsAgainstRerankBudget` would otherwise swallow
 * a Hugging Face fetch failure and return `[]`, so a future test that forgot the stub
 * would reach the network and still pass green.
 */
describe("assertTokenCounterInjectedUnderTest", () => {
  const injected = async (): Promise<(t: string) => number> => (t) => t.length;

  it("refuses the DEFAULT loader under test — that call is a Hugging Face fetch", async () => {
    // Reached through the public entry point with no `loadCounter` argument, which is
    // exactly the mistake being guarded against.
    await expect(profileArmsAgainstRerankBudget(tinyCorpus(), () => {})).rejects.toThrow(
      /without a `loadTokenCounter` seam/,
    );
  });

  it("is NOT swallowed by the profile's degrade-to-empty catch", async () => {
    const logged: string[] = [];
    await expect(
      profileArmsAgainstRerankBudget(tinyCorpus(), (m) => logged.push(m)),
    ).rejects.toThrow();
    // A skipped-profile log line would mean the catch had absorbed it.
    expect(logged).toEqual([]);
  });

  // The real reference is passed by IDENTITY and never invoked, so these assertions
  // exercise the guard itself rather than a stand-in that would pass either way.
  it("rejects the real loader by identity under test", () => {
    expect(() => assertTokenCounterInjectedUnderTest(loadRerankTokenCounter)).toThrow(
      /Hugging Face/,
    );
  });

  it("allows an injected counter", () => {
    expect(() => assertTokenCounterInjectedUnderTest(injected)).not.toThrow();
  });

  it("allows the real loader when the download gate is explicitly set", () => {
    vi.stubEnv("EMBEDDINGS_MODEL_DOWNLOAD_TESTS", "1");
    try {
      expect(() => assertTokenCounterInjectedUnderTest(loadRerankTokenCounter)).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is inert outside a test run, where the CLI legitimately loads the tokenizer", () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => assertTokenCounterInjectedUnderTest(loadRerankTokenCounter)).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("measureOverlapDelivery", () => {
  /**
   * The second consequence of the same line as #1178: the cursor advanced a full
   * stride regardless of where the boundary cut, so almost none of the configured
   * overlap was delivered — 19.2% at the shipped arm, once the denominator is counted
   * correctly. Asserted on the REAL corpus, because delivery is a property of real
   * heading-structured prose.
   *
   * The bound is deliberately loose at 0.9: a boundary cut trims the couple of
   * characters of a line ending at each seam, so exactly 100% is unreachable by
   * construction and pinning a tighter figure would fail on corpus edits that have
   * nothing to do with tiling.
   */
  it("shows the committed corpus now delivers nearly all of the configured overlap", async () => {
    const corpus = await loadDocRetrievalCorpus();
    const { realised, expected } = measureOverlapDelivery(corpus, spec(2048, 256));
    expect(expected).toBeGreaterThan(10_000);
    expect(realised / expected).toBeGreaterThan(0.9);
    expect(realised / expected).toBeLessThanOrEqual(1);
  });

  it("reports zero expected overlap when the arm configures none", () => {
    const { expected } = measureOverlapDelivery(tinyCorpus(), spec(2048, 0));
    expect(expected).toBe(0);
  });

  /**
   * #1183. `chunkMarkdown` caps carry-over at `maxOverlapFor(chunkSize)` — 192 at 768
   * (#1185) — so an arm requesting 256 there runs at 192. Dividing by the REQUEST
   * over-states what a tiled window could have delivered and charges the difference to
   * #1178's tiling. The tell is that delivery still lands around 0.75, above
   * `OVERLAP_INTERPRETABLE_FRACTION`, so the READABLE guard does not misfire and the
   * error passes unnoticed.
   */
  it("divides by the EFFECTIVE overlap, not the value a clamped arm requested", async () => {
    const corpus = await loadDocRetrievalCorpus();
    expect(maxOverlapFor(768)).toBe(192);
    const clamped = measureOverlapDelivery(corpus, spec(768, 256));
    const atTheCap = measureOverlapDelivery(corpus, spec(768, 192));
    // Same chunking, so the same denominator — the request must not leak into it.
    expect(clamped.expected).toBe(atTheCap.expected);
    expect(clamped.realised).toBe(atTheCap.realised);
    // And the naive denominator would have been 256/192 = 1.33x larger.
    expect(clamped.expected).toBeLessThan((atTheCap.expected * 256) / 192);
    expect(clamped.realised / clamped.expected).toBeGreaterThan(0.9);
  }, 30_000);

  /**
   * The denominator correction of #1178, isolated.
   *
   * A section's FIRST chunk has no predecessor to carry over from, so counting it as
   * a continuation inflates "expected if tiled" and understates delivery. The old
   * rule — "a chunk that begins after its predecessor's start is a continuation" — is
   * true of a new section's first chunk too, and most METIS sections fit in one
   * chunk, so on the real corpus it counted 466 boundaries where 51 are genuine. That
   * ninefold inflation is where #1178's original "~98% undelivered" figure came from.
   *
   * This document is built so the two rules give DIFFERENT answers: many one-chunk
   * sections (no continuations at all) and one long section that really is split.
   */
  it("counts only WITHIN-section boundaries, not section transitions", () => {
    const long = "Sentence about alpha configuration and retry policy. ".repeat(120);
    const text = [
      "# Doc",
      "",
      "## Long",
      "",
      long,
      "",
      "## A",
      "",
      "first short section.",
      "",
      "## B",
      "",
      "second short section.",
      "",
      "## C",
      "",
      "third short section.",
      "",
    ].join("\n");
    const corpus = { ...tinyCorpus(), docs: [{ id: "d.md", text }], queries: [] };
    const chunks = chunkMarkdown(text, { chunkSize: 2048, overlap: 256 });
    const { expected } = measureOverlapDelivery(corpus, spec(2048, 256));

    // Ground truth: `chunks − sections`. Five sections here (`Doc` is heading-only,
    // then Long/A/B/C), and only `Long` is split, so the continuations are the extra
    // chunks `Long` contributes beyond its first.
    const sections = 5;
    const continuations = chunks.length - sections;
    expect(continuations).toBeGreaterThan(0);
    expect(expected).toBe(continuations * 256);

    // The rejected rule would have counted nearly every adjacent pair, so it must
    // give a strictly larger answer on this document — otherwise the test is
    // asserting nothing about which rule is in force.
    expect(expected).toBeLessThan((chunks.length - 1) * 256);
  });
});

describe("runChunkSweep orchestration", () => {
  /**
   * Drives the real sweep — every arm, the winner choice, the overlap arm and the
   * report assembly — with the DATABASE seams injected. The chunking, the span
   * alignment and the scoring are all the real code; only Prisma is stood in for.
   */
  const runFake = async (
    rank: (spec: ChunkArmSpec, relevantText: string) => string[],
  ): ReturnType<typeof runChunkSweep> => {
    const os = await import("node:os");
    const corpus = await loadDocRetrievalCorpus();
    let currentSpec: ChunkArmSpec | null = null;
    // The fake ingest reports the count the REAL chunker produces, per document and
    // per arm, so `runChunkArm`'s chunking-agreement guard is exercised honestly
    // rather than short-circuited by a constant.
    const chunksFor = (s: ChunkArmSpec, docId: string): number =>
      chunkMarkdown(corpus.docs.find((d) => d.id === docId)?.text ?? "", {
        chunkSize: s.chunkSize,
        overlap: s.overlap,
      }).length;
    const docIdToCorpusId = new Map(corpus.docs.map((d) => [`doc-mem://${d.id}`, d.id]));
    return runChunkSweep({
      embedder: { model: "fake-embedder" } as never,
      tmpRoot: os.tmpdir(),
      seed: 11,
      resamples: 200,
      seedDocuments: async (c, storagePaths) =>
        new Map(c.docs.map((d) => [d.id, `doc-${storagePaths.get(d.id) ?? d.id}`])),
      makeService: (spec) => {
        currentSpec = spec;
        return {
          async ingestDocument(documentId: string) {
            const docId = docIdToCorpusId.get(documentId);
            if (!docId) throw new Error(`fake ingest: unknown document ${documentId}`);
            return { status: "ready", chunkCount: chunksFor(spec, docId) };
          },
          async search(_projectId: string, question: string) {
            const corpusPromise = loadDocRetrievalCorpus();
            const corpus = await corpusPromise;
            const q = corpus.queries.find((x) => x.question === question);
            const rel = q
              ? relevantChunksForArm(corpus, currentSpec as ChunkArmSpec).get(q.id)
              : null;
            return {
              hits: rank(currentSpec as ChunkArmSpec, rel?.text ?? "").map((text) => ({ text })),
            };
          },
        };
      },
      resetIndex: async () => {},
      countPersisted: async (): Promise<number> =>
        corpus.docs.reduce((n, d) => n + chunksFor(currentSpec as ChunkArmSpec, d.id), 0),
      // A STUB token counter. Without this seam the sweep would reach for
      // `AutoTokenizer.from_pretrained(...)` — a Hugging Face fetch — inside the
      // default `pnpm test` gate, which does not set EMBEDDINGS_MODEL_DOWNLOAD_TESTS.
      loadTokenCounter: async () => (t: string) => Math.ceil(t.length / 4),
      log: () => {},
    });
  };

  it("runs every declared size arm and compares each against the control", async () => {
    const report = await runFake((_s, relevant) => [relevant]);
    expect(report.control.spec.control).toBe(true);
    expect(report.comparisons.map((c) => c.armId).sort()).toEqual(
      CHUNK_SIZE_ARMS.filter((a) => !a.control)
        .map((a) => a.id)
        .sort(),
    );
  }, 60_000);

  it("produces a flat, NOT-ESTABLISHED sweep when every arm retrieves perfectly", async () => {
    const report = await runFake((_s, relevant) => [relevant]);
    for (const c of report.comparisons) {
      expect(c.all.verdict).toBe("NOT-ESTABLISHED");
    }
  }, 60_000);

  it("profiles the cross-encoder budget through the injected counter, with no model fetch", async () => {
    const report = await runFake((_s, relevant) => [relevant]);
    expect(report.rerankBudget.map((b) => b.chunkSize)).toEqual([768, 1024, 2048, 3072]);
  }, 60_000);

  /**
   * The overlap ladder runs at the CONTROL's size, not the winning one (#1183). Every
   * arm is paired against the 2048/256 control, so an overlap arm at another size
   * would have moved size and overlap together — which is precisely why #1160 could
   * not answer the overlap question.
   */
  it("runs the overlap ladder at the CONTROL size and reports corpus provenance", async () => {
    const report = await runFake((_s, relevant) => [relevant]);
    const plan = overlapArmsFor(CONTROL_CHUNK_SIZE);
    expect(report.overlapComparisons.map((c) => c.armId)).toEqual(plan.arms.map((a) => a.id));
    expect(report.overlapComparisons.every((c) => c.chunkSize === CONTROL_CHUNK_SIZE)).toBe(true);
    expect(report.overlapComparisons.length).toBeGreaterThan(1);
    expect(report.overlapPlan).toEqual(plan);
    expect(report.snapshotCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(report.queryCount).toBeGreaterThanOrEqual(40);
    expect(report.corpusChars).toBeGreaterThan(100_000);
    expect(report.embeddingModel).toBe("fake-embedder");
  }, 120_000);
});

describe("openCorpusRetrieval (#1338)", () => {
  const session = async (
    overrides: Partial<Parameters<typeof openCorpusRetrieval>[1]> = {},
    hits: string[] = ["retrieved chunk"],
  ) => {
    const corpus = tinyCorpus();
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const tmpRoot = await fs.mkdtemp(`${os.tmpdir()}/ac-retrieval-`);
    const ingested: string[] = [];
    const searches: { projectId: string; question: string; k: number }[] = [];
    const s = await openCorpusRetrieval(corpus, {
      tmpRoot,
      embedder: {} as never,
      seedDocuments: async (c) => new Map(c.docs.map((d) => [d.id, `doc-${d.id}`])),
      makeService: () => ({
        async ingestDocument(documentId: string) {
          ingested.push(documentId);
          return { status: "ready", chunkCount: 7 };
        },
        async search(projectId: string, question: string, o: { k: number }) {
          searches.push({ projectId, question, k: o.k });
          return { hits: hits.map((text) => ({ text })) };
        },
      }),
      ...overrides,
    });
    return {
      s,
      ingested,
      searches,
      tmpRoot,
      cleanup: () => fs.rm(tmpRoot, { recursive: true, force: true }),
    };
  };

  it("ingests the corpus through the production path and reports what was written", async () => {
    const { s, ingested, cleanup } = await session();
    try {
      expect(ingested).toEqual(["doc-d.md"]);
      expect(s.chunkCount).toBe(7);
      expect(s.projectId).toBe("p1");
    } finally {
      await cleanup();
    }
  });

  it("searches the corpus's OWN project at the requested depth, returning chunk TEXT", async () => {
    const { s, searches, cleanup } = await session({}, ["alpha", "beta"]);
    try {
      expect(await s.search("alpha?", 4)).toEqual(["alpha", "beta"]);
      expect(searches).toEqual([{ projectId: "p1", question: "alpha?", k: 4 }]);
    } finally {
      await cleanup();
    }
  });

  it("defaults to the CONTROL arm — the chunking METIS actually ships", async () => {
    const seen: ChunkArmSpec[] = [];
    const { cleanup } = await session({
      makeService: (spec) => {
        seen.push(spec);
        return {
          async ingestDocument() {
            return { status: "ready", chunkCount: 1 };
          },
          async search() {
            return { hits: [] };
          },
        };
      },
    });
    try {
      expect(seen[0]?.control).toBe(true);
      expect(seen[0]?.chunkSize).toBe(CONTROL_CHUNK_SIZE);
    } finally {
      await cleanup();
    }
  });

  it("refuses a half-built index rather than answering from it", async () => {
    await expect(
      session({
        makeService: () => ({
          async ingestDocument() {
            return { status: "failed", chunkCount: 0, errorMessage: "storage unreachable" };
          },
          async search() {
            return { hits: [] };
          },
        }),
      }),
    ).rejects.toThrow(/ended failed: storage unreachable/);
  });
});

describe("assertPrismaOwnsDatabase (#1338)", () => {
  it("refuses when Prisma is bound to a DIFFERENT database than the run owns", () => {
    // The failure it prevents: `assertThrowawayDatabase` passes on the string
    // the caller intends, while the client writes corpus rows into a
    // developer's dev.db because something imported prisma.js first.
    expect(() => assertPrismaOwnsDatabase("file:/tmp/run-123/throwaway.db")).toThrow(
      /bound to "file:\.\/dev\.db" but this run owns "file:\/tmp\/run-123\/throwaway\.db"/,
    );
  });

  it("names the cause an operator can act on", () => {
    expect(() => assertPrismaOwnsDatabase("file:/tmp/x.db")).toThrow(/before DATABASE_URL was set/);
  });

  it("passes when the client is bound to exactly the database the run owns", () => {
    expect(() => assertPrismaOwnsDatabase("file:./dev.db")).not.toThrow();
  });

  it("is a SEPARATE check from assertThrowawayDatabase, which cannot see the binding", () => {
    // Both guards run in the generator; this is why one is not enough.
    expect(() =>
      assertThrowawayDatabase("file:/tmp/run-123/throwaway.db", "/tmp/run-123"),
    ).not.toThrow();
    expect(() => assertPrismaOwnsDatabase("file:/tmp/run-123/throwaway.db")).toThrow();
  });
});
