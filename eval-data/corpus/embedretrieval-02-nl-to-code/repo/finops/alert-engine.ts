/**
 * FinOps budget alert engine (Epic #47 / Issue #49).
 *
 * On each tick, for every workspace with a budget configured:
 *   1. Read the latest persisted workspace forecast (#48) for the projected
 *      month-end spend + month-to-date actual.
 *   2. Evaluate every enabled alert rule (`alert-rules.ts`).
 *   3. For each rule that should fire: dispatch to the workspace's enabled
 *      channels (#50), persist an `AlertEvent`, and advance the rule's
 *      `lastFiredAt` so the cooldown makes re-evaluation idempotent.
 *
 * Channel dispatch is injected (`AlertDispatcher`) so the engine has no hard
 * dependency on the SMTP/webhook transports and stays unit-testable. The
 * default dispatcher (`createDefaultDispatcher`) wires the #50 channels.
 */
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { notifyBudgetExceeded } from "../teams/notification-hooks.js";
import {
  evaluateRules,
  type AlertRuleState,
  type RuleEvaluation,
  type SpendSnapshot,
} from "./alert-rules.js";

const log = createChildLogger("finops-alert-engine");

export interface AlertChannelRow {
  id: string;
  type: string; // email | webhook
  target: string;
  secret: string | null;
  config: string;
}

export interface AlertNotification {
  workspaceId: string;
  workspaceName: string;
  /** Stable rule id — used for a stable PagerDuty dedup key (#51). */
  ruleId: string;
  ruleName: string;
  thresholdPct: number;
  basis: string;
  spendCents: number;
  budgetCents: number;
  ratio: number;
  firedAt: string;
}

export interface DeliveryResult {
  channelId: string;
  type: string;
  ok: boolean;
  error?: string;
  /**
   * #614 — true when the send was withheld because the recipient's
   * notification preference disabled it (not a delivery failure).
   */
  suppressed?: boolean;
}

/** Injected channel dispatcher. Returns one result per channel. */
export type AlertDispatcher = (
  channels: AlertChannelRow[],
  notification: AlertNotification,
) => Promise<DeliveryResult[]>;

const NOOP_DISPATCHER: AlertDispatcher = async (channels) =>
  channels.map((c) => ({ channelId: c.id, type: c.type, ok: true }));

export interface AlertEngineOptions {
  dispatcher?: AlertDispatcher;
}

/**
 * Run a single alert-engine tick for one workspace. Returns the list of
 * AlertEvents that fired (empty when nothing tripped). Idempotent within the
 * cooldown window: a second call before cooldown elapses fires nothing.
 */
export async function tickWorkspace(
  workspaceId: string,
  now: Date = new Date(),
  opts: AlertEngineOptions = {},
): Promise<RuleEvaluation[]> {
  const dispatcher = opts.dispatcher ?? NOOP_DISPATCHER;

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, monthlyBudgetCents: true },
  });
  if (!workspace || workspace.monthlyBudgetCents == null || workspace.monthlyBudgetCents <= 0) {
    return [];
  }

  const forecast = await prisma.costForecast.findFirst({
    where: { workspaceId, projectId: null },
    orderBy: { computedAt: "desc" },
  });
  if (!forecast) return [];

  const snapshot: SpendSnapshot = {
    budgetCents: workspace.monthlyBudgetCents,
    monthToDateCents: forecast.monthToDateCents,
    projectedMonthEndCents: forecast.projectedMonthEndCents,
  };

  const rules = (await prisma.alertRule.findMany({
    where: { workspaceId, enabled: true },
  })) as unknown as AlertRuleState[];

  const fired = evaluateRules(rules, snapshot, now);
  if (fired.length === 0) return [];

  const channels = (await prisma.alertChannel.findMany({
    where: { workspaceId, enabled: true },
  })) as unknown as AlertChannelRow[];

  for (const evaluation of fired) {
    const rule = rules.find((r) => r.id === evaluation.ruleId);
    const notification: AlertNotification = {
      workspaceId,
      workspaceName: workspace.name,
      ruleId: evaluation.ruleId,
      ruleName: rule?.name ?? evaluation.ruleId,
      thresholdPct: rule?.thresholdPct ?? 0,
      basis: evaluation.basis,
      spendCents: evaluation.spendCents,
      budgetCents: evaluation.budgetCents,
      ratio: evaluation.ratio,
      firedAt: now.toISOString(),
    };

    let deliveries: DeliveryResult[] = [];
    try {
      deliveries = await dispatcher(channels, notification);
    } catch (err) {
      log.warn("alert dispatch failed", {
        workspaceId,
        ruleId: evaluation.ruleId,
        error: (err as Error).message,
      });
      deliveries = channels.map((c) => ({
        channelId: c.id,
        type: c.type,
        ok: false,
        error: (err as Error).message,
      }));
    }

    // Persist the fire + advance lastFiredAt atomically so the cooldown is
    // durable (idempotency state). Both writes must land for the rule to be
    // considered fired — a crash between them would otherwise re-fire the
    // alert on the next tick. `$transaction([...])` makes the pair all-or-
    // nothing (Mi1).
    await prisma.$transaction([
      prisma.alertEvent.create({
        data: {
          workspaceId,
          ruleId: evaluation.ruleId,
          spendCents: evaluation.spendCents,
          budgetCents: evaluation.budgetCents,
          ratio: evaluation.ratio,
          basis: evaluation.basis,
          deliveries: JSON.stringify(deliveries),
        },
      }),
      prisma.alertRule.update({
        where: { id: evaluation.ruleId },
        data: { lastFiredAt: now },
      }),
    ]);

    // Issue #67 — best-effort one-way Teams notification card for the budget
    // alert, fired ONLY after the AlertEvent is durably persisted (so it inherits
    // the rule's cooldown idempotency — no duplicate cards within a window). This
    // is an ADDITIONAL Teams card alongside the workspace's configured #50
    // email/webhook channels, NOT a replacement: it routes via the #67
    // notification target, independent of the AlertChannel dispatcher above.
    // Synchronous + non-throwing; it schedules a fire-and-forget send internally.
    notifyBudgetExceeded(workspaceId, {
      workspaceName: notification.workspaceName,
      ruleName: notification.ruleName,
      basis: notification.basis,
      spendCents: notification.spendCents,
      budgetCents: notification.budgetCents,
      ratio: notification.ratio,
    });
  }

  return fired;
}

/** Run a tick across every workspace with a budget. */
export async function tickAllWorkspaces(
  now: Date = new Date(),
  opts: AlertEngineOptions = {},
): Promise<number> {
  const workspaces = await prisma.workspace.findMany({
    where: { deletedAt: null, monthlyBudgetCents: { not: null } },
    select: { id: true },
  });
  let firedCount = 0;
  for (const ws of workspaces) {
    try {
      const fired = await tickWorkspace(ws.id, now, opts);
      firedCount += fired.length;
    } catch (err) {
      log.warn("alert tick failed", { workspaceId: ws.id, error: (err as Error).message });
    }
  }
  return firedCount;
}

export interface AlertEngineHandle {
  stop(): void;
}

/** Default tick cadence: 15 minutes. */
const DEFAULT_INTERVAL_MS = 15 * 60 * 1_000;

let defaultDispatcherFactory: (() => AlertDispatcher) | null = null;

/**
 * Register the production dispatcher factory (wired by #50). Kept as a setter
 * so the engine module has no static import of the channel transports.
 */
export function setDefaultDispatcherFactory(factory: (() => AlertDispatcher) | null): void {
  defaultDispatcherFactory = factory;
}

/**
 * Start the alert-engine interval. Mirrors the SLA-checker lifecycle.
 */
export function startAlertEngine(intervalMs = DEFAULT_INTERVAL_MS): AlertEngineHandle {
  const timer = setInterval(() => {
    const dispatcher = defaultDispatcherFactory?.();
    tickAllWorkspaces(new Date(), dispatcher ? { dispatcher } : {}).catch((err) => {
      log.error("alert engine tick failed", { error: (err as Error).message });
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  log.info("alert engine started", { intervalMs });
  return {
    stop() {
      clearInterval(timer);
      log.info("alert engine stopped");
    },
  };
}
