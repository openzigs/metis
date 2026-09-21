/**
 * Completeness checklist (Epic #203 / Issue #220).
 *
 * Detects gaps in the ingested corpus — missing non-functional requirements
 * (NFRs), acceptance criteria, assumptions, and risks. Structured output via
 * the METIS house pattern: a `provider.chat(messages, { disableTools: true })`
 * call with a JSON-shaped prompt, then a dedicated `parseCompleteness()`
 * validator (strip fences → `JSON.parse` → per-gap Zod validation). Zod is
 * applied AFTER parse, never at the model boundary.
 *
 * Consumes elicited artifacts from Child Epic 6 (#208) when supplied via
 * `check(..., { elicitedArtifacts })`; works standalone otherwise.
 */
import { type CompletenessGap, completenessGapSchema } from "@metis/shared";
import type { AIProvider, ChatMessage, TokenUsage } from "../ai/types.js";
import { createChildLogger } from "../logger.js";
import type { DocSegment } from "./cross-doc-validator.js";

const log = createChildLogger("completeness-checker");

export interface CompletenessCheckerDeps {
  provider: AIProvider;
  model?: string;
  /** Per-segment content cap (characters) to bound the prompt. */
  segmentCharCap?: number;
}

export interface CompletenessCheckOptions {
  signal?: AbortSignal;
  /**
   * Optional elicited artifacts (assumptions / clarifications) from Child Epic
   * 6 (#208). Injected as additional context so the checklist accounts for
   * facts captured outside the ingested documents.
   */
  elicitedArtifacts?: string;
}

export interface CompletenessCheckResult {
  gaps: CompletenessGap[];
  usage: TokenUsage;
}

/** Default per-segment truncation. */
export const DEFAULT_SEGMENT_CAP = 4000;

const COMPLETENESS_SYSTEM_PROMPT = [
  "You are a business analyst auditing a set of requirement documents for",
  "completeness. Review the corpus and flag any MISSING categories that a",
  "complete specification should contain:",
  '  - "missing-nfr"                 — no non-functional requirements (performance,',
  "                                    security, scalability, availability, etc).",
  '  - "missing-acceptance-criteria" — features without measurable acceptance criteria.',
  '  - "missing-assumption"          — unstated assumptions the spec relies on.',
  '  - "missing-risk"                — risks/edge-cases that are not documented.',
  "",
  "Only flag a category when it is genuinely absent or materially incomplete.",
  "Respond ONLY with a JSON object of the shape:",
  '{ "gaps": [ { "kind": "missing-nfr|missing-acceptance-criteria|',
  'missing-assumption|missing-risk", "title": "...", "rationale": "...",',
  '"evidenceIds": ["<docId>"] } ] }',
  "Do not include markdown fences or commentary.",
].join("\n");

function makeAbortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function zeroUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function truncate(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}\n…[truncated]` : text;
}

/**
 * Parse + validate the LLM completeness response. Strips markdown fences →
 * `JSON.parse` → per-gap Zod validation (invalid gaps dropped individually).
 * Returns an empty result on unrecoverable parse failure.
 * @internal — exposed for testing.
 */
export function parseCompleteness(content: string): { gaps: CompletenessGap[] } {
  let json: unknown;
  try {
    const cleaned = content
      .replace(/^```(?:json)?\s*\n?/m, "")
      .replace(/\n?```\s*$/m, "")
      .trim();
    json = JSON.parse(cleaned);
  } catch {
    log.warn("Failed to parse completeness response as JSON");
    return { gaps: [] };
  }

  if (!json || typeof json !== "object" || !Array.isArray((json as Record<string, unknown>).gaps)) {
    return { gaps: [] };
  }

  const rawGaps = (json as { gaps: unknown[] }).gaps;
  const gaps: CompletenessGap[] = [];
  for (const raw of rawGaps) {
    const parsed = completenessGapSchema.safeParse(raw);
    if (parsed.success) gaps.push(parsed.data);
  }
  return { gaps };
}

export class CompletenessChecker {
  private readonly provider: AIProvider;
  private readonly model: string | undefined;
  private readonly segmentCharCap: number;

  constructor(deps: CompletenessCheckerDeps) {
    this.provider = deps.provider;
    this.model = deps.model;
    this.segmentCharCap = deps.segmentCharCap ?? DEFAULT_SEGMENT_CAP;
  }

  async check(
    segments: DocSegment[],
    opts: CompletenessCheckOptions = {},
  ): Promise<CompletenessCheckResult> {
    if (opts.signal?.aborted) throw makeAbortError();

    const usable = segments.filter((s) => s.content.trim().length > 0);
    if (usable.length === 0) {
      return { gaps: [], usage: zeroUsage() };
    }

    const blocks = usable.map((s) =>
      [`### ${s.label} (id=${s.id})`, "```", truncate(s.content, this.segmentCharCap), "```"].join(
        "\n",
      ),
    );
    const parts = [`Documents to audit (${usable.length}):`, "", ...blocks];
    if (opts.elicitedArtifacts && opts.elicitedArtifacts.trim().length > 0) {
      parts.push("", "Additional elicited artifacts (assumptions/clarifications):", "```");
      parts.push(truncate(opts.elicitedArtifacts.trim(), this.segmentCharCap), "```");
    }
    parts.push("", "Run the completeness checklist now.");

    const messages: ChatMessage[] = [
      { role: "system", content: COMPLETENESS_SYSTEM_PROMPT },
      { role: "user", content: parts.join("\n") },
    ];

    log.info("Running completeness checklist", { segments: usable.length });

    const response = await this.provider.chat(messages, {
      model: this.model,
      signal: opts.signal,
      disableTools: true,
    });

    const { gaps } = parseCompleteness(response.content);
    log.info("Completeness checklist complete", { gaps: gaps.length });

    return { gaps, usage: response.usage ?? zeroUsage() };
  }
}
