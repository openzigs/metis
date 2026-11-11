/**
 * #2229 — the three ways of reading a business document that
 * `pnpm eval:doc-understanding` compares. Every arm turns one document into
 * the requirements it found and the questions it would ask the author
 * ({@link ArmOutput}); the judge and scorer read nothing else.
 *
 *   - **A — today's Requirements Analysis.** The document is chunked by
 *     production's chunker and served the way an analysis serves the document
 *     specialist now: production's multi-query retrieval and fusion
 *     (`buildRetrievalQueries` + `runGroundedRetrieval`, k =
 *     `ANALYSIS_RETRIEVE_K`, `orchestrator.ts` `retrieveContext`), then
 *     production's `runAgent("document")`. The requirements and questions are
 *     what the enhancement pipeline makes of that (`runEnhancementPipeline`):
 *     `RequirementsExtractor` over the agent's extracted requirement texts, or
 *     over its findings when it extracted none. Those structured requirements
 *     are the ones the analyst approves, and their ambiguities' suggested
 *     questions are the clarifying questions the analyst is asked.
 *   - **B — the whole document in one call,** listing every requirement and
 *     question with a verbatim quote.
 *   - **C — section by section:** one call over the whole document for a
 *     summary, glossary and actors; one call per section (production's
 *     `splitSections`, the governing rule reader's) with that context; then
 *     one reduce call that drops repeated requirements and settles the
 *     question list, adding cross-section conflicts.
 *
 * Retrieval is lexical (production's BM25 options over the committed text), so
 * every arm runs offline apart from its model calls. Production's search is
 * hybrid and always fills k; BM25 alone can return fewer chunks, so arm A's
 * hits are padded to k with the unmatched chunks in document order. That
 * gives A at least the reading production would (k chunks), so a gain measured
 * for B or C is not an artefact of A reading less.
 */
import { ANALYSIS_RETRIEVE_K, type RetrievedChunk } from "@metis/shared";
import type { AIProvider } from "../../ai/types.js";
import {
  resolveFinalAnswerMaxOutputTokens,
  runAgent,
  type RetrievalContextChunk,
} from "../../analysis/agent-runner.js";
import { RequirementsExtractor } from "../../analysis/requirements-extractor.js";
import {
  buildRetrievalQueries,
  runGroundedRetrieval,
  type GroundedSearchSource,
} from "../../analysis/retrieval.js";
import { hasVerdict, requestStructuredVerdict } from "../../analysis/structured-verdict.js";
import { createInMemoryBM25 } from "../../rag/bm25-index.js";
import { chunkMarkdown } from "../../rag/chunker.js";
import type { DocUnderstandingItem } from "./corpus.js";
import {
  DOCUMENT_CONTEXT_SHAPE,
  READER_REPLY_SHAPE,
  REDUCE_REPLY_SHAPE,
  buildDocumentContextPrompt,
  buildReducePrompt,
  buildSectionPrompt,
  buildWholeDocumentPrompt,
  documentContextSchema,
  readerReplySchema,
  reduceReplySchema,
  type ReaderReply,
} from "./prompts.js";

/** One requirement an arm found. `quote` and `section` are absent where the arm gives none. */
export interface ExtractedRequirement {
  text: string;
  section?: string;
  quote?: string;
}

/** One question an arm would put to the document's author. */
export interface RaisedQuestion {
  text: string;
  section?: string;
  quote?: string;
}

export interface ArmOutput {
  requirements: ExtractedRequirement[];
  questions: RaisedQuestion[];
  /** Counts that explain the output (chunks retrieved, sections read, calls made). */
  diagnostics: Record<string, number>;
}

export interface ReadContext {
  provider: AIProvider;
  /** Calls arm C may have in flight at once. */
  concurrency: number;
}

export const DOC_ARM_IDS = ["A", "B", "C"] as const;
export type DocArmId = (typeof DOC_ARM_IDS)[number];

export interface DocArm {
  id: DocArmId;
  label: string;
  configuration: Record<string, string | number | boolean>;
  read(item: DocUnderstandingItem, ctx: ReadContext): Promise<ArmOutput>;
}

/** A reader call that gave no usable reply. Its message is METIS's own, so safe to log. */
export class ReaderReplyError extends Error {
  override name = "ReaderReplyError";
}

/** The synthetic document id the document is served under. */
export function documentIdOf(item: Pick<DocUnderstandingItem, "name">): string {
  return `${item.name}:source.docx`;
}

// ── A ────────────────────────────────────────────────────────────────────────

/**
 * The document as document-RAG holds it: production's chunker over the
 * converted text, ranked by production's BM25 options, behind the one method
 * `runGroundedRetrieval` reads.
 */
export function documentKnowledge(item: Pick<DocUnderstandingItem, "name" | "text">): {
  source: GroundedSearchSource;
  chunks: number;
} {
  const documentId = documentIdOf(item);
  const chunks = chunkMarkdown(item.text);
  const byId = new Map(chunks.map((c) => [`${documentId}#${c.position}`, c]));
  const index = createInMemoryBM25(
    chunks.map((c) => ({
      id: `${documentId}#${c.position}`,
      documentId,
      position: c.position,
      text: c.text,
      filename: "source.docx",
    })),
  );
  return {
    chunks: chunks.length,
    source: {
      async search(_projectId, query, opts = {}) {
        const k = opts.k ?? ANALYSIS_RETRIEVE_K;
        const ranked = index.search(query, k).map((h) => ({ id: h.chunkId, score: h.score }));
        // A vector searcher always returns k neighbours; BM25 returns only the
        // chunks sharing a query term. Pad with the rest in document order, so
        // arm A reads as many chunks as production's hybrid search would give it.
        const taken = new Set(ranked.map((r) => r.id));
        for (const id of byId.keys()) {
          if (ranked.length >= k) break;
          if (!taken.has(id)) ranked.push({ id, score: 0 });
        }
        const hits = ranked.map(({ id, score }): RetrievedChunk => {
          const c = byId.get(id)!;
          return {
            chunkId: id,
            documentId,
            filename: "source.docx",
            position: c.position,
            text: c.text,
            score,
            embeddingModel: "none (lexical only)",
            source: "upload",
          };
        });
        return { hits };
      },
    },
  };
}

/** Characters of `text` the retrieved chunks cover (overlap counted once). */
export function charsCovered(text: string, chunks: readonly RetrievalContextChunk[]): number {
  const covered = new Uint8Array(text.length);
  for (const c of chunks) {
    const at = text.indexOf(c.text);
    if (at === -1) continue;
    covered.fill(1, at, at + c.text.length);
  }
  return covered.reduce((n, v) => n + v, 0);
}

export function createArmA(model: string): DocArm {
  return {
    id: "A",
    label: "A — today's document agent over 10 retrieved chunks, then structured extraction",
    configuration: {
      conversion: "parseDocument (mammoth + htmlToMarkdown)",
      chunker: "chunkMarkdown (rag/chunker.ts), default options",
      retrieval:
        "buildRetrievalQueries(document) + runGroundedRetrieval (RRF), document title as the project name",
      searcher:
        "production BM25 options (createInMemoryBM25), no vectors; padded to k with unmatched chunks in document order",
      k: ANALYSIS_RETRIEVE_K,
      rerank: false,
      agent: "runAgent document (analysis/agent-runner.ts)",
      requirements:
        "RequirementsExtractor over the agent's requirement texts, else its findings (runEnhancementPipeline)",
      questions: "the extracted requirements' ambiguities, suggestedQuestion",
      model,
    },
    async read(item, { provider }) {
      const { source, chunks } = documentKnowledge(item);
      const retrieved = await runGroundedRetrieval(source, {
        projectId: item.name,
        queries: buildRetrievalQueries({
          agentKey: "document",
          projectName: item.title,
          projectDescription: "",
          extraInstructions: "",
        }),
        documentIds: [documentIdOf(item)],
        k: ANALYSIS_RETRIEVE_K,
        rerank: false,
      });
      const agent = await runAgent(provider, {
        agentKey: "document",
        projectName: item.title,
        projectDescription: "",
        retrieved,
      });
      const agentRequirements =
        "requirements" in agent.output && Array.isArray(agent.output.requirements)
          ? (agent.output.requirements as Array<{ text: string }>)
          : [];
      // As `runEnhancementPipeline` seeds the extractor: requirement texts,
      // else the document agent's finding titles and bodies.
      let seed = agentRequirements.map((r) => r.text).filter((t) => t.trim().length > 0);
      if (seed.length === 0) {
        seed = agent.output.findings
          .map((f) => [f.title, f.body].filter(Boolean).join(". "))
          .filter((t) => t.trim().length > 0);
      }
      const structured = await new RequirementsExtractor({ provider }).extract(seed.join("\n\n"));
      return {
        requirements: structured.requirements.map((r) => ({
          text: [r.title, r.description].filter(Boolean).join(": "),
        })),
        questions: structured.requirements.flatMap((r) =>
          r.ambiguities
            .map((a) => a.suggestedQuestion.trim())
            .filter(Boolean)
            .map((text) => ({ text })),
        ),
        diagnostics: {
          documentChunks: chunks,
          retrievedChunks: retrieved.length,
          documentChars: item.text.length,
          retrievedChars: charsCovered(item.text, retrieved),
          agentRequirements: agentRequirements.length,
          agentFindings: agent.output.findings.length,
          calls: 2,
        },
      };
    },
  };
}

// ── B and C ─────────────────────────────────────────────────────────────────

async function askReader<T>(
  provider: AIProvider,
  label: string,
  prompt: { systemMessage: string; userMessage: string },
  schema: Parameters<typeof requestStructuredVerdict<T>>[1]["schema"],
  expectedShape: string,
): Promise<T> {
  const outcome = await requestStructuredVerdict(provider, {
    label,
    schema,
    schemaName: label,
    expectedShape,
    systemMessage: prompt.systemMessage,
    messages: [{ role: "user", content: prompt.userMessage }],
    disableTools: true,
    maxTokens: resolveFinalAnswerMaxOutputTokens(provider.model, provider.key),
  });
  if (!hasVerdict(outcome)) {
    throw new ReaderReplyError(`${label}: no usable reply (${outcome.reason})`);
  }
  return outcome.verdict;
}

function fromReply(reply: ReaderReply): Pick<ArmOutput, "requirements" | "questions"> {
  return {
    requirements: reply.requirements.map((r) => ({
      text: r.statement,
      section: r.section,
      quote: r.quote,
    })),
    questions: reply.questions.map((q) => ({
      text: q.question,
      section: q.section,
      quote: q.quote,
    })),
  };
}

export function createArmB(model: string): DocArm {
  return {
    id: "B",
    label: "B — the whole document in one call",
    configuration: {
      conversion: "parseDocument (mammoth + htmlToMarkdown)",
      context: "the whole converted document, fenced",
      calls: "1 (plus one re-prompt on an unreadable reply)",
      model,
    },
    async read(item, { provider }) {
      const reply = await askReader<ReaderReply>(
        provider,
        "doc-understanding-whole",
        buildWholeDocumentPrompt({ title: item.title, text: item.text }),
        readerReplySchema,
        READER_REPLY_SHAPE,
      );
      return { ...fromReply(reply), diagnostics: { documentChars: item.text.length, calls: 1 } };
    },
  };
}

/** `fn` over `items` with at most `limit` in flight, results in input order. */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export function createArmC(model: string): DocArm {
  return {
    id: "C",
    label: "C — section by section with a document summary, glossary and actors, then a reduce",
    configuration: {
      conversion: "parseDocument (mammoth + htmlToMarkdown)",
      context: "one call over the whole document: summary, glossary, actors",
      sections: "splitSections (governing/rule-extraction.ts): every heading, long sections split",
      reduce: "one call: drop repeated requirements, settle and add cross-section questions",
      model,
    },
    async read(item, { provider, concurrency }) {
      const context = await askReader(
        provider,
        "doc-understanding-context",
        buildDocumentContextPrompt({ title: item.title, text: item.text }),
        documentContextSchema,
        DOCUMENT_CONTEXT_SHAPE,
      );
      const replies = await mapLimited(item.sections, concurrency, (section) =>
        askReader<ReaderReply>(
          provider,
          "doc-understanding-section",
          buildSectionPrompt({
            title: item.title,
            heading: section.heading,
            sectionText: section.text,
            context,
          }),
          readerReplySchema,
          READER_REPLY_SHAPE,
        ),
      );
      const found = replies.flatMap((r, s) =>
        fromReply(r).requirements.map((req) => ({
          ...req,
          section: req.section || item.sections[s]!.heading,
        })),
      );
      const asked = replies.flatMap((r, s) =>
        fromReply(r).questions.map((q) => ({
          ...q,
          section: q.section || item.sections[s]!.heading,
        })),
      );
      const reduced = await askReader(
        provider,
        "doc-understanding-reduce",
        buildReducePrompt({
          title: item.title,
          context,
          requirements: found.map((r, i) => ({
            id: `F${i + 1}`,
            statement: r.text,
            section: r.section,
          })),
          questions: asked.map((q, i) => ({
            id: `Q${i + 1}`,
            question: q.text,
            section: q.section,
            quote: q.quote ?? "",
          })),
        }),
        reduceReplySchema,
        REDUCE_REPLY_SHAPE,
      );
      const dropped = new Set(reduced.duplicateRequirements.map((id) => id.trim()));
      return {
        requirements: found.filter((_r, i) => !dropped.has(`F${i + 1}`)),
        questions: reduced.questions.map((q) => ({
          text: q.question,
          section: q.section,
          quote: q.quote,
        })),
        diagnostics: {
          documentChars: item.text.length,
          sections: item.sections.length,
          sectionRequirements: found.length,
          sectionQuestions: asked.length,
          droppedAsRepeated:
            found.length - found.filter((_r, i) => !dropped.has(`F${i + 1}`)).length,
          calls: item.sections.length + 2,
        },
      };
    },
  };
}

const FACTORIES: Record<DocArmId, (model: string) => DocArm> = {
  A: createArmA,
  B: createArmB,
  C: createArmC,
};

export function parseDocArmIds(raw: string | undefined): DocArmId[] {
  const ids = (raw ?? DOC_ARM_IDS.join(","))
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const bad = ids.filter((id) => !(DOC_ARM_IDS as readonly string[]).includes(id));
  if (bad.length > 0) {
    throw new Error(`unknown arm(s) ${bad.join(", ")}; known: ${DOC_ARM_IDS.join(", ")}`);
  }
  if (ids.length === 0) throw new Error("name at least one arm");
  return [...new Set(ids)] as DocArmId[];
}

export function buildDocArms(ids: readonly DocArmId[], model: string): DocArm[] {
  return ids.map((id) => FACTORIES[id](model));
}
