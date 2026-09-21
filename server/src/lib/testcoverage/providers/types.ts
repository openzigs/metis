import type { NormalisedTestCase, TestCaseSource } from "@metis/shared";

export interface ImportProviderContext {
  /** Logical filename or external label (used for error messages only). */
  readonly label: string;
  /**
   * Optional explicit column-name → canonical-field map for tabular providers
   * (CSV/Excel). Use this to bypass fuzzy matching when the auto-detect
   * confidence is too low.
   */
  readonly columnOverrides?: Readonly<Record<string, CanonicalColumn>>;
}

export interface ImportProviderResult {
  readonly cases: NormalisedTestCase[];
  /** Best-effort confidence ∈ [0,1] for any column-mapping the provider did. */
  readonly confidence: number;
  /** Diagnostic notes the caller can surface in the import preview. */
  readonly notes: string[];
}

export interface ImportProvider {
  readonly source: TestCaseSource;
  /**
   * @throws ColumnMappingRequiredError when column-mapping confidence falls
   *         below the framework threshold and the caller did not supply
   *         explicit `columnOverrides`.
   */
  parse(
    input: Buffer | string,
    ctx: ImportProviderContext,
  ): Promise<ImportProviderResult> | ImportProviderResult;
}

/** Canonical tabular column names recognised by CSV/Excel providers. */
export const CANONICAL_COLUMNS = [
  "externalId",
  "title",
  "preconditions",
  "steps",
  "expected",
  "priority",
  "tags",
] as const;
export type CanonicalColumn = (typeof CANONICAL_COLUMNS)[number];

export const MIN_COLUMN_MAPPING_CONFIDENCE = 0.7;

/** Aliases the framework will try when auto-mapping unknown column headers. */
export const COLUMN_ALIASES: Record<CanonicalColumn, readonly string[]> = {
  externalId: ["id", "external id", "external_id", "key", "tc id", "tc_id", "test id"],
  title: ["title", "name", "summary", "test name", "test case", "test_case", "scenario"],
  preconditions: ["preconditions", "pre-conditions", "given", "setup", "preconditions/setup"],
  steps: ["steps", "test steps", "actions", "step", "when"],
  expected: ["expected", "expected result", "expected results", "then", "outcome"],
  priority: ["priority", "severity", "importance"],
  tags: ["tags", "labels", "components", "tag"],
} as const;

export class ColumnMappingRequiredError extends Error {
  public readonly suggestion: Record<string, CanonicalColumn | null>;
  public readonly confidence: number;

  constructor(suggestion: Record<string, CanonicalColumn | null>, confidence: number) {
    super(
      `Column mapping confidence ${confidence.toFixed(2)} is below threshold; please confirm mappings.`,
    );
    this.name = "ColumnMappingRequiredError";
    this.suggestion = suggestion;
    this.confidence = confidence;
  }
}
