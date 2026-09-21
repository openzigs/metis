/**
 * Jira REST API client — Epic #556 / Issue #559.
 *
 * Unified `fetch`-based client for Jira Cloud (v3, Basic email:apiToken)
 * and Data Center (v2, Bearer PAT). Supports proxy, custom TLS CA, and
 * async-generator pagination.
 */
import { createChildLogger } from "../../logger.js";
import type { DnsLookupAllFn, PinnedHost } from "../network-allowlist.js";
import type { DispatcherLike } from "../../net/safe-fetch.js";
import { JiraApiError } from "./jira-errors.js";
import { fetchJiraRaw, type JiraRawResource } from "./raw-fetch.js";
import type {
  JiraClientConfig,
  JiraServerInfo,
  JiraSearchOptions,
  JiraCreateIssueFields,
} from "./types.js";
import type { JiraProject, JiraIssue, JiraSearchResult, JiraIssueDetail } from "@metis/shared";

const log = createChildLogger("jira-client");

// Re-exported so the many existing `import { JiraApiError } from
// "./jira-client.js"` call sites keep working after #1054 moved the class into
// its own module (breaking an import cycle with `raw-fetch.ts`).
export { JiraApiError };

/**
 * Build the Authorization header for the given edition.
 * - Cloud: Basic base64(email:apiToken)
 * - DC: Bearer PAT
 */
function authHeader(config: JiraClientConfig): string {
  if (config.edition === "cloud") {
    const encoded = Buffer.from(`${config.username}:${config.apiToken}`).toString("base64");
    return `Basic ${encoded}`;
  }
  return `Bearer ${config.apiToken}`;
}

/** API version prefix — Cloud uses v3, DC uses v2. */
function apiPrefix(config: JiraClientConfig): string {
  return config.edition === "cloud" ? "/rest/api/3" : "/rest/api/2";
}

/** Normalize the base URL (strip trailing slash). */
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface JiraFetchInit {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Low-level fetch wrapper that handles auth, proxy, TLS, and error mapping.
 */
async function jiraFetch(
  config: JiraClientConfig,
  path: string,
  init: JiraFetchInit = {},
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<unknown> {
  const base = normalizeBaseUrl(config.baseUrl);
  const url = `${base}${path}`;

  const headers: Record<string, string> = {
    Authorization: authHeader(config),
    Accept: "application/json",
    ...init.headers,
  };

  const fetchInit: RequestInit = {
    method: init.method ?? "GET",
    headers,
  };

  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    fetchInit.body = JSON.stringify(init.body);
  }

  log.debug("Jira API request", { method: fetchInit.method, url: path });

  const response = await fetchFn(url, fetchInit);

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => "");
    }
    const msg =
      typeof body === "object" && body !== null && "message" in body
        ? String((body as Record<string, unknown>).message)
        : `Jira API returned ${response.status}`;
    throw new JiraApiError(response.status, "JIRA_API_ERROR", msg, body);
  }

  if (response.status === 204) return null;

  return response.json();
}

// ---- Public API ------------------------------------------------------------

export interface JiraClient {
  testConnection(): Promise<{ ok: boolean; serverInfo: JiraServerInfo; latencyMs: number }>;
  getServerInfo(): Promise<JiraServerInfo>;
  listProjects(): Promise<JiraProject[]>;
  searchIssues(jql: string, opts?: JiraSearchOptions): Promise<JiraSearchResult>;
  getIssue(key: string, expand?: string[]): Promise<JiraIssueDetail>;
  createIssue(fields: JiraCreateIssueFields): Promise<JiraIssue>;
  searchIssuesAll(
    jql: string,
    opts?: Omit<JiraSearchOptions, "startAt">,
  ): AsyncGenerator<JiraIssue>;
  /**
   * Fetch a raw binary resource (e.g. attachment) from the Jira instance.
   *
   * SSRF-hardened in #1054: the URL must share the connection's origin, the
   * host goes through the connector allow-list with DNS pinning, redirects are
   * re-validated per hop, the credential never leaves the Jira origin, the
   * response size is bounded, and `contentType` is the sanitized value from
   * `resolveAttachmentDisposition` — never the raw upstream header.
   */
  fetchRaw(absoluteUrl: string): Promise<JiraRawResource>;
}

/**
 * Optional test/infra seams for the SSRF-hardened `fetchRaw` path (#1054).
 * Production callers leave these unset and get real DNS + a real pinned
 * undici dispatcher.
 */
export interface JiraClientDeps {
  lookup?: DnsLookupAllFn;
  dispatcherFactory?: (pinned: PinnedHost) => Promise<DispatcherLike>;
  maxBytes?: number;
  maxRedirects?: number;
}

/**
 * Create a Jira API client for the given configuration.
 */
export function createJiraClient(
  config: JiraClientConfig,
  fetchFn: typeof fetch = globalThis.fetch,
  deps: JiraClientDeps = {},
): JiraClient {
  const prefix = apiPrefix(config);

  async function testConnection() {
    const start = Date.now();
    const info = await getServerInfo();
    const latencyMs = Date.now() - start;
    return { ok: true, serverInfo: info, latencyMs };
  }

  async function getServerInfo(): Promise<JiraServerInfo> {
    const data = (await jiraFetch(config, "/rest/api/2/serverInfo", {}, fetchFn)) as Record<
      string,
      unknown
    >;
    return {
      version: String(data.version ?? ""),
      baseUrl: String(data.baseUrl ?? config.baseUrl),
      serverTitle: data.serverTitle ? String(data.serverTitle) : undefined,
      deploymentType: data.deploymentType ? String(data.deploymentType) : undefined,
    };
  }

  async function listProjects(): Promise<JiraProject[]> {
    const data = (await jiraFetch(config, `${prefix}/project`, {}, fetchFn)) as Array<
      Record<string, unknown>
    >;
    return data.map((p) => ({
      id: String(p.id ?? ""),
      key: String(p.key ?? ""),
      name: String(p.name ?? ""),
      projectTypeKey: String(p.projectTypeKey ?? ""),
      avatarUrl:
        p.avatarUrls && typeof p.avatarUrls === "object"
          ? String((p.avatarUrls as Record<string, unknown>)["48x48"] ?? "")
          : undefined,
    }));
  }

  async function searchIssues(
    jql: string,
    opts: JiraSearchOptions = {},
  ): Promise<JiraSearchResult> {
    const body = {
      jql,
      startAt: opts.startAt ?? 0,
      maxResults: opts.maxResults ?? 20,
      fields: opts.fields ?? [
        "summary",
        "status",
        "issuetype",
        "priority",
        "assignee",
        "created",
        "updated",
      ],
      expand: opts.expand,
    };
    const data = (await jiraFetch(
      config,
      `${prefix}/search`,
      { method: "POST", body },
      fetchFn,
    )) as Record<string, unknown>;
    return {
      startAt: Number(data.startAt ?? 0),
      maxResults: Number(data.maxResults ?? 20),
      total: Number(data.total ?? 0),
      issues: Array.isArray(data.issues) ? (data.issues as JiraIssue[]) : [],
    };
  }

  async function getIssue(key: string, expand?: string[]): Promise<JiraIssueDetail> {
    const params = new URLSearchParams();
    if (expand?.length) params.set("expand", expand.join(","));
    const qs = params.toString() ? `?${params.toString()}` : "";
    const data = (await jiraFetch(
      config,
      `${prefix}/issue/${encodeURIComponent(key)}${qs}`,
      {},
      fetchFn,
    )) as JiraIssueDetail;
    return data;
  }

  async function createIssue(fields: JiraCreateIssueFields): Promise<JiraIssue> {
    const data = (await jiraFetch(
      config,
      `${prefix}/issue`,
      { method: "POST", body: { fields } },
      fetchFn,
    )) as JiraIssue;
    return data;
  }

  async function* searchIssuesAll(
    jql: string,
    opts: Omit<JiraSearchOptions, "startAt"> = {},
  ): AsyncGenerator<JiraIssue> {
    const pageSize = opts.maxResults ?? 50;
    let startAt = 0;
    let total = Infinity;

    while (startAt < total) {
      const result = await searchIssues(jql, { ...opts, startAt, maxResults: pageSize });
      total = result.total;
      for (const issue of result.issues) {
        yield issue;
      }
      if (result.issues.length === 0) break;
      startAt += result.issues.length;
    }
  }

  return {
    testConnection,
    getServerInfo,
    listProjects,
    searchIssues,
    getIssue,
    createIssue,
    searchIssuesAll,
    async fetchRaw(absoluteUrl: string) {
      return fetchJiraRaw(absoluteUrl, {
        baseUrl: normalizeBaseUrl(config.baseUrl),
        authorization: authHeader(config),
        fetchFn,
        lookup: deps.lookup,
        dispatcherFactory: deps.dispatcherFactory,
        maxBytes: deps.maxBytes,
        maxRedirects: deps.maxRedirects,
      });
    },
  };
}

// ---- Mock provider for testing (ARCHITECTURE.md §21) -----------------------

export interface MockJiraData {
  serverInfo?: Partial<JiraServerInfo>;
  projects?: JiraProject[];
  issues?: JiraIssue[];
  issueDetails?: Record<string, JiraIssueDetail>;
  createResponse?: JiraIssue;
  shouldFail?: { status: number; message: string };
}

export function createMockJiraClient(mockData: MockJiraData = {}): JiraClient {
  function failIfNeeded() {
    if (mockData.shouldFail) {
      throw new JiraApiError(
        mockData.shouldFail.status,
        "JIRA_API_ERROR",
        mockData.shouldFail.message,
      );
    }
  }

  return {
    async testConnection() {
      failIfNeeded();
      return {
        ok: true,
        serverInfo: {
          version: "9.0.0",
          baseUrl: "https://jira.example.com",
          ...mockData.serverInfo,
        },
        latencyMs: 42,
      };
    },
    async getServerInfo() {
      failIfNeeded();
      return {
        version: "9.0.0",
        baseUrl: "https://jira.example.com",
        ...mockData.serverInfo,
      };
    },
    async listProjects() {
      failIfNeeded();
      return mockData.projects ?? [];
    },
    async searchIssues(_jql, opts = {}) {
      failIfNeeded();
      const issues = mockData.issues ?? [];
      const startAt = opts.startAt ?? 0;
      const maxResults = opts.maxResults ?? 20;
      const page = issues.slice(startAt, startAt + maxResults);
      return { startAt, maxResults, total: issues.length, issues: page };
    },
    async getIssue(key) {
      failIfNeeded();
      const detail = mockData.issueDetails?.[key];
      if (!detail) {
        throw new JiraApiError(404, "JIRA_API_ERROR", `Issue ${key} not found`);
      }
      return detail;
    },
    async createIssue() {
      failIfNeeded();
      if (mockData.createResponse) return mockData.createResponse;
      return {
        id: "10001",
        key: "TEST-1",
        self: "https://jira.example.com/rest/api/2/issue/10001",
        fields: {},
      };
    },
    async *searchIssuesAll(_jql, _opts = {}) {
      failIfNeeded();
      const issues = mockData.issues ?? [];
      for (const issue of issues) {
        yield issue;
      }
    },
    async fetchRaw(_absoluteUrl: string) {
      failIfNeeded();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(Buffer.from("mock-content")));
          controller.close();
        },
      });
      return {
        body,
        contentType: "application/octet-stream",
        contentLength: 12,
        contentDisposition: "attachment" as const,
      };
    },
  };
}
