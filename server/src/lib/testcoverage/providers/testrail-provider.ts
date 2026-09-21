/**
 * TestRail provider (Epic #856, issue #874).
 *
 * Imports test cases from TestRail via the v2 REST API.
 *
 * Auth: HTTP Basic with `email:apiKey` base64.
 * Pagination: `limit` (max 250) + `offset`, terminated when the server
 * returns `size < limit` or `_links.next` is absent.
 * Field mapping: prefers `custom_steps_separated[]` for steps; falls back
 * to plain `custom_steps`. `custom_preconds` populates preconditions.
 *
 * SSRF: every URL is validated via `assertConnectorHostAllowed("testrail")`
 * before issuing the request.
 *
 * Credentials: vault-resolved via the resolver pattern; tokens never appear
 * in logs.
 */
import type { NormalisedTestCase } from "@metis/shared";

import { assertConnectorHostAllowed } from "../../connectors/network-allowlist.js";
import { finaliseCase, normalisePriority, normaliseTags } from "../normaliser.js";
import type { TestRailConnectionConfig } from "../exporters/types.js";

export interface TestRailImportOptions {
  /** TestRail numeric project ID. */
  readonly projectId: number;
  /** Optional suite ID (TestRail project must be multi-suite). */
  readonly suiteId?: number;
  /** Page size (1–250). Defaults to 250 (TestRail max). */
  readonly pageSize?: number;
}

interface TestRailCase {
  id: number;
  title: string;
  priority_id?: number;
  custom_preconds?: string;
  custom_steps?: string;
  custom_expected?: string;
  custom_steps_separated?: Array<{ content?: string; expected?: string }>;
  refs?: string;
  labels?: string[];
}

export interface TestRailImportSummary {
  readonly cases: ReadonlyArray<NormalisedTestCase>;
  readonly fetched: number;
}

export async function importTestRailCases(
  config: TestRailConnectionConfig,
  options: TestRailImportOptions,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<TestRailImportSummary> {
  const url = new URL(config.baseUrl);
  await assertConnectorHostAllowed(url.hostname, "testrail");

  const limit = clampLimit(options.pageSize);
  const auth = "Basic " + Buffer.from(`${config.email}:${config.apiKey}`).toString("base64");
  let offset = 0;
  let fetched = 0;
  const cases: NormalisedTestCase[] = [];

  for (;;) {
    const query = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    if (options.suiteId) query.set("suite_id", String(options.suiteId));
    const endpoint = joinUrl(
      config.baseUrl,
      `index.php?/api/v2/get_cases/${options.projectId}&${query.toString()}`,
    );

    const res = await retryingFetch(fetchFn, endpoint, {
      method: "GET",
      headers: {
        Authorization: auth,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`TestRail get_cases failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as
      | { cases?: TestRailCase[]; size?: number; _links?: { next?: string | null } }
      | TestRailCase[];

    const list: TestRailCase[] = Array.isArray(body) ? body : (body.cases ?? []);
    for (const raw of list) {
      const tc = mapCase(raw);
      if (tc) cases.push(tc);
    }
    fetched += list.length;

    // TestRail v6.7+ returns paginated object; v5 returns raw array.
    if (Array.isArray(body)) {
      if (list.length < limit) break;
    } else {
      const next = body._links?.next;
      if (!next) break;
    }
    offset += limit;
  }
  return { cases, fetched };
}

function mapCase(raw: TestRailCase): NormalisedTestCase | null {
  const steps = extractSteps(raw);
  return finaliseCase(
    {
      externalId: String(raw.id),
      title: raw.title,
      preconditions: raw.custom_preconds,
      steps,
      expected: raw.custom_expected,
      priority: normalisePriority(mapPriority(raw.priority_id)),
      tags: normaliseTags((raw.labels ?? []).concat(raw.refs ? [raw.refs] : []).join(",")),
    },
    "testrail",
  );
}

function extractSteps(raw: TestRailCase): Array<{ action: string; expected?: string }> {
  if (raw.custom_steps_separated?.length) {
    return raw.custom_steps_separated
      .map((s) => ({
        action: (s.content ?? "").trim(),
        expected: s.expected?.trim() || undefined,
      }))
      .filter((s) => s.action.length > 0);
  }
  if (raw.custom_steps) {
    return raw.custom_steps
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((action) => ({ action }));
  }
  return [];
}

function mapPriority(id: number | undefined): string | null {
  // TestRail default scheme: 1=Low, 2=Medium, 3=High, 4=Critical.
  if (id === 1) return "low";
  if (id === 2) return "medium";
  if (id === 3) return "high";
  if (id === 4) return "critical";
  return null;
}

function clampLimit(n: number | undefined): number {
  if (!n || n <= 0) return 250;
  return Math.min(250, Math.max(1, Math.floor(n)));
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return path.startsWith("/") ? `${trimmed}${path}` : `${trimmed}/${path}`;
}

/** Fetch with simple exponential backoff on 429 / 5xx. */
export async function retryingFetch(
  fetchFn: typeof fetch,
  input: string | URL,
  init: RequestInit,
  opts: { maxAttempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelay = opts.baseDelayMs ?? 250;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetchFn(input, init);
      if (res.status === 429 || res.status >= 500) {
        if (attempt === maxAttempts) return res;
        await sleep(baseDelay * 2 ** (attempt - 1));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) throw err;
      await sleep(baseDelay * 2 ** (attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("retryingFetch failed");
}
