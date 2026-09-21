/**
 * Linear importer — issue #781.
 *
 * Pages the Linear GraphQL `issues` connection by cursor, optionally including
 * archived issues and filtering by workflow-state type. Linear does not expose
 * a total count on the connection, so `count` streams identifiers.
 */
import type { LinearFilter } from "@metis/shared";
import { fetchWithBackoff, ImporterHttpError, type BackoffOptions } from "./http.js";
import { defaultMap } from "./base-importer.js";
import type {
  AssertHostAllowed,
  ExternalIssue,
  FetchFn,
  Importer,
  ImporterFetchContext,
  MappedRequirement,
} from "./types.js";

export interface LinearImporterConfig {
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
  pageSize?: number;
  backoff?: Pick<
    BackoffOptions,
    "maxRetries" | "baseDelayMs" | "maxDelayMs" | "sleep" | "now" | "random"
  >;
}

interface LinearIssueNode {
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number | null;
  labels?: { nodes: Array<{ name: string }> };
  state?: { name: string; type: string };
}

/** Linear numeric priority (1=Urgent) → requirement priority. */
function linearPriority(value: number | null): string | undefined {
  switch (value) {
    case 1:
      return "critical";
    case 2:
      return "high";
    case 3:
      return "medium";
    case 4:
      return "low";
    default:
      return undefined;
  }
}

const ISSUES_QUERY = `
query Issues($teamId: ID!, $after: String, $first: Int!, $includeArchived: Boolean) {
  issues(
    filter: { team: { id: { eq: $teamId } } }
    after: $after
    first: $first
    includeArchived: $includeArchived
  ) {
    totalCount
    nodes {
      identifier
      title
      description
      url
      priority
      labels { nodes { name } }
      state { name type }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export class LinearImporter implements Importer<LinearFilter> {
  readonly kind = "linear" as const;

  /** Cached pinned dispatcher per-hostname (DNS-rebind TOCTOU protection). */
  private _guardedHostname: string | null = null;
  private _dispatcher: unknown = undefined;

  constructor(private readonly config: LinearImporterConfig) {}

  private get endpoint(): string {
    return this.config.baseUrl?.replace(/\/+$/, "") ?? "https://api.linear.app/graphql";
  }

  private async ensurePinned(): Promise<void> {
    const hostname = new URL(this.endpoint).hostname;
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

  private async request<T>(
    variables: Record<string, unknown>,
    ctx?: ImporterFetchContext,
  ): Promise<T> {
    await this.ensurePinned();
    const res = await fetchWithBackoff(
      this.endpoint,
      {
        method: "POST",
        headers: {
          Authorization: this.config.token,
          "Content-Type": "application/json",
          "User-Agent": "metis-importer",
        },
        body: JSON.stringify({ query: ISSUES_QUERY, variables }),
      },
      {
        fetchFn: this.config.fetchFn,
        dispatcher: this._dispatcher,
        signal: ctx?.signal,
        ...this.config.backoff,
      },
    );
    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) {
      throw new ImporterHttpError(400, `Linear GraphQL error: ${json.errors[0].message}`);
    }
    return json.data as T;
  }

  private matchesState(node: LinearIssueNode, filter: LinearFilter): boolean {
    if (!filter.stateTypes?.length) return true;
    return node.state ? filter.stateTypes.includes(node.state.type) : false;
  }

  async *fetchAll(filter: LinearFilter, ctx?: ImporterFetchContext): AsyncGenerator<ExternalIssue> {
    const first = this.config.pageSize ?? 50;
    let after: string | null = null;
    let fetched = 0;
    let page = 0;
    for (;;) {
      if (ctx?.signal?.aborted) return;
      page += 1;
      const data: {
        issues: {
          totalCount: number;
          nodes: LinearIssueNode[];
          pageInfo: { hasNextPage: boolean; endCursor: string };
        };
      } = await this.request(
        { teamId: filter.teamId, after, first, includeArchived: filter.includeArchived },
        ctx,
      );
      for (const node of data.issues.nodes) {
        if (!this.matchesState(node, filter)) continue;
        fetched += 1;
        yield this.toExternal(node);
      }
      ctx?.onProgress?.({ fetched, page });
      if (!data.issues.pageInfo.hasNextPage) return;
      after = data.issues.pageInfo.endCursor;
    }
  }

  /**
   * Returns the server-side total issue count for the team/archived filter.
   * Uses a single first-page GraphQL request (O(1)) instead of streaming all
   * issues (previously O(n)).  The count reflects the team-level filter only,
   * not client-side `stateTypes` filtering, so it serves as an upper-bound
   * approximation appropriate for the preview UI.
   */
  async count(filter: LinearFilter, ctx?: ImporterFetchContext): Promise<number> {
    const data: { issues: { totalCount: number } } = await this.request(
      { teamId: filter.teamId, after: null, first: 1, includeArchived: filter.includeArchived },
      ctx,
    );
    return data.issues.totalCount;
  }

  private toExternal(node: LinearIssueNode): ExternalIssue {
    const labels = node.labels?.nodes.map((l) => l.name) ?? [];
    return {
      externalId: node.identifier,
      externalSource: "linear",
      url: node.url,
      title: node.title,
      body: node.description ?? "",
      state: node.state?.name,
      labels,
      type: undefined,
      priority: linearPriority(node.priority),
    };
  }

  map(issue: ExternalIssue): MappedRequirement {
    return defaultMap(issue);
  }
}
