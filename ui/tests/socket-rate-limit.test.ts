/**
 * #682 — a rate-limited room join is told apart from an authorization denial,
 * and its retry delay is bounded and jittered.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_RATE_LIMIT_RETRY_MS,
  MAX_RATE_LIMIT_RETRY_MS,
  RATE_LIMIT_RETRY_JITTER_MS,
  rateLimitRetryDelay,
} from "@/lib/socket-rate-limit";

const limited = (retryAfterMs?: number) => ({
  message: "RATE_LIMITED: too many room joins, try again shortly",
  room: "job:j1",
  code: "RATE_LIMITED" as const,
  retryAfterMs,
});

describe("rateLimitRetryDelay", () => {
  it("is undefined for an authorization denial or no refusal", () => {
    expect(rateLimitRetryDelay({ message: "FORBIDDEN", room: "job:j1" })).toBeUndefined();
    expect(rateLimitRetryDelay({ message: "UNAUTHORIZED" })).toBeUndefined();
    expect(rateLimitRetryDelay(undefined)).toBeUndefined();
  });

  it("waits the named delay plus jitter", () => {
    expect(rateLimitRetryDelay(limited(2_000), () => 0)).toBe(2_000);
    expect(rateLimitRetryDelay(limited(2_000), () => 0.5)).toBe(
      2_000 + RATE_LIMIT_RETRY_JITTER_MS / 2,
    );
    expect(rateLimitRetryDelay(limited(2_000), () => 0.9999)).toBeLessThan(
      2_000 + RATE_LIMIT_RETRY_JITTER_MS,
    );
  });

  it.each([[undefined], [-5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    "falls back to the default for a retryAfterMs of %s",
    (retryAfterMs) => {
      expect(rateLimitRetryDelay(limited(retryAfterMs), () => 0)).toBe(DEFAULT_RATE_LIMIT_RETRY_MS);
    },
  );

  it("caps a long delay", () => {
    expect(rateLimitRetryDelay(limited(10 * MAX_RATE_LIMIT_RETRY_MS), () => 0)).toBe(
      MAX_RATE_LIMIT_RETRY_MS,
    );
  });
});
