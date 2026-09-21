/**
 * Structured NFR + acceptance-criteria elicitor — Epic #208 (E6.2 / #231).
 *
 * Today NFRs/ACs exist only as an enum value on extracted requirements
 * (`requirements-extractor.ts:27`) plus template placeholders. This adds REAL
 * elicitation following the METIS house structured-output pattern (NO Vercel AI
 * SDK): a `provider.chat(messages, { disableTools: true })` call with a
 * JSON-shaped prompt, then a dedicated `parseNfrAcceptance()` validator
 * (strip fences → `JSON.parse` → shape guard → per-item Zod, applied AFTER
 * parse, never at the model boundary). Modeled on `requirements-extractor.ts`.
 */
import { randomUUID } from "node:crypto";
import {
  type AcceptanceCriterion,
  type Nfr,
  type NfrAcceptanceResult,
  acceptanceCriterionSchema,
  nfrSchema,
} from "@metis/shared";
import type { AIProvider, ChatMessage, TokenUsage } from "../ai/types.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("nfr-elicitor");

const ELICITATION_SYSTEM_PROMPT = [
  "You are a requirements analyst. From the provided requirement text, elicit",
  "the NON-FUNCTIONAL REQUIREMENTS (NFRs) and explicit ACCEPTANCE CRITERIA.",
  "",
  "For each NFR output a JSON object with:",
  '  - category: one of "performance", "security", "scalability", "availability",',
  '    "reliability", "usability", "maintainability", "compliance",',
  '    "observability", "other"',
  "  - title: concise NFR title",
  "  - description: full NFR description",
  '  - metric: a measurable target if stated (e.g. "p95 < 200ms", "99.9% uptime"),',
  "    else an empty string",
  '  - priority: one of "must-have", "should-have", "nice-to-have"',
  "",
  "For each acceptance criterion output a JSON object with:",
  "  - statement: what the criterion verifies",
  "  - given / when / then: optional Given/When/Then framing (empty strings if",
  "    not applicable)",
  "",
  "Respond ONLY with a JSON object:",
  '{ "nfrs": [...], "acceptanceCriteria": [...] }',
  "Do not include markdown fences or commentary.",
].join("\n");

export interface NfrElicitorDeps {
  provider: AIProvider;
  model?: string;
}

export interface NfrElicitationResult extends NfrAcceptanceResult {
  usage: TokenUsage;
}

function zeroUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function emptyResult(): NfrAcceptanceResult {
  return { nfrs: [], acceptanceCriteria: [] };
}

/**
 * Parse + validate the LLM response into typed NFRs + acceptance criteria.
 * Strips markdown fences → `JSON.parse` → per-item Zod validation (a missing
 * `id` is synthesised before validation so the model need not invent one).
 * Invalid items are dropped individually; an unrecoverable parse failure
 * yields an empty result. @internal — exposed for testing.
 */
export function parseNfrAcceptance(content: string): NfrAcceptanceResult {
  let json: unknown;
  try {
    const cleaned = content
      .replace(/^```(?:json)?\s*\n?/m, "")
      .replace(/\n?```\s*$/m, "")
      .trim();
    json = JSON.parse(cleaned);
  } catch {
    log.warn("Failed to parse NFR/AC response as JSON");
    return emptyResult();
  }

  if (!json || typeof json !== "object") return emptyResult();
  const obj = json as Record<string, unknown>;

  const nfrs: Nfr[] = [];
  if (Array.isArray(obj.nfrs)) {
    for (const raw of obj.nfrs) {
      if (!raw || typeof raw !== "object") continue;
      const withId = { id: randomUUID(), ...(raw as Record<string, unknown>) };
      const parsed = nfrSchema.safeParse(withId);
      if (parsed.success) nfrs.push(parsed.data);
    }
  }

  const acceptanceCriteria: AcceptanceCriterion[] = [];
  if (Array.isArray(obj.acceptanceCriteria)) {
    for (const raw of obj.acceptanceCriteria) {
      if (!raw || typeof raw !== "object") continue;
      const withId = { id: randomUUID(), ...(raw as Record<string, unknown>) };
      const parsed = acceptanceCriterionSchema.safeParse(withId);
      if (parsed.success) acceptanceCriteria.push(parsed.data);
    }
  }

  return { nfrs, acceptanceCriteria };
}

export class NfrElicitor {
  private readonly provider: AIProvider;
  private readonly model: string | undefined;

  constructor(deps: NfrElicitorDeps) {
    this.provider = deps.provider;
    this.model = deps.model;
  }

  /** Elicit structured NFRs + acceptance criteria from raw requirement text. */
  async elicit(rawInput: string, signal?: AbortSignal): Promise<NfrElicitationResult> {
    if (!rawInput.trim()) {
      return { ...emptyResult(), usage: zeroUsage() };
    }

    const messages: ChatMessage[] = [
      { role: "system", content: ELICITATION_SYSTEM_PROMPT },
      { role: "user", content: rawInput },
    ];

    log.info("Eliciting NFRs + acceptance criteria from input (%d chars)", rawInput.length);

    const response = await this.provider.chat(messages, {
      model: this.model,
      signal,
      disableTools: true,
    });

    const parsed = parseNfrAcceptance(response.content);
    log.info(
      "Elicited %d NFR(s), %d acceptance criteria",
      parsed.nfrs.length,
      parsed.acceptanceCriteria.length,
    );

    return { ...parsed, usage: response.usage ?? zeroUsage() };
  }
}
