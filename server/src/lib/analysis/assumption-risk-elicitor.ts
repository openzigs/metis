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
 */
import { randomUUID } from "node:crypto";
import {
  type Assumption,
  type AssumptionRiskResult,
  type Risk,
  assumptionSchema,
  riskSchema,
} from "@metis/shared";
import type { AIProvider, ChatMessage, TokenUsage } from "../ai/types.js";
import { createChildLogger } from "../logger.js";

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
}

function zeroUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function emptyResult(): AssumptionRiskResult {
  return { assumptions: [], risks: [] };
}

/**
 * Parse + validate the LLM response into typed assumptions + risks. Strips
 * markdown fences → `JSON.parse` → per-item Zod validation (a missing `id` is
 * synthesised before validation). Invalid items are dropped individually; an
 * unrecoverable parse failure yields an empty result.
 * @internal — exposed for testing.
 */
export function parseAssumptionRisk(content: string): AssumptionRiskResult {
  let json: unknown;
  try {
    const cleaned = content
      .replace(/^```(?:json)?\s*\n?/m, "")
      .replace(/\n?```\s*$/m, "")
      .trim();
    json = JSON.parse(cleaned);
  } catch {
    log.warn("Failed to parse assumption/risk response as JSON");
    return emptyResult();
  }

  if (!json || typeof json !== "object") return emptyResult();
  const obj = json as Record<string, unknown>;

  const assumptions: Assumption[] = [];
  if (Array.isArray(obj.assumptions)) {
    for (const raw of obj.assumptions) {
      if (!raw || typeof raw !== "object") continue;
      const withId = { id: randomUUID(), ...(raw as Record<string, unknown>) };
      const parsed = assumptionSchema.safeParse(withId);
      if (parsed.success) assumptions.push(parsed.data);
    }
  }

  const risks: Risk[] = [];
  if (Array.isArray(obj.risks)) {
    for (const raw of obj.risks) {
      if (!raw || typeof raw !== "object") continue;
      const withId = { id: randomUUID(), ...(raw as Record<string, unknown>) };
      const parsed = riskSchema.safeParse(withId);
      if (parsed.success) risks.push(parsed.data);
    }
  }

  return { assumptions, risks };
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

    const response = await this.provider.chat(messages, {
      model: this.model,
      signal,
      disableTools: true,
    });

    const parsed = parseAssumptionRisk(response.content);
    log.info("Elicited assumptions + risks", {
      assumptions: parsed.assumptions.length,
      risks: parsed.risks.length,
    });

    return { ...parsed, usage: response.usage ?? zeroUsage() };
  }
}
