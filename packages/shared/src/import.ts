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
  /**
   * Issue #1006 — keep only issues whose title starts with one of these
   * prefixes (case-insensitive), and strip the matched prefix from the imported
   * title. For trackers that mark a type with a title tag such as `[Feature]:`
   * rather than a label. Plain prefixes, never patterns: no regex reaches the server.
   */
  titlePrefixes: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
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

/** Matches a whole `${vault:label}` reference (the shape the vault resolver accepts). */
const VAULT_REF_SHAPE = /^\$\{vault:([^}]+)\}$/;

/**
 * #763 — a pasted API token. A `${vault:…}` reference here used to be stored
 * as the literal token; it now belongs in `secretRef`, so it is refused rather
 * than silently vaulted as plaintext.
 */
const tokenSchema = z
  .string()
  .min(1)
  .max(8192)
  .refine((v) => !v.trim().startsWith("${vault:"), {
    message: "send a ${vault:label} reference as secretRef, not as token",
  });

/** #763 — a reference to an EXISTING vault secret, resolved server-side. */
export const importSecretRefSchema = z
  .string()
  .max(512)
  .refine((v) => (VAULT_REF_SHAPE.exec(v)?.[1] ?? "").trim().length > 0, {
    message: "secretRef must be written as ${vault:label}",
  });

/** #763 — a request names at most one credential: a pasted token or a vault ref. */
function oneCredential(v: { token?: string; secretRef?: string }): boolean {
  return !(v.token && v.secretRef);
}
const ONE_CREDENTIAL = {
  message: "provide either token or secretRef, not both",
  path: ["secretRef"],
};

/** Preview request: validate config + creds without persisting. */
export const importPreviewRequestSchema = z
  .object({
    source: z.enum(IMPORT_SOURCES),
    // `.optional()`: zod 4 rejects an absent `z.unknown()` key, zod 3 admitted it (#309).
    filter: z.unknown().optional(),
    /** API token for github/azure-devops/linear (not needed for jira reuse). */
    token: tokenSchema.optional(),
    /** #763 — `${vault:label}` of an existing vault secret, instead of `token`. */
    secretRef: importSecretRefSchema.optional(),
    baseUrl: baseUrlSchema.optional(),
  })
  .refine(oneCredential, ONE_CREDENTIAL);
export type ImportPreviewRequest = z.infer<typeof importPreviewRequestSchema>;

/** Create a saved import source (and kick off the first run). */
export const createImportSourceSchema = z
  .object({
    source: z.enum(IMPORT_SOURCES),
    label: z.string().min(1).max(200),
    // `.optional()`: zod 4 rejects an absent `z.unknown()` key, zod 3 admitted it (#309).
    filter: z.unknown().optional(),
    token: tokenSchema.optional(),
    /** #763 — `${vault:label}` of an existing vault secret, instead of `token`. */
    secretRef: importSecretRefSchema.optional(),
    baseUrl: baseUrlSchema.optional(),
    syncEnabled: z.boolean().default(false),
    syncIntervalMinutes: z
      .number()
      .int()
      .min(IMPORT_SYNC_MIN_INTERVAL_MINUTES)
      .max(IMPORT_SYNC_MAX_INTERVAL_MINUTES)
      .default(IMPORT_SYNC_DEFAULT_INTERVAL_MINUTES),
  })
  .refine(oneCredential, ONE_CREDENTIAL);
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
  /**
   * #763 — non-fatal notes, e.g. that an unauthenticated GitHub preview is
   * subject to the anonymous rate limit. Never carries credential material.
   */
  warnings?: string[];
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
  /**
   * #763 — true when the token is an existing vault secret the source refers
   * to (chosen by `${vault:label}`), rather than one it vaulted for itself.
   */
  usesVaultSecret: boolean;
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
