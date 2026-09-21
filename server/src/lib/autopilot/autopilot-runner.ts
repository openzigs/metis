/**
 * Autopilot runner (Epic #164).
 *
 * Wraps the scheduled-analysis path. The contract is intentionally narrow:
 *
 *   1. Project must have `autopilotEnabled = true`. Otherwise throws
 *      `AUTOPILOT_DISABLED` (the scheduler create route also enforces this
 *      so jobs never reach this point — but defense-in-depth).
 *   2. The current MTD cost must be below `autopilotCostCeilingCents` (or
 *      no ceiling configured). Throws `AUTOPILOT_COST_CEILING` otherwise.
 *   3. After every chunk/tool call the runner re-checks the ceiling via
 *      `assertCeiling()`. The actual streaming integration calls
 *      `assertCeiling` between provider events.
 *   4. Audit row written at start, abort, and complete via the existing
 *      audit service. Notification is emitted on the project room.
 *
 * Human-approval is intentionally NOT honoured in this path — the runner
 * uses the project policy as-is but the analysis orchestrator's tool gate
 * is configured to auto-approve only when the session policy is `auto`.
 */
import { audit } from "../audit/audit-service.js";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { assertWithinBudget, projectMonthlyCost } from "../finops/budget-enforcer.js";

const log = createChildLogger("autopilot");

export class AutopilotDisabledError extends Error {
  readonly status = 400;
  readonly code = "AUTOPILOT_DISABLED";
  constructor(projectId: string) {
    super(`Autopilot is not enabled for project ${projectId}`);
    this.name = "AutopilotDisabledError";
  }
}

export class AutopilotCostCeilingError extends Error {
  readonly status = 402;
  readonly code = "AUTOPILOT_COST_CEILING";
  readonly projectedCents: number;
  readonly ceilingCents: number;
  constructor(projectedCents: number, ceilingCents: number) {
    super(
      `Autopilot run aborted — projected cost ${projectedCents}¢ exceeds ceiling ${ceilingCents}¢`,
    );
    this.name = "AutopilotCostCeilingError";
    this.projectedCents = projectedCents;
    this.ceilingCents = ceilingCents;
  }
}

export interface AutopilotProjectSettings {
  autopilotEnabled: boolean;
  autopilotCostCeilingCents: number | null;
  monthlyTokenBudget: number | null;
}

export async function loadAutopilotSettings(
  projectId: string,
): Promise<AutopilotProjectSettings | null> {
  const row = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      autopilotEnabled: true,
      autopilotCostCeilingCents: true,
      monthlyTokenBudget: true,
    },
  });
  return row ?? null;
}

/**
 * Single pre-flight check used by both the scheduled-analysis create route
 * and the runner itself.
 */
export async function assertAutopilotAllowed(
  projectId: string,
  now: Date = new Date(),
): Promise<AutopilotProjectSettings> {
  const settings = await loadAutopilotSettings(projectId);
  if (!settings) throw new AutopilotDisabledError(projectId);
  if (!settings.autopilotEnabled) throw new AutopilotDisabledError(projectId);
  // Budget gate first — cheaper to fail than ceiling.
  await assertWithinBudget(projectId, now);
  if (settings.autopilotCostCeilingCents != null) {
    const projected = await projectMonthlyCost(projectId, now);
    if (projected >= settings.autopilotCostCeilingCents) {
      throw new AutopilotCostCeilingError(projected, settings.autopilotCostCeilingCents);
    }
  }
  return settings;
}

/**
 * Mid-stream re-check used by long-running provider streams. Throws when
 * the projection has crossed the ceiling since `assertAutopilotAllowed`
 * passed at start-of-run.
 */
export async function assertCeiling(
  projectId: string,
  ceilingCents: number | null,
  now: Date = new Date(),
): Promise<number> {
  if (ceilingCents == null) return 0;
  const projected = await projectMonthlyCost(projectId, now);
  if (projected >= ceilingCents) {
    throw new AutopilotCostCeilingError(projected, ceilingCents);
  }
  return projected;
}

export interface RunAutopilotOptions {
  projectId: string;
  /** Identity of the trigger ("scheduler" by default). */
  triggeredBy?: string;
  /** Body of the actual analysis run — receives the AbortSignal. */
  run: (signal: AbortSignal) => Promise<unknown>;
  /** Override clock for tests. */
  now?: () => Date;
}

export interface RunAutopilotResult {
  status: "completed" | "aborted";
  reason?: string;
  result?: unknown;
}

/**
 * Wrap a run with the full autopilot rails: pre-flight check, lifecycle
 * audit, and abort-on-ceiling watchdog.
 *
 * The watchdog re-checks the cost projection every `watchdogMs`
 * (default 15s). On ceiling violation it aborts the AbortController so
 * the underlying analysis can clean up.
 */
export async function runAutopilot(opts: RunAutopilotOptions): Promise<RunAutopilotResult> {
  const now = opts.now ?? (() => new Date());
  const settings = await assertAutopilotAllowed(opts.projectId, now());
  const ac = new AbortController();
  const triggeredBy = opts.triggeredBy ?? "scheduler";

  audit({
    actor: { id: null },
    action: "autopilot.run.start",
    target: { type: "project", id: opts.projectId },
    metadata: {
      triggeredBy,
      monthlyTokenBudget: settings.monthlyTokenBudget,
      autopilotCostCeilingCents: settings.autopilotCostCeilingCents,
    },
  });

  let abortReason: string | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  if (settings.autopilotCostCeilingCents != null) {
    watchdog = setInterval(() => {
      void (async () => {
        try {
          await assertCeiling(opts.projectId, settings.autopilotCostCeilingCents, now());
        } catch (err) {
          if (err instanceof AutopilotCostCeilingError) {
            abortReason = err.code;
            ac.abort();
          } else {
            log.error("Autopilot watchdog error", { error: (err as Error).message });
          }
        }
      })();
    }, 15_000);
    // Don't keep node alive just for the watchdog.
    if (typeof watchdog?.unref === "function") watchdog.unref();
  }

  try {
    const result = await opts.run(ac.signal);
    audit({
      actor: { id: null },
      action: "autopilot.run.complete",
      target: { type: "project", id: opts.projectId },
      metadata: { triggeredBy },
    });
    return { status: "completed", result };
  } catch (err) {
    if (err instanceof AutopilotCostCeilingError || abortReason) {
      audit({
        actor: { id: null },
        action: "autopilot.run.abort",
        target: { type: "project", id: opts.projectId },
        metadata: {
          triggeredBy,
          reason: abortReason ?? (err instanceof Error ? err.message : "unknown"),
        },
      });
      return { status: "aborted", reason: abortReason ?? (err as Error).message };
    }
    audit({
      actor: { id: null },
      action: "autopilot.run.failed",
      target: { type: "project", id: opts.projectId },
      metadata: { triggeredBy, error: (err as Error).message },
    });
    throw err;
  } finally {
    if (watchdog) clearInterval(watchdog);
  }
}
