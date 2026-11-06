/**
 * Issue #1841 — `pnpm --filter @metis/server eval:req-retrieval` entrypoint.
 *
 * Asks chat's real `list_requirements` tool the questions in
 * `src/lib/eval/requirement-retrieval/__fixtures__/corpus.json`, once with the
 * word path alone (before #1841) and once with search by meaning fused in, and
 * prints recall@3, MRR@10 and how much each arm returns for questions no
 * requirement answers.
 *
 *   pnpm --filter @metis/server eval:req-retrieval                     # the configured embedder
 *   pnpm --filter @metis/server eval:req-retrieval -- --recorded       # replay the committed vectors
 *   pnpm --filter @metis/server eval:req-retrieval -- --record-vectors # re-record them
 *
 * No LLM call. Thin orchestration; the logic is `retrieval.ts`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEmbedder } from "../src/lib/rag/embedder.js";
import {
  loadRecordedVectors,
  RecordedEmbedService,
  RecordingEmbedService,
  writeRecordedVectors,
} from "../src/lib/eval/recorded-vectors.js";
import type { EmbedService } from "../src/lib/code-graph/symbol-embeddings.js";
import {
  corpusRequirementText,
  corpusSemanticSearch,
  loadRetrievalCorpus,
  renderRetrievalReport,
  runPre1841Arm,
  runRetrievalArm,
} from "../src/lib/eval/requirement-retrieval/retrieval.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(
  here,
  "..",
  "src",
  "lib",
  "eval",
  "requirement-retrieval",
  "__fixtures__",
);
const CORPUS = path.join(FIXTURES, "corpus.json");
const RECORDED = path.join(FIXTURES, "corpus-recorded.json");
const RERECORD = "pnpm --filter @metis/server eval:req-retrieval -- --record-vectors";

async function main(): Promise<number> {
  const corpus = await loadRetrievalCorpus(CORPUS);

  if (process.argv.includes("--record-vectors")) {
    const recording = new RecordingEmbedService(getEmbedder());
    await recording.embed([
      ...corpus.requirements.map(corpusRequirementText),
      ...corpus.questions.map((q) => q.text),
    ]);
    await writeRecordedVectors(RECORDED, recording.toFiles(RERECORD));
    process.stdout.write(`recorded the corpus vectors -> ${RECORDED}\n`);
    return 0;
  }

  let embed: EmbedService;
  let model: string;
  if (process.argv.includes("--recorded")) {
    const recording = await loadRecordedVectors(RECORDED);
    if (!recording) throw new Error(`no recording at ${RECORDED}; run: ${RERECORD}`);
    embed = new RecordedEmbedService(recording, RERECORD);
    model = `${recording.model} (recorded)`;
  } else {
    const embedder = getEmbedder();
    embed = embedder;
    model = embedder.model;
  }

  const before = await runPre1841Arm(corpus);
  const words = await runRetrievalArm("words only, ranked (#1841)", corpus, async () => []);
  const hybrid = await runRetrievalArm(
    "meaning and words (#1841)",
    corpus,
    await corpusSemanticSearch(corpus, embed),
  );
  if (!process.argv.includes("--recorded") && getEmbedder().fellBack) {
    process.stderr.write("eval:req-retrieval: the embedder fell back to the hash stub\n");
    return 1;
  }
  process.stdout.write(`${renderRetrievalReport(model, [before, words, hybrid])}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${String(err instanceof Error ? (err.stack ?? err.message) : err)}\n`);
    process.exit(1);
  },
);
