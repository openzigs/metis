/**
 * Epic #1316 / Issue #1338 — the glue between the doc-retrieval harness and the
 * answer generator, with the harness itself injected.
 *
 * What is asserted here is the orchestration only: which queries get answered,
 * that the corpus is indexed ONCE, and that a drifted query id costs one answer
 * rather than the whole run.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatResponse } from "../../ai/types.js";
import type { DocRetrievalCorpus } from "../doc-retrieval/corpus.js";
import type { CorpusRetrievalSession } from "../doc-retrieval/wired-harness.js";
import { generateCorpusAnswers } from "./corpus-answers.js";

const corpus = (): DocRetrievalCorpus =>
  ({
    id: "docretrieval-01-metis-docs",
    projectId: "eval-project",
    snapshotCommit: "deadbeef",
    docs: [],
    queries: [
      { id: "dq-ops-01", question: "What is the RPO?" },
      { id: "dq-ops-02", question: "Where do metrics live?" },
      { id: "dq-sec-01", question: "How do tokens rotate?" },
    ],
  }) as unknown as DocRetrievalCorpus;

const provider = (answer = "an answer"): AIProvider =>
  ({
    key: "anthropic",
    model: "m",
    offline: false,
    chat: async () => ({ content: answer }) as unknown as ChatResponse,
  }) as unknown as AIProvider;

const session = (): CorpusRetrievalSession => ({
  projectId: "eval-project",
  chunkCount: 12,
  search: async () => ["a retrieved chunk"],
});

describe("generateCorpusAnswers", () => {
  it("answers ONLY the queries that carry gold", async () => {
    const searched: string[] = [];
    const out = await generateCorpusAnswers(["dq-ops-02"], {
      corpus: corpus(),
      provider: provider("Under eval-results."),
      tmpRoot: "/unused",
      embedder: {} as never,
      openRetrieval: async () => ({
        ...session(),
        search: async (question) => {
          searched.push(question);
          return ["chunk"];
        },
      }),
    });
    expect(out).toEqual([{ queryId: "dq-ops-02", answer: "Under eval-results." }]);
    expect(searched).toEqual(["Where do metrics live?"]);
  });

  it("indexes the corpus ONCE for the whole set, not once per query", async () => {
    const openRetrieval = vi.fn(async () => session());
    await generateCorpusAnswers(["dq-ops-01", "dq-ops-02", "dq-sec-01"], {
      corpus: corpus(),
      provider: provider(),
      tmpRoot: "/unused",
      embedder: {} as never,
      openRetrieval,
    });
    expect(openRetrieval).toHaveBeenCalledTimes(1);
  });

  it("never opens a retrieval session when no gold query matches the corpus", async () => {
    // Ingesting a corpus to answer nothing is the exact waste #1338 removes.
    const openRetrieval = vi.fn(async () => session());
    const log = vi.fn();
    const out = await generateCorpusAnswers(["dq-nope-99"], {
      corpus: corpus(),
      provider: provider(),
      tmpRoot: "/unused",
      embedder: {} as never,
      openRetrieval,
      log,
    });
    expect(out).toEqual([]);
    expect(openRetrieval).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no such query in the corpus"));
  });

  it("honours the retrieval depth, model override and abort signal", async () => {
    const seenK: number[] = [];
    const seenModel: unknown[] = [];
    const controller = new AbortController();
    await generateCorpusAnswers(["dq-ops-01"], {
      corpus: corpus(),
      provider: {
        key: "anthropic",
        model: "m",
        offline: false,
        chat: async (_msgs: unknown, opts: Record<string, unknown>) => {
          seenModel.push(opts.model);
          expect(opts.signal).toBe(controller.signal);
          return { content: "answered" } as unknown as ChatResponse;
        },
      } as unknown as AIProvider,
      tmpRoot: "/unused",
      embedder: {} as never,
      k: 3,
      model: "haiku",
      signal: controller.signal,
      openRetrieval: async () => ({
        ...session(),
        search: async (_q, k) => {
          seenK.push(k);
          return ["chunk"];
        },
      }),
    });
    expect(seenK).toEqual([3]);
    expect(seenModel).toEqual(["haiku"]);
  });

  it("loses one drifted id, not the other answers", async () => {
    const out = await generateCorpusAnswers(["dq-ops-01", "dq-drifted-42"], {
      corpus: corpus(),
      provider: provider("Five minutes."),
      tmpRoot: "/unused",
      embedder: {} as never,
      openRetrieval: async () => session(),
    });
    expect(out.map((o) => o.queryId)).toEqual(["dq-ops-01"]);
  });
});
