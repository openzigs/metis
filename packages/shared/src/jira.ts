/**
 * Jira integration schemas — Epic #556 (issues #558–#563).
 *
 * Shared between server (validation) and UI (form types / API contracts).
 */
import { z } from "zod";
import { idSchema, timestampsSchema, dateSchema } from "./common.js";

// ---- Constants -------------------------------------------------------------

export const JIRA_EDITIONS = ["cloud", "datacenter"] as const;
export type JiraEdition = (typeof JIRA_EDITIONS)[number];

export const JIRA_CONNECTION_STATUSES = ["untested", "ok", "error"] as const;
export type JiraConnectionStatus = (typeof JIRA_CONNECTION_STATUSES)[number];

// ---- Label / URL validators ------------------------------------------------

const jiraLabelSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _.\-]*$/, "invalid label");

const jiraUrlSchema = z
  .string()
  .url("must be a valid URL")
  .max(512)
  .refine((u) => u.startsWith("https://") || u.startsWith("http://"), "must start with http(s)://");

// ---- JiraConnection entity schema ------------------------------------------

export const jiraConnectionSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    label: jiraLabelSchema,
    edition: z.enum(JIRA_EDITIONS),
    baseUrl: jiraUrlSchema,
    username: z.string().min(1).max(256),
    secretId: idSchema,
    proxyUrl: jiraUrlSchema.nullable().default(null),
    tlsRejectUnauthorized: z.boolean().default(true),
    tlsCaSecretId: idSchema.nullable().default(null),
    status: z.enum(JIRA_CONNECTION_STATUSES).default("untested"),
    errorMessage: z.string().nullable().default(null),
    lastTestedAt: dateSchema.nullable().default(null),
    createdById: idSchema,
    deletedAt: dateSchema.nullable(),
  })
  .merge(timestampsSchema);
export type JiraConnection = z.infer<typeof jiraConnectionSchema>;

// ---- Create / Update input schemas -----------------------------------------

export const createJiraConnectionSchema = z.object({
  label: jiraLabelSchema,
  edition: z.enum(JIRA_EDITIONS),
  baseUrl: jiraUrlSchema,
  username: z.string().min(1).max(256),
  /** Raw API token / PAT — server stores in vault, returns secretId. */
  apiToken: z.string().min(1).max(1024),
  proxyUrl: jiraUrlSchema.nullable().optional(),
  tlsRejectUnauthorized: z.boolean().optional(),
  tlsCaCert: z.string().max(16_384).nullable().optional(),
});
export type CreateJiraConnectionInput = z.infer<typeof createJiraConnectionSchema>;

export const updateJiraConnectionSchema = z.object({
  label: jiraLabelSchema.optional(),
  edition: z.enum(JIRA_EDITIONS).optional(),
  baseUrl: jiraUrlSchema.optional(),
  username: z.string().min(1).max(256).optional(),
  /** When provided, rotates the secret in vault. */
  apiToken: z.string().min(1).max(1024).optional(),
  proxyUrl: jiraUrlSchema.nullable().optional(),
  tlsRejectUnauthorized: z.boolean().optional(),
  tlsCaCert: z.string().max(16_384).nullable().optional(),
});
export type UpdateJiraConnectionInput = z.infer<typeof updateJiraConnectionSchema>;

// ---- API response types (masked secrets) -----------------------------------

export interface JiraConnectionDetail {
  id: string;
  projectId: string;
  label: string;
  edition: JiraEdition;
  baseUrl: string;
  username: string;
  secretMasked: string; // "••••••••"
  proxyUrl: string | null;
  tlsRejectUnauthorized: boolean;
  hasTlsCa: boolean;
  status: JiraConnectionStatus;
  errorMessage: string | null;
  lastTestedAt: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Jira issue browsing types ---------------------------------------------

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  projectTypeKey: string;
  avatarUrl?: string;
}

export interface JiraSearchRequest {
  jql: string;
  startAt?: number;
  maxResults?: number;
  fields?: string[];
}

export const jiraSearchRequestSchema = z.object({
  jql: z.string().min(1).max(4096),
  startAt: z.number().int().min(0).default(0),
  maxResults: z.number().int().min(1).max(100).default(20),
  fields: z.array(z.string().max(128)).max(50).optional(),
});

export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: Record<string, unknown>;
}

export interface JiraSearchResult {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraIssue[];
}

export interface JiraIssueDetail {
  id: string;
  key: string;
  self: string;
  fields: Record<string, unknown>;
  renderedFields?: Record<string, unknown>;
}

export interface JiraTestResult {
  ok: boolean;
  serverInfo?: {
    version: string;
    baseUrl: string;
    serverTitle?: string;
    deploymentType?: string;
  };
  latencyMs: number;
  errorMessage?: string;
}
