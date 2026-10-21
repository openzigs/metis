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
 *
 * #1081 — an unreadable answer used to come back as `{ gaps: [] }`, which the
 * panel rendered as "no completeness gaps detected". It now goes through
 * `requestStructuredVerdict` (one re-prompt) and a second failure is returned
 * as `unread`, never as a clean result.
 */
import { z } from "zod";
import { type CompletenessGap, completenessGapSchema } from "@metis/shared";
import type { AIProvider, ChatMessage, TokenUsage } from "../ai/types.js";
import { createChildLogger } from "../logger.js";
import { extractJsonObject } from "./agent-runner.js";
import type { DocSegment } from "./cross-doc-validator.js";
import {
  hasVerdict,
  jsonObjectWhereDeclared,
  requestStructuredVerdict,
} from "./structured-verdict.js";
import type { UnreadModelReply } from "./unread-reply.js";

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
  /** #1081 — set when the answer could not be read; `gaps` is then not "none". */
  unread?: UnreadModelReply;
}

/** #1081 — the envelope only; each gap is still validated on its own. */
const envelopeSchema = z.object({ gaps: z.array(z.unknown()) });

/** The shape quoted back to the model in the re-prompt. */
const COMPLETENESS_SHAPE =
  '{ "gaps": [ { "kind": "missing-nfr" | "missing-acceptance-criteria" | ' +
  '"missing-assumption" | "missing-risk", "title": string, "rationale": string, ' +
  '"evidenceIds": string[] } ] }';

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

/** Per-gap Zod validation (invalid gaps dropped individually). */
function validGaps(rawGaps: unknown[]): CompletenessGap[] {
  const gaps: CompletenessGap[] = [];
  for (const raw of rawGaps) {
    const parsed = completenessGapSchema.safeParse(raw);
    if (parsed.success) gaps.push(parsed.data);
  }
  return gaps;
}

/**
 * Parse + validate one LLM completeness response.
 *
 * #1081 — returns `null` when the response cannot be read at all (no JSON
 * object, or no `gaps` array), which is NOT the same as `{ gaps: [] }`.
 * @internal — exposed for testing.
 */
export function parseCompleteness(content: string): { gaps: CompletenessGap[] } | null {
  let json: unknown;
  try {
    json = extractJsonObject(content);
  } catch {
    return null;
  }
  const envelope = envelopeSchema.safeParse(json);
  return envelope.success ? { gaps: validGaps(envelope.data.gaps) } : null;
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

    const outcome = await requestStructuredVerdict(this.provider, {
      label: "completeness-check",
      schema: envelopeSchema,
      schemaName: "completeness",
      expectedShape: COMPLETENESS_SHAPE,
      messages,
      model: this.model,
      signal: opts.signal,
      disableTools: true,
      responseFormat: jsonObjectWhereDeclared(this.provider, this.model),
    });
    if (!hasVerdict(outcome)) {
      log.warn("Completeness answer could not be read — recorded as unread, not as no gaps", {
        reason: outcome.reason,
        attempts: outcome.attempts,
      });
      return {
        gaps: [],
        usage: outcome.usage,
        unread: { reason: outcome.reason, detail: outcome.detail },
      };
    }

    const gaps = validGaps(outcome.verdict.gaps);
    log.info("Completeness checklist complete", { gaps: gaps.length });

    return { gaps, usage: outcome.usage };
  }
}
