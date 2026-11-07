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

/**
 * #1839 — the freshness a link must hold to be borrowed: known to point at
 * current code. The server's borrow and the panel's preview of it (#1840) read
 * this one set, so the preview never lists a link the borrow would skip (#1903).
 */
export const BORROWABLE_FRESHNESS: ReadonlySet<string> = new Set<SimilarCodeLinkFreshness>([
  "fresh",
  "moved",
]);

export interface SimilarRequirementCodeLink {
  /**
   * #1840 — the saved link's id: what "Start from these citations" names in
   * `mappingIds`, so exactly the links it listed are borrowed.
   */
  mappingId: string;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  /** The link's writer, e.g. `semantic`, `manual`, `analysis-grounding`. */
  source: string;
  freshness: SimilarCodeLinkFreshness;
}

export interface SimilarRequirementItem {
  requirementId: string;
  /** #1838 — the analysis run that holds it, for a link to its card. */
  analysisId: string;
  /** The requirement's display key (`REQ-003`, an imported item's id), when it has one. */
  key: string | null;
  title: string;
  /** Review status: `draft` | `approved` | `rejected` | `deferred`. */
  status: string;
  /** Cosine similarity of the two requirements' embeddings, 0..1. */
  score: number;
  label: SimilarRequirementLabel;
  codeLinks: SimilarRequirementCodeLink[];
  /**
   * #1838 — an analyst answered "Not a duplicate" for this pair. Always false
   * for draft text (there is no pair yet).
   */
  notDuplicate: boolean;
  /** #1838 — a `duplicates` link joins the pair already, in either direction. */
  linkedAsDuplicate: boolean;
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

// ---- Borrow a similar requirement's code links (#1839) ---------------------
//
//   POST /api/projects/:projectId/requirements/:requirementId/borrow-citations
//   { fromRequirementId, mappingIds? }
//   200  { success, data: BorrowCitationsResult }

/** The most mapping ids one borrow request may name. */
export const BORROW_CITATIONS_MAX_MAPPING_IDS = 200;

const borrowIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "invalid id");

export const borrowCitationsSchema = z
  .object({
    /** The similar requirement whose saved code links are copied (same project). */
    fromRequirementId: borrowIdSchema,
    /** Copy only these of its links; omitted = every link it holds. */
    mappingIds: z.array(borrowIdSchema).min(1).max(BORROW_CITATIONS_MAX_MAPPING_IDS).optional(),
  })
  .strict();

export type BorrowCitationsInput = z.infer<typeof borrowCitationsSchema>;

export interface BorrowCitationsResult {
  /** Links copied as `similar-requirement` suggestions. */
  copied: number;
  /**
   * Links not copied because they need a re-check first: `stale`, or
   * `unverified` (never checked against the code graph).
   */
  skippedStale: number;
  /** Links not copied because the requirement already holds the same code. */
  skippedDuplicate: number;
  /**
   * #1893 — the origin's links not copied because they were themselves
   * borrowed: a hypothesis is not lent on.
   */
  skippedBorrowed: number;
  /** #1893 — named `mappingIds` that match none of the origin requirement's links. */
  notFound: number;
}

/** #1893 — the 400 a requirement asked to borrow its own code links answers. */
export const BORROW_FROM_SELF_CODE = "BORROW_FROM_SELF";

/**
 * #1902 — the 409 a borrow answers when every attempt lost a write conflict to
 * a concurrent borrow: nothing was copied, and asking again is safe.
 */
export const BORROW_CONFLICT_CODE = "BORROW_CONFLICT";
