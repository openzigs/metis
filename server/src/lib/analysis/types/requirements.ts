/**
 * Types for the Requirements Enhancement pipeline (Epic #597).
 *
 * Covers structured requirements extraction (#622), web research
 * augmentation (#623), clarification dialog (#624), and human
 * approval checkpoints (#626).
 */

import type { DocumentSource } from "../../documents/document-source.js";
import type { GoverningQuestionLink, SharedCriteriaRecord } from "@metis/shared";

// ── Structured Requirements (#622) ─────────────────────────────────────

export type RequirementEnhancementType =
  "functional" | "non-functional" | "constraint" | "assumption" | "dependency";

export type RequirementEnhancementPriority = "must-have" | "should-have" | "nice-to-have";

export interface Ambiguity {
  field: string;
  description: string;
  suggestedQuestion: string;
  /**
   * #2235 — set when the deterministic GtWR pass found it in the source text
   * (`requirement-quality-rules.ts`): the rule, and the source's own words.
   * Absent on an ambiguity the model raised.
   */
  rule?: "R7" | "R8" | "R9" | "TBD";
  term?: string;
}

/**
 * #2235 — the paragraph of the uploaded document a requirement rests on, as
 * the document reader verified it (#2230): the quote is the source's own text,
 * never the model's copy. Questions about the requirement cite it.
 */
export interface RequirementSourceSpan {
  /** The reader's statement label (`REQ-001`), which the extraction cites. */
  ref: string;
  documentId?: string;
  filename?: string;
  /** The section headings above the paragraph, outermost first. */
  headingPath: string[];
  quote: string;
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
  /**
   * #2235 — the document paragraphs this requirement rests on, when the
   * document reader read its source (`ANALYSIS_DOCUMENT_READER`). Its
   * clarifying questions are written from, and cite, these; the GtWR rules ran
   * over their quotes. Absent on the retrieval path.
   */
  sources?: RequirementSourceSpan[];
  /**
   * Issue #1569 — present only on a requirement the extraction did not list,
   * offered at the approval checkpoint from a synthesis item that matched
   * nothing in the reviewed list: that item's `synthesisItemKey`. Promotion
   * joins the item (its criteria and evidence) onto this requirement by it.
   */
  synthesisItemKey?: string;
  /**
   * Issue #1580 — the title the extraction gave it, kept the first time a
   * reviewer retitles it in the approval checkpoint. Synthesis wrote its items
   * against that title, so promotion's title join reads this one; the row is
   * still written with the reviewed `title`.
   */
  extractedTitle?: string;
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
  /**
   * Issue #1081 — the model's search queries could not be read (after one
   * re-prompt), so `query` is the evidence need's own description. Absent when
   * the model wrote the queries.
   */
  queryFallback?: boolean;
}

export interface WebResearchResult {
  digests: EvidenceDigest[];
  totalSources: number;
  reviewRequired: number;
  /**
   * #864 — set when research did not run at all (no web search provider is
   * configured), so the reason is stated once instead of once per need.
   */
  notice?: string;
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
  /** The cited document's name — a display label, not its classification. */
  source: string;
  /**
   * #573 — the cited document's `documents.source`, stamped when grounding ran.
   * The UI parses a `connector:repo:` name only when this is `repo`. Absent on
   * dialog state written before #573.
   */
  documentSource?: DocumentSource;
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
  /**
   * Issue #1081 — set when METIS could not check project knowledge for this
   * question: the model's grounding answer could not be read, or the check
   * failed. The question is then asked as an "open" one, but no model judged
   * it open, and the panel says so. Absent when the check ran.
   */
  groundingFailed?: boolean;
  /**
   * #2275 — true when METIS actually searched the project's documents and
   * code for this question (the grounding pass ran and did not fail). Absent
   * when no search ran: an ambiguity or silence is asked directly, and with
   * no retriever, or offline, nothing is searched. The panel says "searched"
   * only on this.
   */
  searched?: boolean;
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
  /**
   * #1873 — set when the question was asked to settle governing-rule
   * applicability: the requirement it was decided for and every rule the one
   * business fact settles. Absent on every ambiguity question.
   */
  governing?: GoverningQuestionLink;
  /**
   * #2235 — what kind of uncertainty the question is about. Missing knowledge
   * is searched for in the project first (the grounding pass); ambiguity and
   * silence are the author's to settle, so they are asked; an unanswerable one
   * is set aside as an open item. Absent on a question from before #2235, or
   * when the model did not say: it is then grounded and asked, as before.
   */
  uncertainty?: UncertaintyKind;
  /** #2235 — the plausible readings the analyst can pick from. */
  options?: string[];
  /** #2235 — how much of the solution the answer changes; rounds are ranked by it. */
  impact?: QuestionImpact;
  /**
   * #2235 — the paragraph of the source document the question is about, copied
   * from its requirement's verified source (never the model's words).
   */
  citation?: QuestionCitation;
}

export const UNCERTAINTY_KINDS = [
  "missing-knowledge",
  "ambiguity",
  "silence",
  "unanswerable",
] as const;
export type UncertaintyKind = (typeof UNCERTAINTY_KINDS)[number];

export const QUESTION_IMPACTS = ["high", "medium", "low"] as const;
export type QuestionImpact = (typeof QUESTION_IMPACTS)[number];

/** #2235 — a question's cited paragraph: a requirement source without its label. */
export type QuestionCitation = Omit<RequirementSourceSpan, "ref">;

/**
 * #2235 — a question the dialog did not ask, and why: no one available can
 * answer it now (`unanswerable`, an open item), or every plausible reading
 * builds the same thing (`same-outcome`). Kept on the state so the panel can
 * list it; nothing is dropped without a trace.
 */
export interface SetAsideQuestion {
  requirementId: string;
  ambiguityField: string;
  question: string;
  context: string;
  reason: "unanswerable" | "same-outcome";
  /** The round it was set aside in. */
  round: number;
  options?: string[];
  citation?: QuestionCitation;
}

export interface ClarificationAnswer {
  questionId: string;
  answer: string;
}

export interface ClarificationRound {
  round: number;
  questions: ClarifyingQuestion[];
  answers: ClarificationAnswer[];
  /**
   * Issue #1081 — ids of the requirements whose resolution answer could not
   * be read (or whose call failed) when this round's answers were submitted.
   * The answers still count; only the rewritten description is missing.
   * Absent when every resolution was read.
   */
  unreadResolutions?: string[];
  /**
   * #2235 — questions worth asking that did not fit this round's cap
   * (`MAX_QUESTIONS_PER_ROUND`). They stay open and are asked in a later
   * round; on the last round they are never asked, and this count says so.
   */
  notAsked?: number;
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
  /**
   * #2235 — the questions not asked, and why ({@link SetAsideQuestion}).
   * Optional so states persisted before #2235 still load.
   */
  setAside?: SetAsideQuestion[];
  /**
   * #2235 — `reqId:field` keys of the REAL ambiguities set aside. Like
   * `answeredAmbiguities`, only a field that is an ambiguity of its
   * requirement is counted, so a model that names a field of its own cannot
   * complete the dialog early.
   */
  setAsideAmbiguities?: string[];
  /**
   * #2236 — questions not asked because the project had already settled them:
   * an answer given in an earlier analysis (or an earlier round) of the same
   * project, read from its clarification record. Each counts as answered.
   * Optional so states persisted before #2236 still load.
   */
  reused?: ReusedAnswer[];
  escalatedToSonnet: boolean;
  completed: boolean;
}

/**
 * #2236 — a question this dialog did not ask because a clarification record of
 * the project already answers it ({@link ClarificationState.reused}).
 */
export interface ReusedAnswer {
  requirementId: string;
  ambiguityField: string;
  question: string;
  answer: string;
  /** The clarification record the answer was read from. */
  recordId: string;
  /** When the answer was given, ISO 8601. */
  answeredAt: string;
  /** The analysis it was given in; absent for a Spec Kit answer. */
  fromAnalysisId?: string;
  /** The round it was reused in. */
  round: number;
  citation?: QuestionCitation;
  /** Set when it settles governing rules rather than a requirement's wording. */
  governing?: GoverningQuestionLink;
}

/**
 * Issue #1117 (finding A) — the set of ambiguities that must NOT be asked about
 * again: everything the user answered, plus everything the model closed.
 * #2235 — and everything set aside as not worth asking.
 *
 * Used for question generation, the completion check and the panel's progress
 * copy. `resolvedAmbiguities` alone is deliberately still used for the Sonnet
 * escalation ratio, because THAT decision is about the resolution model's
 * competence and is the one place its own judgement is the right input.
 */
export function addressedAmbiguities(state: {
  resolvedAmbiguities: string[];
  answeredAmbiguities?: string[];
  setAsideAmbiguities?: string[];
}): Set<string> {
  return new Set([
    ...state.resolvedAmbiguities,
    ...(state.answeredAmbiguities ?? []),
    ...(state.setAsideAmbiguities ?? []),
  ]);
}

/**
 * Issue #1204 — what promotion's join could not decide, persisted to
 * `Analysis.metadata.promotionMatching` (additive, no migration). The title
 * join refuses a requirement whose items are too close to call rather than
 * guess (#1033), and that requirement is promoted with no acceptance criteria;
 * this record says why, so the requirement card can tell the analyst. Further
 * per-requirement facts about the join sit beside `ambiguous` as siblings.
 */
export interface PromotionMatchingRecord {
  /** How many promoted requirements were refused a match; mirrors `unattributedCount`. */
  ambiguousCount: number;
  /** One entry per refused requirement, keyed by the row it became. */
  ambiguous: AmbiguousPromotionRecord[];
  /**
   * Issue #1203 — one entry per promoted requirement whose criteria a synthesis
   * item wrote for it and other requirements together. Absent before #1203.
   */
  shared?: SharedCriteriaRecord[];
  /** ISO timestamp of the promotion that wrote it. */
  updatedAt: string;
}

/** Issue #1204 — one promoted requirement the join refused, and what it was level on. */
export interface AmbiguousPromotionRecord {
  /** The persisted `Requirement` row id. */
  requirementId: string;
  /** The reviewed (structured) requirement id it was promoted from. */
  structuredId: string;
  /** The grouped synthesis items it was level on, with their criteria to copy across. */
  candidates: Array<{ title: string; acceptanceCriteria: string[] }>;
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
  /**
   * #1204 — of `unattributedCount`, the answers whose requirement matched
   * several saved requirements equally well, so none was picked. Absent before.
   */
  ambiguousCount?: number;
  /**
   * #1162 — answers matched to a requirement whose clarifications block the
   * analyst edited out of shape, so they were not written. Absent before #1162.
   */
  blockEditedCount?: number;
  /**
   * #1162 — answers matched to a requirement that kept changing under the
   * write, or was deleted, so they were not written this pass. Absent before.
   */
  notWrittenCount?: number;
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
  /**
   * Issue #979 — per-answer outcome, so the UI can show WHICH answers were
   * applied and to which requirement, not only how many. `requirementTitle` is
   * `null` for an answer that was not written into any requirement. Absent on
   * metadata written before #979.
   */
  answers?: ClarificationAnswerOutcome[];
}

/** Issue #979 — what happened to one clarification answer. */
export interface ClarificationAnswerOutcome {
  questionId: string;
  /** The question text, shortened to keep the metadata blob small. */
  question: string;
  /** Title of the persisted requirement the answer was written into, or null. */
  requirementTitle: string | null;
  /** Issue #1000 — who wrote the answer. Absent on metadata written before #1000. */
  provenance?: AnswerProvenance;
  /**
   * #1162 — set when the answer was matched to a requirement but not written:
   * its clarifications block was edited out of shape (`requirementTitle` above
   * is then null).
   */
  notApplied?: {
    reason:
      "clarification-block-edited" | "requirement-changed-during-write" | "requirement-deleted";
    requirementTitle: string;
  };
  /**
   * #1204 — set when the answer was not applied because the match was too
   * close to call: the saved requirements (titles) its requirement was refused
   * among. One title means that saved requirement fitted this and another
   * reviewed requirement equally well, not that the answer fitted several.
   */
  ambiguousBetween?: string[];
}

/**
 * Issue #1000 — where a clarification answer came from:
 *   - `suggested`: METIS's grounded suggestion, submitted unchanged;
 *   - `edited`:    METIS's suggestion, changed by the requester before submitting;
 *   - `typed`:     no suggestion was offered; the requester wrote it.
 */
/** #2236 — `reused`: an answer the project had already given, read from its clarification record. */
export type AnswerProvenance = "suggested" | "edited" | "typed" | "reused";

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
  "extraction" | "web-research" | "clarification" | "approval" | "complete";

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
