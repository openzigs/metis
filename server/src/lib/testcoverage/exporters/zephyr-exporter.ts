/**
 * Zephyr Scale Cloud exporter (Epic #856, issue #869).
 *
 * Pushes generated suggestions back to Zephyr Scale.
 *
 * Phase 1 — `POST /v2/testcases` creates the case with title, objective,
 *           precondition, priority, labels, and the linked Jira project key.
 * Phase 2 — `POST /v2/testcases/{key}/teststeps?mode=APPEND` adds one
 *           step per GWT row.
 *
 * Each request goes through the SSRF check and exponential backoff. Failures
 * for an individual suggestion are captured per-row; the exporter does not
 * throw on partial failure.
 */
import type { ExportableSuggestion, ExporterPushResult, ZephyrConnectionConfig } from "./types.js";
import { gwtBucketToText } from "./types.js";
import { retryingFetch } from "../providers/testrail-provider.js";
import { assertConnectorHostAllowed } from "../../connectors/network-allowlist.js";

export interface ZephyrExportOptions {
  readonly projectKey: string;
  readonly folderId?: number;
  readonly dryRun?: boolean;
}

export async function exportSuggestionsToZephyr(
  suggestions: ReadonlyArray<ExportableSuggestion>,
  config: ZephyrConnectionConfig,
  options: ZephyrExportOptions,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<ExporterPushResult> {
  const url = new URL(config.baseUrl);
  await assertConnectorHostAllowed(url.hostname, "zephyr");

  const created: { suggestionId: string; externalId: string }[] = [];
  const failed: { suggestionId: string; reason: string }[] = [];
  const skipped: { suggestionId: string; reason: string }[] = [];

  if (options.dryRun) {
    for (const s of suggestions) skipped.push({ suggestionId: s.id, reason: "dry-run" });
    return { created, failed, skipped };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.bearerToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const createUrl = joinUrl(config.baseUrl, "testcases");

  for (const s of suggestions) {
    try {
      const createBody: Record<string, unknown> = {
        projectKey: options.projectKey,
        name: s.title,
        objective: s.preconditions ?? gwtBucketToText(s.gwt.given),
        precondition: gwtBucketToText(s.gwt.given),
        priority: { name: zephyrPriority(s.priority) },
        labels: [...(s.tags ?? []), `metis:${s.id}`],
      };
      if (options.folderId) createBody.folderId = options.folderId;

      const res = await retryingFetch(fetchFn, createUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(createBody),
      });
      if (!res.ok) {
        failed.push({ suggestionId: s.id, reason: `HTTP ${res.status} ${res.statusText}` });
        continue;
      }
      const body = (await res.json()) as { key?: string };
      if (!body.key) {
        failed.push({ suggestionId: s.id, reason: "missing key in response" });
        continue;
      }
      await postSteps(config.baseUrl, body.key, s, headers, fetchFn);
      created.push({ suggestionId: s.id, externalId: body.key });
    } catch (err) {
      failed.push({
        suggestionId: s.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { created, failed, skipped };
}

async function postSteps(
  base: string,
  caseKey: string,
  s: ExportableSuggestion,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
): Promise<void> {
  const steps = s.steps
    .map((step) => ({
      inline: {
        description: step.action,
        expectedResult: step.expected ?? "",
      },
    }))
    .filter((entry) => entry.inline.description.length > 0);
  if (steps.length === 0) return;
  const stepsUrl = joinUrl(base, `testcases/${encodeURIComponent(caseKey)}/teststeps?mode=APPEND`);
  const res = await retryingFetch(fetchFn, stepsUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ mode: "APPEND", items: steps }),
  });
  if (!res.ok) {
    throw new Error(`Zephyr append steps failed: ${res.status} ${res.statusText}`);
  }
}

function zephyrPriority(priority: ExportableSuggestion["priority"]): string {
  if (priority === "low") return "Low";
  if (priority === "medium") return "Normal";
  if (priority === "high") return "High";
  if (priority === "critical") return "High";
  return "Normal";
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return path.startsWith("/") ? `${trimmed}${path}` : `${trimmed}/${path}`;
}
