/**
 * Test Coverage importer framework (Epic #856, issue #861).
 *
 * Each provider takes a raw input (buffer / string) and yields normalised
 * `NormalisedTestCase` records. The framework handles column mapping,
 * confidence scoring, PII redaction and content hashing centrally so providers
 * stay simple.
 */
export * from "./types.js";
export * from "./hash.js";
export * from "./normaliser.js";
export { csvProvider } from "./providers/csv-provider.js";
export { excelProvider } from "./providers/excel-provider.js";
export { docxProvider } from "./providers/docx-provider.js";
export { markdownProvider } from "./providers/markdown-provider.js";
export { gherkinProvider, parseFeature } from "./providers/gherkin-provider.js";
export { resolveProvider } from "./providers/registry.js";

// Phase 3 — external providers (issues #867 / #869 / #873 / #874)
export { importJiraTestCases } from "./providers/jira-provider.js";
export type {
  JiraFieldMapping,
  JiraImportOptions,
  JiraImportSummary,
} from "./providers/jira-provider.js";
export { XrayClient, importXrayTests } from "./providers/xray-provider.js";
export type { XrayImportOptions, XrayImportSummary } from "./providers/xray-provider.js";
export { importZephyrCases } from "./providers/zephyr-provider.js";
export type { ZephyrImportOptions, ZephyrImportSummary } from "./providers/zephyr-provider.js";
export { importTestRailCases, retryingFetch } from "./providers/testrail-provider.js";
export type {
  TestRailImportOptions,
  TestRailImportSummary,
} from "./providers/testrail-provider.js";

// Phase 3 — exporters (issues #866 / #867 / #869 / #874 / #876 / #877)
export type {
  ExportableSuggestion,
  CoverageReport,
  MatrixCell,
  RequirementCoverage,
  GapRow,
  ExporterPushResult,
  XrayConnectionConfig,
  ZephyrConnectionConfig,
  TestRailConnectionConfig,
} from "./exporters/types.js";
export { exportCoverageReportToExcel } from "./exporters/excel-exporter.js";
export { exportSuggestionsToGherkin } from "./exporters/gherkin-exporter.js";
export type {
  GherkinExportResult,
  GherkinExportSingle,
  GherkinExportZip,
} from "./exporters/gherkin-exporter.js";
export { exportSuggestionsToXray } from "./exporters/xray-exporter.js";
export type { XrayExportOptions } from "./exporters/xray-exporter.js";
export { exportSuggestionsToZephyr } from "./exporters/zephyr-exporter.js";
export type { ZephyrExportOptions } from "./exporters/zephyr-exporter.js";
export { exportSuggestionsToTestRail } from "./exporters/testrail-exporter.js";
export type { TestRailExportOptions } from "./exporters/testrail-exporter.js";
export { exportSuggestionsToGithub, renderTestCaseBody } from "./exporters/github-exporter.js";
export type { GithubExportOptions, GithubExportResult } from "./exporters/github-exporter.js";

// Epic #260 — Playwright POM scaffold generator (issue #44)
export { exportSuggestionsToPlaywrightPom } from "./exporters/playwright-pom-exporter.js";
export type {
  PlaywrightPomExportResult,
  PlaywrightPomExportOptions,
} from "./exporters/playwright-pom-exporter.js";

// Epic #260 — JUnit round-trip parser + coverage status update (issue #45)
export {
  parseJUnitXml,
  JunitParseError,
  JUNIT_MAX_BYTES,
  JUNIT_MAX_CASES,
} from "./junit-parser.js";
export type { JunitTestResult, JunitStatus } from "./junit-parser.js";
export { applyJunitResults, normaliseTestName } from "./junit-roundtrip.js";
export type { JunitUploadSummary, CoverageVerdict } from "./junit-roundtrip.js";
