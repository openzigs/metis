/**
 * Import service — issues #777–#782.
 *
 * Orchestrates inbound importers: preview, persistence of {@link ImportSource}
 * rows, on-demand runs, idempotent upsert into {@link Requirement}, and the
 * optional ongoing-sync scheduled job. All external collaborators (prisma,
 * vault, scheduler, jira) are injected so the whole surface is unit-testable
 * without a database or network.
 */
import {
  IMPORT_PREVIEW_SAMPLE_SIZE,
  IMPORT_SYNC_FAILURE_THRESHOLD,
  type CreateImportSourceRequest,
  type ImportPreview,
  type ImportPreviewRequest,
  type ImportRunView,
  type ImportSourceKind,
  type ImportSourceView,
  type MappedRequirementPreview,
  type UpdateImportSyncRequest,
  parseImportFilter,
} from "@metis/shared";
import type { ImportFilter } from "@metis/shared";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import { getVaultService, type VaultService } from "../vault/vault-service.js";
import { getSchedulerBootstrap } from "../scheduler/index.js";
import type { TaskTrigger } from "../scheduler/types.js";
import { buildJiraClientForConnection } from "../connectors/jira/jira-service.js";
import { AppError } from "../../middleware/error-handler.js";
import { createChildLogger } from "../logger.js";
import { createImporter, sourceUsesToken, type ImporterDeps } from "./registry.js";
import type { JiraSearchClient } from "./jira-importer.js";
import { runImport, type RequirementStore } from "./base-importer.js";
import type { ImporterFetchContext, MappedRequirement } from "./types.js";
import { audit } from "../audit/audit-service.js";
import {
  jobEvents as defaultJobEvents,
  genericFailureMessage,
  type JobEventEmitter,
} from "../socket/job-events.js";

const log = createChildLogger("import-service");

/** Cap on items pulled during a preview so a huge filter can't hang the UI. */
const PREVIEW_MAX_SCAN = IMPORT_PREVIEW_SAMPLE_SIZE;

export interface EnqueuedTask {
  id: string;
}

export interface ScheduledJobRef {
  id: string;
}

export interface JiraResolution {
  client: JiraSearchClient;
  baseUrl: string;
}

export interface ImportServiceDeps {
  prisma: PrismaClient;
  vault: Pick<VaultService, "create" | "read" | "delete">;
  /** Enqueue a one-shot task (manual run). */
  enqueueTask: (input: {
    type: string;
    payload: Record<string, unknown>;
    projectId: string;
    createdById: string;
    trigger?: string;
  }) => Promise<EnqueuedTask>;
  /** Create/replace the recurring sync job. */
  createScheduledJob: (opts: {
    key: string;
    name: string;
    cron: string;
    taskType: string;
    payload: Record<string, unknown>;
    projectId: string;
    createdById: string;
  }) => Promise<ScheduledJobRef>;
  deleteScheduledJob: (id: string, actorId: string) => Promise<void>;
  /** Resolve a stored Jira connection into a search client + base URL. */
  resolveJira: (connectionId: string, projectId: string) => Promise<JiraResolution>;
  importerDeps?: ImporterDeps;
  now?: () => Date;
  sampleSize?: number;
  /**
   * Optional hook called when a scheduled sync is auto-disabled after
   * `IMPORT_SYNC_FAILURE_THRESHOLD` consecutive failures. Best-effort: called
   * fire-and-forget; errors are logged but never surface to the caller.
   *
   * Use this to emit an in-app notification so project members are alerted.
   */
  notifySyncDisabled?: (info: {
    projectId: string;
    importSourceId: string;
    label: string;
    source: string;
    consecutiveFailures: number;
    errorMessage: string;
  }) => void | Promise<void>;
  /**
   * Issue #424 (Epic #406) — unified job-lifecycle emitter. The active run
   * streams `started`/`progress`/`completed`/`failed` on the `import-sync`
   * {@link JobKind} keyed by the {@link ImportRun} id, so the import page can
   * render live progress + a terminal toast (via #423 `useJobToast`) instead of
   * sitting silent behind a 10s poll. Injected for tests; defaults to the live
   * registry-backed `jobEvents` singleton. Emission is fire-and-forget and never
   * affects the run's outcome.
   */
  jobEvents?: JobEventEmitter;
}

type ImportSourceRow = {
  id: string;
  projectId: string;
  analysisId: string;
  source: string;
  label: string;
  filter: string;
  baseUrl: string | null;
  jiraConnectionId: string | null;
  secretId: string | null;
  syncEnabled: boolean;
  syncIntervalMinutes: number;
  scheduledJobId: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
  lastRunAt: Date | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
};

type ImportRunRow = {
  id: string;
  importSourceId: string;
  projectId: string;
  trigger: string;
  status: string;
  taskId: string | null;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  totalFetched: number;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};

/**
 * Translate a sync interval (minutes) into a 5-field cron expression. Whole-hour
 * multiples collapse to an hourly form so the scheduler's minute field stays
 * within range.
 */
export function intervalToCron(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours >= 24 ? "0 0 * * *" : `0 */${hours} * * *`;
  }
  return `*/${minutes} * * * *`;
}

export class ImportService {
  constructor(private readonly deps: ImportServiceDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** Resolve the job-lifecycle emitter (injected for tests, live by default). */
  private get jobEvents(): JobEventEmitter {
    return this.deps.jobEvents ?? defaultJobEvents;
  }

  // ---------- credential resolution ----------

  /**
   * Build an importer for a source kind using already-resolved credentials.
   * `token` is required for token-based sources; Jira uses a stored connection.
   */
  private async buildImporterFor(
    source: ImportSourceKind,
    filter: ReturnType<typeof parseImportFilter>,
    projectId: string,
    creds: { token?: string | null; baseUrl?: string | null; jiraConnectionId?: string | null },
  ) {
    if (source === "jira") {
      const connectionId =
        creds.jiraConnectionId ??
        ("connectionId" in filter ? (filter as { connectionId: string }).connectionId : "");
      if (!connectionId) {
        throw new AppError(
          400,
          "IMPORT_JIRA_CONNECTION_REQUIRED",
          "a Jira connectionId is required",
        );
      }
      const customFieldMap =
        "customFieldMap" in filter
          ? (filter as { customFieldMap?: Record<string, string> }).customFieldMap
          : undefined;
      const { client, baseUrl } = await this.deps.resolveJira(connectionId, projectId);
      return createImporter(
        { source: "jira", client, baseUrl, customFieldMap },
        this.deps.importerDeps,
      );
    }
    if (!creds.token) {
      throw new AppError(400, "IMPORT_TOKEN_REQUIRED", `${source} import requires an API token`);
    }
    return createImporter(
      { source, token: creds.token, baseUrl: creds.baseUrl ?? null },
      this.deps.importerDeps,
    );
  }

  // ---------- preview ----------

  async preview(projectId: string, req: ImportPreviewRequest): Promise<ImportPreview> {
    const filter = parseImportFilter(req.source, req.filter);
    const importer = await this.buildImporterFor(req.source, filter, projectId, {
      token: req.token ?? null,
      baseUrl: req.baseUrl ?? null,
    });
    const count = await importer.count(filter, { signal: undefined });
    const sample: MappedRequirementPreview[] = [];
    const limit = this.deps.sampleSize ?? PREVIEW_MAX_SCAN;
    for await (const issue of importer.fetchAll(filter)) {
      const mapped = importer.map(issue);
      sample.push(toPreview(mapped));
      if (sample.length >= limit) break;
    }
    return { source: req.source, count, sample };
  }

  // ---------- CRUD ----------

  async listSources(projectId: string): Promise<ImportSourceView[]> {
    const rows = (await this.deps.prisma.importSource.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { createdAt: "desc" },
    })) as ImportSourceRow[];
    const views: ImportSourceView[] = [];
    for (const row of rows) {
      views.push(await this.toSourceView(row));
    }
    return views;
  }

  async getSource(projectId: string, id: string): Promise<ImportSourceView> {
    const row = await this.findSourceOrThrow(projectId, id);
    return this.toSourceView(row);
  }

  async createSource(
    projectId: string,
    req: CreateImportSourceRequest,
    userId: string,
  ): Promise<{ source: ImportSourceView; run: ImportRunView }> {
    const filter = parseImportFilter(req.source, req.filter);

    // Validate credentials up-front so we never persist an unusable source.
    if (sourceUsesToken(req.source) && !req.token) {
      throw new AppError(
        400,
        "IMPORT_TOKEN_REQUIRED",
        `${req.source} import requires an API token`,
      );
    }
    const jiraConnectionId =
      req.source === "jira" && "connectionId" in filter
        ? (filter as { connectionId: string }).connectionId
        : null;
    if (req.source === "jira") {
      // Surfaces a 404 early if the connection is missing.
      await this.deps.resolveJira(jiraConnectionId ?? "", projectId);
    }

    // Anchor imported requirements to a synthetic, completed Analysis run.
    const now = this.now();
    const analysis = await this.deps.prisma.analysis.create({
      data: {
        projectId,
        status: "completed",
        startedById: userId,
        completedAt: now,
        metadata: JSON.stringify({ kind: "import", source: req.source, label: req.label }),
      },
    });

    // Store the API token in the vault (token-based sources only).
    let secretId: string | null = null;
    if (req.token) {
      const secretLabel = `import-${req.source}-${projectId}-${req.label}`.replace(
        /[^a-zA-Z0-9_.-]/g,
        "-",
      );
      const secret = await this.deps.vault.create(secretLabel, req.token, "project", {
        description: `${req.source} importer token for ${req.label}`,
        createdById: userId,
      });
      secretId = secret.id;
    }

    const row = (await this.deps.prisma.importSource.create({
      data: {
        projectId,
        analysisId: analysis.id,
        source: req.source,
        label: req.label,
        filter: JSON.stringify(filter),
        baseUrl: req.baseUrl ?? null,
        jiraConnectionId,
        secretId,
        syncEnabled: false,
        syncIntervalMinutes: req.syncIntervalMinutes,
        createdById: userId,
      },
    })) as ImportSourceRow;

    let stored = row;
    if (req.syncEnabled) {
      stored = await this.applySync(stored, {
        syncEnabled: true,
        syncIntervalMinutes: req.syncIntervalMinutes,
      });
    }

    // Kick off the first import immediately.
    const runRow = (await this.deps.prisma.importRun.create({
      data: {
        importSourceId: stored.id,
        projectId,
        trigger: "manual",
        status: "pending",
      },
    })) as ImportRunRow;
    const task = await this.deps.enqueueTask({
      type: "import.run",
      payload: { importSourceId: stored.id, importRunId: runRow.id },
      projectId,
      createdById: userId,
      trigger: "manual",
    });
    const runWithTask = (await this.deps.prisma.importRun.update({
      where: { id: runRow.id },
      data: { taskId: task.id },
    })) as ImportRunRow;

    log.info("Import source created", { id: stored.id, source: req.source, projectId });
    return {
      source: await this.toSourceView(stored),
      run: toRunView(runWithTask),
    };
  }

  async deleteSource(projectId: string, id: string, userId: string): Promise<void> {
    const row = await this.findSourceOrThrow(projectId, id);
    if (row.scheduledJobId) {
      await this.deps.deleteScheduledJob(row.scheduledJobId, userId).catch((err) => {
        log.warn("Failed to delete scheduled job for import source", {
          id,
          jobId: row.scheduledJobId,
          err: String(err),
        });
      });
    }
    if (row.secretId) {
      await this.deps.vault.delete(row.secretId).catch(() => undefined);
    }
    await this.deps.prisma.importSource.update({
      where: { id },
      data: { deletedAt: this.now(), syncEnabled: false, scheduledJobId: null },
    });
    log.info("Import source deleted", { id, projectId });
  }

  // ---------- ongoing sync ----------

  async setSync(
    projectId: string,
    id: string,
    req: UpdateImportSyncRequest,
    userId: string,
  ): Promise<ImportSourceView> {
    const row = await this.findSourceOrThrow(projectId, id);
    const updated = await this.applySync(row, req, userId);
    return this.toSourceView(updated);
  }

  /**
   * Create/update/delete the recurring scheduled job to match the desired sync
   * state, then persist the source's sync columns.
   */
  private async applySync(
    row: ImportSourceRow,
    req: UpdateImportSyncRequest,
    userId: string = row.createdById,
  ): Promise<ImportSourceRow> {
    if (req.syncEnabled) {
      const interval = req.syncIntervalMinutes ?? row.syncIntervalMinutes;
      // Replace any existing job so the cron reflects the new interval.
      if (row.scheduledJobId) {
        await this.deps.deleteScheduledJob(row.scheduledJobId, userId).catch(() => undefined);
      }
      const job = await this.deps.createScheduledJob({
        key: `import-sync-${row.id}`,
        name: `Import sync: ${row.label}`,
        cron: intervalToCron(interval),
        taskType: "import.run",
        payload: { importSourceId: row.id },
        projectId: row.projectId,
        createdById: userId,
      });
      return (await this.deps.prisma.importSource.update({
        where: { id: row.id },
        data: {
          syncEnabled: true,
          syncIntervalMinutes: interval,
          scheduledJobId: job.id,
          consecutiveFailures: 0,
          disabledReason: null,
        },
      })) as ImportSourceRow;
    }

    if (row.scheduledJobId) {
      await this.deps.deleteScheduledJob(row.scheduledJobId, userId).catch(() => undefined);
    }
    return (await this.deps.prisma.importSource.update({
      where: { id: row.id },
      data: { syncEnabled: false, scheduledJobId: null },
    })) as ImportSourceRow;
  }

  // ---------- runs ----------

  async listRuns(projectId: string, importSourceId?: string): Promise<ImportRunView[]> {
    const rows = (await this.deps.prisma.importRun.findMany({
      where: { projectId, ...(importSourceId ? { importSourceId } : {}) },
      orderBy: { createdAt: "desc" },
      take: 50,
    })) as ImportRunRow[];
    return rows.map(toRunView);
  }

  /**
   * Create a pending {@link ImportRun}, enqueue an `import.run` task, and
   * return immediately (202 semantics). The task engine picks up the work
   * asynchronously; clients poll run status via {@link listRuns}.
   */
  async enqueueRun(
    importSourceId: string,
    opts: { trigger?: string; userId?: string } = {},
  ): Promise<ImportRunView> {
    const row = (await this.deps.prisma.importSource.findFirst({
      where: { id: importSourceId, deletedAt: null },
    })) as ImportSourceRow | null;
    if (!row) {
      throw new AppError(
        404,
        "IMPORT_SOURCE_NOT_FOUND",
        `import source ${importSourceId} not found`,
      );
    }
    const runRow = (await this.deps.prisma.importRun.create({
      data: {
        importSourceId,
        projectId: row.projectId,
        trigger: opts.trigger ?? "manual",
        status: "pending",
      },
    })) as ImportRunRow;
    const task = await this.deps.enqueueTask({
      type: "import.run",
      payload: { importSourceId, importRunId: runRow.id },
      projectId: row.projectId,
      createdById: opts.userId ?? row.createdById,
      trigger: opts.trigger ?? "manual",
    });
    const runWithTask = (await this.deps.prisma.importRun.update({
      where: { id: runRow.id },
      data: { taskId: task.id },
    })) as ImportRunRow;
    log.info("Import run enqueued", { importSourceId, taskId: task.id, trigger: opts.trigger });
    return toRunView(runWithTask);
  }

  /**
   * Execute an import. Loads the source, resolves credentials, upserts
   * requirements idempotently, and records the run + failure bookkeeping.
   * Never throws on importer failure — the failure is captured on the run row
   * so the task engine doesn't retry-storm.
   */
  async runSource(
    importSourceId: string,
    opts: {
      trigger?: string;
      runId?: string;
      signal?: AbortSignal;
      reportProgress?: (p: { step: string; current?: number; total?: number }) => void;
    } = {},
  ): Promise<ImportRunView> {
    const row = (await this.deps.prisma.importSource.findFirst({
      where: { id: importSourceId, deletedAt: null },
    })) as ImportSourceRow | null;
    if (!row) {
      throw new AppError(
        404,
        "IMPORT_SOURCE_NOT_FOUND",
        `import source ${importSourceId} not found`,
      );
    }

    const startedAt = this.now();
    let run: ImportRunRow;
    if (opts.runId) {
      run = (await this.deps.prisma.importRun.update({
        where: { id: opts.runId },
        data: { status: "running", startedAt },
      })) as ImportRunRow;
    } else {
      run = (await this.deps.prisma.importRun.create({
        data: {
          importSourceId,
          projectId: row.projectId,
          trigger: opts.trigger ?? "scheduled",
          status: "running",
          startedAt,
        },
      })) as ImportRunRow;
    }

    // Issue #424 — announce the active run so the import page can render live
    // progress immediately (keyed by the run id = the jobId).
    this.jobEvents.started("import-sync", run.id, row.projectId, `Importing from ${row.label}…`);

    try {
      const filter = parseImportFilter(row.source as ImportSourceKind, JSON.parse(row.filter));
      let token: string | null = null;
      if (row.secretId) {
        const secret = await this.deps.vault.read(row.secretId);
        token = secret.plaintext;
      }
      const importer = await this.buildImporterFor(
        row.source as ImportSourceKind,
        filter,
        row.projectId,
        { token, baseUrl: row.baseUrl, jiraConnectionId: row.jiraConnectionId },
      );

      // Best-effort total so the live progress bar can be determinate. A failure
      // to count (e.g. a provider that doesn't support it) degrades gracefully to
      // an indeterminate bar — it never fails the run.
      let total: number | undefined;
      try {
        total = await importer.count(filter, { signal: opts.signal });
      } catch {
        total = undefined;
      }

      const store = this.buildRequirementStore();
      const ctx: ImporterFetchContext = {
        signal: opts.signal,
        onProgress: (info) => {
          opts.reportProgress?.({ step: "fetch", current: info.fetched, total });
          // Issue #424 — stream determinate progress (0-100) when the total is
          // known; omit the percentage otherwise so the UI shows an
          // indeterminate "working" bar rather than a misleading number.
          const pct =
            total && total > 0
              ? Math.min(100, Math.max(0, Math.round((info.fetched / total) * 100)))
              : 0;
          this.jobEvents.progress(
            "import-sync",
            run.id,
            row.projectId,
            pct,
            total ? `Fetched ${info.fetched}/${total} issues` : `Fetched ${info.fetched} issues`,
          );
        },
      };
      const result = await runImport({
        importer,
        filter,
        store,
        projectId: row.projectId,
        analysisId: row.analysisId,
        importSourceId: row.id,
        ctx,
      });

      const completed = (await this.deps.prisma.importRun.update({
        where: { id: run.id },
        data: {
          status: "completed",
          createdCount: result.created,
          updatedCount: result.updated,
          skippedCount: result.skipped,
          totalFetched: result.total,
          completedAt: this.now(),
        },
      })) as ImportRunRow;

      await this.deps.prisma.importSource.update({
        where: { id: row.id },
        data: { lastRunAt: this.now(), consecutiveFailures: 0, disabledReason: null },
      });

      log.info("Import run completed", {
        importSourceId,
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
      });
      // Issue #424 — terminal success drives the success toast (#423 useJobToast)
      // and demotes the 10s poll to a fallback.
      this.jobEvents.completed(
        "import-sync",
        run.id,
        row.projectId,
        `Imported ${result.created} new, ${result.updated} updated from ${row.label}`,
      );
      return toRunView(completed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed = (await this.deps.prisma.importRun.update({
        where: { id: run.id },
        data: { status: "failed", errorMessage: message, completedAt: this.now() },
      })) as ImportRunRow;

      // Issue #424 / #254 — emit a GENERIC, user-safe failure over the socket.
      // The raw `message` is persisted on the run row + logged below, never sent
      // to the client, so no stack/internal detail leaks (OWASP).
      this.jobEvents.failed(
        "import-sync",
        run.id,
        row.projectId,
        genericFailureMessage("import-sync"),
      );

      const failures = row.consecutiveFailures + 1;
      const shouldDisable = row.syncEnabled && failures >= IMPORT_SYNC_FAILURE_THRESHOLD;
      if (shouldDisable && row.scheduledJobId) {
        await this.deps
          .deleteScheduledJob(row.scheduledJobId, row.createdById)
          .catch(() => undefined);
      }
      await this.deps.prisma.importSource.update({
        where: { id: row.id },
        data: {
          consecutiveFailures: failures,
          ...(shouldDisable
            ? {
                syncEnabled: false,
                scheduledJobId: null,
                disabledReason: `auto-disabled after ${failures} consecutive failures: ${message}`,
              }
            : {}),
        },
      });

      // Issue #782: notify project members when sync is auto-disabled.
      if (shouldDisable && this.deps.notifySyncDisabled) {
        void Promise.resolve(
          this.deps.notifySyncDisabled({
            projectId: row.projectId,
            importSourceId: row.id,
            label: row.label,
            source: row.source,
            consecutiveFailures: failures,
            errorMessage: message,
          }),
        ).catch((notifyErr: unknown) => {
          log.warn("Failed to emit sync-disabled notification", {
            importSourceId,
            err: String(notifyErr),
          });
        });
      }

      log.error("Import run failed", { importSourceId, failures, shouldDisable, err: message });
      return toRunView(failed);
    }
  }

  // ---------- prisma-backed requirement store ----------

  private buildRequirementStore(): RequirementStore {
    const prisma = this.deps.prisma;
    return {
      async findByExternal(projectId, externalSource, externalId) {
        const existing = await prisma.requirement.findFirst({
          where: { projectId, externalSource, externalId, deletedAt: null },
        });
        return existing ? { id: existing.id } : null;
      },
      async create(input) {
        const created = await prisma.requirement.create({
          data: {
            projectId: input.projectId,
            analysisId: input.analysisId,
            type: input.type,
            title: input.title,
            body: input.body,
            priority: input.priority,
            labels: JSON.stringify(input.labels),
            externalSource: input.externalSource,
            externalId: input.externalId,
            externalUrl: input.externalUrl,
            importSourceId: input.importSourceId,
          },
        });
        return { id: created.id };
      },
      async update(id, input) {
        const updated = await prisma.requirement.update({
          where: { id },
          data: {
            type: input.type,
            title: input.title,
            body: input.body,
            priority: input.priority,
            labels: JSON.stringify(input.labels),
            externalUrl: input.externalUrl,
            importSourceId: input.importSourceId,
          },
        });
        return { id: updated.id };
      },
      async setParent(childId: string, parentId: string) {
        await prisma.requirement.update({ where: { id: childId }, data: { parentId } });
      },
    };
  }

  // ---------- helpers ----------

  private async findSourceOrThrow(projectId: string, id: string): Promise<ImportSourceRow> {
    const row = (await this.deps.prisma.importSource.findFirst({
      where: { id, projectId, deletedAt: null },
    })) as ImportSourceRow | null;
    if (!row) {
      throw new AppError(404, "IMPORT_SOURCE_NOT_FOUND", `import source ${id} not found`);
    }
    return row;
  }

  private async toSourceView(row: ImportSourceRow): Promise<ImportSourceView> {
    const lastRun = (await this.deps.prisma.importRun.findFirst({
      where: { importSourceId: row.id },
      orderBy: { createdAt: "desc" },
    })) as ImportRunRow | null;
    return {
      id: row.id,
      projectId: row.projectId,
      analysisId: row.analysisId,
      source: row.source as ImportSourceKind,
      label: row.label,
      filter: safeParseFilter(row.source as ImportSourceKind, row.filter),
      baseUrl: row.baseUrl,
      jiraConnectionId: row.jiraConnectionId,
      hasToken: Boolean(row.secretId),
      syncEnabled: row.syncEnabled,
      syncIntervalMinutes: row.syncIntervalMinutes,
      consecutiveFailures: row.consecutiveFailures,
      disabledReason: row.disabledReason,
      lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
      createdById: row.createdById,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastRun: lastRun ? toRunView(lastRun) : null,
    };
  }
}

function toPreview(m: MappedRequirement): MappedRequirementPreview {
  return {
    externalId: m.externalId,
    externalUrl: m.externalUrl,
    title: m.title,
    type: m.type,
    priority: m.priority,
    labels: m.labels,
  };
}

function toRunView(row: ImportRunRow): ImportRunView {
  return {
    id: row.id,
    importSourceId: row.importSourceId,
    projectId: row.projectId,
    trigger: row.trigger as ImportRunView["trigger"],
    status: row.status as ImportRunView["status"],
    taskId: row.taskId,
    createdCount: row.createdCount,
    updatedCount: row.updatedCount,
    skippedCount: row.skippedCount,
    totalFetched: row.totalFetched,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Parse a stored filter JSON back into its typed shape (already validated). */
function safeParseFilter(source: ImportSourceKind, json: string): ImportFilter {
  try {
    return parseImportFilter(source, JSON.parse(json));
  } catch {
    // Stored filter should always be valid; fall back to the raw object.
    try {
      return JSON.parse(json) as ImportFilter;
    } catch {
      return {} as ImportFilter;
    }
  }
}

let singleton: ImportService | null = null;

/** Default-wired singleton used by the routes. */
export function getImportService(): ImportService {
  if (singleton) return singleton;
  singleton = new ImportService({
    prisma: defaultPrisma,
    vault: getVaultService(),
    enqueueTask: async (input) => {
      const task = await getSchedulerBootstrap().queue.enqueue({
        type: input.type,
        payload: input.payload,
        projectId: input.projectId,
        createdById: input.createdById,
        trigger: input.trigger as TaskTrigger | undefined,
      });
      return { id: task.id };
    },
    createScheduledJob: async (opts) => {
      const job = await getSchedulerBootstrap().scheduler.createJob(opts);
      return { id: job.id };
    },
    deleteScheduledJob: async (id, actorId) => {
      await getSchedulerBootstrap().scheduler.deleteJob(id, actorId);
    },
    resolveJira: async (connectionId, projectId) => {
      const client = await buildJiraClientForConnection(connectionId, projectId);
      const conn = await defaultPrisma.jiraConnection.findFirst({
        where: { id: connectionId, projectId, deletedAt: null },
      });
      if (!conn) {
        throw new AppError(
          404,
          "JIRA_CONNECTION_NOT_FOUND",
          `Jira connection ${connectionId} not found`,
        );
      }
      return { client: client as unknown as JiraSearchClient, baseUrl: conn.baseUrl };
    },
    // Issue #782: emit an audit log entry when sync is auto-disabled so the
    // project owner has a persistent, queryable record of the failure event.
    notifySyncDisabled: ({
      importSourceId,
      projectId,
      label,
      source,
      consecutiveFailures,
      errorMessage,
    }) => {
      audit({
        actor: null,
        action: "import.sync.disabled",
        target: { type: "importSource", id: importSourceId },
        metadata: { projectId, label, source, consecutiveFailures, errorMessage },
      });
    },
  });
  return singleton;
}

/** Test seam — reset the singleton. */
export function __resetImportService(): void {
  singleton = null;
}
