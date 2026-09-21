/**
 * Structured elicitation artifacts — Epic #208 (E6.2 #231, E6.3 #232).
 *
 * NFRs, acceptance criteria, assumptions, and risks elicited from requirement
 * text via the METIS house structured-output pattern (JSON-in-prompt + a
 * `parseXxx()` validator). These Zod schemas are applied POST-parse only (never
 * at the model boundary) to give the parsed objects a typed, validated shape —
 * mirroring `cross-doc.ts` / the server `requirements-extractor.ts`.
 */
import { z } from "zod";

// ---- Shared vocabularies ---------------------------------------------------

/** NFR ISO/IEC-25010-flavoured categories the elicitor recognises. */
export const NFR_CATEGORIES = [
  "performance",
  "security",
  "scalability",
  "availability",
  "reliability",
  "usability",
  "maintainability",
  "compliance",
  "observability",
  "other",
] as const;
export type NfrCategory = (typeof NFR_CATEGORIES)[number];

/** MoSCoW priority shared across elicited artifacts. */
export const ELICITATION_PRIORITIES = ["must-have", "should-have", "nice-to-have"] as const;
export type ElicitationPriority = (typeof ELICITATION_PRIORITIES)[number];

/** Qualitative likelihood / impact bands for risks. */
export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

const shortText = z.string().trim().min(1).max(255);
const longText = z.string().trim().min(1).max(2_000);

// ---- Non-functional requirements (#231) ------------------------------------

export const nfrSchema = z.object({
  id: z.string().min(1).max(128),
  category: z.enum(NFR_CATEGORIES),
  title: shortText,
  description: longText,
  /** Measurable target, e.g. "p95 < 200ms", "99.9% uptime". Optional. */
  metric: z.string().trim().max(500).default(""),
  priority: z.enum(ELICITATION_PRIORITIES).default("should-have"),
});
export type Nfr = z.infer<typeof nfrSchema>;

// ---- Acceptance criteria (#231) --------------------------------------------

export const acceptanceCriterionSchema = z.object({
  id: z.string().min(1).max(128),
  /** What the criterion verifies. */
  statement: longText,
  /** Optional Given/When/Then framing for testable criteria. */
  given: z.string().trim().max(1_000).default(""),
  when: z.string().trim().max(1_000).default(""),
  then: z.string().trim().max(1_000).default(""),
});
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;

/** Combined NFR + AC elicitation result (#231). */
export const nfrAcceptanceResultSchema = z.object({
  nfrs: z.array(nfrSchema).max(200).default([]),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).max(200).default([]),
});
export type NfrAcceptanceResult = z.infer<typeof nfrAcceptanceResultSchema>;

// ---- Assumptions (#232) ----------------------------------------------------

export const assumptionSchema = z.object({
  id: z.string().min(1).max(128),
  statement: longText,
  /** Why the spec relies on this being true. */
  rationale: z.string().trim().max(2_000).default(""),
  /** If false, how much does it hurt? Reuses the risk band vocabulary. */
  impactIfFalse: z.enum(RISK_LEVELS).default("medium"),
});
export type Assumption = z.infer<typeof assumptionSchema>;

// ---- Risks (#232) ----------------------------------------------------------

export const riskSchema = z.object({
  id: z.string().min(1).max(128),
  title: shortText,
  description: longText,
  likelihood: z.enum(RISK_LEVELS).default("medium"),
  impact: z.enum(RISK_LEVELS).default("medium"),
  /** Optional mitigation strategy. */
  mitigation: z.string().trim().max(2_000).default(""),
});
export type Risk = z.infer<typeof riskSchema>;

/** Combined assumptions + risks elicitation result (#232). */
export const assumptionRiskResultSchema = z.object({
  assumptions: z.array(assumptionSchema).max(200).default([]),
  risks: z.array(riskSchema).max(200).default([]),
});
export type AssumptionRiskResult = z.infer<typeof assumptionRiskResultSchema>;
