/**
 * Zephyr Scale Cloud provider (Epic #856, issue #869).
 *
 * Imports test cases from Zephyr Scale via the v2 REST API.
 *
 * Auth: Bearer JWT (Zephyr's user-profile API token).
 * Pagination: `startAt` / `maxResults`; loop until `isLast === true` or
 * the returned values array is shorter than `maxResults`.
 * Endpoints:
 *   - `GET /v2/testcases?projectKey=…`   — list test cases
 *   - `GET /v2/testcases/{key}/teststeps` — step list (one call per case)
 *   - `GET /v2/testcases/{key}/testscript` — fallback script body
 *
 * SSRF: every request URL validated via `assertConnectorHostAllowed`.
 */
import type { NormalisedTestCase } from "@metis/shared";

import { assertConnectorHostAllowed } from "../../connectors/network-allowlist.js";
import { finaliseCase, normalisePriority, normaliseTags } from "../normaliser.js";
import type { ZephyrConnectionConfig } from "../exporters/types.js";
import { retryingFetch } from "./testrail-provider.js";

export interface ZephyrImportOptions {
  /** Jira project key the Zephyr cases live under (e.g. `WIDGET`). */
  readonly projectKey: string;
  /** Optional folder ID filter. */
  readonly folderId?: number;
  readonly pageSize?: number;
}

interface ZephyrCase {
  key: string;
  name: string;
  objective?: string;
  precondition?: string;
  priority?: { id: number; name?: string };
  labels?: string[];
}

interface ZephyrStep {
  inline?: { description?: string; expectedResult?: string };
  testCase?: { self: string };
}

interface ZephyrPage<T> {
  values?: T[];
  startAt?: number;
  maxResults?: number;
  total?: number;
  isLast?: boolean;
}

export interface ZephyrImportSummary {
  readonly cases: ReadonlyArray<NormalisedTestCase>;
  readonly fetched: number;
}

export async function importZephyrCases(
  config: ZephyrConnectionConfig,
  options: ZephyrImportOptions,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<ZephyrImportSummary> {
  const url = new URL(config.baseUrl);
  await assertConnectorHostAllowed(url.hostname, "zephyr");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.bearerToken}`,
    Accept: "application/json",
  };
  const pageSize = clampPageSize(options.pageSize);
  const cases: NormalisedTestCase[] = [];
  let startAt = 0;
  let fetched = 0;

  for (;;) {
    const query = new URLSearchParams({
      projectKey: options.projectKey,
      startAt: String(startAt),
      maxResults: String(pageSize),
    });
    if (options.folderId) query.set("folderId", String(options.folderId));
    const listUrl = joinUrl(config.baseUrl, `testcases?${query.toString()}`);
    const res = await retryingFetch(fetchFn, listUrl, { method: "GET", headers });
    if (!res.ok) {
      throw new Error(`Zephyr testcases list failed: ${res.status} ${res.statusText}`);
    }
    const page = (await res.json()) as ZephyrPage<ZephyrCase>;
    const values = page.values ?? [];
    for (const raw of values) {
      const steps = await fetchSteps(config.baseUrl, raw.key, headers, fetchFn);
      const tc = mapCase(raw, steps);
      if (tc) cases.push(tc);
    }
    fetched += values.length;
    if (page.isLast === true || values.length < pageSize) break;
    startAt += pageSize;
  }
  return { cases, fetched };
}

async function fetchSteps(
  base: string,
  caseKey: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
): Promise<Array<{ action: string; expected?: string }>> {
  const stepsUrl = joinUrl(base, `testcases/${encodeURIComponent(caseKey)}/teststeps`);
  const res = await retryingFetch(fetchFn, stepsUrl, { method: "GET", headers });
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`Zephyr testcase steps failed: ${res.status} ${res.statusText}`);
  }
  const page = (await res.json()) as ZephyrPage<ZephyrStep>;
  const out: Array<{ action: string; expected?: string }> = [];
  for (const s of page.values ?? []) {
    const action = s.inline?.description?.trim() ?? "";
    if (!action) continue;
    const expected = s.inline?.expectedResult?.trim();
    out.push(expected ? { action, expected } : { action });
  }
  return out;
}

function mapCase(
  raw: ZephyrCase,
  steps: Array<{ action: string; expected?: string }>,
): NormalisedTestCase | null {
  return finaliseCase(
    {
      externalId: raw.key,
      title: raw.name,
      preconditions: raw.precondition ?? raw.objective,
      steps,
      priority: normalisePriority(raw.priority?.name ?? null),
      tags: normaliseTags((raw.labels ?? []).join(",")),
    },
    "zephyr",
  );
}

function clampPageSize(n: number | undefined): number {
  if (!n || n <= 0) return 50;
  return Math.min(100, Math.max(1, Math.floor(n)));
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return path.startsWith("/") ? `${trimmed}${path}` : `${trimmed}/${path}`;
}
