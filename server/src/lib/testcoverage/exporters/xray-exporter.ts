/**
 * Xray Cloud exporter (Epic #856, issue #867).
 *
 * Pushes generated suggestions to Xray Cloud via
 * `POST /api/v2/import/test/bulk`. Authentication, retries, SSRF, and
 * 401-refresh are handled by `XrayClient`. The bulk endpoint accepts an
 * array of Test objects; we batch in chunks of 100 (Xray hard limit).
 */
import type { ExportableSuggestion, ExporterPushResult, XrayConnectionConfig } from "./types.js";
import { gwtBucketToText } from "./types.js";
import { XrayClient } from "../providers/xray-provider.js";
import { retryingFetch } from "../providers/testrail-provider.js";

const BULK_LIMIT = 100;

export interface XrayExportOptions {
  readonly projectKey: string;
  readonly dryRun?: boolean;
}

export async function exportSuggestionsToXray(
  suggestions: ReadonlyArray<ExportableSuggestion>,
  config: XrayConnectionConfig,
  options: XrayExportOptions,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<ExporterPushResult> {
  const created: { suggestionId: string; externalId: string }[] = [];
  const failed: { suggestionId: string; reason: string }[] = [];
  const skipped: { suggestionId: string; reason: string }[] = [];

  if (options.dryRun) {
    for (const s of suggestions) skipped.push({ suggestionId: s.id, reason: "dry-run" });
    return { created, failed, skipped };
  }

  const client = new XrayClient(config, fetchFn);
  const token = await client.authenticate(false);
  const url = joinUrl(config.baseUrl, "api/v2/import/test/bulk");

  for (let i = 0; i < suggestions.length; i += BULK_LIMIT) {
    const chunk = suggestions.slice(i, i + BULK_LIMIT);
    const payload = chunk.map((s) => buildTest(s, options.projectKey));
    try {
      const res = await retryingFetch(fetchFn, url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const reason = `HTTP ${res.status} ${res.statusText}`;
        for (const s of chunk) failed.push({ suggestionId: s.id, reason });
        continue;
      }
      const body = (await res.json()) as {
        jobId?: string;
        results?: Array<{ key?: string; importedTest?: { key?: string }; errors?: string[] }>;
      };
      const results = body.results ?? [];
      chunk.forEach((s, idx) => {
        const r = results[idx];
        const key = r?.importedTest?.key ?? r?.key;
        if (key) {
          created.push({ suggestionId: s.id, externalId: key });
        } else {
          failed.push({
            suggestionId: s.id,
            reason:
              r?.errors?.join("; ") ??
              (body.jobId ? `pending job ${body.jobId}` : "no key returned"),
          });
        }
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      for (const s of chunk) failed.push({ suggestionId: s.id, reason });
    }
  }
  return { created, failed, skipped };
}

function buildTest(s: ExportableSuggestion, projectKey: string): Record<string, unknown> {
  return {
    testtype: "Manual",
    fields: {
      project: { key: projectKey },
      summary: s.title,
      description: s.preconditions ?? gwtBucketToText(s.gwt.given),
      priority: { name: xrayPriority(s.priority) },
      labels: [...(s.tags ?? []), `metis-${s.id}`],
    },
    steps: s.steps
      .map((step) => ({
        action: step.action,
        result: step.expected ?? "",
      }))
      .filter((step) => step.action.length > 0),
  };
}

function xrayPriority(priority: ExportableSuggestion["priority"]): string {
  if (priority === "low") return "Low";
  if (priority === "medium") return "Medium";
  if (priority === "high") return "High";
  if (priority === "critical") return "Highest";
  return "Medium";
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return path.startsWith("/") ? `${trimmed}${path}` : `${trimmed}/${path}`;
}
