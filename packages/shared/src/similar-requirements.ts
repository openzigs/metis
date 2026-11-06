/**
 * Issue #1837 (epic #1828) — the similar and duplicate requirement API's wire
 * contract.
 *
 *   GET  /api/projects/:projectId/requirements/:requirementId/similar?limit=5
 *   POST /api/projects/:projectId/requirements/similar  { text, acceptanceCriteria? }
 *   200  { items: SimilarRequirementItem[] }
 *
 * `label` is a SUGGESTION. The thresholds behind it were calibrated in #1836 and
 * `duplicate` reached a precision of 0.48 on the labelled set, so a duplicate is
 * something an analyst confirms (#1838), never an automatic action.
 */
import { z } from "zod";
import {
  ACCEPTANCE_CRITERIA_MAX_ITEMS,
  ACCEPTANCE_CRITERION_MAX_LENGTH,
} from "./acceptance-criteria-fallback.js";

export const SIMILAR_REQUIREMENT_LABELS = ["duplicate", "overlap", "related"] as const;
export type SimilarRequirementLabel = (typeof SIMILAR_REQUIREMENT_LABELS)[number];

/**
 * How current a saved code link is (#1830). `unverified` when the link carries
 * no freshness stamp (written before #1830, or by a writer that does not stamp).
 */
export const SIMILAR_CODE_LINK_FRESHNESS = ["fresh", "moved", "stale", "unverified"] as const;
export type SimilarCodeLinkFreshness = (typeof SIMILAR_CODE_LINK_FRESHNESS)[number];

export interface SimilarRequirementCodeLink {
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  /** The link's writer, e.g. `semantic`, `manual`, `analysis-grounding`. */
  source: string;
  freshness: SimilarCodeLinkFreshness;
}

export interface SimilarRequirementItem {
  requirementId: string;
  /** The requirement's display key (`REQ-003`, an imported item's id), when it has one. */
  key: string | null;
  title: string;
  /** Review status: `draft` | `approved` | `rejected` | `deferred`. */
  status: string;
  /** Cosine similarity of the two requirements' embeddings, 0..1. */
  score: number;
  label: SimilarRequirementLabel;
  codeLinks: SimilarRequirementCodeLink[];
}

export interface SimilarRequirementsResponse {
  items: SimilarRequirementItem[];
}

/** The most items one call returns. */
export const SIMILAR_REQUIREMENTS_MAX_LIMIT = 20;
export const SIMILAR_REQUIREMENTS_DEFAULT_LIMIT = 5;
/** The longest draft text the POST accepts. */
export const SIMILAR_REQUIREMENTS_MAX_TEXT = 8_000;

export const similarRequirementsLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(SIMILAR_REQUIREMENTS_MAX_LIMIT)
  .default(SIMILAR_REQUIREMENTS_DEFAULT_LIMIT);

export const similarRequirementsDraftSchema = z
  .object({
    text: z.string().trim().min(1).max(SIMILAR_REQUIREMENTS_MAX_TEXT),
    acceptanceCriteria: z
      .array(z.string().max(ACCEPTANCE_CRITERION_MAX_LENGTH))
      .max(ACCEPTANCE_CRITERIA_MAX_ITEMS)
      .optional(),
    limit: similarRequirementsLimitSchema.optional(),
  })
  .strict();

export type SimilarRequirementsDraft = z.infer<typeof similarRequirementsDraftSchema>;
