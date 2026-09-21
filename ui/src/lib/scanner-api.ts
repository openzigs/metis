/**
 * Epic #708 — AI Bug Scanner client.
 *
 * Wraps the server API routes added in:
 *   - server/src/routes/rules.ts
 *   - server/src/routes/scans.ts
 *   - server/src/routes/triage.ts
 */
import { apiFetch } from "./api-client";

export type ScannerSeverity = "critical" | "high" | "medium" | "low" | "info";
export type RuleStatus = "draft" | "compiling" | "awaiting_grading" | "active" | "failed";
export type TriageStatus = "pending" | "approved" | "rejected" | "deferred";
export type ScanMode = "rules" | "heuristic" | "both" | "spec";

export interface RuleSet {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  isActive: boolean;
  rules: Rule[];
}

export interface Rule {
  id: string;
  ruleSetId: string;
  naturalLanguage: string;
  status: RuleStatus;
  severity: ScannerSeverity;
  category: string;
  errorMessage: string | null;
  compiledMeta: string | null;
  exemplarGrades: string | null;
}

export interface Scan {
  id: string;
  projectId: string;
  repoConnectionId: string;
  commitSha: string;
  status: string;
  mode: ScanMode;
  startedAt: string | null;
  completedAt: string | null;
  totalSymbols: number;
  scannedSymbols: number;
  totalTokens: number;
  costCents: number | null;
  budgetCapTokens: number;
  errorMessage: string | null;
  createdAt: string;
  /**
   * Issue #422 — scheduler task id driving an in-flight scan, surfaced so the
   * UI can `subscribe:task` for live `task:progress` / `task:status` events.
   * `null` for terminal scans (no live task) or older API responses.
   */
  taskId?: string | null;
}

export interface ScanFinding {
  id: string;
  scanId: string;
  ruleId: string | null;
  symbolId: string;
  title: string;
  body: string;
  severity: ScannerSeverity;
  category: string;
  evidenceLines: string;
  fingerprint: string;
  confidence: number;
  triageStatus: TriageStatus;
  triageNote: string | null;
  materializedFindingId: string | null;
  symbol?: { qualifiedName: string; filePath: string } | null;
  issueLinks?: Array<{
    id: string;
    provider: string;
    externalId: string;
    externalUrl: string;
  }>;
}

export interface IssueLink {
  id: string;
  scanFindingId: string;
  provider: "github" | "jira";
  externalId: string;
  externalUrl: string;
  fingerprint: string;
}

export interface ExemplarGrade {
  codeSnippet: string;
  language: string;
  expectedFinding: boolean;
  humanGrade: "true_positive" | "false_positive" | "ambiguous";
  note?: string;
}

export const scannerApi = {
  // ----- rule sets -----
  listRuleSets: (projectId: string) => apiFetch<RuleSet[]>(`/projects/${projectId}/rule-sets`),
  createRuleSet: (projectId: string, body: { name: string; description?: string }) =>
    apiFetch<RuleSet>(`/projects/${projectId}/rule-sets`, { method: "POST", body }),

  // ----- rules -----
  createRule: (
    projectId: string,
    ruleSetId: string,
    body: { naturalLanguage: string; severity?: ScannerSeverity; category?: string },
  ) =>
    apiFetch<Rule>(`/projects/${projectId}/rule-sets/${ruleSetId}/rules`, {
      method: "POST",
      body,
    }),
  compileRule: (projectId: string, ruleSetId: string, ruleId: string) =>
    apiFetch<Rule>(`/projects/${projectId}/rule-sets/${ruleSetId}/rules/${ruleId}/compile`, {
      method: "POST",
    }),
  gradeRule: (
    projectId: string,
    ruleSetId: string,
    ruleId: string,
    body: { exemplars: ExemplarGrade[] },
  ) =>
    apiFetch<Rule>(`/projects/${projectId}/rule-sets/${ruleSetId}/rules/${ruleId}/grade`, {
      method: "POST",
      body,
    }),

  // ----- scans -----
  startScan: (
    projectId: string,
    repoConnectionId: string,
    body: { mode?: ScanMode; budgetCapTokens?: number },
  ) =>
    apiFetch<Scan>(`/projects/${projectId}/repositories/${repoConnectionId}/scans`, {
      method: "POST",
      body,
    }),
  /** List all scans for the project (cross-repo). */
  listProjectScans: (projectId: string) =>
    apiFetch<Array<Scan & { findingCount: number }>>(`/projects/${projectId}/scans`),
  /** List scans for a specific repository connection. */
  listScans: (projectId: string, repoConnectionId: string) =>
    apiFetch<Scan[]>(`/projects/${projectId}/repositories/${repoConnectionId}/scans`),
  /**
   * Epic #708 — lightweight gate the scanner CTA calls before enabling
   * "Scan for bugs". `indexed=false` means the repository has no code
   * graph rows yet (run the ingest first).
   */
  getIndexStatus: (projectId: string, repoConnectionId: string) =>
    apiFetch<{
      indexed: boolean;
      commitSha: string | null;
      lastIndexedAt: string | null;
      symbolCount: number;
    }>(`/projects/${projectId}/repositories/${repoConnectionId}/scans/index-status`),
  getScan: (projectId: string, scanId: string) =>
    apiFetch<Scan>(`/projects/${projectId}/scans/${scanId}`),

  // ----- triage / publish -----
  listFindings: (projectId: string, scanId: string) =>
    apiFetch<ScanFinding[]>(`/projects/${projectId}/scans/${scanId}/findings`),
  triage: (
    projectId: string,
    scanId: string,
    findingId: string,
    body: { decision: "approved" | "rejected" | "deferred"; note?: string },
  ) =>
    apiFetch<{
      scanFindingId: string;
      newStatus: TriageStatus;
      materializedFindingId: string | null;
    }>(`/projects/${projectId}/scans/${scanId}/findings/${findingId}/triage`, {
      method: "POST",
      body,
    }),
  publish: (
    projectId: string,
    scanId: string,
    findingId: string,
    body: { provider: "github" | "jira"; extraLabels?: string[] },
  ) =>
    apiFetch<IssueLink>(`/projects/${projectId}/scans/${scanId}/findings/${findingId}/publish`, {
      method: "POST",
      body,
    }),
};
