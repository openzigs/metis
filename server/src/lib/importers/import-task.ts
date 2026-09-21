/**
 * Import task handler — issues #777 / #782.
 *
 * Registers the `import.run` task type with the scheduler. The handler simply
 * delegates to {@link ImportService.runSource}, threading the abort signal and
 * progress reporter through. Manual runs pass an `importRunId` so the existing
 * pending run is reused; scheduled fires create a fresh run.
 */
import type { TaskHandlerRegistry } from "../scheduler/types.js";
import type { ImportService } from "./import-service.js";

export const IMPORT_RUN_TASK_TYPE = "import.run";

export interface ImportTaskDeps {
  runSource: ImportService["runSource"];
}

/** Register the import.run handler on the given registry. */
export function registerImportTaskHandlers(
  registry: TaskHandlerRegistry,
  deps: ImportTaskDeps,
): void {
  registry.register({
    type: IMPORT_RUN_TASK_TYPE,
    description: "Run an inbound importer (GitHub / Jira / Azure DevOps / Linear)",
    handler: async (ctx) => {
      const importSourceId = String(ctx.task.payload.importSourceId ?? "");
      if (!importSourceId) {
        throw new Error("import.run task missing importSourceId in payload");
      }
      const runId =
        typeof ctx.task.payload.importRunId === "string" ? ctx.task.payload.importRunId : undefined;
      const run = await deps.runSource(importSourceId, {
        trigger: ctx.task.trigger === "scheduled" ? "scheduled" : "manual",
        runId,
        signal: ctx.signal,
        reportProgress: (p) =>
          ctx.reportProgress({ step: p.step, current: p.current, total: p.total }),
      });
      return {
        runId: run.id,
        status: run.status,
        created: run.createdCount,
        updated: run.updatedCount,
        skipped: run.skippedCount,
      };
    },
  });
}
