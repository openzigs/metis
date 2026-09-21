/**
 * Scheduler config loader — reads env vars with safe defaults.
 */
import type { SchedulerConfig } from "./types.js";

export const SCHEDULER_DEFAULTS: SchedulerConfig = {
  concurrency: 4,
  tickMs: 1000,
  defaultTimeoutMs: 5 * 60 * 1000,
  retryBackoffMs: 1000,
  retryBackoffMaxMs: 60 * 1000,
  minCronIntervalSec: 60,
  enabled: true,
};

function parseIntEnv(raw: string | undefined, fallback: number, min = 0): number {
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, n);
}

function parseBoolEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export function loadSchedulerConfig(env: NodeJS.ProcessEnv = process.env): SchedulerConfig {
  return {
    concurrency: parseIntEnv(env.SCHEDULER_CONCURRENCY, SCHEDULER_DEFAULTS.concurrency, 1),
    tickMs: parseIntEnv(env.SCHEDULER_TICK_MS, SCHEDULER_DEFAULTS.tickMs, 100),
    defaultTimeoutMs: parseIntEnv(
      env.SCHEDULER_DEFAULT_TIMEOUT_MS,
      SCHEDULER_DEFAULTS.defaultTimeoutMs,
      1000,
    ),
    retryBackoffMs: parseIntEnv(
      env.SCHEDULER_RETRY_BACKOFF_MS,
      SCHEDULER_DEFAULTS.retryBackoffMs,
      100,
    ),
    retryBackoffMaxMs: parseIntEnv(
      env.SCHEDULER_RETRY_BACKOFF_MAX_MS,
      SCHEDULER_DEFAULTS.retryBackoffMaxMs,
      1000,
    ),
    minCronIntervalSec: parseIntEnv(
      env.SCHEDULER_MIN_CRON_INTERVAL_SEC,
      SCHEDULER_DEFAULTS.minCronIntervalSec,
      1,
    ),
    enabled: parseBoolEnv(env.SCHEDULER_ENABLED, SCHEDULER_DEFAULTS.enabled),
  };
}
