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
import { scrubWriterFenceLookalikes } from "../../ai/tool-runtime/fence-scrub.js";
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
  return `facts:${sanitiseModuleDir(moduleDir)}:${idx}`;
}

function sanitiseModuleDir(moduleDir: string): string {
  const sanitised = moduleDir.replace(/[^A-Za-z0-9.-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitised || "module";
}

/**
 * #1356 — the id of a facts source, the ONE way every caller mints it: the
 * grounding context that shows the source to the model, and the provenance
 * that records which sources a section was given. They used to differ for a
 * module with no repository (an uploaded document, an archive): provenance kept
 * the raw dir (`facts:src/m00:0`) and citations the sanitised one
 * (`facts:src_m00:0`), so a join between the two missed every such module.
 */
export function factsSourceIdOf(
  source: Pick<FactsSourceInput, "moduleDir" | "idx" | "repository">,
): string {
  return factsSourceId(source.moduleDir, source.idx, source.repository);
}

/** A repository-backed id: `facts:repo:<URI-encoded JSON tuple>:<idx>`, never sanitised. */
const REPOSITORY_FACTS_PREFIX = "facts:repo:%5B";
const FACTS_PREFIX = "facts:";

/**
 * #1356 — a stored facts id in its canonical form, so provenance written before
 * the fix still joins to the citations it was written beside. Before #1356 a
 * section's `factsSourceIds` held a repository-less module by its RAW dir
 * (`facts:src/m00:0`) while its citations used the sanitised dir. The raw form
 * is mapped to the sanitised one here, at read time; a stored manifest is never
 * rewritten. Idempotent: a canonical id, a repository-backed id and anything
 * that is not a `facts:` id come back unchanged.
 *
 * The idx is what follows the LAST colon (a raw dir can hold one). The raw form
 * is recognisable because the sanitiser never leaves a character outside
 * `[A-Za-z0-9.-]` and never a leading or trailing `_`.
 */
export function canonicalFactsSourceId(id: string): string {
  if (!id.startsWith(FACTS_PREFIX) || id.startsWith(REPOSITORY_FACTS_PREFIX)) return id;
  const cut = id.lastIndexOf(":");
  if (cut < FACTS_PREFIX.length) return id;
  const dir = id.slice(FACTS_PREFIX.length, cut);
  const idx = id.slice(cut + 1);
  if (!/^\d+$/.test(idx)) return id;
  return `facts:${sanitiseModuleDir(dir)}:${idx}`;
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
      sourceId: factsSourceIdOf(f),
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
      sourceId: factsSourceIdOf(f),
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
 *
 * #168 — `factsBlob`: the EXTRACTED MODULE FACTS text the same prompt already
 * carries. A `facts:` source whose text appears verbatim in it is listed by id,
 * label and module header only, pointing at that entry, instead of being sent a
 * second time. A facts source whose text is NOT in the blob keeps its text, so
 * no fact the model could cite is ever dropped from the prompt. The context
 * itself is unchanged: the judge still reads every source's text.
 */
export function renderGroundingBlock(
  ctx: GroundingContext,
  opts: { factsBlob?: string } = {},
): string {
  if (ctx.isEmpty) return "";
  const blob = opts.factsBlob ?? "";
  let referenced = 0;
  // #1370 — a source's text is repository, document or web text: it cannot
  // close this block, forge another of the writer's blocks, or forge a
  // `[SOURCE id=…]` header that would pass its text off as another source's.
  // Clean text is returned unchanged, so the prompt (and its cache prefix) is
  // byte-identical for it.
  const data = (text: string) => scrubWriterFenceLookalikes(text, "[REDACTED-FENCE]");
  const parts = ctx.sources.map((s) => {
    const header = `[SOURCE id=${s.sourceId} kind=${s.kind} label=${JSON.stringify(data(s.label))}]`;
    if (s.kind === "facts" && blob && blob.includes(s.text)) {
      referenced++;
      const entry = data(s.text.split("\n", 1)[0]);
      return `${header}\n(text: the "${entry}" entry in EXTRACTED MODULE FACTS above)`;
    }
    return `${header}\n${data(s.text)}`;
  });
  return [
    "=== RETRIEVED GROUNDING SOURCES ===",
    "Every factual claim you write MUST be grounded in one or more of the",
    "sources below and cite their `id` value(s). Do NOT invent source ids.",
    // #737 — citations are turned into document-wide footnotes at assembly.
    `Cite by writing the id in square brackets straight after the claim, e.g. [${ctx.sources[0].sourceId}].`,
    "Do NOT write your own footnotes, source keys, handles (S1, S2 …) or reference",
    "tables — the citations are rendered into numbered references automatically.",
    ...(referenced > 0
      ? [
          "A `kind=facts` source listed without its text is the named MODULE entry in",
          "EXTRACTED MODULE FACTS above; cite its `id` for claims drawn from that entry.",
        ]
      : []),
    "",
    parts.join("\n\n---\n\n"),
    "",
    "=== END GROUNDING SOURCES ===",
  ].join("\n");
}

/**
 * #1329 — a section prompt's grounding as two blocks, for a prompt prefix
 * cache. `shared` carries the retrieved sources (repository excerpts, project
 * documents, web digests): every batch of one section is given the same ones,
 * so the prompt puts this block AHEAD of the batch's own facts and the batches
 * share it as a cached prefix. `own` carries the module-facts sources, which
 * are the batch's own, and goes after its facts, as the whole block did.
 *
 * With no retrieved source, `shared` is empty and `own` is exactly
 * {@link renderGroundingBlock}'s block. Together the two hold every source once.
 */
export interface GroundingBlocks {
  shared: string;
  own: string;
}

export const NO_GROUNDING_BLOCKS: GroundingBlocks = { shared: "", own: "" };

export function renderGroundingBlocks(
  ctx: GroundingContext,
  opts: { factsBlob?: string } = {},
): GroundingBlocks {
  if (ctx.isEmpty) return NO_GROUNDING_BLOCKS;
  const retrieved = ctx.sources.filter((s) => s.kind !== "facts");
  if (retrieved.length === 0) {
    return { shared: "", own: renderGroundingBlock(ctx, opts) };
  }
  const facts = ctx.sources.filter((s) => s.kind === "facts");
  const shared = renderGroundingBlock(
    { sources: retrieved, sourceIds: new Set(retrieved.map((s) => s.sourceId)), isEmpty: false },
    opts,
  );
  if (facts.length === 0) return { shared, own: "" };
  const blob = opts.factsBlob ?? "";
  const data = (text: string) => scrubWriterFenceLookalikes(text, "[REDACTED-FENCE]");
  let referenced = 0;
  const parts = facts.map((s) => {
    const header = `[SOURCE id=${s.sourceId} kind=${s.kind} label=${JSON.stringify(data(s.label))}]`;
    if (blob && blob.includes(s.text)) {
      referenced++;
      return `${header}\n(text: the "${data(s.text.split("\n", 1)[0])}" entry in EXTRACTED MODULE FACTS above)`;
    }
    return `${header}\n${data(s.text)}`;
  });
  const own = [
    "=== GROUNDING SOURCES: MODULE FACTS ===",
    "These are grounding sources too: cite them exactly as the retrieved sources above.",
    ...(referenced > 0
      ? [
          "A `kind=facts` source listed without its text is the named MODULE entry in",
          "EXTRACTED MODULE FACTS above; cite its `id` for claims drawn from that entry.",
        ]
      : []),
    "",
    parts.join("\n\n---\n\n"),
    "",
    "=== END GROUNDING SOURCES ===",
  ].join("\n");
  return { shared, own };
}
