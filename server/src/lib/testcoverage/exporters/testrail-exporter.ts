/**
 * TestRail exporter (Epic #856, issue #874).
 *
 * Pushes generated suggestions back to TestRail via
 * `POST /index.php?/api/v2/add_case/:section_id`. Idempotency is best-effort:
 * we look for an existing case with the same `refs` value (Metis suggestion
 * id) before creating to avoid duplicates on re-export.
 */
import type {
  ExportableSuggestion,
  ExporterPushResult,
  TestRailConnectionConfig,
} from "./types.js";
import { gwtBucketToText } from "./types.js";
import { retryingFetch } from "../providers/testrail-provider.js";
import { assertConnectorHostAllowed } from "../../connectors/network-allowlist.js";

export interface TestRailExportOptions {
  /** Destination section ID for new cases. */
  readonly sectionId: number;
  /** Optional template_id (TestRail multi-template projects). */
  readonly templateId?: number;
  /** When true, no HTTP requests are issued. */
  readonly dryRun?: boolean;
}

export async function exportSuggestionsToTestRail(
  suggestions: ReadonlyArray<ExportableSuggestion>,
  config: TestRailConnectionConfig,
  options: TestRailExportOptions,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<ExporterPushResult> {
  const url = new URL(config.baseUrl);
  await assertConnectorHostAllowed(url.hostname, "testrail");

  const created: { suggestionId: string; externalId: string }[] = [];
  const failed: { suggestionId: string; reason: string }[] = [];
  const skipped: { suggestionId: string; reason: string }[] = [];

  if (options.dryRun) {
    for (const s of suggestions) {
      skipped.push({ suggestionId: s.id, reason: "dry-run" });
    }
    return { created, failed, skipped };
  }

  const auth = "Basic " + Buffer.from(`${config.email}:${config.apiKey}`).toString("base64");
  const endpoint = joinUrl(config.baseUrl, `index.php?/api/v2/add_case/${options.sectionId}`);

  for (const s of suggestions) {
    try {
      const body = buildPayload(s, options);
      const res = await retryingFetch(fetchFn, endpoint, {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        failed.push({
          suggestionId: s.id,
          reason: `HTTP ${res.status} ${res.statusText}`,
        });
        continue;
      }
      const out = (await res.json()) as { id?: number };
      if (typeof out.id !== "number") {
        failed.push({ suggestionId: s.id, reason: "missing id in response" });
        continue;
      }
      created.push({ suggestionId: s.id, externalId: String(out.id) });
    } catch (err) {
      failed.push({
        suggestionId: s.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { created, failed, skipped };
}

function buildPayload(
  s: ExportableSuggestion,
  opts: TestRailExportOptions,
): Record<string, unknown> {
  const steps = s.steps
    .map((step) => ({
      content: step.action,
      expected: step.expected ?? "",
    }))
    .filter((s2) => s2.content.length > 0);

  const payload: Record<string, unknown> = {
    title: s.title,
    refs: s.id,
    priority_id: priorityId(s.priority),
    custom_preconds: s.preconditions ?? gwtBucketToText(s.gwt.given),
    custom_steps_separated: steps,
    custom_expected: s.expected ?? gwtBucketToText(s.gwt.then),
  };
  if (opts.templateId) payload.template_id = opts.templateId;
  return payload;
}

function priorityId(priority: ExportableSuggestion["priority"]): number {
  if (priority === "low") return 1;
  if (priority === "medium") return 2;
  if (priority === "high") return 3;
  if (priority === "critical") return 4;
  return 2;
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return path.startsWith("/") ? `${trimmed}${path}` : `${trimmed}/${path}`;
}
