/**
 * Grounding retrieval (Epic #204 / Issue #222).
 *
 * Bridges the synthesis call site to the two grounding sources:
 *   1. RAG chunks from the project's LanceDB index (via `KnowledgeService`), and
 *   2. Already-fetched web-research digests from `Analysis.metadata.webResearch`.
 *
 * Produces a {@link GroundingContext} with stable source ids, ready to inject
 * into the synthesis prompt. Retrieval failures are non-fatal: doc generation
 * must never break because grounding was unavailable, so this returns an empty
 * context on any error.
 */
import { isJunkSourcePath } from "@metis/shared";
import { createChildLogger } from "../../logger.js";
import { getKnowledgeService } from "../../rag/knowledge-service.js";
import { getLatestWebResearch } from "../../analysis/analysis-service.js";
import { assertEvidencePolicy, type EvidencePolicy } from "../evidence-policy.js";
import { extractRepoRelPath } from "../../rag/fused-code-context.js";
import { isInPathScope } from "../path-scope.js";
import type { SearchOptions } from "../../rag/knowledge-service.js";
import {
  buildGroundingContext,
  type GroundingContext,
  type RagChunk,
} from "./grounding-context.js";
import type { RepositoryIdentity } from "../repository-identity.js";

const log = createChildLogger("docs-gen:grounding-retrieval");

/** A KnowledgeService-like surface (the parts we use). Eases testing. */
export interface KnowledgeSearchLike {
  search(
    projectId: string,
    query: string,
    opts?: SearchOptions,
  ): Promise<{
    hits: Array<{ documentId: string; chunkId: string; filename: string; text: string }>;
  }>;
}

/** A web-research reader. Eases testing. */
export type WebResearchReader = (projectId: string) => Promise<{
  digests: import("../../analysis/types/requirements.js").EvidenceDigest[];
} | null>;

export interface BuildProjectGroundingDeps {
  knowledge?: KnowledgeSearchLike;
  readWebResearch?: WebResearchReader;
}

export interface BuildProjectGroundingInput {
  projectId: string;
  policy: EvidencePolicy;
  /** Free-text retrieval query — typically the doc title + type label. */
  query: string;
  /**
   * Max RAG chunks to retrieve. When omitted, resolves to the configured
   * default ({@link resolveGroundingK} — `DOCS_GROUNDING_K` env or 40).
   */
  k?: number;
  /** Char budget for the assembled grounding text. */
  charBudget?: number;
  /**
   * Path scope: repository-source chunks outside these repository-relative
   * prefixes are dropped. Reference documents (non-source chunks) are kept.
   */
  pathPrefixes?: readonly string[];
}

/**
 * Default number of RAG chunks to retrieve for grounding (Issue #264; raised
 * 40→60 to lift per-section retrieval RECALL).
 *
 * The `risk` SAS corpus is embedded with the hash embedder, so dense similarity
 * is weak and BM25 lexical carries recall; paraphrased business-language claims
 * (e.g. "manager approval required") miss the raw-SAS-token chunk that supports
 * them when only 40 chunks are judged. The supporting chunk frequently EXISTS in
 * the corpus but fell outside the per-section retrieved set — a retrieval-miss,
 * not a hallucination. Judging more chunks puts more of those genuine supporting
 * chunks in front of the faithfulness judge so code-derived claims clear the bar.
 */
export const DEFAULT_GROUNDING_K = 80;
/** Clamp bounds for {@link resolveGroundingK} — guards a typo'd env value. */
export const MIN_GROUNDING_K = 1;
/**
 * Upper clamp for `k`. Kept in lock-step with the real backend cap:
 * `KnowledgeService.search` re-clamps `k` to `MAX_SEARCH_K` (80), so advertising
 * anything higher here would be misleading — a larger value silently retrieves
 * at most `MAX_SEARCH_K`. When raising this, raise the backend clamp too.
 */
export const MAX_GROUNDING_K = 80;

/**
 * Resolve the grounding retrieval `k` (chunks per query): an explicit value
 * wins, else the `DOCS_GROUNDING_K` env override, else {@link DEFAULT_GROUNDING_K}.
 * The result is always clamped to `[MIN_GROUNDING_K, MAX_GROUNDING_K]` so a
 * misconfigured env can neither retrieve zero sources nor blow the char budget.
 *
 * Issue #264: the old hardcoded `k=12` left broad narrative sections (e.g.
 * "Overview & Domain") unable to resolve their claims against a tiny retrieved
 * set, marking the whole doc `degraded`. Raising the default and exposing the
 * env knob is the second leverage point in the fix.
 */
export function resolveGroundingK(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return clampGroundingK(explicit);
  }
  return clampGroundingK(parseIntEnv("DOCS_GROUNDING_K", DEFAULT_GROUNDING_K));
}

function clampGroundingK(n: number): number {
  if (n < MIN_GROUNDING_K) return MIN_GROUNDING_K;
  if (n > MAX_GROUNDING_K) return MAX_GROUNDING_K;
  return Math.floor(n);
}

/** Mirror of the project's `parseIntEnv` helper (knowledge-service.ts:953). */
function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Retrieve and assemble the grounding context for a project's doc synthesis.
 * Both sources are best-effort; either may be empty.
 */
export async function buildProjectGroundingContext(
  input: BuildProjectGroundingInput,
  deps: BuildProjectGroundingDeps = {},
): Promise<GroundingContext> {
  assertEvidencePolicy(input.policy, input.projectId);
  const knowledge = deps.knowledge ?? getKnowledgeService();
  const readWebResearch = deps.readWebResearch ?? getLatestWebResearch;

  const ragChunks = await retrieveRagChunks(knowledge, input);
  const webDigests = input.policy.allowWebResearch
    ? await retrieveWebDigests(readWebResearch, input.projectId)
    : [];

  const ctx = buildGroundingContext({
    ragChunks,
    webDigests,
    charBudget: input.charBudget,
  });

  log.info("Assembled grounding context", {
    projectId: input.projectId,
    ragChunks: ragChunks.length,
    webDigests: webDigests.length,
    sources: ctx.sources.length,
  });

  return ctx;
}

/** A single section's retrieval request for per-section grounding (#264). */
export interface SectionGroundingRequest {
  /** Stable section id (for de-dupe / logging). */
  id: string;
  /**
   * Section-topic retrieval query (e.g. the section label + keywords, optionally
   * + the doc title). This is the core of the #264 fix: each section is grounded
   * against sources retrieved for ITS topic, not one doc-level title query.
   */
  query: string;
}

/**
 * A per-section grounding retriever (#264). Given a section request, returns a
 * {@link GroundingContext} scoped to that section's topic. Returns `undefined`
 * to signal "no section-specific grounding — fall back to the doc-level set",
 * which keeps the existing single-retrieval path working for callers/tests that
 * don't opt in.
 */
export type SectionGroundingRetriever = (
  req: SectionGroundingRequest,
) => Promise<GroundingContext | undefined>;

/**
 * Build a per-section grounding retriever for a project (#264).
 *
 * Web-research digests are doc-level, so they are fetched ONCE here and merged
 * into every section's context; only the RAG retrieval is re-issued per section
 * using that section's topic query. Each section's context independently honors
 * `charBudget` (default 60K) so prompt size stays bounded per section.
 *
 * Retrieval failures are non-fatal (same contract as
 * {@link buildProjectGroundingContext}): a section that fails to retrieve grounds
 * against whatever it could assemble (possibly just the shared web digests, or
 * an empty context), never crashing synthesis.
 */
export function buildSectionGroundingRetriever(
  input: Omit<BuildProjectGroundingInput, "query">,
  deps: BuildProjectGroundingDeps = {},
): SectionGroundingRetriever {
  assertEvidencePolicy(input.policy, input.projectId);
  const knowledge = deps.knowledge ?? getKnowledgeService();
  const readWebResearch = deps.readWebResearch ?? getLatestWebResearch;
  const k = resolveGroundingK(input.k);

  // Fetch doc-level web digests once and reuse across sections.
  let webDigestsPromise: Promise<
    import("../../analysis/types/requirements.js").EvidenceDigest[]
  > | null = null;
  const webDigests = (): Promise<
    import("../../analysis/types/requirements.js").EvidenceDigest[]
  > => {
    if (!webDigestsPromise) {
      webDigestsPromise = input.policy.allowWebResearch
        ? retrieveWebDigests(readWebResearch, input.projectId)
        : Promise.resolve([]);
    }
    return webDigestsPromise;
  };

  return async (req: SectionGroundingRequest): Promise<GroundingContext | undefined> => {
    const ragChunks = await retrieveRagChunks(knowledge, {
      projectId: input.projectId,
      query: req.query,
      policy: input.policy,
      k,
      ...(input.pathPrefixes ? { pathPrefixes: input.pathPrefixes } : {}),
    });
    const digests = await webDigests();
    const ctx = buildGroundingContext({
      ragChunks,
      webDigests: digests,
      charBudget: input.charBudget,
    });
    log.info("Assembled per-section grounding context", {
      projectId: input.projectId,
      section: req.id,
      ragChunks: ragChunks.length,
      webDigests: digests.length,
      sources: ctx.sources.length,
    });
    return ctx;
  };
}

async function retrieveRagChunks(
  knowledge: KnowledgeSearchLike,
  input: BuildProjectGroundingInput,
): Promise<RagChunk[]> {
  if (!input.query.trim()) return [];
  try {
    const result = await knowledge.search(input.projectId, input.query, {
      k: resolveGroundingK(input.k),
      actor: input.policy.actor,
      evidencePolicy: input.policy,
    });
    const scope = input.pathPrefixes;
    return result.hits
      .filter((h) => !isJunkSourcePath(h.filename))
      .filter((h) => {
        if (!scope) return true;
        const rel = extractRepoRelPath(h.filename);
        return rel === null || isInPathScope(rel, scope);
      })
      .map((h) => ({
        documentId: h.documentId,
        chunkId: h.chunkId,
        filename: h.filename,
        text: h.text,
        evidenceClass: h.filename.startsWith("connector:repo:")
          ? ("repository-source" as const)
          : ("project-reference" as const),
        ...resolveRepositoryIdentity(h.filename, input.policy),
      }));
  } catch {
    log.warn("RAG retrieval for grounding failed (continuing ungrounded)", {
      projectId: input.projectId,
      // Do not log backend error payloads: they may contain restricted text.
    });
    return [];
  }
}

function resolveRepositoryIdentity(
  filename: string,
  policy: EvidencePolicy,
): { repository?: RepositoryIdentity } {
  const repoPrefix = "connector:repo:";
  if (!filename.startsWith(repoPrefix)) return {};
  const repoConnectorId = filename.slice(repoPrefix.length).split(":")[0] ?? "";
  if (!repoConnectorId) return {};
  if (policy.repoConnectorId && repoConnectorId !== policy.repoConnectorId) return {};
  if (!policy.codeGraphId) return {};
  return {
    repository: {
      repoConnectorId,
      codeGraphId: policy.codeGraphId,
    },
  };
}

async function retrieveWebDigests(
  readWebResearch: WebResearchReader,
  projectId: string,
): Promise<import("../../analysis/types/requirements.js").EvidenceDigest[]> {
  try {
    const research = await readWebResearch(projectId);
    return research?.digests ?? [];
  } catch {
    log.warn("Web-research read for grounding failed (continuing without it)", {
      projectId,
    });
    return [];
  }
}
