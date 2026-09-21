/**
 * Jira importer — issue #779.
 *
 * Reuses an existing Jira connection's client (Cloud v3 / Data Center v2 is
 * handled inside the shared JiraClient) and paginates a JQL query. Supports an
 * optional custom-field remap so non-standard Jira fields can drive the
 * requirement title/body/type/priority.
 */
import type { JiraFilter, JiraSearchResult } from "@metis/shared";
import { defaultMap, normalizePriority, normalizeType } from "./base-importer.js";
import type { ExternalIssue, Importer, ImporterFetchContext, MappedRequirement } from "./types.js";

/** The slice of JiraClient this importer depends on (keeps it testable). */
export interface JiraSearchClient {
  searchIssues(
    jql: string,
    opts: { startAt?: number; maxResults?: number; fields?: string[] },
  ): Promise<JiraSearchResult>;
}

export interface JiraImporterConfig {
  client: JiraSearchClient;
  baseUrl: string;
  customFieldMap?: Record<string, string>;
  pageSize?: number;
}

const BASE_FIELDS = ["summary", "description", "labels", "issuetype", "priority"];

function fieldToString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  // Atlassian Document Format / nested objects — serialise readable text.
  if (typeof value === "object") {
    const obj = value as { content?: unknown; text?: string; name?: string };
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.name === "string") return obj.name;
    return JSON.stringify(value);
  }
  return String(value);
}

export class JiraImporter implements Importer<JiraFilter> {
  readonly kind = "jira" as const;

  constructor(private readonly config: JiraImporterConfig) {}

  private fields(filter: JiraFilter): string[] {
    const custom = Object.values({ ...filter.customFieldMap, ...this.config.customFieldMap });
    return Array.from(new Set([...BASE_FIELDS, ...custom]));
  }

  async count(filter: JiraFilter): Promise<number> {
    const res = await this.config.client.searchIssues(filter.jql, { startAt: 0, maxResults: 0 });
    return res.total;
  }

  async *fetchAll(filter: JiraFilter, ctx?: ImporterFetchContext): AsyncGenerator<ExternalIssue> {
    const pageSize = this.config.pageSize ?? 100;
    const fields = this.fields(filter);
    let startAt = 0;
    let fetched = 0;
    let page = 0;
    for (;;) {
      if (ctx?.signal?.aborted) return;
      page += 1;
      const res = await this.config.client.searchIssues(filter.jql, {
        startAt,
        maxResults: pageSize,
        fields,
      });
      for (const issue of res.issues) {
        fetched += 1;
        yield this.toExternal(issue, filter);
      }
      ctx?.onProgress?.({ fetched, page });
      startAt += res.issues.length;
      if (res.issues.length === 0 || startAt >= res.total) return;
    }
  }

  private toExternal(
    issue: { key: string; fields: Record<string, unknown> },
    filter: JiraFilter,
  ): ExternalIssue {
    const map = { ...filter.customFieldMap, ...this.config.customFieldMap };
    const fields = issue.fields;
    const title = map.title ? fieldToString(fields[map.title]) : fieldToString(fields.summary);
    const body = map.body ? fieldToString(fields[map.body]) : fieldToString(fields.description);
    const issuetype = fields.issuetype as { name?: string } | undefined;
    const priority = fields.priority as { name?: string } | undefined;
    const labels = Array.isArray(fields.labels) ? (fields.labels as string[]) : [];
    return {
      externalId: issue.key,
      externalSource: "jira",
      url: `${this.config.baseUrl.replace(/\/+$/, "")}/browse/${issue.key}`,
      title,
      body,
      labels,
      type: map.type ? fieldToString(fields[map.type]) : issuetype?.name,
      priority: map.priority ? fieldToString(fields[map.priority]) : priority?.name,
    };
  }

  map(issue: ExternalIssue): MappedRequirement {
    const mapped = defaultMap(issue);
    // Jira issue types map more directly than label-derived heuristics.
    mapped.type = normalizeType(issue.type, issue.labels);
    mapped.priority = normalizePriority(issue.priority, issue.labels);
    return mapped;
  }
}
