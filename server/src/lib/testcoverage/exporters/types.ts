/**
 * Shared types for Test Coverage exporters (Epic #856 Phase 3 — issues
 * #866, #867, #869, #874, #876, #877).
 *
 * Exporters take a list of `ExportableSuggestion` (a subset of the
 * persisted `SuggestionDto`) plus per-target connection config and produce
 * either:
 *
 *   - a byte stream (Excel, Gherkin zip)
 *   - a side-effect on a remote system (Xray / Zephyr / TestRail / GitHub)
 *
 * Every external-system exporter MUST authenticate via the existing vault
 * resolver, validate the host via `assertConnectorHostAllowed`, honour rate
 * limits with exponential backoff, and never log credentials.
 */
import type { Gwt, Priority, TestStep } from "@metis/shared";

/** Minimal suggestion shape required by every exporter. */
export interface ExportableSuggestion {
  readonly id: string;
  readonly title: string;
  readonly gwt: Gwt;
  readonly steps: ReadonlyArray<TestStep>;
  readonly priority?: Priority;
  readonly preconditions?: string;
  readonly expected?: string;
  readonly tags?: ReadonlyArray<string>;
  readonly mappedRequirementIds: ReadonlyArray<string>;
  readonly faithfulness: number;
  readonly lowConfidence: boolean;
}

/** Coverage matrix cell — used by the Excel exporter. */
export interface MatrixCell {
  readonly requirementId: string;
  readonly testCaseId: string;
  readonly score: number;
  readonly status: "covered" | "partial" | "uncovered";
}

/** Requirement coverage status — used by the Excel exporter. */
export interface RequirementCoverage {
  readonly requirementId: string;
  readonly title: string;
  readonly status: "covered" | "partial" | "uncovered";
  readonly bestScore: number;
}

/** Gap-list row — used by the Excel exporter. */
export interface GapRow {
  readonly requirementId: string;
  readonly title: string;
  readonly severity: Priority;
  readonly reason?: string;
}

/** Coverage-report payload consumed by `ExcelExporter`. */
export interface CoverageReport {
  readonly runId: string;
  readonly projectName: string;
  readonly generatedAt: string;
  readonly requirements: ReadonlyArray<RequirementCoverage>;
  readonly testCases: ReadonlyArray<{ id: string; title: string }>;
  readonly matrix: ReadonlyArray<MatrixCell>;
  readonly gaps: ReadonlyArray<GapRow>;
  readonly suggestions: ReadonlyArray<ExportableSuggestion>;
}

// ---- External provider connection configs ---------------------------------

/**
 * In-memory representation of an Xray Cloud connection. The persisted
 * `TestManagementConnection` row resolves to this shape via vault lookups
 * before any HTTP call is made.
 */
export interface XrayConnectionConfig {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly proxyUrl?: string;
}

/** In-memory representation of a Zephyr Scale Cloud connection. */
export interface ZephyrConnectionConfig {
  readonly baseUrl: string;
  /** Bearer JWT issued via Zephyr's user profile. */
  readonly bearerToken: string;
  readonly proxyUrl?: string;
}

/** In-memory representation of a TestRail connection. */
export interface TestRailConnectionConfig {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiKey: string;
  readonly proxyUrl?: string;
}

/** Result returned by external exporters. */
export interface ExporterPushResult {
  readonly created: ReadonlyArray<{ suggestionId: string; externalId: string }>;
  readonly failed: ReadonlyArray<{ suggestionId: string; reason: string }>;
  readonly skipped: ReadonlyArray<{ suggestionId: string; reason: string }>;
}

/**
 * Flatten a `Gwt` bucket (array of lines) to a single newline-joined string,
 * suitable for systems that accept a single rich-text/plain-text field.
 */
export function gwtBucketToText(bucket: ReadonlyArray<string> | string | undefined): string {
  if (!bucket) return "";
  const list = Array.isArray(bucket) ? bucket : [bucket as string];
  return list
    .flatMap((line) => line.split(/\r?\n/))
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
}
