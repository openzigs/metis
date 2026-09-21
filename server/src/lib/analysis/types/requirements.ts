/**
 * Types for the Requirements Enhancement pipeline (Epic #597).
 *
 * Covers structured requirements extraction (#622), web research
 * augmentation (#623), clarification dialog (#624), and human
 * approval checkpoints (#626).
 */

// ── Structured Requirements (#622) ─────────────────────────────────────

export type RequirementEnhancementType =
  | "functional"
  | "non-functional"
  | "constraint"
  | "assumption"
  | "dependency";

export type RequirementEnhancementPriority = "must-have" | "should-have" | "nice-to-have";

export interface Ambiguity {
  field: string;
  description: string;
  suggestedQuestion: string;
}

export interface EvidenceNeed {
  id: string;
  description: string;
  domain: string;
  searchHints: string[];
}

export interface StructuredRequirement {
  id: string;
  title: string;
  description: string;
  type: RequirementEnhancementType;
  stakeholders: string[];
  priority: RequirementEnhancementPriority;
  ambiguities: Ambiguity[];
  evidenceNeeds: EvidenceNeed[];
  rawSource: string;
}

export interface StructuredRequirements {
  requirements: StructuredRequirement[];
  totalAmbiguities: number;
  totalEvidenceNeeds: number;
}

// ── Web Research (#623) ────────────────────────────────────────────────

export type DomainTrust = "high" | "medium" | "low";

export interface WebSource {
  url: string;
  title: string;
  excerpt: string;
  relevanceScore: number;
  domainTrust: DomainTrust;
}

export interface EvidenceDigest {
  id: string;
  requirementId: string;
  evidenceNeedId: string;
  query: string;
  sources: WebSource[];
  digest: string;
  needsHumanReview: boolean;
}

export interface WebResearchResult {
  digests: EvidenceDigest[];
  totalSources: number;
  reviewRequired: number;
}

/** Pluggable web search provider interface. */
export interface WebSearchProvider {
  search(query: string, maxResults?: number): Promise<WebSearchHit[]>;
}

export interface WebSearchHit {
  url: string;
  title: string;
  snippet: string;
  score?: number;
}

// ── Clarification Dialog (#624) ────────────────────────────────────────

/**
 * A single piece of project knowledge that supports a grounded clarifying
 * question's suggested answer (self-resolution pass).
 */
export interface GroundingCitation {
  source: string;
  snippet: string;
  documentId?: string;
  chunkId?: string;
  score?: number;
}

export interface ClarifyingQuestion {
  id: string;
  requirementId: string;
  ambiguityField: string;
  question: string;
  context: string;
  /**
   * Self-resolution status from the retrieval-grounded grounding pass.
   * Absent (undefined) is treated as "open" everywhere for back-compat.
   *   - grounded: project knowledge answers it — `groundedAnswer` + citations set.
   *   - partial:  project knowledge partially answers it — residual still asked.
   *   - open:     not answerable from project knowledge — plain blank question.
   */
  groundingStatus?: "grounded" | "partial" | "open";
  /** Suggested answer text; absent when status is "open". */
  groundedAnswer?: string;
  /** Supporting citations; never empty when an answer is present. */
  groundingCitations?: GroundingCitation[];
  /**
   * Issue #1104 (finding C) — the answer the user actually submitted for this
   * question, stamped onto the question when the round is answered. The round's
   * `answers[]` array remains the durable record; this field makes a persisted
   * round self-describing so a reloaded dialog can render the Q&A back to the
   * user instead of showing an unanswered-looking form.
   */
  answer?: string;
}

export interface ClarificationAnswer {
  questionId: string;
  answer: string;
}

export interface ClarificationRound {
  round: number;
  questions: ClarifyingQuestion[];
  answers: ClarificationAnswer[];
}

export interface ClarificationState {
  analysisId: string;
  currentRound: number;
  maxRounds: number;
  rounds: ClarificationRound[];
  /**
   * `reqId:field` keys the RESOLUTION MODEL confirmed it could close from the
   * user's answer, after #1104's real-field/answered-field filter. This is a
   * model judgement and it is routinely stingy — see `answeredAmbiguities`.
   */
  resolvedAmbiguities: string[];
  /**
   * Issue #1117 (finding A) — `reqId:field` keys the USER actually answered.
   *
   * Deterministic: a key lands here when a non-blank answer arrives for a
   * question whose `ambiguityField` is a real ambiguity of its requirement. No
   * model is consulted, so no model failure can lose it.
   *
   * This exists because `resolvedAmbiguities` was being asked to carry two
   * different facts at once. In the run that filed #1117 the user answered 14
   * questions and the resolution model returned exactly ONE `resolvedFields`
   * entry that survived the filter — so the panel reported "1 resolved / 13
   * remaining" and re-presented all 14 questions under a Round 2 heading. The
   * answers had persisted correctly; the accounting had not.
   *
   * Loosening #1104's filter was the wrong fix (it exists because the model
   * over-claimed 40 resolutions for 12 ambiguities, which drove the count
   * negative and hid the whole panel). The right fix is to stop deriving
   * user-facing behaviour — what to ask next, when the dialog is done, what the
   * panel says — from a model's opinion of its own work.
   *
   * Optional so states persisted before #1117 still load.
   */
  answeredAmbiguities?: string[];
  escalatedToSonnet: boolean;
  completed: boolean;
}

/**
 * Issue #1117 (finding A) — the set of ambiguities that must NOT be asked about
 * again: everything the user answered, plus everything the model closed.
 *
 * Used for question generation, the completion check and the panel's progress
 * copy. `resolvedAmbiguities` alone is deliberately still used for the Sonnet
 * escalation ratio, because THAT decision is about the resolution model's
 * competence and is the one place its own judgement is the right input.
 */
export function addressedAmbiguities(state: {
  resolvedAmbiguities: string[];
  answeredAmbiguities?: string[];
}): Set<string> {
  return new Set([...state.resolvedAmbiguities, ...(state.answeredAmbiguities ?? [])]);
}

/**
 * Issue #1116 — durable accounting of what the last clarification-enrichment
 * pass did with the user's answers. Persisted to
 * `Analysis.metadata.clarificationApplication` (additive, no migration) so the
 * UI can state plainly which answers reach a published issue and which only
 * shape the analysis shown on screen. Computed in `clarification-enrichment.ts`;
 * declared here so the metadata writer needs no import from it.
 */
export interface ClarificationApplication {
  /** Non-blank answers found across every round. */
  answeredCount: number;
  /** Answers written into a persisted requirement's body. */
  appliedCount: number;
  /** Answers with no requirement to attach to (see `requirementsAvailable`). */
  unattributedCount: number;
  /** Distinct `Requirement` rows whose body changed in this pass. */
  requirementsUpdated: number;
  /**
   * Whether any `Requirement` row existed when this ran. `false` means the
   * approval gate is still withholding them — the answers are not lost, they
   * are applied at promotion.
   */
  requirementsAvailable: boolean;
  /** ISO timestamp of the pass. */
  updatedAt: string;
}

// ── Approval Checkpoint (#626) ─────────────────────────────────────────

export type ApprovalStatus = "pending" | "approved" | "rejected";
export type ApprovalType = "evidence" | "clarification" | "requirement";

export interface ApprovalRequestInput {
  analysisId: string;
  type: ApprovalType;
  itemId: string;
}

export interface ApprovalReview {
  status: ApprovalStatus;
  reviewerId: string;
  reviewNote?: string;
}

// ── Enhancement Pipeline ───────────────────────────────────────────────

export type EnhancementStep =
  | "extraction"
  | "web-research"
  | "clarification"
  | "approval"
  | "complete";

export interface EnhancementConfig {
  enableWebResearch: boolean;
  enableClarification: boolean;
}

export interface EnhancementProgress {
  currentStep: EnhancementStep;
  stepsCompleted: EnhancementStep[];
  totalSteps: number;
  percentComplete: number;
}
