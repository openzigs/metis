/**
 * Scheduler + Tasks public surface (Phase 11).
 *
 * Boot order:
 *   1. `bootstrapScheduler({io})` builds the registry, queue, scheduler.
 *   2. Caller may pass `handlerOverrides` to wire downstream services.
 *   3. `scheduler.start()` registers cron schedules from the database.
 */
import type { MetisIOServer } from "../socket/server.js";
import { loadSchedulerConfig } from "./config.js";
import { InMemoryTaskHandlerRegistry, registerBuiltInHandlers } from "./task-handlers.js";
import { TaskQueue } from "./task-queue.js";
import { createPrismaTaskStore, readTaskRecord } from "./task-store.js";
import { SchedulerService } from "./scheduler-service.js";
import { createSchedulerEmitter, NOOP_SCHEDULER_EMITTER } from "./socket-emitter.js";
import { createHttpWebhookHandler } from "./webhook-handler.js";
import { runScanWithPrismaPorts } from "../scanner/prisma-adapter.js";
import type { BuiltInHandlerDeps } from "./task-handlers.js";
import type { SchedulerConfig, SchedulerEmitter } from "./types.js";

export * from "./types.js";
export { TaskQueue } from "./task-queue.js";
export { SchedulerService } from "./scheduler-service.js";
export { InMemoryTaskHandlerRegistry, registerBuiltInHandlers } from "./task-handlers.js";
export { validateCron, nextRunOf } from "./cron-validator.js";
export { loadSchedulerConfig, SCHEDULER_DEFAULTS } from "./config.js";
export { createPrismaTaskStore, readTaskRecord } from "./task-store.js";
export { createSchedulerEmitter, NOOP_SCHEDULER_EMITTER } from "./socket-emitter.js";
export {
  createHttpWebhookHandler,
  loadWebhookConfig,
  type WebhookHandlerConfig,
} from "./webhook-handler.js";
export {
  subscribeSchedulerToConfig,
  type SchedulerSubscriberOptions,
} from "./runtime-config-subscriber.js";
export {
  LeaderElector,
  AlwaysLeader,
  PostgresLeaseBackend,
  resolveLeaderElection,
  withJobWindowLock,
  DEFAULT_LOCK_NAME,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_RENEW_INTERVAL_MS,
  type LeaseBackend,
  type LeaderElectorOptions,
  type JobWindowLockOptions,
  type JobWindowResult,
  type ResolveLeaderElectionEnv,
} from "./leader-election.js";

export interface SchedulerBootstrap {
  scheduler: SchedulerService;
  queue: TaskQueue;
  registry: InMemoryTaskHandlerRegistry;
  emitter: SchedulerEmitter;
  config: SchedulerConfig;
  shutdown(): Promise<void>;
}

export interface BootstrapSchedulerOptions {
  io?: MetisIOServer;
  handlerOverrides?: Partial<BuiltInHandlerDeps>;
  config?: SchedulerConfig;
}

let active: SchedulerBootstrap | null = null;

export function bootstrapScheduler(opts: BootstrapSchedulerOptions = {}): SchedulerBootstrap {
  if (active) return active;
  const config = opts.config ?? loadSchedulerConfig();
  const emitter = opts.io ? createSchedulerEmitter(opts.io) : NOOP_SCHEDULER_EMITTER;
  const registry = new InMemoryTaskHandlerRegistry();
  const handlerDeps: BuiltInHandlerDeps = {
    httpWebhookHandler: opts.handlerOverrides?.httpWebhookHandler ?? createHttpWebhookHandler(),
    refreshRepoConnector: opts.handlerOverrides?.refreshRepoConnector,
    refreshDbConnectorSchema: opts.handlerOverrides?.refreshDbConnectorSchema,
    rerunAnalysis: opts.handlerOverrides?.rerunAnalysis,
    publishBatch: opts.handlerOverrides?.publishBatch,
    publishGeneratedDocument: opts.handlerOverrides?.publishGeneratedDocument,
    regenerateGeneratedDocument: opts.handlerOverrides?.regenerateGeneratedDocument,
    runScannerScan:
      opts.handlerOverrides?.runScannerScan ??
      (async (scanId, signal) => {
        await runScanWithPrismaPorts(scanId, signal);
        return { scanId };
      }),
  };
  registerBuiltInHandlers(registry, handlerDeps);
  const store = createPrismaTaskStore();
  const queue = new TaskQueue(store, registry, emitter, config);
  const scheduler = new SchedulerService({ queue, registry, emitter, config });
  active = {
    scheduler,
    queue,
    registry,
    emitter,
    config,
    shutdown: async () => {
      await scheduler.stop();
      await queue.shutdown();
      active = null;
    },
  };
  return active;
}

export function getSchedulerBootstrap(): SchedulerBootstrap {
  if (!active) {
    throw new Error("scheduler bootstrap has not been initialised; call bootstrapScheduler first");
  }
  return active;
}

/** Test seam — clear the singleton between unit tests. */
export function __resetSchedulerBootstrap(): void {
  active = null;
}

/** Convenience: read a TaskRecord, throw 404 if missing. */
export { readTaskRecord as fetchTaskRecord };
