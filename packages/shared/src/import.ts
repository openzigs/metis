/**
 * Inbound importer schemas — Epic #776 (issues #777–#784).
 *
 * Shared between server (request validation, DTO shapes) and UI (form types /
 * API client contracts). Covers the four supported trackers — GitHub, Jira,
 * Azure DevOps and Linear — plus the saved-import config and run-history DTOs.
 */
import { z } from "zod";

// ---- Sources ---------------------------------------------------------------

export const IMPORT_SOURCES = ["github", "jira", "azure-devops", "linear"] as const;
export type ImportSourceKind = (typeof IMPORT_SOURCES)[number];

export const IMPORT_RUN_STATUSES = ["pending", "running", "completed", "failed"] as const;
export type ImportRunStatus = (typeof IMPORT_RUN_STATUSES)[number];

export const IMPORT_RUN_TRIGGERS = ["manual", "scheduled"] as const;
export type ImportRunTrigger = (typeof IMPORT_RUN_TRIGGERS)[number];

/** Default + bounds for ongoing-sync cron interval (minutes). */
export const IMPORT_SYNC_MIN_INTERVAL_MINUTES = 5;
export const IMPORT_SYNC_DEFAULT_INTERVAL_MINUTES = 15;
export const IMPORT_SYNC_MAX_INTERVAL_MINUTES = 24 * 60; // daily

/** Auto-disable ongoing sync after this many consecutive failures (#782). */
export const IMPORT_SYNC_FAILURE_THRESHOLD = 3;

/** Number of items returned in a preview sample. */
export const IMPORT_PREVIEW_SAMPLE_SIZE = 10;

// ---- Per-source filters ----------------------------------------------------

const labelList = z.array(z.string().min(1).max(128)).max(100);

export const githubFilterSchema = z.object({
  owner: z.string().min(1).max(120),
  repo: z.string().min(1).max(120),
  labels: labelList.optional(),
  state: z.enum(["open", "closed", "all"]).default("open"),
});
export type GithubFilter = z.infer<typeof githubFilterSchema>;

export const jiraFilterSchema = z.object({
  connectionId: z.string().min(1),
  jql: z.string().min(1).max(4096),
  /** Optional Jira custom field id → requirement attribute remapping. */
  customFieldMap: z.record(z.string(), z.string()).optional(),
});
export type JiraFilter = z.infer<typeof jiraFilterSchema>;

export const azureDevopsFilterSchema = z.object({
  organization: z.string().min(1).max(200),
  project: z.string().min(1).max(200),
  workItemTypes: z.array(z.string().min(1).max(120)).max(50).optional(),
  wiql: z.string().max(8192).optional(),
});
export type AzureDevopsFilter = z.infer<typeof azureDevopsFilterSchema>;

export const linearFilterSchema = z.object({
  teamId: z.string().min(1).max(120),
  includeArchived: z.boolean().default(false),
  stateTypes: z.array(z.string().min(1).max(60)).max(20).optional(),
});
export type LinearFilter = z.infer<typeof linearFilterSchema>;

export type ImportFilter = GithubFilter | JiraFilter | AzureDevopsFilter | LinearFilter;

/** Validate + parse a raw filter object against the schema for `source`. */
export function parseImportFilter(source: ImportSourceKind, raw: unknown): ImportFilter {
  switch (source) {
    case "github":
      return githubFilterSchema.parse(raw);
    case "jira":
      return jiraFilterSchema.parse(raw);
    case "azure-devops":
      return azureDevopsFilterSchema.parse(raw);
    case "linear":
      return linearFilterSchema.parse(raw);
    default: {
      const exhaustive: never = source;
      throw new Error(`Unknown import source: ${String(exhaustive)}`);
    }
  }
}

// ---- Request payloads ------------------------------------------------------

const baseUrlSchema = z.string().url().max(2048);
const tokenSchema = z.string().min(1).max(8192);

/** Preview request: validate config + creds without persisting. */
export const importPreviewRequestSchema = z.object({
  source: z.enum(IMPORT_SOURCES),
  filter: z.unknown(),
  /** API token for github/azure-devops/linear (not needed for jira reuse). */
  token: tokenSchema.optional(),
  baseUrl: baseUrlSchema.optional(),
});
export type ImportPreviewRequest = z.infer<typeof importPreviewRequestSchema>;

/** Create a saved import source (and kick off the first run). */
export const createImportSourceSchema = z.object({
  source: z.enum(IMPORT_SOURCES),
  label: z.string().min(1).max(200),
  filter: z.unknown(),
  token: tokenSchema.optional(),
  baseUrl: baseUrlSchema.optional(),
  syncEnabled: z.boolean().default(false),
  syncIntervalMinutes: z
    .number()
    .int()
    .min(IMPORT_SYNC_MIN_INTERVAL_MINUTES)
    .max(IMPORT_SYNC_MAX_INTERVAL_MINUTES)
    .default(IMPORT_SYNC_DEFAULT_INTERVAL_MINUTES),
});
export type CreateImportSourceRequest = z.infer<typeof createImportSourceSchema>;

/** Toggle / reconfigure ongoing sync for an existing source. */
export const updateImportSyncSchema = z.object({
  syncEnabled: z.boolean(),
  syncIntervalMinutes: z
    .number()
    .int()
    .min(IMPORT_SYNC_MIN_INTERVAL_MINUTES)
    .max(IMPORT_SYNC_MAX_INTERVAL_MINUTES)
    .optional(),
});
export type UpdateImportSyncRequest = z.infer<typeof updateImportSyncSchema>;

// ---- DTOs ------------------------------------------------------------------

/** A single mapped requirement preview row. */
export interface MappedRequirementPreview {
  externalId: string;
  externalUrl: string;
  title: string;
  type: string;
  priority: string;
  labels: string[];
}

export interface ImportPreview {
  source: ImportSourceKind;
  count: number;
  sample: MappedRequirementPreview[];
}

export interface ImportRunView {
  id: string;
  importSourceId: string;
  projectId: string;
  trigger: ImportRunTrigger;
  status: ImportRunStatus;
  taskId: string | null;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  totalFetched: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ImportSourceView {
  id: string;
  projectId: string;
  analysisId: string;
  source: ImportSourceKind;
  label: string;
  filter: ImportFilter;
  baseUrl: string | null;
  jiraConnectionId: string | null;
  /** True when an API token is stored (the token itself is never returned). */
  hasToken: boolean;
  syncEnabled: boolean;
  syncIntervalMinutes: number;
  consecutiveFailures: number;
  disabledReason: string | null;
  lastRunAt: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  /** Most recent run, when available. */
  lastRun?: ImportRunView | null;
}
