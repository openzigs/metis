/**
 * #116 / #123 — the ONE strict parser for millisecond settings.
 *
 * `Number.parseInt` reads `1_200_000` and `1.2e6` as `1`, and Node turns any
 * timer longer than 2^31-1 ms into a 1 ms timer (TimeoutOverflowWarning). Either
 * way a value meant to RAISE a budget silently made it 1 ms. So a millisecond
 * setting accepts plain decimal digits only, inside `[min, max]`; unset or blank
 * keeps the default silently, and anything else keeps the default and warns,
 * naming the setting.
 */
import { createChildLogger } from "../logger.js";

const log = createChildLogger("config.env-ms");

/** Node clamps any timer longer than 2^31-1 ms to 1 ms. */
export const MAX_NODE_TIMER_MS = 2_147_483_647;

/**
 * Headroom kept under {@link MAX_NODE_TIMER_MS}. The local provider sizes
 * undici's `headersTimeout` to its budget PLUS a 30 s margin, so its budget must
 * leave that room or undici's own timer overflows; every other millisecond
 * setting shares the same cap so there is one number to document.
 */
export const TIMER_HEADROOM_MS = 30_000;

/** Largest accepted millisecond setting: 2147453647 ms, ~24.8 days. */
export const MAX_TIMEOUT_MS = MAX_NODE_TIMER_MS - TIMER_HEADROOM_MS;

export interface StrictMsOptions {
  /** Smallest accepted value (inclusive). Default 0. */
  min?: number;
  /** Largest accepted value (inclusive). Default {@link MAX_TIMEOUT_MS}; never above it. */
  max?: number;
  /** Log line used when a value is ignored. */
  warning?: string;
  /**
   * Warn once per (setting, raw value) for the life of the process. For
   * settings read on every request (the `AI_STREAM_*` limits), where one bad
   * value would otherwise log on every chat turn. A different bad value warns
   * again.
   */
  warnOnce?: boolean;
}

/** (setting, raw value) pairs already warned about under `warnOnce`. */
const warnedOnce = new Set<string>();
/** Bound on {@link warnedOnce}; past it the set is cleared, never grown. */
const WARNED_ONCE_MAX = 256;

/** Test seam — forget which `warnOnce` values were already reported. */
export function resetEnvMsWarningsForTests(): void {
  warnedOnce.clear();
}

/**
 * Parse the raw value of the millisecond setting `name`. Pure apart from the
 * warning, so callers that read from `process.env`, a merged config map or
 * `ConfigService` all share it.
 */
export function parseStrictMs(
  name: string,
  raw: string | undefined | null,
  fallback: number,
  opts: StrictMsOptions = {},
): number {
  if (raw == null || raw.trim().length === 0) return fallback;
  const min = opts.min ?? 0;
  const max = Math.min(opts.max ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const value = raw.trim();
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    if (n >= min && n <= max) return n;
  }
  if (opts.warnOnce) {
    const key = `${name}=${raw}`;
    if (warnedOnce.has(key)) return fallback;
    if (warnedOnce.size >= WARNED_ONCE_MAX) warnedOnce.clear();
    warnedOnce.add(key);
  }
  log.warn(opts.warning ?? "Ignoring invalid millisecond setting; keeping the default", {
    env: name,
    value: raw.slice(0, 40),
    defaultMs: fallback,
    minMs: min,
    maxMs: max,
  });
  return fallback;
}

/** {@link parseStrictMs} over `process.env[name]`. */
export function envMs(name: string, fallback: number, opts: StrictMsOptions = {}): number {
  return parseStrictMs(name, process.env[name], fallback, opts);
}
