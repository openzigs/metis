/**
 * Issue #403 — trust-boundary validation for `POST .../analyses/:id/clarify`.
 *
 * The route used to cast `req.body` straight to `StructuredRequirements`, so a
 * body such as `{ requirements: {} }` or a `null` requirement entry reached
 * `withAmbiguityDefaults` and threw — a 500 for what is a client error. This
 * schema rejects malformed input with a 400 before the dialog sees it.
 *
 * It is deliberately lenient about what #382 made legal: a requirement may omit
 * `ambiguities` (or carry `null`) and is then treated as having none. Unknown
 * keys on a requirement are preserved (`looseObject`) because the refined
 * requirements are persisted back into `Analysis.metadata` and must not lose
 * fields the dialog does not itself read.
 */
import { z } from "zod";

/**
 * Caps against pathological array shapes (DoS guard). They do not bound the
 * prompt on their own: multiplied out they allow far more text than a request
 * can carry. The express.json body limit (JSON_LIMIT in app.ts) is what bounds
 * the total size (PR #435 review).
 */
export const MAX_CLARIFY_REQUIREMENTS = 1000;
export const MAX_CLARIFY_AMBIGUITIES_PER_REQUIREMENT = 200;
export const MAX_CLARIFY_ANSWERS = 2000;
const MAX_ID_CHARS = 200;
const MAX_TEXT_CHARS = 20_000;

const ambiguitySchema = z.looseObject({
  field: z.string().min(1).max(MAX_ID_CHARS),
  description: z.string().max(MAX_TEXT_CHARS).optional(),
  suggestedQuestion: z.string().max(MAX_TEXT_CHARS).optional(),
});

const requirementSchema = z.looseObject({
  id: z.string().min(1).max(MAX_ID_CHARS),
  title: z.string().max(MAX_TEXT_CHARS).optional(),
  description: z.string().max(MAX_TEXT_CHARS).optional(),
  ambiguities: z.array(ambiguitySchema).max(MAX_CLARIFY_AMBIGUITIES_PER_REQUIREMENT).nullish(),
});

const structuredRequirementsSchema = z.looseObject({
  requirements: z.array(requirementSchema).max(MAX_CLARIFY_REQUIREMENTS),
  totalAmbiguities: z.number().finite().optional(),
  totalEvidenceNeeds: z.number().finite().optional(),
});

const answerSchema = z.object({
  questionId: z.string().min(1).max(MAX_ID_CHARS),
  answer: z.string().max(MAX_TEXT_CHARS),
});

export const clarifyRequestSchema = z.object({
  requirements: structuredRequirementsSchema.optional(),
  answers: z.array(answerSchema).max(MAX_CLARIFY_ANSWERS).optional(),
});

export type ClarifyRequest = z.infer<typeof clarifyRequestSchema>;
