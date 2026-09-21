/**
 * GitHub Issues importer — issue #778.
 *
 * Lists issues via the REST API (Link-header pagination) and computes the
 * preview count cheaply via the GraphQL `search.issueCount`. Honours the
 * primary (5000/h) and secondary rate limits through {@link fetchWithBackoff},
 * and supports GitHub Enterprise via `baseUrl`.
 */
import type { GithubFilter } from "@metis/shared";
import { fetchWithBackoff, parseLinkHeader, type BackoffOptions } from "./http.js";
import { defaultMap } from "./base-importer.js";
import type {
  AssertHostAllowed,
  ExternalIssue,
  FetchFn,
  Importer,
  ImporterFetchContext,
  MappedRequirement,
} from "./types.js";

export interface GithubImporterConfig {
  token: string;
  baseUrl?: string | null;
  fetchFn?: FetchFn;
  assertHostAllowed?: AssertHostAllowed;
  /**
   * Factory that resolves a hostname to a pinned undici Dispatcher, defending
   * against DNS-rebind TOCTOU attacks. When provided, it takes priority over
   * `assertHostAllowed` (it both validates and pins). Omit in unit tests;
   * registry.ts wires this for production.
   */
  pinnedDispatcherFor?: (hostname: string) => Promise<unknown>;
  backoff?: Pick<
    BackoffOptions,
    "maxRetries" | "baseDelayMs" | "maxDelayMs" | "sleep" | "now" | "random"
  >;
}

interface GithubRestIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  labels: Array<{ name: string } | string>;
  pull_request?: unknown;
}

export class GithubImporter implements Importer<GithubFilter> {
  readonly kind = "github" as const;

  /** Cached pinned dispatcher per-hostname (DNS-rebind TOCTOU protection). */
  private _guardedHostname: string | null = null;
  private _dispatcher: unknown = undefined;

  constructor(private readonly config: GithubImporterConfig) {}

  private get apiBase(): string {
    const b = this.config.baseUrl?.replace(/\/+$/, "");
    return b ? `${b}/api/v3` : "https://api.github.com";
  }

  private get graphqlUrl(): string {
    const b = this.config.baseUrl?.replace(/\/+$/, "");
    return b ? `${b}/api/graphql` : "https://api.github.com/graphql";
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "metis-importer",
    };
  }

  private async guard(rawUrl: string): Promise<void> {
    const hostname = new URL(rawUrl).hostname;
    if (this.config.pinnedDispatcherFor) {
      // pinnedDispatcherFor both validates (resolveAndAssert) and pins DNS.
      // Re-pin only when the hostname changes (defence against SSRF via
      // adversarial Link: next headers pointing at a different host).
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

  /** Build the GitHub search query string for `count`. */
  private searchQuery(filter: GithubFilter): string {
    const parts = [`repo:${filter.owner}/${filter.repo}`, "is:issue"];
    if (filter.state !== "all") parts.push(`state:${filter.state}`);
    for (const label of filter.labels ?? []) parts.push(`label:"${label}"`);
    return parts.join(" ");
  }

  async count(filter: GithubFilter, ctx?: ImporterFetchContext): Promise<number> {
    await this.guard(this.graphqlUrl);
    const query = `query($q:String!){ search(query:$q, type:ISSUE){ issueCount } }`;
    const res = await fetchWithBackoff(
      this.graphqlUrl,
      {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { q: this.searchQuery(filter) } }),
      },
      this.backoffOpts(ctx),
    );
    const json = (await res.json()) as { data?: { search?: { issueCount?: number } } };
    return json.data?.search?.issueCount ?? 0;
  }

  async *fetchAll(filter: GithubFilter, ctx?: ImporterFetchContext): AsyncGenerator<ExternalIssue> {
    const params = new URLSearchParams({ state: filter.state, per_page: "100" });
    if (filter.labels?.length) params.set("labels", filter.labels.join(","));
    let url: string | null =
      `${this.apiBase}/repos/${filter.owner}/${filter.repo}/issues?${params.toString()}`;
    let fetched = 0;
    let page = 0;
    while (url) {
      // Validate every URL — including next-page URLs extracted from the
      // upstream Link header — so an adversarial Link cannot redirect
      // paginated fetches to an internal host (SSRF pagination bypass).
      await this.guard(url);
      if (ctx?.signal?.aborted) return;
      page += 1;
      const res: Response = await fetchWithBackoff(
        url,
        { method: "GET", headers: this.headers() },
        this.backoffOpts(ctx),
      );
      const issues = (await res.json()) as GithubRestIssue[];
      for (const issue of issues) {
        // The /issues endpoint returns PRs too — skip them.
        if (issue.pull_request) continue;
        fetched += 1;
        yield this.toExternal(issue);
      }
      ctx?.onProgress?.({ fetched, page });
      url = parseLinkHeader(res.headers.get("link")).next ?? null;
    }
  }

  private toExternal(issue: GithubRestIssue): ExternalIssue {
    const labels = issue.labels.map((l) => (typeof l === "string" ? l : l.name));
    return {
      externalId: String(issue.number),
      externalSource: "github",
      url: issue.html_url,
      title: issue.title,
      body: issue.body ?? "",
      state: issue.state,
      labels,
      priority: undefined,
      type: undefined,
    };
  }

  map(issue: ExternalIssue): MappedRequirement {
    return defaultMap(issue);
  }
}
