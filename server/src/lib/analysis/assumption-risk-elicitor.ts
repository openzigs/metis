/**
 * Structured assumptions + risks elicitor — Epic #208 (E6.3 / #232).
 *
 * Assumptions and risks previously existed only as an enum/placeholder, never
 * as elicited artifacts. This adds typed elicitation using the same METIS
 * house structured-output pattern as #231 (NO Vercel AI SDK): a
 * `provider.chat(messages, { disableTools: true })` call with a JSON-shaped
 * prompt, then a dedicated `parseAssumptionRisk()` validator (strip fences →
 * `JSON.parse` → shape guard → per-item Zod, applied AFTER parse, never at the
 * model boundary). Modeled on `requirements-extractor.ts`.
 *
 * #1081 — an answer that cannot be read is no longer returned as "no
 * assumptions, no risks": the call goes through `requestStructuredVerdict`
 * (one re-prompt), and a second failure comes back marked `unread`.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type Assumption,
  type AssumptionRiskResult,
  type Risk,
  assumptionSchema,
  riskSchema,
} from "@metis/shared";
import type { AIProvider, ChatMessage, TokenUsage } from "../ai/types.js";
import { createChildLogger } from "../logger.js";
import { extractJsonObject } from "./agent-runner.js";
import {
  hasVerdict,
  jsonObjectWhereDeclared,
  requestStructuredVerdict,
} from "./structured-verdict.js";
import type { UnreadModelReply } from "./unread-reply.js";

const log = createChildLogger("assumption-risk-elicitor");

const ELICITATION_SYSTEM_PROMPT = [
  "You are a requirements analyst. From the provided requirement text, elicit",
  "the ASSUMPTIONS the specification relies on and the RISKS it faces.",
  "",
  "For each assumption output a JSON object with:",
  "  - statement: the thing being assumed true",
  "  - rationale: why the spec depends on it (empty string if none)",
  '  - impactIfFalse: one of "low", "medium", "high" — how much it hurts if the',
  "    assumption turns out false",
  "",
  "For each risk output a JSON object with:",
  "  - title: concise risk title",
  "  - description: full risk description",
  '  - likelihood: one of "low", "medium", "high"',
  '  - impact: one of "low", "medium", "high"',
  "  - mitigation: a mitigation strategy if any (empty string otherwise)",
  "",
  "Respond ONLY with a JSON object:",
  '{ "assumptions": [...], "risks": [...] }',
  "Do not include markdown fences or commentary.",
].join("\n");

export interface AssumptionRiskElicitorDeps {
  provider: AIProvider;
  model?: string;
}

export interface AssumptionRiskElicitationResult extends AssumptionRiskResult {
  usage: TokenUsage;
  /** #1081 — set when the answer could not be read; the lists are then not "none". */
  unread?: UnreadModelReply;
}

/** #1081 — the envelope only; items are still read one by one below. */
const envelopeSchema = z
  .object({
    assumptions: z.array(z.unknown()).nullish(),
    risks: z.array(z.unknown()).nullish(),
  })
  .refine((o) => o.assumptions != null || o.risks != null, {
    message: "expected an assumptions or risks array",
  });
type AssumptionRiskEnvelope = z.infer<typeof envelopeSchema>;

/** The shape quoted back to the model in the re-prompt. */
const ASSUMPTION_RISK_SHAPE =
  '{ "assumptions": [ { "statement": string, "rationale": string, "impactIfFalse": string } ], ' +
  '"risks": [ { "title": string, "description": string, "likelihood": string, ' +
  '"impact": string, "mitigation": string } ] }';

function zeroUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function emptyResult(): AssumptionRiskResult {
  return { assumptions: [], risks: [] };
}

/** Per-item Zod validation of a read envelope; a missing `id` is synthesised. */
function normalizeAssumptionRisk(envelope: AssumptionRiskEnvelope): AssumptionRiskResult {
  const assumptions: Assumption[] = [];
  for (const raw of envelope.assumptions ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const withId = { id: randomUUID(), ...(raw as Record<string, unknown>) };
    const parsed = assumptionSchema.safeParse(withId);
    if (parsed.success) assumptions.push(parsed.data);
  }

  const risks: Risk[] = [];
  for (const raw of envelope.risks ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const withId = { id: randomUUID(), ...(raw as Record<string, unknown>) };
    const parsed = riskSchema.safeParse(withId);
    if (parsed.success) risks.push(parsed.data);
  }

  return { assumptions, risks };
}

/**
 * Parse + validate one LLM response into typed assumptions + risks. Invalid
 * items are dropped individually.
 *
 * #1081 — returns `null` when the response cannot be read at all, which is
 * NOT the same as an empty answer.
 * @internal — exposed for testing.
 */
export function parseAssumptionRisk(content: string): AssumptionRiskResult | null {
  let json: unknown;
  try {
    json = extractJsonObject(content);
  } catch {
    return null;
  }
  const envelope = envelopeSchema.safeParse(json);
  return envelope.success ? normalizeAssumptionRisk(envelope.data) : null;
}

export class AssumptionRiskElicitor {
  private readonly provider: AIProvider;
  private readonly model: string | undefined;

  constructor(deps: AssumptionRiskElicitorDeps) {
    this.provider = deps.provider;
    this.model = deps.model;
  }

  /** Elicit structured assumptions + risks from raw requirement text. */
  async elicit(rawInput: string, signal?: AbortSignal): Promise<AssumptionRiskElicitationResult> {
    if (!rawInput.trim()) {
      return { ...emptyResult(), usage: zeroUsage() };
    }

    const messages: ChatMessage[] = [
      { role: "system", content: ELICITATION_SYSTEM_PROMPT },
      { role: "user", content: rawInput },
    ];

    log.info("Eliciting assumptions + risks from input", { chars: rawInput.length });

    const outcome = await requestStructuredVerdict(this.provider, {
      label: "assumption-risk-elicitation",
      schema: envelopeSchema,
      schemaName: "assumptions and risks",
      expectedShape: ASSUMPTION_RISK_SHAPE,
      messages,
      model: this.model,
      signal,
      disableTools: true,
      responseFormat: jsonObjectWhereDeclared(this.provider, this.model),
    });
    if (!hasVerdict(outcome)) {
      log.warn("Assumption/risk answer could not be read — recorded as unread, not as empty", {
        reason: outcome.reason,
        attempts: outcome.attempts,
      });
      return {
        ...emptyResult(),
        usage: outcome.usage,
        unread: { reason: outcome.reason, detail: outcome.detail },
      };
    }

    const parsed = normalizeAssumptionRisk(outcome.verdict);
    log.info("Elicited assumptions + risks", {
      assumptions: parsed.assumptions.length,
      risks: parsed.risks.length,
    });

    return { ...parsed, usage: outcome.usage };
  }
}
