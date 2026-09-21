/**
 * Network-layer stubs + DTO builders for the inbound-importer Playwright suite
 * (Epic #776, sub-issues #783 / #784).
 *
 * The wizard + history UI talks to `/api/projects/:projectId/imports/...`.
 * These helpers intercept that surface with `page.route(...)` so the specs are
 * deterministic and never reach real Jira / GitHub / Azure DevOps / Linear
 * APIs. State is held in memory and mutated by the route handlers so that a
 * `Run now` / sync-toggle / delete is reflected on the next `listSources`
 * poll — exactly as the real backend would behave.
 */
import type { Page, Route } from "@playwright/test";

// The e2e package does not link `@metis/shared`; mirror the importer DTO shapes
// and constants locally (see `packages/shared/src/import.ts`).
export const IMPORT_SYNC_DEFAULT_INTERVAL_MINUTES = 15;

export type ImportSourceKind = "github" | "jira" | "azure-devops" | "linear";
export type ImportRunStatus = "pending" | "running" | "completed" | "failed";
export type ImportRunTrigger = "manual" | "scheduled";

export interface MappedRequirementPreview {
  externalId: string;
  externalUrl: string;
  title: string;
  type: string;
  priority: string;
  labels: string[];
}

export interface ImportPreview {
  source: ImportSourceKind;
  count: number;
  sample: MappedRequirementPreview[];
}

export interface ImportRunView {
  id: string;
  importSourceId: string;
  projectId: string;
  trigger: ImportRunTrigger;
  status: ImportRunStatus;
  taskId: string | null;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  totalFetched: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ImportSourceView {
  id: string;
  projectId: string;
  analysisId: string;
  source: ImportSourceKind;
  label: string;
  filter: Record<string, unknown>;
  baseUrl: string | null;
  jiraConnectionId: string | null;
  hasToken: boolean;
  syncEnabled: boolean;
  syncIntervalMinutes: number;
  consecutiveFailures: number;
  disabledReason: string | null;
  lastRunAt: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  lastRun?: ImportRunView | null;
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

/** Build a single mapped-requirement preview row. */
export function mappedPreview(i: number): MappedRequirementPreview {
  return {
    externalId: `EXT-${i}`,
    externalUrl: `https://example.com/issues/${i}`,
    title: `Imported issue #${i}`,
    type: i % 2 === 0 ? "bug" : "feature",
    priority: "medium",
    labels: ["imported"],
  };
}

/** Build an `ImportPreview` with `count` matches and `sampleSize` sample rows. */
export function buildPreview(
  source: ImportSourceKind,
  count: number,
  sampleSize = Math.min(count, 10),
): ImportPreview {
  return {
    source,
    count,
    sample: Array.from({ length: sampleSize }, (_, i) => mappedPreview(i + 1)),
  };
}

/** Build an `ImportRunView` with sensible defaults. */
export function buildRun(
  importSourceId: string,
  projectId: string,
  overrides: Partial<ImportRunView> = {},
): ImportRunView {
  const now = new Date().toISOString();
  return {
    id: nextId("run"),
    importSourceId,
    projectId,
    trigger: "manual",
    status: "completed",
    taskId: nextId("task"),
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    totalFetched: 0,
    errorMessage: null,
    startedAt: now,
    completedAt: now,
    createdAt: now,
    ...overrides,
  };
}

/** Build an `ImportSourceView` with sensible defaults. */
export function buildSource(
  projectId: string,
  overrides: Partial<ImportSourceView> = {},
): ImportSourceView {
  const now = new Date().toISOString();
  const id = overrides.id ?? nextId("src");
  return {
    id,
    projectId,
    analysisId: nextId("analysis"),
    source: "github",
    label: "GitHub import",
    filter: { owner: "octocat", repo: "hello-world", state: "open" },
    baseUrl: null,
    jiraConnectionId: null,
    hasToken: true,
    syncEnabled: false,
    syncIntervalMinutes: IMPORT_SYNC_DEFAULT_INTERVAL_MINUTES,
    consecutiveFailures: 0,
    disabledReason: null,
    lastRunAt: null,
    createdById: "user-1",
    createdAt: now,
    updatedAt: now,
    lastRun: null,
    ...overrides,
  };
}

const ok = (route: Route, data: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify({ success: true, data }),
  });

export interface ImportMockController {
  /** Live, mutable list returned by `listSources` (poll-backed). */
  sources: ImportSourceView[];
  /** Configure the next `Preview` response. */
  setPreview(preview: ImportPreview): void;
  /**
   * Configure how a `Run now` call mutates the target source's `lastRun`.
   * Defaults to a completed run with `createdCount = 0`.
   */
  setRunOutcome(outcome: Partial<ImportRunView>): void;
}

/**
 * Install deterministic stubs for the whole importer API surface and return a
 * controller for per-test configuration. Call this BEFORE navigating so the
 * mount-time `listSources` poll is intercepted.
 */
export async function installImportMocks(
  page: Page,
  projectId: string,
  initialSources: ImportSourceView[] = [],
): Promise<ImportMockController> {
  const ctrl: ImportMockController & {
    preview?: ImportPreview;
    runOutcome: Partial<ImportRunView>;
  } = {
    sources: initialSources,
    runOutcome: { createdCount: 0, updatedCount: 0, status: "completed" },
    setPreview(preview) {
      this.preview = preview;
    },
    setRunOutcome(outcome) {
      this.runOutcome = { ...this.runOutcome, ...outcome };
    },
  };

  const root = `**/api/projects/${projectId}/imports`;

  // POST /imports/preview
  await page.route(`${root}/preview`, (route) =>
    ok(route, ctrl.preview ?? buildPreview("github", 0)),
  );

  // POST /imports/sources/:id/run
  await page.route(`${root}/sources/*/run`, (route) => {
    const id = route.request().url().split("/sources/")[1]!.split("/")[0]!;
    const run = buildRun(id, projectId, { trigger: "manual", ...ctrl.runOutcome });
    const src = ctrl.sources.find((s) => s.id === id);
    if (src) {
      src.lastRun = run;
      src.lastRunAt = run.completedAt;
    }
    return ok(route, run);
  });

  // PATCH /imports/sources/:id/sync
  await page.route(`${root}/sources/*/sync`, (route) => {
    const id = route.request().url().split("/sources/")[1]!.split("/")[0]!;
    const body = route.request().postDataJSON() as {
      syncEnabled: boolean;
      syncIntervalMinutes?: number;
    };
    const src = ctrl.sources.find((s) => s.id === id);
    if (src) {
      src.syncEnabled = body.syncEnabled;
      if (typeof body.syncIntervalMinutes === "number") {
        src.syncIntervalMinutes = body.syncIntervalMinutes;
      }
    }
    return ok(route, src ?? buildSource(projectId, { id }));
  });

  // GET /imports/sources  ·  POST /imports/sources
  await page.route(`${root}/sources`, (route) => {
    const method = route.request().method();
    if (method === "POST") {
      const body = route.request().postDataJSON() as {
        source: ImportSourceKind;
        label: string;
        syncEnabled?: boolean;
        syncIntervalMinutes?: number;
      };
      const source = buildSource(projectId, {
        source: body.source,
        label: body.label,
        syncEnabled: body.syncEnabled ?? false,
        syncIntervalMinutes: body.syncIntervalMinutes ?? IMPORT_SYNC_DEFAULT_INTERVAL_MINUTES,
        lastRun: buildRun(nextId("src"), projectId, { status: "pending" }),
      });
      ctrl.sources.push(source);
      return ok(route, { source, run: source.lastRun }, 201);
    }
    return ok(route, ctrl.sources);
  });

  // DELETE /imports/sources/:id  (also serves GET getSource)
  await page.route(`${root}/sources/*`, (route) => {
    const id = route.request().url().split("/sources/")[1]!.split(/[/?]/)[0]!;
    if (route.request().method() === "DELETE") {
      ctrl.sources = ctrl.sources.filter((s) => s.id !== id);
      return route.fulfill({ status: 204, body: "" });
    }
    const src = ctrl.sources.find((s) => s.id === id) ?? buildSource(projectId, { id });
    return ok(route, src);
  });

  return ctrl;
}
