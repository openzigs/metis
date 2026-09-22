/**
 * Claim-level decomposition + citation enforcement (Epic #204 / Issue #223).
 *
 * Decomposes a generated section into ATOMIC claims, each of which MUST cite one
 * or more retrieved `sourceId`s drawn from the grounding context (#222). This is
 * the structural pre-requisite for citation validation (#224): without explicit
 * per-claim `sourceIds`, there is nothing to resolve against the retrieved set.
 *
 * Structured output uses METIS's established pattern (NO Vercel AI SDK, NO
 * `generateObject` / `Output.object` / `response_format`):
 *   1. `provider.chat(messages, { disableTools: true })` with a JSON-shaped
 *      prompt asking for `{ claims: [{ claim, sourceIds }] }`.
 *   2. A dedicated `parseClaims()` validator — strip markdown fences →
 *      `JSON.parse` → shape check — modeled on
 *      `requirements-extractor.ts:67-101`.
 *   3. Zod validation applied AFTER parse (never at the model boundary).
 *
 * The offline stub (`AI_OFFLINE=1`) returns deterministic, parseable output so
 * the test seam stays green without a network call.
 */
import { z } from "zod";
import type { AIProvider, ChatMessage, JsonSchemaResponseFormat } from "../../ai/types.js";
import { createChildLogger } from "../../logger.js";
import type { GroundingContext } from "./grounding-context.js";
import { extractFirstJson } from "./json-extract.js";

const log = createChildLogger("docs-gen:claim-extractor");

/** A single atomic claim with the source ids that support it. */
export interface GroundedClaim {
  claim: string;
  sourceIds: string[];
}

/** Result of decomposing one section of generated text. */
export interface ClaimDecomposition {
  claims: GroundedClaim[];
}

// ── Zod schema — applied AFTER JSON.parse + shape check, never at the boundary.
const groundedClaimSchema = z.object({
  claim: z.string().trim().min(1),
  sourceIds: z.array(z.string().trim().min(1)),
});

const decompositionSchema = z.object({
  claims: z.array(groundedClaimSchema),
});

/**
 * Strip markdown blockquote / admonition blocks before claim extraction.
 *
 * The verbose generation prompt explicitly instructs the model to emit GitHub-
 * style callouts (`> **Note:** ...`, `> **Warning:** ...`, `> **Tip:** ...`) and
 * the code-derived sections additionally tell it to flag missing facts in a
 * callout. For SAS projects that produced body-thin facts, the model honestly
 * disclaims its own output ("> **Note:** many modules had empty bodies…"). Those
 * disclaimers are META-COMMENTARY ABOUT EXTRACTION QUALITY — they are NOT
 * documentation claims to be grounded in the source. Feeding them to the claim
 * extractor turned each disclaimer line into an ungrounded "claim", dragging the
 * section's faithfulness ratio down (the Key Workflows 0/7 case was largely
 * these). We therefore drop every blockquote line (any line whose first
 * non-whitespace character is `>`, the GFM blockquote marker) before decomposing.
 *
 * Only blockquote lines are removed; normal prose, bullets, numbered lists,
 * tables, headings, and fenced code blocks are untouched — including a `>`
 * comparison that appears INSIDE a line (e.g. "amount > 1000"), which is not a
 * blockquote because the `>` is not the line's leading token. A blank line left
 * where a multi-line blockquote stood is collapsed so surrounding prose still
 * decomposes the same way.
 * @internal — exported for testing.
 */
export function stripDisclaimerBlocks(markdown: string): string {
  const lines = markdown.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    // A GFM blockquote line starts (after optional leading whitespace) with `>`.
    // This matches `>`, `> text`, and nested `>>` callouts. A mid-line `>`
    // (a numeric/SQL comparison) is NOT matched, so real claims are preserved.
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  // Collapse 3+ consecutive blank lines (possibly created by removing a
  // blockquote between paragraphs) down to a single blank line. Line-based
  // splitting downstream is blank-line tolerant, but this keeps the text tidy.
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

const SYSTEM_PROMPT = `You decompose generated documentation into ATOMIC, verifiable claims and attach citations.

You are given (a) a passage of generated documentation and (b) a list of retrieved SOURCES, each with a stable \`id\`. Break the passage into atomic factual claims. For EACH claim, list the \`id\`(s) of the source(s) that directly support it.

Rules:
- Each claim is a single, self-contained factual statement (one fact per claim).
- \`sourceIds\` MUST be drawn ONLY from the provided source ids. NEVER invent an id.
- If a claim is not supported by any provided source, return it with an EMPTY \`sourceIds\` array (do NOT fabricate a citation).
- Ignore pure formatting, headings, and diagram syntax — only extract substantive claims.

Respond ONLY with a JSON object of the shape:
{ "claims": [ { "claim": "string", "sourceIds": ["id", ...] } ] }
Do not include markdown fences or commentary.`;

export interface ClaimExtractorDeps {
  provider: AIProvider;
  model?: string;
  /**
   * When true, request prompt caching on each `chat` call: the shared system
   * prompt (reused across every section's decomposition) and the large stable
   * passage/source-id prefix in the user turn. Providers that support it (e.g.
   * the native Anthropic provider) cache those prefixes; others ignore it.
   * Defaults to false (back-compat — un-flagged requests are unchanged).
   */
  promptCaching?: boolean;
  /**
   * #1226 — OUTPUT cap for each `chat` call, resolved against THIS extractor's
   * {@link model}. Without it the request inherits the provider's
   * `defaultMaxTokens`, which was sized for the Phase-2 section model — a
   * different, potentially much larger-ceiling model than the claim model.
   */
  maxTokens?: number;
  /**
   * #336 — optional OpenAI-compatible `response_format` schema. When set (the
   * local/vLLM path with `DOCS_GEN_LOCAL_STRUCTURED_OUTPUT=1`), each `chat` call
   * requests schema-constrained decoding of the `{ claims: [...] }` shape so the
   * model cannot emit unparseable structure. The provider degrades gracefully if
   * the runtime rejects it, and {@link parseClaims} still runs, so setting this
   * is safe on any runtime. Undefined = unchanged request (the default).
   */
  responseFormat?: JsonSchemaResponseFormat;
}

export class ClaimExtractor {
  private readonly provider: AIProvider;
  private readonly model: string | undefined;
  private readonly promptCaching: boolean;
  private readonly maxTokens: number | undefined;
  private readonly responseFormat: JsonSchemaResponseFormat | undefined;

  constructor(deps: ClaimExtractorDeps) {
    this.provider = deps.provider;
    this.model = deps.model;
    this.promptCaching = deps.promptCaching ?? false;
    this.maxTokens = deps.maxTokens;
    this.responseFormat = deps.responseFormat;
  }

  /**
   * Decompose a section of generated text into grounded claims. The grounding
   * context supplies the legal source-id universe; the prompt enumerates the
   * source ids so the model cites real ids.
   */
  async decompose(
    sectionText: string,
    ctx: GroundingContext,
    signal?: AbortSignal,
  ): Promise<ClaimDecomposition> {
    // Drop disclaimer/admonition blockquotes (e.g. "> **Note:** empty bodies…")
    // BEFORE extraction so they never become ungrounded "claims" on either the
    // offline or the LLM path. See {@link stripDisclaimerBlocks}.
    const text = stripDisclaimerBlocks(sectionText).trim();
    if (!text) return { claims: [] };

    // Offline / no-grounding: deterministic, parseable, never invents citations.
    if (this.provider.offline) {
      return this.offlineDecomposition(text);
    }

    const idList = ctx.sources.map((s) => `- ${s.sourceId} (${s.kind}): ${s.label}`).join("\n");

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `AVAILABLE SOURCE IDS (cite only these):\n${idList || "(none)"}\n\n=== PASSAGE ===\n${text}\n=== END PASSAGE ===`,
      },
    ];

    log.info("Decomposing section into grounded claims", { chars: text.length });

    const response = await this.provider.chat(messages, {
      model: this.model,
      signal,
      disableTools: true,
      // #1226 — cap sized for THIS extractor's model, never inherited from the
      // provider's section-model default.
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
      // #390/#701 — tag prompt-cache hit-ratio telemetry by workload. Claim
      // extraction has its OWN bucket (split from the faithfulness judge's
      // "grounding") so its input:output ratio + hit rate surface distinctly in
      // the #699 admin telemetry endpoint, validating the Sonnet-vs-Haiku call.
      callType: "claim-extraction",
      ...(this.promptCaching ? { promptCaching: { system: true, messages: true } } : {}),
      // #336 — schema-constrained decoding on the local/vLLM path when enabled.
      ...(this.responseFormat ? { responseFormat: this.responseFormat } : {}),
    });

    return this.parseClaims(response.content);
  }

  /**
   * Deterministic offline decomposition: one claim per non-empty line that is
   * not a heading/fence, with empty citations (the validator will then flag
   * them as ungrounded — which is the correct, honest behaviour offline).
   * @internal — exposed for testing.
   */
  offlineDecomposition(text: string): ClaimDecomposition {
    const claims: GroundedClaim[] = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("```"))
      .map((l) => l.replace(/^[-*]\s+/, ""))
      .filter((l) => l.length > 0)
      .map((l) => ({ claim: l, sourceIds: [] as string[] }));
    return { claims };
  }

  /**
   * Parse + validate the LLM response into a {@link ClaimDecomposition}.
   * Mirrors `requirements-extractor.ts`: strip fences → JSON.parse → shape
   * check → Zod (post-parse). Never throws; an unparseable response yields an
   * empty decomposition.
   * @internal — exposed for testing.
   */
  parseClaims(content: string): ClaimDecomposition {
    // Tolerant parse: recovers the claims JSON even when the model wraps it in
    // prose or a mid-response ```json fence. A genuinely unrecoverable response
    // still degrades to an empty claim set (treated as "no claims" upstream — no
    // ungrounded warning), which is intentional: we never fabricate claims, and a
    // degenerate parse should not by itself mark a section degraded.
    // See {@link extractFirstJson}.
    const json = extractFirstJson(content);
    if (json === null) {
      log.warn("Failed to parse claim decomposition as JSON, returning empty");
      return { claims: [] };
    }

    // Coarse shape check before Zod (mirrors requirements-extractor).
    if (
      !json ||
      typeof json !== "object" ||
      !Array.isArray((json as Record<string, unknown>).claims)
    ) {
      log.warn("Claim decomposition missing 'claims' array");
      return { claims: [] };
    }

    // Zod AFTER parse. Drop malformed entries individually rather than failing
    // the whole decomposition.
    const rawClaims = (json as { claims: unknown[] }).claims;
    const claims: GroundedClaim[] = [];
    for (const raw of rawClaims) {
      const result = groundedClaimSchema.safeParse(raw);
      if (!result.success) continue;
      claims.push({
        claim: result.data.claim,
        // De-duplicate while preserving order.
        sourceIds: Array.from(new Set(result.data.sourceIds)),
      });
    }

    // Final validation of the assembled object (post-parse Zod on the whole).
    const validated = decompositionSchema.safeParse({ claims });
    return validated.success ? validated.data : { claims: [] };
  }
}
