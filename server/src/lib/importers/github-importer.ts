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
import { defaultMap, parseTitleTypeTag, typeFromLabels } from "./base-importer.js";
import type {
  AssertHostAllowed,
  ExternalIssue,
  FetchFn,
  Importer,
  ImporterFetchContext,
  MappedRequirement,
} from "./types.js";

export interface GithubImporterConfig {
  /**
   * API token. #763 — empty means anonymous: public repositories only, at
   * GitHub's unauthenticated rate limit. The count then uses REST search,
   * because the GraphQL API refuses every unauthenticated request.
   */
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

/** Prefix match that, for a word-character ending, requires a word boundary after it. */
function startsWithPrefix(lowerTitle: string, lowerPrefix: string): boolean {
  if (!lowerTitle.startsWith(lowerPrefix)) return false;
  if (!/\w$/.test(lowerPrefix)) return true;
  return !/^\w/.test(lowerTitle.slice(lowerPrefix.length));
}

/**
 * Issue #1006 — match a title against the filter's `titlePrefixes`
 * (case-insensitive, after trimming) and strip the matched prefix plus any
 * separator after it (`:`, `-`, dashes, whitespace). The longest matching
 * prefix wins, so `[Feature]:` and `[Feature]` both strip the colon. A title
 * that is nothing but the prefix keeps its full text rather than going blank.
 * `null` when no prefix matches.
 */
export function stripTitlePrefix(
  title: string,
  prefixes: ReadonlyArray<string>,
): { title: string } | null {
  const trimmed = title.trim();
  const lower = trimmed.toLowerCase();
  const match = prefixes
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && startsWithPrefix(lower, p.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  if (match === undefined) return null;
  const rest = trimmed
    .slice(match.length)
    .replace(/^[\s:\-–—]+/, "")
    .trim();
  return { title: rest.length > 0 ? rest : trimmed };
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

  private get anonymous(): boolean {
    return this.config.token.length === 0;
  }

  private headers(): Record<string, string> {
    return {
      ...(this.anonymous ? {} : { Authorization: `Bearer ${this.config.token}` }),
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
    // #1006 — no GitHub search qualifier matches a title PREFIX (`in:title` is a
    // word match anywhere), so a prefix-filtered count must walk the issues the
    // import would actually take, or the preview would promise the wrong number.
    if (filter.titlePrefixes?.length) {
      let n = 0;
      for await (const issue of this.fetchAll(filter, ctx)) {
        void issue;
        n += 1;
      }
      return n;
    }
    if (this.anonymous) return this.countViaRestSearch(filter, ctx);
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

  /** #763 — anonymous count: REST search accepts unauthenticated callers. */
  private async countViaRestSearch(
    filter: GithubFilter,
    ctx?: ImporterFetchContext,
  ): Promise<number> {
    const params = new URLSearchParams({ q: this.searchQuery(filter), per_page: "1" });
    const url = `${this.apiBase}/search/issues?${params.toString()}`;
    await this.guard(url);
    const res = await fetchWithBackoff(
      url,
      { method: "GET", headers: this.headers() },
      this.backoffOpts(ctx),
    );
    const json = (await res.json()) as { total_count?: number };
    return json.total_count ?? 0;
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
        const external = this.toExternal(issue);
        if (filter.titlePrefixes?.length) {
          const stripped = stripTitlePrefix(issue.title, filter.titlePrefixes);
          if (!stripped) continue;
          // #1006 — the stripped prefix may be the only type signal (`[Bug]:`),
          // so read the type off the ORIGINAL title before it is gone.
          external.type = parseTitleTypeTag(issue.title).type;
          external.title = stripped.title;
        }
        fetched += 1;
        yield external;
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

  /**
   * Issue #979 — GitHub has no issue type field, so the type comes from the
   * labels or, when no label names one, from an issue-template title tag such as
   * `[Bug]:`. The tag is stripped from the title either way it is recognised.
   */
  map(issue: ExternalIssue): MappedRequirement {
    const mapped = defaultMap(issue);
    const tagged = parseTitleTypeTag(issue.title);
    mapped.title = tagged.title;
    mapped.type = typeFromLabels(issue.labels) ?? tagged.type ?? issue.type ?? "feature";
    return mapped;
  }
}
