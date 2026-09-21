/**
 * Epic #708 — AI Bug Scanner shared types & constants.
 *
 * The scanner is a *two-tier* LLM pipeline that consumes a project's
 * CodeGraph + RAG knowledge base and produces ScanFinding rows. A cheap
 * model (Haiku) does the first pass per symbol; an expensive model
 * (Sonnet) does a multi-vote false-positive filter. Only triage-approved
 * findings flow downstream as Finding + IssueLink rows.
 *
 * This module is dependency-free so it can be imported from both the
 * Express route layer and the task-scheduler handler without circular
 * imports.
 */

export type ScanMode = "rules" | "heuristic" | "both" | "spec";
export type ScanStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type RuleStatus = "draft" | "compiling" | "awaiting_grading" | "active" | "failed";
export type TriageStatus = "pending" | "approved" | "rejected" | "deferred";
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type ExemplarGrade = "positive" | "negative" | "unsure";
export type Publisher = "github" | "jira";

export interface CompiledRuleMeta {
  /** Lower-case keyword bag used as a coarse retrieval pre-filter. */
  keywords: string[];
  /** CodeSymbol.kind values the rule cares about (function, class, …). */
  symbolKinds: string[];
  /** Short natural-language exemplars the LLM uses as in-context anchors. */
  exemplars: string[];
}

export interface ExemplarGradeEntry {
  symbolId: string;
  grade: ExemplarGrade;
}

export interface CandidateFinding {
  ruleId: string | null;
  symbolId: string;
  qualifiedName: string;
  filePath: string;
  title: string;
  body: string;
  severity: Severity;
  category: string;
  /** 1-indexed line numbers inside the symbol's file. */
  evidenceLines: number[];
  /** First-pass self-reported confidence in [0,1]. */
  confidence: number;
}

export interface FpFilterVerdict {
  keep: boolean;
  confidence: number;
  rationale: string;
}

/** Minimum number of exemplars the user must grade before a rule activates. */
export const MIN_EXEMPLAR_GRADES = 5;

/** Confidence floor for promotion past the FP filter. */
export const FP_FILTER_MIN_CONFIDENCE = 0.5;

/** Self-consistency vote count for the FP filter. */
export const FP_FILTER_VOTE_COUNT = 2;

/** Default per-scan token budget. Aligned with Scan.budgetCapTokens default. */
export const DEFAULT_SCAN_TOKEN_BUDGET = 20_000_000;

/** Max tokens per per-symbol assembled context window. */
export const PER_SYMBOL_CONTEXT_TOKEN_CAP = 8000;

/** MVP languages — only symbols whose CodeSymbol.language is in this set are scanned. */
export const SCANNER_SUPPORTED_LANGUAGES = new Set([
  "go",
  "java",
  "py",
  "python",
  "ts",
  "typescript",
  "js",
  "javascript",
  "scala",
  "sql",
  "kt",
  "kotlin",
]);

export const SEVERITY_VALUES: readonly Severity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const;

export const TRIAGE_STATUS_VALUES: readonly TriageStatus[] = [
  "pending",
  "approved",
  "rejected",
  "deferred",
] as const;

export const RULE_STATUS_VALUES: readonly RuleStatus[] = [
  "draft",
  "compiling",
  "awaiting_grading",
  "active",
  "failed",
] as const;

export const SCAN_MODE_VALUES: readonly ScanMode[] = [
  "rules",
  "heuristic",
  "both",
  "spec",
] as const;

export const PUBLISHER_VALUES: readonly Publisher[] = ["github", "jira"] as const;

/** Array form of {@link SCANNER_SUPPORTED_LANGUAGES} for zod enum construction. */
export const SCANNER_SUPPORTED_LANGUAGES_ARRAY: readonly string[] = [
  "go",
  "java",
  "py",
  "python",
  "ts",
  "typescript",
  "js",
  "javascript",
  "scala",
  "sql",
  "kt",
  "kotlin",
] as const;

/** Marker injected into published issue bodies for idempotency lookups. */
export const SCANNER_PUBLISH_MARKER_PREFIX = "metis-finding";
