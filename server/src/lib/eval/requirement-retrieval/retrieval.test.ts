/**
 * Issue #1841 — the requirement-retrieval slice, replayed from the committed
 * vectors of the real embedder (no model download): the numbers the PR reports
 * are the numbers this reproduces.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadRecordedVectors, RecordedEmbedService } from "../recorded-vectors.js";
import {
  corpusSemanticSearch,
  loadRetrievalCorpus,
  renderRetrievalReport,
  runPre1841Arm,
  runRetrievalArm,
} from "./retrieval.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const tmp = mkdtempSync(path.join(os.tmpdir(), "metis-1841-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("requirement retrieval slice (#1841)", () => {
  it("search by meaning finds what words alone miss, on the real embedder's vectors", async () => {
    const corpus = await loadRetrievalCorpus(path.join(FIXTURES, "corpus.json"));
    const recording = await loadRecordedVectors(path.join(FIXTURES, "corpus-recorded.json"));
    expect(recording?.model).toBe("Alibaba-NLP/gte-modernbert-base");
    const embed = new RecordedEmbedService(recording!, "eval:req-retrieval --record-vectors");

    const before = await runPre1841Arm(corpus);
    const words = await runRetrievalArm("words", corpus, async () => []);
    const hybrid = await runRetrievalArm(
      "hybrid",
      corpus,
      await corpusSemanticSearch(corpus, embed),
    );
    expect(embed.missing).toEqual([]);
    expect(before).toMatchObject({ answerable: 17, hitsAt3: 5 });
    expect(words.hitsAt3).toBe(11);
    expect(hybrid.hitsAt3).toBe(17);
    expect(hybrid.mrr).toBeGreaterThan(words.mrr);
    // "let customers pay later": no word in common with "Deferred settlement terms".
    expect(before.questions[0]).toMatchObject({ id: "q01", rank: null });
    expect(hybrid.questions[0]?.rank).toBeLessThanOrEqual(3);

    const md = renderRetrievalReport("m", [before, hybrid]);
    expect(md).toContain("| hybrid | 17/17 (1.000) |");
    expect(md).toContain("| q18 | none | 10 returned | 10 returned |");
  });

  it("refuses a question that expects an unknown requirement", async () => {
    const file = path.join(tmp, "bad.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        requirements: [{ id: "r1", status: "draft", title: "t", body: "b" }],
        questions: [{ id: "q1", text: "x", expected: "r9" }],
      }),
    );
    await expect(loadRetrievalCorpus(file)).rejects.toThrow(/unknown requirement r9/);
  });
});
