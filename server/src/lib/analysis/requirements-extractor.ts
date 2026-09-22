/**
 * Structured Requirements Extractor (Epic #597 / Issue #622).
 *
 * Accepts raw text or markdown input and uses an LLM (Haiku via model
 * router) to extract structured requirements with identified ambiguities
 * and evidence needs.
 */
import { randomUUID } from "node:crypto";
import type { AIProvider, ChatMessage } from "../ai/types.js";
import { createChildLogger } from "../logger.js";
import type {
  StructuredRequirement,
  StructuredRequirements,
  Ambiguity,
  EvidenceNeed,
  RequirementEnhancementType,
  RequirementEnhancementPriority,
} from "./types/requirements.js";

const log = createChildLogger("requirements-extractor");

const EXTRACTION_SYSTEM_PROMPT = `You are a requirements analyst. Extract structured requirements from the provided text.

For each requirement you identify, output a JSON object with:
- title: concise requirement title
- description: full requirement description
- type: one of "functional", "non-functional", "constraint", "assumption", "dependency"
- stakeholders: array of identified stakeholders
- priority: one of "must-have", "should-have", "nice-to-have"
- ambiguities: array of { field, description, suggestedQuestion } for any vague/unclear aspects
- evidenceNeeds: array of { description, domain, searchHints } for claims needing external evidence

Respond ONLY with a JSON object: { "requirements": [...] }
Do not include markdown fences or commentary.`;

const VALID_TYPES: ReadonlySet<string> = new Set<RequirementEnhancementType>([
  "functional",
  "non-functional",
  "constraint",
  "assumption",
  "dependency",
]);

const VALID_PRIORITIES: ReadonlySet<string> = new Set<RequirementEnhancementPriority>([
  "must-have",
  "should-have",
  "nice-to-have",
]);

export interface RequirementsExtractorDeps {
  provider: AIProvider;
  model?: string;
}

export class RequirementsExtractor {
  private readonly provider: AIProvider;
  private readonly model: string | undefined;

  constructor(deps: RequirementsExtractorDeps) {
    this.provider = deps.provider;
    this.model = deps.model;
  }

  /**
   * Extract structured requirements from raw input text.
   */
  async extract(rawInput: string, signal?: AbortSignal): Promise<StructuredRequirements> {
    if (!rawInput.trim()) {
      return { requirements: [], totalAmbiguities: 0, totalEvidenceNeeds: 0 };
    }

    const messages: ChatMessage[] = [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      { role: "user", content: rawInput },
    ];

    log.info("Extracting structured requirements from input", { chars: rawInput.length });

    const response = await this.provider.chat(messages, {
      model: this.model,
      signal,
      disableTools: true,
    });

    const parsed = this.parseResponse(response.content, rawInput);

    log.info("Extracted structured requirements", {
      requirements: parsed.requirements.length,
      ambiguities: parsed.totalAmbiguities,
      evidenceNeeds: parsed.totalEvidenceNeeds,
    });

    return parsed;
  }

  /**
   * Parse and validate the LLM response into StructuredRequirements.
   * @internal — exposed for testing.
   */
  parseResponse(content: string, rawSource: string): StructuredRequirements {
    let json: unknown;
    try {
      // Strip markdown fences if present
      const cleaned = content.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
      json = JSON.parse(cleaned);
    } catch {
      log.warn("Failed to parse LLM response as JSON, returning empty result");
      return { requirements: [], totalAmbiguities: 0, totalEvidenceNeeds: 0 };
    }

    if (
      !json ||
      typeof json !== "object" ||
      !Array.isArray((json as Record<string, unknown>).requirements)
    ) {
      log.warn("LLM response missing 'requirements' array");
      return { requirements: [], totalAmbiguities: 0, totalEvidenceNeeds: 0 };
    }

    const rawReqs = (json as { requirements: unknown[] }).requirements;
    const requirements: StructuredRequirement[] = [];
    let totalAmbiguities = 0;
    let totalEvidenceNeeds = 0;

    for (const raw of rawReqs) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;

      const title = typeof r.title === "string" ? r.title : "";
      const description = typeof r.description === "string" ? r.description : "";
      if (!title && !description) continue;

      const type = VALID_TYPES.has(String(r.type))
        ? (String(r.type) as RequirementEnhancementType)
        : "functional";
      const priority = VALID_PRIORITIES.has(String(r.priority))
        ? (String(r.priority) as RequirementEnhancementPriority)
        : "should-have";
      const stakeholders = Array.isArray(r.stakeholders)
        ? r.stakeholders.filter((s): s is string => typeof s === "string")
        : [];

      const ambiguities = this.parseAmbiguities(r.ambiguities);
      const evidenceNeeds = this.parseEvidenceNeeds(r.evidenceNeeds);

      totalAmbiguities += ambiguities.length;
      totalEvidenceNeeds += evidenceNeeds.length;

      requirements.push({
        id: randomUUID(),
        title,
        description,
        type,
        stakeholders,
        priority,
        ambiguities,
        evidenceNeeds,
        rawSource,
      });
    }

    return { requirements, totalAmbiguities, totalEvidenceNeeds };
  }

  private parseAmbiguities(raw: unknown): Ambiguity[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
      .map((a) => ({
        field: typeof a.field === "string" ? a.field : "unknown",
        description: typeof a.description === "string" ? a.description : "",
        suggestedQuestion: typeof a.suggestedQuestion === "string" ? a.suggestedQuestion : "",
      }))
      .filter((a) => a.description || a.suggestedQuestion);
  }

  private parseEvidenceNeeds(raw: unknown): EvidenceNeed[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .map((e) => ({
        id: randomUUID(),
        description: typeof e.description === "string" ? e.description : "",
        domain: typeof e.domain === "string" ? e.domain : "general",
        searchHints: Array.isArray(e.searchHints)
          ? e.searchHints.filter((h): h is string => typeof h === "string")
          : [],
      }))
      .filter((e) => e.description);
  }
}
