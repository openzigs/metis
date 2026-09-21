/**
 * HTTP helper with rate-limit awareness + exponential backoff — issue #777.
 *
 * Used by the GitHub / Azure DevOps / Linear importers (Jira reuses its own
 * client). Honours `Retry-After` and GitHub's `X-RateLimit-Reset` /
 * secondary-rate-limit signals, and retries transient 5xx / network errors
 * with exponential backoff + jitter. `sleep` and `now` are injectable so unit
 * tests run instantly and deterministically.
 */
import type { FetchFn } from "./types.js";

export interface BackoffOptions {
  /** Injectable fetch (defaults to global fetch). */
  fetchFn?: FetchFn;
  /** Max attempts including the first. Default 5. */
  maxRetries?: number;
  /** Initial backoff delay (ms). Default 500. */
  baseDelayMs?: number;
  /** Cap on a single backoff delay (ms). Default 30_000. */
  maxDelayMs?: number;
  /** Abort signal threaded from the task engine. */
  signal?: AbortSignal;
  /** Injectable sleep (ms) — overridden in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (ms epoch) — overridden in tests. */
  now?: () => number;
  /** Injectable jitter in [0,1) — overridden in tests for determinism. */
  random?: () => number;
  /**
   * Pre-resolved undici-compatible `Dispatcher` for DNS-rebind TOCTOU
   * protection (M1 — SSRF). Only used when no custom `fetchFn` is injected
   * (i.e. not in unit-test mode).  When set, every fetch is routed through the
   * pinned dispatcher so the TCP connection always goes to the validated IP.
   */
  dispatcher?: unknown;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the delay (ms) before the next attempt. Prefers an explicit
 * server hint (`Retry-After` seconds or `X-RateLimit-Reset` epoch seconds)
 * when the rate limit is exhausted, otherwise falls back to exponential
 * backoff with full jitter.
 */
export function computeRetryDelay(
  res: Response | null,
  attempt: number,
  opts: Required<Pick<BackoffOptions, "baseDelayMs" | "maxDelayMs">> & {
    now: () => number;
    random: () => number;
  },
): number {
  if (res) {
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, opts.maxDelayMs);
    }
    // GitHub: when remaining hits 0, reset is an epoch-seconds timestamp.
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    if (remaining === "0" && reset) {
      const resetMs = Number(reset) * 1000;
      if (Number.isFinite(resetMs)) {
        const wait = resetMs - opts.now();
        if (wait > 0) return Math.min(wait, opts.maxDelayMs);
      }
    }
  }
  const exp = Math.min(opts.baseDelayMs * 2 ** attempt, opts.maxDelayMs);
  // Full jitter.
  return Math.floor(exp * opts.random());
}

/** True when a response/error should be retried. */
export function isRetryable(res: Response): boolean {
  if (RETRYABLE_STATUS.has(res.status)) return true;
  // GitHub secondary rate limit surfaces as 403 with remaining 0.
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") return true;
  return false;
}

export class ImporterHttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: string,
  ) {
    super(message);
    this.name = "ImporterHttpError";
  }
}

/**
 * Fetch with retry/backoff. Resolves with a successful (2xx) Response or
 * throws {@link ImporterHttpError} after exhausting retries / on a
 * non-retryable 4xx.
 */
export async function fetchWithBackoff(
  url: string | URL,
  init: RequestInit,
  options: BackoffOptions = {},
): Promise<Response> {
  const maxRetries = options.maxRetries ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;

  // When a pinned undici Dispatcher is provided and no custom fetchFn is
  // injected, route all connections through the dispatcher so the OS resolver
  // cannot be hijacked between validation and connect (DNS-rebind TOCTOU fix).
  const fetchFn: FetchFn =
    options.dispatcher !== undefined && !options.fetchFn
      ? (input, reqInit) =>
          (globalThis.fetch as (input: unknown, init?: unknown) => Promise<Response>)(input, {
            ...reqInit,
            dispatcher: options.dispatcher,
          })
      : (options.fetchFn ?? (globalThis.fetch as FetchFn));

  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    if (options.signal?.aborted) {
      throw new ImporterHttpError(0, "import aborted");
    }
    let res: Response;
    try {
      res = await fetchFn(url, { ...init, signal: options.signal });
    } catch (err) {
      lastError = err;
      if (options.signal?.aborted) throw new ImporterHttpError(0, "import aborted");
      // Network error — backoff and retry.
      if (attempt < maxRetries - 1) {
        await sleep(computeRetryDelay(null, attempt, { baseDelayMs, maxDelayMs, now, random }));
        continue;
      }
      throw new ImporterHttpError(0, `network error: ${(err as Error).message}`);
    }

    if (res.ok) return res;

    if (isRetryable(res) && attempt < maxRetries - 1) {
      await sleep(computeRetryDelay(res, attempt, { baseDelayMs, maxDelayMs, now, random }));
      continue;
    }

    const body = await res.text().catch(() => "");
    throw new ImporterHttpError(res.status, `HTTP ${res.status} from ${String(url)}`, body);
  }
  throw new ImporterHttpError(0, `exhausted retries: ${String(lastError)}`);
}

/** Parse a GitHub-style `Link` header into a map of rel → url. */
export function parseLinkHeader(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(",")) {
    const match = /<([^>]+)>;\s*rel="([^"]+)"/.exec(part.trim());
    if (match) out[match[2]] = match[1];
  }
  return out;
}
