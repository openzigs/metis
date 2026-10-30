import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api-client";

/**
 * #1570 — how many times a query retries a 429 that carries `Retry-After`.
 * The server's own window resets within one wait, so more is only a loop.
 */
export const RATE_LIMITED_MAX_RETRIES = 2;

/**
 * #1570 — the longest `Retry-After` a query waits out: one 15-minute limiter
 * window. A longer one is not a rate limit this client can sit out.
 */
export const RATE_LIMITED_MAX_WAIT_MS = 15 * 60_000;

/** TanStack Query's own default backoff, kept for every non-429 retry. */
function defaultRetryDelay(failureCount: number): number {
  return Math.min(1000 * 2 ** failureCount, 30_000);
}

/** A 429 whose `Retry-After` says when to come back, within one window. */
function isWaitableRateLimit(error: unknown): error is ApiError & { retryAfterMs: number } {
  return (
    error instanceof ApiError &&
    error.status === 429 &&
    error.retryAfterMs !== undefined &&
    error.retryAfterMs <= RATE_LIMITED_MAX_WAIT_MS
  );
}

/**
 * Build a QueryClient with sensible UI defaults:
 * - 30s stale time so navigations re-show recent data without re-fetching
 * - 1 retry, but never on 4xx (those won't fix themselves) — except a 429 that
 *   says when to come back, which is retried then (#1570)
 * - No refetch on window focus to avoid hammering the API in dev
 *
 * Mutations also retry once on transient 5xx but never on client errors.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          // #1117 — never at once; #1570 — but after the server's Retry-After.
          if (isWaitableRateLimit(error)) return failureCount < RATE_LIMITED_MAX_RETRIES;
          if (error instanceof ApiError && error.status < 500) return false;
          return failureCount < 1;
        },
        retryDelay: (failureCount, error) =>
          isWaitableRateLimit(error) ? error.retryAfterMs : defaultRetryDelay(failureCount),
      },
      mutations: {
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status < 500) return false;
          return failureCount < 1;
        },
      },
    },
  });
}
