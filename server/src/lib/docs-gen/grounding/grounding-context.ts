/**
 * Grounding context for holistic synthesis (Epic #204 / Issue #222).
 *
 * Generation was previously ungrounded: the holistic synthesizer trusted the
 * LLM's parametric knowledge with no retrieved evidence in the prompt, and the
 * already-fetched web research (`Analysis.metadata.webResearch`) was never
 * injected. This module assembles the two grounding sources into a single,
 * deterministically-ordered context with STABLE source IDs so that:
 *
 *   1. The synthesis prompt can quote/cite real retrieved evidence, and
 *   2. Downstream claim-level citation validation (#223/#224) can resolve every
 *      emitted `sourceId` back to a concrete retrieved chunk or digest.
 *
 * Source ID scheme:
 *   - RAG chunk     → `rag:<documentId>:<chunkId>`         (globally unique)
 *   - Web digest    → `web:<digestId>`                     (globally unique)
 *   - Repository fact → `facts:repo:<encoded [connector,graph,path]>:<idx>` (#1354).
 *   - Legacy fact → `facts:<sanitisedModuleDir>:<idx>` (#267); `idx` is the
 *     module's rank in this section's relevance-sorted selection, so the id is
 *     stable within a section run but two distinct module dirs CAN sanitise to
 *     the same id — collisions are resolved first-wins / drop-duplicate (see
 *     {@link factsSourceId}).
 *
 * The `(documentId, chunkId)` pair is the LanceDB `VectorMetadata` identity
 * (`vector-store.ts:28-36`); the digest id is the `EvidenceDigest.id` produced
 * by the `WebResearchAugmenter`.
 */
import type { VectorMetadata } from "../../rag/vector-store.js";
import type { EvidenceDigest } from "../../analysis/types/requirements.js";
import { repositoryPathIdentity, type RepositoryIdentity } from "../repository-identity.js";

/** A single retrieved RAG chunk used as grounding evidence. */
export interface RagChunk {
  documentId: string;
  evidenceClass?: "repository-source" | "project-reference";
  chunkId: string;
  repository?: RepositoryIdentity;
  /** Source filename (for display + provenance). */
  filename?: string;
  /** The chunk text the model may quote/cite. */
  text: string;
}

/** Kind discriminator for a grounding source. */
export type GroundingSourceKind = "rag" | "web" | "facts";

/**
 * A synthesis-fact grounding source (#267). The doc is synthesized from
 * per-module code-graph facts (`extractModuleFacts`), but the citation validator
 * could previously only resolve `rag:`/`web:` ids — so claims derived from the
 * facts had nothing to cite and were flagged ungrounded. Admitting the facts as
 * first-class citable sources closes that gap.
 */
export interface FactsSourceInput {
  /** Graph/connector identity is required on facts emitted by holistic synthesis. */
  repository?: RepositoryIdentity;
  /** Source module directory (used to build the stable id + default label). */
  moduleDir: string;
  /**
   * Rank of this module within the section's relevance-sorted selection (one
   * `FactsSourceInput` per selected module — NOT a per-fact-within-module index).
   * It is the 0-based position the module landed at in `selectRelevantFacts`'s
   * ordered output. The resulting id (`facts:<sanitisedModuleDir>:<idx>`) is
   * therefore stable only while that selection ordering is stable, and the same
   * module can be assigned a DIFFERENT idx in a different section (each section
   * runs its own selection). Within a single section run this is exactly the
   * rank used to build the facts blob the model reads, so blob and citable id
   * stay in lock-step.
   */
  idx: number;
  /** Short human label (module name). */
  label?: string;
  /** The ACTUAL fact text a claim could cite — not just a label. */
  text: string;
}

/**
 * A normalised grounding source with a STABLE id. Every claim emitted by the
 * synthesizer must cite one or more of these ids; the citation validator
 * (#224) resolves citations against the set of ids assembled here.
 */
export interface GroundingSource {
  repository?: RepositoryIdentity;
  /** Explicitly distinguish scoped source evidence from allowed shared context. */
  evidenceClass?: "repository-source" | "project-reference" | "web-reference";
  /**
   * Stable id: `rag:<documentId>:<chunkId>`, `web:<digestId>`, or
   * `facts:<sanitisedModuleDir>:<idx>` where `idx` is the module's rank in the
   * section's relevance-sorted selection (see {@link FactsSourceInput.idx}). RAG
   * and web ids are globally collision-free; facts ids are unique within a single
   * section run but two distinct module dirs CAN sanitise to the same id (see
   * {@link factsSourceId}).
   */
  sourceId: string;
  kind: GroundingSourceKind;
  /** Short human label (filename for RAG, query/host for web, module for facts). */
  label: string;
  /** The grounding text the model may quote. */
  text: string;
  /** Original RAG identity, present only for `kind === "rag"`. */
  documentId?: string;
  chunkId?: string;
}

/** Assembled grounding context handed to the synthesizer. */
export interface GroundingContext {
  sources: GroundingSource[];
  /** Quick membership lookup for citation validation. */
  sourceIds: Set<string>;
  /** True when there is no grounding evidence at all. */
  isEmpty: boolean;
}

export interface BuildGroundingContextInput {
  /**
   * Synthesis facts (#267). Admitted FIRST (before rag/web) so they are not
   * budget-starved — they are the closest evidence to the synthesized claims.
   */
  factsSources?: FactsSourceInput[];
  ragChunks?: RagChunk[];
  webDigests?: EvidenceDigest[];
  /** Hard cap on total characters of grounding text (default 60K). */
  charBudget?: number;
}

/** Build the stable source id for a RAG chunk. */
export function ragSourceId(documentId: string, chunkId: string): string {
  return `rag:${documentId}:${chunkId}`;
}

/** Build the stable source id for a web-research digest. */
export function webSourceId(digestId: string): string {
  return `web:${digestId}`;
}

/**
 * Build the source id for a synthesis fact (#267). The module dir is sanitised
 * so the id stays parseable under the `kind:rest` grammar: any char that is not
 * a letter, digit, `.`, or `-` (`/` included, which would be ambiguous) is
 * collapsed to `_`. `idx` is the module's rank within the section's
 * relevance-sorted selection (see {@link FactsSourceInput.idx}).
 *
 * Repository-backed facts use a reversible tuple encoding instead; the legacy
 * sanitiser below remains only for callers without repository provenance.
 * COLLISION CAVEAT: because the legacy sanitiser is lossy, two DISTINCT module dirs can
 * map to the same sanitised string (e.g. `a/b` and `a:b` → `a_b`) and, if they
 * land at the same selection rank, produce an identical id. The admit loops in
 * {@link buildGroundingContext} / {@link mergeFactsIntoContext} resolve this
 * "first wins / drop duplicate": the first source admitted under an id is kept
 * and the later colliding source is silently dropped (NOT cross-attributed to
 * the first). A dropped module's claims simply fall back to other citable
 * sources or are flagged ungrounded — never mis-cited.
 */
export function factsSourceId(
  moduleDir: string,
  idx: number,
  repository?: RepositoryIdentity,
): string {
  if (repository) return `facts:${repositoryPathIdentity(repository, moduleDir)}:${idx}`;
  const sanitised = moduleDir.replace(/[^A-Za-z0-9.-]+/g, "_").replace(/^_+|_+$/g, "");
  return `facts:${sanitised || "module"}:${idx}`;
}

/**
 * Normalise a RAG `VectorMetadata` row into a {@link RagChunk}. Convenience for
 * callers that already have search hits in hand.
 */
export function ragChunkFromMetadata(meta: VectorMetadata): RagChunk {
  return {
    documentId: meta.documentId,
    chunkId: meta.chunkId,
    filename: meta.filename,
    text: meta.text,
  };
}

const DEFAULT_CHAR_BUDGET = 60_000;

/**
 * Assemble synthesis facts, RAG chunks, and web-research digests into a single
 * grounding context with stable ids.
 *
 * Ordering (#267): FACTS first, then RAG, then WEB. Rationale — the document is
 * synthesized FROM the per-module facts, so a synthesized claim is most likely
 * to be supported by a fact; admitting facts first guarantees they are not
 * budget-starved by a large RAG set. Web (external) evidence stays last.
 *
 * Empty/whitespace-only sources are dropped. Duplicate source ids are
 * de-duplicated (first occurrence wins). Sources are admitted up to `charBudget`
 * so a huge retrieval set can't blow the synthesis prompt.
 */
export function buildGroundingContext(input: BuildGroundingContextInput): GroundingContext {
  const charBudget =
    input.charBudget && input.charBudget > 0 ? input.charBudget : DEFAULT_CHAR_BUDGET;
  const sources: GroundingSource[] = [];
  const sourceIds = new Set<string>();
  let usedChars = 0;

  const admit = (s: GroundingSource): void => {
    const text = s.text.trim();
    if (!text) return;
    if (sourceIds.has(s.sourceId)) return;
    if (usedChars + text.length > charBudget && sources.length > 0) return;
    sourceIds.add(s.sourceId);
    sources.push({ ...s, text });
    usedChars += text.length;
  };

  // Facts FIRST — closest to the synthesized claims; must not be budget-starved.
  for (const f of input.factsSources ?? []) {
    admit({
      sourceId: factsSourceId(f.moduleDir, f.idx, f.repository),
      ...(f.repository
        ? { repository: f.repository, evidenceClass: "repository-source" as const }
        : {}),
      kind: "facts",
      label: f.label?.trim() || f.moduleDir,
      text: f.text ?? "",
    });
  }

  for (const chunk of input.ragChunks ?? []) {
    if (!chunk.documentId || !chunk.chunkId) continue;
    admit({
      sourceId: ragSourceId(chunk.documentId, chunk.chunkId),
      kind: "rag",
      label: chunk.filename?.trim() || `${chunk.documentId}/${chunk.chunkId}`,
      text: chunk.text ?? "",
      documentId: chunk.documentId,
      chunkId: chunk.chunkId,
      ...(chunk.evidenceClass ? { evidenceClass: chunk.evidenceClass } : {}),
      ...(chunk.repository ? { repository: chunk.repository } : {}),
    });
  }

  for (const digest of input.webDigests ?? []) {
    if (!digest.id) continue;
    const host = firstSourceHost(digest);
    admit({
      sourceId: webSourceId(digest.id),
      kind: "web",
      evidenceClass: "web-reference",
      label: host ? `web:${host}` : `web:${digest.query?.slice(0, 40) ?? digest.id}`,
      text: digest.digest ?? "",
    });
  }

  return { sources, sourceIds, isEmpty: sources.length === 0 };
}

/**
 * Merge synthesis facts (#267) into an existing grounding context WITHOUT
 * mutating it. Facts are placed FIRST (same rationale as
 * {@link buildGroundingContext}), then the base context's existing sources.
 * Returns the original context unchanged when there are no facts to add
 * (back-compat: no facts → identical behaviour).
 *
 * Used by the per-section synthesis loop to admit THAT section's selected module
 * facts into the SAME context the section is generated from AND validated
 * against, so claims derived from the facts can resolve.
 *
 * BUDGET SEMANTICS (the fix for the >60K Bedrock regression):
 *   - `charBudget` caps ONLY the facts admitted here. The caller MUST pass the
 *     same facts budget (`factsCharCap`) it used to build the facts BLOB the
 *     model reads, so every facts module the model saw is also citable. (The
 *     old default-60K fallback silently dropped the >60K Bedrock tail from the
 *     citable set while keeping it in the blob → fact-derived claims past 60K
 *     could not cite → stripped → section `degraded`. That regression is gone.)
 *   - The base context's existing sources (RAG/web/facts) are ALWAYS re-admitted
 *     with NO additional budget gating. They were already bounded by the
 *     base-context budget when they were first assembled
 *     ({@link buildGroundingContext}), so re-admitting them all cannot grow the
 *     prompt beyond that prior allocation — and, crucially, a large facts set can
 *     NO LONGER evict RAG/web. Every source citable before this merge stays
 *     citable (no regression), and facts only ADD to the citable set.
 *
 * Net guarantee: (a) all facts the model saw in the blob (≤ `charBudget`) are
 * citable, AND (b) every RAG/web/base-facts source citable before the merge
 * remains citable.
 */
export function mergeFactsIntoContext(
  base: GroundingContext | undefined,
  factsSources: FactsSourceInput[],
  charBudget?: number,
): GroundingContext {
  if (factsSources.length === 0) return base ?? buildGroundingContext({});

  const factsBudget = charBudget && charBudget > 0 ? charBudget : DEFAULT_CHAR_BUDGET;
  const sources: GroundingSource[] = [];
  const sourceIds = new Set<string>();
  let factsChars = 0;

  // Facts FIRST, capped by the facts budget so the citable set matches the blob.
  const admitFact = (s: GroundingSource): void => {
    const text = s.text.trim();
    if (!text) return;
    if (sourceIds.has(s.sourceId)) return; // first-wins / drop-duplicate on id collision
    if (factsChars + text.length > factsBudget && sources.length > 0) return;
    sourceIds.add(s.sourceId);
    sources.push({ ...s, text });
    factsChars += text.length;
  };
  for (const f of factsSources) {
    admitFact({
      sourceId: factsSourceId(f.moduleDir, f.idx, f.repository),
      ...(f.repository
        ? { repository: f.repository, evidenceClass: "repository-source" as const }
        : {}),
      kind: "facts",
      label: f.label?.trim() || f.moduleDir,
      text: f.text ?? "",
    });
  }

  // Base sources ALWAYS preserved — already budget-bounded upstream, so facts can
  // never starve them. De-dup only (a base id could already be a facts id).
  for (const s of base?.sources ?? []) {
    const text = s.text.trim();
    if (!text) continue;
    if (sourceIds.has(s.sourceId)) continue;
    sourceIds.add(s.sourceId);
    sources.push({ ...s, text });
  }

  return { sources, sourceIds, isEmpty: sources.length === 0 };
}

/** Best-effort hostname of a digest's first source, for a compact label. */
function firstSourceHost(digest: EvidenceDigest): string | undefined {
  const url = digest.sources?.[0]?.url;
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Render the grounding context as a prompt block. Each source is delimited and
 * labelled with its stable id so the model can cite ids verbatim. Returns an
 * empty string when there is no grounding evidence (the caller can then skip
 * the block entirely).
 */
export function renderGroundingBlock(ctx: GroundingContext): string {
  if (ctx.isEmpty) return "";
  const parts = ctx.sources.map((s) => {
    return `[SOURCE id=${s.sourceId} kind=${s.kind} label=${JSON.stringify(s.label)}]\n${s.text}`;
  });
  return [
    "=== RETRIEVED GROUNDING SOURCES ===",
    "Every factual claim you write MUST be grounded in one or more of the",
    "sources below and cite their `id` value(s). Do NOT invent source ids.",
    "",
    parts.join("\n\n---\n\n"),
    "",
    "=== END GROUNDING SOURCES ===",
  ].join("\n");
}
