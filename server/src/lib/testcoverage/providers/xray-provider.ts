/**
 * Xray Cloud provider (Epic #856, issue #867).
 *
 * Imports test cases from Xray Cloud via the v2 REST API.
 *
 * Auth: `POST /api/v2/authenticate` with `{ client_id, client_secret }`
 *   returns a quoted JWT string. The token is cached in-memory by the
 *   `XrayClient` instance and refreshed transparently on the first 401.
 *
 * Endpoints used:
 *   - `GET /api/v2/test`               — paginated list (limit + page params)
 *   - `GET /api/v2/test/{key}`         — full details when list is sparse
 *   - `GET /api/v2/test/{key}/preconditions` — linked preconditions
 *
 * SSRF: every request URL validated via `assertConnectorHostAllowed`.
 * Credentials: vault-resolved upstream; never logged. The JWT itself is
 * also treated as a secret.
 */
import type { NormalisedTestCase } from "@metis/shared";

import { assertConnectorHostAllowed } from "../../connectors/network-allowlist.js";
import { finaliseCase, normalisePriority, normaliseTags } from "../normaliser.js";
import type { XrayConnectionConfig } from "../exporters/types.js";
import { retryingFetch } from "./testrail-provider.js";

export interface XrayImportOptions {
  /** Jira project key to restrict the search to. */
  readonly projectKey: string;
  readonly pageSize?: number;
}

interface XrayTest {
  key: string;
  fields?: {
    summary?: string;
    description?: string;
    priority?: { name?: string };
    labels?: string[];
  };
  testType?: { name?: string };
  steps?: Array<{ action?: string; data?: string; result?: string }>;
}

export interface XrayImportSummary {
  readonly cases: ReadonlyArray<NormalisedTestCase>;
  readonly fetched: number;
}

export class XrayClient {
  private token: string | null = null;
  private hostAsserted = false;
  constructor(
    readonly config: XrayConnectionConfig,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  private async ensureHostAllowed(): Promise<void> {
    if (this.hostAsserted) return;
    await assertConnectorHostAllowed(new URL(this.config.baseUrl).hostname, "xray");
    this.hostAsserted = true;
  }

  async authenticate(force = false): Promise<string> {
    if (this.token && !force) return this.token;
    await this.ensureHostAllowed();
    const res = await retryingFetch(
      this.fetchFn,
      joinUrl(this.config.baseUrl, "api/v2/authenticate"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`Xray authenticate failed: ${res.status} ${res.statusText}`);
    }
    const raw = (await res.text()).trim();
    // Xray returns the JWT wrapped in JSON quotes.
    this.token = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    return this.token;
  }

  async listTests(opts: XrayImportOptions): Promise<XrayTest[]> {
    const limit = clampPageSize(opts.pageSize);
    const out: XrayTest[] = [];
    let page = 1;
    for (;;) {
      const query = new URLSearchParams({
        limit: String(limit),
        page: String(page),
        jql: `project = ${opts.projectKey}`,
      });
      const url = joinUrl(this.config.baseUrl, `api/v2/test?${query.toString()}`);
      const res = await this.authedFetch(url, { method: "GET" });
      if (!res.ok) {
        throw new Error(`Xray list tests failed: ${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as XrayTest[] | { tests?: XrayTest[]; total?: number };
      const list: XrayTest[] = Array.isArray(body) ? body : (body.tests ?? []);
      out.push(...list);
      if (list.length < limit) break;
      page += 1;
    }
    return out;
  }

  async getPreconditions(testKey: string): Promise<string[]> {
    const url = joinUrl(
      this.config.baseUrl,
      `api/v2/test/${encodeURIComponent(testKey)}/preconditions`,
    );
    const res = await this.authedFetch(url, { method: "GET" });
    if (res.status === 404) return [];
    if (!res.ok) {
      throw new Error(`Xray preconditions failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as Array<{ definition?: string; key?: string }>;
    return body.map((p) => p.definition?.trim() ?? p.key ?? "").filter((s) => s.length > 0);
  }

  private async authedFetch(input: string, init: RequestInit): Promise<Response> {
    const token = await this.authenticate(false);
    const headers = {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    const res = await retryingFetch(this.fetchFn, input, { ...init, headers });
    if (res.status !== 401) return res;
    const refreshed = await this.authenticate(true);
    const retryHeaders = { ...headers, Authorization: `Bearer ${refreshed}` };
    return retryingFetch(this.fetchFn, input, { ...init, headers: retryHeaders });
  }
}

export async function importXrayTests(
  config: XrayConnectionConfig,
  options: XrayImportOptions,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<XrayImportSummary> {
  const client = new XrayClient(config, fetchFn);
  const tests = await client.listTests(options);
  const cases: NormalisedTestCase[] = [];
  for (const t of tests) {
    let preconditions = t.fields?.description ?? "";
    try {
      const extra = await client.getPreconditions(t.key);
      if (extra.length) {
        preconditions = [preconditions, ...extra].filter(Boolean).join("\n");
      }
    } catch {
      // Preconditions are best-effort; missing endpoint must not fail the import.
    }
    const tc = mapTest(t, preconditions);
    if (tc) cases.push(tc);
  }
  return { cases, fetched: tests.length };
}

function mapTest(t: XrayTest, preconditions: string): NormalisedTestCase | null {
  const steps: Array<{ action: string; expected?: string }> = [];
  for (const s of t.steps ?? []) {
    const action = [s.action?.trim(), s.data?.trim() ? `Data: ${s.data.trim()}` : ""]
      .filter(Boolean)
      .join("\n");
    if (!action) continue;
    const expected = s.result?.trim();
    steps.push(expected ? { action, expected } : { action });
  }

  return finaliseCase(
    {
      externalId: t.key,
      title: t.fields?.summary ?? t.key,
      preconditions: preconditions || undefined,
      steps,
      priority: normalisePriority(t.fields?.priority?.name ?? null),
      tags: normaliseTags((t.fields?.labels ?? []).join(",")),
    },
    "xray",
  );
}

function clampPageSize(n: number | undefined): number {
  if (!n || n <= 0) return 100;
  return Math.min(100, Math.max(1, Math.floor(n)));
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return path.startsWith("/") ? `${trimmed}${path}` : `${trimmed}/${path}`;
}
