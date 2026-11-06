/**
 * Issue #1841 — a requirement-retrieval slice for chat's `list_requirements`.
 *
 * `eval:answer-correctness` scores chat ANSWERS against human gold answers over
 * documents (#1319) and has no requirement corpus, so this slice measures the
 * part #1841 changed: whether the tool puts the requirement that answers an
 * analyst's question in its top 3. Both arms run the REAL tool
 * (`createListRequirementsTool`) over the same rows — the word path alone, as
 * before #1841, and words fused with search by meaning — and differ only in the
 * `semantic` dependency. The meaning search here ranks the fixture's
 * requirements by cosine in memory, embedding each through the requirement
 * index's own text format (`formatRequirementForEmbedding`) with the configured
 * embedder; the index's store round trip is tested elsewhere.
 *
 * No LLM call. Entrypoint: `scripts/eval-req-retrieval.ts`.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { EmbedService } from "../../code-graph/symbol-embeddings.js";
import { cosineSimilarity } from "../../rag/vector-store.js";
import { formatRequirementForEmbedding } from "../../requirements/requirement-embeddings.js";
import {
  createListRequirementsTool,
  type RequirementToolsDeps,
  type SemanticRequirementSearch,
} from "../../requirements/requirements-chat-tools.js";

const corpusSchema = z.object({
  version: z.literal(1),
  description: z.string().optional(),
  requirements: z
    .array(
      z.object({
        id: z.string().min(1),
        status: z.enum(["draft", "approved", "rejected", "deferred"]),
        title: z.string().min(1),
        body: z.string(),
      }),
    )
    .min(1),
  questions: z
    .array(
      z.object({ id: z.string().min(1), text: z.string().min(1), expected: z.string().nullable() }),
    )
    .min(1),
});

export type RetrievalCorpus = z.infer<typeof corpusSchema>;

/** Read and validate the corpus; every `expected` must name a requirement. */
export async function loadRetrievalCorpus(path: string): Promise<RetrievalCorpus> {
  const corpus = corpusSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const ids = new Set(corpus.requirements.map((r) => r.id));
  for (const q of corpus.questions) {
    if (q.expected !== null && !ids.has(q.expected)) {
      throw new Error(`question ${q.id} expects unknown requirement ${q.expected}`);
    }
  }
  return corpus;
}

/** The text the index embeds for a corpus requirement. */
export function corpusRequirementText(r: RetrievalCorpus["requirements"][number]): string {
  return formatRequirementForEmbedding({ title: r.title, body: r.body, acceptanceCriteria: "[]" });
}

const PROJECT = "eval-req-retrieval";

/** The rows `list_requirements` reads, served from the corpus. */
function corpusPrisma(corpus: RetrievalCorpus): NonNullable<RequirementToolsDeps["prisma"]> {
  const rows = corpus.requirements.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    type: "feature",
    priority: "medium",
    labels: "[]",
    reviewStatus: r.status,
    _count: { codeMappings: 0, dataMappings: 0 },
  }));
  return {
    requirement: { findMany: async () => rows },
  } as unknown as NonNullable<RequirementToolsDeps["prisma"]>;
}

/** An in-memory meaning search over the corpus, with the given embedder. */
export async function corpusSemanticSearch(
  corpus: RetrievalCorpus,
  embed: EmbedService,
): Promise<SemanticRequirementSearch> {
  const { vectors } = await embed.embed(corpus.requirements.map(corpusRequirementText));
  return async (_projectId, query, limit) => {
    const {
      vectors: [q],
    } = await embed.embed([query]);
    return corpus.requirements
      .map((r, i) => ({ requirementId: r.id, score: cosineSimilarity(q as number[], vectors[i]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  };
}

export interface QuestionResult {
  id: string;
  expected: string | null;
  /** The tool's ids, best first (up to 10). */
  returned: string[];
  /** 1-based rank of `expected`, or null when absent. */
  rank: number | null;
}

export interface ArmReport {
  arm: string;
  answerable: number;
  /** Answerable questions whose requirement is in the top 3. */
  hitsAt3: number;
  recallAt3: number;
  /** Mean reciprocal rank over the answerable questions (0 when absent from the top 10). */
  mrr: number;
  /** Results returned, summed over the questions no requirement answers. */
  unanswerableReturned: number;
  questions: QuestionResult[];
}

/** Score one arm: `ask` returns the requirement ids for a question, best first. */
async function scoreArm(
  arm: string,
  corpus: RetrievalCorpus,
  ask: (question: string) => Promise<string[]>,
): Promise<ArmReport> {
  const questions: QuestionResult[] = [];
  for (const q of corpus.questions) {
    const returned = (await ask(q.text)).slice(0, 10);
    const at = q.expected === null ? -1 : returned.indexOf(q.expected);
    questions.push({ id: q.id, expected: q.expected, returned, rank: at >= 0 ? at + 1 : null });
  }
  const answerable = questions.filter((q) => q.expected !== null);
  const hitsAt3 = answerable.filter((q) => q.rank !== null && q.rank <= 3).length;
  return {
    arm,
    answerable: answerable.length,
    hitsAt3,
    recallAt3: answerable.length === 0 ? 0 : hitsAt3 / answerable.length,
    mrr:
      answerable.length === 0
        ? 0
        : answerable.reduce((s, q) => s + (q.rank ? 1 / q.rank : 0), 0) / answerable.length,
    unanswerableReturned: questions
      .filter((q) => q.expected === null)
      .reduce((s, q) => s + q.returned.length, 0),
    questions,
  };
}

/** Ask the real tool every corpus question with one `semantic` dependency. */
export function runRetrievalArm(
  arm: string,
  corpus: RetrievalCorpus,
  semantic: SemanticRequirementSearch,
): Promise<ArmReport> {
  const tool = createListRequirementsTool({ prisma: corpusPrisma(corpus), semantic });
  return scoreArm(arm, corpus, async (question) => {
    const res = await tool.exec(
      { query: question, limit: 10 },
      { sessionId: "eval", userId: "eval", projectId: PROJECT },
    );
    return ((res.data as { requirements?: Array<{ id: string }> })?.requirements ?? []).map(
      (r) => r.id,
    );
  });
}

/**
 * The tool as it was before #1841, replicated: keep every requirement whose
 * title or body contains any query word, in the order the database returned
 * them (here the corpus order; production read `updatedAt desc`).
 */
export function runPre1841Arm(corpus: RetrievalCorpus): Promise<ArmReport> {
  return scoreArm("before #1841 (any word, unranked)", corpus, async (question) => {
    const terms = question
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    return corpus.requirements
      .filter((r) => {
        const haystack = `${r.title}\n${r.body}`.toLowerCase();
        return terms.some((t) => haystack.includes(t));
      })
      .map((r) => r.id);
  });
}

export function renderRetrievalReport(model: string, arms: readonly ArmReport[]): string {
  const lines = [
    `Embedder: \`${model}\``,
    "",
    "| arm | recall@3 | MRR@10 | results on unanswerable questions |",
    "|---|---|---|---|",
    ...arms.map(
      (a) =>
        `| ${a.arm} | ${a.hitsAt3}/${a.answerable} (${a.recallAt3.toFixed(3)}) | ${a.mrr.toFixed(3)} | ${a.unanswerableReturned} |`,
    ),
    "",
    "| question | expected | " + arms.map((a) => `${a.arm} rank`).join(" | ") + " |",
    "|---|---|" + arms.map(() => "---").join("|") + "|",
  ];
  const first = arms[0];
  if (first) {
    first.questions.forEach((q, i) => {
      lines.push(
        `| ${q.id} | ${q.expected ?? "none"} | ` +
          arms
            .map((a) => {
              const r = a.questions[i] as QuestionResult;
              return r.expected === null ? `${r.returned.length} returned` : (r.rank ?? "—");
            })
            .join(" | ") +
          " |",
      );
    });
  }
  return lines.join("\n");
}
