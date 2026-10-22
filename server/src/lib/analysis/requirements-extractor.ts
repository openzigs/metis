/**
 * Structured Requirements Extractor (Epic #597 / Issue #622).
 *
 * Accepts raw text or markdown input and uses an LLM (Haiku via model
 * router) to extract structured requirements with identified ambiguities
 * and evidence needs.
 *
 * #1058 — an answer that cannot be read is an ERROR, never an empty list. This
 * module used to catch the `JSON.parse` failure, log it and return
 * `{ requirements: [] }`, which is also what a text with no requirements
 * yields — so a malformed answer looked like "requirements look complete", and
 * no clarifying questions and no approval checkpoint followed. The call now
 * goes through `requestStructuredVerdict` (one re-prompt carrying the parse
 * error and the expected shape) and throws {@link RequirementsExtractionError}
 * when that fails too.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AIProvider, ChatMessage } from "../ai/types.js";
import { createChildLogger } from "../logger.js";
import {
  hasVerdict,
  jsonObjectWhereDeclared,
  requestStructuredVerdict,
  type NoVerdictReason,
} from "./structured-verdict.js";
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

/**
 * The envelope only. Each requirement is still read leniently below (a wrong
 * `type` falls back to "functional", a non-string stakeholder is dropped):
 * rejecting a whole extraction over one malformed field would trade a silent
 * failure for a noisy one. What is NOT lenient is the envelope itself — an
 * answer with no `requirements` array is not an extraction.
 */
const extractionSchema = z.object({ requirements: z.array(z.unknown()) });

/** The shape quoted back to the model in the re-prompt. */
const EXTRACTION_SHAPE =
  '{ "requirements": [ { "title": string, "description": string, "type": string, ' +
  '"stakeholders": string[], "priority": string, ' +
  '"ambiguities": [ { "field": string, "description": string, "suggestedQuestion": string } ], ' +
  '"evidenceNeeds": [ { "description": string, "domain": string, "searchHints": string[] } ] } ] }';

/**
 * #1058 — structured extraction produced nothing usable. Distinct from an empty
 * result: the model was asked and its answer could not be read (or the call
 * failed), so "there are no requirements" has NOT been established.
 */
export class RequirementsExtractionError extends Error {
  constructor(
    /** Why — the `requestStructuredVerdict` no-signal reason. */
    readonly reason: NoVerdictReason,
    detail: string,
  ) {
    super(`Structured requirements extraction failed (${reason}): ${detail}`);
    this.name = "RequirementsExtractionError";
  }
}

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

    const outcome = await requestStructuredVerdict(this.provider, {
      label: "requirements-extraction",
      schema: extractionSchema,
      schemaName: "requirements",
      expectedShape: EXTRACTION_SHAPE,
      messages,
      model: this.model,
      signal,
      disableTools: true,
      // #1077 — JSON mode only where the backend is declared json_object-only
      // (DeepSeek's OpenAI-format host, or a catalog override).
      responseFormat: jsonObjectWhereDeclared(this.provider, this.model),
    });
    if (!hasVerdict(outcome)) {
      throw new RequirementsExtractionError(outcome.reason, outcome.detail);
    }

    const parsed = this.toStructured(outcome.verdict.requirements, rawInput);

    log.info("Extracted structured requirements", {
      requirements: parsed.requirements.length,
      ambiguities: parsed.totalAmbiguities,
      evidenceNeeds: parsed.totalEvidenceNeeds,
    });

    return parsed;
  }

  private toStructured(rawReqs: unknown[], rawSource: string): StructuredRequirements {
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
