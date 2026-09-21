/**
 * Retrieval-grounded clarifying-question self-resolution (Epic: clarify
 * self-resolve from knowledge).
 *
 * Before METIS asks a clarifying question, this module tries to ANSWER it from
 * the project's own ingested knowledge (code chunks + other documents) using
 * existing retrieval + the existing LLM provider. Each question is classified:
 *   - grounded: project knowledge answers it — a suggested answer + citations
 *               are attached for human confirmation (NOT silent auto-accept).
 *   - partial:  partially answered — surface what's known + still ask residual.
 *   - open:     not answerable from project knowledge — plain blank question.
 *
 * The classifier is deliberately CONSERVATIVE: offline / zero-retrieval /
 * malformed-response / any error all degrade safely to "open", and an answer is
 * NEVER returned without at least one valid citation.
 */
import type { AIProvider, ChatMessage } from "../ai/types.js";
import { HAIKU_MODEL_ID } from "../ai/model-router.js";
import { createChildLogger } from "../logger.js";
import type { ClarifyingQuestion, GroundingCitation } from "./types/requirements.js";

const log = createChildLogger("ambiguity-grounding");

/** Number of chunks to retrieve per question. */
const RETRIEVE_K = 6;
/**
 * Max number of questions grounded in parallel. Each grounding does one
 * retrieval + one LLM call; a small bounded pool turns a slow sequential pass
 * (~99s for ~28 questions in production) into ~5-wide concurrency while still
 * being gentle on the provider/retriever. Kept small and hand-rolled — no new
 * dependency.
 */
export const GROUNDING_CONCURRENCY = 5;
/** Per-snippet text truncation to bound the prompt token cost. */
const SNIPPET_MAX_CHARS = 500;

/**
 * Minimal retrieval surface this module depends on. `KnowledgeService` from
 * `../rag/knowledge-service.js` satisfies this structurally, so the call site
 * passes `getKnowledgeService()`. Kept as a narrow interface so tests can mock
 * retrieval without standing up LanceDB.
 */
export interface GroundingRetriever {
  search(
    projectId: string,
    query: string,
    opts?: { k?: number },
  ): Promise<{
    hits: Array<{
      chunkId: string;
      documentId: string;
      filename: string;
      text: string;
      score: number;
    }>;
  }>;
}

export interface AmbiguityGroundingDeps {
  provider: AIProvider;
  retriever: GroundingRetriever;
  /** Model override; defaults to Haiku (cheap, this is a pre-filter pass). */
  model?: string;
}

/** Result of grounding a single clarifying question. */
export interface GroundingResult {
  groundingStatus: "grounded" | "partial" | "open";
  groundedAnswer?: string;
  groundingCitations?: GroundingCitation[];
}

export const GROUNDING_SYSTEM_PROMPT = `You are a requirements analyst. You are given numbered snippets retrieved from a software project's own ingested knowledge (source code and documents) and a single clarifying question about an ambiguous requirement.

Decide whether the snippets ANSWER the question:
- "grounded": the snippets FULLY answer the question. Provide the answer grounded ONLY in the snippets, and list the snippet numbers you used.
- "partial": the snippets PARTIALLY answer the question. Provide what is known from the snippets, and list the snippet numbers used.
- "open": the snippets are irrelevant or do not address the question. Set "answer" to "" and "citationIndexes" to [].

Rules:
- Never invent facts beyond what the snippets state. If unsure, choose "open".
- Cite by snippet number (1-based) for every snippet you relied on.

Respond ONLY with a JSON object, no markdown fences, no commentary:
{ "status": "grounded" | "partial" | "open", "answer": string, "citationIndexes": number[] }`;

/** Truncate a snippet's text to keep prompt tokens bounded. */
function truncate(text: string): string {
  const t = text ?? "";
  return t.length <= SNIPPET_MAX_CHARS ? t : `${t.slice(0, SNIPPET_MAX_CHARS)}…`;
}

type RetrievedHit = Awaited<ReturnType<GroundingRetriever["search"]>>["hits"][number];

/** Build the chat messages for the grounding decision. */
export function buildGroundingMessages(
  question: ClarifyingQuestion,
  hits: RetrievedHit[],
): ChatMessage[] {
  const snippetBlock = hits
    .map((h, i) => `[${i + 1}] (${h.filename})\n${truncate(h.text)}`)
    .join("\n\n");

  const contextLine = question.context ? `\nContext: ${question.context}` : "";

  return [
    { role: "system", content: GROUNDING_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Clarifying question: ${question.question}${contextLine}\n\nRetrieved snippets:\n\n${snippetBlock}`,
    },
  ];
}

interface ParsedGrounding {
  status: "grounded" | "partial" | "open";
  answer: string;
  citationIndexes: number[];
}

/** Robustly parse the model's JSON decision; returns null on any failure. */
function parseGrounding(content: string): ParsedGrounding | null {
  try {
    const cleaned = content.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
    const json = JSON.parse(cleaned) as Record<string, unknown>;
    const status = json.status;
    if (status !== "grounded" && status !== "partial" && status !== "open") {
      return null;
    }
    return {
      status,
      answer: typeof json.answer === "string" ? json.answer : "",
      citationIndexes: Array.isArray(json.citationIndexes)
        ? json.citationIndexes.filter((n): n is number => typeof n === "number")
        : [],
    };
  } catch {
    return null;
  }
}

export class AmbiguityGrounding {
  private readonly provider: AIProvider;
  private readonly retriever: GroundingRetriever;
  private readonly model: string;

  constructor(deps: AmbiguityGroundingDeps) {
    this.provider = deps.provider;
    this.retriever = deps.retriever;
    this.model = deps.model ?? HAIKU_MODEL_ID;
  }

  /**
   * Ground a single clarifying question against the project's knowledge.
   * Always resolves (never throws) — degrades to "open" on any problem.
   */
  async groundQuestion(
    projectId: string,
    question: ClarifyingQuestion,
    signal?: AbortSignal,
  ): Promise<GroundingResult> {
    // 1. Offline providers cannot ground anything — no retrieval, no LLM.
    if (this.provider.offline) {
      return { groundingStatus: "open" };
    }

    try {
      // 2. Retrieve project knowledge for this question.
      const { hits } = await this.retriever.search(projectId, question.question, {
        k: RETRIEVE_K,
      });
      if (!hits || hits.length === 0) {
        return { groundingStatus: "open" };
      }

      // 3 + 4. Ask the model to decide, grounded only in the snippets.
      const messages = buildGroundingMessages(question, hits);
      const response = await this.provider.chat(messages, {
        model: this.model,
        signal,
        disableTools: true,
      });

      const parsed = parseGrounding(response.content);
      if (!parsed || parsed.status === "open") {
        return { groundingStatus: "open" };
      }

      // 5. Map 1-based citation indexes onto the retrieved hits.
      const citations: GroundingCitation[] = [];
      for (const idx of parsed.citationIndexes) {
        const hit = hits[idx - 1];
        if (!hit) continue; // ignore out-of-range indexes
        citations.push({
          source: hit.filename,
          snippet: truncate(hit.text),
          documentId: hit.documentId,
          chunkId: hit.chunkId,
          score: hit.score,
        });
      }

      // 6. Conservative guard: never an answer without a citation, never an
      //    empty answer. Either condition downgrades to "open".
      const answer = parsed.answer.trim();
      if (citations.length === 0 || answer.length === 0) {
        return { groundingStatus: "open" };
      }

      return {
        groundingStatus: parsed.status,
        groundedAnswer: answer,
        groundingCitations: citations,
      };
    } catch (err) {
      // 7. Degrade safe on any retrieval/LLM error.
      log.warn(
        "Grounding failed for question %s — treating as open: %s",
        question.id,
        (err as Error).message,
      );
      return { groundingStatus: "open" };
    }
  }

  /**
   * Ground a batch of questions, merging results back onto each question.
   *
   * Uses a hand-rolled, bounded worker pool (size GROUNDING_CONCURRENCY) over a
   * shared index queue rather than a sequential loop, because each question
   * costs one retrieval + one LLM round-trip and a fully sequential pass is the
   * dominant latency (~99s for ~28 questions in production). Chosen over a
   * chunked Promise.all so a slow question in one chunk does not stall the next
   * chunk — workers pull the next index the moment they finish.
   *
   * Guarantees:
   *   - OUTPUT ORDER matches input order (each worker writes to `enriched[i]`).
   *   - `groundQuestion` already never throws (it degrades to "open"), but each
   *     task is still wrapped so a rejected promise can never abort siblings;
   *     a failure yields `{ groundingStatus: "open" }` for that one question.
   *   - The AbortSignal is threaded through to each `groundQuestion`.
   */
  async groundQuestions(
    projectId: string,
    questions: ClarifyingQuestion[],
    signal?: AbortSignal,
  ): Promise<ClarifyingQuestion[]> {
    const enriched: ClarifyingQuestion[] = new Array(questions.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < questions.length) {
        const i = next;
        next += 1;
        const question = questions[i]!;
        let result: GroundingResult;
        try {
          result = await this.groundQuestion(projectId, question, signal);
        } catch (err) {
          // Defensive: groundQuestion already degrades safe, but never let one
          // rejected task abort its siblings.
          log.warn(
            "Grounding task threw for question %s — treating as open: %s",
            question.id,
            (err as Error).message,
          );
          result = { groundingStatus: "open" };
        }
        enriched[i] = { ...question, ...result };
      }
    };

    const poolSize = Math.min(GROUNDING_CONCURRENCY, questions.length);
    await Promise.all(Array.from({ length: poolSize }, () => worker()));
    return enriched;
  }
}
