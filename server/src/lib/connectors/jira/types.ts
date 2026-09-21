/**
 * Jira connector types — Epic #556 / Issue #559.
 */
import type {
  JiraEdition,
  JiraConnectionStatus,
  JiraProject,
  JiraSearchResult,
  JiraIssueDetail,
  JiraTestResult,
} from "@metis/shared";

export interface JiraClientConfig {
  edition: JiraEdition;
  baseUrl: string;
  username: string;
  apiToken: string;
  proxyUrl?: string | null;
  tlsRejectUnauthorized?: boolean;
  tlsCaCert?: string | null;
}

export interface JiraServerInfo {
  version: string;
  baseUrl: string;
  serverTitle?: string;
  deploymentType?: string;
}

export interface JiraSearchOptions {
  startAt?: number;
  maxResults?: number;
  fields?: string[];
  expand?: string[];
}

export interface JiraCreateIssueFields {
  project: { key: string };
  summary: string;
  issuetype: { name: string };
  description?: unknown;
  [key: string]: unknown;
}

export {
  JiraEdition,
  JiraConnectionStatus,
  JiraProject,
  JiraSearchResult,
  JiraIssueDetail,
  JiraTestResult,
};
