/**
 * Epic #1316 / Issue #1319 — argument handling for `pnpm eval:answer-correctness`.
 *
 * The corpus id becomes a filesystem path, so the parser is the boundary that
 * has to hold: a traversal here would let a run read an arbitrary file and then
 * COMMIT it into `eval-results/` via the nightly workflow.
 */
import { describe, expect, it, vi } from "vitest";
import {
  embedderAllowed,
  makeGenerator,
  NO_EMBEDDER_REASON,
  parseCorpus,
  summariseEnvelope,
} from "./eval-answer-correctness.js";
import { correctnessEnvelope } from "../src/lib/eval/answer-correctness/metric.js";
import {
  offlineJudgeDeps,
  providerJudgeDeps,
} from "../src/lib/eval/answer-correctness/judge-deps.js";
import type { AIProvider } from "../src/lib/ai/types.js";
import type { DocRetrievalCorpus } from "../src/lib/eval/doc-retrieval/corpus.js";
import { DEFAULT_DOC_CORPUS_ID } from "../src/lib/eval/doc-retrieval/corpus.js";

describe("parseCorpus", () => {
  it("defaults to the corpus #1319 scopes (decision 2), not the wide one", () => {
    expect(parseCorpus([])).toBe(DEFAULT_DOC_CORPUS_ID);
    expect(parseCorpus(["--validate-only"])).toBe(DEFAULT_DOC_CORPUS_ID);
    // `--corpus` with a missing or flag-shaped value falls back rather than
    // consuming the next flag as an id.
    expect(parseCorpus(["--corpus"])).toBe(DEFAULT_DOC_CORPUS_ID);
    expect(parseCorpus(["--corpus", "--validate-only"])).toBe(DEFAULT_DOC_CORPUS_ID);
  });

  it("accepts a plain corpus id", () => {
    expect(parseCorpus(["--corpus", "docretrieval-02-metis-docs-wide"])).toBe(
      "docretrieval-02-metis-docs-wide",
    );
  });

  it.each([
    "../../etc/passwd",
    "..",
    "/etc/passwd",
    "docretrieval-01/../../../secrets",
    "a b",
    "corpus;rm -rf /",
    "corpus$(whoami)",
  ])("rejects %s", (bad) => {
    expect(() => parseCorpus(["--corpus", bad])).toThrow(/invalid --corpus/);
  });
});

describe("embedderAllowed", () => {
  it("requires the real embedder to be enabled, exactly as eval:doc-retrieval does", () => {
    expect(embedderAllowed({} as NodeJS.ProcessEnv)).toBe(false);
    expect(embedderAllowed({ EMBEDDINGS_MODEL_DOWNLOAD_TESTS: "1" } as NodeJS.ProcessEnv)).toBe(
      true,
    );
  });

  it("refuses the hash fallback — a chance-level answer is worse than no answer", () => {
    expect(
      embedderAllowed({
        EMBEDDINGS_MODEL_DOWNLOAD_TESTS: "1",
        EMBED_ALLOW_HASH_FALLBACK: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

describe("makeGenerator — the CI-hermetic gates", () => {
  const corpus = { queries: [] } as unknown as DocRetrievalCorpus;
  const liveProvider = {
    key: "anthropic",
    model: "m",
    offline: false,
    chat: async () => {
      throw new Error("no test may reach a provider");
    },
  } as unknown as AIProvider;

  const db = async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const tmpRoot = await mkdtemp(nodePath.join(os.tmpdir(), "eval1338-test-"));
    return { tmpRoot, databaseUrl: `file:${nodePath.join(tmpRoot, "answer-correctness.db")}` };
  };

  /** No SQLite file was created, so nothing reached `prisma db push`. */
  const dbUntouched = async (d: { databaseUrl: string }): Promise<boolean> => {
    const { access } = await import("node:fs/promises");
    return access(d.databaseUrl.slice("file:".length)).then(
      () => false,
      () => true,
    );
  };

  it("generates nothing, and says why, when no provider is configured", async () => {
    // Ingesting a corpus and answering 48 questions that nothing could then
    // judge is pure cost. The reason is logged so the skip is not silent.
    const log = vi.fn();
    const d = await db();
    const judge = offlineJudgeDeps("no AI provider is configured.");
    expect(await makeGenerator(corpus, judge, log, d)(["dq-ops-01"])).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no AI provider is configured."));
    expect(await dbUntouched(d)).toBe(true);
  });

  it("generates nothing, and says why, when the real embedder is not enabled", async () => {
    const log = vi.fn();
    const d = await db();
    const prev = process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS;
    delete process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS;
    try {
      const judge = providerJudgeDeps(liveProvider);
      expect(judge.unavailableReason).toBeNull();
      expect(await makeGenerator(corpus, judge, log, d)(["dq-ops-01"])).toEqual([]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining(NO_EMBEDDER_REASON));
      // A skip that still pushed the schema would have paid for a database the
      // run then never used.
      expect(await dbUntouched(d)).toBe(true);
    } finally {
      if (prev !== undefined) process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS = prev;
    }
  });
});

/**
 * Issue #1342 — the line a human reads in the nightly log.
 *
 * Before this issue it was `mean=0.531…` and nothing else, which is precisely
 * the figure that reads as "METIS is 53% correct". The envelope JSON is also
 * echoed into the job summary, but the console line is what a developer running
 * the script sees, and it has to stand on its own.
 */
describe("summariseEnvelope (#1342)", () => {
  const reported = correctnessEnvelope({
    corpusId: "docretrieval-01-metis-docs",
    referenceCount: 2,
    results: [
      { queryId: "a", recall: 1, precision: 1 / 7, f1: 0.25, answerClaims: 7, referenceClaims: 1 },
      { queryId: "b", recall: 1, precision: 1, f1: 1, answerClaims: 3, referenceClaims: 3 },
    ],
  });

  it("leads with recall and precision, and labels the blend as length-sensitive", () => {
    const [headline] = summariseEnvelope("docretrieval-01-metis-docs", reported);
    expect(headline).toContain("recall=1.000");
    expect(headline).toContain("precision=0.571");
    expect(headline).toContain("f1(length-sensitive)=0.625");
    expect(headline?.indexOf("recall=")).toBeLessThan(headline?.indexOf("f1(") ?? -1);
    // The bare key that invited the misreading must not come back.
    expect(headline).not.toMatch(/(^|[^a-zA-Z])mean=/);
  });

  it("prints the computed interpretation, so the caveat is not only in the JSON", () => {
    const lines = summariseEnvelope("docretrieval-01-metis-docs", reported);
    expect(lines.some((l) => l.includes("LENGTH-SENSITIVE"))).toBe(true);
    expect(lines.some((l) => l.includes("5.0 claim(s) per answer against 2.0"))).toBe(true);
  });

  it("says MALFORMED rather than printing the word `undefined` into the metric line", () => {
    // `aggregate` is optional on the type; `reported: true` without one is a bug
    // in `correctnessEnvelope`. The previous `scored=${agg?.scored}` would have
    // rendered "scored=undefined recall=unverifiable" — a line that reads like a
    // run which merely could not score, not a broken envelope.
    const broken = { ...reported, aggregate: undefined, interpretation: undefined };
    const lines = summariseEnvelope("c", broken);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("MALFORMED ENVELOPE");
    expect(lines[0]).not.toContain("undefined");
  });

  it("still says NOT REPORTED with the reason code when nothing was scored", () => {
    const lines = summariseEnvelope("c", correctnessEnvelope({ corpusId: "c", referenceCount: 0 }));
    expect(lines[0]).toContain("NOT REPORTED [no-gold-answers]");
    // No number, and nothing to caveat.
    expect(lines).toHaveLength(1);
  });
});
