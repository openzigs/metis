/**
 * Issue #260 — wire the running `SchedulerService` to the runtime-config
 * event bus.
 *
 * Subscribes to `config.changed` for two registered tunables:
 *
 *   - `SCHEDULER_ENABLED` — flips the master switch. `false` drains the
 *     in-flight tick (no new crons fired, queued tasks complete) and stops
 *     every cron entry. `true` rebuilds cron registrations from the database.
 *   - `SCHEDULER_TICK_INTERVAL_MS` — restarts the scheduler so the new
 *     interval is picked up by the queue's tick loop. The in-flight tick is
 *     allowed to complete first to avoid a double-fire across the restart.
 *
 * The subscriber is **idempotent** — calling `subscribeSchedulerToConfig`
 * twice without unsubscribing replaces the existing listener. Returns an
 * unsubscribe handle so `bootstrap.shutdown()` can drop the listener
 * cleanly.
 *
 * NB: writes are serialized through a single in-flight promise so two events
 * arriving back-to-back never overlap a stop/start cycle. Without this
 * guard a `SCHEDULER_ENABLED → SCHEDULER_TICK_INTERVAL_MS` rapid sequence
 * could leave the scheduler running with the older config.
 */
import { type ConfigChangedEvent, type ConfigService, getConfigService } from "../config/index.js";
import { createChildLogger } from "../logger.js";
import type { SchedulerBootstrap } from "./index.js";
import type { SchedulerConfig } from "./types.js";

const log = createChildLogger("scheduler-runtime-config");

/** Keys we react to. `SCHEDULER_TICK_INTERVAL_MS` maps to `config.tickMs`. */
const SCHEDULER_KEYS = ["SCHEDULER_ENABLED", "SCHEDULER_TICK_INTERVAL_MS"] as const;
type SchedulerKey = (typeof SCHEDULER_KEYS)[number];

function isSchedulerKey(key: string): key is SchedulerKey {
  return (SCHEDULER_KEYS as readonly string[]).includes(key);
}

export interface SchedulerSubscriberOptions {
  /** Override the global `ConfigService` singleton (tests). */
  configService?: ConfigService;
}

/**
 * Subscribe the scheduler to runtime-config changes. Returns an unsubscribe
 * handle that detaches the listener and resolves any in-flight restart.
 */
export function subscribeSchedulerToConfig(
  bootstrap: SchedulerBootstrap,
  opts: SchedulerSubscriberOptions = {},
): () => void {
  const svc = opts.configService ?? getConfigService();
  let inflight: Promise<void> = Promise.resolve();

  const handler = (evt: ConfigChangedEvent): void => {
    if (!isSchedulerKey(evt.key)) return;
    const key: SchedulerKey = evt.key;
    // Chain serially so a burst of changes never overlaps a restart cycle.
    inflight = inflight
      .then(() => applySchedulerChange(bootstrap, key, svc))
      .catch((err: unknown) => {
        log.error("Scheduler runtime-config apply failed", {
          key,
          error: (err as Error).message,
        });
      });
  };

  svc.on("config.changed", handler);
  log.info("Scheduler subscribed to config.changed", { keys: [...SCHEDULER_KEYS] });

  return (): void => {
    svc.off("config.changed", handler);
  };
}

/**
 * Apply a single scheduler-key change. Reads the current effective value
 * (DB → env fallback handled by `ConfigService`) and restarts the scheduler
 * if the new state differs from the cached config.
 */
async function applySchedulerChange(
  bootstrap: SchedulerBootstrap,
  key: SchedulerKey,
  svc: ConfigService,
): Promise<void> {
  const cfg = mutableConfig(bootstrap);
  if (key === "SCHEDULER_ENABLED") {
    const next = svc.getBool("SCHEDULER_ENABLED", cfg.enabled);
    if (next === cfg.enabled) return;
    cfg.enabled = next;
    await bootstrap.scheduler.stop();
    if (next) await bootstrap.scheduler.start();
    log.info("Scheduler enabled flag applied", { enabled: next });
    return;
  }
  if (key === "SCHEDULER_TICK_INTERVAL_MS") {
    const next = svc.getNumber("SCHEDULER_TICK_INTERVAL_MS", cfg.tickMs);
    if (next === cfg.tickMs) return;
    cfg.tickMs = next;
    if (cfg.enabled) {
      await bootstrap.scheduler.stop();
      await bootstrap.scheduler.start();
    }
    log.info("Scheduler tick interval applied", { tickMs: next });
  }
}

/** Narrow type assertion — the bootstrap config object is mutated in place. */
function mutableConfig(bootstrap: SchedulerBootstrap): SchedulerConfig {
  return bootstrap.config;
}
