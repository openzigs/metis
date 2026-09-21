/**
 * Azure DevOps Boards importer — issue #780.
 *
 * Resolves work-item ids via a WIQL query, batch-fetches the items with their
 * relations, and surfaces parent/child hierarchy (Hierarchy-Reverse) as
 * requirement parent links. PAT auth via HTTP Basic.
 */
import type { AzureDevopsFilter } from "@metis/shared";
import { fetchWithBackoff, type BackoffOptions } from "./http.js";
import { defaultMap } from "./base-importer.js";
import type {
  AssertHostAllowed,
  ExternalIssue,
  FetchFn,
  Importer,
  ImporterFetchContext,
  MappedRequirement,
} from "./types.js";

export interface AzureDevopsImporterConfig {
  token: string;
  baseUrl?: string | null;
  fetchFn?: FetchFn;
  assertHostAllowed?: AssertHostAllowed;
  /**
   * Factory that resolves a hostname to a pinned undici Dispatcher, defending
   * against DNS-rebind TOCTOU attacks. Takes priority over `assertHostAllowed`.
   * Omit in unit tests; registry.ts wires this for production.
   */
  pinnedDispatcherFor?: (hostname: string) => Promise<unknown>;
  backoff?: Pick<
    BackoffOptions,
    "maxRetries" | "baseDelayMs" | "maxDelayMs" | "sleep" | "now" | "random"
  >;
}

interface AdoWorkItemRef {
  id: number;
}
interface AdoRelation {
  rel: string;
  url: string;
}
interface AdoWorkItem {
  id: number;
  fields: Record<string, unknown>;
  relations?: AdoRelation[];
  _links?: { html?: { href?: string } };
}

const API_VERSION = "7.0";
const BATCH_SIZE = 200;

/** ADO numeric priority (1=highest) → requirement priority. */
function adoPriority(value: unknown): string | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  if (n <= 1) return "critical";
  if (n === 2) return "high";
  if (n === 3) return "medium";
  return "low";
}

export class AzureDevopsImporter implements Importer<AzureDevopsFilter> {
  readonly kind = "azure-devops" as const;

  /** Cached pinned dispatcher per-hostname (DNS-rebind TOCTOU protection). */
  private _guardedHostname: string | null = null;
  private _dispatcher: unknown = undefined;

  constructor(private readonly config: AzureDevopsImporterConfig) {}

  private get base(): string {
    return this.config.baseUrl?.replace(/\/+$/, "") ?? "https://dev.azure.com";
  }

  private headers(): Record<string, string> {
    const basic = Buffer.from(`:${this.config.token}`).toString("base64");
    return {
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
      "User-Agent": "metis-importer",
    };
  }

  private async guard(rawUrl: string): Promise<void> {
    const hostname = new URL(rawUrl).hostname;
    if (this.config.pinnedDispatcherFor) {
      if (hostname !== this._guardedHostname) {
        this._dispatcher = await this.config.pinnedDispatcherFor(hostname);
        this._guardedHostname = hostname;
      }
      return;
    }
    if (this.config.assertHostAllowed) {
      await this.config.assertHostAllowed(hostname);
    }
  }

  private backoffOpts(ctx?: ImporterFetchContext): BackoffOptions {
    return {
      fetchFn: this.config.fetchFn,
      dispatcher: this._dispatcher,
      signal: ctx?.signal,
      ...this.config.backoff,
    };
  }

  private wiql(filter: AzureDevopsFilter): string {
    if (filter.wiql) return filter.wiql;
    const clauses = [`[System.TeamProject] = '${filter.project.replace(/'/g, "''")}'`];
    if (filter.workItemTypes?.length) {
      const types = filter.workItemTypes.map((t) => `'${t.replace(/'/g, "''")}'`).join(", ");
      clauses.push(`[System.WorkItemType] IN (${types})`);
    }
    return `SELECT [System.Id] FROM workitems WHERE ${clauses.join(" AND ")} ORDER BY [System.Id]`;
  }

  private async queryIds(filter: AzureDevopsFilter, ctx?: ImporterFetchContext): Promise<number[]> {
    const url = `${this.base}/${encodeURIComponent(filter.organization)}/${encodeURIComponent(
      filter.project,
    )}/_apis/wit/wiql?api-version=${API_VERSION}`;
    await this.guard(url);
    const res = await fetchWithBackoff(
      url,
      {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ query: this.wiql(filter) }),
      },
      this.backoffOpts(ctx),
    );
    const json = (await res.json()) as { workItems?: AdoWorkItemRef[] };
    return (json.workItems ?? []).map((w) => w.id);
  }

  async count(filter: AzureDevopsFilter, ctx?: ImporterFetchContext): Promise<number> {
    const ids = await this.queryIds(filter, ctx);
    return ids.length;
  }

  async *fetchAll(
    filter: AzureDevopsFilter,
    ctx?: ImporterFetchContext,
  ): AsyncGenerator<ExternalIssue> {
    const ids = await this.queryIds(filter, ctx);
    let fetched = 0;
    let page = 0;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      if (ctx?.signal?.aborted) return;
      page += 1;
      const batch = ids.slice(i, i + BATCH_SIZE);
      const url = `${this.base}/${encodeURIComponent(
        filter.organization,
      )}/_apis/wit/workitems?ids=${batch.join(",")}&$expand=relations&api-version=${API_VERSION}`;
      const res = await fetchWithBackoff(
        url,
        { method: "GET", headers: this.headers() },
        this.backoffOpts(ctx),
      );
      const json = (await res.json()) as { value?: AdoWorkItem[] };
      for (const item of json.value ?? []) {
        fetched += 1;
        yield this.toExternal(item, filter);
      }
      ctx?.onProgress?.({ fetched, page });
    }
  }

  private toExternal(item: AdoWorkItem, filter: AzureDevopsFilter): ExternalIssue {
    const f = item.fields;
    const tags = typeof f["System.Tags"] === "string" ? (f["System.Tags"] as string) : "";
    const labels = tags
      .split(";")
      .map((t) => t.trim())
      .filter(Boolean);
    const parent = item.relations?.find((r) => r.rel === "System.LinkTypes.Hierarchy-Reverse");
    const parentId = parent ? (parent.url.split("/").pop() ?? null) : null;
    const htmlHref =
      item._links?.html?.href ??
      `${this.base}/${encodeURIComponent(filter.organization)}/${encodeURIComponent(
        filter.project,
      )}/_workitems/edit/${item.id}`;
    return {
      externalId: String(item.id),
      externalSource: "azure-devops",
      url: htmlHref,
      title: String(f["System.Title"] ?? ""),
      body: String(f["System.Description"] ?? ""),
      state: typeof f["System.State"] === "string" ? (f["System.State"] as string) : undefined,
      labels,
      type:
        typeof f["System.WorkItemType"] === "string"
          ? (f["System.WorkItemType"] as string)
          : undefined,
      priority: adoPriority(f["Microsoft.VSTS.Common.Priority"]),
      parentExternalId: parentId,
    };
  }

  map(issue: ExternalIssue): MappedRequirement {
    return defaultMap(issue);
  }
}
